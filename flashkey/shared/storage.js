/*
 * FlashKey — storage layer (chrome.storage.local + unlimitedStorage).
 *
 * Keys in chrome.storage.local:
 *   schemaVersion  number
 *   settings       object   (see matcher.DEFAULT_SETTINGS)
 *   folders        [{id, name, icon, order}]
 *   snippets       [{id, trigger, label, body, html, isRichText, folderId, tags, enabled,
 *                    matchCase, triggerMode, pinned, useCount, createdAt, updatedAt}]
 *   snapshots      rolling ring buffer (max 5) of {id, createdAt, reason, count, snippets, folders}
 *   stats          {totalExpansions, charactersSaved}
 *   usage          {[snippetId]: count}  — written by the service worker in batches so an
 *                  expansion never rewrites the (possibly multi-MB) snippets array
 *   meta           {installedAt, lastBackupAt, backupReminderDismissedAt}
 *
 * Safety rules: never overwrite existing data on install/update, migrate
 * forward only, and snapshot before every bulk/destructive operation.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const deps = isNode
    ? { matcher: require('./matcher.js'), formats: require('./formats.js') }
    : { matcher: root.FlashKey.matcher, formats: root.FlashKey.formats };
  const mod = factory(deps);
  if (isNode) module.exports = mod;
  else (root.FlashKey = root.FlashKey || {}).storage = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';
  const { matcher, formats } = deps;

  const SCHEMA_VERSION = 1;
  const MAX_SNAPSHOTS = 5;
  const KEYS = ['schemaVersion', 'settings', 'folders', 'snippets', 'snapshots', 'stats', 'usage', 'meta'];

  const DEFAULT_FOLDERS = [
    { id: 'default', name: 'General', icon: '📁', order: 0 },
    { id: 'work', name: 'Work & Support', icon: '💼', order: 1 }
  ];

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function seedSnippets(now) {
    const t = now || Date.now();
    const mk = (trigger, label, body, folderId, tags) => ({
      id: uuid(), trigger, label, body, html: '', isRichText: false, folderId, tags, enabled: true,
      matchCase: null, triggerMode: null, pinned: false, useCount: 0, createdAt: t, updatedAt: t
    });
    return [
      mk(';date', "Today's date", '{date:MMM D, YYYY}', 'default', ['dates']),
      mk(';email', 'My email address (edit me)', 'you@example.com', 'default', ['personal']),
      mk(';meet', 'Meeting invite with fill-ins', 'Hi {input:First name},\n\nAre you free for a quick call on {choice:Day=Monday|Tuesday|Wednesday|Thursday|Friday}? Here is my link: https://meet.example.com/your-room\n\n{cursor}', 'work', ['email', 'outreach']),
      mk(';sig', 'Standard email signature', 'Best regards,\nYour Name', 'work', ['email'])
    ];
  }

  function normalizeTags(tags) {
    const arr = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
    return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
  }

  function normalizeSnippet(raw, defaults) {
    const d = defaults || {};
    const now = Date.now();
    const s = raw || {};
    return {
      id: typeof s.id === 'string' && s.id ? s.id : uuid(),
      trigger: String(s.trigger == null ? '' : s.trigger).trim(),
      label: String(s.label == null ? '' : s.label),
      body: String(s.body == null ? '' : s.body).replace(/\r\n?/g, '\n'),
      html: typeof s.html === 'string' ? s.html : '',
      isRichText: !!s.isRichText && typeof s.html === 'string' && s.html.length > 0,
      folderId: typeof s.folderId === 'string' && s.folderId ? s.folderId : d.folderId || 'default',
      tags: normalizeTags(s.tags),
      enabled: s.enabled !== false,
      matchCase: s.matchCase === true || s.matchCase === false ? s.matchCase : null,
      triggerMode: s.triggerMode === 'immediate' || s.triggerMode === 'delimiter' ? s.triggerMode : null,
      pinned: s.pinned === true,
      useCount: Number.isFinite(s.useCount) ? s.useCount : 0,
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : now,
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now
    };
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, matcher.DEFAULT_SETTINGS, raw || {});
    s.blockedDomains = Array.isArray(s.blockedDomains)
      ? [...new Set(s.blockedDomains.map((x) => String(x).trim()).filter(Boolean))]
      : [...matcher.DEFAULT_SETTINGS.blockedDomains];
    if (!['light', 'dark', 'system'].includes(s.theme)) s.theme = 'system';
    if (!['immediate', 'delimiter'].includes(s.triggerMode)) s.triggerMode = 'delimiter';
    return s;
  }

  /** Forward-only, idempotent migrations. Never drops user data. */
  function migrate(state) {
    const st = Object.assign({}, state);
    const from = Number(st.schemaVersion) || 0;
    st.settings = normalizeSettings(st.settings);
    st.folders = Array.isArray(st.folders) && st.folders.length ? st.folders : DEFAULT_FOLDERS.map((f) => Object.assign({}, f));
    if (!st.folders.some((f) => f.id === 'default')) st.folders.unshift(Object.assign({}, DEFAULT_FOLDERS[0]));
    const folderIds = new Set(st.folders.map((f) => f.id));
    st.snippets = Array.isArray(st.snippets) ? st.snippets.map((x) => {
      const n = normalizeSnippet(x);
      if (!folderIds.has(n.folderId)) n.folderId = 'default';
      return n;
    }) : [];
    st.snapshots = Array.isArray(st.snapshots) ? st.snapshots.slice(0, MAX_SNAPSHOTS) : [];
    st.stats = Object.assign({ totalExpansions: 0, charactersSaved: 0 }, st.stats || {});
    st.usage = st.usage && typeof st.usage === 'object' ? st.usage : {};
    st.meta = Object.assign({ installedAt: Date.now(), lastBackupAt: 0 }, st.meta || {});
    st.schemaVersion = Math.max(from, SCHEMA_VERSION);
    return st;
  }

  /* --------------------------- storage backend --------------------------- */

  function promisifyArea(area) {
    // chrome.storage in MV3 already returns promises; tests pass a plain object area.
    return {
      get: (keys) => Promise.resolve(area.get(keys)),
      set: (items) => Promise.resolve(area.set(items)),
      remove: (keys) => Promise.resolve(area.remove(keys))
    };
  }

  function createStore(rawArea) {
    const area = promisifyArea(rawArea);

    async function load() {
      const raw = await area.get(KEYS);
      return migrate(raw || {});
    }

    /** Install/update entry point. Seeds starters only when the user has no data at all. */
    async function init(opts) {
      const o = opts || {};
      const raw = (await area.get(KEYS)) || {};
      const fresh = raw.snippets === undefined;
      const st = migrate(raw);
      const write = {};
      if (fresh && o.seedIfEmpty !== false) {
        st.snippets = seedSnippets();
        write.snippets = st.snippets;
      }
      for (const k of ['schemaVersion', 'settings', 'folders', 'stats', 'meta']) {
        if (fresh || raw[k] === undefined || k === 'schemaVersion' || k === 'settings') write[k] = st[k];
      }
      if (!fresh && raw.snippets !== undefined && Number(raw.schemaVersion || 0) < SCHEMA_VERSION) write.snippets = st.snippets;
      if (raw.snapshots === undefined) write.snapshots = [];
      await area.set(write);
      return { fresh, state: st };
    }

    async function getSettings() { return normalizeSettings((await area.get('settings')).settings); }

    async function saveSettings(patch) {
      const cur = await getSettings();
      const next = normalizeSettings(Object.assign({}, cur, patch || {}));
      await area.set({ settings: next });
      return next;
    }

    async function getSnippets() { return (await load()).snippets; }

    async function snapshot(reason, stateOpt) {
      const st = stateOpt || (await load());
      const snap = {
        id: uuid(),
        createdAt: Date.now(),
        reason: String(reason || 'Manual snapshot'),
        count: st.snippets.length,
        snippets: st.snippets,
        folders: st.folders
      };
      const snapshots = [snap].concat(st.snapshots || []).slice(0, MAX_SNAPSHOTS);
      await area.set({ snapshots });
      return snap;
    }

    async function listSnapshots() {
      const { snapshots } = await area.get('snapshots');
      return (snapshots || []).map(({ id, createdAt, reason, count }) => ({ id, createdAt, reason, count }));
    }

    async function getSnapshot(id) {
      const { snapshots } = await area.get('snapshots');
      return (snapshots || []).find((s) => s.id === id) || null;
    }

    async function deleteSnapshot(id) {
      const { snapshots } = await area.get('snapshots');
      await area.set({ snapshots: (snapshots || []).filter((s) => s.id !== id) });
    }

    async function restoreSnapshot(id) {
      const st = await load();
      const snap = (st.snapshots || []).find((s) => s.id === id);
      if (!snap) throw new Error('Snapshot not found');
      await snapshot('Before restoring snapshot from ' + new Date(snap.createdAt).toLocaleString(), st);
      const restored = migrate({ snippets: snap.snippets, folders: snap.folders, settings: st.settings });
      await area.set({ snippets: restored.snippets, folders: restored.folders });
      return restored.snippets.length;
    }

    async function upsertSnippet(input) {
      const st = await load();
      const err = matcher.validateTrigger(input.trigger);
      if (err) throw new Error(err);
      const idx = st.snippets.findIndex((s) => s.id === input.id);
      const now = Date.now();
      let saved;
      if (idx >= 0) {
        saved = normalizeSnippet(Object.assign({}, st.snippets[idx], input, { updatedAt: now, createdAt: st.snippets[idx].createdAt }));
        st.snippets[idx] = saved;
      } else {
        saved = normalizeSnippet(Object.assign({}, input, { createdAt: now, updatedAt: now }));
        st.snippets.push(saved);
      }
      if (!st.folders.some((f) => f.id === saved.folderId)) saved.folderId = 'default';
      await area.set({ snippets: st.snippets });
      return saved;
    }

    /** Delete snippets. Bulk deletes (2+) are snapshotted first. */
    async function deleteSnippets(ids, opts) {
      const set = new Set(ids);
      const st = await load();
      const victims = st.snippets.filter((s) => set.has(s.id));
      if (!victims.length) return { removed: [], snapshot: null };
      const o = opts || {};
      let snap = null;
      if (o.snapshot !== false && (victims.length > 1 || o.snapshot === true)) {
        snap = await snapshot(`Before deleting ${victims.length} snippet${victims.length === 1 ? '' : 's'}`, st);
      }
      await area.set({ snippets: st.snippets.filter((s) => !set.has(s.id)) });
      return { removed: victims, snapshot: snap };
    }

    async function restoreSnippets(list) {
      const st = await load();
      const ids = new Set(st.snippets.map((s) => s.id));
      for (const s of list) if (!ids.has(s.id)) st.snippets.push(normalizeSnippet(s));
      await area.set({ snippets: st.snippets });
    }

    async function bulkUpdate(ids, patch) {
      const set = new Set(ids);
      const st = await load();
      const now = Date.now();
      st.snippets = st.snippets.map((s) => (set.has(s.id) ? normalizeSnippet(Object.assign({}, s, patch, { id: s.id, updatedAt: now })) : s));
      await area.set({ snippets: st.snippets });
      return st.snippets.filter((s) => set.has(s.id)).length;
    }

    async function saveFolder(folder) {
      const st = await load();
      const name = String(folder.name || '').trim();
      if (!name) throw new Error('Folder name is required.');
      const idx = st.folders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) st.folders[idx] = Object.assign({}, st.folders[idx], { name, icon: folder.icon || st.folders[idx].icon });
      else st.folders.push({ id: uuid(), name, icon: folder.icon || '📁', order: st.folders.length });
      await area.set({ folders: st.folders });
      return st.folders;
    }

    /** Remove a folder; its snippets move to General unless deleteSnippets is set. */
    async function deleteFolder(id, opts) {
      if (id === 'default') throw new Error('The General folder cannot be deleted.');
      const o = opts || {};
      const st = await load();
      const inside = st.snippets.filter((s) => s.folderId === id);
      if (inside.length) await snapshot(`Before deleting folder "${(st.folders.find((f) => f.id === id) || {}).name || id}"`, st);
      const snippets = o.deleteSnippets ? st.snippets.filter((s) => s.folderId !== id) : st.snippets.map((s) => (s.folderId === id ? Object.assign({}, s, { folderId: 'default' }) : s));
      await area.set({ folders: st.folders.filter((f) => f.id !== id), snippets });
    }

    async function clearAll() {
      const st = await load();
      await snapshot('Before clearing all snippets', st);
      await area.set({ snippets: [] });
    }

    /**
     * Commit an import.
     * @param {Array} incoming raw snippets from formats.parseImport()
     * @param {{mode:'merge'|'replace', conflict:'skip'|'overwrite'|'keep', targetFolderId?:string,
     *          folders?:Array, settings?:object}} opts
     */
    async function importSnippets(incoming, opts) {
      const o = Object.assign({ mode: 'merge', conflict: 'skip' }, opts || {});
      const st = await load();
      const snap = await snapshot(`Before ${o.mode === 'replace' ? 'replace' : 'merge'} import of ${incoming.length} snippet${incoming.length === 1 ? '' : 's'}`, st);
      let folders = st.folders.map((f) => Object.assign({}, f));
      const byName = new Map(folders.map((f) => [f.name.toLowerCase(), f]));
      const byId = new Map(folders.map((f) => [f.id, f]));

      // Native backups carry folder ids — restore those folders first.
      for (const f of o.folders || []) {
        if (!f || !f.name) continue;
        if (!byId.has(f.id) && !byName.has(String(f.name).toLowerCase())) {
          const nf = { id: f.id || uuid(), name: String(f.name), icon: f.icon || '📁', order: folders.length };
          folders.push(nf); byId.set(nf.id, nf); byName.set(nf.name.toLowerCase(), nf);
        }
      }
      const folderFor = (raw) => {
        if (o.targetFolderId && byId.has(o.targetFolderId)) return o.targetFolderId;
        if (raw.folderId && byId.has(raw.folderId)) return raw.folderId;
        const name = String(raw.folder || '').trim();
        if (!name) return 'default';
        let f = byName.get(name.toLowerCase());
        if (!f) {
          f = { id: uuid(), name, icon: '📁', order: folders.length };
          folders.push(f); byName.set(name.toLowerCase(), f); byId.set(f.id, f);
        }
        return f.id;
      };

      const base = o.mode === 'replace' ? [] : st.snippets.slice();
      const index = new Map(base.map((s, i) => [s.trigger.toLowerCase(), i]));
      const ids = new Set(base.map((s) => s.id));
      const report = { added: 0, overwritten: 0, skipped: 0, renamed: 0, invalid: 0, snapshotId: snap.id };
      const now = Date.now();

      for (const raw of incoming) {
        const trigger = String(raw.trigger || '').trim();
        if (matcher.validateTrigger(trigger)) { report.invalid++; continue; }
        const n = normalizeSnippet(Object.assign({}, raw, { trigger, folderId: folderFor(raw), updatedAt: raw.updatedAt || now }));
        if (ids.has(n.id)) n.id = uuid();
        const key = trigger.toLowerCase();
        if (index.has(key)) {
          if (o.conflict === 'skip') { report.skipped++; continue; }
          if (o.conflict === 'overwrite') {
            const i = index.get(key);
            n.id = base[i].id;
            n.createdAt = base[i].createdAt;
            base[i] = n;
            report.overwritten++;
            continue;
          }
          // keep both: give the incoming one a unique trigger
          let k = 2;
          let candidate = trigger + '-' + k;
          while (index.has(candidate.toLowerCase())) candidate = trigger + '-' + ++k;
          n.trigger = candidate;
          report.renamed++;
        }
        index.set(n.trigger.toLowerCase(), base.length);
        ids.add(n.id);
        base.push(n);
        report.added++;
      }
      const write = { snippets: base, folders };
      if (o.settings) write.settings = normalizeSettings(Object.assign({}, st.settings, o.settings));
      await area.set(write);
      report.total = base.length;
      return report;
    }

    async function exportBackup() {
      const st = await load();
      return formats.toJSONBackup(st);
    }

    async function markBackedUp() {
      const st = await load();
      await area.set({ meta: Object.assign({}, st.meta, { lastBackupAt: Date.now() }) });
    }

    async function setMeta(patch) {
      const st = await load();
      await area.set({ meta: Object.assign({}, st.meta, patch) });
    }

    /** Apply a batch of usage increments (called by the service worker). */
    async function recordUsage(counts, chars) {
      const { usage, stats } = await area.get(['usage', 'stats']);
      const u = Object.assign({}, usage || {});
      let total = 0;
      for (const [id, n] of Object.entries(counts || {})) { u[id] = (u[id] || 0) + n; total += n; }
      const s = Object.assign({ totalExpansions: 0, charactersSaved: 0 }, stats || {});
      s.totalExpansions += total;
      s.charactersSaved += Math.max(0, chars || 0);
      await area.set({ usage: u, stats: s });
    }

    return {
      load, init, getSettings, saveSettings, getSnippets, upsertSnippet, deleteSnippets, restoreSnippets,
      bulkUpdate, saveFolder, deleteFolder, clearAll, importSnippets, exportBackup, markBackedUp, setMeta,
      snapshot, listSnapshots, getSnapshot, deleteSnapshot, restoreSnapshot, recordUsage
    };
  }

  return {
    SCHEMA_VERSION, MAX_SNAPSHOTS, KEYS, DEFAULT_FOLDERS,
    uuid, seedSnippets, normalizeSnippet, normalizeSettings, migrate, createStore
  };
});
