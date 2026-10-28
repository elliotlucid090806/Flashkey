/* FlashKey Studio — settings, excluded sites and safety snapshots. */
(() => {
  'use strict';
  const S = window.Studio;
  const { matcher, vars, formats, ui } = FlashKey;
  const { h, icon } = ui;
  const { $, store } = S;

  /* ------------------------------- settings ------------------------------- */

  const TOGGLES = { 's-enabled': 'enabled', 's-keep': 'keepDelimiter', 's-case': 'caseSensitive', 's-inside': 'matchInsideWords', 's-picker': 'quickPickerShortcut', 's-reminder': 'backupReminder' };
  const TEXTS = { 's-datefmt': 'dateFormat', 's-timefmt': 'timeFormat', 's-locale': 'locale' };

  async function save(patch) {
    S.data.settings = await store.saveSettings(patch);
  }

  function dateExample() {
    const s = S.data.settings;
    const ctx = { locale: s.locale, dateFormat: s.dateFormat, timeFormat: s.timeFormat };
    $('s-date-example').textContent = vars.resolve('{date} · {time} · {day}', ctx).text;
  }

  async function renderClip() {
    const granted = await chrome.permissions.contains({ permissions: ['clipboardRead'] });
    $('clip-status').textContent = granted
      ? 'Allowed. {clipboard} pastes what you last copied, read only at the moment you expand.'
      : 'Lets snippets paste what you last copied. Chrome asks you once.';
    $('clip-grant').textContent = granted ? 'Remove access' : 'Allow';
    $('clip-grant').dataset.granted = String(granted);
  }

  function renderBlocklist() {
    const ul = $('block-list');
    ul.textContent = '';
    for (const p of S.data.settings.blockedDomains) {
      ul.appendChild(h('li', null,
        h('span', { class: 'mono' }, p),
        h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Stop excluding ' + p, onclick: () => save({ blockedDomains: S.data.settings.blockedDomains.filter((x) => x !== p) }) }, 'Remove')));
    }
  }

  function renderSettings() {
    const s = S.data.settings;
    for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = !!s[key];
    for (const [id, key] of Object.entries(TEXTS)) if (document.activeElement !== $(id)) $(id).value = s[key] || '';
    $('s-mode').value = s.triggerMode;
    renderBlocklist();
    dateExample();
    renderClip();
  }

  /* ------------------------------- snapshots ------------------------------- */

  function renderSnapshots() {
    const ul = $('snap-list');
    ul.textContent = '';
    const snaps = S.data.snapshots;
    if (!snaps.length) {
      ul.appendChild(h('li', null, h('span', { class: 'hint' }, 'No snapshots yet. One is taken automatically before any import or bulk delete.')));
      return;
    }
    for (const sn of snaps) {
      ul.appendChild(h('li', null,
        h('span', { class: 'snap-when' }, new Date(sn.createdAt).toLocaleString()),
        h('span', { class: 'snap-reason' }, sn.reason),
        h('span', { class: 'badge' }, sn.count + ' snippet' + (sn.count === 1 ? '' : 's')),
        h('button', { class: 'btn', type: 'button', onclick: () => restore(sn) }, 'Restore'),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Download as JSON', 'aria-label': 'Download snapshot', html: icon('download'), onclick: () => downloadSnap(sn) }),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Delete snapshot', 'aria-label': 'Delete snapshot', html: icon('trash'), onclick: () => store.deleteSnapshot(sn.id) })));
    }
  }

  async function restore(sn) {
    const ok = await S.confirm({
      title: 'Restore this snapshot?',
      body: `Your library goes back to ${sn.count} snippets from ${new Date(sn.createdAt).toLocaleString()}. Your current library is saved as a snapshot first.`,
      confirm: 'Restore'
    });
    if (!ok) return;
    const n = await store.restoreSnapshot(sn.id);
    ui.toast(`Restored ${n} snippets`);
  }

  async function downloadSnap(sn) {
    const full = await store.getSnapshot(sn.id);
    if (!full) return;
    const data = formats.toJSONBackup({ settings: S.data.settings, folders: full.folders, snippets: full.snippets, stats: {} });
    const d = new Date(sn.createdAt);
    ui.download(formats.backupFilename('json', d).replace('backup', 'snapshot'), JSON.stringify(data, null, 2), 'application/json');
  }

  /* -------------------------------- wiring -------------------------------- */

  function wire() {
    for (const [id, key] of Object.entries(TOGGLES)) $(id).addEventListener('change', (e) => save({ [key]: e.target.checked }));
    for (const [id, key] of Object.entries(TEXTS)) $(id).addEventListener('input', ui.debounce((e) => save({ [key]: e.target.value.trim() }).then(dateExample), 300));
    $('s-mode').addEventListener('change', (e) => save({ triggerMode: e.target.value }));
    $('block-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = $('block-input').value.trim();
      const p = matcher.normalizePattern(raw);
      if (!p) return;
      if (!S.data.settings.blockedDomains.includes(p)) await save({ blockedDomains: S.data.settings.blockedDomains.concat([p]) });
      $('block-input').value = '';
      ui.toast('Excluded ' + p);
    });
    $('clip-grant').addEventListener('click', async () => {
      if ($('clip-grant').dataset.granted === 'true') await chrome.permissions.remove({ permissions: ['clipboardRead'] });
      else {
        const ok = await chrome.permissions.request({ permissions: ['clipboardRead'] });
        ui.toast(ok ? 'Clipboard access allowed' : 'Clipboard access not allowed');
      }
      renderClip();
    });
    $('clear-all').addEventListener('click', async () => {
      const n = S.data.snippets.length;
      if (!n) { ui.toast('Your library is already empty'); return; }
      const ok = await S.confirm({ title: `Delete all ${n} snippets?`, body: 'A snapshot is saved first. You can restore it from Snapshots at any time.', confirm: 'Delete all', danger: true });
      if (!ok) return;
      await store.clearAll();
      ui.toast('All snippets deleted', { label: 'Undo', run: S.undoLastSnapshot });
    });
    $('snap-now').addEventListener('click', async () => { await store.snapshot('Manual snapshot'); ui.toast('Snapshot saved'); });
  }

  S.renderers.settings = renderSettings;
  S.renderers.snapshots = renderSnapshots;
  (S.onReady = S.onReady || []).push(wire);
})();
