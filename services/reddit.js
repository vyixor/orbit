// ORBIT — Reddit Pipeline

import { getConfig } from './settings.js';
import { db, logAction, STORES } from './db.js';
import { classifyPosts, analyzePost, draftReply } from './ai.js';
import { research, formatResearchContext } from './research.js';

// ── Navigate to Reddit if needed, wait for content script ────────────────────
export async function ensureRedditTab(targetUrl = 'https://www.reddit.com') {
  const tabsResp = await chrome.runtime.sendMessage({ action: 'GET_REDDIT_TABS' });
  const tabs = tabsResp.tabs || [];

  if (!tabs.length) {
    // Open Reddit in background tab
    const nav = await chrome.runtime.sendMessage({ action: 'NAVIGATE_TO_REDDIT', url: targetUrl });
    // Wait for page to load and content script to inject
    await waitForRedditTab(nav.tabId, 8000);
    return nav.tabId;
  }
  return tabs[0].id;
}

async function waitForRedditTab(tabId, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 800));
    const ping = await chrome.runtime.sendMessage({
      action: 'SEND_TO_REDDIT_TAB',
      payload: { action: 'PING' },
      tabId,
    });
    if (ping && ping.ok) return true;
  }
  throw new Error('Reddit tab timed out loading. Try opening Reddit manually first.');
}

// ── Scan ──────────────────────────────────────────────────────────────────────
export async function scanRedditTab(tabId = null) {
  const resp = await chrome.runtime.sendMessage({
    action: 'SEND_TO_REDDIT_TAB',
    payload: { action: 'SCAN_POSTS' },
    tabId,
  });

  if (resp.error === 'NO_REDDIT_TAB') throw new Error('NO_REDDIT_TAB');
  if (resp.error) throw new Error(resp.error);
  return resp.posts || [];
}

// ── Local Filter (soft — blocked only, no subreddit gating if list empty) ────
export async function filterPosts(rawPosts) {
  const cfg = await getConfig();
  const r = cfg.reddit;

  return rawPosts.filter(post => {
    if (!post.title || post.title.length < 5) return false;

    const sub = (post.subreddit || '').toLowerCase();
    if (r.blockedSubreddits.some(b => b.toLowerCase() === sub)) return false;

    // Only filter by subreddit list if list is non-empty
    if (r.subreddits.length) {
      if (!r.subreddits.some(s => s.toLowerCase() === sub)) return false;
    }

    if (post.score < (r.minScore || 0)) return false;

    const maxAgeMin = (r.maxAgeHours || 48) * 60;
    if (post.ageMinutes > maxAgeMin) return false;

    if (post.commentCount < (r.minComments || 0)) return false;

    const text = `${post.title} ${post.text || ''}`.toLowerCase();
    if (r.blockedKeywords.some(k => k && text.includes(k.toLowerCase()))) return false;

    return true;
  });
}

// ── Local Relevance Score ─────────────────────────────────────────────────────
export async function scorePosts(posts) {
  const cfg = await getConfig();
  const { profile, reddit, scoringWeights: w } = cfg;
  const interests = (profile.interests || []).map(i => i.toLowerCase());
  const keywords  = (reddit.keywords || []).map(k => k.toLowerCase());
  const subreddits = (reddit.subreddits || []).map(s => s.toLowerCase());

  return posts.map(post => {
    const text = `${post.title} ${post.text || ''}`.toLowerCase();
    let score = 0;

    if (interests.length) {
      const hits = interests.filter(i => text.includes(i)).length;
      score += w.topicMatch * Math.min(hits / interests.length, 1);
    }

    if (keywords.length) {
      const hits = keywords.filter(k => text.includes(k)).length;
      score += w.keywordMatch * Math.min(hits / keywords.length, 1);
    }

    const maxAge = (reddit.maxAgeHours || 48) * 60;
    score += w.freshness * (1 - Math.min(post.ageMinutes / maxAge, 1));

    score += w.discussionActivity * Math.min((post.commentCount || 0) / 50, 1);

    if (subreddits.includes((post.subreddit || '').toLowerCase())) score += w.subredditMatch;

    if (/\?/.test(post.title) || /\b(how|what|why|where|when|should|can i|does anyone|help)\b/i.test(post.title)) {
      score += w.questionDetected;
    }

    return { ...post, localScore: Math.round(score) };
  }).sort((a, b) => b.localScore - a.localScore);
}

// ── Dedupe ────────────────────────────────────────────────────────────────────
export async function dedupePosts(posts) {
  const seen = new Set();
  const fresh = [];
  for (const post of posts) {
    const existing = await db.get(STORES.POSTS, post.id);
    if (existing && existing.status === 'posted') continue; // skip already posted
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    fresh.push(post);
  }
  return fresh;
}

// ── Full Discovery Pipeline ───────────────────────────────────────────────────
// Returns ALL posts that pass local filter (not just AI-selected ones)
// Posts get a localScore and optional AI classification if keys are configured
export async function runDiscovery(tabId = null) {
  const cfg = await getConfig();
  await logAction('discovery_start', {});

  // Step 1: Ensure we have a Reddit tab
  let activeTabId = tabId;
  try {
    activeTabId = await ensureRedditTab();
  } catch (e) {
    throw new Error(`Can't reach Reddit: ${e.message}`);
  }

  // Step 2: Scan
  let raw = [];
  try {
    raw = await scanRedditTab(activeTabId);
  } catch (e) {
    throw new Error(`Scan failed: ${e.message}`);
  }
  await logAction('discovery_scan', { count: raw.length });

  if (!raw.length) {
    return { posts: [], tabId: activeTabId, message: 'Reddit page loaded but no posts detected. Try scrolling the page first.' };
  }

  // Step 3: Filter
  const filtered = await filterPosts(raw);
  await logAction('discovery_filter', { raw: raw.length, filtered: filtered.length });

  // Step 4: Score + dedupe
  const scored = await scorePosts(filtered);
  const deduped = await dedupePosts(scored);

  // Step 5: Category fallback — posts that scored low on keywords get a second
  // chance via AI category matching (title vs user's category list)
  const categories = cfg.reddit?.categories || [];
  let deduped2 = deduped;
  if (categories.length) {
    // Split: keyword-matched (keep) vs low-scorers (category-scan candidates)
    const KEYWORD_THRESHOLD = 15;
    const highScorers = deduped.filter(p => p.localScore >= KEYWORD_THRESHOLD);
    const lowScorers  = deduped.filter(p => p.localScore < KEYWORD_THRESHOLD);

    // Quick local category check before spending AI tokens
    const catLower = categories.map(c => c.toLowerCase());
    const localCatMatch = lowScorers.filter(p => {
      const titleWords = p.title.toLowerCase();
      return catLower.some(cat => titleWords.includes(cat));
    });

    // Merge: keyword-hits first, then local category matches
    deduped2 = [...highScorers, ...localCatMatch];
    if (deduped2.length === 0) deduped2 = deduped; // fallback: use all if nothing matched
    await logAction('discovery_category_filter', { from: deduped.length, to: deduped2.length });
  }

  // Step 5: AI classification (optional — only if API key exists)
  let classified = deduped2;
  if (cfg.groqApiKey && deduped2.length) {
    try {
      const batch = deduped2.slice(0, cfg.reddit.maxAIBatch).map(p => ({
        post_id: p.id,
        title: p.title,
        subreddit: p.subreddit,
        score: p.score,
        commentCount: p.commentCount,
        ageMinutes: p.ageMinutes,
        text: (p.text || '').slice(0, 200),
      }));

      const results = await classifyPosts(batch);

      // Merge AI results back — keep all posts, just annotate with AI data
      classified = deduped2.map(post => {
        const ai = results.find(r => r.post_id === post.id);
        return {
          ...post,
          aiRelevant: ai?.relevant ?? null,
          priority: ai?.priority ?? (post.localScore / 100),
          aiReason: ai?.reason ?? '',
          needsResearch: ai?.needsResearch ?? false,
          recommendedAction: ai?.recommended_action ?? 'read',
        };
      });

      // Sort: AI-relevant first, then by local score
      classified.sort((a, b) => {
        if (a.aiRelevant && !b.aiRelevant) return -1;
        if (!a.aiRelevant && b.aiRelevant) return 1;
        return (b.priority || 0) - (a.priority || 0);
      });
    } catch (e) {
      // AI failed — continue with locally scored posts, don't crash
      await logAction('discovery_ai_skip', { reason: e.message });
      classified = deduped2; // use locally scored on AI fail
    }
  }

  // Persist to DB
  for (const post of classified) {
    await db.put(STORES.POSTS, {
      ...post,
      status: post.status || 'new',
      analyzedAt: Date.now(),
    });
  }

  await logAction('discovery_done', { total: classified.length });
  return { posts: classified, tabId: activeTabId, message: null };
}

// ── Deep Analysis ─────────────────────────────────────────────────────────────
export async function analyzePostDeep(postId, tabId = null) {
  const commentsResp = await chrome.runtime.sendMessage({
    action: 'SEND_TO_REDDIT_TAB',
    payload: { action: 'EXTRACT_COMMENTS', max: 15 },
    tabId,
  });

  const comments = commentsResp.comments || [];
  const post = await db.get(STORES.POSTS, postId);
  if (!post) throw new Error('Post not found in DB');

  const cfg = await getConfig();
  let researchContext = null;
  if (post.needsResearch && cfg.research.autoResearch) {
    const result = await research(`${post.title} ${post.subreddit}`);
    researchContext = formatResearchContext(result);
  }

  const analysis = await analyzePost(post, comments, researchContext);
  await db.put(STORES.POSTS, { ...post, analysis, status: 'analyzed' });

  return { post, comments, analysis, researchContext };
}

// ── Draft ─────────────────────────────────────────────────────────────────────
export async function generateDraft(postId, extraResearch = null) {
  const post = await db.get(STORES.POSTS, postId);
  if (!post) throw new Error('Post not found');

  const commentsResp = await chrome.runtime.sendMessage({
    action: 'SEND_TO_REDDIT_TAB',
    payload: { action: 'EXTRACT_COMMENTS', max: 10 },
  });

  const comments = commentsResp.comments || [];
  const analysis = post.analysis || {};
  const researchContext = extraResearch ? formatResearchContext(extraResearch) : null;

  const result = await draftReply(post, comments, analysis, researchContext);

  const draft = {
    postId,
    postTitle: post.title,
    subreddit: post.subreddit,
    postUrl: post.url,
    text: result.draft,
    confidence: result.confidence,
    notes: result.notes,
    requireApproval: true,
    status: 'pending',
    createdAt: Date.now(),
  };

  // Save and fetch back to get auto-incremented id
  await db.put(STORES.DRAFTS, draft);
  const allDrafts = await db.getAll(STORES.DRAFTS);
  const saved = allDrafts.sort((a,b) => b.createdAt - a.createdAt)[0];
  return saved || draft;
}

// ── Post Reply ────────────────────────────────────────────────────────────────
export async function postReply(draft, tabId = null) {
  if (!draft.text) throw new Error('Draft has no text');

  // Make sure a Reddit tab is on the correct post page
  const tabs = await chrome.runtime.sendMessage({ action: 'GET_REDDIT_TABS' });
  const redditTabs = tabs.tabs || [];

  let targetTabId = tabId;
  let onPostPage = false;

  if (redditTabs.length) {
    // Check if any tab is already on this post
    const postTab = redditTabs.find(t => t.url && draft.postUrl && t.url.includes(draft.postUrl.split('?')[0]));
    if (postTab) {
      targetTabId = postTab.id;
      onPostPage = true;
    } else {
      // Navigate first reddit tab to the post
      targetTabId = redditTabs[0].id;
      await chrome.tabs.update(targetTabId, { url: draft.postUrl, active: true });
      await new Promise(r => setTimeout(r, 3000)); // wait for load
    }
  } else {
    // Open new tab to post
    const nav = await chrome.runtime.sendMessage({ action: 'NAVIGATE_TO_REDDIT', url: draft.postUrl });
    targetTabId = nav.tabId;
    await new Promise(r => setTimeout(r, 3500));
  }

  const insertResp = await chrome.runtime.sendMessage({
    action: 'SEND_TO_REDDIT_TAB',
    payload: { action: 'INSERT_REPLY', text: draft.text },
    tabId: targetTabId,
  });
  if (insertResp?.error) throw new Error(`Could not insert: ${insertResp.error}. Make sure the Reddit post is open and the reply box is visible.`);

  if (!draft.requireApproval) {
    await new Promise(r => setTimeout(r, 500));
    const submitResp = await chrome.runtime.sendMessage({
      action: 'SEND_TO_REDDIT_TAB',
      payload: { action: 'SUBMIT_REPLY' },
      tabId: targetTabId,
    });
    if (submitResp?.error) throw new Error(submitResp.error);
    const updated = { ...draft, status: 'posted', postedAt: Date.now() };
    if (draft.id) await db.put(STORES.DRAFTS, updated);
    await logAction('post_reply', { postId: draft.postId, auto: true });
    return { status: 'posted' };
  }

  const updated = { ...draft, status: 'inserted' };
  if (draft.id) await db.put(STORES.DRAFTS, updated);
  await logAction('post_reply', { postId: draft.postId, auto: false });
  return { status: 'inserted', note: 'Draft inserted — click Submit in the Reddit tab.' };
}
