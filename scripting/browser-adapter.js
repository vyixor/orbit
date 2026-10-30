// ORBIT — Browser Adapter
// All browser interaction from scripts goes through here.
// Routes via chrome.runtime.sendMessage → background worker → content scripts.

import { NoTabError, BrowserCancelledError, ElementError, BrowserResponseError } from './engine/errors.js';
// Runs in the sidepanel context.

export class BrowserAdapter {
  constructor() {
    this._activeTabId = null;
  }

  // ── Send a command to the browser agent in the active tab ─────────────────
  async exec(action, params = {}, signal = null) {
    const tabId = await this._getActiveTabId();

    return new Promise((resolve, reject) => {
      let done = false;

      const onAbort = () => {
        if (!done) { done = true; reject(new BrowserCancelledError('Browser operation cancelled')); }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      chrome.runtime.sendMessage(
        { action: 'SCRIPT_BROWSER_EXEC', step: { action, ...params }, tabId },
        (resp) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          chrome.runtime.lastError; // consume
          if (done) return;
          done = true;
          if (resp?.error) reject(new BrowserResponseError(resp.error));
          else resolve(resp?.data ?? null);
        }
      );
    });
  }

  // ── Tab management ────────────────────────────────────────────────────────
  async _getActiveTabId() {
    if (this._activeTabId) return this._activeTabId;
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find(t => !t.url?.startsWith('chrome://') && !t.url?.startsWith('chrome-extension://'));
    if (!tab) throw new NoTabError('No accessible tab found. Open a regular web page first.');
    return tab.id;
  }

  setTabId(id) { this._activeTabId = id; }
  clearTabId() { this._activeTabId = null; }

  // ── High-level methods used by commands ────────────────────────────────────
  async navigate(url, signal) { return this.exec('NAVIGATE', { url }, signal); }

  async click(target, type, signal) { return this.exec('CLICK', { target, targetType: type }, signal); }
  async rightClick(target, type, signal) { return this.exec('RIGHT_CLICK', { target, targetType: type }, signal); }
  async focus(target, type, signal) { return this.exec('FOCUS', { target, targetType: type }, signal); }
  async type(text, speed, signal) { return this.exec('TYPE', { text, speed }, signal); }
  async press(key, signal) { return this.exec('PRESS', { key }, signal); }

  async scrollDown(amount, signal) { return this.exec('SCROLL', { direction: 'down', amount }, signal); }
  async scrollUp(amount, signal) { return this.exec('SCROLL', { direction: 'up', amount }, signal); }

  async drag(destX, destY, target, type, signal) { return this.exec('DRAG', { destX, destY, target, targetType: type }, signal); }

  async get(retrieval, target, targetType, attribute, signal) {
    return this.exec('GET', { retrieval, target, targetType, attribute }, signal);
  }

  async findText(text, signal) { return this.exec('FIND_TEXT', { text }, signal); }
  async seeText(text, signal) { return this.exec('SEE_TEXT', { text }, signal); }
  async textContain(text, signal) { return this.exec('TEXT_CONTAIN', { text }, signal); }

  async getPos(target, targetType, signal) { return this.exec('GET_POS', { target, targetType }, signal); }

  async wait(seconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, seconds * 1000);
      if (signal) {
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new BrowserCancelledError('Wait cancelled')); }, { once: true });
      }
    });
  }

  async pageLoaded(signal) { return this.exec('PAGE_LOADED', {}, signal); }

  async snapshot(signal) { return this.exec('AGENT_SNAPSHOT', {}, signal); }

  async executeInPage(code, signal) { return this.exec('EVAL_IN_PAGE', { code }, signal); }
}
