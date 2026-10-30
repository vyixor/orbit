// ORBIT — Floating Bot Content Script v5
// Safe chrome API. Timer-based mouth. Idle animations. Eye gaze.

(function () {
  'use strict';

  if (window.__orbitBotLoaded) return;
  window.__orbitBotLoaded = true;

  const BOT_ID = 'orbit-float-bot';

  // ── State ─────────────────────────────────────────────────────────────────
  let _mouthTimer   = null;
  let _idleTimer    = null;
  let _gazeTimer    = null;
  let _isSpeaking   = false;
  let _mouseX       = window.innerWidth / 2;
  let _mouseY       = window.innerHeight / 2;
  let _lastMouseMove = Date.now();
  let _mouthOpen    = false;

  // ── Safe chrome wrappers ──────────────────────────────────────────────────
  function safeGet(key) {
    return new Promise(r => {
      try { chrome.storage.local.get(key, d => { chrome.runtime.lastError; r(d?.[key]); }); }
      catch (_) { r(undefined); }
    });
  }
  function safeSet(key, val) { try { chrome.storage.local.set({ [key]: val }); } catch (_) {} }
  function safeSend(msg) { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) {} }
  function ctxOk() { try { return !!(chrome.runtime?.id); } catch (_) { return false; } }

  // ── Styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('orbit-bot-styles')) return;
    const s = document.createElement('style');
    s.id = 'orbit-bot-styles';
    s.textContent = `
      #orbit-float-bot {
        position: fixed; z-index: 2147483647;
        display: flex; flex-direction: column; align-items: center; gap: 3px;
        cursor: grab; user-select: none;
        filter: drop-shadow(0 4px 14px rgba(91,143,255,0.4));
        transition: filter 0.2s;
      }
      #orbit-float-bot:hover { filter: drop-shadow(0 6px 22px rgba(91,143,255,0.75)); }
      #orbit-float-bot:active { cursor: grabbing; }
      #orbit-bot-svg { display: block; overflow: visible; }
      .ob-bob  { animation: ob-bob 3s ease-in-out infinite; }
      .ob-think { animation: ob-think 0.7s ease-in-out infinite; }
      @keyframes ob-bob  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
      @keyframes ob-think { 0%,100%{transform:translateY(0) rotate(0deg)} 25%{transform:translateY(-3px) rotate(-5deg)} 75%{transform:translateY(-3px) rotate(5deg)} }
      #orbit-bot-label {
        font-family:'Segoe UI',system-ui,sans-serif; font-size:9px; font-weight:700;
        letter-spacing:2px; color:#5b8fff; background:rgba(10,10,16,0.9);
        padding:2px 7px; border-radius:4px; border:1px solid rgba(91,143,255,0.25); white-space:nowrap;
      }
      #orbit-bot-close {
        position:absolute; top:-5px; right:-5px; width:17px; height:17px;
        background:#1a1a24; border:1px solid rgba(91,143,255,0.4); border-radius:50%;
        color:#777; font-size:9px; line-height:17px; text-align:center;
        cursor:pointer; opacity:0; transition:opacity 0.15s; z-index:1; font-family:sans-serif;
      }
      #orbit-float-bot:hover #orbit-bot-close { opacity:1; }
      #orbit-bot-close:hover { color:#fff; background:#c0392b; border-color:#c0392b; }
    `;
    document.head.appendChild(s);
  }

  // ── Mouth shapes ─────────────────────────────────────────────────────────
  // Closed paths (end with Z or return to start) so fill works properly
  const MOUTHS = {
    smile:    { d: 'M 18 36 Q 26 42 34 36', fill: 'none' },
    neutral:  { d: 'M 18 37 Q 26 38 34 37', fill: 'none' },
    happy:    { d: 'M 16 35 Q 26 45 36 35', fill: 'none' },
    thinking: { d: 'M 20 37 Q 23 36 30 38', fill: 'none' },
    concerned:{ d: 'M 18 39 Q 26 35 34 39', fill: 'none' },
    // Open mouth = top lip + bottom lip forming a closed shape with red fill
    open1:    { d: 'M 18 35 Q 26 33 34 35 Q 26 45 18 35 Z', fill: '#8B0000' },
    open2:    { d: 'M 18 35 Q 26 34 34 35 Q 26 43 18 35 Z', fill: '#6B1010' },
    half:     { d: 'M 18 36 Q 26 34 34 36 Q 26 41 18 36 Z', fill: '#4a0808' },
    closed:   { d: 'M 18 37 Q 26 38 34 37', fill: 'none' },
  };

  function setMouth(expr) {
    const bot = document.getElementById(BOT_ID);
    if (!bot) return;
    const m = bot.querySelector('#ob-mouth');
    if (!m) return;
    const shape = MOUTHS[expr] || MOUTHS.smile;
    m.setAttribute('d', shape.d);
    m.setAttribute('fill', shape.fill);
    m.setAttribute('stroke', shape.fill === 'none' ? '#5b8fff' : '#cc2200');
  }

  // ── Build SVG ─────────────────────────────────────────────────────────────
  function buildSVG() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.id = 'orbit-bot-svg';
    svg.setAttribute('width', '56');
    svg.setAttribute('height', '56');
    svg.setAttribute('viewBox', '0 0 52 52');
    svg.classList.add('ob-bob');

    // Body
    const body = document.createElementNS(ns, 'circle');
    body.setAttribute('cx','26'); body.setAttribute('cy','28'); body.setAttribute('r','22');
    body.setAttribute('fill','#0e0e10'); body.setAttribute('stroke','#5b8fff'); body.setAttribute('stroke-width','2');
    svg.appendChild(body);

    // Orbit ring
    const ring = document.createElementNS(ns, 'ellipse');
    ring.setAttribute('cx','26'); ring.setAttribute('cy','28'); ring.setAttribute('rx','15'); ring.setAttribute('ry','4.5');
    ring.setAttribute('fill','none'); ring.setAttribute('stroke','#5b8fff'); ring.setAttribute('stroke-width','1');
    ring.setAttribute('opacity','0.25'); ring.setAttribute('transform','rotate(-18 26 28)');
    svg.appendChild(ring);

    // Antenna
    const ant = document.createElementNS(ns, 'line');
    ant.setAttribute('x1','26'); ant.setAttribute('y1','6'); ant.setAttribute('x2','26'); ant.setAttribute('y2','13');
    ant.setAttribute('stroke','#5b8fff'); ant.setAttribute('stroke-width','1.5'); ant.setAttribute('stroke-linecap','round');
    svg.appendChild(ant);
    const antDot = document.createElementNS(ns, 'circle');
    antDot.setAttribute('cx','26'); antDot.setAttribute('cy','5'); antDot.setAttribute('r','2.5'); antDot.setAttribute('fill','#5b8fff');
    svg.appendChild(antDot);

    // Ear studs
    const earL = document.createElementNS(ns, 'circle');
    earL.setAttribute('cx','4'); earL.setAttribute('cy','28'); earL.setAttribute('r','2'); earL.setAttribute('fill','#5b8fff'); earL.setAttribute('opacity','0.45');
    svg.appendChild(earL);
    const earR = document.createElementNS(ns, 'circle');
    earR.setAttribute('cx','48'); earR.setAttribute('cy','28'); earR.setAttribute('r','2'); earR.setAttribute('fill','#5b8fff'); earR.setAttribute('opacity','0.45');
    svg.appendChild(earR);

    // Eyes — left
    const eyeL = document.createElementNS(ns, 'g');
    eyeL.id = 'ob-eye-l';
    const elL = document.createElementNS(ns, 'ellipse');
    elL.setAttribute('cx','18'); elL.setAttribute('cy','25'); elL.setAttribute('rx','4'); elL.setAttribute('ry','4.5'); elL.setAttribute('fill','#5b8fff');
    const puL = document.createElementNS(ns, 'circle');
    puL.id = 'ob-pup-l'; puL.setAttribute('cx','18'); puL.setAttribute('cy','25'); puL.setAttribute('r','2'); puL.setAttribute('fill','#060610');
    // Shine
    const shL = document.createElementNS(ns, 'circle');
    shL.setAttribute('cx','19.5'); shL.setAttribute('cy','23.5'); shL.setAttribute('r','0.8'); shL.setAttribute('fill','rgba(255,255,255,0.7)');
    eyeL.appendChild(elL); eyeL.appendChild(puL); eyeL.appendChild(shL);
    svg.appendChild(eyeL);

    // Eyes — right
    const eyeR = document.createElementNS(ns, 'g');
    eyeR.id = 'ob-eye-r';
    const elR = document.createElementNS(ns, 'ellipse');
    elR.setAttribute('cx','34'); elR.setAttribute('cy','25'); elR.setAttribute('rx','4'); elR.setAttribute('ry','4.5'); elR.setAttribute('fill','#5b8fff');
    const puR = document.createElementNS(ns, 'circle');
    puR.id = 'ob-pup-r'; puR.setAttribute('cx','34'); puR.setAttribute('cy','25'); puR.setAttribute('r','2'); puR.setAttribute('fill','#060610');
    const shR = document.createElementNS(ns, 'circle');
    shR.setAttribute('cx','35.5'); shR.setAttribute('cy','23.5'); shR.setAttribute('r','0.8'); shR.setAttribute('fill','rgba(255,255,255,0.7)');
    eyeR.appendChild(elR); eyeR.appendChild(puR); eyeR.appendChild(shR);
    svg.appendChild(eyeR);

    // Mouth fill path (interior color when open)
    const mouthFill = document.createElementNS(ns, 'path');
    mouthFill.id = 'ob-mouth-fill';    mouthFill.setAttribute('fill','none');
    mouthFill.setAttribute('opacity','0');
    svg.appendChild(mouthFill);

    // Mouth outline
    const mouth = document.createElementNS(ns, 'path');
    mouth.id = 'ob-mouth';
    mouth.setAttribute('d', MOUTHS.smile.d);
    mouth.setAttribute('stroke','#5b8fff'); mouth.setAttribute('stroke-width','2');
    mouth.setAttribute('fill','none'); mouth.setAttribute('stroke-linecap','round');
    svg.appendChild(mouth);

    return svg;
  }

  // ── Mouth animation — timer-based, cycles through open/close ─────────────
  const SPEAK_CYCLE = ['open1','half','open2','closed','half','open1','closed','open2','half','closed'];
  let _speakIdx = 0;

  function startMouth() {
    stopMouth();
    _isSpeaking = true;
    _speakIdx = 0;
    _mouthTimer = setInterval(() => {
      setMouth(SPEAK_CYCLE[_speakIdx % SPEAK_CYCLE.length]);
      _speakIdx++;
    }, 110);
  }

  function stopMouth() {
    if (_mouthTimer) { clearInterval(_mouthTimer); _mouthTimer = null; }
    _isSpeaking = false;
    setMouth('smile');
  }

  // ── TTS — global entry point ───────────────────────────────────────────────
  // Chrome has a known bug where speechSynthesis stalls after the page loses
  // focus. We work around it with a resume() keepalive and always cancel()
  // before starting a new utterance to fully reset the queue.
  //
  // Bubble timing: the bubble is shown on utter.onstart (not before) and
  // hidden on utter.onend so it is perfectly in sync with actual audio.

  let _currentBubble  = null;   // the live bubble DOM node, if any
  let _resumeTimer    = null;   // keepalive timer for Chrome TTS stall bug
  let _speakCallCount = 0;      // monotonic counter — each call gets a unique id

  function _showBubble(text) {
    const bot = document.getElementById(BOT_ID);
    if (!bot) return;
    // Remove any existing bubble immediately
    _hideBubble();

    const MAX = 80;
    const display = text.length > MAX ? text.slice(0, MAX - 1) + '…' : text;

    const bubble = document.createElement('div');
    bubble.className = 'orbit-say-bubble';
    bubble.style.cssText = [
      'position:absolute',
      'bottom:68px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(8,8,18,0.96)',
      'border:1.5px solid rgba(91,143,255,0.55)',
      'border-radius:10px',
      'padding:7px 11px',
      'font-size:11px',
      'line-height:1.45',
      'color:#dde8ff',
      'font-family:system-ui,sans-serif',
      'white-space:normal',
      'word-break:break-word',
      'width:160px',
      'max-width:160px',
      'text-align:center',
      'box-shadow:0 2px 12px rgba(0,0,0,0.6)',
      'z-index:2147483647',
      'pointer-events:none',
    ].join(';');
    bubble.textContent = display;

    const tail = document.createElement('div');
    tail.style.cssText = [
      'position:absolute',
      'bottom:-8px',
      'left:50%',
      'transform:translateX(-50%)',
      'width:0',
      'height:0',
      'border-left:7px solid transparent',
      'border-right:7px solid transparent',
      'border-top:8px solid rgba(91,143,255,0.55)',
    ].join(';');
    bubble.appendChild(tail);
    bot.appendChild(bubble);
    _currentBubble = bubble;
  }

  function _hideBubble() {
    if (_currentBubble) { _currentBubble.remove(); _currentBubble = null; }
    // Also sweep any orphaned bubbles from previous runs
    document.querySelectorAll('.orbit-say-bubble').forEach(b => b.remove());
  }

  window.__orbitBotSpeak = function (text, voiceSettings) {
    if (!text || !window.speechSynthesis) return;

    // Assign a unique id to this call so stale callbacks don\'t fire
    const myCallId = ++_speakCallCount;

    // Cancel any in-progress speech, stop mouth, clear resume timer
    if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
    window.speechSynthesis.cancel();
    stopMouth();
    _hideBubble();

    function doSpeak() {
      // Guard: if a newer call arrived while we were waiting for voices, bail
      if (myCallId !== _speakCallCount) return;

      const utter = new SpeechSynthesisUtterance(text);
      utter.rate   = voiceSettings?.rate   ?? 1.05;
      utter.pitch  = voiceSettings?.pitch  ?? 1.0;
      utter.volume = voiceSettings?.volume ?? 1.0;

      if (voiceSettings?.voiceName) {
        const v = speechSynthesis.getVoices().find(v => v.name === voiceSettings.voiceName);
        if (v) utter.voice = v;
      }

      // ── Bubble + mouth start ONLY when audio actually begins ──
      utter.onstart = () => {
        if (myCallId !== _speakCallCount) return; // superseded
        _showBubble(text);
        startMouth();
        gaze(26, 20);

        // Chrome TTS stall workaround: resume() every 10s keeps the engine alive
        _resumeTimer = setInterval(() => {
          if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
        }, 10000);
      };

      // ── Bubble + mouth end when audio actually finishes ──
      utter.onend = () => {
        if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
        stopMouth();
        _hideBubble();
        resetGaze();
        // Notify the sidepanel so say() in scripts can await actual completion
        try { chrome.runtime.sendMessage({ action: 'ORBIT_SPEAK_DONE' }); } catch(_) {}
      };

      utter.onerror = (e) => {
        if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
        // \'interrupted\' fires when we cancel intentionally — not a real error
        if (e.error !== 'interrupted') { stopMouth(); _hideBubble(); resetGaze(); }
      };

      window.speechSynthesis.speak(utter);
    }

    // Voices may not be ready on first call after page load
    if (speechSynthesis.getVoices().length === 0) {
      speechSynthesis.onvoiceschanged = () => { speechSynthesis.onvoiceschanged = null; doSpeak(); };
    } else {
      // Small defer so cancel() has time to flush before speak()
      setTimeout(doSpeak, 50);
    }
  };

  // ── Eye gaze ──────────────────────────────────────────────────────────────
  function gaze(targetX, targetY) {
    const bot = document.getElementById(BOT_ID);
    if (!bot) return;
    const rect = bot.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;

    const angle = Math.atan2(targetY - cy, targetX - cx);
    const dist  = 1.6;
    const dx    = Math.cos(angle) * dist;
    const dy    = Math.sin(angle) * dist;

    const pl = bot.querySelector('#ob-pup-l');
    const pr = bot.querySelector('#ob-pup-r');
    if (pl) { pl.setAttribute('cx', 18 + dx); pl.setAttribute('cy', 25 + dy); }
    if (pr) { pr.setAttribute('cx', 34 + dx); pr.setAttribute('cy', 25 + dy); }
  }

  function resetGaze() {
    // Return to tracking mouse
    gaze(_mouseX, _mouseY);
  }

  function startGazeLoop() {
    if (_gazeTimer) clearInterval(_gazeTimer);
    _gazeTimer = setInterval(() => {
      if (_isSpeaking) return; // gaze is controlled by speech when talking
      const idle = Date.now() - _lastMouseMove;
      if (idle > 4000) {
        // Idle — look around randomly
        const rx = Math.random() * window.innerWidth;
        const ry = Math.random() * window.innerHeight;
        gaze(rx, ry);
      } else {
        gaze(_mouseX, _mouseY);
      }
    }, 600);
  }

  // ── Blink ─────────────────────────────────────────────────────────────────
  function startBlink() {
    function blink() {
      if (!document.getElementById(BOT_ID)) return;
      const eyeL = document.querySelector('#ob-eye-l');
      const eyeR = document.querySelector('#ob-eye-r');
      if (eyeL && eyeR && !_isSpeaking) {
        eyeL.style.transition = eyeR.style.transition = 'transform 0.07s';
        eyeL.style.transformOrigin = '18px 25px';
        eyeR.style.transformOrigin = '34px 25px';
        eyeL.style.transform = eyeR.style.transform = 'scaleY(0.05)';
        setTimeout(() => {
          eyeL.style.transform = eyeR.style.transform = 'scaleY(1)';
        }, 100);
      }
      setTimeout(blink, 2000 + Math.random() * 4000);
    }
    setTimeout(blink, 1200 + Math.random() * 1000);
  }

  // ── Idle animation — look around, occasionally bob head ──────────────────
  function startIdleLoop() {
    if (_idleTimer) clearInterval(_idleTimer);
    _idleTimer = setInterval(() => {
      if (_isSpeaking) return;
      const idle = Date.now() - _lastMouseMove;
      const svg  = document.querySelector('#orbit-bot-svg');
      if (!svg) return;

      if (idle > 8000) {
        // Been idle a while — do a random look or head tilt
        svg.classList.remove('ob-bob');
        svg.classList.add('ob-think');
        setTimeout(() => {
          svg.classList.remove('ob-think');
          svg.classList.add('ob-bob');
        }, 1500);
      }
    }, 6000);
  }

  // ── Create bot ────────────────────────────────────────────────────────────
  async function createBot() {
    if (document.getElementById(BOT_ID)) return;
    injectStyles();

    const pos = await safeGet('orbit_bot_pos');
    const wrap = document.createElement('div');
    wrap.id = BOT_ID;

    if (pos) { wrap.style.left = `${pos.x}px`; wrap.style.top = `${pos.y}px`; }
    else      { wrap.style.right = '20px'; wrap.style.bottom = '80px'; }

    const closeBtn = document.createElement('div');
    closeBtn.id = 'orbit-bot-close'; closeBtn.title = 'Close ORBIT'; closeBtn.textContent = '✕';
    wrap.appendChild(closeBtn);
    wrap.appendChild(buildSVG());

    const label = document.createElement('div');
    label.id = 'orbit-bot-label'; label.textContent = 'ORBIT';
    wrap.appendChild(label);

    document.body.appendChild(wrap);

    // Wire interactions
    closeBtn.addEventListener('click', e => { e.stopPropagation(); destroyBot(); });
    wrap.addEventListener('mouseenter', () => { if (!_isSpeaking) setMouth('happy'); });
    wrap.addEventListener('mouseleave', () => { if (!_isSpeaking) setMouth('smile'); });

    // Drag
    let dragging = false, ox = 0, oy = 0;
    wrap.addEventListener('mousedown', e => {
      if (e.target.id === 'orbit-bot-close') return;
      dragging = true;
      const r = wrap.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      wrap.style.cursor = 'grabbing';
      wrap.style.right = wrap.style.bottom = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      _mouseX = e.clientX; _mouseY = e.clientY; _lastMouseMove = Date.now();
      if (dragging) {
        wrap.style.left = `${e.clientX - ox}px`; wrap.style.top = `${e.clientY - oy}px`;
        safeSet('orbit_bot_pos', { x: e.clientX - ox, y: e.clientY - oy });
      }
    });
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; wrap.style.cursor = 'grab'; } });

    // Double-click opens side panel
    let lastClick = 0;
    wrap.addEventListener('click', e => {
      if (e.target.id === 'orbit-bot-close') return;
      const now = Date.now();
      if (now - lastClick < 350) safeSend({ action: 'OPEN_SIDE_PANEL_CURRENT_TAB' });
      lastClick = now;
    });

    // Start life
    setMouth('smile');
    startBlink();
    startGazeLoop();
    startIdleLoop();

    // Save available voices to storage so the script engine can list them
    function saveVoices() {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      const list = voices.map((v, i) => ({ index: i, name: v.name, lang: v.lang, default: v.default }));
      safeSet('orbit_voices', list);
    }
    saveVoices();
    speechSynthesis.onvoiceschanged = saveVoices;
  }

  function destroyBot() {
    stopMouth();
    if (_gazeTimer) { clearInterval(_gazeTimer); _gazeTimer = null; }
    if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
    window.speechSynthesis?.cancel();
    document.getElementById(BOT_ID)?.remove();
    safeSet('orbit_bot_active', false);
  }

  // ── Message listener ──────────────────────────────────────────────────────
  function setupListener() {
    if (!ctxOk()) return;
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'ORBIT_BOT_SHOW') { safeSet('orbit_bot_active', true); createBot(); }
        if (msg.action === 'ORBIT_BOT_HIDE') { destroyBot(); }
        if (msg.action === 'ORBIT_BOT_EXPRESSION') {
          if (!_isSpeaking) setMouth(msg.expr || 'smile');
        }
        if (msg.action === 'ORBIT_SPEAK_NOTIFICATION') {
          const bot = document.getElementById(BOT_ID);
          const doSpeak = () => window.__orbitBotSpeak(msg.text, msg.voice);
          if (!bot) createBot().then(() => setTimeout(doSpeak, 500));
          else doSpeak();
        }
        // ■ Stop pressed — cancel any in-progress speech immediately
        if (msg.action === 'ORBIT_SPEAK_STOP') {
          if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
          _hideBubble();
          stopMouth();
          resetGaze();
          if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
        }
        // Side panel started speaking — sync our mouth
        if (msg.action === 'ORBIT_BOT_MOUTH_START') startMouth();
        if (msg.action === 'ORBIT_BOT_MOUTH_STOP')  stopMouth();

        // ── Script engine companion commands ────────────────────────────
        if (msg.action === 'ORBIT_BOT_SHAKE') {
          const bot = document.getElementById(BOT_ID);
          const svg = bot?.querySelector('svg') || document.getElementById('orbit-bot-svg');
          if (svg) {
            svg.style.animation = 'none';
            setTimeout(() => {
              svg.style.animation = 'ob-shake 0.4s ease-in-out';
              setTimeout(() => { svg.style.animation = ''; }, 500);
            }, 10);
          }
        }

        if (msg.action === 'ORBIT_BOT_ROLL') {
          const bot = document.getElementById(BOT_ID);
          if (bot) {
            // Inject keyframe if not already present
            if (!document.getElementById('orbit-roll-style')) {
              const st = document.createElement('style');
              st.id = 'orbit-roll-style';
              st.textContent = `
                @keyframes ob-roll {
                  0%   { transform: rotate(0deg)   translateY(0px);  }
                  25%  { transform: rotate(90deg)  translateY(-12px); }
                  50%  { transform: rotate(180deg) translateY(0px);  }
                  75%  { transform: rotate(270deg) translateY(-12px); }
                  100% { transform: rotate(360deg) translateY(0px);  }
                }
              `;
              document.head.appendChild(st);
            }
            bot.style.transition = 'none';
            bot.style.animation = 'ob-roll 0.65s cubic-bezier(0.36,0.07,0.19,0.97)';
            setTimeout(() => {
              bot.style.animation = '';
              bot.style.transition = '';
            }, 700);
          }
        }
        if (msg.action === 'ORBIT_BOT_FACE') {
          const faces = { happy: 'smile', sad: 'concerned', happy2: 'happy', neutral: 'neutral',
                          frown: 'concerned', laugh: 'happy', cry: 'concerned' };
          setMouth(faces[msg.expr] || msg.expr || 'smile');
        }
        if (msg.action === 'ORBIT_BOT_LOOK') {
          const bot = document.getElementById(BOT_ID);
          if (bot) {
            const deg = Math.max(0, Math.min(360, parseFloat(msg.degrees) || 0));
            const rad = (deg - 90) * (Math.PI / 180);
            const dist = 3;
            const ox = Math.cos(rad) * dist;
            const oy = Math.sin(rad) * dist;
            const pupL = bot.querySelector('#ob-pup-l');
            const pupR = bot.querySelector('#ob-pup-r');
            if (pupL) { pupL.setAttribute('cx', String(18 + ox)); pupL.setAttribute('cy', String(25 + oy)); }
            if (pupR) { pupR.setAttribute('cx', String(34 + ox)); pupR.setAttribute('cy', String(25 + oy)); }
          }
        }
        if (msg.action === 'ORBIT_BOT_MOVE') {
          const bot = document.getElementById(BOT_ID);
          if (bot) {
            const x = Math.max(0, Math.min(window.innerWidth  - 60, parseFloat(msg.x) || 0));
            const y = Math.max(0, Math.min(window.innerHeight - 60, parseFloat(msg.y) || 0));
            bot.style.left = x + 'px';
            bot.style.top  = y + 'px';
          }
        }
        if (msg.action === 'ORBIT_BOT_EYES') {
          const bot = document.getElementById(BOT_ID);
          if (!bot) return;
          const ns = 'http://www.w3.org/2000/svg';
          const eyeL = bot.querySelector('#ob-eye-l');
          const eyeR = bot.querySelector('#ob-eye-r');

          function buildEyeChildren(cx, cy) {
            // Returns [ellipse, pupil, shine] — same as buildSVG
            const el = document.createElementNS(ns, 'ellipse');
            el.setAttribute('cx', cx); el.setAttribute('cy', cy);
            el.setAttribute('rx','4'); el.setAttribute('ry','4.5'); el.setAttribute('fill','#5b8fff');
            const pu = document.createElementNS(ns, 'circle');
            pu.setAttribute('cx', cx); pu.setAttribute('cy', cy);
            pu.setAttribute('r','2'); pu.setAttribute('fill','#060610');
            const sh = document.createElementNS(ns, 'circle');
            sh.setAttribute('cx', cx + 1.5); sh.setAttribute('cy', cy - 1.5);
            sh.setAttribute('r','0.8'); sh.setAttribute('fill','rgba(255,255,255,0.7)');
            return [el, pu, sh];
          }

          if (msg.open) {
            // Rebuild full open-eye content
            if (eyeL) {
              eyeL.innerHTML = '';
              buildEyeChildren(18, 25).forEach(n => eyeL.appendChild(n));
              // Restore pupil ids for gaze
              const children = eyeL.querySelectorAll('circle');
              if (children[0]) children[0].id = 'ob-pup-l';
            }
            if (eyeR) {
              eyeR.innerHTML = '';
              buildEyeChildren(34, 25).forEach(n => eyeR.appendChild(n));
              const children = eyeR.querySelectorAll('circle');
              if (children[0]) children[0].id = 'ob-pup-r';
            }
          } else {
            // Closed eyes — a simple curved line
            const closedPath = (cx, cy) =>
              `<path d="M ${cx-4} ${cy} Q ${cx} ${cy-3} ${cx+4} ${cy}" stroke="#5b8fff" stroke-width="2" fill="none" stroke-linecap="round"/>`;
            if (eyeL) eyeL.innerHTML = closedPath(18, 25);
            if (eyeR) eyeR.innerHTML = closedPath(34, 25);
          }
        }
        if (msg.action === 'ORBIT_BOT_MOUTH') {
          setMouth(msg.open ? 'open1' : 'closed');
        }
        if (msg.action === 'ORBIT_BOT_SAY') {
          // Bubble is now shown/hidden inside __orbitBotSpeak on utter.onstart/onend
          // so it is in perfect sync with actual audio. No action needed here.
        }
        if (msg.action === 'ORBIT_BOT_CRY') {
          setMouth('concerned');
          const bot = document.getElementById(BOT_ID);
          if (bot) {
            const svg = bot.querySelector('#orbit-bot-svg');
            if (svg) { svg.style.animation = 'ob-think 0.6s ease-in-out 3'; }
          }
        }
        if (msg.action === 'ORBIT_BOT_LAUGH') {
          setMouth('happy');
          const bot = document.getElementById(BOT_ID);
          if (bot) {
            const svg = bot.querySelector('#orbit-bot-svg');
            if (svg) { svg.style.animation = 'ob-bob 0.3s ease-in-out 6'; }
          }
        }
      });
    } catch (_) {}
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    if (!ctxOk()) return;
    setupListener();
    const active = await safeGet('orbit_bot_active');
    if (active) {
      if (document.body) createBot();
      else document.addEventListener('DOMContentLoaded', createBot);
    }
  }

  init();
})();
