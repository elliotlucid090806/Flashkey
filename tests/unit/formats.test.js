'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../flashkey/shared/formats.js');

const TRICKY = [
  { trigger: ';sig', label: 'Signature', body: 'Best regards,\nElliot', folder: 'Work & Support', tags: ['email', 'outreach'], enabled: true },
  { trigger: ';q', label: 'Quotes "inside", commas', body: 'He said "hi", then left;\r\nnext line', folder: 'General', tags: [], enabled: false },
  { trigger: ';uni', label: 'Unicode', body: 'नमस्ते 🙏 — café, naïve, 日本語', folder: 'Intl', tags: ['हिंदी'], enabled: true },
  { trigger: ';sp', label: '', body: '  leading and trailing spaces  ', folder: '', tags: [], enabled: true },
  { trigger: ';code', label: 'Code', body: 'function f() { return {a: 1}; } // `tick` 100% ; done\n\ttabbed', folder: 'Dev', tags: ['js'], enabled: true },
  { trigger: '::ahk', label: 'Colons', body: 'x', folder: '', tags: [], enabled: true },
  { trigger: ';vars', label: 'Variables', body: 'Hi {input:Name}, see you {date+7d:dddd}. {cursor}', folder: '', tags: [], enabled: true }
];
const norm = (s) => s.replace(/\r\n?/g, '\n');

/* --------------------------------- CSV --------------------------------- */

test('RFC-4180 parser: quotes, escaped quotes, embedded newlines, CRLF, BOM, empty fields', () => {
  const csv = '﻿trigger,body,label\r\n";a","say ""hi""",\r\n;b,"multi\r\nline, with comma",B\n;c,,C';
  assert.deepEqual(f.parseCSV(csv), [['trigger', 'body', 'label'], [';a', 'say "hi"', ''], [';b', 'multi\r\nline, with comma', 'B'], [';c', '', 'C']]);
});

test('delimiter detection: comma, tab, semicolon', () => {
  assert.equal(f.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(f.detectDelimiter('a\tb\tc'), '\t');
  assert.equal(f.detectDelimiter('a;b;c\n"x,y";2;3'), ';');
  assert.equal(f.detectDelimiter('"a;b",c'), ',');
});

test('CSV export → import round-trip is lossless', () => {
  const folders = [{ id: 'w', name: 'Work & Support' }, { id: 'g', name: 'General' }, { id: 'i', name: 'Intl' }, { id: 'd', name: 'Dev' }];
  const byName = Object.fromEntries(folders.map((x) => [x.name, x.id]));
  const snippets = TRICKY.map((s) => Object.assign({}, s, { folderId: byName[s.folder] || 'none' }));
  const csv = f.toCSV(snippets, folders);
  assert.ok(csv.startsWith('﻿trigger,label,body,folder,tags,enabled\r\n'), 'Excel-friendly BOM + header');
  const back = f.parseImport(csv, { filename: 'export.csv' });
  assert.equal(back.format, 'csv');
  assert.equal(back.snippets.length, TRICKY.length);
  back.snippets.forEach((s, i) => {
    const want = TRICKY[i];
    assert.equal(s.trigger, want.trigger);
    assert.equal(s.label, want.label);
    assert.equal(s.body, want.body, 'body #' + i);
    assert.equal(s.folder, want.folder);
    assert.deepEqual(s.tags, want.tags);
    assert.equal(s.enabled, want.enabled);
  });
});

test('CSV with competitor column names maps automatically', () => {
  const csv = 'Shortcut,Expansion,Name,Category,Labels\n//zoom,https://zoom.us/j/1,Zoom link,Meetings,"calls, links"\n';
  const out = f.parseImport(csv, { filename: 'magical.csv' });
  assert.equal(out.needsMapping, false);
  assert.deepEqual(out.snippets[0], { trigger: '//zoom', label: 'Zoom link', body: 'https://zoom.us/j/1', html: '', isRichText: false, folder: 'Meetings', tags: ['calls', 'links'], enabled: true });
});

test('CSV without a header row and TSV files', () => {
  const out = f.parseImport(';a,Alpha\n;b,Beta', { filename: 'plain.csv' });
  assert.deepEqual(out.snippets.map((s) => [s.trigger, s.body]), [[';a', 'Alpha'], [';b', 'Beta']]);
  assert.ok(out.warnings.length);
  const tsv = f.parseImport('abbr\ttext\n;t\tTab, separated "value"', { filename: 'x.tsv' });
  assert.equal(tsv.format, 'tsv');
  assert.equal(tsv.snippets[0].body, 'Tab, separated "value"');
});

test('CSV with unknown headers asks for a column mapping, then applies it', () => {
  const out = f.parseImport('Shortcut,Foo,Bar\n;x,hello,lbl\n', { filename: 'odd.csv' });
  assert.equal(out.needsMapping, true);
  assert.equal(out.snippets.length, 0);
  const mapped = f.rowsToSnippets(out.rows, { trigger: 0, body: 1, label: 2 });
  assert.deepEqual(mapped.map((s) => [s.trigger, s.body, s.label]), [[';x', 'hello', 'lbl']]);
});

/* -------------------------------- JSON -------------------------------- */

test('FlashKey JSON backup round-trip keeps folders, settings and usage', () => {
  const state = {
    schemaVersion: 1,
    settings: { theme: 'dark', blockedDomains: ['x.com'] },
    folders: [{ id: 'default', name: 'General' }, { id: 'w', name: 'Work' }],
    snippets: [{ id: 'a', trigger: ';a', body: 'A', folderId: 'w', useCount: 2, tags: ['t'] }],
    usage: { a: 3 },
    stats: { totalExpansions: 5 }
  };
  const backup = f.toJSONBackup(state);
  assert.equal(backup.format, 'flashkey-backup');
  assert.equal(backup.snippets[0].useCount, 5, 'pending usage merged into export');
  const back = f.parseImport(JSON.stringify(backup), { filename: 'flashkey-backup-2026-10-28.json' });
  assert.equal(back.format, 'flashkey');
  assert.equal(back.snippets[0].folder, 'Work');
  assert.equal(back.settings.theme, 'dark');
  assert.equal(back.folders.length, 2);
  assert.equal(f.backupFilename('json', new Date(2026, 9, 28)), 'flashkey-backup-2026-10-28.json');
});

test('Text Blaze-style nested folders, rich text and form fields', () => {
  const tb = {
    version: 2,
    folders: [{
      name: 'Support',
      snippets: [
        { name: 'Greeting', shortcut: '/hi', text: 'Hello {formtext: name=Customer; default=there}, ticket due {time: YYYY-MM-DD; shift=+3D}', html: '<p>Hello <b>there</b></p>' },
        { name: 'Priority', shortcut: '/pri', text: 'Priority: {formmenu: default=Low; Medium; High; name=Level}' }
      ]
    }]
  };
  const out = f.parseImport(JSON.stringify(tb), { filename: 'textblaze.json' });
  assert.equal(out.format, 'textblaze');
  assert.equal(out.snippets.length, 2);
  const [a, b] = out.snippets;
  assert.equal(a.trigger, '/hi');
  assert.equal(a.label, 'Greeting');
  assert.equal(a.folder, 'Support');
  assert.equal(a.body, 'Hello {input:Customer=there}, ticket due {date+3d:YYYY-MM-DD}');
  assert.ok(a.isRichText && a.html.includes('<b>there</b>'));
  assert.equal(b.body, 'Priority: {choice:Level=Low|Medium|High}');
  assert.equal(f.convertForeignPlaceholders('{time:HH:mm}'), '{time:HH:mm}', "FlashKey's own {time:...} is untouched");
});

test('Magical-style flat array and ProKeys nested arrays', () => {
  const magical = [{ title: 'Zoom', shortcut: '//zoom', template: 'https://zoom.us/j/123', tags: 'links;meetings' }];
  const m = f.parseImport(JSON.stringify(magical));
  assert.deepEqual([m.snippets[0].trigger, m.snippets[0].label, m.snippets[0].body, m.snippets[0].tags], ['//zoom', 'Zoom', 'https://zoom.us/j/123', ['links', 'meetings']]);
  const prokeys = ['Snippets', 1600000000000, { name: 'brb', body: 'be right back', timestamp: 1 }, ['Work', 1600000000001, { name: 'sig', body: 'Regards', timestamp: 2 }]];
  const p = f.parseImport(JSON.stringify(prokeys));
  assert.equal(p.format, 'prokeys');
  assert.deepEqual(p.snippets.map((s) => [s.trigger, s.body, s.folder]), [['brb', 'be right back', ''], ['sig', 'Regards', 'Work']]);
});

test('Auto Text Expander style key → text map', () => {
  const out = f.parseImport('{"btw":"by the way","omw":"on my way!"}');
  assert.equal(out.format, 'json-map');
  assert.deepEqual(out.snippets.map((s) => [s.trigger, s.body]), [['btw', 'by the way'], ['omw', 'on my way!']]);
});

test('broken JSON produces a readable error instead of throwing', () => {
  const out = f.parseImport('{"nope": ', { filename: 'bad.json' });
  assert.equal(out.snippets.length, 0);
  assert.match(out.warnings[0], /Could not read/);
});

/* --------------------------- AutoHotKey (.ahk) --------------------------- */

test('AHK parser: single-line, options, comments, escapes, continuation and Send blocks', () => {
  const ahk = [
    '; my hotstrings',
    '#Hotstring EndChars -()[]{}:;',
    '::btw::by the way',
    ':*:;sig::Best regards ; trailing comment',
    ':C:Abc::Case matters',
    '::semi::a`; b',
    '::nl::line1`nline2',
    '::x::;literal semicolon right after the colons',
    '/* block',
    '::hidden::should not import',
    '*/',
    '::addr::',
    '(LTrim',
    '    12 Main St',
    '    Jhansi',
    ')',
    '::sendit::',
    'SendInput, Hello{Enter}World{Tab}Next',
    'return',
    ':X:run::Run notepad.exe',
    '::braces::{{}x{}}'
  ].join('\r\n');
  const out = f.parseImport(ahk, { filename: 'hotstrings.ahk' });
  const get = (t) => out.snippets.find((s) => s.trigger === t);
  assert.equal(out.format, 'ahk');
  assert.equal(get('btw').body, 'by the way');
  assert.equal(get(';sig').body, 'Best regards');
  assert.equal(get(';sig').triggerMode, 'immediate');
  assert.equal(get('Abc').matchCase, true);
  assert.equal(get('semi').body, 'a; b');
  assert.equal(get('nl').body, 'line1\nline2');
  assert.equal(get('x').body, ';literal semicolon right after the colons');
  assert.equal(get('hidden'), undefined);
  assert.equal(get('addr').body, '12 Main St\nJhansi');
  assert.equal(get('sendit').body, 'Hello\nWorld{tab}Next');
  assert.equal(get('run'), undefined);
  assert.ok(out.warnings.some((w) => /run/.test(w)));
  assert.equal(get('braces').body, '{x}');
});

test('AHK export → import round-trip', () => {
  const list = TRICKY.filter((s) => !/[\s:]/.test(s.trigger)).map((s) => Object.assign({}, s, { body: norm(s.body) }));
  list.push({ trigger: 'imm', body: 'fast', triggerMode: 'immediate', matchCase: true });
  list.push({ trigger: 'paren', body: 'line\n) starts with paren\nend' });
  const ahk = f.toAHK(list);
  assert.ok(!/:[^:]*:::ahk::/.test(ahk), 'triggers containing colons are skipped');
  const back = f.parseImport(ahk, { filename: 'out.ahk' });
  assert.equal(back.snippets.length, list.length);
  back.snippets.forEach((s, i) => {
    assert.equal(s.trigger, list[i].trigger);
    assert.equal(s.body, list[i].body, 'body of ' + list[i].trigger);
  });
  const imm = back.snippets.find((s) => s.trigger === 'imm');
  assert.equal(imm.triggerMode, 'immediate');
  assert.equal(imm.matchCase, true);
});

test('format detection', () => {
  assert.equal(f.detectFormat('::a::b', 'x.ahk'), 'ahk');
  assert.equal(f.detectFormat('::a::b\n:*:c::d'), 'ahk');
  assert.equal(f.detectFormat('[1,2]'), 'json');
  assert.equal(f.detectFormat('a,b\n1,2', 'x.csv'), 'csv');
  assert.equal(f.detectFormat('a\tb', 'x.tsv'), 'tsv');
  assert.equal(f.detectFormat('::a::b', 'notes.txt'), 'ahk');
});
