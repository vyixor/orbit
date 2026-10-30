// ORBIT — Browser Agent Service v7
//
// Key design decisions:
//
// 1. Model: always llama-3.3-70b-versatile for agent calls.
//    Never inherit cfg.ai.model — some models (e.g. gpt-oss-20b) have native
//    tool-calling that fires even when no tools are defined, causing Groq 400s.
//
// 2. response_format: json_object is requested but if Groq returns empty or
//    fails validation we retry without it (plain text + manual JSON extract).
//
// 3. Rate caution: a configurable human-like random delay before each AI call
//    to spread token usage and avoid TPM limits on free plans.
//
// 4. Chunk notes: the AI can save short notes while reading chunks so data
//    from chunk 2 is still available when reading chunk 8. Notes are
//    size-guarded and oldest are evicted when over the limit.

import { getConfig } from './settings.js';
import { logAction } from './db.js';

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
// Agent always uses the configured model (cfg.ai.model).
// To prevent models with native tool-calling (e.g. gpt-oss-20b) from firing
// tools when none are defined, we send tool_choice:"none" + an empty tools
// array on every call. This is a Groq-supported way to disable tool use.

let _onLog = null;
export function setAgentLogger(fn) { _onLog = fn; }

function alog(level, action, detail, data = {}) {
  const entry = { level, action, detail, data, ts: Date.now() };
  logAction(`agent_${level}`, { action, detail });
  if (_onLog) _onLog(entry);
}

function clean(str) {
  if (!str) return '';
  return String(str).replace(/["\\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Rate caution delay ────────────────────────────────────────────────────────
// Spreads AI calls across time like a human would, preventing TPM bursts.
// Caution level comes from cfg.agent.rateCaution (set in Settings).

const CAUTION_DELAY = {
  low:    { min: 1000, max:  3000 },  // fast, may hit free-tier limits
  normal: { min: 4000, max:  8000 },  // balanced — default
  high:   { min: 9000, max: 16000 },  // very safe on free tier
};

async function rateCautionDelay(cfg) {
  const level = cfg.agent?.rateCaution || 'normal';
  const { min, max } = CAUTION_DELAY[level] || CAUTION_DELAY.normal;
  const ms = min + Math.floor(Math.random() * (max - min));
  alog('info', 'PACE', `waiting ${(ms / 1000).toFixed(1)}s (caution: ${level})`);
  await new Promise(r => setTimeout(r, ms));
}

// ── Chunk notes ───────────────────────────────────────────────────────────────
// The AI can attach notes to a READ_CHUNK result via the `note` field.
// Notes persist across chunk reads so data found in chunk 2 is available
// when reading chunk 7. Oldest notes are evicted when total size exceeds limit.

function addNote(notes, chunkIndex, text, maxTotalChars) {
  if (!text || !text.trim()) return notes;
  const entry = { chunkIndex, text: text.slice(0, 400), ts: Date.now() };
  const updated = [...notes, entry];
  // Evict oldest entries until total size is within budget
  let totalChars = updated.reduce((s, n) => s + n.text.length, 0);
  while (totalChars > maxTotalChars && updated.length > 1) {
    const removed = updated.shift();
    totalChars -= removed.text.length;
  }
  return updated;
}

function formatNotes(notes) {
  if (!notes.length) return '';
  const lines = ['📝 Notes from previous chunks:'];
  for (const n of notes) {
    lines.push(`  [chunk ${n.chunkIndex + 1}] ${n.text}`);
  }
  return lines.join('\n');
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

async function getActiveTabId() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_TAB' }, resp => {
      chrome.runtime.lastError;
      resolve(resp?.tab?.id || null);
    });
  });
}

async function sendToTab(tabId, payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'AGENT_EXEC', step: payload, tabId }, resp => {
      chrome.runtime.lastError;
      resolve(resp || { ok: false, error: 'No response from page' });
    });
  });
}

// ── Structural snapshot (interactive elements + headings) ─────────────────────

async function getSnapshot(tabId, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const snap = await new Promise(r => {
      chrome.runtime.sendMessage(
        { action: 'AGENT_EXEC', step: { action: 'AGENT_SNAPSHOT' }, tabId },
        resp => { chrome.runtime.lastError; r(resp?.data || null); }
      );
    });
    if (snap && snap.url && snap.url !== 'about:blank') return snap;
    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

function formatSnapshot(snap) {
  if (!snap) return 'Page not loaded yet.';
  const isYT = snap.url?.includes('youtube.com');
  const lines = [
    `URL: ${clean(snap.url)}`,
    `Title: ${clean(snap.title)}`,
  ];
  if (snap.headings?.length) {
    lines.push(`Headings: ${snap.headings.map(h => `"${clean(h)}"`).join(' | ')}`);
  }
  if (snap.inputs?.length) {
    const inps = snap.inputs.slice(0, 5)
      .map(i => clean(i.label || i.ph || i.name || i.id || i.type))
      .filter(Boolean);
    if (inps.length) lines.push(`Inputs: ${inps.join(' | ')}`);
  }
  if (snap.buttons?.length) {
    const btns = snap.buttons.slice(0, 8).map(b => clean(b.text)).filter(Boolean);
    if (btns.length) lines.push(`Buttons: ${btns.join(' | ')}`);
  }
  if (snap.links?.length) {
    const YTSKIP = new Set(['home','shorts','subscriptions','you','history','library',
      'trending','music','gaming','news','sports','explore','live','fashion']);
    let links = snap.links.filter(l => {
      const t = clean(l.text).toLowerCase();
      return t.length > 2 && !(isYT && YTSKIP.has(t));
    });
    if (isYT) {
      const videos = links.filter(l => l.href?.includes('/watch?v='));
      const others = links.filter(l => !l.href?.includes('/watch?v='));
      links = [...videos, ...others];
    }
    const formatted = links.slice(0, 15).map(l => `"${clean(l.text).slice(0, 70)}"`);
    lines.push(`Links (${snap.links.length} total): ${formatted.join(', ')}`);
  }
  lines.push(`Scroll: ${snap.scroll?.y || 0}px / ${snap.scroll?.height || 0}px total`);
  return lines.join('\n');
}

// ── Paged text chunk fetcher ──────────────────────────────────────────────────

async function getPageChunk(tabId, chunkIndex) {
  const resp = await new Promise(resolve => {
    chrome.runtime.sendMessage(
      { action: 'AGENT_EXEC', step: { action: 'AGENT_PAGE_CHUNK', chunkIndex }, tabId },
      r => { chrome.runtime.lastError; resolve(r || { ok: false }); }
    );
  });
  return resp || { ok: false, error: 'No response' };
}

function formatChunk(chunkResp, alreadyRead, notes) {
  if (!chunkResp?.ok) {
    return `[Page chunk could not be read: ${chunkResp?.error || 'unknown error'}]`;
  }
  const { chunk, chunkIndex: ci, totalChunks, headings, links, url, title } = chunkResp;

  const lines = [];

  // ── Reading status header ──
  lines.push(`📄 Page text — currently reading chunk ${ci + 1} of ${totalChunks}`);
  if (alreadyRead.length) {
    lines.push(`   Already read: chunks ${alreadyRead.map(i => i + 1).join(', ')}`);
  }
  const unread = [...Array(totalChunks).keys()].filter(i => i !== ci && !alreadyRead.includes(i));
  if (unread.length) {
    lines.push(`   Unread: chunks ${unread.map(i => i + 1).join(', ')}`);
  }
  lines.push(`   Page: "${clean(title)}" — ${clean(url)}`);

  if (headings?.length) {
    lines.push(`   Headings here: ${headings.map(h => `"${clean(h)}"`).join(' | ')}`);
  }
  if (links?.length) {
    lines.push(`   Links here: ${links.slice(0, 8).map(l => `"${clean(l.text)}"`).join(' | ')}`);
  }

  lines.push('');
  lines.push(chunk);
  lines.push('');

  // ── Notes from previous chunks ──
  if (notes.length) {
    lines.push(formatNotes(notes));
    lines.push('');
  }

  // ── Navigation hint ──
  if (totalChunks > 1) {
    const nav = [];
    if (ci > 0) nav.push(`READ_CHUNK ${ci - 1} (prev)`);
    if (ci < totalChunks - 1) nav.push(`READ_CHUNK ${ci + 1} (next)`);
    nav.push(`READ_CHUNK N (jump to any chunk 0–${totalChunks - 1})`);
    lines.push(`[To continue reading: ${nav.join(' | ')}]`);
    lines.push(`[To save a note from this chunk: include "note":"your note text" in your JSON]`);
  }

  return lines.join('\n');
}

// ── AI step decider ───────────────────────────────────────────────────────────
// Prompt is untouched from v16. Error handling is upgraded.

const STEP_SYSTEM = `You are a browser agent. One action per turn. Reply ONLY with valid JSON, nothing else.

{"action":"ACTION_NAME","target":"value","text":"(TYPE only)","chunkIndex":0,"message":"(DONE/FAIL only)","note":"(optional note to save from this chunk)","reasoning":"why"}

ACTIONS:
- NAVIGATE(target=url) — go to a URL
- CLICK_LINK(target=exact link text from snapshot)
- CLICK_BUTTON(target=exact button text from snapshot)
- TYPE(target=field name/placeholder, text=what to type)
- PRESS_KEY(target=Enter|Tab|Escape)
- WAIT(target=milliseconds, max 5000)
- READ_CHUNK(chunkIndex=N) — read page text chunk N. The page is split into chunks; use this to read content without scrolling. You see the current chunk index and total in the chunk header.
- DONE(message=summary of what you found)
- FAIL(message=why you couldn't complete the task)

RULES:
- Use READ_CHUNK to read page content — NOT SCROLL. READ_CHUNK re-fetches the page fresh so you always see current content.
- After NAVIGATE, use WAIT 2000, then take a structural snapshot before reading chunks.
- Copy link/button text EXACTLY from the snapshot — no paraphrasing.
- When you find the answer in a chunk, use DONE with the answer in the message.
- If you've read all chunks and can't find the answer, try clicking a relevant link or use FAIL.
- READ_CHUNK scrolls the browser to that part of the page so the user can see what you're reading.
- Use the optional "note" field to save important data from a chunk (e.g. a number, name, date) that you might need later. Notes persist across chunks.`;

async function decideNextStep(task, history, context, cfg) {
  const userPrompt = `TASK: ${clean(task)}

CURRENT STATE:
${context}

HISTORY (last 6 steps):
${history.length ? history.slice(-6).join('\n') : 'None yet'}

What is the single best next action? Reply with JSON only.`;

  // Apply rate caution delay BEFORE the call to spread TPM across the minute
  await rateCautionDelay(cfg);

  // Attempt 1: with response_format json_object (preferred — stricter)
  // Attempt 2+: without response_format (fallback for models that choke on it)
  for (let attempt = 0; attempt < 4; attempt++) {
    const useJsonMode = attempt < 2; // first two attempts use json_object mode

    const body = {
      model:                 cfg.ai?.model || 'openai/gpt-oss-20b',
      temperature:           0.1,
      max_completion_tokens: 400,
      // Disable tool-calling on models that have it built in (e.g. gpt-oss-20b).
      // Without this, those models call a "browser.action" tool that doesn't
      // exist here, causing Groq 400 "tool_use_failed" errors.
      tool_choice:           'none',
      tools:                 [],
      messages: [
        { role: 'system', content: STEP_SYSTEM },
        { role: 'user',   content: userPrompt  },
      ],
      ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cfg.groqApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      // Exponential back-off with jitter, max 30s
      const retryAfter = parseInt(resp.headers?.get?.('retry-after') || '0', 10) * 1000;
      const backoff    = Math.min(
        retryAfter || (Math.pow(2, attempt) * 4000 + Math.random() * 3000),
        30000
      );
      alog('info', 'RATE_LIMIT', `429 — backing off ${(backoff / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (resp.status === 400) {
      // 400 can mean: empty generation (json_validate_failed) or tool-use conflict.
      // Drop json_object mode and retry with plain text extraction.
      const errText = await resp.text();
      alog('info', 'GROQ_400', `attempt ${attempt + 1} — ${errText.slice(0, 120)}`);
      if (attempt >= 2) throw new Error(`Groq 400 after fallback: ${errText.slice(0, 200)}`);
      // Next attempt will have useJsonMode=false
      continue;
    }

    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);

    const data = await resp.json();
    let raw = data.choices?.[0]?.message?.content || '';

    if (!raw.trim()) {
      // Empty response — retry without json_object
      alog('info', 'EMPTY_RESP', `attempt ${attempt + 1} got empty response, retrying`);
      continue;
    }

    // Extract JSON from the response (handles markdown fences and leading prose)
    raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      alog('info', 'NO_JSON', `attempt ${attempt + 1}: ${raw.slice(0, 100)}`);
      if (attempt >= 3) throw new Error(`Could not extract JSON from AI response: ${raw.slice(0, 200)}`);
      continue;
    }

    try {
      return JSON.parse(match[0]);
    } catch (e) {
      alog('info', 'PARSE_ERR', `attempt ${attempt + 1}: ${e.message}`);
      if (attempt >= 3) throw new Error(`JSON parse failed: ${e.message}`);
    }
  }

  throw new Error('All AI attempts failed — check your Groq API key and model in Settings.');
}

// ── Execute one step ──────────────────────────────────────────────────────────

async function execStep(step, tabId) {
  const action = (step.action || '').toUpperCase();
  alog('step', action, step.target || step.message || step.text || '', { tabId });

  switch (action) {
    case 'NAVIGATE': {
      const url = step.target;
      if (!url?.startsWith('http')) return { ok: false, error: `Invalid URL: ${url}` };
      alog('info', 'NAVIGATE', url);
      const resp = await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'AGENT_NAVIGATE', url }, r)
      );
      await new Promise(r => setTimeout(r, 2500));
      const newTabId = resp?.tabId || await getActiveTabId();
      return { ok: true, result: `Navigated to ${url}`, newTabId };
    }

    case 'CLICK_LINK': {
      const r = await sendToTab(tabId, { action: 'AGENT_CLICK_LINK', text: step.target });
      if (!r.ok) return { ok: false, error: r.error };
      await new Promise(r2 => setTimeout(r2, 1200));
      return { ok: true, result: `Clicked link: "${r.found}"` };
    }

    case 'CLICK_BUTTON': {
      const r = await sendToTab(tabId, { action: 'AGENT_CLICK_BUTTON', text: step.target });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: `Clicked button: "${r.found}"` };
    }

    case 'CLICK': {
      const r = await sendToTab(tabId, { action: 'AGENT_CLICK', target: step.target });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: `Clicked: "${r.found}"` }; 
    }

    case 'TYPE': {
      const r = await sendToTab(tabId, { action: 'AGENT_TYPE', target: step.target, text: step.text, clear: true });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, result: `Typed "${step.text}" into ${step.target}` };
    }

    case 'SCROLL': {
      const dir = (step.target || 'down').toLowerCase();
      await sendToTab(tabId, { action: 'AGENT_SCROLL', direction: dir, amount: 500 });
      await new Promise(r => setTimeout(r, 900));
      return { ok: true, result: `Scrolled ${dir}` };
    }

    case 'PRESS_KEY': {
      await sendToTab(tabId, { action: 'AGENT_PRESS_KEY', key: step.target || 'Enter' });
      await new Promise(r => setTimeout(r, 700));
      return { ok: true, result: `Pressed ${step.target}` };
    }

    case 'WAIT': {
      const ms = Math.min(parseInt(step.target || 1500), 5000);
      await new Promise(r => setTimeout(r, ms));
      return { ok: true, result: `Waited ${ms}ms` };
    }

    case 'READ_CHUNK': {
      const idx = typeof step.chunkIndex === 'number' ? step.chunkIndex
        : parseInt(step.target ?? '0', 10) || 0;
      const chunkResp = await getPageChunk(tabId, idx);
      if (!chunkResp?.ok) return { ok: false, error: chunkResp?.error || 'chunk failed' };
      alog('info', 'READ_CHUNK', `chunk ${idx + 1}/${chunkResp.totalChunks}`);
      return {
        ok:        true,
        isChunk:   true,
        chunkData: chunkResp,
        note:      step.note || null, // optional note the AI wants to save
        result:    `Read chunk ${idx + 1} of ${chunkResp.totalChunks}`,
      };
    }

    case 'DONE':
      return { ok: true, done: true, message: step.message || 'Done.' };

    case 'FAIL':
      return { ok: false, done: true, error: step.message || 'Failed.' };

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// ── Main task loop ────────────────────────────────────────────────────────────

export async function* runAgentTask(task, onAsk) {
  alog('info', 'START', task);
  yield { type: 'status', text: '⚙️ Starting…' };

  const cfg = await getConfig();
  if (!cfg.groqApiKey) {
    yield { type: 'error', text: 'No Groq API key. Add it in Settings.' };
    return;
  }

  // Max notes size comes from settings (default 800 chars)
  const MAX_NOTES_CHARS = cfg.agent?.maxNotesChars || 800;

  let tabId = await getActiveTabId();
  const history  = [];
  const MAX_STEPS = 20;
  let stepCount   = 0;

  // Chunk tracking
  let currentChunkContext = null;   // { formatted, chunkIndex, totalChunks }
  const alreadyReadChunks = [];     // indices of chunks already read this task
  let chunkNotes = [];              // [{ chunkIndex, text, ts }]

  while (stepCount < MAX_STEPS) {
    stepCount++;

    alog('info', 'SNAPSHOT', `Step ${stepCount}`);
    const snap    = await getSnapshot(tabId);
    const snapStr = formatSnapshot(snap);

    // Early exit for video tasks
    if (snap?.url?.includes('/watch?v=') && /video|watch|play|find|look for/i.test(task)) {
      alog('ok', 'EARLY_EXIT', 'On video page');
      yield { type: 'done', success: true, message: `Found it — now on: ${snap.title}` };
      return;
    }

    // Build context: snapshot + current chunk (if any) + notes
    let context = snapStr;
    if (currentChunkContext) {
      context += '\n\n' + currentChunkContext.formatted;
    }

    yield {
      type: 'status',
      text: currentChunkContext
        ? `📄 Reading chunk ${currentChunkContext.chunkIndex + 1}/${currentChunkContext.totalChunks}…`
        : `🔍 Analysing page (step ${stepCount})…`,
    };

    // ── Ask AI ──
    let step;
    try {
      step = await decideNextStep(task, history, context, cfg);
      alog('info', 'AI', `${step.action}: ${step.target ?? step.chunkIndex ?? step.message ?? ''}`,
        { reason: step.reasoning });
    } catch (e) {
      alog('fail', 'AI_ERROR', e.message);
      yield { type: 'error', text: `AI error: ${e.message}` };
      return;
    }

    yield { type: 'step', step, stepCount, snapStr };

    if (!step.action) {
      yield { type: 'done', success: false, message: 'AI returned no action.' };
      return;
    }

    // ── Execute ──
    const result = await execStep(step, tabId);
    if (result.newTabId) tabId = result.newTabId;

    // ── Handle READ_CHUNK result ──
    if (result.isChunk && result.chunkData) {
      const cd  = result.chunkData;
      const ci  = cd.chunkIndex;

      // Track which chunks have been read
      if (!alreadyReadChunks.includes(ci)) alreadyReadChunks.push(ci);

      // Save note if AI included one
      if (result.note) {
        chunkNotes = addNote(chunkNotes, ci, result.note, MAX_NOTES_CHARS);
        alog('info', 'NOTE_SAVED', `chunk ${ci + 1}: ${result.note.slice(0, 60)}`);
      }

      // Build the rich chunk context for next decision
      currentChunkContext = {
        formatted:   formatChunk(cd, alreadyReadChunks.filter(i => i !== ci), chunkNotes),
        chunkIndex:  ci,
        totalChunks: cd.totalChunks,
      };

      history.push(
        `✓ READ_CHUNK ${ci + 1}/${cd.totalChunks}` +
        (result.note ? ` [noted: "${result.note.slice(0, 50)}"]` : '') +
        ` — headings: [${(cd.headings || []).join(' | ')}]`
      );

      yield {
        type: 'status',
        text: `📖 Read chunk ${ci + 1}/${cd.totalChunks} — "${clean(cd.title)}"` +
              (result.note ? ` · saved note` : ''),
      };

      await new Promise(r => setTimeout(r, 600));
      continue;
    } else {
      // Non-chunk action: clear chunk context (fresh snapshot next step)
      currentChunkContext = null;
    }

    if (result.done) {
      yield { type: 'done', success: result.ok, message: result.message || result.error };
      return;
    }

    if (!result.ok) {
      alog('fail', 'STEP_FAILED', result.error);
      yield { type: 'step_error', step, error: result.error };

      const question =
        `Couldn't ${step.action.toLowerCase()} "${step.target}": ${result.error}\n\n` +
        `You can:\n- Type **retry** to try again\n- Type **skip** to skip this step\n` +
        `- Type **stop** to cancel\n- Or tell me what to do instead`;

      yield { type: 'ask', question };
      const answer = await onAsk(question);
      const al = (answer || '').toLowerCase().trim();

      if (al === 'stop' || al === 'cancel') {
        yield { type: 'done', success: false, message: 'Stopped.' };
        return;
      }
      if (al === 'skip') {
        history.push(`SKIPPED: ${step.action} "${step.target}" — ${result.error}`);
        continue;
      }

      history.push(`FAILED: ${step.action} "${step.target}" — ${result.error}`);
      history.push(`USER CORRECTION: ${answer}`);
      continue;
    }

    history.push(`✓ ${step.action} "${step.target || step.text || step.message || ''}" → ${result.result}`);
  }

  alog('fail', 'MAX_STEPS', `Hit ${MAX_STEPS} step limit`);
  yield {
    type: 'done',
    success: false,
    message: `Stopped after ${MAX_STEPS} steps. Try breaking the task into smaller parts.`,
  };
}
