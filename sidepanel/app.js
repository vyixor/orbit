// ORBIT — Side Panel App v2

import { initScriptTab, resetScriptManager } from './script-tab.js';
import { getConfig, saveConfig, resetConfig } from '../services/settings.js';
import { db, logAction, STORES } from '../services/db.js';
import { runDiscovery, generateDraft, postReply } from '../services/reddit.js';
import { research, formatResearchContext } from '../services/research.js';
import { chat, parseReminder } from '../services/ai.js';
import { memoryForPrompt, memorySave, memoryDelete, memoryGetAll, applyMemoryUpdate, memoryStats } from '../services/memory.js';
import { runAgentTask, setAgentLogger } from '../services/agent.js';
import {
  speak, stop as ttsStop, setTTSCallbacks, getVoices, isSpeaking,
} from '../services/voice.js';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  activeTab:      'inbox',
  inboxPosts:     [],
  selectedPostIds: new Set(),
  researchMode:   false,
  busy:           false,
  agentAskResolver: null,
  currentSpeakingEl: null,    // the bubble element currently being spoken
  // Chat
  currentSessionId: null,
  chatMessages:   [],   // [{role, content, sources?, ts}]
  sessions:       [],   // [{id, title, createdAt, messages}]
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Markdown renderer (no library needed) ─────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Code blocks ```lang\n...\n```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`
  );

  // Inline code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Bold **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g,     '<strong>$1</strong>');

  // Italic *text* or _text_
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g,   '<em>$1</em>');

  // Unordered lists
  html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)(\n(?!<li>)|$)/g, '<ul>$1</ul>');

  // Ordered lists — group consecutive items into one <ol>
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="ol-item">$1</li>');
  // Group consecutive ol-items — split lines, batch runs, rejoin
  const olLines = html.split('\n');
  const olOut = [];
  let inOl = false;
  for (const line of olLines) {
    if (line.startsWith('<li class="ol-item">')) {
      if (!inOl) { olOut.push('<ol>'); inOl = true; }
      olOut.push(line.replace(/ class="ol-item"/, ''));
    } else {
      if (inOl) { olOut.push('</ol>'); inOl = false; }
      olOut.push(line);
    }
  }
  if (inOl) olOut.push('</ol>');
  html = olOut.join('\n');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Paragraphs — double newline → paragraph break
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs and paragraphs wrapping block elements
  html = html.replace(/<p>\s*(<(?:pre|ul|ol|h[1-3]|hr|blockquote)[^>]*>)/g, '$1');
  html = html.replace(/(<\/(?:pre|ul|ol|h[1-3]|hr|blockquote)>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

// ── Typing animation ──────────────────────────────────────────────────────────
function typeInto(el, html, onDone) {
  // Strip HTML for char-by-char then reveal — instead do word-chunk reveal
  // which preserves HTML structure
  el.innerHTML = '';
  const chars = html.split('');
  let i = 0;
  const CHUNK = 4;
  const DELAY = 12;

  function step() {
    if (i >= chars.length) {
      el.innerHTML = html; // final clean render
      if (onDone) onDone();
      return;
    }
    i = Math.min(i + CHUNK, chars.length);
    // Render partial — slice up to current position
    // We need to be careful not to break mid-tag
    let partial = chars.slice(0, i).join('');
    // Close any open tags roughly
    el.innerHTML = partial;
    scrollChatBottom();
    setTimeout(step, DELAY);
  }
  step();
}

function scrollChatBottom() {
  const msgs = $('chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// ── Status ─────────────────────────────────────────────────────────────────────
function setStatus(text, type = 'idle') {
  const st = $('status-text');
  const dot = $('status-dot');
  if (st) st.textContent = text;
  if (dot) { dot.className = ''; dot.classList.add(type); }
}

// ── Tab routing ────────────────────────────────────────────────────────────────
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const tab = $(`tab-${name}`);
  const btn = document.querySelector(`.nav-btn[data-tab="${name}"]`);
  if (tab) tab.classList.add('active');
  if (btn) btn.classList.add('active');
  state.activeTab = name;
  if (name === 'history') renderHistory();
  if (name === 'tasks') renderTasks();
  if (name === 'settings') renderSettings();
  if (name === 'chat') scrollChatBottom();
  // script tab handled by script-tab.js, no render call needed
}

$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── CHAT SESSIONS ─────────────────────────────────────────────────────────────

async function loadSessions() {
  const all = await db.getAll(STORES.SESSIONS);
  state.sessions = all.sort((a, b) => b.createdAt - a.createdAt);
  renderSessionDropdown();
}

async function createNewSession() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const session = {
    title: `Chat ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.put(STORES.SESSIONS, session);
  const all = await db.getAll(STORES.SESSIONS);
  const created = all.sort((a,b) => b.createdAt - a.createdAt)[0];
  state.currentSessionId = created.id;
  state.chatMessages = [];
  state.sessions = all.sort((a,b) => b.createdAt - a.createdAt);
  renderSessionDropdown();
  renderChatMessages();
  return created;
}

async function autoTitleSession(firstUserMessage) {
  if (!state.currentSessionId) return;
  const session = await db.get(STORES.SESSIONS, state.currentSessionId);
  if (!session) return;
  // Only auto-title if it still has the default "Chat ..." title
  if (!session.title.startsWith('Chat ')) return;
  // Use first ~40 chars of first message as title
  const title = firstUserMessage.slice(0, 42).replace(/\n/g, ' ').trim();
  const newTitle = title.length < firstUserMessage.length ? title + '…' : title;
  await db.put(STORES.SESSIONS, { ...session, title: newTitle, updatedAt: Date.now() });
  state.sessions = state.sessions.map(s =>
    s.id === state.currentSessionId ? { ...s, title: newTitle } : s
  );
  renderSessionDropdown();
}

async function deleteSession(id) {
  await db.delete(STORES.SESSIONS, id);
  state.sessions = state.sessions.filter(s => s.id !== id);
  if (state.currentSessionId === id) {
    if (state.sessions.length) {
      await loadSession(state.sessions[0].id);
    } else {
      await createNewSession();
    }
  }
  renderSessionDropdown();
}

async function renameSession(id, newTitle) {
  const session = await db.get(STORES.SESSIONS, id);
  if (!session) return;
  await db.put(STORES.SESSIONS, { ...session, title: newTitle, updatedAt: Date.now() });
  state.sessions = state.sessions.map(s => s.id === id ? { ...s, title: newTitle } : s);
  renderSessionDropdown();
}

async function saveCurrentSession() {
  if (!state.currentSessionId) return;
  const session = await db.get(STORES.SESSIONS, state.currentSessionId);
  if (!session) return;
  const msgs = state.chatMessages.slice(-30); // keep last 30 messages
  await db.put(STORES.SESSIONS, { ...session, messages: msgs, updatedAt: Date.now() });
  // Update in-memory sessions list for accurate relative times
  state.sessions = state.sessions.map(s =>
    s.id === state.currentSessionId ? { ...s, updatedAt: Date.now() } : s
  );
}

async function loadSession(id) {
  const session = await db.get(STORES.SESSIONS, id);
  if (!session) return;
  state.currentSessionId = id;
  state.chatMessages = session.messages || [];
  renderChatMessages();
  renderSessionDropdown();
}

async function clearCurrentSession() {
  state.chatMessages = [];
  await saveCurrentSession();
  renderChatMessages();
}

function renderSessionDropdown() {
  const sel = $('session-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const s of state.sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const msgCount = (s.messages || []).length;
    const ago = s.updatedAt || s.createdAt
      ? formatRelativeTime(s.updatedAt || s.createdAt) : '';
    opt.textContent = `${s.title}${ago ? ' · ' + ago : ''}`;
    opt.title = `${msgCount} messages`;
    if (s.id === state.currentSessionId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7)  return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Session controls
document.addEventListener('click', async (e) => {
  if (e.target.id === 'btn-new-chat') {
    await saveCurrentSession();
    await createNewSession();
  }
  if (e.target.id === 'btn-clear-chat') {
    if (confirm('Clear all messages in this chat?')) {
      await clearCurrentSession();
    }
  }
  if (e.target.id === 'btn-delete-session') {
    if (!state.currentSessionId) return;
    const session = state.sessions.find(s => s.id === state.currentSessionId);
    if (confirm(`Delete "${session?.title || 'this chat'}"? This cannot be undone.`)) {
      await deleteSession(state.currentSessionId);
    }
  }
  if (e.target.id === 'btn-rename-chat') {
    const session = state.sessions.find(s => s.id === state.currentSessionId);
    if (!session) return;
    // Inline rename — replace select with input temporarily
    const sel = $('session-select');
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = session.title;
    input.maxLength = 60;
    sel.parentNode.replaceChild(input, sel);
    input.focus();
    input.select();

    const finish = async () => {
      const newTitle = input.value.trim() || session.title;
      await renameSession(state.currentSessionId, newTitle);
      input.parentNode.replaceChild(sel, input);
      renderSessionDropdown();
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { input.parentNode.replaceChild(sel, input); renderSessionDropdown(); }
    });
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'session-select') {
    await saveCurrentSession();
    await loadSession(parseInt(e.target.value));
  }
});

// ── CHAT RENDER ────────────────────────────────────────────────────────────────

function renderChatMessages() {
  const container = $('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  for (const msg of state.chatMessages) {
    appendChatBubble(msg, false); // no animation for history
  }
  scrollChatBottom();
}

function formatMsgTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChatBubble(msg, animate = true) {
  const container = $('chat-messages');
  if (!container) return;

  // Outer wrap — holds timestamp + bubble
  const wrap = document.createElement('div');
  wrap.className = `chat-msg-wrap ${msg.role}`;

  const div = document.createElement('div');
  div.className = `chat-msg ${msg.role}`;

  // Timestamp
  const ts = document.createElement('div');
  ts.className = 'chat-ts';
  ts.textContent = formatMsgTime(msg.ts);

  if (msg.role === 'orbit') {
    let inner = `<div class="msg-label">ORBIT</div>`;
    if (msg.research) inner += `<span class="research-badge">🔍 Research</span> `;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    const rendered = renderMarkdown(msg.content);

    if (animate) {
      div.innerHTML = inner;
      div.appendChild(contentDiv);
      wrap.appendChild(div);
      wrap.appendChild(ts);
      container.appendChild(wrap);
      typeInto(contentDiv, rendered, () => {
        if (msg.sources?.length) div.appendChild(buildSourcesEl(msg.sources));
        scrollChatBottom();
      });
    } else {
      contentDiv.innerHTML = renderMarkdown(msg.content);
      div.innerHTML = inner;
      div.appendChild(contentDiv);
      if (msg.sources?.length) div.appendChild(buildSourcesEl(msg.sources));
      wrap.appendChild(div);
      wrap.appendChild(ts);
      container.appendChild(wrap);
    }
  } else {
    div.textContent = msg.content;
    wrap.appendChild(div);
    wrap.appendChild(ts);
    container.appendChild(wrap);
  }

  scrollChatBottom();
}

function buildSourcesEl(sources) {
  const el = document.createElement('div');
  el.className = 'chat-sources';
  el.innerHTML = `<div class="src-label">Sources</div>` +
    sources.slice(0,4).map(s =>
      `<a href="${s.url}" target="_blank">${escHtml(s.title || s.url)}</a>`
    ).join('');
  return el;
}

// ── Chat send ──────────────────────────────────────────────────────────────────

async function sendChat() {
  const input = $('chat-input');
  const rawText = input.value.trim();
  if (!rawText) return;
  input.value = '';
  $('chat-input').classList.remove('interim');
  await sendChatText(rawText, false);
}

$('btn-send-chat').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('toggle-research-mode').addEventListener('change', (e) => {
  state.researchMode = e.target.checked;
});

// sendChatText — core send logic, callable from wake word or button
async function sendChatText(rawText) {
  if (!rawText) return;

  // !! Check resolver FIRST — the agent is busy by design while waiting for input.
  // Checking state.busy before this silently swallowed the user's reply.
  if (state.agentAskResolver) {
    const resolver = state.agentAskResolver;
    state.agentAskResolver = null;
    const userMsg = { role: 'user', content: rawText, ts: Date.now() };
    state.chatMessages.push(userMsg);
    appendChatBubble(userMsg, false);
    await saveCurrentSession();
    resolver(rawText);
    return;
  }

  if (state.busy) return;

  // Ensure session exists
  if (!state.currentSessionId) await createNewSession();

  state.busy = true;
  // NOTE: don't disable send button here — agent asks need it enabled
  $('btn-send-chat').disabled = false;



  const userMsg = { role: 'user', content: rawText, ts: Date.now() };
  state.chatMessages.push(userMsg);
  appendChatBubble(userMsg, false);

  // Auto-title from first user message
  const userMsgCount = state.chatMessages.filter(m => m.role === 'user').length;
  if (userMsgCount === 1) autoTitleSession(rawText);

  setStatus('Thinking…', 'thinking');

  try {
    // Check for intent: scan, reminder, research
    const intent = detectIntent(rawText);

    if (intent === 'SCAN') {
      await handleScanIntent(rawText);
    } else if (intent === 'REMINDER') {
      await handleReminderIntent(rawText);
    } else if (intent === 'READ_PAGE') {
      await handleReadPageIntent(rawText);
    } else if (intent === 'AGENT') {
      await handleAgentIntent(rawText);
    } else if (intent === 'MEMORY') {
      await handleMemoryIntent(rawText);
    } else {
      await handleChatIntent(rawText);
    }
  } catch (e) {
    const errMsg = { role: 'orbit', content: `Something went wrong: ${e.message}`, ts: Date.now() };
    state.chatMessages.push(errMsg);
    appendChatBubble(errMsg, true);
    setStatus('Error', 'error');
  } finally {
    state.busy = false;
    $('btn-send-chat').disabled = false;
    await saveCurrentSession();
    if (state.activeTab === 'chat') setStatus('Idle', 'idle');
  }
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(scan|check reddit|find posts?|look for posts?|search reddit|what('s| is) on reddit|find discussions?|find something)\b/.test(t)) return 'SCAN';
  if (/\b(remind|reminder|every|daily|weekly|schedule|at \d|tomorrow|tonight)\b/.test(t) && /\b(remind|schedule|set)\b/.test(t)) return 'REMINDER';
  if (/\b(read (this|the|current) (page|site|article|post)|summarize (this|the|current) (page|site|article)|what('s| is|does) (this|the) (page|site|article)|tldr|tl;?dr|explain this page)\b/.test(t)) return 'READ_PAGE';
  if (/\b(open |go to |navigate to |search (for|on)|scroll|click |type |fill |submit |enter .* in|do .* on|browse to|visit )/.test(t)) return 'AGENT';
  if (/\b(remember (this|that|my)|save (this|that|to memory)|forget (this|that|about)|what do you (know|remember)|your memory|clear memory)\b/.test(t)) return 'MEMORY';
  return 'CHAT';
}

async function handleScanIntent(userText) {
  const msg = { role: 'orbit', content: 'Scanning Reddit for you…', ts: Date.now() };
  state.chatMessages.push(msg);
  appendChatBubble(msg, true);

  try {
    setStatus('Scanning…', 'thinking');
    const { posts, message } = await runDiscovery();

    let response;
    if (!posts.length) {
      response = message || 'I scanned Reddit but nothing came through the filter. Check your settings — you might want to add subreddits or relax the score filter.';
    } else {
      state.inboxPosts = posts.map(p => ({ post: p, draft: null }));
      response = `Found **${posts.length} posts**. I've loaded them in the Inbox tab — go check them out and select the ones you want to reply to.`;
    }

    const replyMsg = { role: 'orbit', content: response, ts: Date.now() };
    state.chatMessages.push(replyMsg);
    appendChatBubble(replyMsg, true);

    // Also render inbox
    if (posts.length) renderPostList();
  } catch (e) {
    const errMsg = { role: 'orbit', content: `Scan failed: ${e.message}`, ts: Date.now() };
    state.chatMessages.push(errMsg);
    appendChatBubble(errMsg, true);
  }
}

async function handleReminderIntent(userText) {
  setStatus('Parsing reminder…', 'thinking');
  try {
    const parsed = await parseReminder(userText);
    if (!parsed.valid) throw new Error(parsed.error || 'Could not parse that as a reminder');

    const task = {
      title: parsed.title,
      description: userText,
      nextRun: new Date(parsed.triggerAt).getTime(),
      recurrence: parsed.recurrence || 'none',
      recurrenceDays: parsed.recurrenceDays || [],
      status: 'active',
      createdAt: Date.now(),
    };
    await chrome.runtime.sendMessage({ action: 'SAVE_TASK', task });
    await logAction('task_created', { title: task.title });

    const when = new Date(task.nextRun).toLocaleString();
    const reply = `Done. Reminder set: **${parsed.title}**\nFires: ${when}${task.recurrence !== 'none' ? ` · repeats ${task.recurrence}` : ''}`;
    const msg = { role: 'orbit', content: reply, ts: Date.now() };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);
  } catch (e) {
    const msg = { role: 'orbit', content: `Couldn't set that reminder: ${e.message}`, ts: Date.now() };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);
  }
}

async function handleReadPageIntent(userText) {
  setStatus('Reading page…', 'thinking');

  const thinking = { role: 'orbit', content: 'Reading the current tab…', ts: Date.now() };
  state.chatMessages.push(thinking);
  appendChatBubble(thinking, true);

  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'READ_CURRENT_TAB_PAGE',
      maxWords: 1200,
    });

    if (resp.error || !resp.content) {
      throw new Error(resp.error || 'Could not read the page. Try refreshing it first.');
    }

    const { title, url, text, wordCount } = resp.content;

    // Build a focused prompt
    const memStr = await memoryForPrompt(10);

    const pageContext = `Page title: ${title}\nURL: ${url}\n\nContent (~${wordCount} words):\n${text}`;

    const result = await chat(
      `The user asked: "${userText}"\n\nHere is the page content:\n${pageContext}\n\nAnswer the user's question about this page. Be concise and specific. Use markdown for structure.`,
      '', false, memStr
    );

    const msg = {
      role: 'orbit',
      content: `**${escHtml(title)}**\n\n${result.response}`,
      ts: Date.now(),
    };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);
    setStatus('Done', 'ok');



  } catch (e) {
    const msg = { role: 'orbit', content: `Couldn't read the page: ${e.message}`, ts: Date.now() };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);
    setStatus('Error', 'error');
  }
}

// ── Agent intent ─────────────────────────────────────────────────────────────

async function handleAgentIntent(userText) {
  setStatus('Planning…', 'thinking');

  const planMsg = { role: 'orbit', content: '⚙️ Planning browser actions…', ts: Date.now() };
  state.chatMessages.push(planMsg);
  appendChatBubble(planMsg, false);

  // Collect agent question answers from user
  const pendingAsks = [];
  let askResolver = null;

  function onAsk(question) {
    return new Promise(resolve => {
      askResolver = resolve;
      // Show question as orbit message
      const askMsg = { role: 'orbit', content: `❓ ${question}`, ts: Date.now(), isAsk: true };
      state.chatMessages.push(askMsg);
      appendChatBubble(askMsg, true);
      // The next user message in chat will resolve this
      pendingAsks.push({ question, resolve });
    });
  }

  // Override sendChat temporarily to capture answers
  state.agentAskResolver = null;

  try {
    const gen = runAgentTask(userText, (question) => {
      return new Promise(resolve => {
        state.agentAskResolver = resolve;
        const askMsg = { role: 'orbit', content: `❓ ${question}`, ts: Date.now() };
        state.chatMessages.push(askMsg);
        appendChatBubble(askMsg, true);
        saveCurrentSession();
      });
    });

    for await (const event of gen) {
      switch (event.type) {
        case 'status':
          setStatus(event.text, 'thinking');
          break;

        case 'plan': {
          const stepLines = event.steps
            .map((s, i) => {
              const parts = [s.action];
              if (s.target) parts.push(`→ "${s.target}"`);
              if (s.url)    parts.push(s.url);
              if (s.text)   parts.push(`"${s.text}"`);
              if (s.key)    parts.push(s.key);
              return `${i+1}. ${parts.join(' ')}`;
            })
            .join('\n');
          const planDisplay = {
            role: 'orbit',
            content: "**Plan:** " + event.summary + "\n```\n" + stepLines + "\n```",
            ts: Date.now(),
          };
          state.chatMessages.push(planDisplay);
          appendChatBubble(planDisplay, true);
          // Also log to agent panel
          addAgentLogRow({ level: 'info', action: 'PLAN', detail: event.summary, data: { steps: event.steps.length }, ts: Date.now() });
          switchTab('agentlog');
          setTimeout(() => switchTab('chat'), 1200);
          break;
        }

        case 'step': {
          const s = event.step;
          const label = [s.action, s.target, s.text, s.message].filter(Boolean).join(' ');
          setStatus(`${s.action} (${event.stepCount})`, 'thinking');
          addAgentLogRow({ level: 'step', action: s.action, detail: label.slice(0,100), ts: Date.now() });
          // Show snapshot summary in agent log
          if (event.snapStr) {
            const firstLine = event.snapStr.split('\n')[0];
            addAgentLogRow({ level: 'info', action: 'PAGE_STATE', detail: firstLine, ts: Date.now() });
          }
          break;
        }

        case 'step_error':
          setStatus('Step failed', 'error');
          addAgentLogRow({ level: 'fail', action: event.step.action, detail: event.error, ts: Date.now() });
          break;

        case 'ask':
          setStatus('Waiting for your answer…', 'idle');
          // Make sure send button is explicitly enabled
          $('btn-send-chat').disabled = false;
          $('chat-input').focus();
          break;

        case 'error': {
          const errMsg = { role: 'orbit', content: `❌ ${event.text}`, ts: Date.now() };
          state.chatMessages.push(errMsg);
          appendChatBubble(errMsg, true);
          setStatus('Error', 'error');
          addAgentLogRow({ level: 'fail', action: 'ERROR', detail: event.text, ts: Date.now() });
          break;
        }

        case 'done': {
          const doneMsg = {
            role: 'orbit',
            content: event.success
              ? `✅ ${event.message}`
              : `❌ ${event.message}`,
            ts: Date.now(),
          };
          state.chatMessages.push(doneMsg);
          appendChatBubble(doneMsg, true);
          setStatus(event.success ? 'Done' : 'Stopped', event.success ? 'ok' : 'error');
          addAgentLogRow({ level: event.success ? 'ok' : 'fail', action: 'DONE', detail: event.message, ts: Date.now() });
          break;
        }
      }
      await saveCurrentSession();
    }
  } catch (e) {
    const errMsg = { role: 'orbit', content: `Agent error: ${e.message}`, ts: Date.now() };
    state.chatMessages.push(errMsg);
    appendChatBubble(errMsg, true);
    setStatus('Error', 'error');
  }

  state.agentAskResolver = null;
}

// ── Memory intent ─────────────────────────────────────────────────────────────

async function handleMemoryIntent(userText) {
  const t = userText.toLowerCase();

  if (/what do you (know|remember)|show.*memory|your memory|what.*have.*for me|what.*in.*memory|check.*memory/.test(t)) {
    const all = await memoryGetAll();
    const stats = await memoryStats();
    if (!all.length) {
      const msg = { role: 'orbit', content: "Nothing in memory yet — tell me something worth saving.", ts: Date.now() };
      state.chatMessages.push(msg);
      appendChatBubble(msg, true);
      return;
    }
    // Group by category
    const byCategory = {};
    for (const m of all) {
      const cat = m.category || 'general';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(m);
    }
    const lines = Object.entries(byCategory).map(([cat, items]) => {
      const itemLines = items.map(m => `  - ${m.key.replace(/_/g,' ')}: ${m.value}`).join('\n');
      return `**${cat}**\n${itemLines}`;
    }).join('\n\n');
    const msg = {
      role: 'orbit',
      content: `Here's what I have (${stats.count}/${stats.max} slots used):\n\n${lines}`,
      ts: Date.now(),
    };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);

  } else if (/clear memory|forget everything|wipe memory/.test(t)) {
    await db.clear(STORES.MEMORY);
    const msg = { role: 'orbit', content: "Memory cleared.", ts: Date.now() };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);

  } else if (/forget (about |that )?(.+)/.test(t)) {
    const match = t.match(/forget (?:about |that )?(.+)/);
    const topic = match?.[1]?.trim();
    if (topic) {
      const all = await memoryGetAll();
      const toDelete = all.filter(m =>
        m.key.toLowerCase().includes(topic) || m.value.toLowerCase().includes(topic)
      );
      for (const item of toDelete) await memoryDelete(item.key);
      const msg = {
        role: 'orbit',
        content: toDelete.length ? `Forgot ${toDelete.length} item(s) about "${topic}".` : `Nothing about "${topic}" in memory.`,
        ts: Date.now(),
      };
      state.chatMessages.push(msg);
      appendChatBubble(msg, true);
    }

  } else if (/save|remember/.test(t)) {
    // Extract what to save
    const cleaned = userText
      .replace(/save this( to (your )?memory)?[:\-]?\s*/i, '')
      .replace(/remember (that |this )?/i, '')
      .trim();

    if (cleaned) {
      const key = 'user_note_' + Date.now();
      await memorySave(key, cleaned, { relevance: 7, category: 'user_saved', source: 'user' });
      const msg = { role: 'orbit', content: `Got it, saved to memory: _"${escHtml(cleaned)}"_`, ts: Date.now() };
      state.chatMessages.push(msg);
      appendChatBubble(msg, true);
    }

  } else {
    await handleChatIntent(userText);
  }

  await saveCurrentSession();
}

async function handleChatIntent(userText) {
  const memStr = await memoryForPrompt(20);

  // Recent conversation context (last 8 messages from current session)
  const recentHistory = state.chatMessages.slice(-9, -1) // exclude current user msg
    .map(m => `${m.role === 'user' ? 'User' : 'ORBIT'}: ${m.content}`)
    .join('\n');

  let researchData = null;
  const result = await chat(userText, recentHistory, state.researchMode, memStr);

  // Auto-research if needed
  if (result.needsResearch && result.researchQuery) {
    setStatus('Researching…', 'thinking');
    try {
      researchData = await research(result.researchQuery);
      const ctx = formatResearchContext(researchData);
      const refined = await chat(
        `Question: ${userText}\n\nResearch:\n${ctx}\n\nAnswer based on research. Cite sources where relevant.`,
        '', false, memStr
      );
      result.response = refined.response;
    } catch (_) {} // fallback to original response
  }

  // Save memory updates
  if (result.memoryUpdate) {
    await applyMemoryUpdate(result.memoryUpdate);
  }

  const msg = {
    role: 'orbit',
    content: result.response,
    sources: researchData?.sources || null,
    research: !!researchData,
    ts: Date.now(),
  };
  state.chatMessages.push(msg);
  appendChatBubble(msg, true);

}


// ── INBOX ──────────────────────────────────────────────────────────────────────

$('btn-scan').addEventListener('click', doScan);

async function doScan() {
  if (state.busy) return;
  state.busy = true;
  $('btn-scan').disabled = true;
  setStatus('Scanning…', 'thinking');

  const empty = $('inbox-empty');
  const list  = $('post-list');
  empty.innerHTML = '⏳ Opening Reddit and scanning…';
  empty.style.display = 'block';
  list.innerHTML = '';

  try {
    const { posts, message } = await runDiscovery();
    state.inboxPosts = posts.map(p => ({ post: p, draft: null }));
    renderPostList();

    if (!posts.length) {
      empty.innerHTML = message || 'Nothing found. Try adjusting your subreddit or keyword filters in Settings.';
    } else {
      empty.style.display = 'none';
    }
    setStatus(`${posts.length} posts`, 'ok');
  } catch (e) {
    setStatus('Error', 'error');
    empty.innerHTML = `<span class="error-msg">❌ ${escHtml(e.message)}</span>`;
  } finally {
    state.busy = false;
    $('btn-scan').disabled = false;
  }
}

$('btn-clear-inbox').addEventListener('click', () => {
  state.inboxPosts = [];
  state.selectedPostIds.clear();
  renderPostList();
  updateActionBar();
  $('inbox-empty').style.display = 'block';
  $('inbox-empty').textContent = 'No posts yet. Hit Scan Reddit with a Reddit tab open.';
});

$('btn-draft-selected').addEventListener('click', async () => {
  const ids = [...state.selectedPostIds];
  if (!ids.length) return;
  setStatus('Drafting…', 'thinking');
  for (const id of ids) {
    const entry = state.inboxPosts.find(e => e.post.id === id);
    if (!entry || entry.draft) continue;
    try {
      entry.draft = await generateDraft(id);
    } catch (e) { console.error('Draft failed', id, e); }
  }
  renderPostList();
  setStatus('Drafts ready', 'ok');
});

$('btn-deselect-all').addEventListener('click', () => {
  state.selectedPostIds.clear();
  renderPostList();
  updateActionBar();
});

function updateActionBar() {
  const count = state.selectedPostIds.size;
  $('post-action-bar').style.display = count > 0 ? 'flex' : 'none';
  $('selected-count').textContent = `${count} post${count !== 1 ? 's' : ''} selected`;
}

function priorityClass(p) {
  if (p == null) return 'priority-low';
  if (p >= 0.75) return 'priority-high';
  if (p >= 0.45) return 'priority-mid';
  return 'priority-low';
}
function priorityLabel(p) {
  if (p == null) return '—';
  if (p >= 0.75) return 'High';
  if (p >= 0.45) return 'Med';
  return 'Low';
}
function formatAge(mins) {
  if (!mins && mins !== 0) return '?';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins/60)}h`;
  return `${Math.round(mins/1440)}d`;
}

function renderPostList() {
  const list = $('post-list');
  list.innerHTML = '';
  if (!state.inboxPosts.length) return;

  for (const entry of state.inboxPosts) {
    const { post, draft } = entry;
    const card = document.createElement('div');
    card.className = `post-card${state.selectedPostIds.has(post.id) ? ' selected' : ''}`;
    card.dataset.id = post.id;

    const pClass = priorityClass(post.priority);
    const pLabel = priorityLabel(post.priority);

    // AI badge
    const aiBadge = post.aiRelevant === true
      ? `<span class="ai-badge ai-yes">✓ AI</span>`
      : post.aiRelevant === false
        ? `<span class="ai-badge ai-no">✗ AI</span>`
        : `<span class="ai-badge ai-none">unscored</span>`;

    card.innerHTML = `
      <div class="post-card-top">
        <input type="checkbox" class="post-checkbox" ${state.selectedPostIds.has(post.id) ? 'checked' : ''} />
        <div class="post-card-body">
          <div class="post-meta">
            <span class="post-sub">r/${escHtml(post.subreddit || '?')}</span>
            <span class="post-age">${formatAge(post.ageMinutes)}</span>
            <span class="post-score">▲${post.score || 0}</span>
            <span class="post-priority ${pClass}">${pLabel}</span>
            ${aiBadge}
          </div>
          <div class="post-title">${escHtml(post.title)}</div>
          ${post.aiReason ? `<div class="post-reason">${escHtml(post.aiReason)}</div>` : ''}
          <div class="post-card-actions">
            <button class="btn-ghost btn-sm btn-open-post">Open</button>
            <button class="btn-ghost btn-sm btn-draft-one">Draft Reply</button>
            <button class="btn-ghost btn-sm btn-research-post">Research</button>
            <button class="btn-ghost btn-sm btn-remove-post" style="color:var(--red)">Remove</button>
          </div>
        </div>
      </div>
      ${draft ? renderDraftHTML(post, draft) : ''}
    `;

    card.querySelector('.post-checkbox').addEventListener('change', (e) => {
      if (e.target.checked) state.selectedPostIds.add(post.id);
      else state.selectedPostIds.delete(post.id);
      card.classList.toggle('selected', e.target.checked);
      updateActionBar();
    });
    card.querySelector('.btn-open-post').addEventListener('click', () => chrome.tabs.create({ url: post.url }));
    card.querySelector('.btn-draft-one').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Drafting…';
      setStatus('Drafting…', 'thinking');
      try {
        entry.draft = await generateDraft(post.id);
        renderPostList();
        setStatus('Done', 'ok');
      } catch (err) { e.target.textContent = 'Failed'; setStatus('Error','error'); }
    });
    card.querySelector('.btn-research-post').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Searching…';
      setStatus('Researching…', 'thinking');
      try {
        const result = await research(`${post.title} ${post.subreddit}`);
        switchTab('chat');
        const msg = { role: 'orbit', content: `Research on **${post.title}**:\n\n${result.answer || ''}`, sources: result.sources, ts: Date.now() };
        state.chatMessages.push(msg);
        appendChatBubble(msg, true);
        setStatus('Done', 'ok');
      } catch (err) { setStatus('Error','error'); }
      finally { e.target.disabled = false; e.target.textContent = 'Research'; }
    });
    card.querySelector('.btn-remove-post').addEventListener('click', () => {
      state.inboxPosts = state.inboxPosts.filter(en => en.post.id !== post.id);
      state.selectedPostIds.delete(post.id);
      renderPostList();
      updateActionBar();
    });

    if (draft) wireDraftActions(card, entry);
    list.appendChild(card);
  }
}

function renderDraftHTML(post, draft) {
  return `
    <div class="draft-section">
      <div class="draft-label">Draft Reply</div>
      ${draft.notes ? `<div class="draft-notes">${escHtml(draft.notes)}</div>` : ''}
      <textarea class="draft-textarea">${escHtml(draft.text)}</textarea>
      <div class="draft-actions">
        <button class="btn-primary btn-sm btn-post-reply">Post Reply</button>
        <button class="btn-ghost btn-sm btn-regen-draft">Regenerate</button>
        <label class="auto-post-label">
          <input type="checkbox" class="auto-post-cb" ${!draft.requireApproval ? 'checked' : ''} />
          Auto-post
        </label>
      </div>
    </div>
  `;
}

function wireDraftActions(card, entry) {
  const { post, draft } = entry;
  const ta = card.querySelector('.draft-textarea');
  if (ta) ta.addEventListener('input', () => { entry.draft.text = ta.value; });

  const autoCb = card.querySelector('.auto-post-cb');
  if (autoCb) autoCb.addEventListener('change', () => { entry.draft.requireApproval = !autoCb.checked; });

  const postBtn = card.querySelector('.btn-post-reply');
  if (postBtn) {
    postBtn.addEventListener('click', async () => {
      postBtn.disabled = true; postBtn.textContent = 'Posting…';
      setStatus('Posting…', 'thinking');
      try {
        const result = await postReply({ ...entry.draft, text: entry.draft.text });
        postBtn.textContent = result.status === 'posted' ? 'Posted ✓' : 'Inserted ✓';
        setStatus(result.status === 'posted' ? 'Posted' : 'Inserted — submit in Reddit', 'ok');
      } catch (err) {
        postBtn.disabled = false; postBtn.textContent = 'Post Reply';
        setStatus('Error', 'error');
      }
    });
  }

  const regenBtn = card.querySelector('.btn-regen-draft');
  if (regenBtn) {
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true; regenBtn.textContent = 'Regen…';
      setStatus('Drafting…', 'thinking');
      try {
        entry.draft = await generateDraft(post.id);
        renderPostList();
        setStatus('Done', 'ok');
      } catch (e) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
    });
  }
}

// ── TASKS ──────────────────────────────────────────────────────────────────────

$('btn-add-task').addEventListener('click', () => {
  const area = $('task-input-area');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
  if (area.style.display === 'block') $('task-nlp-input').focus();
});
$('btn-cancel-task').addEventListener('click', () => {
  $('task-input-area').style.display = 'none';
  $('task-nlp-input').value = '';
});
$('btn-parse-task').addEventListener('click', async () => {
  const text = $('task-nlp-input').value.trim();
  if (!text) return;
  $('btn-parse-task').disabled = true;
  $('btn-parse-task').textContent = 'Parsing…';
  setStatus('Parsing…', 'thinking');
  try {
    const parsed = await parseReminder(text);
    if (!parsed.valid) throw new Error(parsed.error || 'Could not parse');
    const task = {
      title: parsed.title,
      description: text,
      nextRun: new Date(parsed.triggerAt).getTime(),
      recurrence: parsed.recurrence || 'none',
      status: 'active',
      createdAt: Date.now(),
    };
    await chrome.runtime.sendMessage({ action: 'SAVE_TASK', task });
    $('task-input-area').style.display = 'none';
    $('task-nlp-input').value = '';
    await renderTasks();
    setStatus('Saved', 'ok');
  } catch (e) {
    setStatus('Error', 'error');
    alert(`Could not parse: ${e.message}`);
  } finally {
    $('btn-parse-task').disabled = false;
    $('btn-parse-task').textContent = 'Parse & Save';
  }
});

async function renderTasks() {
  const list = $('task-list');
  list.innerHTML = '';
  const tasks = await db.getAll(STORES.TASKS);
  if (!tasks.length) { list.innerHTML = '<div class="empty-state"><p>No reminders yet.</p></div>'; return; }
  tasks.sort((a, b) => (a.nextRun || 0) - (b.nextRun || 0));
  for (const task of tasks) {
    const card = document.createElement('div');
    card.className = `task-card${task.status === 'done' ? ' task-done' : ''}`;
    const nextStr = task.nextRun ? new Date(task.nextRun).toLocaleString() : '—';
    card.innerHTML = `
      <div class="task-info">
        <div class="task-title">${escHtml(task.title)}${task.system ? ' <span class="task-sys">system</span>' : ''}</div>
        <div class="task-next">Next: ${nextStr}</div>
        ${task.recurrence && task.recurrence !== 'none' ? `<div class="task-recur">${task.recurrence}</div>` : ''}
      </div>
      <button class="btn-ghost btn-sm" data-del="${task.id}">×</button>
    `;
    card.querySelector('[data-del]').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'DELETE_TASK', id: task.id });
      card.remove();
    });
    list.appendChild(card);
  }
}

// ── HISTORY ────────────────────────────────────────────────────────────────────

async function renderHistory() {
  const list = $('history-list');
  list.innerHTML = '';
  const rows = await db.getAllSorted(STORES.HISTORY, 'timestamp', 'prev', 100);
  if (!rows.length) { list.innerHTML = '<div class="empty-state"><p>No activity yet.</p></div>'; return; }
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'history-row';
    const t = new Date(row.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const detail = Object.entries(row)
      .filter(([k]) => !['id','type','timestamp'].includes(k))
      .map(([k,v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ');
    div.innerHTML = `
      <span class="history-time">${t}</span>
      <span class="history-type">${escHtml(row.type)}</span>
      <span class="history-detail">${escHtml(detail)}</span>
    `;
    list.appendChild(div);
  }
}
$('btn-clear-history').addEventListener('click', async () => { await db.clear(STORES.HISTORY); renderHistory(); });

// ── SETTINGS ───────────────────────────────────────────────────────────────────

async function renderSettings() {
  const cfg = await getConfig();
  const form = $('settings-form');
  form.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">API Keys</div>
      <div class="field"><label>Groq API Key</label><input type="password" id="s-groq-key" value="${cfg.groqApiKey}" placeholder="gsk_…" /></div>
      <div class="field">
        <label>Groq Model</label>
        <input type="text" id="s-ai-model" value="${escAttr(cfg.ai?.model || 'openai/gpt-oss-20b')}" placeholder="openai/gpt-oss-20b" list="groq-models-list" autocomplete="off" spellcheck="false" />
        <datalist id="groq-models-list">
          <option value="openai/gpt-oss-20b">gpt-oss-20b — free, generous TPM (default)</option>
          <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile — strong reasoning</option>
          <option value="llama-3.1-8b-instant">llama-3.1-8b-instant — fastest, lowest cost</option>
          <option value="llama3-70b-8192">llama3-70b-8192 — large context</option>
          <option value="llama3-8b-8192">llama3-8b-8192 — fast and light</option>
          <option value="mixtral-8x7b-32768">mixtral-8x7b-32768 — long context</option>
          <option value="gemma2-9b-it">gemma2-9b-it — Google Gemma 2</option>
          <option value="compound-beta">compound-beta — Groq compound model</option>
          <option value="compound-beta-mini">compound-beta-mini — compact compound</option>
        </datalist>
        <span class="field-hint">Type any Groq model ID or pick a suggestion. Used for chat, agent, and $ask commands. Find all models at <a href="https://console.groq.com/docs/models" target="_blank" style="color:#5b8fff">console.groq.com/docs/models</a>.</span>
      </div>
      <div class="field"><label>Tavily API Key</label><input type="password" id="s-tavily-key" value="${cfg.tavilyApiKey}" placeholder="tvly-…" /></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Your Profile</div>
      <div class="field"><label>Name</label><input type="text" id="s-name" value="${escAttr(cfg.profile.name)}" /></div>
      <div class="field"><label>Bio</label><textarea id="s-bio">${escHtml(cfg.profile.bio)}</textarea></div>
      <div class="field"><label>Interests (comma-separated)</label><input type="text" id="s-interests" value="${escAttr(cfg.profile.interests.join(', '))}" /><span class="field-hint">e.g. Python automation, Windows tools, indie dev</span></div>
      <div class="field"><label>Projects (comma-separated)</label><input type="text" id="s-projects" value="${escAttr(cfg.profile.projects.join(', '))}" /></div>
      <div class="field"><label>Skills (comma-separated)</label><input type="text" id="s-skills" value="${escAttr(cfg.profile.skills.join(', '))}" /></div>
      <div class="field"><label>Writing Style</label>
        <select id="s-style">
          <option value="casual" ${cfg.profile.writingStyle==='casual'?'selected':''}>Casual</option>
          <option value="technical" ${cfg.profile.writingStyle==='technical'?'selected':''}>Technical</option>
          <option value="casual-technical" ${cfg.profile.writingStyle==='casual-technical'?'selected':''}>Casual + Technical</option>
          <option value="formal" ${cfg.profile.writingStyle==='formal'?'selected':''}>Formal</option>
        </select>
      </div>
      <div class="field"><label>Tone</label>
        <select id="s-tone">
          <option value="helpful" ${cfg.profile.tone==='helpful'?'selected':''}>Helpful</option>
          <option value="witty" ${cfg.profile.tone==='witty'?'selected':''}>Witty</option>
          <option value="direct" ${cfg.profile.tone==='direct'?'selected':''}>Direct</option>
          <option value="concise" ${cfg.profile.tone==='concise'?'selected':''}>Concise</option>
        </select>
      </div>
      <div class="field"><label>Topics to Avoid</label><input type="text" id="s-avoid" value="${escAttr(cfg.profile.avoidTopics.join(', '))}" /></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Reddit</div>
      <div class="field"><label>Subreddits to watch</label><input type="text" id="s-subreddits" value="${escAttr(cfg.reddit.subreddits.join(', '))}" /><span class="field-hint">Leave empty to scan whatever's open</span></div>
      <div class="field"><label>Blocked Subreddits</label><input type="text" id="s-blocked-subs" value="${escAttr(cfg.reddit.blockedSubreddits.join(', '))}" /></div>
      <div class="field"><label>Keywords to boost</label><input type="text" id="s-keywords" value="${escAttr(cfg.reddit.keywords.join(', '))}" /></div>
      <div class="field"><label>Blocked Keywords</label><input type="text" id="s-blocked-kw" value="${escAttr(cfg.reddit.blockedKeywords.join(', '))}" /></div>
      <div class="field"><label>Post Categories (comma-separated)</label><input type="text" id="s-categories" value="${escAttr((cfg.reddit.categories||[]).join(', '))}" /><span class="field-hint">e.g. coding, tools, automation, ai, pdf, saas, clickbait — AI matches post titles against these even when keywords don't hit</span></div>
      <div class="field"><label>Min Score</label><input type="number" id="s-min-score" value="${cfg.reddit.minScore}" min="0" /></div>
      <div class="field"><label>Max Age (hours)</label><input type="number" id="s-max-age" value="${cfg.reddit.maxAgeHours}" min="1" /></div>
      <div class="field"><label>Min Comments</label><input type="number" id="s-min-comments" value="${cfg.reddit.minComments}" min="0" /></div>
      <div class="field"><label>Max AI Batch</label><input type="number" id="s-ai-batch" value="${cfg.reddit.maxAIBatch}" min="1" max="25" /><span class="field-hint">Posts sent to AI per scan</span></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Research</div>
      <div class="field"><label>Search Depth</label>
        <select id="s-search-depth">
          <option value="basic" ${cfg.research.searchDepth==='basic'?'selected':''}>Basic</option>
          <option value="advanced" ${cfg.research.searchDepth==='advanced'?'selected':''}>Advanced</option>
        </select>
      </div>
      <div class="field"><label>Max Results</label><input type="number" id="s-research-results" value="${cfg.research.maxResults}" min="1" max="10" /></div>
      <div class="field"><label><input type="checkbox" id="s-auto-research" ${cfg.research.autoResearch?'checked':''} /> Auto-trigger research</label></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Script</div>
      <div class="field">
        <label>Script timeout (seconds)</label>
        <input type="number" id="s-script-timeout" value="${Math.round((cfg.scripting?.totalTimeoutMs ?? 300000) / 1000)}" min="30" max="3600" step="30" />
        <span class="field-hint">How long a script can run before it's cancelled. Raise this if agent tasks time out. Default: 300s (5 min).</span>
      </div>
      <div class="field">
        <label>Max loop iterations</label>
        <input type="number" id="s-script-loops" value="${cfg.scripting?.maxLoopIterations ?? 1000}" min="10" max="100000" step="10" />
        <span class="field-hint">Maximum iterations for while/repeat loops before an error is thrown.</span>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Agent</div>
      <div class="field">
        <label>Rate Caution</label>
        <select id="s-rate-caution">
          <option value="low"    ${(cfg.agent?.rateCaution||'normal')==='low'   ?'selected':''}>Low — fast, may hit free-tier limits</option>
          <option value="normal" ${(cfg.agent?.rateCaution||'normal')==='normal'?'selected':''}>Normal — balanced (recommended)</option>
          <option value="high"   ${(cfg.agent?.rateCaution||'normal')==='high'  ?'selected':''}>High — slower, very safe on free plan</option>
        </select>
        <span class="field-hint">Random delay before each agent AI call to spread token usage and avoid rate limits.</span>
      </div>
      <div class="field">
        <label>Max chunk note size (chars)</label>
        <input type="number" id="s-max-notes" value="${cfg.agent?.maxNotesChars ?? 800}" min="200" max="3000" step="100" />
        <span class="field-hint">Total characters the agent can keep as notes while reading page chunks. Oldest notes are removed when this limit is hit.</span>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Daily Reminder</div>
      <div class="field"><label>Fire daily reminder at (hour, 24h)</label><input type="number" id="s-daily-hour" value="${cfg.dailyReminderHour??18}" min="0" max="23" /></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Notifications</div>
      <div class="field"><label><input type="checkbox" id="s-notif-enabled" ${cfg.notifications.enabled?'checked':''} /> Enable notifications</label></div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Voice (TTS)</div>
      <div class="field">
        <label><input type="checkbox" id="s-tts-enabled" ${(cfg.voice?.ttsEnabled!==false)?'checked':''} /> Enable ORBIT voice</label>
        <span class="field-hint">ORBIT speaks its replies via the browser's built-in text-to-speech</span>
      </div>
      <div class="field">
        <label>Voice</label>
        <select id="s-voice-name"></select>
      </div>
      <div class="field">
        <label>Speed (${(cfg.voice?.rate||1.05).toFixed(2)}x)</label>
        <input type="range" id="s-voice-rate" min="0.5" max="2" step="0.05" value="${cfg.voice?.rate||1.05}" />
      </div>
      <div class="field">
        <label>Pitch (${(cfg.voice?.pitch||1).toFixed(2)})</label>
        <input type="range" id="s-voice-pitch" min="0.5" max="2" step="0.05" value="${cfg.voice?.pitch||1}" />
      </div>
      <div class="field">
        <label>Volume</label>
        <input type="range" id="s-voice-volume" min="0" max="1" step="0.05" value="${cfg.voice?.volume||1}" />
      </div>
      <div class="field">
        <button id="btn-test-voice" class="btn-ghost btn-sm">Test Voice</button>
      </div>
    </div>
  `;

  // Populate voice list after render
  setTimeout(async () => {
    const sel = document.getElementById('s-voice-name');
    if (!sel) return;
    const voices = await getVoices();
    const currentVoice = cfg.voice?.voiceName || '';
    let opts = '<option value="">Browser default</option>';
    for (const v of voices) {
      const sel2 = currentVoice === v.name ? ' selected' : '';
      opts += '<option value="' + escAttr(v.name) + '"' + sel2 + '>' + escAttr(v.name) + ' (' + v.lang + ')</option>';
    }
    sel.innerHTML = opts;
  }, 100);

    // Test voice button
  setTimeout(() => {
    document.getElementById('btn-test-voice')?.addEventListener('click', async () => {
      const cfg2 = await getConfig();
      await speakReply("Hey, this is what ORBIT sounds like. You can adjust the speed and pitch above.", null);
    });
  }, 150);
}

$('btn-save-settings').addEventListener('click', async () => {
  const csv = (id) => ($(`s-${id}`)?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  await saveConfig({
    groqApiKey: $('s-groq-key')?.value.trim() || '',
    tavilyApiKey: $('s-tavily-key')?.value.trim() || '',
    ai: {
      model: $('s-ai-model')?.value.trim() || 'openai/gpt-oss-20b',
    },
    dailyReminderHour: parseInt($('s-daily-hour')?.value || '18'),
    profile: {
      name: $('s-name')?.value.trim() || '',
      bio: $('s-bio')?.value.trim() || '',
      interests: csv('interests'),
      projects: csv('projects'),
      skills: csv('skills'),
      writingStyle: $('s-style')?.value || 'casual-technical',
      tone: $('s-tone')?.value || 'helpful',
      avoidTopics: csv('avoid'),
    },
    reddit: {
      subreddits: csv('subreddits'),
      blockedSubreddits: csv('blocked-subs'),
      keywords: csv('keywords'),
      blockedKeywords: csv('blocked-kw'),
        categories: csv('categories'),
      minScore: parseInt($('s-min-score')?.value || '0'),
      maxAgeHours: parseInt($('s-max-age')?.value || '48'),
      minComments: parseInt($('s-min-comments')?.value || '0'),
      maxAIBatch: parseInt($('s-ai-batch')?.value || '15'),
    },
    research: {
      searchDepth: $('s-search-depth')?.value || 'basic',
      maxResults: parseInt($('s-research-results')?.value || '5'),
      autoResearch: $('s-auto-research')?.checked || false,
    },
    scripting: {
      totalTimeoutMs:    (parseInt($('s-script-timeout')?.value || '300') || 300) * 1000,
      maxLoopIterations: parseInt($('s-script-loops')?.value || '1000') || 1000,
      maxNestDepth:      32,
    },
    agent: {
      rateCaution:   $('s-rate-caution')?.value      || 'normal',
      maxNotesChars: parseInt($('s-max-notes')?.value || '800'),
    },
    notifications: { enabled: $('s-notif-enabled')?.checked !== false },
    voice: {
      ttsEnabled: $('s-tts-enabled')?.checked !== false,
      voiceName:  $('s-voice-name')?.value || '',
      rate:       parseFloat($('s-voice-rate')?.value || '1.05'),
      pitch:      parseFloat($('s-voice-pitch')?.value || '1'),
      volume:     parseFloat($('s-voice-volume')?.value || '1'),
      lang:       'en-US',
    },
  });
  await chrome.runtime.sendMessage({ action: 'RELOAD_ALARMS' });
  resetScriptManager(); // re-create on next run so new timeout/loop settings take effect

  setStatus('Saved ✓', 'ok');
  setTimeout(() => setStatus('Idle', 'idle'), 2000);
});

$('btn-reset-settings').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  await resetConfig();
  renderSettings();
  setStatus('Reset', 'ok');
});

// ── FLOATING BOT ───────────────────────────────────────────────────────────────
// Injects a draggable floating widget into the current tab

// ── Floating bot toggle via content script ────────────────────────────────────
let botActive = false;

$('btn-float').addEventListener('click', async () => {
  botActive = !botActive;
  const btn = $('btn-float');
  const action = botActive ? 'ORBIT_BOT_SHOW' : 'ORBIT_BOT_HIDE';

  // Route through background worker which has access to all tabs
  await chrome.runtime.sendMessage({ action: 'ORBIT_BOT_BROADCAST', payload: { action } });

  // Persist state so new tabs auto-restore
  chrome.storage.local.set({ orbit_bot_active: botActive });

  btn.style.color = botActive ? 'var(--green)' : '';
  btn.title = botActive ? 'Hide floating ORBIT' : 'Show floating ORBIT';
});

// ── Background message listener ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'AUTO_SCAN_TRIGGERED' && state.activeTab === 'inbox') {
    doScan();
  }
  if (msg.action === 'DAILY_REMINDER') {
    // Show a chat nudge
    switchTab('chat');
    const nudge = { role: 'orbit', content: "Hey — time to check Reddit. Want me to scan for something worth replying to?", ts: Date.now() };
    state.chatMessages.push(nudge);
    appendChatBubble(nudge, true);
    saveCurrentSession();
  }
  // Forward JS execution results to the JSRunner
  if (msg.action === 'SCRIPT_JS_RESULT') {
    window._orbitJSRunner?.handleResult(msg);
  }
  // Forward $exec results to the exec handler
  if (msg.action === 'RUNJS_RESULT') {
    window._orbitHandleRunjs?.(msg);
  }
});

// ── Utilities ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function escAttr(str) { return String(str||'').replace(/"/g,'&quot;'); }

// ── Agent Log ──────────────────────────────────────────────────────────────────

const agentLogEntries = [];

function addAgentLogRow(entry) {
  agentLogEntries.push(entry);

  const list = $('agentlog-list');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'alog-row';

  const t = new Date(entry.ts || Date.now())
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let dataStr = '';
  if (entry.data && Object.keys(entry.data).length) {
    dataStr = Object.entries(entry.data)
      .filter(([k]) => !['ts'].includes(k))
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`)
      .join(' · ');
  }

  row.innerHTML = `
    <span class="alog-time">${t}</span>
    <span class="alog-level ${entry.level}">${entry.level.toUpperCase()}</span>
    <span class="alog-action">${escHtml(entry.action)}</span>
    <span class="alog-detail">
      ${escHtml(entry.detail || '')}
      ${dataStr ? `<span class="alog-data">${escHtml(dataStr)}</span>` : ''}
    </span>
  `;

  list.appendChild(row);
  list.scrollTop = list.scrollHeight;

  // Auto-switch to agent log tab on failures
  if (entry.level === 'fail' && state.activeTab !== 'agentlog') {
    // Just highlight the tab without switching
    const btn = document.querySelector('.nav-btn[data-tab="agentlog"]');
    if (btn) {
      btn.style.color = 'var(--red)';
      setTimeout(() => { btn.style.color = ''; }, 3000);
    }
  }
}

document.getElementById('btn-clear-agentlog')?.addEventListener('click', () => {
  agentLogEntries.length = 0;
  const list = $('agentlog-list');
  if (list) list.innerHTML = '';
});

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  setStatus('Idle', 'idle');

  // Wire agent logger
  setAgentLogger(addAgentLogRow);

  // Initialize script tab
  try { await initScriptTab(); } catch(e) { console.error('Script tab init failed:', e); }

  await loadSessions();

  // Auto-load or create first session
  if (state.sessions.length) {
    await loadSession(state.sessions[0].id);
  } else {
    await createNewSession();
  }

  const cfg = await getConfig();

  if (!cfg.groqApiKey) {
    setStatus('Setup needed', 'error');
    const msg = { role: 'orbit', content: "Hey! Drop your Groq and Tavily keys in **Settings** to get started. Then fill in your profile — interests, projects, skills — so I know what's relevant to you.", ts: Date.now() };
    state.chatMessages.push(msg);
    appendChatBubble(msg, true);
    await saveCurrentSession();
  } else {
    // Greeting on fresh open
    const last = state.chatMessages[state.chatMessages.length - 1];
    const tenMin = 10 * 60 * 1000;
    if (!last || (Date.now() - last.ts) > tenMin) {
      const now = new Date();
      const hour = now.getHours();
      const greeting = hour < 12 ? 'Morning' : hour < 17 ? 'Hey' : 'Evening';
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const msg = { role: 'orbit', content: `${greeting} — ${timeStr}. Ready when you are — hit **Scan Reddit** or ask me something.`, ts: Date.now() };
      state.chatMessages.push(msg);
      appendChatBubble(msg, true);
      await saveCurrentSession();
    }
  }
})();

// ── Script dialog (alert / prompt commands) ───────────────────────────────────
// The script engine calls window.__orbitScriptDialog() which shows a styled
// overlay in the sidepanel and resolves when the user clicks OK or Cancel.
// This works for both alert (just OK) and prompt (input + OK/Cancel).

(function () {
  const overlay  = document.getElementById('script-dialog-overlay');
  const msgEl    = document.getElementById('script-dialog-msg');
  const inputEl  = document.getElementById('script-dialog-input');
  const okBtn    = document.getElementById('script-dialog-ok');
  const cancelBtn = document.getElementById('script-dialog-cancel');

  let _resolver = null;

  function closeDialog(value) {
    overlay.style.display = 'none';
    inputEl.value = '';
    if (_resolver) { _resolver(value); _resolver = null; }
  }

  okBtn.addEventListener('click', () => {
    closeDialog(inputEl.style.display !== 'none' ? inputEl.value : true);
  });
  // confirm cancels resolve false; prompt cancels resolve null (no input vs negative answer)
  cancelBtn.addEventListener('click', () => {
    const isPrompt = inputEl.style.display !== 'none';
    closeDialog(isPrompt ? null : false);
  });

  // Close on overlay background click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      const isPrompt = inputEl.style.display !== 'none';
      closeDialog(isPrompt ? null : false);
    }
  });

  // Enter key submits
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
    if (e.key === 'Escape') cancelBtn.click();
  });

  /**
   * window.__orbitScriptDialog(type, message) → Promise
   *   type: 'alert'  → shows message + OK button, resolves true when dismissed
   *   type: 'prompt' → shows message + text input + OK/Cancel, resolves string|null
   *   type: 'confirm'→ shows message + OK/Cancel, resolves true|null
   */
  window.__orbitScriptDialog = function (type, message) {
    return new Promise(resolve => {
      _resolver = resolve;

      msgEl.textContent = message || '';

      const isPrompt  = type === 'prompt';
      const isConfirm = type === 'confirm';
      const isAlert   = type === 'alert';

      inputEl.style.display  = isPrompt  ? 'block' : 'none';
      cancelBtn.style.display = (isPrompt || isConfirm) ? 'inline-block' : 'none';
      okBtn.textContent = isAlert ? 'OK' : (isConfirm ? 'Yes' : 'OK');
      cancelBtn.textContent = isConfirm ? 'No' : 'Cancel';

      overlay.style.display = 'flex';

      // Focus the right element
      setTimeout(() => { isPrompt ? inputEl.focus() : okBtn.focus(); }, 50);
    });
  };
})();

// ── Voice (TTS output) wiring ────────────────────────────────────────────────
// TTS plays through the browser's built-in speechSynthesis.
// Mouth animation is synced via ORBIT_BOT_MOUTH_START/STOP messages to the bot.

let _sidePanelMouthTimer = null;

function startSidePanelMouth() {
  stopSidePanelMouth();
  chrome.runtime.sendMessage({
    action: 'ORBIT_BOT_BROADCAST',
    payload: { action: 'ORBIT_BOT_MOUTH_START' }
  }).catch(() => {});
}

function stopSidePanelMouth() {
  if (_sidePanelMouthTimer) { clearInterval(_sidePanelMouthTimer); _sidePanelMouthTimer = null; }
  chrome.runtime.sendMessage({
    action: 'ORBIT_BOT_BROADCAST',
    payload: { action: 'ORBIT_BOT_MOUTH_STOP' }
  }).catch(() => {});
}

setTTSCallbacks(
  (e) => { if (!_sidePanelMouthTimer) startSidePanelMouth(); },
  () => {
    stopSidePanelMouth();
    if (state.currentSpeakingEl) {
      state.currentSpeakingEl.classList.remove('msg-speaking');
      state.currentSpeakingEl = null;
    }
  },
  () => { startSidePanelMouth(); }
);

// ── Speak an ORBIT reply ──────────────────────────────────────────────────────

async function speakReply(text, bubbleEl) {
  const cfg = await getConfig();
  if (!cfg.voice?.ttsEnabled) return;
  ttsStop();
  stopSidePanelMouth();
  if (state.currentSpeakingEl) state.currentSpeakingEl.classList.remove('msg-speaking');
  state.currentSpeakingEl = bubbleEl || null;
  if (bubbleEl) bubbleEl.classList.add('msg-speaking');
  await speak(text, {
    voiceName: cfg.voice.voiceName,
    rate:      cfg.voice.rate,
    pitch:     cfg.voice.pitch,
    volume:    cfg.voice.volume,
    lang:      cfg.voice.lang,
  });
}

// ── Chat menu toggle ───────────────────────────────────────────────────────────
document.getElementById('btn-chat-menu')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('chat-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', () => {
  const menu = document.getElementById('chat-menu');
  if (menu) menu.style.display = 'none';
});
