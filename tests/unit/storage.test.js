'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../flashkey/shared/storage.js');

/** In-memory stand-in for chrome.storage.local with the same get/set/remove contract. */
function memArea(initial) {
  const data = structuredClone(initial || {});
  return {
    data,
    get(keys) {
      const ks = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return Promise.resolve(out);
    },
    set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); return Promise.resolve(); },
    remove(keys) { for (const k of [].concat(keys)) delete data[k]; return Promise.resolve(); }
  };
}

const triggers = (list) => list.map((s) => s.trigger).sort();

test('first install seeds the 4 starter snippets; later installs never overwrite', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  const first = await store.init({ seedIfEmpty: true });
  assert.equal(first.fresh, true);
  assert.deepEqual(triggers(area.data.snippets), [';date', ';email', ';meet', ';sig']);
  assert.equal(area.data.schemaVersion, storage.SCHEMA_VERSION);
  assert.deepEqual(area.data.settings.blockedDomains.slice(0, 2), ['*.bank.*', 'duosecurity.com']);

  const sig = area.data.snippets.find((s) => s.trigger === ';sig');
  await store.upsertSnippet(Object.assign({}, sig, { body: 'Cheers,\nElliot' }));
  await store.saveSettings({ theme: 'dark' });
  const again = await store.init({ seedIfEmpty: true });
  assert.equal(again.fresh, false);
  assert.equal(area.data.snippets.length, 4);
  assert.equal(area.data.snippets.find((s) => s.trigger === ';sig').body, 'Cheers,\nElliot');
  assert.equal(area.data.settings.theme, 'dark');
});

test('a user who deleted everything is not re-seeded on update', async () => {
  const area = memArea({ snippets: [], schemaVersion: 1 });
  await storage.createStore(area).init({ seedIfEmpty: true });
  assert.deepEqual(area.data.snippets, []);
});

test('migration normalises legacy/partial records without losing data', () => {
  const st = storage.migrate({
    settings: { theme: 'neon', blockedDomains: ['a.com', 'a.com', ' '] },
    folders: [{ id: 'w', name: 'Work' }],
    snippets: [{ trigger: ' ;x ', body: 'line1\r\nline2', folderId: 'gone', tags: 'a, b,,a' }]
  });
  assert.equal(st.settings.theme, 'system');
  assert.deepEqual(st.settings.blockedDomains, ['a.com']);
  assert.ok(st.folders.some((f) => f.id === 'default'), 'General folder always exists');
  const s = st.snippets[0];
  assert.equal(s.trigger, ';x');
  assert.equal(s.body, 'line1\nline2');
  assert.equal(s.folderId, 'default', 'orphaned snippets land in General');
  assert.deepEqual(s.tags, ['a', 'b']);
  assert.ok(s.id && s.createdAt && s.enabled === true);
});

test('snapshots are a rolling buffer of the 5 most recent', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  await store.init();
  for (let i = 1; i <= 7; i++) await store.snapshot('snap ' + i);
  const list = await store.listSnapshots();
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((s) => s.reason), ['snap 7', 'snap 6', 'snap 5', 'snap 4', 'snap 3']);
  assert.equal(list[0].count, 4);
});

test('bulk delete is snapshotted and fully reversible; single delete can be undone', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  await store.init();
  const ids = area.data.snippets.map((s) => s.id);
  const res = await store.deleteSnippets(ids.slice(0, 3));
  assert.ok(res.snapshot, 'snapshot taken before bulk delete');
  assert.equal(area.data.snippets.length, 1);
  const restored = await store.restoreSnapshot(res.snapshot.id);
  assert.equal(restored, 4);
  assert.equal(area.data.snippets.length, 4);
  assert.match((await store.listSnapshots())[0].reason, /Before restoring/, 'restoring snapshots the current state first');

  const single = await store.deleteSnippets([ids[3]], { snapshot: false });
  assert.equal(single.snapshot, null);
  await store.restoreSnippets(single.removed);
  assert.equal(area.data.snippets.length, 4);
});

test('clear all and folder deletion are snapshotted', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  await store.init();
  await store.deleteFolder('work');
  assert.ok(area.data.snippets.every((s) => s.folderId === 'default'), 'snippets moved to General');
  assert.match((await store.listSnapshots())[0].reason, /Before deleting folder/);
  await assert.rejects(store.deleteFolder('default'));
  await store.clearAll();
  assert.equal(area.data.snippets.length, 0);
  const snap = (await store.listSnapshots())[0];
  assert.match(snap.reason, /clearing/);
  await store.restoreSnapshot(snap.id);
  assert.equal(area.data.snippets.length, 4);
});

test('import: merge with skip / overwrite / keep-both, replace, invalid rows, folders', async () => {
  const incoming = [
    { trigger: ';sig', body: 'Imported signature', folder: 'Imported' },
    { trigger: ';new', body: 'Brand new', folder: 'Imported' },
    { trigger: 'bad trigger', body: 'x' },
    { trigger: '', body: 'x' }
  ];
  const run = async (opts) => {
    const area = memArea();
    const store = storage.createStore(area);
    await store.init();
    const report = await store.importSnippets(incoming, opts);
    return { area, store, report };
  };

  let { area, report } = await run({ mode: 'merge', conflict: 'skip' });
  assert.deepEqual([report.added, report.skipped, report.invalid], [1, 1, 2]);
  assert.equal(area.data.snippets.find((s) => s.trigger === ';sig').body, 'Best regards,\nYour Name');
  const folder = area.data.folders.find((f) => f.name === 'Imported');
  assert.ok(folder, 'folder created by name');
  assert.equal(area.data.snippets.find((s) => s.trigger === ';new').folderId, folder.id);

  ({ area, report } = await run({ mode: 'merge', conflict: 'overwrite' }));
  assert.equal(report.overwritten, 1);
  assert.equal(area.data.snippets.filter((s) => s.trigger === ';sig').length, 1);
  assert.equal(area.data.snippets.find((s) => s.trigger === ';sig').body, 'Imported signature');

  ({ area, report } = await run({ mode: 'merge', conflict: 'keep' }));
  assert.equal(report.renamed, 1);
  assert.ok(area.data.snippets.some((s) => s.trigger === ';sig-2' && s.body === 'Imported signature'));

  const replaced = await run({ mode: 'replace', targetFolderId: 'work' });
  assert.deepEqual(triggers(replaced.area.data.snippets), [';new', ';sig']);
  assert.ok(replaced.area.data.snippets.every((s) => s.folderId === 'work'), 'target folder honoured');
  // Undo = restore the automatic pre-import snapshot.
  await replaced.store.restoreSnapshot(replaced.report.snapshotId);
  assert.deepEqual(triggers(replaced.area.data.snippets), [';date', ';email', ';meet', ';sig']);
});

test('import of a native backup restores folders by id and optionally settings', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  await store.init();
  await store.importSnippets([{ trigger: ';z', body: 'Z', folderId: 'f-1' }], {
    mode: 'merge', folders: [{ id: 'f-1', name: 'Clinic notes', icon: '🩺' }], settings: { theme: 'dark', caseSensitive: true }
  });
  const z = area.data.snippets.find((s) => s.trigger === ';z');
  assert.equal(z.folderId, 'f-1');
  assert.equal(area.data.folders.find((f) => f.id === 'f-1').name, 'Clinic notes');
  assert.equal(area.data.settings.theme, 'dark');
  assert.equal(area.data.settings.caseSensitive, true);
});

test('upsert validates triggers; usage stats batch into separate keys', async () => {
  const area = memArea();
  const store = storage.createStore(area);
  await store.init();
  await assert.rejects(store.upsertSnippet({ trigger: 'has space', body: 'x' }), /spaces/);
  const created = await store.upsertSnippet({ trigger: ';ok', body: 'fine' });
  const updated = await store.upsertSnippet({ id: created.id, trigger: ';ok', body: 'changed' });
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(area.data.snippets.filter((s) => s.trigger === ';ok').length, 1);
  const before = JSON.stringify(area.data.snippets);
  await store.recordUsage({ [created.id]: 3 }, 120);
  await store.recordUsage({ [created.id]: 1 }, 30);
  assert.equal(area.data.usage[created.id], 4);
  assert.deepEqual(area.data.stats, { totalExpansions: 4, charactersSaved: 150 });
  assert.equal(JSON.stringify(area.data.snippets), before, 'expansions never rewrite the snippets array');
  const backup = await store.exportBackup();
  assert.equal(backup.snippets.find((s) => s.id === created.id).useCount, 4);
});
