/* FlashKey — toolbar popup: search, copy, insert, quick add, per-site pause. */
(() => {
  'use strict';
  const { matcher, vars, storage, fillin, ui } = FlashKey;
  const { h, icon, toast } = ui;
  const store = storage.createStore(chrome.storage.local);
  const $ = (id) => document.getElementById(id);

  const state = { settings: null, snippets: [], folders: [], usage: {}, tab: null, host: '', query: '', items: [], sel: 0 };

  /* ------------------------------- boot ------------------------------- */

  async function load() {
    const st = await store.load();
    state.settings = st.settings;
    state.snippets = st.snippets;
    state.folders = st.folders;
    state.usage = st.usage || {};
    ui.applyTheme(state.settings.theme);
  }

  async function loadTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tab || null;
      const u = tab && tab.url ? new URL(tab.url) : null;
      state.host = u && /^https?:$/.test(u.protocol) ? u.host : '';
    } catch (_) { state.host = ''; }
  }

  function staticIcons() {
    $('mark').innerHTML = icon('bolt');
    $('export').innerHTML = icon('download');
    $('studio').innerHTML = icon('open');
    $('search-icon').innerHTML = icon('search');
    $('add-open').innerHTML = icon('plus') + '<span>New snippet</span>';
  }

  /* ------------------------------ header ------------------------------ */

  const THEMES = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

  function renderHeader() {
    const s = state.settings;
    $('enabled').checked = s.enabled !== false;
    $('theme').innerHTML = icon(s.theme === 'light' ? 'sun' : s.theme === 'dark' ? 'moon' : 'system');
    $('theme').title = THEME_LABEL[s.theme] || THEME_LABEL.system;
    $('theme').setAttribute('aria-label', $('theme').title);
    renderSite();
    const notice = $('notice');
    if (s.enabled === false) { notice.hidden = false; notice.textContent = 'Expansion is paused everywhere. Copy and insert still work.'; }
    else notice.hidden = true;
  }

  function exactRuleFor(host) {
    const plain = matcher.normalizePattern(host);
    return (state.settings.blockedDomains || []).filter((p) => matcher.normalizePattern(p) === plain || matcher.normalizePattern(p) === plain.split(':')[0]);
  }

  function renderSite() {
    const site = $('site');
    if (!state.host) { site.hidden = true; return; }
    site.hidden = false;
    $('site-host').textContent = state.host;
    const blocked = matcher.isBlocked(state.settings.blockedDomains, [state.host]);
    const exact = exactRuleFor(state.host).length > 0;
    const pause = $('pause');
    pause.disabled = blocked && !exact;
    pause.setAttribute('aria-pressed', String(blocked));
    if (blocked && !exact) {
      const rule = state.settings.blockedDomains.find((p) => matcher.hostMatches(p, state.host));
      pause.innerHTML = icon('shield') + '<span></span>';
      pause.lastChild.textContent = 'Excluded by ' + rule;
      pause.title = 'Change excluded sites in Studio → Settings';
    } else if (blocked) {
      pause.innerHTML = icon('play') + '<span>Paused here · resume</span>';
      pause.title = 'Resume expansion on ' + state.host;
    } else {
      pause.innerHTML = icon('pause') + '<span>Pause on this site</span>';
      pause.title = 'Stop expanding on ' + state.host;
    }
  }

  async function togglePause() {
    const host = state.host.replace(/^www\./, '');
    const list = state.settings.blockedDomains.slice();
    const exact = exactRuleFor(host);
    const next = exact.length ? list.filter((p) => !exact.includes(p)) : list.concat([host.split(':')[0]]);
    state.settings = await store.saveSettings({ blockedDomains: next });
    renderHeader();
    toast(exact.length ? 'Expanding on ' + host + ' again' : 'Paused on ' + host);
  }

  /* ------------------------------- list ------------------------------- */

  function folderName(id) {
    const f = state.folders.find((x) => x.id === id);
    return f ? f.name : '';
  }

  function score(s, q) {
    if (!q) return 1;
    const t = s.trigger.toLowerCase();
    const l = (s.label || '').toLowerCase();
    const hay = t + ' ' + l + ' ' + (s.body || '').toLowerCase() + ' ' + (s.tags || []).join(' ').toLowerCase() + ' ' + folderName(s.folderId).toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return 0;
    let sc = 1;
    if (t === q) sc += 300; else if (t.startsWith(q)) sc += 150; else if (t.includes(q)) sc += 80;
    if (l.startsWith(q)) sc += 60; else if (l.includes(q)) sc += 30;
    return sc;
  }

  function sorted() {
    const q = state.query.trim().toLowerCase();
    return state.snippets
      .map((s) => [score(s, q), s])
      .filter((x) => x[0] > 0)
      .sort((a, b) => b[0] - a[0]
        || (b[1].pinned ? 1 : 0) - (a[1].pinned ? 1 : 0)
        || (state.usage[b[1].id] || 0) + (b[1].useCount || 0) - (state.usage[a[1].id] || 0) - (a[1].useCount || 0)
        || (a[1].label || a[1].trigger).localeCompare(b[1].label || b[1].trigger))
      .map((x) => x[1]);
  }

  function renderList() {
    state.items = sorted();
    state.sel = Math.min(state.sel, Math.max(0, state.items.length - 1));
    const list = $('list');
    list.textContent = '';
    if (!state.items.length) {
      const empty = h('li', { class: 'empty' });
      if (state.snippets.length) empty.append('No snippets match “' + state.query + '”.');
      else empty.append('No snippets yet. Create one below, or import your library in the Studio.');
      list.appendChild(empty);
      return;
    }
    state.items.slice(0, 200).forEach((s, i) => {
      const row = h('li', {
        class: 'row' + (s.enabled === false ? ' off' : ''),
        role: 'option',
        id: 'opt-' + i,
        'aria-selected': String(i === state.sel),
        onclick: () => { state.sel = i; paintSelection(); copy(s); },
        onmouseenter: () => { state.sel = i; paintSelection(); }
      },
      h('span', { class: 'key', title: s.trigger }, s.trigger),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, s.label || ui.oneLine(vars.preview(s.body), 48)),
        h('div', { class: 'row-prev' }, s.label ? ui.oneLine(vars.preview(s.body), 80) : folderName(s.folderId))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Copy', 'aria-label': 'Copy ' + s.trigger, html: icon('copy'), onclick: (e) => { e.stopPropagation(); copy(s); } }),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Edit in Studio', 'aria-label': 'Edit ' + s.trigger, html: icon('edit'), onclick: (e) => { e.stopPropagation(); openStudio('edit=' + encodeURIComponent(s.id)); } })));
      list.appendChild(row);
    });
    $('q').setAttribute('aria-activedescendant', 'opt-' + state.sel);
  }

  function paintSelection() {
    const rows = $('list').querySelectorAll('.row');
    rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === state.sel)));
    const cur = rows[state.sel];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    $('q').setAttribute('aria-activedescendant', 'opt-' + state.sel);
  }

  /* --------------------------- copy & insert --------------------------- */

  function renderCtx(values, clipboard) {
    const s = state.settings;
    return { values, clipboard, locale: s.locale, dateFormat: s.dateFormat, timeFormat: s.timeFormat };
  }

  function askFillins(s, parts, prompts) {
    return new Promise((resolve) => {
      const overlay = $('overlay');
      overlay.textContent = '';
      overlay.hidden = false;
      const shell = h('div', { class: 'fk-root', 'data-theme': fillin.resolveTheme(state.settings.theme) });
      if (!document.getElementById('fk-fillin-css')) document.head.appendChild(h('style', { id: 'fk-fillin-css', text: fillin.CSS.replace(':host { all: initial; }', '') }));
      overlay.appendChild(shell);
      const form = fillin.build({
        doc: document, mount: shell, prompts, title: s.label || s.trigger,
        preview: (values) => vars.render(parts, renderCtx(values, '[clipboard]')).text,
        onDone: (v) => { overlay.hidden = true; overlay.textContent = ''; resolve(v); }
      });
      form.focus();
    });
  }

  async function copy(s) {
    const parts = vars.parse(s.body);
    const prompts = vars.collectPrompts(parts);
    let values = {};
    if (prompts.length) {
      values = await askFillins(s, parts, prompts);
      if (!values) { $('q').focus(); return; }
    }
    let clip = '';
    if (vars.needsClipboard(parts)) { try { clip = await navigator.clipboard.readText(); } catch (_) { clip = ''; } }
    const text = vars.render(parts, renderCtx(values, clip)).text;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied ' + s.trigger);
      chrome.runtime.sendMessage({ type: 'fk:expanded', id: s.id, saved: text.length }).catch(() => {});
    } catch (_) {
      toast('Could not copy — try again');
    }
    $('q').focus();
  }

  async function insert(s) {
    if (!state.tab || state.tab.id == null) { toast('Open a web page to insert into it'); return; }
    chrome.runtime.sendMessage({ type: 'fk:insertInTab', tabId: state.tab.id, id: s.id }).catch(() => {});
    setTimeout(() => window.close(), 30);
  }

  function openStudio(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html' + (hash ? '#' + hash : '')) });
    window.close();
  }

  /* ------------------------------ quick add ------------------------------ */

  function renderFolders() {
    const sel = $('add-folder');
    sel.textContent = '';
    for (const f of state.folders) sel.appendChild(h('option', { value: f.id }, f.name));
  }

  function openAdd(open) {
    $('add').hidden = !open;
    $('add-open').hidden = open;
    $('add-msg').textContent = '';
    if (open) { renderFolders(); $('add-trigger').focus(); }
    else $('q').focus();
  }

  function checkTrigger() {
    const t = $('add-trigger').value.trim();
    const err = t ? matcher.validateTrigger(t) : '';
    const dup = t && state.snippets.find((s) => s.trigger.toLowerCase() === t.toLowerCase());
    $('add-msg').textContent = err || (dup ? `“${t}” is already used by ${dup.label || 'another snippet'}.` : '');
  }

  async function saveAdd(e) {
    e.preventDefault();
    const trigger = $('add-trigger').value.trim();
    const err = matcher.validateTrigger(trigger);
    if (err) { $('add-msg').textContent = err; $('add-trigger').focus(); return; }
    if (!$('add-body').value) { $('add-msg').textContent = 'Add the text this trigger should expand to.'; $('add-body').focus(); return; }
    await store.upsertSnippet({ trigger, label: $('add-label').value.trim(), body: $('add-body').value, folderId: $('add-folder').value });
    $('add').reset();
    openAdd(false);
    toast('Saved ' + trigger);
  }

  /* ------------------------------- events ------------------------------- */

  function wire() {
    $('q').addEventListener('input', (e) => { state.query = e.target.value; state.sel = 0; renderList(); });
    $('q').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.sel = Math.min(state.items.length - 1, state.sel + 1); paintSelection(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); state.sel = Math.max(0, state.sel - 1); paintSelection(); }
      else if (e.key === 'Enter' && state.items[state.sel]) { e.preventDefault(); (e.shiftKey ? insert : copy)(state.items[state.sel]); }
    });
    $('enabled').addEventListener('change', async (e) => { state.settings = await store.saveSettings({ enabled: e.target.checked }); renderHeader(); });
    $('theme').addEventListener('click', async () => {
      const next = THEMES[(THEMES.indexOf(state.settings.theme) + 1) % THEMES.length];
      state.settings = await store.saveSettings({ theme: next });
      ui.applyTheme(next);
      renderHeader();
    });
    $('export').addEventListener('click', async () => { const n = await ui.exportBackup(store); toast(`Backup saved · ${n} snippets`); });
    $('studio').addEventListener('click', () => openStudio(''));
    $('pause').addEventListener('click', togglePause);
    $('add-open').addEventListener('click', () => openAdd(true));
    $('add-cancel').addEventListener('click', () => openAdd(false));
    $('add-trigger').addEventListener('input', checkTrigger);
    $('add').addEventListener('submit', saveAdd);
    $('add').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); openAdd(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveAdd(e);
    });
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local' || !(changes.snippets || changes.settings || changes.folders)) return;
      await load();
      renderHeader();
      renderList();
    });
  }

  (async () => {
    staticIcons();
    wire();
    await Promise.all([load(), loadTab()]);
    renderHeader();
    renderList();
    $('q').focus();
  })();
})();
