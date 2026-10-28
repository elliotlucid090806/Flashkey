/* FlashKey Studio — anti-hostage import (with preview) and one-click exports. */
(() => {
  'use strict';
  const S = window.Studio;
  const { matcher, vars, formats, ui } = FlashKey;
  const { h } = ui;
  const { $, store } = S;

  const FORMAT_NAMES = {
    flashkey: 'FlashKey backup', 'json-map': 'shortcut → text JSON (Auto Text Expander style)', textblaze: 'Text Blaze JSON',
    prokeys: 'ProKeys JSON', json: 'JSON', csv: 'CSV spreadsheet', tsv: 'TSV spreadsheet', ahk: 'AutoHotKey script'
  };
  const FIELDS = [['trigger', 'Trigger'], ['body', 'Text'], ['label', 'Label'], ['folder', 'Folder'], ['tags', 'Tags'], ['html', 'Rich text (HTML)']];

  const I = { parsed: null, snippets: [], source: '' };

  /* ------------------------------- export ------------------------------- */

  function renderExport() {
    const meta = S.data.meta || {};
    $('last-backup').textContent = 'Last backup: ' + ui.timeAgo(meta.lastBackupAt);
  }

  function exportAHK() {
    ui.download(formats.backupFilename('ahk').replace('backup', 'hotstrings'), formats.toAHK(S.data.snippets), 'text/plain;charset=utf-8');
    ui.toast(`AutoHotKey file downloaded · ${S.data.snippets.length} hotstrings`);
  }

  /* ------------------------------- import ------------------------------- */

  async function readFile(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { ui.toast('That file is over 50 MB — is it the right one?'); return; }
    const text = await file.text();
    parse(text, { filename: file.name }, file.name);
  }

  function parse(text, opts, source) {
    if (!text.trim()) { ui.toast('Nothing to import — the text is empty'); return; }
    I.parsed = formats.parseImport(text, opts);
    I.source = source || 'pasted text';
    I.snippets = I.parsed.snippets || [];
    showPreview();
  }

  function renderMapper() {
    const box = $('pv-mapper');
    const p = I.parsed;
    const isTable = (p.format === 'csv' || p.format === 'tsv') && p.headers && p.headers.length;
    box.hidden = !isTable;
    box.textContent = '';
    if (!isTable) return;
    for (const [field, label] of FIELDS) {
      const sel = h('select', { class: 'select', 'data-field': field });
      sel.appendChild(h('option', { value: '-1' }, field === 'trigger' || field === 'body' ? 'Choose a column' : 'Not used'));
      p.headers.forEach((hd, i) => sel.appendChild(h('option', { value: String(i) }, hd || 'Column ' + (i + 1))));
      sel.value = p.mapping && p.mapping[field] !== undefined ? String(p.mapping[field]) : '-1';
      sel.addEventListener('change', () => {
        const m = {};
        box.querySelectorAll('select').forEach((s) => { if (s.value !== '-1') m[s.dataset.field] = Number(s.value); });
        p.mapping = m;
        p.needsMapping = m.trigger === undefined || (m.body === undefined && m.html === undefined);
        I.snippets = p.needsMapping ? [] : formats.rowsToSnippets(p.rows, m);
        showPreview(true);
      });
      box.appendChild(h('label', { class: 'field' }, h('span', null, label), sel));
    }
  }

  function showPreview(keepMapper) {
    const p = I.parsed;
    $('preview').hidden = false;
    if (!keepMapper) renderMapper();
    const existing = new Set(S.data.snippets.map((s) => s.trigger.toLowerCase()));
    const conflicts = I.snippets.filter((s) => existing.has(String(s.trigger).toLowerCase())).length;
    const invalid = I.snippets.filter((s) => matcher.validateTrigger(s.trigger)).length;
    const n = I.snippets.length;
    $('pv-title').textContent = 'Preview: ' + I.source;
    const parts = [];
    if (p.needsMapping) parts.push('Pick which columns hold the trigger and the text.');
    else parts.push(`Found ${n} snippet${n === 1 ? '' : 's'} in a ${FORMAT_NAMES[p.format] || p.format} file.`);
    if (conflicts) parts.push(`${conflicts} trigger${conflicts === 1 ? '' : 's'} already exist${conflicts === 1 ? 's' : ''} in your library.`);
    if (invalid) parts.push(`${invalid} will be skipped (empty trigger or contains spaces).`);
    $('pv-summary').textContent = parts.join(' ');

    const warn = $('pv-warnings');
    warn.textContent = '';
    (p.warnings || []).slice(0, 8).forEach((w) => warn.appendChild(h('li', null, w)));
    if ((p.warnings || []).length > 8) warn.appendChild(h('li', null, `…and ${p.warnings.length - 8} more`));

    const fsel = $('pv-folder');
    const keep = fsel.value;
    fsel.textContent = '';
    fsel.appendChild(h('option', { value: '' }, 'Keep folders from the file'));
    for (const f of S.data.folders) fsel.appendChild(h('option', { value: f.id }, 'Put everything in ' + f.name));
    fsel.value = keep && [...fsel.options].some((o) => o.value === keep) ? keep : '';
    $('pv-settings-wrap').hidden = !(p.format === 'flashkey' && p.settings);

    const tbody = $('pv-rows');
    tbody.textContent = '';
    for (const s of I.snippets.slice(0, 200)) {
      const bad = matcher.validateTrigger(s.trigger);
      const dup = !bad && existing.has(String(s.trigger).toLowerCase());
      tbody.appendChild(h('tr', null,
        h('td', null, h('span', { class: 'key' }, String(s.trigger || '—'))),
        h('td', null, s.label || ''),
        h('td', { title: s.body }, ui.oneLine(vars.preview(s.body || ''), 90)),
        h('td', null, s.folder || ''),
        h('td', null, bad ? h('span', { class: 'invalid' }, 'Skipped') : dup ? h('span', { class: 'conflict' }, 'Exists') : '')));
    }
    if (n > 200) tbody.appendChild(h('tr', null, h('td', { colspan: '5', class: 'hint' }, `…and ${n - 200} more`)));
    $('pv-commit').textContent = `Import ${n - invalid} snippet${n - invalid === 1 ? '' : 's'}`;
    $('pv-commit').disabled = !(n - invalid > 0);
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function commit() {
    const mode = document.querySelector('[name="pv-mode"]:checked').value;
    const conflict = document.querySelector('[name="pv-conflict"]:checked').value;
    if (mode === 'replace') {
      const ok = await S.confirm({ title: `Replace your ${S.data.snippets.length} snippets?`, body: 'Your current library is saved as a snapshot first, so you can switch back from Snapshots.', confirm: 'Replace', danger: true });
      if (!ok) return;
    }
    const p = I.parsed;
    const report = await store.importSnippets(I.snippets, {
      mode, conflict,
      targetFolderId: $('pv-folder').value || undefined,
      folders: p.folders || null,
      settings: p.format === 'flashkey' && $('pv-settings').checked ? p.settings : null
    });
    const bits = [`${report.added} added`];
    if (report.overwritten) bits.push(`${report.overwritten} overwritten`);
    if (report.renamed) bits.push(`${report.renamed} renamed`);
    if (report.skipped) bits.push(`${report.skipped} skipped`);
    if (report.invalid) bits.push(`${report.invalid} invalid`);
    resetPreview();
    ui.toast('Imported · ' + bits.join(', '), { label: 'Undo', run: async () => { await store.restoreSnapshot(report.snapshotId); ui.toast('Import undone'); } });
  }

  function resetPreview() {
    I.parsed = null;
    I.snippets = [];
    $('preview').hidden = true;
    $('paste').value = '';
    $('file').value = '';
  }

  function wire() {
    const drop = $('drop');
    drop.addEventListener('click', () => $('file').click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
    $('file').addEventListener('change', (e) => readFile(e.target.files[0]));
    $('paste-go').addEventListener('click', () => parse($('paste').value, { format: $('paste-format').value }, 'pasted text'));
    $('pv-commit').addEventListener('click', commit);
    $('pv-cancel').addEventListener('click', resetPreview);
    document.querySelectorAll('[name="pv-mode"]').forEach((r) => r.addEventListener('change', () => {
      $('pv-conflict-set').disabled = document.querySelector('[name="pv-mode"]:checked').value === 'replace';
    }));
    $('exp-json').addEventListener('click', S.exportJSON);
    $('exp-csv').addEventListener('click', () => S.exportCSV());
    $('exp-ahk').addEventListener('click', exportAHK);
  }

  S.renderers.import = renderExport;
  S.importText = parse; // used by tests and drag-and-drop
  (S.onReady = S.onReady || []).push(wire);
})();
