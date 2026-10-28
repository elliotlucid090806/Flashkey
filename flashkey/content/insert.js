/*
 * FlashKey — content: the three insertion tiers, one instance per window.
 *   Tier 1  <input>/<textarea>: execCommand('insertText') keeps native undo and fires real
 *           input events (React/Vue/Angular); native value setter + events as a fallback.
 *   Tier 2  contenteditable: select the trigger, let the editor sync its selection, then
 *           insertText / synthetic paste (multi-line, rich) / insertHTML.
 *   {tab}   move to the next field and keep filling.
 */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});

  function create(win, caret, resolveEditable) {
    const doc = win.document;
    const { sanitize, vars } = FK;
    const { getSel } = caret;

    /**
     * Select a range and give the page's editor a chance to mirror it: Lexical,
     * ProseMirror, Quill and Slate copy the DOM selection into their own model on
     * the asynchronous 'selectionchange' event; acting before that would make them
     * insert at a stale position.
     */
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable]:not([contenteditable="false"]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    function setNativeValue(el, value, data) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function insertInput(el, loc, text, cursor) {
      if (el.tagName === 'INPUT') text = text.replace(/\n/g, ' ');
      const before = el.value;
      let ok = false;
      if (loc.selectable) {
        try { el.setSelectionRange(loc.start, loc.end); } catch (_) {}
        try { ok = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete'); } catch (_) { ok = false; }
      }
      const expected = before.slice(0, loc.start) + text + before.slice(loc.end);
      if (!ok || (el.value === before && expected !== before)) {
        if (el.value !== expected) setNativeValue(el, expected, text);
      }
      if (loc.selectable) {
        const caret = loc.start + (cursor == null ? text.length : cursor);
        try { el.setSelectionRange(caret, caret); } catch (_) {}
      }
    }
    function detectEditor(host) {
      if (host.hasAttribute('data-lexical-editor')) return 'lexical';
      if (host.classList.contains('ProseMirror')) return 'prosemirror';
      if (host.hasAttribute('data-slate-editor')) return 'slate';
      if (host.classList.contains('ql-editor')) return 'quill';
      if (host.closest('.DraftEditor-root')) return 'draft';
      if (host.classList.contains('ck-editor__editable') || host.classList.contains('ck-content')) return 'ckeditor';
      if (host.classList.contains('tiptap')) return 'prosemirror';
      return null;
    }
    function selectRange(sel, range) {
      try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
    }
    function dispatchPaste(target, text, html) {
      let dt;
      try {
        dt = new DataTransfer();
        dt.setData('text/plain', text);
        if (html) dt.setData('text/html', html);
      } catch (_) { return false; }
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    function pasteTarget(host, sel) {
      const n = sel && sel.focusNode;
      const el = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
      return el && host.contains(el) ? el : host;
    }
    function selectAndSync(host, range) {
      const sel = getSel(host);
      selectRange(sel, range);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; doc.removeEventListener('selectionchange', onChange, true); setTimeout(() => resolve(sel), 0); };
        const onChange = () => finish();
        doc.addEventListener('selectionchange', onChange, true);
        setTimeout(finish, 40);
      });
    }
    function moveCaretBack(host, n) {
      if (!n || n < 0) return;
      const sel = getSel(host);
      if (!sel || typeof sel.modify !== 'function') return;
      for (let i = 0; i < n; i++) sel.modify('move', 'backward', 'character');
    }
    async function insertCEPlain(host, loc, text, cursor) {
      const sel = await selectAndSync(host, loc.range);
      const back = cursor == null ? 0 : text.length - cursor;
      if (!text.includes('\n')) {
        let ok = false;
        try { ok = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete'); } catch (_) { ok = false; }
        if (!ok) rangeInsert(loc.range, text, sel);
      } else {
        // Multi-line: hand the editor a paste so newlines become paragraphs/line breaks in
        // its own model. No Enter key is ever simulated, so ChatGPT / WhatsApp /
        // Intercom never auto-send. Plain contenteditables fall back to native insertText.
        const handled = dispatchPaste(pasteTarget(host, sel), text, sanitize.textToHTML(text));
        if (!handled) {
          let ok = false;
          try { ok = doc.execCommand('insertText', false, text); } catch (_) { ok = false; }
          if (!ok) rangeInsert(getSel(host).getRangeAt(0), text, sel);
        }
      }
      if (back) { await tick(); moveCaretBack(host, back); }
    }
    async function insertCERich(host, loc, richOut, delimiter) {
      const html = richOut.text;
      const cursor = richOut.cursor;
      const clean = sanitize.sanitizeHTML(html + (delimiter ? vars.escapeHtml(delimiter) : ''));
      const back = cursor == null ? 0 : sanitize.htmlToText(html.slice(cursor)).length + delimiter.length;
      const sel = await selectAndSync(host, loc.range);
      const handled = dispatchPaste(pasteTarget(host, sel), sanitize.htmlToText(clean), clean);
      if (!handled) {
        let ok = false;
        try { ok = doc.execCommand('insertHTML', false, clean); } catch (_) { ok = false; }
        if (!ok) rangeInsert(getSel(host).getRangeAt(0), sanitize.htmlToText(clean), sel);
      }
      if (back) { await tick(); moveCaretBack(host, back); }
    }
    /** Last-resort DOM insertion when execCommand is unavailable (keeps the page usable). */
    function rangeInsert(range, text, sel) {
      try {
        range.deleteContents();
        const node = doc.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selectRange(sel, range);
        const host = node.parentElement;
        if (host) host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch (_) {}
    }
    function visible(n) {
      return !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
    }
    function focusNext(cur) {
      const root = cur.getRootNode ? cur.getRootNode() : doc;
      const all = Array.from((root.querySelectorAll ? root : doc).querySelectorAll(FOCUSABLE))
        .filter((n) => n.tabIndex >= 0 && visible(n) && !(n.parentElement && n.parentElement.isContentEditable));
      let i = all.indexOf(cur);
      if (i < 0) i = all.findIndex((n) => n.contains(cur) || cur.contains(n));
      const next = i >= 0 ? all[i + 1] : null;
      if (!next) return null;
      try { next.focus({ preventScroll: false }); } catch (_) {}
      return next;
    }
    async function fillField(el, text, cursor) {
      if (el.tagName === 'SELECT') {
        const want = text.trim().toLowerCase();
        const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        return;
      }
      const r = resolveEditable(el);
      if (!r || !text) return;
      if (r.kind === 'input') {
        const len = el.value.length;
        let selectable = true;
        try { el.setSelectionRange(len, len); } catch (_) { selectable = false; }
        insertInput(el, { start: len, end: len, selectable }, text, cursor);
      } else {
        const range = doc.createRange();
        range.selectNodeContents(r.el);
        range.collapse(false);
        await insertCEPlain(r.el, { range }, text, cursor);
      }
    }

    return { insertInput, insertCEPlain, insertCERich, focusNext, fillField };
  }

  FK.insert = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
