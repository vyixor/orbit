// ORBIT — Page Reader Content Script
// Extracts clean readable text from any page on demand.
// Runs on all_urls, only activates when messaged.

(function () {
  'use strict';

  function extractPageContent() {
    // Remove noise elements
    const SKIP_TAGS = new Set(['script','style','noscript','nav','footer','header',
      'aside','iframe','svg','canvas','video','audio','form','button','input',
      'select','textarea','meta','link','head']);

    const SKIP_ROLES = new Set(['navigation','banner','complementary','contentinfo',
      'search','form','dialog','alertdialog','menu','menubar','toolbar']);

    function shouldSkip(el) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
      const role = el.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) return true;
      const cls = (el.className || '').toLowerCase();
      const id  = (el.id || '').toLowerCase();
      const noise = ['nav','sidebar','footer','header','menu','cookie','popup',
        'modal','advertisement','ad-','banner','newsletter','subscribe','share',
        'social','comment-form','reply-form'];
      return noise.some(n => cls.includes(n) || id.includes(n));
    }

    // Try to find main content first
    const mainSelectors = [
      'main', 'article', '[role="main"]', '#main-content', '.main-content',
      '.post-content', '.article-body', '.entry-content', '.content',
      '#content', '.story', '.post', '[data-testid="post-container"]',
    ];

    let root = null;
    for (const sel of mainSelectors) {
      const el = document.querySelector(sel);
      if (el) { root = el; break; }
    }
    if (!root) root = document.body;

    // Walk the DOM and collect text
    const lines = [];
    const seen  = new Set();

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t.length > 25 && !seen.has(t)) {
          seen.add(t);
          lines.push(t);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkip(node)) return;

      // Headings get a marker
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const t = node.textContent.trim();
        if (t) lines.push(`\n## ${t}`);
        return;
      }

      for (const child of node.childNodes) walk(child);

      // Add paragraph break after block elements
      if (['p','div','li','tr','blockquote','section'].includes(tag)) {
        if (lines.length && lines[lines.length-1] !== '') lines.push('');
      }
    }

    walk(root);

    // Clean up: collapse multiple blank lines, trim
    const text = lines.join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      title:   document.title,
      url:     window.location.href,
      text,
      wordCount: text.split(/\s+/).length,
    };
  }

  // Smart truncation — keeps beginning and end, summarises middle
  function smartTruncate(text, maxWords = 1200) {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;

    const keepHead = Math.floor(maxWords * 0.6);
    const keepTail = Math.floor(maxWords * 0.3);
    const head = words.slice(0, keepHead).join(' ');
    const tail = words.slice(-keepTail).join(' ');
    const skipped = words.length - keepHead - keepTail;

    return `${head}\n\n[... ${skipped} words omitted to save tokens ...]\n\n${tail}`;
  }

  // Guard: if already injected (tab navigation re-runs script), skip re-init
  if (window.__orbitPageReaderLoaded) return;
  window.__orbitPageReaderLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'READ_PAGE') {
      try {
        const content = extractPageContent();
        const maxWords = msg.maxWords || 1200;
        content.text = smartTruncate(content.text, maxWords);
        sendResponse({ ok: true, content });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }
  });
})();
