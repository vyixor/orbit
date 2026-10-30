// ORBIT — $exec Runner via Sandboxed iframe
//
// Why this approach?
// MV3 blocks new Function() / eval() in:
//   - Extension pages (sidepanel, popup) — CSP: script-src 'self'
//   - Service workers — same CSP (Chrome 130+ enforces this)
//
// The ONLY MV3-approved way to eval user code is a sandboxed extension page.
// Chrome's "sandbox" manifest key gives that page a relaxed CSP where eval()
// works, while keeping it isolated from the extension's own origin.
//
// We embed scripting/sandbox.html in a hidden <iframe> inside the sidepanel,
// communicate via postMessage, and stream console.log output back in real time.

let _sandboxFrame = null;
let _sandboxReady = false;
const _pending = new Map(); // reqId → { resolve, reject, onLog, timeoutId }

function getSandboxFrame() {
  if (_sandboxFrame && document.body.contains(_sandboxFrame)) return _sandboxFrame;

  // Create a hidden iframe pointing at the sandboxed page
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('scripting/sandbox.html');
  frame.style.cssText = 'display:none;width:0;height:0;border:none;position:absolute;';
  frame.setAttribute('sandbox', 'allow-scripts');
  document.body.appendChild(frame);

  _sandboxFrame = frame;
  _sandboxReady = false;

  // The frame is ready as soon as it loads — postMessage is always ready
  frame.addEventListener('load', () => { _sandboxReady = true; });

  // Handle results and log streams from the sandbox
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.reqId) return;

    const p = _pending.get(d.reqId);
    if (!p) return;

    if (d.type === 'ORBIT_EVAL_LOG') {
      try { p.onLog({ level: d.level || 'console', text: d.text }); } catch(_) {}
      return; // Don't resolve yet — wait for ORBIT_EVAL_RESULT
    }

    if (d.type === 'ORBIT_EVAL_RESULT') {
      clearTimeout(p.timeoutId);
      _pending.delete(d.reqId);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result ?? null);
    }
  });

  return frame;
}

export async function runInSandbox(code, isExpr = false, onLog = null, args = null) {
  const reqId = `rjs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const frame = getSandboxFrame();

  // Wait for frame to be ready (usually instant after first load)
  if (!_sandboxReady) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Sandbox iframe timed out loading')), 5000);
      frame.addEventListener('load', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    _sandboxReady = true;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      _pending.delete(reqId);
      reject(new Error('$exec timed out — check your code for infinite loops'));
    }, 15000);

    _pending.set(reqId, {
      resolve,
      reject,
      onLog: onLog || (() => {}),
      timeoutId,
    });

    frame.contentWindow.postMessage(
      { type: 'ORBIT_EVAL', reqId, code: String(code), isExpr: !!isExpr, args: args || null },
      '*'
    );
  });
}

// Called by the sidepanel's onMessage listener for RUNJS_RESULT messages
// (kept for backward compatibility — $exec now uses iframe, not this path,
//  but the worker still sends RUNJS_RESULT for legacy RUNJS_EXEC messages)
export const _runjsPending = _pending; // re-export for app.js compatibility

export function handleRunjsResult(msg) {
  // This path is no longer used for $exec (we use iframe now),
  // but kept so app.js doesn't break if it still calls this.
  const p = _pending.get(msg.reqId);
  if (!p) return false;
  clearTimeout(p.timeoutId);
  _pending.delete(msg.reqId);
  if (msg.type === 'log' && p.onLog) {
    p.onLog({ level: msg.level || 'console', text: msg.text });
    return true;
  }
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
  return true;
}
