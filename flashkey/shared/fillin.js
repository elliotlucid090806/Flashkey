/*
 * FlashKey — keyboard-first fill-in form for {input:...} and {choice:...}.
 *
 * Used inside the content script's closed Shadow DOM and inside the popup.
 * Builds plain DOM into whatever root it is given; ships its own CSS so the
 * page can never style it (and it can never style the page).
 */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});

  const CSS = `
:host { all: initial; }
.fk-root { --bg:#ffffff; --bg2:#f5f6f8; --fg:#16181d; --muted:#6b7280; --line:#e4e6eb; --accent:#e8a400; --accent-fg:#16181d; --ring:rgba(232,164,0,.45); --shadow:0 18px 48px rgba(15,17,22,.22),0 2px 6px rgba(15,17,22,.08);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif; color: var(--fg); -webkit-font-smoothing: antialiased; }
.fk-root[data-theme="dark"] { --bg:#17191f; --bg2:#20232b; --fg:#eceef2; --muted:#9aa1ad; --line:#2c3039; --accent:#ffc53d; --accent-fg:#16181d; --ring:rgba(255,197,61,.4); --shadow:0 18px 48px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.3); }
.fk-root *, .fk-root *::before, .fk-root *::after { box-sizing: border-box; }
.fk-card { pointer-events: auto; width: min(440px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 14px; }
.fk-head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
.fk-mark { width: 18px; height: 18px; border-radius: 5px; background: #16181d; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.fk-root[data-theme="dark"] .fk-mark { background: #2a2e37; }
.fk-mark svg { width: 12px; height: 12px; }
.fk-title { font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fk-kbd { font: 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--muted); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 2px 5px; background: var(--bg2); }
.fk-field { display: block; margin: 0 0 10px; }
.fk-label { display: block; font-size: 11.5px; font-weight: 600; color: var(--muted); margin: 0 0 4px; letter-spacing: .01em; }
.fk-input { display: block; width: 100%; font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; outline: none; margin: 0; }
.fk-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
.fk-choices { display: flex; flex-wrap: wrap; gap: 6px; outline: none; border-radius: 8px; padding: 2px; }
.fk-choices:focus-visible { box-shadow: 0 0 0 3px var(--ring); }
.fk-chip { font: inherit; font-size: 12.5px; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; cursor: pointer; margin: 0; }
.fk-chip[aria-checked="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
.fk-preview { white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--muted); background: var(--bg2); border: 1px dashed var(--line); border-radius: 8px; padding: 8px 10px; max-height: 120px; overflow: auto; margin: 2px 0 12px; }
.fk-actions { display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.fk-hint { flex: 1; color: var(--muted); font-size: 11.5px; }
.fk-btn { font: inherit; font-weight: 600; font-size: 12.5px; border-radius: 8px; padding: 6px 12px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); cursor: pointer; margin: 0; }
.fk-btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.fk-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
`;

  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#ffc53d" d="M13.5 2 4.5 13.6h6.1L9.4 22l9.1-11.7h-6.2z"/></svg>';

  function resolveTheme(theme, win) {
    if (theme === 'dark' || theme === 'light') return theme;
    try { return (win || window).matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * Render the fill-in form.
   * @param {{doc:Document, mount:Node, prompts:Array, title?:string, preview?:(values)=>string, onDone:(values|null)=>void}} o
   * @returns {{root:HTMLElement, focus:()=>void, destroy:()=>void}}
   */
  function build(o) {
    const doc = o.doc;
    const values = {};
    const card = el(doc, 'div', 'fk-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'FlashKey fill-in');
    const head = el(doc, 'div', 'fk-head');
    const mark = el(doc, 'span', 'fk-mark');
    mark.innerHTML = BOLT;
    head.append(mark, el(doc, 'span', 'fk-title', o.title || 'Fill in the blanks'), el(doc, 'span', 'fk-kbd', 'Esc'));
    card.appendChild(head);

    const focusables = [];
    let previewEl = null;
    const update = () => { if (previewEl && o.preview) previewEl.textContent = o.preview(Object.assign({}, values)); };

    o.prompts.forEach((p, i) => {
      const field = el(doc, 'label', 'fk-field');
      const id = 'fk-f' + i;
      const lab = el(doc, 'span', 'fk-label', p.label);
      lab.id = id + '-l';
      field.appendChild(lab);
      if (p.type === 'input') {
        const input = el(doc, 'input', 'fk-input');
        input.type = 'text';
        input.value = p.default || '';
        input.setAttribute('aria-labelledby', lab.id);
        input.setAttribute('autocomplete', 'off');
        input.spellcheck = true;
        values[p.key] = input.value;
        input.addEventListener('input', () => { values[p.key] = input.value; update(); });
        field.appendChild(input);
        focusables.push(input);
      } else {
        const group = el(doc, 'div', 'fk-choices');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-labelledby', lab.id);
        group.tabIndex = 0;
        let sel = Math.max(0, p.options.indexOf(p.default));
        const chips = p.options.map((opt, j) => {
          const c = el(doc, 'button', 'fk-chip', opt);
          c.type = 'button';
          c.tabIndex = -1;
          c.setAttribute('role', 'radio');
          c.addEventListener('click', (e) => { e.preventDefault(); choose(j); group.focus(); });
          group.appendChild(c);
          return c;
        });
        const choose = (j) => {
          sel = (j + chips.length) % chips.length;
          chips.forEach((c, k) => c.setAttribute('aria-checked', String(k === sel)));
          values[p.key] = p.options[sel];
          update();
        };
        choose(sel);
        group.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); choose(sel + 1); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); choose(sel - 1); }
          else if (/^[1-9]$/.test(e.key) && +e.key <= chips.length) { e.preventDefault(); choose(+e.key - 1); }
          else if (e.key === ' ') { e.preventDefault(); choose(sel + 1); }
        });
        field.appendChild(group);
        focusables.push(group);
      }
      card.appendChild(field);
    });

    if (o.preview) {
      previewEl = el(doc, 'div', 'fk-preview');
      previewEl.setAttribute('aria-live', 'polite');
      card.appendChild(previewEl);
    }

    const actions = el(doc, 'div', 'fk-actions');
    actions.appendChild(el(doc, 'span', 'fk-hint', 'Tab to move · ←/→ to choose · Enter to insert'));
    const cancel = el(doc, 'button', 'fk-btn', 'Cancel');
    cancel.type = 'button';
    const ok = el(doc, 'button', 'fk-btn fk-btn-primary', 'Insert');
    ok.type = 'button';
    actions.append(cancel, ok);
    card.appendChild(actions);

    let done = false;
    const finish = (v) => { if (done) return; done = true; o.onDone(v); };
    cancel.addEventListener('click', (e) => { e.preventDefault(); finish(null); });
    ok.addEventListener('click', (e) => { e.preventDefault(); finish(Object.assign({}, values)); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (e.target === cancel) return;
        e.preventDefault();
        finish(Object.assign({}, values));
      }
    });

    o.mount.appendChild(card);
    update();
    return {
      root: card,
      focus: () => { const f = focusables[0] || ok; f.focus(); if (f.select) f.select(); },
      destroy: () => { done = true; card.remove(); }
    };
  }

  FK.fillin = { CSS, BOLT, build, resolveTheme };
})(typeof globalThis !== 'undefined' ? globalThis : this);
