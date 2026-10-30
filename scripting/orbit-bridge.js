// ORBIT — Orbit Bridge
// Routes companion commands from scripts to the floating bot.
// Runs in the sidepanel context.

export class OrbitBridge {
  // ── Internal broadcast via background worker ─────────────────────────────
  async _broadcast(payload) {
    try {
      await chrome.runtime.sendMessage({ action: 'ORBIT_BOT_BROADCAST', payload });
    } catch (_) {}
  }

  // ── Basic animations ──────────────────────────────────────────────────────
  async shake()  { return this._broadcast({ action: 'ORBIT_BOT_SHAKE' }); }
  async roll()   { return this._broadcast({ action: 'ORBIT_BOT_ROLL' }); }
  async hide()   { return this._broadcast({ action: 'ORBIT_BOT_HIDE' }); }
  async show()   { return this._broadcast({ action: 'ORBIT_BOT_SHOW' }); }
  async cry()    { return this._broadcast({ action: 'ORBIT_BOT_CRY' }); }
  async laugh()  { return this._broadcast({ action: 'ORBIT_BOT_LAUGH' }); }

  async setFace(expr)  { return this._broadcast({ action: 'ORBIT_BOT_FACE', expr }); }
  async look(degrees)  { return this._broadcast({ action: 'ORBIT_BOT_LOOK', degrees }); }
  async move(x, y)     { return this._broadcast({ action: 'ORBIT_BOT_MOVE', x, y }); }
  async openEyes()     { return this._broadcast({ action: 'ORBIT_BOT_EYES', open: true }); }
  async closeEyes()    { return this._broadcast({ action: 'ORBIT_BOT_EYES', open: false }); }
  async openMouth()    { return this._broadcast({ action: 'ORBIT_BOT_MOUTH', open: true }); }
  async closeMouth()   { return this._broadcast({ action: 'ORBIT_BOT_MOUTH', open: false }); }

  // ── say — uses ORBIT_SPEAK_NOTIFICATION for real TTS ─────────────────────
  async say(text, signal = null, voiceIndex = null) {
    if (!text) return;

    // 1. Get current voice settings from config
    let voiceSettings = {};
    try {
      const cfg = await new Promise(r =>
        chrome.storage.local.get('orbit_config', d => r(d.orbit_config || {}))
      );
      const v = cfg.voice || {};
      voiceSettings = {
        voiceName: v.voiceName,
        rate:   v.rate   ?? 1.05,
        pitch:  v.pitch  ?? 1.0,
        volume: v.volume ?? 1.0,
      };
    } catch (_) {}

    // 2. Override voice if --voice N was specified
    if (voiceIndex != null && !isNaN(voiceIndex)) {
      try {
        const voices = await this._getVoices();
        const chosen = voices[voiceIndex];
        if (chosen) voiceSettings.voiceName = chosen.name;
      } catch (_) {}
    }

    // 3. Show speech bubble (kept for compat — bubble is now driven by utter.onstart in bot)
    await this._broadcast({ action: 'ORBIT_BOT_SAY', text });

    // 4. Trigger TTS and wait for actual completion via SPEAK_DONE message.
    //    This ensures say "A"; rollOrbit; executes in sequence — rollOrbit runs
    //    only after speech ends, not while it is still playing.
    //    Fallback: if no SPEAK_DONE arrives within a generous timeout, continue anyway.
    const SPEAK_TIMEOUT = Math.min(500 + text.length * 80, 30000);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      // Listen for the bot to report speech ended
      const listener = (msg) => {
        if (msg?.action === 'ORBIT_SPEAK_DONE') {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          finish();
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      // Safety timeout in case the message never arrives
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        finish();
      }, SPEAK_TIMEOUT);

      if (signal) signal.addEventListener('abort', () => {
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timer);
        // Tell the bot to cancel speech immediately
        chrome.runtime.sendMessage({ action: 'ORBIT_BOT_BROADCAST', payload: { action: 'ORBIT_SPEAK_STOP' } })
          .catch(() => {});
        finish();
      }, { once: true });

      // Fire TTS — bot emits ORBIT_SPEAK_DONE when utter.onend fires
      this._broadcast({ action: 'ORBIT_SPEAK_NOTIFICATION', text, voice: voiceSettings });
    });
  }

  // ── listVoices — enumerate available TTS voices ───────────────────────────
  async listVoices(logFn) {
    const voices = await this._getVoices();
    if (!voices.length) {
      logFn('No voices available — TTS may not be supported in this browser');
      return [];
    }
    voices.forEach((v, i) => {
      logFn(`voice-${i}  ${v.name}  [${v.lang}]${v.default ? '  ← default' : ''}`);
    });
    return voices;
  }

  // ── Internal: get voices from speechSynthesis ────────────────────────────
  _getVoices() {
    return new Promise(resolve => {
      // speechSynthesis is not available in the sidepanel service worker context,
      // so we ask the bot content script to enumerate and return them.
      // Simpler fallback: use a hidden iframe with the extension URL.
      // Even simpler: just ask via broadcast and use a short-lived promise.
      // For now: read from chrome.storage (the bot saves them on init).
      chrome.storage.local.get('orbit_voices', (d) => {
        resolve(d.orbit_voices || []);
      });
    });
  }
}
