/*
 * FlashKey — strict HTML sanitizer for rich-text snippets (needs a DOM).
 *
 * Allow-list only: formatting tags survive, everything else is unwrapped
 * (text kept) or dropped entirely (script/style/iframe/...). No attributes are
 * kept except a vetted href on <a>, and no inline styles — so inserted text
 * always inherits the destination editor's own font, size and colour.
 */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});

  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'CODE', 'PRE', 'SPAN', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'SUB', 'SUP']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'OPTION', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'CANVAS', 'BASE', 'TITLE', 'HEAD', 'FRAME', 'FRAMESET', 'PORTAL', 'APPLET', 'DIALOG', 'SLOT']);
  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
  const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

  let outDoc = null;
  function out() {
    if (!outDoc) outDoc = document.implementation.createHTMLDocument('');
    return outDoc;
  }

  function copyClean(src, dst, depth) {
    if (depth > 64) return;
    const d = out();
    for (const node of Array.from(src.childNodes)) {
      if (node.nodeType === 3) { dst.appendChild(d.createTextNode(node.data)); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      if (!ALLOWED.has(tag)) { copyClean(node, dst, depth + 1); continue; }
      const el = d.createElement(tag.toLowerCase());
      if (tag === 'A') {
        const href = (node.getAttribute('href') || '').trim();
        if (SAFE_HREF.test(href)) {
          el.setAttribute('href', href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      }
      copyClean(node, el, depth + 1);
      dst.appendChild(el);
    }
  }

  function parse(html) {
    return new DOMParser().parseFromString('<!doctype html><body>' + String(html || ''), 'text/html').body;
  }

  /** Returns a safe HTML string. */
  function sanitizeHTML(html) {
    const container = out().createElement('div');
    copyClean(parse(html), container, 0);
    return container.innerHTML;
  }

  /** Readable plain text from HTML, keeping line structure. */
  function htmlToText(html) {
    let text = '';
    const walk = (node) => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) { text += n.data.replace(/[\t\n\r ]+/g, ' '); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toUpperCase();
        if (DROP.has(tag)) continue;
        if (tag === 'BR') { text += '\n'; continue; }
        const block = BLOCK.has(tag);
        if (block && text && !text.endsWith('\n')) text += '\n';
        if (tag === 'LI') text += '• ';
        walk(n);
        if (block && !text.endsWith('\n')) text += '\n';
      }
    };
    walk(parse(html));
    return text.replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  /** Plain text -> minimal HTML (paragraph per line) for rich editors' paste handlers. */
  function textToHTML(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return String(text).split('\n').map((line) => '<p>' + (line ? esc(line) : '<br>') + '</p>').join('');
  }

  FK.sanitize = { sanitizeHTML, htmlToText, textToHTML, BLOCK };
})(typeof globalThis !== 'undefined' ? globalThis : this);
