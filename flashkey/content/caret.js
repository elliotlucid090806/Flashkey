/*
 * FlashKey — content: element & caret helpers, one instance per window.
 * Reads the few characters before the caret in <input>/<textarea> and in
 * contenteditable trees (walking inline nodes only, never across blocks).
 */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});
  const ZW_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/;
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TD', 'TH', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'HR', 'DL', 'DT', 'DD']);

  function create(win) {
    const doc = win.document;
    function targetOf(e) {
      const p = e.composedPath ? e.composedPath() : null;
      return (p && p[0]) || e.target;
    }
    function deepActive(doc) {
      let a = doc.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a;
    }
    function editingHost(el) {
      let h = el;
      while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
      return h;
    }
    function fieldInfo(el) {
      return {
        tag: el.tagName,
        type: el.tagName === 'INPUT' ? el.type : '',
        autocomplete: el.getAttribute('autocomplete'),
        name: el.getAttribute('name'),
        id: el.id,
        inputmode: el.getAttribute('inputmode'),
        maxLength: el.maxLength,
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder')
      };
    }
    function getSel(el) {
      const root = el && el.getRootNode ? el.getRootNode() : null;
      if (root && root !== doc && typeof root.getSelection === 'function') {
        const s = root.getSelection();
        if (s) return s;
      }
      return win.getSelection();
    }
    function inputCaret(el) {
      let s = null;
      let e = null;
      try { s = el.selectionStart; e = el.selectionEnd; } catch (_) { s = null; }
      if (s == null) return { caret: el.value.length, selectable: false }; // e.g. type=email
      if (s !== e) return null;
      return { caret: s, selectable: true };
    }
    function inputContext(el, n) {
      const c = inputCaret(el);
      if (!c) return null;
      return { text: el.value.slice(Math.max(0, c.caret - n), c.caret), caret: c.caret, selectable: c.selectable };
    }
    function isBoundary(n) {
      if (n.nodeType !== 1) return false;
      return n.tagName === 'BR' || n.tagName === 'IMG' || BLOCK_TAGS.has(n.tagName) || n.getAttribute('contenteditable') === 'false';
    }
    function lastLeaf(n) {
      while (n && n.nodeType === 1 && !isBoundary(n) && n.lastChild) n = n.lastChild;
      return n;
    }
    function prevLeaf(n, host) {
      for (;;) {
        if (n === host) return null;
        let p = n.previousSibling;
        if (p) {
          for (;;) {
            if (p.nodeType === 1 && isBoundary(p)) return null;
            if (p.nodeType === 3) return p;
            if (p.lastChild) { p = p.lastChild; continue; }
            break;
          }
          n = p;
          continue;
        }
        n = n.parentNode;
        if (!n || n === host || (n.nodeType === 1 && isBoundary(n))) return null;
      }
    }
    function ceContext(host, n) {
      const sel = getSel(host);
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
      const caretNode = sel.focusNode;
      const caretOffset = sel.focusOffset;
      if (!caretNode || !(host === caretNode || host.contains(caretNode))) return null;
      let node = caretNode;
      let end = caretOffset;
      if (node.nodeType !== 3) {
        const child = node.childNodes[end - 1];
        if (!child) return { text: '', chars: [], caretNode, caretOffset };
        node = lastLeaf(child);
        if (!node || node.nodeType !== 3) return { text: '', chars: [], caretNode, caretOffset };
        end = node.data.length;
      }
      const chars = [];
      let cur = node;
      while (cur && chars.length < n) {
        if (cur.nodeType === 3) {
          const d = cur.data;
          for (let i = Math.min(end, d.length) - 1; i >= 0 && chars.length < n; i--) {
            const ch = d[i];
            if (ZW_RE.test(ch)) continue;
            chars.push({ node: cur, i, ch: ch === ' ' ? ' ' : ch });
          }
        }
        cur = prevLeaf(cur, host);
        end = cur && cur.nodeType === 3 ? cur.data.length : 0;
      }
      chars.reverse();
      return { text: chars.map((c) => c.ch).join(''), chars, caretNode, caretOffset };
    }
    /**
     * Up to n visible characters before a collapsed caret inside a contenteditable host are read by
     * ceContext() (zero-width chars skipped, &nbsp; read as space).
     */

    /** Locate the text to replace (removeLen chars before the caret). */
    function capture(job) {
      const { el, kind, removeLen } = job;
      if (kind === 'input') {
        const c = inputCaret(el);
        if (!c) {
          if (removeLen) return null;
          return { start: el.selectionStart, end: el.selectionEnd, selectable: true, expect: '' };
        }
        const start = c.caret - removeLen;
        if (start < 0) return null;
        return { start, end: c.caret, selectable: c.selectable, expect: el.value.slice(start, c.caret) };
      }
      const sel = getSel(el);
      if (!sel || !sel.rangeCount) return null;
      if (!removeLen) {
        const range = sel.getRangeAt(0).cloneRange();
        if (!(el === range.commonAncestorContainer || el.contains(range.commonAncestorContainer))) return null;
        const caretRange = range.cloneRange();
        caretRange.collapse(false);
        return { range, caretRange, expect: '' };
      }
      const ctx = ceContext(el, removeLen);
      if (!ctx || ctx.chars.length < removeLen) return null;
      const first = ctx.chars[ctx.chars.length - removeLen];
      const range = doc.createRange();
      range.setStart(first.node, first.i);
      range.setEnd(ctx.caretNode, ctx.caretOffset);
      const caretRange = doc.createRange();
      caretRange.setStart(ctx.caretNode, ctx.caretOffset);
      caretRange.collapse(true);
      return { range, caretRange, expect: ctx.text.slice(-removeLen) };
    }

    return { targetOf, deepActive, editingHost, fieldInfo, getSel, inputCaret, inputContext, ceContext, capture };
  }

  FK.caret = { create, BLOCK_TAGS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
