// ORBIT — Script Tab Controller
// Manages the script editor UI, execution lifecycle, console output, and saved scripts.

import { ScriptManager, detectLanguage, LANG } from '../scripting/engine/script-manager.js';
import { CommandRegistry } from '../scripting/engine/registry.js';
import { registerBuiltins } from '../scripting/commands/builtin.js';
import { BrowserAdapter }   from '../scripting/browser-adapter.js';
import { OrbitBridge }      from '../scripting/orbit-bridge.js';
import { JSRunner }         from '../scripting/js-runner.js';
import { handleRunjsResult } from '../scripting/runjs-sandbox.js';
import { getConfig }        from '../services/settings.js';
import { chat }                              from '../services/ai.js';
import { research, formatResearchContext }   from '../services/research.js';
import { runAgentTask }                      from '../services/agent.js';

// ── Bootstrap the scripting engine ───────────────────────────────────────────
const registry   = new CommandRegistry();
registerBuiltins(registry);

const browserAdapter = new BrowserAdapter();
const orbitBridge    = new OrbitBridge();
const jsRunner       = new JSRunner(registry, browserAdapter);

// Expose for the app.js onMessage listener to forward results back here
window._orbitJSRunner      = jsRunner;
window._orbitHandleRunjs   = handleRunjsResult;

let scriptManager = null; // created with settings on first use

// Called by app.js after settings are saved so the next run picks up new values
export function resetScriptManager() { scriptManager = null; }

async function getManager() {
  if (scriptManager) return scriptManager;
  const cfg = await getConfig();
  const s = cfg.scripting || {};
  scriptManager = new ScriptManager({
    registry,
    browserAdapter,
    orbitBridge,
    jsRunner,
    chatServices: { chat, research, formatResearchContext, runAgentTask },
    settings: {
      maxLoopIterations: s.maxLoopIterations || 1000,
      maxNestDepth:      s.maxNestDepth      || 32,
      totalTimeoutMs:    s.totalTimeoutMs    || 300000,
    },
  });
  return scriptManager;
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  scripts:      [],          // [{ id, title, src, createdAt, updatedAt }]
  currentId:    null,
  running:      false,
  runStart:     0,
  durTimer:     null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function editor()  { return $('script-editor'); }
function console_()   { return $('script-console'); }

// ── Storage ───────────────────────────────────────────────────────────────────
const STORE_KEY = 'orbit_scripts_v1';

async function loadScripts() {
  return new Promise(r => {
    chrome.storage.local.get(STORE_KEY, d => {
      state.scripts = d[STORE_KEY] || [];
      r();
    });
  });
}

async function saveScripts() {
  return new Promise(r => chrome.storage.local.set({ [STORE_KEY]: state.scripts }, r));
}

function newScript(title = 'New script', src = '"use obt";\n\n# Type your Orbit Script here\nsay "Hello world";\n') {
  return {
    id:        `s_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    title,
    src,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Script select render ──────────────────────────────────────────────────────
function renderScriptSelect() {
  const sel = $('script-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const s of state.scripts) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    if (s.id === state.currentId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function currentScript() { return state.scripts.find(s => s.id === state.currentId); }

async function loadScript(id) {
  // Save current first
  await saveCurrentEditorSrc();
  const script = state.scripts.find(s => s.id === id);
  if (!script) return;
  state.currentId = id;
  editor().value = script.src;
  updateLineNums();
  updateLangBadge();
  renderScriptSelect();
}

async function saveCurrentEditorSrc() {
  const script = currentScript();
  if (!script) return;
  script.src = editor().value;
  script.updatedAt = Date.now();
  await saveScripts();
}

// ── Language badge ─────────────────────────────────────────────────────────────
function updateLangBadge() {
  const badge = $('script-lang-badge');
  if (!badge) return;
  badge.textContent = 'OBT';
  badge.className = 'script-lang-badge';
}

// ── Line numbers ──────────────────────────────────────────────────────────────
function updateLineNums() {
  const ta   = editor();
  const nums = $('script-line-nums');
  if (!ta || !nums) return;
  const lines = (ta.value.match(/\n/g) || []).length + 1;
  let html = '';
  for (let i = 1; i <= lines; i++) html += i + '\n';
  nums.textContent = html;
  // Sync scroll
  nums.scrollTop = ta.scrollTop;
}

// ── Console output ────────────────────────────────────────────────────────────
function consoleLine(text, level = 'info') {
  const el = console_();
  if (!el) return;
  const div = document.createElement('div');
  div.className = `console-line ${level}`;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  div.textContent = `[${ts}] ${text}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function consoleLog(entry) {
  let level = 'info';
  if (entry.level === 'error')   level = 'error';
  else if (entry.level === 'warn')    level = 'warn';
  else if (entry.level === 'result')  level = 'result';
  else if (entry.level === 'cmd')     level = 'cmd';
  else if (entry.level === 'console') level = 'console';
  else if (entry.level === 'done')    level = 'done';
  else if (entry.level === 'cancel')  level = 'cancel';
  else if (entry.level === 'parse')   level = 'parse';

  const msg = entry.message || entry.msg || '';
  consoleLine(msg, level);
}

// ── Run / Stop ────────────────────────────────────────────────────────────────
async function runScript() {
  if (state.running) return;

  await saveCurrentEditorSrc();
  const src = editor().value.trim();
  if (!src) { consoleLine('Nothing to run.', 'warn'); return; }

  state.running = true;
  state.runStart = Date.now();
  $('btn-script-run').disabled  = true;
  $('btn-script-stop').disabled = false;

  const bar = $('script-status-bar');
  const barText = $('script-status-text');
  const barDur  = $('script-status-dur');
  if (bar) { bar.style.display = 'flex'; bar.className = 'script-status-bar running'; }
  if (barText) barText.textContent = 'Running…';
  if (barDur) barDur.textContent = '';

  // Update duration every second
  state.durTimer = setInterval(() => {
    const elapsed = ((Date.now() - state.runStart) / 1000).toFixed(1);
    if (barDur) barDur.textContent = `${elapsed}s`;
  }, 200);

  const hint = LANG.OS;
  consoleLine('Script started (OBT)', 'info');

  try {
    const mgr = await getManager();
    const result = await mgr.run(src, {
      lang: LANG.OS,
      onLog: (entry) => consoleLog(entry),
    });
    const dur = ((Date.now() - state.runStart) / 1000).toFixed(2);
    consoleLine(`Script completed in ${dur}s. Result: ${result !== null && result !== undefined ? JSON.stringify(result) : '(none)'}`, 'done');
    if (bar) { bar.className = 'script-status-bar done'; }
    if (barText) barText.textContent = 'Done';
  } catch (e) {
    const isCancelled = e.cancelled || e.message?.includes('cancelled');
    const level = isCancelled ? 'cancel' : 'error';
    consoleLine(isCancelled ? 'Script stopped.' : `Error: ${e.message}`, level);
    if (bar) { bar.className = `script-status-bar ${isCancelled ? '' : 'error'}`; }
    if (barText) barText.textContent = isCancelled ? 'Stopped' : 'Error';
  } finally {
    clearInterval(state.durTimer);
    state.running = false;
    $('btn-script-run').disabled  = false;
    $('btn-script-stop').disabled = true;
    const dur = ((Date.now() - state.runStart) / 1000).toFixed(2);
    if (barDur) barDur.textContent = `${dur}s`;
  }
}

async function stopScript() {
  const mgr = await getManager();
  mgr.stop();
  consoleLine('Stop requested…', 'warn');
  // Cancel any in-progress speech immediately
  chrome.runtime.sendMessage({ action: 'ORBIT_BOT_BROADCAST', payload: { action: 'ORBIT_SPEAK_STOP' } })
    .catch(() => {});
}

// ── AI Code Generation ────────────────────────────────────────────────────────
// ── Directive sanitiser ───────────────────────────────────────────────────────
// AI-generated scripts sometimes emit the directive wrong:
//   obt;              ← missing quotes and "use"
//   use obt;          ← missing quotes
//   "use obt"         ← missing semicolon
//   "use os";         ← old name
//   (nothing)         ← omitted entirely
//
// This function strips any malformed directive attempt from the first line
// and prepends the correct canonical form so the parser always sees it right.

function sanitiseDirective(src) {
  if (!src) return '"use obt";\n';

  const lines  = src.split('\n');
  const first  = lines[0].trim();

  // Patterns that are recognisably a directive attempt (correct or malformed)
  const isDirectiveAttempt =
    /^"use (obt|os|js)"\s*;?\s*$/.test(first) ||   // correct or missing ;
    /^use (obt|os|js)\s*;?\s*$/.test(first)   ||   // missing quotes
    /^obt\s*;?\s*$/.test(first)               ||   // bare word
    /^os\s*;?\s*$/.test(first);                    // old bare word

  // Remove the first line if it was a directive attempt (correct or broken)
  const body = isDirectiveAttempt
    ? lines.slice(1).join('\n').replace(/^\n+/, '')
    : src;

  return `"use obt";\n${body}`;
}

async function generateScript() {
  const input = $('script-ai-input');
  const desc  = input?.value?.trim();
  if (!desc) return;

  consoleLine('AI generating script…', 'info');
  $('btn-script-ai-gen').disabled = true;

  // Build command catalog for the AI
  const cmdDocs = registry.allDefs().slice(0, 30).map(d =>
    `- ${d.name}${d.aliases?.length ? ` (also: ${d.aliases.join(', ')})` : ''}: ${d.description || ''} | usage: ${d.usage || d.name}`
  ).join('\n');

  const prompt = `You are generating an Orbit Script (OS) automation script for a browser extension called ORBIT.

ORBIT SCRIPT SYNTAX:
\`\`\`
"use obt";
navigate "https://example.com";
wait 2;
var title = $run(get --type text --target selector "h1");
say {$title};
if seeText "Login" {
  click --type text "Login";
}
repeat 3 {
  scrollDown 1;
  wait 0.5;
}
until seeText "Done" {
  wait 1;
}
\`\`\`

AVAILABLE COMMANDS:
${cmdDocs}

USER REQUEST: ${desc}

Generate a complete, working Orbit Script to accomplish this. Start with "use obt";. Use only listed commands. Return ONLY the script code, no explanation.`;

  try {
    const result = await chat(prompt, '', false, '');
    const code = result.response?.trim() || '';
    // Strip markdown fences if present
    const stripped = code.replace(/^```\w*\n?/m, '').replace(/\n?```$/m, '').trim();
    const cleaned = sanitiseDirective(stripped);
    if (cleaned) {
      // Insert into editor — ask user to review before running
      editor().value = cleaned;
      updateLineNums();
      updateLangBadge();
      consoleLine('AI script inserted — review before running.', 'info');
      if (input) input.value = '';
    }
  } catch (e) {
    consoleLine(`AI generation failed: ${e.message}`, 'error');
  } finally {
    $('btn-script-ai-gen').disabled = false;
  }
}

// ── Script library management ─────────────────────────────────────────────────
async function createNewScript() {
  await saveCurrentEditorSrc();
  const script = newScript();
  state.scripts.unshift(script);
  state.currentId = script.id;
  editor().value = script.src;
  await saveScripts();
  renderScriptSelect();
  updateLineNums();
  editor().focus();
}

async function deleteCurrentScript() {
  if (!state.currentId) return;
  const script = currentScript();
  if (!confirm(`Delete "${script?.title || 'this script'}"?`)) return;
  state.scripts = state.scripts.filter(s => s.id !== state.currentId);
  await saveScripts();
  if (state.scripts.length) {
    await loadScript(state.scripts[0].id);
  } else {
    await createNewScript();
  }
}

async function duplicateCurrentScript() {
  await saveCurrentEditorSrc();
  const script = currentScript();
  if (!script) return;
  const dup = { ...script, id: `s_${Date.now()}`, title: script.title + ' (copy)', createdAt: Date.now(), updatedAt: Date.now() };
  const idx = state.scripts.findIndex(s => s.id === state.currentId);
  state.scripts.splice(idx + 1, 0, dup);
  state.currentId = dup.id;
  await saveScripts();
  renderScriptSelect();
}

async function renameCurrentScript() {
  const script = currentScript();
  if (!script) return;
  const name = prompt('Rename script:', script.title);
  if (!name || !name.trim()) return;
  script.title = name.trim();
  await saveScripts();
  renderScriptSelect();
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initScriptTab() {
  await loadScripts();

  if (!state.scripts.length) {
    const s = newScript('Hello World', '"use obt";\n\n# Orbit Script example\nsay "Hello world";\nnavigate "https://example.com";\nwait 2;\nhappyFace;\n');
    state.scripts.push(s);
    await saveScripts();
  }

  state.currentId = state.scripts[0].id;
  renderScriptSelect();
  editor().value = state.scripts[0].src;
  updateLineNums();
  updateLangBadge();

  // ── Event wiring ────────────────────────────────────────────────────────

  $('btn-script-run')?.addEventListener('click', runScript);
  $('btn-script-stop')?.addEventListener('click', stopScript);

  $('btn-script-ai-gen')?.addEventListener('click', generateScript);
  $('script-ai-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); generateScript(); }
  });

  $('btn-script-copy-output')?.addEventListener('click', () => {
    const lines = [...(console_()?.querySelectorAll('.console-line') || [])];
    navigator.clipboard.writeText(lines.map(l => l.textContent).join('\n'));
  });

  $('btn-script-clear-console')?.addEventListener('click', () => {
    if (console_()) console_().innerHTML = '';
  });

  // Script select change
  $('script-select')?.addEventListener('change', async (e) => {
    await loadScript(e.target.value);
  });

  // Language select
  $('script-lang-select')?.addEventListener('change', () => {
    updateLangBadge();
  });

  // Editor: line numbers and lang badge sync
  editor()?.addEventListener('input', () => {
    updateLineNums();
    updateLangBadge();
  });

  editor()?.addEventListener('scroll', () => {
    const nums = $('script-line-nums');
    if (nums) nums.scrollTop = editor().scrollTop;
  });

  // Tab key inserts 2 spaces
  editor()?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = editor();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
      updateLineNums();
    }
    // Ctrl/Cmd+Enter to run
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runScript();
    }
  });

  // Script menu
  $('btn-script-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('script-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => {
    const menu = $('script-menu');
    if (menu) menu.style.display = 'none';
  });

  $('btn-script-new')?.addEventListener('click',       createNewScript);
  $('btn-script-save')?.addEventListener('click',      async () => { await saveCurrentEditorSrc(); consoleLine('Saved.', 'info'); });
  $('btn-script-rename')?.addEventListener('click',    renameCurrentScript);
  $('btn-script-duplicate')?.addEventListener('click', duplicateCurrentScript);
  $('btn-script-delete')?.addEventListener('click',    deleteCurrentScript);

  // Auto-save when tab loses focus
  window.addEventListener('blur', saveCurrentEditorSrc);
}

// ── Export registry for AI context and autocomplete ───────────────────────────
export { registry };
