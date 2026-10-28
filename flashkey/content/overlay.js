/*
 * FlashKey — content: on-demand UI in a CLOSED Shadow DOM, one instance per window.
 *
 * Nothing here is created until the user explicitly asks for it (Ctrl+Shift+Space,
 * the "Insert FlashKey snippet…" menu, or a snippet with {input}/{choice}).
 * The host is reset with `all: initial`, page CSS cannot reach inside, our CSS
 * cannot leak out, and key/mouse events are stopped at the host so page
 * shortcuts never fire while the user types into it.
 */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});
  const HOST_TAG = 'flashkey-ui';

  const LAYER_CSS = `
.fk-layer { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; padding: min(16vh, 120px) 12px 12px; pointer-events: none; }
.fk-picker { width: min(520px, calc(100vw - 24px)); padding: 0; overflow: hidden; display: flex; flex-direction: column; max-height: min(440px, calc(100vh - 24px)); }
.fk-search { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.fk-search .fk-input { background: transparent; border: 0; box-shadow: none; padding: 4px 0; font-size: 14px; }
.fk-search .fk-input:focus { box-shadow: none; }
.fk-list { list-style: none; margin: 0; padding: 6px; overflow: auto; flex: 1; }
.fk-item { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 2px 10px; align-items: center; padding: 7px 9px; border-radius: 8px; cursor: pointer; }
.fk-item[aria-selected="true"] { background: var(--bg2); box-shadow: inset 0 0 0 1px var(--line); }
.fk-trig { font: 600 11.5px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--bg2); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; color: var(--fg); grid-row: span 2; align-self: start; justify-self: start; max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.fk-item[aria-selected="true"] .fk-trig { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.fk-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fk-prev { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fk-empty { padding: 18px; text-align: center; color: var(--muted); }
.fk-foot { display: flex; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; }
`;

  const STOP_EVENTS = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'compositionstart', 'compositionupdate', 'compositionend'];

  function scoreSnippet(s, q) {
    if (!q) return 1 + (s.pinned ? 1 : 0);
    const t = (s.trigger || '').toLowerCase();
    const l = (s.label || '').toLowerCase();
    const hay = t + ' ' + l + ' ' + (s.body || '').toLowerCase() + ' ' + (s.tags || []).join(' ').toLowerCase();
    if (!q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return 0;
    let sc = 10;
    if (t === q) sc += 200; else if (t.startsWith(q)) sc += 100; else if (t.includes(q)) sc += 60;
    if (l.startsWith(q)) sc += 50; else if (l.includes(q)) sc += 30;
    if (s.pinned) sc += 5;
    return sc;
  }

  function create(win) {
    const doc = win.document;
    const { fillin, vars } = FK;
    let ui = null;

    function mount(anchor, theme) {
      close(false);
      const host = doc.createElement(HOST_TAG);
      host.id = 'flashkey-shadow-host';
      host.setAttribute('style', 'all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;pointer-events:none !important;display:block !important;');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = doc.createElement('style');
      style.textContent = fillin.CSS + LAYER_CSS;
      const wrap = doc.createElement('div');
      wrap.className = 'fk-root fk-layer';
      wrap.dataset.theme = fillin.resolveTheme(theme, win);
      shadow.append(style, wrap);
      for (const t of STOP_EVENTS) host.addEventListener(t, (e) => e.stopPropagation());
      // Inside a modal <dialog> / focus trap, mount within it so focus is allowed there.
      const modal = anchor && anchor.closest ? anchor.closest('dialog[open], [aria-modal="true"]') : null;
      (modal || doc.body || doc.documentElement).appendChild(host);
      ui = { host, wrap, onCancel: null };
      return ui;
    }

    function close(cancelled) {
      if (!ui) return;
      const u = ui;
      ui = null;
      u.host.remove();
      if (cancelled && u.onCancel) u.onCancel();
    }

    /** Fill-in form for {input}/{choice}. Resolves with values, or null when cancelled. */
    function fillinForm({ anchor, theme, prompts, title, preview }) {
      return new Promise((resolve) => {
        const u = mount(anchor, theme);
        u.onCancel = () => resolve(null);
        const form = fillin.build({
          doc, mount: u.wrap, prompts, title, preview,
          onDone: (v) => { u.onCancel = null; close(false); resolve(v); }
        });
        setTimeout(() => form.focus(), 0);
      });
    }

    /** Quick-Picker: search all snippets, Enter inserts. */
    function picker({ anchor, theme, snippets, onPick, onCancel }) {
      const u = mount(anchor, theme);
      u.onCancel = onCancel;
      const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const card = el('div', 'fk-card fk-picker');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'FlashKey quick picker');
      const search = el('div', 'fk-search');
      const mark = el('span', 'fk-mark');
      mark.innerHTML = fillin.BOLT;
      const input = el('input', 'fk-input');
      input.placeholder = 'Search snippets…';
      input.setAttribute('aria-label', 'Search snippets');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      search.append(mark, input, el('span', 'fk-kbd', 'Esc'));
      const list = el('ul', 'fk-list');
      list.setAttribute('role', 'listbox');
      const foot = el('div', 'fk-foot');
      foot.append(el('span', null, '↑↓ navigate'), el('span', null, 'Enter insert'), el('span', null, 'Esc close'));
      card.append(search, list, foot);
      u.wrap.appendChild(card);

      let items = [];
      let sel = 0;
      const pick = (s) => { u.onCancel = null; close(false); onPick(s); };
      const render = () => {
        const q = input.value.trim().toLowerCase();
        items = snippets.filter((s) => s.enabled !== false)
          .map((s) => [scoreSnippet(s, q), s])
          .filter((x) => x[0] > 0)
          .sort((a, b) => b[0] - a[0] || String(a[1].label || a[1].trigger).localeCompare(String(b[1].label || b[1].trigger)))
          .slice(0, 60)
          .map((x) => x[1]);
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.textContent = '';
        if (!items.length) {
          list.appendChild(el('li', 'fk-empty', snippets.length ? 'No matching snippets' : 'No snippets yet — add some from the FlashKey toolbar button.'));
          return;
        }
        items.forEach((s, i) => {
          const li = el('li', 'fk-item');
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(i === sel));
          li.append(el('span', 'fk-trig', s.trigger), el('span', 'fk-name', s.label || s.trigger), el('span', 'fk-prev', vars.preview(s.body || '').replace(/\s+/g, ' ').slice(0, 120)));
          li.addEventListener('mousedown', (e) => e.preventDefault());
          li.addEventListener('click', () => pick(s));
          list.appendChild(li);
        });
        const cur = list.children[sel];
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      };
      input.addEventListener('input', () => { sel = 0; render(); });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
        else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (items[sel]) pick(items[sel]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      });
      render();
      setTimeout(() => input.focus(), 0);
    }

    return {
      isOpen: () => !!ui,
      owns: (el) => !!(ui && el && (el === ui.host || ui.host.contains(el))),
      isFrom: (e) => !!(ui && e.composedPath && e.composedPath().includes(ui.host)),
      close,
      fillin: fillinForm,
      picker
    };
  }

  FK.overlay = { create, scoreSnippet };
})(typeof globalThis !== 'undefined' ? globalThis : this);
