/* FlashKey Studio — snippet list, bulk actions and the editor (with live test sandbox). */
(() => {
  'use strict';
  const S = window.Studio;
  const { matcher, vars, sanitize, formats, ui } = FlashKey;
  const { h, icon } = ui;
  const { $, store } = S;

  const L = { selectedId: null, isNew: false, dirty: false, mode: 'plain', tags: [], checked: new Set(), visible: [] };
  S.lib = L;

  /* ------------------------------- list ------------------------------- */

  function visibleSnippets() {
    const { nav, tags, query, sort } = S.filter;
    let list = S.data.snippets;
    if (nav === 'pinned') list = list.filter((s) => s.pinned);
    else if (nav.startsWith('folder:')) list = list.filter((s) => s.folderId === nav.slice(7));
    if (tags.size) list = list.filter((s) => [...tags].every((t) => (s.tags || []).includes(t)));
    const q = query.trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter((s) => {
        const hay = (s.trigger + ' ' + s.label + ' ' + s.body + ' ' + (s.tags || []).join(' ')).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const byTrigger = (a, b) => a.trigger.localeCompare(b.trigger, undefined, { sensitivity: 'base' });
    const cmp = {
      used: (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || S.uses(b) - S.uses(a) || byTrigger(a, b),
      trigger: byTrigger,
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt
    }[sort] || byTrigger;
    return list.slice().sort(cmp);
  }

  function renderList() {
    L.visible = visibleSnippets();
    const ul = $('snippet-list');
    ul.textContent = '';
    ul.classList.toggle('selecting', L.checked.size > 0);
    if (!L.visible.length) {
      const msg = S.data.snippets.length ? 'No snippets match these filters.' : 'Your library is empty. Create a snippet or import one from another tool.';
      ul.appendChild(h('li', { class: 'list-empty' }, msg));
    }
    const showFolder = !S.filter.nav.startsWith('folder:');
    const frag = document.createDocumentFragment();
    for (const s of L.visible.slice(0, 1500)) {
      const uses = S.uses(s);
      const check = h('input', { type: 'checkbox', class: 'srow-check', 'aria-label': 'Select ' + s.trigger, onclick: (e) => { e.stopPropagation(); toggleCheck(s.id, e.target.checked); } });
      check.checked = L.checked.has(s.id);
      frag.appendChild(h('li', {
        class: 'srow' + (s.enabled === false ? ' off' : ''), role: 'option', 'aria-selected': String(s.id === L.selectedId), 'data-id': s.id, tabindex: s.id === L.selectedId ? '0' : '-1',
        onclick: () => openEditor(s.id)
      },
      check,
      h('span', { class: 'key', title: s.trigger }, s.trigger),
      h('div', { class: 'srow-text' },
        h('div', { class: 'srow-title' }, s.label || ui.oneLine(vars.preview(s.body), 60) || '(empty)'),
        h('div', { class: 'srow-prev' }, s.label ? ui.oneLine(vars.preview(s.isRichText && s.html ? sanitize.htmlToText(s.html) : s.body), 120) : '')),
      h('div', { class: 'srow-meta' },
        s.pinned ? h('span', { html: icon('pin'), title: 'Pinned' }) : null,
        s.enabled === false ? h('span', { class: 'srow-off' }, 'Off') : null,
        showFolder ? h('span', null, S.folderName(s.folderId)) : null,
        uses ? h('span', { title: uses + ' expansions' }, uses + '×') : null)));
    }
    ul.appendChild(frag);
    renderBulk();
  }

  function toggleCheck(id, on) {
    if (on) L.checked.add(id); else L.checked.delete(id);
    $('snippet-list').classList.toggle('selecting', L.checked.size > 0);
    renderBulk();
  }

  function renderBulk() {
    for (const id of [...L.checked]) if (!S.data.snippets.some((s) => s.id === id)) L.checked.delete(id);
    const n = L.checked.size;
    $('bulk').hidden = n === 0;
    $('bulk-count').textContent = n + ' selected';
    $('select-all').checked = n > 0 && L.visible.every((s) => L.checked.has(s.id));
    const mv = $('bulk-move');
    mv.textContent = '';
    mv.appendChild(h('option', { value: '' }, 'Move to…'));
    for (const f of S.data.folders) mv.appendChild(h('option', { value: f.id }, f.name));
  }

  /* ------------------------------- editor ------------------------------- */

  function blank(overrides) {
    const nav = S.filter.nav;
    return Object.assign({
      id: null, trigger: '', label: '', body: '', html: '', isRichText: false,
      folderId: nav.startsWith('folder:') ? nav.slice(7) : 'default', tags: [], enabled: true, matchCase: null, triggerMode: null,
      pinned: nav === 'pinned', createdAt: 0, updatedAt: 0
    }, overrides || {});
  }

  async function guardDirty() {
    if (!L.dirty) return true;
    return S.confirm({ title: 'Discard unsaved changes?', body: 'Your edits to this snippet have not been saved.', confirm: 'Discard', danger: true });
  }

  async function openEditor(id) {
    if (id === L.selectedId && !L.isNew) return;
    if (!(await guardDirty())) return;
    const sn = S.data.snippets.find((s) => s.id === id);
    if (!sn) return;
    L.selectedId = id;
    L.isNew = false;
    populate(sn);
    renderList();
    const row = $('snippet-list').querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  S.openEditor = openEditor;

  async function newSnippet(overrides) {
    if (!(await guardDirty())) return;
    L.selectedId = null;
    L.isNew = true;
    populate(blank(overrides));
    if (overrides && overrides.body) L.dirty = true;
    renderList();
    $('f-trigger').focus();
  }
  S.newSnippet = newSnippet;

  function populate(sn) {
    $('editor-empty').hidden = true;
    $('edit-form').hidden = false;
    $('f-trigger').value = sn.trigger;
    $('f-label').value = sn.label;
    const fs = $('f-folder');
    fs.textContent = '';
    for (const f of S.data.folders) fs.appendChild(h('option', { value: f.id }, f.name));
    fs.value = S.data.folders.some((f) => f.id === sn.folderId) ? sn.folderId : 'default';
    L.tags = (sn.tags || []).slice();
    renderTags();
    setMode(sn.isRichText && sn.html ? 'rich' : 'plain', sn);
    $('f-body').value = sn.body;
    $('f-mode').value = sn.triggerMode || '';
    $('f-case').value = sn.matchCase == null ? '' : String(sn.matchCase);
    $('f-enabled').checked = sn.enabled !== false;
    $('f-pinned').checked = !!sn.pinned;
    $('f-delete').hidden = L.isNew;
    $('f-duplicate').hidden = L.isNew;
    $('f-meta').textContent = L.isNew ? 'New snippet' : `Used ${S.uses(sn)} time${S.uses(sn) === 1 ? '' : 's'} · updated ${ui.timeAgo(sn.updatedAt)}`;
    $('sandbox-text').value = '';
    $('sandbox-rich').textContent = '';
    L.dirty = false;
    validate();
    refreshSandbox();
  }

  function setMode(mode, sn) {
    L.mode = mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('rich-tools').hidden = mode !== 'rich';
    $('f-rich').hidden = mode !== 'rich';
    $('f-body').hidden = mode === 'rich';
    $('mode-hint').textContent = mode === 'rich'
      ? 'Bold, italics, links and lists for editors like Gmail, Zendesk and LinkedIn. Plain text boxes get the text version.'
      : 'Plain text takes on the font of wherever you type it.';
    if (mode === 'rich') {
      const src = sn ? (sn.html || sanitize.textToHTML(sn.body)) : sanitize.textToHTML($('f-body').value);
      $('f-rich').innerHTML = sanitize.sanitizeHTML(src);
    } else if (!sn) {
      $('f-body').value = sanitize.htmlToText($('f-rich').innerHTML);
    }
  }

  function renderTags() {
    const box = $('f-tags');
    box.querySelectorAll('.chip').forEach((c) => c.remove());
    const input = $('f-tag-input');
    for (const t of L.tags) {
      box.insertBefore(h('span', { class: 'chip' }, t,
        h('button', { type: 'button', 'aria-label': 'Remove tag ' + t, html: icon('x'), onclick: () => { L.tags = L.tags.filter((x) => x !== t); renderTags(); markDirty(); } })), input);
    }
  }

  function addTag(raw) {
    const parts = String(raw).split(',').map((t) => t.trim()).filter(Boolean);
    let added = false;
    for (const t of parts) if (!L.tags.includes(t)) { L.tags.push(t); added = true; }
    if (added) { renderTags(); markDirty(); }
  }

  function collect() {
    const rich = L.mode === 'rich';
    const html = rich ? sanitize.sanitizeHTML($('f-rich').innerHTML) : '';
    const caseVal = $('f-case').value;
    return {
      id: L.selectedId || undefined,
      trigger: $('f-trigger').value.trim(),
      label: $('f-label').value.trim(),
      body: rich ? sanitize.htmlToText(html) : $('f-body').value,
      html,
      isRichText: rich && !!html,
      folderId: $('f-folder').value,
      tags: L.tags.slice(),
      triggerMode: $('f-mode').value || null,
      matchCase: caseVal === '' ? null : caseVal === 'true',
      enabled: $('f-enabled').checked,
      pinned: $('f-pinned').checked
    };
  }

  function validate() {
    const d = collect();
    const msg = $('f-trigger-msg');
    let text = d.trigger ? matcher.validateTrigger(d.trigger) : '';
    if (!text && d.trigger) {
      const others = S.data.snippets.filter((s) => s.id !== L.selectedId);
      const dup = others.find((s) => s.trigger.toLowerCase() === d.trigger.toLowerCase());
      if (dup) text = `“${dup.trigger}” is already used by ${dup.label ? '“' + dup.label + '”' : 'another snippet'}. Only one of them will expand.`;
      else {
        const mode = d.triggerMode || S.data.settings.triggerMode;
        const low = d.trigger.toLowerCase();
        const longer = mode === 'immediate' && others.find((s) => s.trigger.toLowerCase().startsWith(low));
        const shorter = others.find((s) => (s.triggerMode || S.data.settings.triggerMode) === 'immediate' && low.startsWith(s.trigger.toLowerCase()));
        if (longer) text = `Expanding immediately means “${longer.trigger}” can never be typed — “${d.trigger}” fires first.`;
        else if (shorter) text = `“${shorter.trigger}” expands immediately, so this trigger can never be reached.`;
      }
    }
    msg.textContent = text;
    return d;
  }

  function markDirty() {
    L.dirty = true;
    validate();
    refreshSandbox();
  }

  const refreshSandbox = ui.debounce(() => {
    if (window.__flashkeyEngine) window.__flashkeyEngine.refresh();
    const d = collect();
    $('sandbox-hint').textContent = d.trigger && !matcher.validateTrigger(d.trigger)
      ? `Type ${d.trigger} then ${((d.triggerMode || S.data.settings.triggerMode) === 'immediate') ? 'nothing else' : 'Space'} — unsaved changes included.`
      : 'Add a trigger, then type it here to watch it expand.';
  }, 120);

  window.FlashKeyStudioDraft = () => {
    if ($('edit-form').hidden) return null;
    const d = collect();
    if (!d.trigger || matcher.validateTrigger(d.trigger)) return null;
    return Object.assign({}, d, { id: L.selectedId || '__studio_draft__' });
  };

  async function save(e) {
    if (e) e.preventDefault();
    const d = validate();
    const err = matcher.validateTrigger(d.trigger);
    if (err) { ui.toast(err); $('f-trigger').focus(); return; }
    if (!d.body.trim() && !d.html) { ui.toast('Add the text this trigger expands to'); (L.mode === 'rich' ? $('f-rich') : $('f-body')).focus(); return; }
    if (/\{clipboard\}/i.test(d.body)) ensureClipboardPermission();
    const saved = await store.upsertSnippet(d);
    L.selectedId = saved.id;
    L.isNew = false;
    L.dirty = false;
    $('f-delete').hidden = false;
    $('f-duplicate').hidden = false;
    $('f-meta').textContent = 'Saved just now';
    ui.toast('Saved ' + saved.trigger);
  }

  async function removeCurrent() {
    const sn = S.data.snippets.find((s) => s.id === L.selectedId);
    if (!sn) return;
    const { removed } = await store.deleteSnippets([sn.id], { snapshot: false });
    L.selectedId = null;
    L.dirty = false;
    closeEditor();
    ui.toast('Deleted ' + sn.trigger, { label: 'Undo', run: async () => { await store.restoreSnippets(removed); L.selectedId = sn.id; populate(sn); } });
  }

  function closeEditor() {
    $('edit-form').hidden = true;
    $('editor-empty').hidden = false;
    L.isNew = false;
    renderList();
  }

  function ensureClipboardPermission() {
    // Called from a click, so Chrome can show its one-time prompt.
    chrome.permissions.request({ permissions: ['clipboardRead'] }).catch(() => {});
  }

  function insertVar(token) {
    if (token === '{clipboard}') ensureClipboardPermission();
    if (L.mode === 'rich') {
      const r = $('f-rich');
      r.focus();
      document.execCommand('insertText', false, token);
    } else {
      const ta = $('f-body');
      ta.focus();
      const start = ta.selectionStart;
      ta.setRangeText(token, start, ta.selectionEnd, 'end');
      // Select the editable part of fill-ins so it can be typed over right away.
      const m = /^\{(input|choice):(.*)\}$/.exec(token);
      if (m) ta.setSelectionRange(start + m[1].length + 2, start + token.length - 1);
    }
    markDirty();
  }

  /* -------------------------------- bulk -------------------------------- */

  async function bulk(action) {
    const ids = [...L.checked];
    if (!ids.length) return;
    if (action === 'delete') {
      const ok = await S.confirm({ title: `Delete ${ids.length} snippet${ids.length === 1 ? '' : 's'}?`, body: 'A snapshot is saved first, so you can undo this from Snapshots.', confirm: 'Delete', danger: true });
      if (!ok) return;
      const { snapshot } = await store.deleteSnippets(ids, { snapshot: true });
      L.checked.clear();
      if (ids.includes(L.selectedId)) { L.selectedId = null; L.dirty = false; closeEditor(); }
      ui.toast(`Deleted ${ids.length} snippet${ids.length === 1 ? '' : 's'}`, snapshot ? { label: 'Undo', run: async () => { await store.restoreSnapshot(snapshot.id); ui.toast('Restored'); } } : null);
    } else if (action === 'enable' || action === 'disable') {
      await store.bulkUpdate(ids, { enabled: action === 'enable' });
      ui.toast(`${action === 'enable' ? 'Enabled' : 'Disabled'} ${ids.length}`);
    } else if (action === 'export') {
      const picked = S.data.snippets.filter((s) => L.checked.has(s.id));
      const fmt = await S.choose({ title: `Export ${picked.length} snippet${picked.length === 1 ? '' : 's'}`, options: [{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON backup' }] });
      if (fmt === 'csv') S.exportCSV(picked);
      else if (fmt === 'json') {
        const data = formats.toJSONBackup(Object.assign({}, S.data, { snippets: picked }));
        ui.download(formats.backupFilename('json').replace('backup', 'selection'), JSON.stringify(data, null, 2), 'application/json');
      }
    }
  }

  /* -------------------------------- wiring -------------------------------- */

  function wire() {
    $('search').addEventListener('input', ui.debounce((e) => { S.filter.query = e.target.value; renderList(); }, 60));
    $('sort').addEventListener('change', (e) => { S.filter.sort = e.target.value; renderList(); });
    $('new-snippet').addEventListener('click', () => { if (S.view !== 'library') S.setView('library'); newSnippet(); });
    $('editor-empty-new').addEventListener('click', () => newSnippet());
    $('edit-form').addEventListener('submit', save);
    $('edit-form').addEventListener('input', (e) => { if (!e.target.closest('[data-flashkey-sandbox]') && e.target.id !== 'f-tag-input') markDirty(); });
    $('edit-form').addEventListener('change', (e) => { if (!e.target.closest('[data-flashkey-sandbox]') && e.target.id !== 'f-tag-input') markDirty(); });
    $('f-delete').addEventListener('click', removeCurrent);
    $('f-duplicate').addEventListener('click', async () => {
      const d = collect();
      await newSnippet(Object.assign(d, { id: null, trigger: d.trigger + '-copy', label: d.label ? d.label + ' (copy)' : '' }));
      L.dirty = true;
    });
    $('f-tag-input').addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && e.target.value.trim()) { e.preventDefault(); addTag(e.target.value); e.target.value = ''; }
      else if (e.key === 'Backspace' && !e.target.value && L.tags.length) { L.tags.pop(); renderTags(); markDirty(); }
    });
    $('f-tag-input').addEventListener('blur', (e) => { if (e.target.value.trim()) { addTag(e.target.value); e.target.value = ''; } });
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { if (L.mode !== b.dataset.mode) { setMode(b.dataset.mode, null); markDirty(); } }));
    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
      const cmd = b.dataset.cmd;
      $('f-rich').focus();
      if (cmd === 'createLink') {
        const sel = window.getSelection();
        const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        const url = await S.prompt({ title: 'Add link', label: 'Web address', placeholder: 'https://', confirm: 'Add link' });
        $('f-rich').focus();
        if (range) { sel.removeAllRanges(); sel.addRange(range); }
        if (url && /^(https?:|mailto:|tel:)/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
        else if (url) ui.toast('Links must start with https://, mailto: or tel:');
      } else document.execCommand(cmd, false, null);
      markDirty();
    }));
    $('f-rich').addEventListener('paste', (e) => {
      // Keep pasted formatting simple and safe.
      const html = e.clipboardData && e.clipboardData.getData('text/html');
      if (!html) return;
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize.sanitizeHTML(html));
    });
    document.querySelectorAll('[data-var]').forEach((b) => b.addEventListener('click', () => insertVar(b.dataset.var)));

    $('select-all').addEventListener('change', (e) => { for (const s of L.visible) { if (e.target.checked) L.checked.add(s.id); else L.checked.delete(s.id); } renderList(); });
    $('bulk-clear').addEventListener('click', () => { L.checked.clear(); renderList(); });
    $('bulk-enable').addEventListener('click', () => bulk('enable'));
    $('bulk-disable').addEventListener('click', () => bulk('disable'));
    $('bulk-export').addEventListener('click', () => bulk('export'));
    $('bulk-delete').addEventListener('click', () => bulk('delete'));
    $('bulk-move').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const n = await store.bulkUpdate([...L.checked], { folderId: e.target.value });
      ui.toast(`Moved ${n} to ${S.folderName(e.target.value)}`);
    });

    $('snippet-list').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = L.visible.findIndex((s) => s.id === L.selectedId);
      const next = L.visible[Math.max(0, Math.min(L.visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) openEditor(next.id).then(() => { const row = $('snippet-list').querySelector(`[data-id="${CSS.escape(next.id)}"]`); if (row) row.focus(); });
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.view === 'library' && !$('edit-form').hidden) { e.preventDefault(); save(); }
      else if (e.key === '/' && S.view === 'library' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { e.preventDefault(); $('search').focus(); }
    });
    window.addEventListener('beforeunload', (e) => { if (L.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  S.renderers.library = () => {
    renderList();
    if (!L.isNew && L.selectedId && !S.data.snippets.some((s) => s.id === L.selectedId)) { L.selectedId = null; L.dirty = false; closeEditor(); }
    if (!L.dirty && !L.isNew && L.selectedId) {
      const sn = S.data.snippets.find((s) => s.id === L.selectedId);
      if (sn && document.activeElement && !document.activeElement.closest('#edit-form')) populate(sn);
      else if (sn) $('f-meta').textContent = `Used ${S.uses(sn)} time${S.uses(sn) === 1 ? '' : 's'} · updated ${ui.timeAgo(sn.updatedAt)}`;
    }
    if (window.__flashkeyEngine) window.__flashkeyEngine.refresh();
  };

  (S.onReady = S.onReady || []).push(wire);
})();
