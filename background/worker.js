// ORBIT — Background Service Worker

import { db, logAction, STORES } from '../services/db.js';
import { getConfig } from '../services/settings.js';

const ALARM_SCAN  = 'orbit_scan';
const ALARM_TASKS = 'orbit_tasks';
const ALARM_DAILY = 'orbit_daily_reminder';

// ── Content scripts to inject into existing tabs ──────────────────────────────
// Chrome only auto-injects into tabs opened AFTER the extension loads.
// We must manually inject into already-open tabs on install/update/startup.

const ALL_SCRIPTS = [
  { files: ['content/orbit-bot.js', 'content/page-reader.js'], matches: '<all_urls>' },
  { files: ['content/reddit-scraper.js'], matches: 'https://*.reddit.com/*' },
];

async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;

    for (const { files, matches } of ALL_SCRIPTS) {
      const isReddit = matches === 'https://*.reddit.com/*';
      if (isReddit && !tab.url.includes('reddit.com')) continue;

      for (const file of files) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [file],
          });
        } catch (_) {
          // Some tabs (PDFs, chrome pages) will silently fail — that's fine
        }
      }
    }
  }
}

// ── Inject into a single tab on demand if content script missing ──────────────
async function ensureContentScript(tabId, files) {
  // Probe first — if the script is already there, skip injection
  const probe = await pingTab(tabId);
  if (probe) return true; // already has content scripts

  for (const file of files) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (_) {}
  }

  // Give it a moment to initialise
  await new Promise(r => setTimeout(r, 300));
  return true;
}

async function pingTab(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { action: 'PING' }, (resp) => {
      chrome.runtime.lastError; // suppress unchecked error
      resolve(!!(resp && resp.ok));
    });
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  await ensureDailyReminder();
  await injectIntoExistingTabs();
  logAction('system', { event: 'installed' });
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarms();
  await injectIntoExistingTabs();
});

// Also inject whenever a tab finishes loading (catches navigations)
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  // Always inject the universal scripts
  for (const file of ['content/orbit-bot.js', 'content/page-reader.js']) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (_) {}
  }

  // Reddit-specific
  if (tab.url.includes('reddit.com')) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/reddit-scraper.js'] });
    } catch (_) {}
  }

  // If bot was active, re-show it on new page (storage-based auto-restore handles it,
  // but send the message too in case the script just injected fresh)
  const botActive = await chrome.storage.local.get('orbit_bot_active');
  if (botActive.orbit_bot_active) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { action: 'ORBIT_BOT_SHOW' }).catch(() => {});
    }, 400);
  }
});

// ── Alarms ────────────────────────────────────────────────────────────────────
async function setupAlarms() {
  const cfg = await getConfig();
  chrome.alarms.clearAll();

  if (cfg.reddit?.enabled && cfg.reddit?.autoScanOnReddit) {
    chrome.alarms.create(ALARM_SCAN, { periodInMinutes: cfg.reddit.scanIntervalMinutes || 30 });
  }

  chrome.alarms.create(ALARM_TASKS, { periodInMinutes: 1 });

  const hour = cfg.dailyReminderHour ?? 18;
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  chrome.alarms.create(ALARM_DAILY, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

async function ensureDailyReminder() {
  const tasks = await db.getAll(STORES.TASKS);
  if (tasks.find(t => t.id === 'daily_reddit')) return;
  const d = new Date(); d.setHours(18, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  await db.put(STORES.TASKS, {
    id: 'daily_reddit',
    title: 'Time to check Reddit',
    description: 'Keep your online presence alive — find something worth replying to.',
    recurrence: 'daily',
    status: 'active',
    system: true,
    nextRun: d.getTime(),
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SCAN)  chrome.runtime.sendMessage({ action: 'AUTO_SCAN_TRIGGERED' }).catch(() => {});
  if (alarm.name === ALARM_TASKS) await checkDueTasks();
  if (alarm.name === ALARM_DAILY) {
    await showNotification('Time for Reddit', 'Keep your online presence alive — open ORBIT and find something worth replying to.');
    chrome.runtime.sendMessage({ action: 'DAILY_REMINDER' }).catch(() => {});
  }
});

// ── Side panel ────────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Message routing ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    switch (msg.action) {
      case 'REDDIT_PAGE_LOADED': return { ok: true };

      case 'OPEN_SIDE_PANEL_CURRENT_TAB': return await openSidePanelCurrentTab();
      case 'OPEN_SIDE_PANEL':
        await chrome.sidePanel.open({ tabId: msg.tabId });
        return { ok: true };

      case 'SEND_TO_REDDIT_TAB':  return await sendToRedditTab(msg.payload, msg.tabId);
      case 'NAVIGATE_TO_REDDIT':  return await navigateToReddit(msg.url || 'https://www.reddit.com');
      case 'GET_REDDIT_TABS':     return { tabs: await getRedditTabs() };

      case 'RELOAD_ALARMS':
        await setupAlarms();
        return { ok: true };

      case 'NOTIFY':
        await showNotification(msg.title, msg.message);
        return { ok: true };

      case 'SAVE_TASK':   await db.put(STORES.TASKS, msg.task);    return { ok: true };
      case 'DELETE_TASK': await db.delete(STORES.TASKS, msg.id);   return { ok: true };
      case 'GET_TASKS':   return { tasks: await db.getAll(STORES.TASKS) };

      case 'READ_CURRENT_TAB_PAGE': return await readCurrentTabPage(msg.maxWords);

      case 'ORBIT_BOT_BROADCAST':
        await broadcastToAllTabs(msg.payload);
        return { ok: true };

      case 'AGENT_NAVIGATE': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) return { error: 'No active tab' };
        await chrome.tabs.update(tabId, { url: msg.url });
        await waitForTabLoad(tabId, 8000);
        // Re-inject agent into the new page
        try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] }); } catch(_){}
        return { ok: true, tabId };
      }

      case 'AGENT_OPEN_TAB': {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        await waitForTabLoad(tab.id, 8000);
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/browser-agent.js'] }); } catch(_){}
        return { ok: true, tabId: tab.id };
      }

      case 'AGENT_EXEC': {
        // msg.step has the action (e.g. AGENT_CLICK) and payload
        // Forward it directly to the tab's content script
        return await execAgentStep(msg.step, msg.tabId);
      }

      // ── Script browser automation ───────────────────────────────────────
      // ── $exec — run user JS in background worker (no page CSP applies here) ──
      case 'RUNJS_EXEC': {
        // Runs purely in the background service worker — no page injection.
        // Works on every site with zero CSP issues.
        // No DOM access by design — use OBT commands for page interaction.
        const { reqId, code, isExpr } = msg;
        execRunJS(reqId, code, isExpr).catch(() => {});
        return { ok: true };
      }

      // Relay RUNJS_RESULT from isolated world back to sidepanel
      case 'RUNJS_RESULT': {
        broadcastToSidePanel({ action: 'RUNJS_RESULT', reqId: msg.reqId,
          result: msg.result, error: msg.error, type: msg.type,
          level: msg.level, text: msg.text });
        return { ok: true };
      }

      case 'SCRIPT_BROWSER_EXEC': {
        const tabId = msg.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { error: 'No active tab for browser command' };
        // Ensure browser-agent is loaded
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] });
        } catch (_) {}
        return execScriptBrowserStep(msg.step, tabId);
      }

      // ── Script JS execution in page (isolated world) ───────────────────
      case 'SCRIPT_JS_EXEC': {
        const tabId = msg.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { error: 'No active tab for JS execution' };
        // Fire async — results stream back via SCRIPT_JS_RESULT messages to the sidepanel
        execUserJS(tabId, msg.code, msg.reqId, msg.expression ?? false).catch(() => {});
        return { ok: true };
      }

      case 'SCRIPT_JS_RESULT': {
        // Forward from content script to the sidepanel via broadcastToSidePanel
        broadcastToSidePanel({ action: 'SCRIPT_JS_RESULT', reqId: msg.reqId, type: msg.type,
          level: msg.level, text: msg.text, result: msg.result, error: msg.error });
        return { ok: true };
      }

      case 'GET_ACTIVE_TAB': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { tab };
      }



      default: return { error: `Unknown: ${msg.action}` };
    }
  };

  handle().then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function openSidePanelCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.sidePanel.open({ tabId: tab.id });
  return { ok: true };
}

async function getRedditTabs() {
  return chrome.tabs.query({ url: 'https://*.reddit.com/*' });
}

async function navigateToReddit(url) {
  const tabs = await getRedditTabs();
  let tabId, created;

  if (tabs.length) {
    // Reuse existing reddit tab
    await chrome.tabs.update(tabs[0].id, { url, active: true });
    tabId = tabs[0].id; created = false;
  } else {
    // Open new tab — keep active:true so it actually loads
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id; created = true;
  }

  // Wait for tab to finish loading then inject scripts
  await waitForTabLoad(tabId, 10000);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/reddit-scraper.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/orbit-bot.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-reader.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] });
  } catch (_) {}

  return { tabId, created };
}

async function waitForTabLoad(tabId, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch (_) { return false; }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function sendToRedditTab(payload, preferTabId = null) {
  const tabs = await getRedditTabs();
  if (!tabs.length) return { error: 'NO_REDDIT_TAB' };

  const tab = preferTabId ? (tabs.find(t => t.id === preferTabId) || tabs[0]) : tabs[0];
  if (tab.status === 'loading') await new Promise(r => setTimeout(r, 2000));

  // Ensure reddit-scraper is injected
  await ensureContentScript(tab.id, ['content/reddit-scraper.js']);

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, payload, resp => {
      chrome.runtime.lastError;
      resolve(resp || { error: 'No response from Reddit tab' });
    });
  });
}

async function readCurrentTabPage(maxWords = 1200) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'No active tab found' };
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return { error: "Can't read Chrome internal pages" };
  }

  // Ensure page-reader is injected
  await ensureContentScript(tab.id, ['content/page-reader.js']);

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { action: 'READ_PAGE', maxWords }, resp => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { error: 'No response from page' });
      }
    });
  });
}

async function broadcastToAllTabs(payload) {
  // For speak notifications, only send to the active tab.
  // Sending to ALL tabs caused every tab with orbit-bot.js to speak simultaneously.
  if (payload.action === 'ORBIT_SPEAK_NOTIFICATION' || payload.action === 'ORBIT_BOT_SAY') {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab && !activeTab.url?.startsWith('chrome://') && !activeTab.url?.startsWith('chrome-extension://')) {
      chrome.tabs.sendMessage(activeTab.id, payload).catch(() => {});
    }
    return;
  }
  // Other broadcasts (show/hide/animate) still go to all tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
  }
}

// ── Task checker ──────────────────────────────────────────────────────────────
async function checkDueTasks() {
  const tasks = await db.getAll(STORES.TASKS);
  const now   = Date.now();
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    if (!task.nextRun || task.nextRun > now) continue;
    await showNotification(task.title, task.description || 'Reminder from ORBIT');
    await logAction('task_triggered', { taskId: task.id, title: task.title });

    // Tell the bot to speak the reminder
    const speakText = task.title + (task.description ? '. ' + task.description : '');
    broadcastToAllTabs({ action: 'ORBIT_SPEAK_NOTIFICATION', text: speakText });
    const updated = { ...task };
    if (!task.recurrence || task.recurrence === 'none') {
      updated.status = 'done';
    } else {
      updated.nextRun = getNextRun(task);
    }
    await db.put(STORES.TASKS, updated);
    chrome.runtime.sendMessage({ action: 'TASK_TRIGGERED', task }).catch(() => {});
  }
}

function getNextRun(task) {
  const base = Date.now();
  if (task.recurrence === 'daily')  return base + 86400000;
  if (task.recurrence === 'weekly') return base + 604800000;
  if (task.recurrence === 'weekday') {
    let d = new Date(base + 86400000);
    while (d.getDay() === 0 || d.getDay() === 6) d = new Date(d.getTime() + 86400000);
    return d.getTime();
  }
  return null;
}

async function showNotification(title, message) {
  const cfg = await getConfig();
  if (!cfg.notifications?.enabled) return;
  chrome.notifications.create(`orbit_${Date.now()}`, {
    type: 'basic',
    iconUrl: '../icons/icon48.png',
    title: `ORBIT — ${title}`,
    message,
    priority: 1,
  });
}

// ── Agent step executor ───────────────────────────────────────────────────────
async function execAgentStep(step, preferTabId = null) {
  let tabId = preferTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return { ok: false, error: 'No active tab' };

  // Ensure browser-agent is injected
  const pingResp = await new Promise(r => {
    chrome.tabs.sendMessage(tabId, { action: 'PING' }, resp => { chrome.runtime.lastError; r(resp); });
  });
  if (!pingResp?.ok) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] }); } catch(_){}
    await new Promise(r => setTimeout(r, 300));
  }

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, step, resp => {
      chrome.runtime.lastError;
      resolve(resp || { ok: false, error: 'No response' });
    });
  });
}

// ── Script browser step executor (routes to content script) ──────────────────
async function execScriptBrowserStep(step, tabId) {
  // Map script actions to the browser-agent actions that orbit-bot's agent already understands
  const mapped = mapScriptAction(step);

  // Ping / inject if needed
  const pingResp = await new Promise(r => {
    chrome.tabs.sendMessage(tabId, { action: 'PING' }, resp => { chrome.runtime.lastError; r(resp); });
  });
  if (!pingResp?.ok) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] }); } catch(_){}
    await new Promise(r => setTimeout(r, 400));
  }

  // Handle navigation separately — use tabs API not content script
  if (step.action === 'NAVIGATE') {
    try {
      await chrome.tabs.update(tabId, { url: step.url });
      await waitForTabLoad(tabId, 10000);
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser-agent.js'] }); } catch(_){}
      return { ok: true, data: { navigated: step.url } };
    } catch(e) { return { error: e.message }; }
  }

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, mapped, resp => {
      chrome.runtime.lastError;
      resolve(resp || { ok: false, error: 'No response from content script' });
    });
  });
}

// Map scripting engine actions to browser-agent actions
function mapScriptAction(step) {
  switch (step.action) {
    case 'CLICK':       return { action: 'AGENT_CLICK',      target: step.target, targetType: step.targetType };
    case 'RIGHT_CLICK': return { action: 'AGENT_RIGHT_CLICK',target: step.target, targetType: step.targetType };
    case 'FOCUS':       return { action: 'AGENT_FOCUS',      target: step.target, targetType: step.targetType };
    case 'TYPE':        return { action: 'AGENT_TYPE',       text: step.text, speed: step.speed };
    case 'PRESS':       return { action: 'AGENT_PRESS',      key: step.key };
    case 'SCROLL':      return { action: 'AGENT_SCROLL',     direction: step.direction, amount: step.amount };
    case 'DRAG':        return { action: 'AGENT_DRAG',       destX: step.destX, destY: step.destY, target: step.target, targetType: step.targetType };
    case 'GET':         return { action: 'AGENT_GET',        retrieval: step.retrieval, target: step.target, targetType: step.targetType, attribute: step.attribute };
    case 'FIND_TEXT':   return { action: 'AGENT_FIND_TEXT',  text: step.text };
    case 'SEE_TEXT':    return { action: 'AGENT_SEE_TEXT',   text: step.text };
    case 'TEXT_CONTAIN':return { action: 'AGENT_TEXT_CONTAIN', text: step.text };
    case 'GET_POS':     return { action: 'AGENT_GET_POS',    target: step.target, targetType: step.targetType };
    case 'PAGE_LOADED': return { action: 'AGENT_PAGE_LOADED' };
    case 'AGENT_SNAPSHOT': return step;
    default:            return step;
  }
}

// ── JS execution helper ───────────────────────────────────────────────────────
// Runs user JS in the tab's isolated world via chrome.scripting.executeScript.
// Streams console.log output and the final result back to the sidepanel as
// SCRIPT_JS_RESULT messages. No eval() or new Function() in extension pages.

async function execUserJS(tabId, code, reqId, expression = false) {
  // The fundamental constraint:
  //   - MAIN world: user gets window/page globals, but page CSP governs eval → blocked on strict pages
  //   - ISOLATED world: Chrome's own scripting context, page CSP does NOT apply, eval works fine
  //     but user cannot access page-level JS globals (window.myCustomVar etc)
  //
  // For $exec() the primary use cases are DOM reads (document.title, querySelector, etc)
  // which all work perfectly in the isolated world. We use isolated world so it works
  // on ALL pages including strict-CSP ones like ChatGPT, bank sites, Google apps.
  //
  // For full JS mode scripts we also use isolated world. If a user needs MAIN world
  // page globals they can use orbit.runJS() with world:'MAIN' explicitly (future feature).
  //
  // Execution: we inject a runner function (not a string eval — func reference is safe),
  // store result in a background-owned Map keyed by reqId (no tab globals needed),
  // and the runner sends one chrome.runtime.sendMessage when done.

  // The runner is a real function — executeScript serialises it by reference, never evals it.
  // It receives the code string as an arg and uses indirect eval inside the isolated world,
  // where Chrome permits it regardless of the page's CSP.
  function isolatedRunner(userCode, runReqId, isExpr) {
    const logs = [];
    const origLog   = console.log.bind(console);
    const origWarn  = console.warn.bind(console);
    const origError = console.error.bind(console);

    const addLog = (level, args) => {
      try {
        const text = args.map(a => {
          try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a); }
          catch(_) { return String(a); }
        }).join(' ');
        logs.push({ level, text });
        chrome.runtime.sendMessage({ action: 'SCRIPT_JS_RESULT', reqId: runReqId, type: 'log', level, text }).catch(() => {});
      } catch(_) {}
    };

    console.log   = (...a) => { origLog(...a);   addLog('console', a); };
    console.warn  = (...a) => { origWarn(...a);  addLog('warn', a); };
    console.error = (...a) => { origError(...a); addLog('error', a); };

    const restore = () => {
      console.log = origLog; console.warn = origWarn; console.error = origError;
    };

    const send = (payload) => {
      restore();
      chrome.runtime.sendMessage({ action: 'SCRIPT_JS_RESULT', reqId: runReqId, ...payload }).catch(() => {});
    };

    try {
      // In the isolated world Chrome permits indirect eval regardless of page CSP.
      // We wrap user code in an async IIFE so await works and we capture the return value.
      const wrapped = isExpr
        ? `(async () => { return (${userCode}); })()`
        : `(async () => { ${userCode} })()`;

      // Indirect eval — not new Function, avoids some lint rules but same permission
      const geval = eval; // eslint-disable-line no-eval
      const promise = geval(wrapped);

      promise.then(result => {
        let serialized = null;
        try {
          serialized = (result !== undefined && result !== null)
            ? JSON.parse(JSON.stringify(result))
            : result ?? null;
        } catch(_) { serialized = String(result); }
        send({ type: 'done', result: serialized });
      }).catch(err => {
        send({ type: 'done', error: err.message || String(err) });
      });
    } catch(e) {
      send({ type: 'done', error: 'Syntax error: ' + (e.message || String(e)) });
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: isolatedRunner,
      args: [code, reqId, expression],
      // ISOLATED world — Chrome's own context, page CSP does not apply.
      // Works on ChatGPT, bank sites, Google, anywhere.
      world: 'ISOLATED',
    });
  } catch(e) {
    broadcastToSidePanel({
      action: 'SCRIPT_JS_RESULT', reqId, type: 'done',
      error: `Could not inject into tab: ${e.message}. Make sure a regular web page is open.`,
    });
  }
}

// ── Broadcast a message to all open sidepanel pages ───────────────────────────
// chrome.runtime.sendMessage from the background DOES fire onMessage in extension
// pages (sidepanel, popup). The sidepanel's listener picks these up.
function broadcastToSidePanel(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // Sidepanel may not be open — ignore
  });
}

// ── $exec executor ────────────────────────────────────────────────────────────
// $exec() now runs via a sandboxed iframe in the sidepanel (scripting/sandbox.html).
// Sandboxed extension pages have a relaxed CSP that permits eval() — the only
// MV3-compliant way to eval user code without adding unsafe-eval to the manifest.
//
// Flow:
//   sidepanel → runInSandbox() → postMessage → sandbox.html iframe
//                                            ← postMessage (result/logs)
//
// This worker handler is kept for backward-compat but is no longer the main path.
// If RUNJS_EXEC arrives here (old code path), we return an error so nothing hangs.
async function execRunJS(reqId, code, isExpr) {
  // new Function() is blocked in MV3 service workers by Chrome 130+.
  // The real execution path is the sandboxed iframe in runjs-sandbox.js.
  broadcastToSidePanel({
    action: 'RUNJS_RESULT',
    reqId,
    error: '$exec: internal routing error — execution should go through the sandboxed iframe. This is a bug, please report it.',
  });
}
