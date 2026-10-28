/* FlashKey Studio — shell: state, routing, sidebar, header, banners, dialogs. */
(() => {
  'use strict';
  const { storage, ui } = FlashKey;
  const { h, icon } = ui;
  const store = storage.createStore(chrome.storage.local);
  const $ = (id) => document.getElementById(id);

  const S = (window.Studio = {
    store,
    $,
    data: { settings: null, snippets: [], folders: [], usage: {}, stats: {}, meta: {}, snapshots: [] },
    filter: { nav: 'all', tags: new Set(), query: '', sort: 'used' },
    view: 'library',
    renderers: {},
    ready: false
  });

  S.folderName = (id) => { const f = S.data.folders.find((x) => x.id === id); return f ? f.name : 'General'; };
  S.uses = (s) => (s.useCount || 0) + (S.data.usage[s.id] || 0);

  S.load = async () => {
    const st = await store.load();
    S.data.settings = st.settings;
    S.data.snippets = st.snippets;
    S.data.folders = st.folders.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    S.data.usage = st.usage || {};
    S.data.stats = st.stats || {};
    S.data.meta = st.meta || {};
    S.data.snapshots = (st.snapshots || []).map(({ id, createdAt, reason, count }) => ({ id, createdAt, reason, count }));
    ui.applyTheme(S.data.settings.theme);
  };

  S.renderAll = () => {
    renderSide();
    renderTop();
    renderBanners();
    const r = S.renderers[S.view];
    if (r) r();
  };

  /* ------------------------------- routing ------------------------------- */

  const TITLES = { import: 'Import & backup', snapshots: 'Snapshots', settings: 'Settings & excluded sites' };

  S.setView = (view) => {
    S.view = view;
    for (const v of ['library', 'import', 'snapshots', 'settings']) $('view-' + v).hidden = v !== view;
    S.renderAll();
  };

  S.setNav = (nav) => {
    S.filter.nav = nav;
    if (S.view !== 'library') S.setView('library'); else S.renderAll();
  };

  function libraryTitle() {
    const n = S.filter.nav;
    if (n === 'pinned') return 'Pinned';
    if (n.startsWith('folder:')) return S.folderName(n.slice(7));
    return 'All snippets';
  }

  /* ------------------------------- sidebar ------------------------------- */

  function renderSide() {
    const { snippets, folders } = S.data;
    $('count-all').textContent = snippets.length;
    $('count-pinned').textContent = snippets.filter((s) => s.pinned).length;
    $('count-snaps').textContent = S.data.snapshots.length;
    document.querySelectorAll('[data-nav]').forEach((b) => b.setAttribute('aria-current', String(S.view === 'library' && b.dataset.nav === S.filter.nav)));
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-current', String(S.view === b.dataset.view)));

    const box = $('folders');
    box.textContent = '';
    for (const f of folders) {
      const nav = 'folder:' + f.id;
      const count = snippets.filter((s) => s.folderId === f.id).length;
      const item = h('div', { class: 'nav-item folder-item', role: 'listitem', 'aria-current': String(S.view === 'library' && S.filter.nav === nav) },
        h('span', { class: 'folder-emoji', 'aria-hidden': 'true' }, f.icon || '📁'),
        h('button', { class: 'nav-label', type: 'button', style: 'all:unset;flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', onclick: () => S.setNav(nav) }, f.name),
        h('span', { class: 'count' }, count),
        h('span', { class: 'folder-tools' },
          h('button', { class: 'btn btn-ghost btn-icon btn-mini', type: 'button', title: 'Rename folder', 'aria-label': 'Rename ' + f.name, html: icon('edit'), onclick: () => renameFolder(f) }),
          f.id === 'default' ? null : h('button', { class: 'btn btn-ghost btn-icon btn-mini', type: 'button', title: 'Delete folder', 'aria-label': 'Delete ' + f.name, html: icon('trash'), onclick: () => deleteFolder(f, count) })));
      box.appendChild(item);
    }

    const tags = new Map();
    for (const s of snippets) for (const t of s.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    const tbox = $('tags');
    tbox.textContent = '';
    if (!tags.size) tbox.appendChild(h('span', { class: 'hint' }, 'Tags you add show up here.'));
    [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).forEach(([t, n]) => {
      tbox.appendChild(h('button', {
        class: 'tag-chip', type: 'button', 'aria-pressed': String(S.filter.tags.has(t)), title: n + ' snippet' + (n === 1 ? '' : 's'),
        onclick: () => { if (S.filter.tags.has(t)) S.filter.tags.delete(t); else S.filter.tags.add(t); if (S.view !== 'library') S.setView('library'); else S.renderAll(); }
      }, t));
    });

    const st = S.data.stats || {};
    $('stats').innerHTML = '';
    $('stats').append(
      h('div', null, h('b', null, (st.totalExpansions || 0).toLocaleString()), ' expansions'),
      h('div', null, h('b', null, ui.timeSaved(st.charactersSaved)), ' of typing saved'),
      h('div', { class: 'hint' }, 'Stored only in this browser'));
  }

  async function renameFolder(f) {
    const name = await S.prompt({ title: 'Rename folder', label: 'Folder name', value: f.name, confirm: 'Rename' });
    if (!name) return;
    await store.saveFolder({ id: f.id, name });
  }

  async function deleteFolder(f, count) {
    if (!count) { await store.deleteFolder(f.id); if (S.filter.nav === 'folder:' + f.id) S.filter.nav = 'all'; return; }
    const choice = await S.choose({
      title: `Delete “${f.name}”?`,
      body: `It holds ${count} snippet${count === 1 ? '' : 's'}. A snapshot is saved first either way.`,
      options: [{ value: 'move', label: 'Move them to General' }, { value: 'delete', label: 'Delete them too', danger: true }]
    });
    if (!choice) return;
    await store.deleteFolder(f.id, { deleteSnippets: choice === 'delete' });
    if (S.filter.nav === 'folder:' + f.id) S.filter.nav = 'all';
    ui.toast(choice === 'delete' ? 'Folder and snippets deleted' : 'Folder deleted, snippets moved to General', { label: 'Undo', run: S.undoLastSnapshot });
  }

  S.undoLastSnapshot = async () => {
    const snaps = await store.listSnapshots();
    if (!snaps.length) return;
    await store.restoreSnapshot(snaps[0].id);
    ui.toast('Restored');
  };

  /* ------------------------------- header ------------------------------- */

  function renderTop() {
    $('view-title').textContent = S.view === 'library' ? libraryTitle() : TITLES[S.view];
    document.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themePick === S.data.settings.theme)));
  }

  /* ------------------------------- banners ------------------------------- */

  function renderBanners() {
    const box = $('banners');
    box.textContent = '';
    const meta = S.data.meta || {};
    const now = Date.now();
    if (!meta.welcomeDismissed && (location.hash === '#welcome' || now - (meta.installedAt || now) < 3 * 86400000)) {
      box.appendChild(h('div', { class: 'banner banner-welcome' },
        h('span', null, 'FlashKey is ready. Type ', h('span', { class: 'key' }, ';date'), ' then Space in any text box — or try it in the editor below.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: () => S.setView('import') }, 'Import from Magical or Text Blaze'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => store.setMeta({ welcomeDismissed: true }) }, 'Dismiss')));
    }
    const last = meta.lastBackupAt || meta.installedAt || now;
    const snoozed = meta.reminderSnoozedAt && now - meta.reminderSnoozedAt < 7 * 86400000;
    if (S.data.settings.backupReminder && S.data.snippets.length >= 10 && now - last > 30 * 86400000 && !snoozed) {
      box.appendChild(h('div', { class: 'banner' },
        h('span', null, `Your last backup was ${ui.timeAgo(meta.lastBackupAt)}. A copy on your computer keeps ${S.data.snippets.length} snippets safe.`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: exportJSON }, 'Download backup'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => store.setMeta({ reminderSnoozedAt: Date.now() }) }, 'Later')));
    }
  }

  async function exportJSON() {
    const n = await ui.exportBackup(store);
    ui.toast(`Backup downloaded · ${n} snippets`);
  }
  S.exportJSON = exportJSON;

  S.exportCSV = (list) => {
    const snippets = list || S.data.snippets;
    ui.download(FlashKey.formats.backupFilename('csv'), FlashKey.formats.toCSV(snippets, S.data.folders), 'text/csv;charset=utf-8');
    ui.toast(`CSV downloaded · ${snippets.length} snippets`);
  };

  /* ------------------------------- dialogs ------------------------------- */

  function openDialog(build) {
    return new Promise((resolve) => {
      const modal = $('modal');
      const prev = document.activeElement;
      modal.textContent = '';
      modal.hidden = false;
      const close = (v) => { modal.hidden = true; modal.textContent = ''; document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
      document.addEventListener('keydown', onKey, true);
      modal.onclick = (e) => { if (e.target === modal) close(null); };
      const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
      build(box, close);
      modal.appendChild(box);
      const f = box.querySelector('input, .btn-primary, .btn-danger-solid, button');
      if (f) { f.focus(); if (f.select) f.select(); }
    });
  }

  S.confirm = ({ title, body, confirm, danger }) => openDialog((box, close) => {
    box.append(h('h3', null, title));
    if (body) box.append(h('p', null, body));
    box.append(h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'), type: 'button', onclick: () => close(true) }, confirm || 'OK')));
  });

  S.prompt = ({ title, label, value, confirm, placeholder }) => openDialog((box, close) => {
    const input = h('input', { class: 'input', value: value || '', placeholder: placeholder || '', 'aria-label': label });
    const submit = () => { const v = input.value.trim(); if (v) close(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    box.append(h('h3', null, title), h('label', { class: 'field' }, h('span', null, label), input),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, confirm || 'Save')));
  });

  S.choose = ({ title, body, options }) => openDialog((box, close) => {
    box.append(h('h3', null, title));
    if (body) box.append(h('p', null, body));
    box.append(h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close(null) }, 'Cancel'),
      ...options.map((o) => h('button', { class: 'btn ' + (o.danger ? 'btn-danger-solid' : 'btn-primary'), type: 'button', onclick: () => close(o.value) }, o.label))));
  });

  /* -------------------------------- wiring -------------------------------- */

  function fillIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  }
  S.fillIcons = fillIcons;

  function wire() {
    document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => S.setNav(b.dataset.nav)));
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => S.setView(b.dataset.view)));
    document.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', async () => {
      S.data.settings = await store.saveSettings({ theme: b.dataset.themePick });
      ui.applyTheme(S.data.settings.theme);
      renderTop();
    }));
    $('folder-add').addEventListener('click', async () => {
      const name = await S.prompt({ title: 'New folder', label: 'Folder name', placeholder: 'Clinic notes', confirm: 'Create folder' });
      if (name) await store.saveFolder({ name });
    });
    $('top-export-json').addEventListener('click', exportJSON);
    $('top-export-csv').addEventListener('click', () => S.exportCSV());

    const refresh = ui.debounce(async () => { await S.load(); S.renderAll(); }, 60);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      refresh();
    });
  }

  async function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash === 'import' || hash === 'snapshots' || hash === 'settings') { S.setView(hash); return; }
    S.setView('library');
    if (hash.startsWith('edit=') && S.openEditor) S.openEditor(hash.slice(5));
    if (hash === 'new-from-selection' && S.newSnippet) {
      let draft = null;
      try { draft = (await chrome.storage.session.get('pendingDraft')).pendingDraft; await chrome.storage.session.remove('pendingDraft'); } catch (_) {}
      S.newSnippet({ body: draft ? draft.body : '', label: draft && draft.source ? 'Saved from ' + draft.source : '' });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    fillIcons();
    wire();
    await S.load();
    S.ready = true;
    if (S.onReady) S.onReady.forEach((fn) => fn());
    await route();
    window.addEventListener('hashchange', route);
  });
})();
