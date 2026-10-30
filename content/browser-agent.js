// ORBIT — Browser Agent Content Script v3
// Vision-first: every interaction is preceded by real page inspection.

(function () {
  'use strict';

  if (window.__orbitAgentLoaded) return;
  window.__orbitAgentLoaded = true;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Deep page snapshot — what the AI actually sees ────────────────────────
  // Returns structured data about every interactive/readable element

  function snapshot() {
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    // Collect links — walk shadow roots too for custom elements
    const links = [];
    function collectLinks(root) {
      const anchors = root.querySelectorAll('a[href]');
      for (const a of anchors) {
        if (!visible(a)) continue;
        // Get text from the element and its shadow/custom-element children
        const text = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim();
        if (!text || text.length < 2) continue;
        links.push({
          text: text.slice(0, 120),
          href: a.href,
          id: a.id || '',
          cls: (a.className || '').toString().slice(0, 40),
        });
      }
      // Walk into custom elements (YouTube uses these heavily)
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collectLinks(el.shadowRoot);
      }
    }
    collectLinks(document);

    // Deduplicate links by text
    const seenLinkText = new Set();
    const uniqueLinks = links.filter(l => {
      const key = l.text.toLowerCase().trim();
      if (seenLinkText.has(key)) return false;
      seenLinkText.add(key);
      return true;
    });

    // Buttons
    const buttons = [];
    for (const el of document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')) {
      if (!visible(el)) continue;
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      if (!text) continue;
      buttons.push({
        text: text.slice(0, 80),
        disabled: !!el.disabled,
        id: el.id || '',
      });
    }

    // Inputs
    const inputs = [];
    for (const el of document.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
      if (!visible(el)) continue;
      const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      inputs.push({
        tag:   el.tagName.toLowerCase(),
        type:  el.type || (el.isContentEditable ? 'contenteditable' : ''),
        ph:    el.placeholder || '',
        name:  el.name || '',
        id:    el.id || '',
        label: (labelEl?.textContent || el.getAttribute('aria-label') || '').trim(),
        value: (el.value || el.textContent || '').slice(0, 60),
      });
    }

    // Headings and key text blocks (helps AI understand page structure)
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(visible)
      .map(h => h.textContent.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 8);

    return {
      url:      location.href,
      title:    document.title,
      headings,
      inputs:   inputs.slice(0, 20),
      buttons:  buttons.slice(0, 25),
      links:    uniqueLinks.slice(0, 50),
      scroll: {
        y:      window.scrollY,
        height: document.body.scrollHeight,
        viewH:  window.innerHeight,
      },
    };
  }

  // ── Find element with fallback strategies ─────────────────────────────────

  function findEl(target) {
    if (!target) return null;
    const t = String(target).trim();
    const tl = t.toLowerCase();

    const strategies = [
      // CSS selector (if it looks like one)
      () => { if (t.startsWith('#') || t.startsWith('.') || t.startsWith('[')) return document.querySelector(t); },
      // Exact placeholder
      () => document.querySelector(`[placeholder="${t}"]`),
      // Partial placeholder
      () => [...document.querySelectorAll('[placeholder]')].find(e => e.placeholder.toLowerCase().includes(tl)),
      // aria-label exact
      () => document.querySelector(`[aria-label="${t}"]`),
      // aria-label partial
      () => [...document.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label').toLowerCase().includes(tl)),
      // label for=
      () => {
        for (const lbl of document.querySelectorAll('label')) {
          if (lbl.textContent.toLowerCase().includes(tl)) {
            const inp = lbl.htmlFor ? document.getElementById(lbl.htmlFor) : lbl.querySelector('input,select,textarea');
            if (inp) return inp;
          }
        }
      },
      // name attr
      () => document.querySelector(`[name="${t}"]`),
      // id attr
      () => document.getElementById(t) || [...document.querySelectorAll('[id]')].find(e => e.id.toLowerCase().includes(tl)),
      // button/link text
      () => [...document.querySelectorAll('button,[role="button"],a')].find(e => {
        const txt = (e.textContent || e.getAttribute('aria-label') || '').trim().toLowerCase();
        return txt === tl || txt.includes(tl);
      }),
    ];

    for (const fn of strategies) {
      try { const el = fn(); if (el) return el; } catch (_) {}
    }
    return null;
  }

  // Find best matching link — walks shadow roots
  function findLink(text) {
    const tl = text.toLowerCase().trim();
    const all = [];

    function collect(root) {
      for (const a of root.querySelectorAll('a[href]')) {
        const txt = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim();
        if (!txt) continue;
        const score = txt.toLowerCase() === tl ? 0
          : txt.toLowerCase().startsWith(tl) ? 1
          : txt.toLowerCase().includes(tl) ? 2 : 99;
        if (score < 99) all.push({ el: a, txt, score });
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    }
    collect(document);

    all.sort((a, b) => a.score - b.score || a.txt.length - b.txt.length);
    return all[0]?.el || null;
  }

  function findButton(text) {
    const tl = text.toLowerCase().trim();
    const sels = 'button,[role="button"],input[type="submit"],input[type="button"]';
    const all = [...document.querySelectorAll(sels)].map(el => {
      const txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      const score = txt.toLowerCase() === tl ? 0 : txt.toLowerCase().includes(tl) ? 1 : 99;
      return { el, txt, score };
    }).filter(x => x.score < 99).sort((a,b) => a.score - b.score || a.txt.length - b.txt.length);
    return all[0]?.el || null;
  }

  function highlight(el) {
    if (!el) return;
    const prev = el.style.outline;
    el.style.outline = '3px solid #5b8fff';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; }, 1500);
  }

  async function clickEl(el) {
    if (!el) return false;
    highlight(el);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);
    el.focus();
    // Try multiple click methods for SPA compatibility
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    await sleep(100);
    return true;
  }

  // ── Type into field ───────────────────────────────────────────────────────

  async function typeInto(el, text, clear = true) {
    el.scrollIntoView({ block: 'center' });
    el.focus();
    await sleep(100);

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (clear) {
        const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(30);
      }
      for (const char of text) {
        const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, el.value + char); else el.value += char;
        el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true }));
        await sleep(15);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));

    } else if (el.isContentEditable) {
      el.focus();
      await sleep(80);
      if (clear) {
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        await sleep(40);
        document.execCommand('delete', false, null);
        await sleep(40);
      }
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  // ── Wait for element ──────────────────────────────────────────────────────

  async function waitFor(target, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = target.startsWith('#') || target.startsWith('.') || target.startsWith('[')
        ? document.querySelector(target)
        : findEl(target);
      if (el) return el;
      await sleep(350);
    }
    return null;
  }

  // ── Scroll ────────────────────────────────────────────────────────────────

  function doScroll(direction, amount = 400) {
    if (direction === 'top')    { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (direction === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return; }
    window.scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'smooth' });
  }

  // ── Message handler ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handle = async () => {
      switch (msg.action) {

        case 'PING':
          return { ok: true, url: location.href, title: document.title };

        // Vision snapshot — gives AI real page state
        case 'AGENT_SNAPSHOT':
          return { ok: true, data: snapshot() };

        // Legacy inspect alias
        case 'AGENT_INSPECT':
          return { ok: true, data: snapshot() };

        // ── Paged text snapshot — splits page body into viewport-sized chunks ──
        // Solves the "scroll forever" problem: instead of blind scrolling, the
        // agent can request any chunk of the page by index.
        // Returns { ok, chunk, chunkIndex, totalChunks, url, title, scrolled }
        // scrolled: true if we scrolled the browser to that chunk's position.
        case 'AGENT_PAGE_CHUNK': {
          const CHUNK_VIEWPORT_H = window.innerHeight * 0.9; // chars ≈ viewport
          const chunkIndex = typeof msg.chunkIndex === 'number' ? msg.chunkIndex : 0;

          // Extract full visible text from the page in DOM order
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                const s = window.getComputedStyle(p);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
                  return NodeFilter.FILTER_REJECT;
                }
                const tag = p.tagName.toLowerCase();
                if (['script','style','noscript','head'].includes(tag)) {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          const lines = [];
          let node;
          while ((node = walker.nextNode())) {
            const t = node.textContent.replace(/\s+/g, ' ').trim();
            if (t.length > 2) lines.push(t);
          }

          // Also collect headings + links for structure at the start of each chunk
          const headings = [...document.querySelectorAll('h1,h2,h3')]
            .filter(h => {
              const r = h.getBoundingClientRect();
              return r.width > 0;
            })
            .map(h => ({ text: h.textContent.trim().slice(0, 100), y: h.getBoundingClientRect().top + window.scrollY }));

          // Split into chunks by approximate character count (~1800 chars each)
          const CHUNK_SIZE = 1800;
          const fullText = lines.join(' ');
          const chunks = [];
          for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
            chunks.push(fullText.slice(i, i + CHUNK_SIZE));
          }
          if (chunks.length === 0) chunks.push('(Page appears to be empty or has no readable text)');

          const safeIdx = Math.max(0, Math.min(chunkIndex, chunks.length - 1));
          const chunkText = chunks[safeIdx];

          // Scroll the browser to the chunk's position so the user can see it
          const scrollTarget = (safeIdx / Math.max(chunks.length - 1, 1)) * document.body.scrollHeight;
          window.scrollTo({ top: scrollTarget, behavior: 'smooth' });

          // Find headings that fall within this chunk's scroll band
          const scrollBandStart = scrollTarget;
          const scrollBandEnd   = scrollTarget + window.innerHeight * 2;
          const chunkHeadings   = headings
            .filter(h => h.y >= scrollBandStart - 100 && h.y <= scrollBandEnd)
            .map(h => h.text)
            .slice(0, 5);

          // Collect links visible near this scroll position
          const visibleLinks = [...document.querySelectorAll('a[href]')]
            .filter(a => {
              const r = a.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) return false;
              const absY = r.top + window.scrollY;
              return absY >= scrollBandStart - 50 && absY <= scrollBandEnd;
            })
            .slice(0, 15)
            .map(a => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.href }))
            .filter(l => l.text.length > 2);

          return {
            ok: true,
            chunkIndex: safeIdx,
            totalChunks: chunks.length,
            chunk: chunkText,
            headings: chunkHeadings,
            links: visibleLinks,
            url: location.href,
            title: document.title,
            scrolled: true,
          };
        }

        case 'AGENT_CLICK': {
          const el = findEl(msg.target);
          if (!el) return { ok: false, error: `No element matching: "${msg.target}"` };
          await clickEl(el);
          return { ok: true, found: (el.textContent || el.value || el.tagName).trim().slice(0, 80) };
        }

        case 'AGENT_CLICK_LINK': {
          const el = findLink(msg.text);
          if (!el) return { ok: false, error: `No link matching: "${msg.text}"` };
          await clickEl(el);
          return { ok: true, found: el.textContent.trim().slice(0, 100) };
        }

        case 'AGENT_CLICK_BUTTON': {
          const el = findButton(msg.text);
          if (!el) return { ok: false, error: `No button matching: "${msg.text}"` };
          await clickEl(el);
          return { ok: true, found: (el.textContent || el.value || '').trim().slice(0, 80) };
        }

        case 'AGENT_TYPE': {
          let el = findEl(msg.target);
          if (!el) el = await waitFor(msg.target, 3000);
          if (!el) return { ok: false, error: `Field not found: "${msg.target}"` };
          await typeInto(el, msg.text, msg.clear !== false);
          return { ok: true };
        }

        case 'AGENT_CLEAR': {
          const el = findEl(msg.target);
          if (!el) return { ok: false, error: `Field not found: "${msg.target}"` };
          if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          else if (el.isContentEditable) el.innerHTML = '';
          return { ok: true };
        }

        case 'AGENT_SELECT': {
          const el = findEl(msg.target);
          if (!el || el.tagName !== 'SELECT') return { ok: false, error: `Dropdown not found: "${msg.target}"` };
          const t = msg.option.toLowerCase();
          const opt = [...el.options].find(o => o.text.toLowerCase().includes(t));
          if (!opt) return { ok: false, error: `Option "${msg.option}" not found in "${msg.target}"` };
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selected: opt.text };
        }

        case 'AGENT_RADIO': {
          const t = msg.option.toLowerCase();
          for (const r of document.querySelectorAll('input[type="radio"]')) {
            const lbl = document.querySelector(`label[for="${r.id}"]`);
            const txt = (lbl?.textContent || r.value || '').toLowerCase();
            if (txt.includes(t)) {
              r.checked = true;
              r.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, selected: txt };
            }
          }
          return { ok: false, error: `Radio "${msg.option}" not found` };
        }

        case 'AGENT_SCROLL':
          doScroll(msg.direction || 'down', msg.amount || 400);
          return { ok: true };

        case 'AGENT_PRESS_KEY': {
          const el = msg.target ? (findEl(msg.target) || document.activeElement) : document.activeElement;
          const target = el || document.body;
          ['keydown','keypress','keyup'].forEach(type =>
            target.dispatchEvent(new KeyboardEvent(type, { key: msg.key, code: msg.key, bubbles: true, cancelable: true }))
          );
          return { ok: true };
        }

        case 'AGENT_WAIT':
          await sleep(Math.min(msg.ms || 1000, 5000));
          return { ok: true };

        case 'AGENT_WAIT_FOR': {
          const el = await waitFor(msg.target, msg.timeout || 6000);
          return { ok: true, found: !!el };
        }

        case 'AGENT_GET_TEXT': {
          const el = msg.target ? findEl(msg.target) : document.body;
          if (!el) return { ok: false, error: 'Element not found' };
          return { ok: true, text: el.textContent.trim().slice(0, 500) };
        }

        // ── Script Engine Actions ─────────────────────────────────────────

        case 'AGENT_CLICK': {
          // Enhanced: support targetType routing
          const targetType = msg.targetType || 'text';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);
          if (!el) return { ok: false, error: `No element matching: "${msg.target}" (type: ${targetType})` };
          await clickEl(el);
          return { ok: true, data: { clicked: (el.textContent || el.value || el.tagName).trim().slice(0, 80) } };
        }

        case 'AGENT_RIGHT_CLICK': {
          const targetType = msg.targetType || 'text';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);
          if (!el) return { ok: false, error: `No element for right-click: "${msg.target}"` };
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
          return { ok: true, data: null };
        }

        case 'AGENT_FOCUS': {
          const targetType = msg.targetType || 'text';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);
          if (!el) return { ok: false, error: `No element to focus: "${msg.target}"` };
          el.focus();
          return { ok: true, data: null };
        }

        case 'AGENT_PRESS': {
          const key = msg.key || '';
          // Support combos like Control+L
          const parts  = key.split('+');
          const mainKey = parts[parts.length - 1];
          const mods = {
            ctrlKey:  parts.some(p => p.toLowerCase() === 'control' || p.toLowerCase() === 'ctrl'),
            shiftKey: parts.some(p => p.toLowerCase() === 'shift'),
            altKey:   parts.some(p => p.toLowerCase() === 'alt'),
            metaKey:  parts.some(p => p.toLowerCase() === 'meta' || p.toLowerCase() === 'command'),
          };
          const target = document.activeElement || document.body;
          ['keydown', 'keypress', 'keyup'].forEach(type =>
            target.dispatchEvent(new KeyboardEvent(type, { key: mainKey, code: mainKey, bubbles: true, cancelable: true, ...mods }))
          );
          return { ok: true, data: null };
        }

        case 'AGENT_GET': {
          // Retrieve data from a page element
          const retrieval  = msg.retrieval || 'text';
          const targetType = msg.targetType || 'selector';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);

          if (retrieval === 'count') {
            const sel = targetType === 'selector' ? msg.target : null;
            const count = sel ? document.querySelectorAll(sel).length : (el ? 1 : 0);
            return { ok: true, data: count };
          }
          if (retrieval === 'exists') return { ok: true, data: !!el };
          if (!el) return { ok: false, error: `Element not found: "${msg.target}"` };
          if (retrieval === 'visible') {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return { ok: true, data: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' };
          }

          let result;
          switch (retrieval) {
            case 'text':        result = el.textContent?.trim(); break;
            case 'innerText':   result = el.innerText?.trim(); break;
            case 'textContent': result = el.textContent; break;
            case 'innerHTML':   result = el.innerHTML; break;
            case 'outerHTML':   result = el.outerHTML; break;
            case 'value':       result = el.value; break;
            case 'attribute':   result = el.getAttribute(msg.attribute); break;
            case 'id':          result = el.id; break;
            case 'class':       result = el.className; break;
            case 'href':        result = el.href || el.getAttribute('href'); break;
            case 'src':         result = el.src || el.getAttribute('src'); break;
            case 'title':       result = el.title; break;
            case 'tagName':     result = el.tagName.toLowerCase(); break;
            default:            result = el.getAttribute(retrieval);
          }
          return { ok: true, data: result ?? null };
        }

        case 'AGENT_FIND_TEXT': {
          const needle = (msg.text || '').toLowerCase().trim();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent.toLowerCase().includes(needle)) {
              const el = node.parentElement;
              if (!el) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              const st = window.getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden') continue;
              return { ok: true, data: { found: true, text: el.textContent.trim().slice(0, 200), tag: el.tagName.toLowerCase() } };
            }
          }
          return { ok: true, data: { found: false } };
        }

        case 'AGENT_SEE_TEXT': {
          const needle = (msg.text || '').toLowerCase().trim();
          const body = document.body?.innerText?.toLowerCase() || '';
          return { ok: true, data: body.includes(needle) };
        }

        case 'AGENT_TEXT_CONTAIN': {
          const needle = (msg.text || '').toLowerCase().trim();
          const body = document.body?.innerText?.toLowerCase() || '';
          return { ok: true, data: body.includes(needle) };
        }

        case 'AGENT_GET_POS': {
          const targetType = msg.targetType || 'text';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);
          if (!el) return { ok: false, error: `Element not found for getPos: "${msg.target}"` };
          const r = el.getBoundingClientRect();
          return { ok: true, data: {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width:   Math.round(r.width),
            height:  Math.round(r.height),
            centerX: Math.round(r.left + r.width / 2),
            centerY: Math.round(r.top  + r.height / 2),
          }};
        }

        case 'AGENT_DRAG': {
          const targetType = msg.targetType || 'text';
          let el = null;
          if (targetType === 'selector') el = document.querySelector(msg.target);
          else if (targetType === 'id')  el = document.getElementById(msg.target);
          else el = findEl(msg.target);
          if (!el) return { ok: false, error: `Drag source not found: "${msg.target}"` };
          const r = el.getBoundingClientRect();
          const srcX = r.left + r.width / 2, srcY = r.top + r.height / 2;
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: srcX, clientY: srcY }));
          await sleep(80);
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: msg.destX, clientY: msg.destY }));
          await sleep(80);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: msg.destX, clientY: msg.destY }));
          return { ok: true, data: { from: { x: srcX, y: srcY }, to: { x: msg.destX, y: msg.destY } } };
        }

        case 'AGENT_TYPE': {
          // Enhanced type: handles free-form text without requiring a target
          if (msg.target) {
            let el = findEl(msg.target);
            if (!el) el = await waitFor(msg.target, 3000);
            if (!el) return { ok: false, error: `Field not found: "${msg.target}"` };
            await typeInto(el, msg.text, msg.clear !== false);
          } else {
            // Type into focused element
            const el = document.activeElement;
            if (el && ('value' in el || el.isContentEditable)) {
              await typeInto(el, msg.text, false);
            } else {
              // Dispatch key events on body
              for (const ch of (msg.text || '')) {
                document.body.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
                if (msg.speed) await sleep(msg.speed * 1000);
              }
            }
          }
          return { ok: true, data: null };
        }

        default:
          return { ok: false, error: `Unknown: ${msg.action}` };
      }
    };

    handle().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  });

})();
