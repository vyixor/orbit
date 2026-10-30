// ORBIT — Voice Service (TTS only)
// Handles text-to-speech output using the browser's built-in speechSynthesis API.
// Microphone / speech-to-text is not supported in Chrome extension pages —
// it is blocked by Chrome's extension CSP and media-input policy.

// ── TTS — Text to Speech ──────────────────────────────────────────────────────

let _currentUtterance = null;
let _onBoundary = null;
let _onEnd      = null;
let _onStart    = null;

export function setTTSCallbacks(onBoundary, onEnd, onStart) {
  _onBoundary = onBoundary;
  _onEnd      = onEnd;
  _onStart    = onStart || null;
}

export async function getVoices() {
  return new Promise(resolve => {
    const voices = speechSynthesis.getVoices();
    if (voices.length) { resolve(voices); return; }
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
  });
}

export async function speak(text, settings = {}) {
  stop();
  const voices = await getVoices();
  const utter  = new SpeechSynthesisUtterance(stripMarkdown(text));

  if (settings.voiceName) {
    const match = voices.find(v => v.name === settings.voiceName);
    if (match) utter.voice = match;
  }

  utter.rate   = settings.rate   ?? 1.0;
  utter.pitch  = settings.pitch  ?? 1.0;
  utter.volume = settings.volume ?? 1.0;
  utter.lang   = settings.lang   || 'en-US';

  utter.onstart    = () => { if (_onStart) _onStart(); };
  utter.onboundary = (e) => { if (e.name === 'word' && _onBoundary) _onBoundary(e); };
  utter.onend      = () => { _currentUtterance = null; if (_onEnd) _onEnd(); };
  utter.onerror    = () => { _currentUtterance = null; if (_onEnd) _onEnd(); };

  _currentUtterance = utter;
  speechSynthesis.speak(utter);
}

export function stop() {
  speechSynthesis.cancel();
  _currentUtterance = null;
  if (_onEnd) _onEnd();
}

export function isSpeaking() {
  return speechSynthesis.speaking;
}

// Strip markdown so TTS reads naturally
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/#{1,6} /g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/^[*\-] /gm, '')
    .replace(/^\d+\. /gm, '')
    .replace(/^> /gm, '')
    .replace(/---+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}
