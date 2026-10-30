// ORBIT — JavaScript Runner
//
// MV3 reality check:
import { NoTabError } from './engine/errors.js';
// - new Function() / eval() in the sidepanel page = blocked by CSP (script-src 'self').
// - The ONLY approved way to run user-authored JS strings is chrome.scripting.executeScript
//   called from the background worker (service workers are not subject to that CSP).
//
// Architecture:
//   User JS  →  SCRIPT_JS_EXEC message  →  background worker
//            →  chrome.scripting.executeScript({ func: runner, args: [src, reqId] })
//            →  isolated world in tab (has DOM access, no page globals)
//            →  console output + return value forwarded back via chrome.runtime.sendMessage
//            →  background relays to sidepanel
//
// The orbit.* API inside user JS works by sending SCRIPT_ORBIT_CMD messages back to the
// background worker, which dispatches them through the same browser adapter path.
// This keeps privileged APIs completely out of the page context.

export class JSRunner {
  constructor(registry, browserAdapter) {
    this.registry = registry;
    this.browser  = browserAdapter;
    this._pendingRuns = new Map(); // reqId → { resolve, reject }
  }

  // ── Execute a full user JS script ────────────────────────────────────────
  async executeScript(src, runtime) {
    const tabId = await this._getTabId();
    const reqId = `js_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      let done = false;

      const finish = (err, result) => {
        if (done) return;
        done = true;
        this._pendingRuns.delete(reqId);
        if (err) reject(new Error(err));
        else resolve(result ?? null);
      };

      const onAbort = () => finish('JavaScript execution cancelled');
      if (runtime.signal) runtime.signal.addEventListener('abort', onAbort, { once: true });

      // Hard 30s timeout
      const timeoutId = setTimeout(() => {
        if (!done) finish('JavaScript execution timed out — make sure a web page is open and try again');
      }, 30000);

      this._pendingRuns.set(reqId, {
        resolve: (r) => { clearTimeout(timeoutId); if (runtime.signal) runtime.signal.removeEventListener('abort', onAbort); finish(null, r); },
        reject:  (e) => { clearTimeout(timeoutId); if (runtime.signal) runtime.signal.removeEventListener('abort', onAbort); finish(e); },
        onLog: (entry) => runtime.log(entry.level, entry.message),
      });

      chrome.runtime.sendMessage(
        { action: 'SCRIPT_JS_EXEC', tabId, code: src, reqId },
        (resp) => {
          chrome.runtime.lastError; // consume
          if (resp?.error && !done) finish(resp.error);
          // actual result comes back via SCRIPT_JS_RESULT message
        }
      );
    });
  }

  // ── Execute a single JS expression (used by $exec()) ────────────────────
  async execute(code, signal) {
    const tabId = await this._getTabId();
    const reqId = `jsexpr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, result) => {
        if (done) return;
        done = true;
        this._pendingRuns.delete(reqId);
        clearTimeout(timeoutId);
        if (err) reject(new Error(err));
        else resolve(result ?? null);
      };

      // Hard timeout — if no result in 30s, fail clearly
      const timeoutId = setTimeout(() => finish('$exec timed out — make sure a web page is open'), 30000);

      if (signal) signal.addEventListener('abort', () => finish('JS expression cancelled'), { once: true });

      this._pendingRuns.set(reqId, {
        resolve: (r) => finish(null, r),
        reject:  (e) => finish(e),
        onLog:   () => {},
      });

      chrome.runtime.sendMessage(
        { action: 'SCRIPT_JS_EXEC', tabId, code, reqId, expression: true },
        (resp) => {
          chrome.runtime.lastError;
          if (resp?.error && !done) finish(resp.error);
          // actual result comes via SCRIPT_JS_RESULT → handleResult
        }
      );
    });
  }

  // ── Handle results that come back from the background worker ──────────────
  // Call this from the sidepanel's chrome.runtime.onMessage listener
  handleResult(msg) {
    if (msg.action !== 'SCRIPT_JS_RESULT') return false;
    const pending = this._pendingRuns.get(msg.reqId);
    if (!pending) return false;

    if (msg.type === 'log') {
      pending.onLog({ level: msg.level || 'console', message: msg.text });
    } else if (msg.type === 'done') {
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
    }
    return true;
  }

  async _getTabId() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find(t => !t.url?.startsWith('chrome://') && !t.url?.startsWith('chrome-extension://'));
    if (!tab) throw new NoTabError('No accessible tab for JS execution. Open a regular web page first.');
    return tab.id;
  }
}
