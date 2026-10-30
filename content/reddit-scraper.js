// ORBIT — Reddit Content Script

(function () {
  'use strict';

  if (window.__orbitRedditLoaded) return;
  window.__orbitRedditLoaded = true;

  // ── Selectors ─────────────────────────────────────────────────────────────

  const SELECTORS = {
    postCard: [
      'shreddit-post',
      '[data-testid="post-container"]',
      '[data-fullname^="t3_"]',
      '.Post',
    ],
    postTitle: [
      'a[slot="title"]',
      '[data-adclicklocation="title"] a',
      '[data-click-id="body"] h3',
      '.Post h3',
      'h1',
    ],
    postScore: [
      'faceplate-number[pretty]',
      '[data-testid="post-upvote-count"]',
      '.score.unvoted',
    ],
    commentCount: [
      'a[data-click-id="comments"]',
      '[data-testid="comment-count"]',
      '.comments',
    ],
    postBody: [
      '[data-testid="post-rtjson-content"]',
      '[slot="text-body"]',
      '.Post .RichTextJSON-root',
      '.expando .usertext-body',
    ],
    commentItem: [
      'shreddit-comment',
      '[data-testid="comment"]',
      '.Comment',
    ],
    commentBody: [
      '[slot="comment"] p',
      '[data-testid="comment"] p',
      '.RichTextJSON-root p',
      '.md p',
    ],
    // Reply box selectors — ordered by likelihood on new Reddit
    replyBox: [
      'div[data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[data-testid="comment-submission-form-richtext"] [contenteditable]',
      '.public-DraftEditor-content',
      '.usertext-edit textarea',
      'textarea[name="text"]',
    ],
    submitButton: [
      'button[data-testid="comment-submission-form-submit"]',
      'button.save[type="submit"]',
      '.usertext-buttons .save',
      'button:not([disabled])[type="submit"]',
    ],
    // Top-level reply trigger
    replyTrigger: [
      '[data-testid="top-level-reply-button"]',
      'button[data-click-id="text"]',
      '.reply-button',
      'button.reply',
    ],
  };

  function queryFirst(sels, root = document) {
    for (const s of sels) {
      try { const el = root.querySelector(s); if (el) return el; } catch (_) {}
    }
    return null;
  }

  function queryAll(sels, root = document) {
    for (const s of sels) {
      try { const els = root.querySelectorAll(s); if (els.length) return Array.from(els); } catch (_) {}
    }
    return [];
  }

  function getText(el) { return el?.textContent?.trim() || ''; }

  function parseScore(el) {
    if (!el) return 0;
    const raw = getText(el).replace(/[^0-9.kmKM]/g, '');
    if (!raw) return 0;
    if (/k/i.test(raw)) return Math.round(parseFloat(raw) * 1000);
    if (/m/i.test(raw)) return Math.round(parseFloat(raw) * 1000000);
    return parseInt(raw) || 0;
  }

  function getSubreddit() {
    const m = window.location.pathname.match(/^\/r\/([^/]+)/);
    return m ? m[1] : '';
  }

  function getPostId(el) {
    // shreddit-post has id attribute like t3_xxxxx
    const name = el.getAttribute('id') || el.getAttribute('data-fullname') || el.getAttribute('name') || '';
    const m = name.match(/t3_(\w+)/);
    if (m) return m[1];
    // Try permalink
    const link = el.querySelector('a[href*="/comments/"]');
    const hm = link?.href?.match(/\/comments\/(\w+)/);
    return hm ? hm[1] : null;
  }

  function getPostUrl(el) {
    const link = queryFirst(SELECTORS.postTitle, el);
    if (link?.href) return link.href;
    return window.location.href;
  }

  // ── Extract posts from feed ───────────────────────────────────────────────

  function extractPosts() {
    const cards = queryAll(SELECTORS.postCard);
    const posts = [];
    const seen  = new Set();

    for (const card of cards) {
      try {
        const titleEl = queryFirst(SELECTORS.postTitle, card);
        const title = getText(titleEl);
        if (!title || title.length < 3) continue;

        const url = getPostUrl(card);
        // Get post id from URL as fallback
        const urlMatch = url.match(/\/comments\/(\w+)/);
        const id = getPostId(card) || (urlMatch ? urlMatch[1] : null) || btoa(url).slice(0, 12);

        if (seen.has(id)) continue;
        seen.add(id);

        const score        = parseScore(queryFirst(SELECTORS.postScore, card));
        const commentCount = parseScore(queryFirst(SELECTORS.commentCount, card));

        let subreddit = getSubreddit();
        if (!subreddit) {
          const subLink = card.querySelector('a[href^="/r/"]');
          const sm = subLink?.href?.match(/\/r\/([^/]+)/);
          subreddit = sm ? sm[1] : '';
        }

        const timeEl = card.querySelector('time, [datetime], faceplate-timeago');
        const dateStr = timeEl?.getAttribute('datetime') || timeEl?.getAttribute('ts') || '';
        const postedAt  = dateStr ? new Date(dateStr).getTime() : Date.now();
        const ageMinutes = Math.round((Date.now() - postedAt) / 60000);

        const bodyEl = queryFirst(SELECTORS.postBody, card);
        const text   = getText(bodyEl).slice(0, 300);

        posts.push({ id, title, url, subreddit, score, commentCount, ageMinutes, text, postedAt });
      } catch (_) {}
    }
    return posts;
  }

  // ── Extract comments ──────────────────────────────────────────────────────

  function extractComments(max = 20) {
    const items = queryAll(SELECTORS.commentItem);
    const comments = [];

    for (const item of items.slice(0, max * 2)) {
      try {
        const bodyEl = queryFirst(SELECTORS.commentBody, item);
        const text = getText(bodyEl);
        if (!text || text.length < 10) continue;

        const authorEl = item.querySelector('[data-testid="comment_author_link"], a[href*="/user/"]');
        const author   = getText(authorEl);
        const scoreEl  = item.querySelector('faceplate-number, [id$="-vote-arrows"]');
        const score    = parseScore(scoreEl);
        const depth    = parseInt(item.getAttribute('depth') || item.getAttribute('data-depth') || '0');

        comments.push({ author, text: text.slice(0, 600), score, depth });
        if (comments.length >= max) break;
      } catch (_) {}
    }

    return comments.sort((a, b) => b.score - a.score);
  }

  // ── Reply insertion — fixed ───────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function insertReply(text) {
    // 1. Find or open the reply box
    let box = queryFirst(SELECTORS.replyBox);

    if (!box) {
      // Try clicking the reply trigger button
      const trigger = queryFirst(SELECTORS.replyTrigger);
      if (trigger) {
        trigger.click();
        await sleep(1200);
        box = queryFirst(SELECTORS.replyBox);
      }
    }

    if (!box) throw new Error('Reply editor not found. Open the post and make sure the comment section is visible.');

    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);
    box.focus();
    await sleep(200);

    // 2. Clear existing content safely WITHOUT selectAll
    if (box.tagName === 'TEXTAREA') {
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(50);

      // Type character by character for proper event firing
      for (const char of text) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(box, box.value + char);
        } else {
          box.value += char;
        }
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(10);
      }
      box.dispatchEvent(new Event('change', { bubbles: true }));

    } else {
      // Contenteditable (Lexical editor on new Reddit)
      // Clear by moving cursor and deleting — avoid document.execCommand('selectAll')
      box.focus();
      await sleep(100);

      // Empty it by clearing innerHTML then inserting text via clipboard API simulation
      // First try: execCommand without selectAll
      const range = document.createRange();
      const sel   = window.getSelection();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      await sleep(50);

      // Delete selection
      document.execCommand('delete', false, null);
      await sleep(50);

      // Now insert text
      document.execCommand('insertText', false, text);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }

    return true;
  }

  async function submitReply() {
    // Wait briefly for button to enable
    await sleep(400);
    let btn = queryFirst(SELECTORS.submitButton);

    if (!btn) throw new Error('Submit button not found');

    // If disabled, wait up to 3 seconds
    let waited = 0;
    while (btn.disabled && waited < 3000) {
      await sleep(200);
      waited += 200;
      btn = queryFirst(SELECTORS.submitButton);
    }

    if (btn.disabled) throw new Error('Submit button is still disabled. The reply box may be empty.');

    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  }

  function getCurrentPost() {
    const match = window.location.pathname.match(/\/comments\/(\w+)/);
    if (!match) return null;
    const titleEl = document.querySelector('h1, [data-testid="post-title"]');
    const bodyEl  = queryFirst(SELECTORS.postBody);
    return {
      id: match[1],
      title: getText(titleEl),
      text: getText(bodyEl).slice(0, 2000),
      subreddit: getSubreddit(),
      url: window.location.href,
    };
  }

  // ── Message handler ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handle = async () => {
      switch (msg.action) {
        case 'PING':             return { ok: true, url: window.location.href };
        case 'SCAN_POSTS':       return { posts: extractPosts() };
        case 'EXTRACT_COMMENTS': return { comments: extractComments(msg.max || 20) };
        case 'GET_CURRENT_POST': return { post: getCurrentPost() };
        case 'INSERT_REPLY':
          await insertReply(msg.text);
          return { ok: true };
        case 'SUBMIT_REPLY':
          await submitReply();
          return { ok: true };
        default:
          return { error: `Unknown: ${msg.action}` };
      }
    };
    handle().then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  });

  chrome.runtime.sendMessage({ action: 'REDDIT_PAGE_LOADED', url: window.location.href });
})();
