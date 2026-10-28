'use strict';
/*
 * End-to-end tests: the real unpacked extension in Chromium, against local
 * pages built with real Lexical, ProseMirror, Quill and React.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, sleep } = require('./harness.js');

let h;
const TYPE = { delay: 18 }; // a fast human typist
const STD = [
  { trigger: ';hi', body: 'Hello there' },
  { trigger: ';sig', body: 'Best regards,\nElliot' },
  { trigger: ';cur', body: 'A{cursor}B' },
  { trigger: ';meet', body: 'Hi {input:First name},\nFree on {choice:Day=Monday|Tuesday|Wednesday}?{cursor}' },
  { trigger: ';addr', body: 'Elliot{tab}Alderson{tab}India{tab}Jhansi' },
  { trigger: ';d', body: '{date:YYYY-MM-DD}' },
  { trigger: ';clip', body: '[{clipboard}]' },
  { trigger: ';rich', body: 'Bold link', isRichText: true, html: '<b>Bold</b> <a href="https://example.com" onclick="evil()">link</a><script>window.pwned=1</script><img src=x onerror="window.pwned=2"><a href="javascript:alert(1)">bad</a>' }
];

async function page(path, host) {
  const p = await h.context.newPage();
  await p.goto(h.url(path, host));
  await p.waitForLoadState('load');
  return p;
}
const val = (p, sel) => p.$eval(sel, (e) => (e.value !== undefined ? e.value : e.innerText));

test.before(async () => {
  h = await launch();
  await h.setSnippets(STD);
});
test.after(async () => { if (h) await h.close(); });
// Every test starts clean: standard snippets, default settings, only the initial tab open.
test.afterEach(async () => {
  const pages = h.context.pages();
  for (const p of pages.slice(1)) await p.close().catch(() => {});
  await h.setSnippets(STD, { triggerMode: 'delimiter', enabled: true });
  await h.setData({ snapshots: [] });
});

test('expands in <input>, <textarea>, search and email fields', async () => {
  const p = await page('basic.html');
  for (const sel of ['#text', '#ta', '#search']) {
    await p.click(sel);
    await p.keyboard.type('x ;hi y', TYPE);
    assert.equal(await val(p, sel), 'x Hello there y', sel);
  }
  await p.click('#email');
  await p.keyboard.type(';hi ', TYPE);
  await sleep(50);
  assert.equal(await val(p, '#email'), 'Hello there', 'type=email strips the space but still expands');
  assert.equal(await p.$('flashkey-ui'), null, 'no floating widgets were injected');
  await p.close();
});

test('punctuation, Caps Lock and the word-boundary rule', async () => {
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type(';hi, ;HI. word;hi ', TYPE);
  assert.equal(await val(p, '#ta'), 'Hello there, Hello there. word;hi ');
  await p.close();
});

test('{cursor} places the caret; Ctrl+Z restores the trigger', async () => {
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type(';cur ', TYPE);
  await p.keyboard.type('Z', TYPE);
  assert.equal(await val(p, '#ta'), 'AZB ');
  await p.click('#text');
  await p.keyboard.type('go ;hi ', TYPE);
  await p.keyboard.press('Control+z');
  assert.equal(await val(p, '#text'), 'go ;hi ', 'native undo brings the trigger back');
  await p.close();
});

test('plain contenteditable (Gmail-style): single and multi-line, undo', async () => {
  const p = await page('basic.html');
  await p.click('#ce');
  await p.keyboard.type('a ;hi b ;sig ', TYPE);
  await sleep(60);
  assert.equal((await val(p, '#ce')).replace(/ /g, ' '), 'a Hello there b Best regards,\nElliot ');
  await p.keyboard.press('Control+z');
  await sleep(30);
  assert.match((await val(p, '#ce')).replace(/ /g, ' '), /b ;sig ?$/);
  await p.close();
});

test('React controlled inputs keep component state in sync', async () => {
  const p = await page('react.html');
  await p.click('#r-input');
  await p.keyboard.type(';hi ', TYPE);
  await p.click('#r-ta');
  await p.keyboard.type(';sig ', TYPE);
  await sleep(50);
  const state = JSON.parse(await p.$eval('#r-state', (e) => e.textContent));
  assert.equal(state.a, 'Hello there ');
  assert.equal(state.b, 'Best regards,\nElliot ');
  await p.close();
});

test('never touches password, OTP, card, PIN, read-only or opted-out fields', async () => {
  const p = await page('basic.html');
  for (const sel of ['#pw', '#otp', '#otp2', '#mfa', '#cc', '#pin6', '#cvv', '#off']) {
    await p.click(sel);
    await p.keyboard.type(';hi ', TYPE);
    await sleep(30);
    assert.equal(await val(p, sel), ';hi ', sel);
  }
  await p.close();
});

test('Enter and Tab complete a trigger without submitting the form or leaving the field', async () => {
  const p = await page('basic.html');
  await p.click('#f1');
  await p.keyboard.type(';hi', TYPE);
  await p.keyboard.press('Enter');
  await sleep(40);
  assert.equal(await val(p, '#f1'), 'Hello there');
  assert.equal(await p.evaluate(() => window.formSubmits || 0), 0);
  await p.keyboard.type(' ;hi', TYPE);
  await p.keyboard.press('Tab');
  await sleep(40);
  assert.equal(await val(p, '#f1'), 'Hello there Hello there');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'f1');
  await p.close();
});

test('{tab} fills the following form fields, including a <select>', async () => {
  const p = await page('basic.html');
  await p.click('#f1');
  await p.keyboard.type(';addr ', TYPE);
  await sleep(80);
  assert.deepEqual(await p.evaluate(() => ['f1', 'f2', 'f3', 'f4'].map((id) => document.getElementById(id).value)), ['Elliot', 'Alderson', 'in', 'Jhansi ']);
  await p.close();
});

test('iframes: srcdoc, script-built about:blank composer (Zendesk-style), same-origin page', async () => {
  const p = await page('basic.html');
  await p.click('h1');
  for (const f of p.frames().slice(1)) {
    const sel = (await f.$('textarea')) ? 'textarea' : 'body';
    await f.click(sel);
    await p.keyboard.type(';hi ', TYPE);
    await sleep(60);
    const text = await f.$eval(sel, (e) => (e.value !== undefined ? e.value : e.innerText));
    assert.equal(text.replace(/ /g, ' '), 'Hello there ', f.url());
  }
  await p.close();
});

test('open Shadow DOM inputs inside web components', async () => {
  const p = await page('basic.html');
  await p.click('fk-field >> #inner');
  await p.keyboard.type(';hi ', TYPE);
  await p.click('fk-field >> #innerce');
  await p.keyboard.type(';hi ', TYPE);
  await sleep(60);
  assert.equal(await p.$eval('fk-field', (e) => e.shadowRoot.querySelector('#inner').value), 'Hello there ');
  assert.equal(await p.$eval('fk-field', (e) => e.shadowRoot.querySelector('#innerce').innerText.replace(/ /g, ' ')), 'Hello there ');
  await p.close();
});

for (const [name, sel, fn, submitsVar] of [
  ['Lexical (WhatsApp Web)', '#lexical', 'lexicalText', 'submits'],
  ['ProseMirror (ChatGPT-style)', '#pm .ProseMirror', 'pmText', 'pmSubmits'],
  ['Quill', '#quill .ql-editor', 'quillText', null]
]) {
  test(`${name}: single-line, multi-line without sending, Enter-trigger, {cursor}`, async () => {
    const p = await page('editors.html');
    await p.click(sel);
    await p.keyboard.type('a ;hi b ;sig ', TYPE);
    await sleep(120);
    await p.keyboard.type('c ;cur', TYPE);
    await p.keyboard.press('Enter');
    await sleep(120);
    await p.keyboard.type('Z', TYPE);
    await sleep(80);
    const text = (await p.evaluate(`window.${fn}()`)).replace(/\n+$/, '');
    assert.match(text, /^a Hello there b Best regards,\n+Elliot ?c AZB$/, JSON.stringify(text));
    if (submitsVar) assert.equal(await p.evaluate(`window.${submitsVar}`), 0, 'Enter was never sent to the chat app');
    await p.close();
  });
}

test('{input}/{choice} micro-prompt lives in a closed Shadow DOM and is keyboard-first', async () => {
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type(';meet ', TYPE);
  await p.waitForSelector('flashkey-ui', { state: 'attached' });
  assert.equal(await p.$eval('flashkey-ui', (e) => e.shadowRoot), null, 'shadow root is closed');
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('flashkey-ui')).position), 'fixed');
  await p.keyboard.type('Sarah', TYPE);
  await p.keyboard.press('Tab');
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  await sleep(80);
  assert.equal(await p.$('flashkey-ui'), null, 'prompt removed after use');
  assert.equal(await val(p, '#ta'), 'Hi Sarah,\nFree on Tuesday? ');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'ta', 'focus returned to the field');

  await p.click('#text');
  await p.keyboard.type(';meet ', TYPE);
  await p.waitForSelector('flashkey-ui', { state: 'attached' });
  await p.keyboard.press('Escape');
  await sleep(60);
  assert.equal(await val(p, '#text'), ';meet ', 'Escape cancels and leaves the trigger as typed');
  await p.close();
});

test('Quick-Picker (Ctrl+Shift+Space) searches and inserts at the caret', async () => {
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type('Note: ', TYPE);
  await p.keyboard.press('Control+Shift+Space');
  await p.waitForSelector('flashkey-ui', { state: 'attached' });
  await p.keyboard.type('signa', TYPE); // matches the body "Best regards" via label-less search
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Backspace');
  await p.keyboard.type('ig', TYPE);
  await p.keyboard.press('Enter');
  await sleep(80);
  assert.equal(await val(p, '#ta'), 'Note: Best regards,\nElliot');
  await p.close();
});

test('rich-text snippets keep formatting and are strictly sanitised', async () => {
  const p = await page('basic.html');
  await p.click('#ce');
  await p.keyboard.type(';rich ', TYPE);
  await sleep(80);
  const html = await p.$eval('#ce', (e) => e.innerHTML);
  assert.match(html, /<b>Bold<\/b>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.ok(!/script|onerror|onclick|javascript:|<img/i.test(html), html);
  assert.equal(await p.evaluate(() => window.pwned), undefined);
  await p.click('#ta');
  await p.keyboard.type(';rich ', TYPE);
  assert.equal(await val(p, '#ta'), 'Bold link ', 'plain fields get the plain-text version');
  await p.close();
});

test('{date} and {clipboard} variables', async () => {
  await h.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${h.port}` });
  const p = await page('basic.html');
  await p.evaluate(() => navigator.clipboard.writeText('from clipboard'));
  await p.click('#ta');
  await p.keyboard.type(';d ;clip ', TYPE);
  await sleep(300);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(await val(p, '#ta'), `${today} [from clipboard] `);
  await p.close();
});

test('immediate mode expands without a delimiter', async () => {
  await h.setSnippets(STD, { triggerMode: 'immediate' });
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type('x ;hi!', TYPE);
  assert.equal(await val(p, '#ta'), 'x Hello there!');
  await p.close();
  await h.setSnippets(STD);
});

test('blocklist, per-site pause and the global switch', async () => {
  await h.setSnippets(STD, { blockedDomains: ['127.0.0.1'] });
  let p = await page('basic.html', '127.0.0.1');
  await p.click('#ta');
  await p.keyboard.type(';hi ', TYPE);
  await sleep(50);
  assert.equal(await val(p, '#ta'), ';hi ', 'blocked host');
  const frame = p.frames().find((f) => f.url().endsWith('frame.html'));
  await frame.click('textarea');
  await p.keyboard.type(';hi ', TYPE);
  await sleep(50);
  assert.equal(await frame.$eval('textarea', (e) => e.value), ';hi ', 'iframes on a blocked page stay quiet');
  await p.close();
  p = await page('basic.html', 'localhost');
  await p.click('#ta');
  await p.keyboard.type(';hi ', TYPE);
  assert.equal(await val(p, '#ta'), 'Hello there ', 'other hosts still work');
  await h.setSnippets(STD, { enabled: false });
  await sleep(50);
  await p.keyboard.type(';hi ', TYPE);
  await sleep(50);
  assert.equal(await val(p, '#ta'), 'Hello there ;hi ', 'global off switch applies live');
  await p.close();
  await h.setSnippets(STD);
});

test('performance: 5,000 snippets, keystroke-to-expansion latency and no scroll/touch listeners', async () => {
  const many = STD.slice();
  for (let i = 0; i < 5000; i++) many.push({ trigger: ';t' + i, body: 'Template number ' + i + ' {date:YYYY}' });
  await h.setSnippets(many);
  const p = await page('basic.html');
  await p.click('#ta');
  await p.keyboard.type('warm ', TYPE);
  const samples = [];
  const engineSamples = [];
  for (const n of [17, 1234, 4999, 2500, 3]) {
    await p.evaluate(() => {
      const ta = document.getElementById('ta');
      window.__t0 = 0; window.__t1 = 0;
      ta.addEventListener('keydown', function kd(e) { if (e.key === ' ') { window.__t0 = performance.now(); ta.removeEventListener('keydown', kd); } });
      window.__ti = 0;
      ta.addEventListener('input', function on() {
        if (!window.__ti && /;t\d+ $/.test(ta.value)) window.__ti = performance.now(); // the Space has landed
        if (/Template number \d+ \d{4}\s?$/.test(ta.value)) { window.__t1 = performance.now(); ta.removeEventListener('input', on); }
      });
    });
    await p.keyboard.type(';t' + n + ' ', TYPE);
    await sleep(40);
    const [ms, engine] = await p.evaluate(() => [window.__t1 - window.__t0, window.__t1 - window.__ti]);
    assert.ok(ms > 0 && engine >= 0, 'expanded');
    samples.push(ms);
    engineSamples.push(engine);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const eng = engineSamples.reduce((a, b) => a + b, 0) / engineSamples.length;
  console.log(`    with ${many.length} snippets: keydown→expanded avg ${avg.toFixed(2)} ms (max ${Math.max(...samples).toFixed(2)}); delimiter landed→expanded avg ${eng.toFixed(2)} ms`);
  assert.ok(eng < 16, 'expansion lands within one frame (16 ms) of the delimiter');
  assert.ok(avg < 25, 'average keystroke-to-expansion under 25 ms');

  // Inspect the extension's own isolated world (where content scripts register listeners).
  const cdp = await h.context.newCDPSession(p);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(100);
  const mainFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const iso = contexts.find((c) => c.auxData && c.auxData.frameId === mainFrame && c.auxData.type === 'isolated' && String(c.origin || c.name).includes(h.extensionId));
  assert.ok(iso, 'found the FlashKey isolated world');
  const types = new Set();
  for (const expr of ['window', 'document']) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr, contextId: iso.id });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    listeners.forEach((l) => types.add(l.type));
  }
  assert.ok(types.has('input') && types.has('keydown'), 'engine listeners are visible to the audit');
  for (const bad of ['scroll', 'touchmove', 'touchstart', 'wheel', 'mousewheel', 'mousemove']) assert.ok(!types.has(bad), 'no ' + bad + ' listener');
  console.log('    listeners on window/document: ' + [...types].sort().join(', '));
  await p.close();
  await h.setSnippets(STD);
});

test('popup: search, quick add and insert into the focused page field', async () => {
  const target = await page('basic.html');
  await target.click('#ta');
  await sleep(100);
  const pop = await h.context.newPage();
  await pop.setViewportSize({ width: 380, height: 560 });
  await pop.goto(h.extUrl('popup/popup.html'));
  await pop.waitForSelector('.row');
  await pop.keyboard.type('sig', TYPE);
  const rows = await pop.$$eval('.row .key', (els) => els.map((e) => e.textContent));
  assert.equal(rows[0], ';sig');

  await pop.click('#add-open');
  await pop.fill('#add-trigger', ';pop');
  await pop.fill('#add-label', 'From popup');
  await pop.fill('#add-body', 'Added from the popup');
  await pop.click('#add button[type=submit]');
  await sleep(150);
  const { snippets } = await h.getData('snippets');
  const added = snippets.find((s) => s.trigger === ';pop');
  assert.ok(added, 'quick-add saved');

  const { lastFocus } = await h.sw.evaluate(() => chrome.storage.session.get('lastFocus'));
  const tabId = lastFocus.tabId;
  await pop.evaluate(([tabId, id]) => chrome.runtime.sendMessage({ type: 'fk:insertInTab', tabId, id }), [tabId, added.id]);
  await sleep(1100);
  assert.equal(await val(target, '#ta'), 'Added from the popup');
  await pop.close();
  await target.close();
  await h.setSnippets(STD);
});

test('Studio: live test sandbox expands the unsaved draft, then saves it', async () => {
  const s = await h.context.newPage();
  await s.goto(h.extUrl('options/options.html'));
  await s.click('#new-snippet');
  await s.fill('#f-trigger', ';fresh');
  await s.fill('#f-label', 'Fresh one');
  await s.fill('#f-body', 'Fresh text {date:YYYY}');
  await sleep(200);
  await s.click('#sandbox-text');
  await s.keyboard.type('try ;fresh ', TYPE);
  await sleep(80);
  assert.equal(await val(s, '#sandbox-text'), `try Fresh text ${new Date().getFullYear()} `);
  await s.click('#sandbox-rich');
  await s.keyboard.type(';hi ', TYPE);
  await sleep(80);
  assert.equal((await val(s, '#sandbox-rich')).replace(/ /g, ' '), 'Hello there ');
  await s.click('#search');
  await s.keyboard.type(';hi ', TYPE);
  assert.equal(await val(s, '#search'), ';hi ', 'the Studio itself only expands inside the sandbox');
  await s.fill('#search', '');
  await s.keyboard.press('Control+s');
  await sleep(150);
  const { snippets } = await h.getData('snippets');
  assert.ok(snippets.some((x) => x.trigger === ';fresh' && x.label === 'Fresh one'));
  await s.close();
  await h.setSnippets(STD);
});

test('Studio: CSV import with preview, automatic snapshot and one-click undo', async () => {
  const s = await h.context.newPage();
  await s.goto(h.extUrl('options/options.html#import'));
  const csv = 'Shortcut,Expansion,Title,Category\n//zoom,https://zoom.us/j/1,Zoom,Meetings\n;hi,Overwritten?,Hi,\n"/multi","Line 1\nLine 2",Multi,Meetings\n';
  await s.setInputFiles('#file', { name: 'magical-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await s.waitForSelector('#preview:not([hidden])');
  assert.match(await s.textContent('#pv-summary'), /Found 3 snippets.*1 trigger already exists/);
  await s.click('#pv-commit');
  await s.waitForSelector('.toast');
  let data = await h.getData(['snippets', 'snapshots', 'folders']);
  assert.equal(data.snippets.length, STD.length + 2, 'conflict skipped by default');
  assert.equal(data.snapshots.length, 1);
  assert.ok(data.folders.some((f) => f.name === 'Meetings'));
  await s.click('.toast button');
  await sleep(200);
  data = await h.getData(['snippets']);
  assert.equal(data.snippets.length, STD.length, 'undo restored the pre-import library');
  await s.close();
});

test('Studio: AutoHotKey paste import, exports (JSON / CSV / AHK) and bulk delete with snapshot', async () => {
  const s = await h.context.newPage();
  await s.goto(h.extUrl('options/options.html#import'));
  await s.click('.paste summary');
  await s.fill('#paste', '::btw::by the way\n:*:;addr2::\n(\n12 Main St\nJhansi\n)');
  await s.click('#paste-go');
  await s.waitForSelector('#preview:not([hidden])');
  assert.match(await s.textContent('#pv-summary'), /Found 2 snippets in a AutoHotKey/);
  await s.click('#pv-commit');
  await s.waitForSelector('.toast');

  for (const [btn, re] of [['#exp-json', /"format": "flashkey-backup"/], ['#exp-csv', /^﻿trigger,label,body,folder,tags,enabled/], ['#exp-ahk', /:T:btw::by the way/]]) {
    const [dl] = await Promise.all([s.waitForEvent('download'), s.click(btn)]);
    const stream = await dl.createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk;
    assert.match(text, re, btn + ' ' + dl.suggestedFilename());
    assert.match(dl.suggestedFilename(), /^flashkey-(backup|hotstrings)-\d{4}-\d{2}-\d{2}\.(json|csv|ahk)$/);
  }

  await s.click('[data-nav="all"]');
  await s.waitForSelector('.srow');
  const before = (await h.getData('snippets')).snippets.length;
  const boxes = await s.$$('.srow-check');
  await boxes[0].check();
  await boxes[1].check();
  await s.click('#bulk-delete');
  await s.click('.dialog .btn-danger-solid');
  await sleep(200);
  const after = await h.getData(['snippets', 'snapshots']);
  assert.equal(after.snippets.length, before - 2);
  assert.match(after.snapshots[0].reason, /Before deleting 2 snippets/);
  await s.close();
  await h.setSnippets(STD);
});

test('context menu "Save selection as FlashKey snippet" opens a prefilled editor', async () => {
  await h.sw.evaluate(() => chrome.storage.session.set({ pendingDraft: { body: 'Thanks for reaching out!\nWe will reply within 24 hours.', html: '', source: 'mail.example.com' } }));
  const s = await h.context.newPage();
  await s.goto(h.extUrl('options/options.html#new-from-selection'));
  await s.waitForSelector('#edit-form:not([hidden])');
  assert.equal(await s.inputValue('#f-body'), 'Thanks for reaching out!\nWe will reply within 24 hours.');
  assert.equal(await s.inputValue('#f-label'), 'Saved from mail.example.com');
  assert.equal(await s.evaluate(() => document.activeElement.id), 'f-trigger');
  await s.close();
});

test('Studio settings: excluding a site updates the blocklist', async () => {
  const s = await h.context.newPage();
  await s.goto(h.extUrl('options/options.html#settings'));
  await s.fill('#block-input', 'https://www.Chase.com/login');
  await s.click('#block-form button');
  await sleep(150);
  const { settings } = await h.getData('settings');
  assert.ok(settings.blockedDomains.includes('chase.com'));
  await s.close();
  await h.setSnippets(STD);
});

test('no errors, CSP violations or [Violation] warnings anywhere', async () => {
  const errors = h.errors.filter((e) => !/favicon\.ico/.test(e));
  assert.deepEqual(errors, []);
});
