// ORBIT — Built-in Command Definitions
// All commands register through the registry; none require parser changes.
// Grouped by module: navigation, element, mouse/keyboard, scroll, data, companion, util.

import {
  NoBrowserError, NavigationError,
  ElementError, DragError,
  GetError,
  DialogError,
  AskError, ApiKeyError, ApiError,
  WaitError,
  AssertionError,
} from '../engine/errors.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return 'https:' + raw;
  return 'https://' + raw;
}

function resolveTarget(args, namedArgs) {
  // --type selector/text/id/... --target "value" OR positional
  const type   = namedArgs.type   || 'text';
  const target = namedArgs.target || args[0];
  if (!target && target !== 0) throw new ElementError('Target required (positional arg or --target)');
  return { type, target: String(target) };
}

// ── Register all built-ins ────────────────────────────────────────────────────
export function registerBuiltins(registry) {

  // ── NAVIGATION ────────────────────────────────────────────────────────────

  registry.register({
    name: 'navigate',
    aliases: ['goto', 'open'],
    description: 'Navigate the current tab to a URL or domain.',
    usage: 'navigate "https://example.com"',
    args: [{ name: 'url', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args) {
      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available — open a web page first');
      const url = normalizeUrl(String(args[0]));
      try { new URL(url); } catch { throw new NavigationError(`Invalid URL: ${url}`); }
      await ctx.browser.navigate(url, ctx.signal);
      return url;
    },
  });

  registry.register({
    name: 'doneLoading',
    aliases: ['done-loading'],
    description: 'Set the automation loading-complete flag.',
    usage: 'doneLoading true',
    args: [{ name: 'state', type: 'boolean', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const state = args[0] !== false && args[0] !== 0;
      ctx.log(`doneLoading → ${state}`);
      return state;
    },
  });

  registry.register({
    name: 'wait',
    description: 'Pause execution for a number of seconds.',
    usage: 'wait 2',
    args: [{ name: 'seconds', type: 'number', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const s = parseFloat(args[0]);
      if (isNaN(s) || s < 0) throw new WaitError('wait requires a non-negative number of seconds');
      await ctx.browser.wait(s, ctx.signal);
      return s;
    },
  });

  // ── SCROLLING ─────────────────────────────────────────────────────────────

  registry.register({
    name: 'scrollDown',
    aliases: ['scroll-down'],
    description: 'Scroll the page down. Amount is in viewport units.',
    usage: 'scrollDown 2',
    args: [{ name: 'amount', type: 'number', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const amt = parseFloat(args[0] ?? 1);
      await ctx.browser.scrollDown(amt, ctx.signal);
      return amt;
    },
  });

  registry.register({
    name: 'scrollUp',
    aliases: ['scroll-up'],
    description: 'Scroll the page up.',
    usage: 'scrollUp 2',
    args: [{ name: 'amount', type: 'number', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const amt = parseFloat(args[0] ?? 1);
      await ctx.browser.scrollUp(amt, ctx.signal);
      return amt;
    },
  });

  // ── CLICK ─────────────────────────────────────────────────────────────────

  registry.register({
    name: 'click',
    description: 'Click an element by text, id, selector, or other type.',
    usage: 'click "Continue"\nclick --type selector "button.primary"\nclick --type id "submit"',
    args: [{ name: 'target', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const { type, target } = resolveTarget(args, namedArgs);
      await ctx.browser.click(target, type, ctx.signal);
      return { clicked: target, type };
    },
  });

  registry.register({
    name: 'rightClick',
    aliases: ['right-click', 'contextClick'],
    description: 'Right-click (context menu) on an element.',
    usage: 'rightClick --type selector ".menu-item"',
    args: [{ name: 'target', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const { type, target } = resolveTarget(args, namedArgs);
      await ctx.browser.rightClick(target, type, ctx.signal);
      return { rightClicked: target, type };
    },
  });

  // ── FOCUS ─────────────────────────────────────────────────────────────────

  registry.register({
    name: 'focus',
    description: 'Focus an element.',
    usage: 'focus --type selector "input[name=q]"',
    args: [{ name: 'target', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const { type, target } = resolveTarget(args, namedArgs);
      await ctx.browser.focus(target, type, ctx.signal);
      return { focused: target, type };
    },
  });

  // ── TYPE / PRESS ──────────────────────────────────────────────────────────

  registry.register({
    name: 'type',
    description: 'Type text into the currently focused element.',
    usage: 'type "Hello world"\ntype "Hello" speed 0.25',
    args: [{ name: 'text', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const text  = String(args[0] ?? '');
      const speed = namedArgs.speed != null ? parseFloat(namedArgs.speed) : null;
      await ctx.browser.type(text, speed, ctx.signal);
      return text;
    },
  });

  registry.register({
    name: 'press',
    description: 'Press a keyboard key or combo.',
    usage: 'press Enter\npress Control+L',
    args: [{ name: 'key', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const key = String(args[0] ?? '');
      await ctx.browser.press(key, ctx.signal);
      return key;
    },
  });

  // ── DRAG ──────────────────────────────────────────────────────────────────

  registry.register({
    name: 'drag',
    description: 'Drag an element to viewport coordinates.',
    usage: 'drag 500 300 "Draggable item"\ndrag 500 300 --type selector ".handle"',
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const destX  = parseFloat(args[0]);
      const destY  = parseFloat(args[1]);
      const target = namedArgs.target || args[2];
      const type   = namedArgs.type || 'text';
      if (isNaN(destX) || isNaN(destY)) throw new DragError('drag requires numeric X and Y coordinates');
      await ctx.browser.drag(destX, destY, target, type, ctx.signal);
      return { destX, destY, target, type };
    },
  });

  // ── PAGE TEXT INSPECTION ──────────────────────────────────────────────────

  registry.register({
    name: 'findText',
    aliases: ['find-text'],
    description: 'Find visible text on the page. Returns element info or null.',
    usage: 'findText "Welcome"',
    args: [{ name: 'text', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args) {
      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available');
      const r = await ctx.browser.findText(String(args[0]), ctx.signal);
      return r?.data !== undefined ? r.data : r;
    },
  });

  registry.register({
    name: 'seeText',
    aliases: ['see-text'],
    description: 'Returns true if text is visible on the page, false otherwise.',
    usage: 'var found = $run(seeText "Dashboard")',
    args: [{ name: 'text', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args) {
      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available');
      const r = await ctx.browser.seeText(String(args[0]), ctx.signal);
      const val = r?.data !== undefined ? r.data : r;
      return !!val;
    },
  });

  registry.register({
    name: 'textContain',
    aliases: ['text-contain'],
    description: 'Checks whether the page contains the given text (partial match).',
    usage: 'textContain "Welcome"',
    args: [{ name: 'text', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args) {
      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available');
      const r = await ctx.browser.textContain(String(args[0]), ctx.signal);
      return r?.data !== undefined ? r.data : r;
    },
  });

  // ── DATA RETRIEVAL ────────────────────────────────────────────────────────

  registry.register({
    name: 'get',
    description: 'Retrieve data from a page element.',
    usage: 'get --type text --target selector "h1"\nget --type value --target id "email-input"\nget --type attribute --target selector ".card" --attribute "href"',
    builtin: true,
    async execute(ctx, args, namedArgs) {
      // Spec syntax:  get --type <retrieval> --target <targetType> "elementValue"
      // --type  = what to retrieve  (text, value, innerHTML, count, exists, …)
      // --target = how to find it   (text, id, selector)
      // positional arg 0 = the actual element selector / text / id string
      const retrieval  = String(namedArgs.type   || 'text');
      const targetType = String(namedArgs.target  || 'selector'); // "selector", "text", or "id"
      const target     = args[0] != null ? String(args[0]) : namedArgs.value != null ? String(namedArgs.value) : null;
      const attribute  = namedArgs.attribute != null ? String(namedArgs.attribute) : (args[1] != null ? String(args[1]) : null);

      if (!target && retrieval !== 'count') throw new GetError('get: missing element value. Usage: get --type text --target selector "h1"');

      const VALID = new Set(['text','innerText','textContent','innerHTML','outerHTML','value',
        'attribute','id','class','href','src','title','tagName','count','exists','visible']);
      if (!VALID.has(retrieval)) throw new GetError(`get: unknown type "${retrieval}". Valid: ${[...VALID].join(', ')}`);

      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available');
      const result = await ctx.browser.get(retrieval, target || '*', targetType, attribute, ctx.signal);
      if (result && result.ok === false) throw new GetError(result.error || 'get failed');
      return result?.data !== undefined ? result.data : result;
    },
  });

  // ── ELEMENT POSITION ──────────────────────────────────────────────────────

  registry.register({
    name: 'getPos',
    aliases: ['get-pos', 'getPosition'],
    description: 'Get the position and size of an element. Returns { x, y, width, height, centerX, centerY }.',
    usage: 'getPos --type text "Continue"\nvar pos = $run(getPos --type selector ".card")',
    builtin: true,
    async execute(ctx, args, namedArgs) {
      if (!ctx.browser) throw new NoBrowserError('Browser adapter not available');
      const { type, target } = resolveTarget(args, namedArgs);
      const r = await ctx.browser.getPos(target, type, ctx.signal);
      if (r?.ok === false) throw new GetError(r.error || 'getPos failed');
      return r?.data !== undefined ? r.data : r;
    },
  });

  // ── DIALOG COMMANDS ──────────────────────────────────────────────────────
  // alert, confirm, prompt — show a styled overlay in the sidepanel.
  // These pause the script and wait for the user to respond.
  // They use window.__orbitScriptDialog() which is set up by app.js.

  registry.register({
    name: 'alert',
    description: 'Show a message dialog and pause the script until the user clicks OK.',
    usage: 'alert "Are you sure you want to continue?";',
    builtin: true,
    async execute(ctx, args) {
      const msg = String(args[0] ?? '').trim() || 'Alert';
      ctx.log(`alert: ${msg}`);
      const fn = (typeof window !== 'undefined') && window.__orbitScriptDialog;
      if (!fn) throw new DialogError('alert: dialog not available in this context');
      await fn('alert', msg);
      return null;
    },
  });

  registry.register({
    name: 'confirm',
    description: 'Show a Yes/No dialog. Returns true if the user clicks Yes, null if No/Cancel. Script can branch on the result.',
    usage: [
      'var ok = $run(confirm "Are you sure you want to delete this?");',
      'if {$ok} { say "Confirmed"; } else { say "Cancelled"; }',
    ].join('\n'),
    builtin: true,
    async execute(ctx, args) {
      const msg = String(args[0] ?? '').trim() || 'Confirm';
      ctx.log(`confirm: ${msg}`);
      const fn = (typeof window !== 'undefined') && window.__orbitScriptDialog;
      if (!fn) throw new DialogError('confirm: dialog not available in this context');
      const result = await fn('confirm', msg);
      return result === true ? true : false;
    },
  });

  registry.register({
    name: 'prompt',
    aliases: ['ask-user'],
    description: 'Show a text input dialog and return the user\'s answer as a string. Returns null if the user cancels.',
    usage: [
      'var name = $run(prompt "What is your name?");',
      'if {$name} { say "Hello, {$name}!"; } else { say "Cancelled."; }',
    ].join('\n'),
    builtin: true,
    async execute(ctx, args) {
      const msg = String(args[0] ?? '').trim() || 'Enter a value:';
      ctx.log(`prompt: ${msg}`);
      const fn = (typeof window !== 'undefined') && window.__orbitScriptDialog;
      if (!fn) throw new DialogError('prompt: dialog not available in this context');
      const result = await fn('prompt', msg);
      return typeof result === 'string' ? result : null;
    },
  });

  // ── AI COMMANDS ──────────────────────────────────────────────────────────
  //
  // $ask("prompt")  — ask ORBIT's AI a question from inside a script.
  //
  // Deliberately limited vs full chat mode:
  //   ✓  Full Groq AI (same model, same quality)
  //   ✓  Auto-research via Tavily if the AI decides it needs it
  //   ✓  --page flag: reads the current tab and injects its text as context
  //   ✓  --agent flag: runs the browser agent on the prompt instead of chat
  //   ✗  No memory read or write (no memoryForPrompt / applyMemoryUpdate)
  //   ✗  No chat history (each $ask is stateless)
  //   ✗  No UI side-effects — only the response text is returned
  //
  // Usage:
  //   var answer = $run(ask "What is the capital of France?");
  //   var summary = $run(ask "Summarize this page" --page);
  //   var result = $run(ask "Find the price of the first product" --agent);
  //   say {$answer};

  registry.register({
    name: 'ask',
    description: 'Ask the AI a question from inside a script and return its text response. Supports --page (inject current tab content) and --agent (run as browser agent task). No memory or chat history — pure stateless AI call.',
    usage: [
      'var a = $run(ask "What is the boiling point of water?");',
      'var s = $run(ask "Summarize this article" --page);',
      'var r = $run(ask "Find the cheapest item on this page" --agent);',
      'say {$a};',
    ].join('\n'),
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const svc = ctx.chatServices;
      if (!svc) throw new AskError('$ask: AI services not available in this context');
      const { chat, research, formatResearchContext, runAgentTask } = svc;

      const prompt = String(args[0] || namedArgs.prompt || '').trim();
      if (!prompt) throw new AskError('$ask: prompt is required — e.g. ask "What is X?"');

      const usePage  = namedArgs.page  != null;
      const useAgent = namedArgs.agent != null;

      // ── Agent mode ────────────────────────────────────────────────────────
      // Runs the full browser agent loop. Returns the final done/fail message.
      if (useAgent) {
        ctx.log(`$ask --agent: ${prompt}`);
        const messages = [];
        let lastMessage = '';

        // Provide a minimal onAsk responder so the agent doesn't hang if it
        // gets stuck — we tell it to stop, since there's no user at the keyboard.
        const onAsk = async (question) => {
          ctx.log(`$ask --agent question: ${question}`);
          return 'stop';
        };

        for await (const event of runAgentTask(prompt, onAsk)) {
          if (event.type === 'status') {
            ctx.log(event.text);
          } else if (event.type === 'step') {
            ctx.log(`Agent step: ${event.step?.action} → ${event.step?.target || ''}`);
          } else if (event.type === 'ask') {
            ctx.log(`Agent asked: ${event.question}`);
          } else if (event.type === 'done') {
            lastMessage = event.message || (event.success ? 'Done.' : 'Failed.');
            ctx.log(`Agent done: ${lastMessage}`);
          } else if (event.type === 'error') {
            throw new AskError(`$ask --agent error: ${event.text}`);
          }
        }

        return lastMessage;
      }

      // ── Page-context mode ─────────────────────────────────────────────────
      // Reads the current tab and prepends its content to the prompt.
      let fullPrompt = prompt;

      if (usePage) {
        ctx.log('$ask --page: reading current tab…');
        const resp = await new Promise(resolve =>
          chrome.runtime.sendMessage({ action: 'READ_CURRENT_TAB_PAGE', maxWords: 1200 }, r => {
            chrome.runtime.lastError;
            resolve(r || { error: 'No response from background' });
          })
        );

        if (resp.error || !resp.content) {
          throw new AskError(`$ask --page: could not read tab — ${resp.error || 'empty response'}. Try refreshing the page.`);
        }

        const { title, url, text, wordCount } = resp.content;
        fullPrompt =
          `The user asked: "${prompt}"\n\n` +
          `Current page — "${title}" (${url})\n` +
          `Content (~${wordCount} words):\n${text}\n\n` +
          `Answer the user's question using the page content above. Be concise and specific.`;
        ctx.log(`$ask --page: read "${title}" (~${wordCount} words)`);
      }

      // ── Chat mode (default) ───────────────────────────────────────────────
      // Stateless: no memory in, no memory saved, no chat history.
      ctx.log(`$ask: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);

      const SYSTEM = `You are ORBIT — direct, slightly witty, genuinely helpful. A companion, not a bot.
Personality rules:
- Be concise. No preamble, no filler, no "Great question!".
- Use markdown only when it genuinely helps (code blocks for code, lists for actual lists).
- Never start with "I" as the first word.
- Contractions. Sound human.
- Never mention being an AI or an assistant.`;

      const USER_TMPL = (msg) =>
        `${msg}\n\nRespond. If this question needs internet research to answer accurately, set needsResearch to true.\n` +
        `Return JSON:\n{ "response": "string", "needsResearch": false, "researchQuery": "string|null" }`;

      // Direct Groq call (bypass app.js — no memory, no history, no UI side-effects)
      const { getConfig } = await import('../../services/settings.js').catch(() => ({}));
      if (!getConfig) throw new AskError('$ask: settings service not available');
      const cfg = await getConfig();
      if (!cfg?.groqApiKey) throw new ApiKeyError('$ask: No Groq API key — add it in Settings.');

      const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

      const callGroq = async (systemPrompt, userPrompt) => {
        const body = {
          model:                 cfg.ai?.model || 'openai/gpt-oss-20b',
          temperature:           cfg.ai?.temperature ?? 0.7,
          max_completion_tokens: cfg.ai?.max_completion_tokens || 1000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
          response_format: { type: 'json_object' },
        };
        const r = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.groqApiKey}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new ApiError(`Groq ${r.status}: ${await r.text()}`);
        const data = await r.json();
        const raw  = data.choices?.[0]?.message?.content;
        if (!raw) throw new ApiError('Empty response from Groq');
        try { return JSON.parse(raw); }
        catch { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
      };

      let result = await callGroq(SYSTEM, USER_TMPL(fullPrompt));

      // Auto-research if the AI says it needs it
      if (result.needsResearch && result.researchQuery) {
        ctx.log(`$ask: researching "${result.researchQuery}"…`);
        try {
          const researchData = await research(result.researchQuery);
          const ctx2 = formatResearchContext(researchData);
          const refined = await callGroq(
            SYSTEM,
            `Question: ${fullPrompt}\n\nResearch:\n${ctx2}\n\nAnswer based on the research above. Cite sources where relevant.\nReturn JSON: { "response": "string", "needsResearch": false, "researchQuery": null }`
          );
          result.response = refined.response;
          ctx.log('$ask: research complete');
        } catch (e) {
          ctx.log(`$ask: research failed (${e.message}), using original answer`);
        }
      }

      return String(result.response || '');
    },
  });

  // ── COMPANION COMMANDS ────────────────────────────────────────────────────

  registry.register({
    name: 'say',
    description: 'Speak text through Orbit\'s TTS and animate the mouth. Use --voice N to pick a voice by index from voiceList.',
    usage: 'say "Hello"\nsay --voice 2 "Hello with a different voice"',
    args: [{ name: 'text', type: 'string', required: true }],
    builtin: true,
    async execute(ctx, args, namedArgs) {
      const text = String(args[0] ?? '');
      // --voice N  picks a voice by index (as shown by voiceList)
      const voiceIndex = namedArgs.voice != null ? parseInt(namedArgs.voice, 10) : null;
      await ctx.orbit.say(text, ctx.signal, voiceIndex);
      return text;
    },
  });

  registry.register({
    name: 'voiceList',
    aliases: ['listVoices', 'voices'],
    description: 'List all available TTS voices with their index numbers.',
    usage: 'voiceList;\n# Then use: say --voice 2 "text"',
    builtin: true,
    async execute(ctx) {
      // Ask the sidepanel to enumerate voices and log them
      await ctx.orbit.listVoices(ctx.log.bind(ctx));
      return null;
    },
  });

  registry.register({
    name: 'shakeOrbit',
    aliases: ['shake'],
    description: 'Shake the Orbit companion.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.shake(); return null; },
  });

  registry.register({
    name: 'rollOrbit',
    aliases: ['roll'],
    description: 'Make Orbit do a spin roll.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.roll(); return null; },
  });

  registry.register({
    name: 'closeOrbitEyes',
    aliases: ['closeEyes'],
    description: 'Close Orbit\'s eyes.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.closeEyes(); return null; },
  });

  registry.register({
    name: 'openOrbitEyes',
    aliases: ['openEyes'],
    description: 'Open Orbit\'s eyes.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.openEyes(); return null; },
  });

  registry.register({
    name: 'look',
    description: 'Make Orbit look in a direction. 0-360 degrees.',
    usage: 'look 180',
    args: [{ name: 'degrees', type: 'number', required: true }],
    builtin: true,
    async execute(ctx, args) {
      const deg = parseFloat(args[0] ?? 0);
      await ctx.orbit.look(deg);
      return deg;
    },
  });

  registry.register({
    name: 'openMouth',
    description: 'Open Orbit\'s mouth.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.openMouth(); return null; },
  });

  registry.register({
    name: 'closeMouth',
    description: 'Close Orbit\'s mouth.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.closeMouth(); return null; },
  });

  registry.register({
    name: 'frownFace',
    aliases: ['frown'],
    description: 'Set Orbit\'s face to a frown.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.setFace('concerned'); return null; },
  });

  registry.register({
    name: 'sadFace',
    aliases: ['sad'],
    description: 'Set Orbit\'s face to a sad expression.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.setFace('sad'); return null; },
  });

  registry.register({
    name: 'happyFace',
    aliases: ['happy'],
    description: 'Set Orbit\'s face to a happy expression.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.setFace('happy'); return null; },
  });

  registry.register({
    name: 'hide',
    description: 'Hide the Orbit companion.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.hide(); return null; },
  });

  registry.register({
    name: 'showBot',
    aliases: ['show', 'showOrbit'],
    description: 'Show the Orbit companion.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.show(); return null; },
  });

  registry.register({
    name: 'cry',
    description: 'Make Orbit cry.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.cry(); return null; },
  });

  registry.register({
    name: 'laugh',
    description: 'Make Orbit laugh.',
    builtin: true,
    async execute(ctx) { await ctx.orbit.laugh(); return null; },
  });

  registry.register({
    name: 'move',
    description: 'Move the Orbit companion to viewport coordinates.',
    usage: 'move 100 50',
    args: [
      { name: 'x', type: 'number', required: true },
      { name: 'y', type: 'number', required: true },
    ],
    builtin: true,
    async execute(ctx, args) {
      const x = parseFloat(args[0] ?? 0);
      const y = parseFloat(args[1] ?? 0);
      await ctx.orbit.move(x, y);
      return { x, y };
    },
  });


  // ── STRING UTILITIES ──────────────────────────────────────────────────────

  registry.register({
    name: 'split',
    description: 'Split a string by a delimiter. Returns an array.',
    usage: 'split "," "red,green,blue"',
    args: [
      { name: 'delimiter', type: 'string', required: true },
      { name: 'str', type: 'string', required: true },
    ],
    builtin: true,
    async execute(ctx, args) {
      const delim = String(args[0]);
      const str   = String(args[1] ?? '');
      return str.split(delim);
    },
  });

  registry.register({
    name: 'join',
    description: 'Join an array with a delimiter. Returns a string.',
    usage: 'join "," {$colors}',
    builtin: true,
    async execute(ctx, args) {
      const delim = String(args[0] ?? '');
      const arr   = args[1];
      if (!Array.isArray(arr)) return String(arr ?? '');
      return arr.join(delim);
    },
  });

  registry.register({
    name: 'length',
    description: 'Return the length of a string or array.',
    usage: 'length {$colors}',
    builtin: true,
    async execute(ctx, args) {
      const val = args[0];
      if (Array.isArray(val)) return val.length;
      if (typeof val === 'string') return val.length;
      if (val == null) return 0;
      return String(val).length;
    },
  });

  registry.register({
    name: 'trim',
    description: 'Trim whitespace from a string.',
    usage: 'trim "  hello  "',
    builtin: true,
    async execute(ctx, args) { return String(args[0] ?? '').trim(); },
  });

  registry.register({
    name: 'lowercase',
    aliases: ['toLower', 'lower'],
    description: 'Convert string to lowercase.',
    builtin: true,
    async execute(ctx, args) { return String(args[0] ?? '').toLowerCase(); },
  });

  registry.register({
    name: 'uppercase',
    aliases: ['toUpper', 'upper'],
    description: 'Convert string to uppercase.',
    builtin: true,
    async execute(ctx, args) { return String(args[0] ?? '').toUpperCase(); },
  });

  registry.register({
    name: 'replace',
    description: 'Replace occurrences of a pattern in a string.',
    usage: 'replace "old" "new" "old value"',
    builtin: true,
    async execute(ctx, args) {
      const search  = String(args[0] ?? '');
      const replace = String(args[1] ?? '');
      const str     = String(args[2] ?? '');
      return str.split(search).join(replace);
    },
  });

  registry.register({
    name: 'contains',
    description: 'Check if a string contains a substring. Returns boolean.',
    usage: 'contains "orbit" "Orbit automation"',
    builtin: true,
    async execute(ctx, args) {
      const needle   = String(args[0] ?? '');
      const haystack = String(args[1] ?? '');
      return haystack.toLowerCase().includes(needle.toLowerCase());
    },
  });

  // ── VARIABLE UTILITIES ────────────────────────────────────────────────────

  registry.register({
    name: 'getVar',
    aliases: ['get-var'],
    description: 'Retrieve the value of a variable (by name string).',
    usage: 'getVar name',
    builtin: true,
    async execute(ctx, args) {
      // This is mostly useful for debugging; normal var access uses {$name}
      const name = String(args[0] ?? '');
      ctx.log(`getVar ${name}`);
      return name; // The interpreter's VAR_REF handles actual resolution
    },
  });

  // ── DEBUG / UTILITY ───────────────────────────────────────────────────────

  registry.register({
    name: 'log',
    aliases: ['print', 'debug'],
    description: 'Log a value to the script console.',
    usage: 'log "value"',
    builtin: true,
    async execute(ctx, args) {
      const val = args[0];
      ctx.log(typeof val === 'object' ? JSON.stringify(val) : String(val ?? ''));
      return val;
    },
  });

  registry.register({
    name: 'assert',
    description: 'Throw an error if condition is falsy.',
    usage: 'assert {$found} "Expected element to be found"',
    builtin: true,
    async execute(ctx, args) {
      const cond = args[0];
      const msg  = args[1] || 'Assertion failed';
      if (!cond && cond !== 0 && cond !== '') {
        // Check explicitly for falsy
        const isFalsy = (cond === false || cond === null || cond === undefined || cond === 0 || cond === '');
        if (isFalsy) throw new AssertionError(String(msg));
      }
      return true;
    },
  });
}
