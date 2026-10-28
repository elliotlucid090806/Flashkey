'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../flashkey/shared/matcher.js');

const sn = (trigger, extra) => Object.assign({ id: trigger, trigger, body: 'x', enabled: true, matchCase: null, triggerMode: null }, extra || {});
const idx = (list, settings) => m.compile(list, Object.assign({ triggerMode: 'delimiter' }, settings || {}));
const hit = (index, typed, context, mode = 'delimiter') => {
  const e = m.findMatch(index, typed, context == null ? typed : context, mode);
  return e ? e.trigger : null;
};

test('compile skips disabled and invalid triggers and tracks the longest trigger', () => {
  const index = idx([sn(';sig'), sn(';off', { enabled: false }), sn('has space'), sn(''), sn(';longertrigger')]);
  assert.equal(index.count, 2);
  assert.equal(index.maxLen, ';longertrigger'.length);
});

test('delimiter mode: the token before the delimiter must be a trigger', () => {
  const index = idx([sn(';sig'), sn(';date'), sn(';datetime')]);
  assert.equal(hit(index, ';sig', 'Thanks!\n;sig'), ';sig');
  assert.equal(hit(index, ';date', 'see ;date'), ';date');
  assert.equal(hit(index, ';datetime', 'see ;datetime'), ';datetime', 'longer trigger is not shadowed');
  assert.equal(hit(index, ';dat', 'see ;dat'), null);
  assert.equal(hit(index, ';sig', 'see ;sig', 'immediate'), null, 'delimiter snippets never fire immediately');
});

test('immediate mode and per-snippet overrides', () => {
  const index = idx([sn('btw', { triggerMode: 'immediate' }), sn(';sig')], { triggerMode: 'delimiter' });
  assert.equal(hit(index, 'btw', 'ok btw', 'immediate'), 'btw');
  assert.equal(hit(index, 'btw', 'ok btw', 'delimiter'), null);
  const all = idx([sn(';sig')], { triggerMode: 'immediate' });
  assert.equal(hit(all, ';sig', ';sig', 'immediate'), ';sig');
});

test('case: insensitive by default (Caps Lock works), sensitive on request', () => {
  assert.equal(hit(idx([sn(';sig')]), ';SIG'), ';sig');
  assert.equal(hit(idx([sn(';sig')], { caseSensitive: true }), ';SIG'), null);
  assert.equal(hit(idx([sn(';Sig', { matchCase: true })]), ';sig'), null, 'per-snippet exact case');
  assert.equal(hit(idx([sn(';sig', { matchCase: false })], { caseSensitive: true }), ';SIG'), ';sig', 'per-snippet ignore case');
});

test('word boundary: no mid-word expansion unless enabled', () => {
  const index = idx([sn(';sig'), sn('teh')]);
  assert.equal(hit(index, ';sig', 'hello;sig'), null);
  assert.equal(hit(index, ';sig', '(;sig'), ';sig');
  assert.equal(hit(index, 'teh', 'the teh'), 'teh');
  assert.equal(hit(index, 'teh', 'tteh'), null);
  assert.equal(hit(index, 'teh', 'caféteh'), null, 'Unicode letters count as word characters');
  assert.equal(hit(index, 'teh', 'कteh'), null, 'Devanagari counts as word characters');
  const inside = idx([sn(';sig'), sn('oe')], { matchInsideWords: true });
  assert.equal(hit(inside, ';sig', 'hello;sig'), ';sig');
  assert.equal(hit(inside, 'oe', 'Phoe'), 'oe', 'character replacement inside a word');
});

test('the real text before the caret must agree with what was typed', () => {
  const index = idx([sn(';sig')]);
  assert.equal(hit(index, ';sig', 'x ;sih'), null);
  assert.equal(hit(index, ';sig', ''), null);
});

test('longest trigger wins when several end the same way', () => {
  const index = idx([sn('g'), sn(';sig'), sn('sig')], { matchInsideWords: true });
  assert.equal(hit(index, ';sig', ' ;sig'), ';sig');
});

test('delimiters and trigger validation', () => {
  for (const ch of [' ', '\n', '.', ',', '!', '?', ';', ':', ')', '"', "'", ' ']) assert.ok(m.isDelimiterChar(ch), JSON.stringify(ch));
  for (const ch of ['a', '/', '-', '_', '@', '#', '(', '1']) assert.ok(!m.isDelimiterChar(ch), ch);
  assert.equal(m.validateTrigger(';ok'), '');
  assert.match(m.validateTrigger('two words'), /spaces/);
  assert.match(m.validateTrigger(''), /required/);
  assert.match(m.validateTrigger('x'.repeat(65)), /64/);
});

test('conflict finder reports duplicates and immediate-mode prefixes', () => {
  const { duplicates, prefixes } = m.findConflicts([sn(';d', { triggerMode: 'immediate' }), sn(';date'), sn(';DATE'), sn(';x')]);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(prefixes.map(([a, b]) => [a.trigger, b.trigger]).sort(), [[';d', ';DATE'], [';d', ';date']]);
});

test('domain blocklist with wildcards', () => {
  assert.ok(m.hostMatches('example.com', 'example.com'));
  assert.ok(m.hostMatches('example.com', 'www.example.com'));
  assert.ok(m.hostMatches('example.com', 'mail.example.com:8443'));
  assert.ok(!m.hostMatches('example.com', 'notexample.com'));
  assert.ok(m.hostMatches('*.chase.com', 'secure.chase.com'));
  assert.ok(m.hostMatches('*.chase.com', 'chase.com'));
  assert.ok(m.hostMatches('*.bank.*', 'www.bank.com'));
  assert.ok(m.hostMatches('*.bank.*', 'bank.co.uk'));
  assert.ok(!m.hostMatches('*.bank.*', 'mybank.com'));
  assert.ok(m.hostMatches('localhost:*', 'localhost:3000'));
  assert.ok(!m.hostMatches('localhost:*', '127.0.0.1:3000'));
  assert.ok(m.hostMatches('localhost:3000', 'localhost:3000'));
  assert.ok(!m.hostMatches('localhost:3000', 'localhost:5173'));
  assert.ok(m.hostMatches('https://Example.com/login?x=1', 'example.com'), 'pasted URLs are normalised');
  assert.ok(m.isBlocked(['zendesk.com'], ['', 'acme.zendesk.com']), 'an about:blank frame inherits its ancestors');
  assert.ok(!m.isBlocked([], ['example.com']));
  assert.ok(m.isBlocked(m.DEFAULT_SETTINGS.blockedDomains, ['api-1234.duosecurity.com']));
});

test('sensitive-field guard: passwords, OTP, cards and codes are never touched', () => {
  const bad = [
    { tag: 'INPUT', type: 'password' },
    { tag: 'INPUT', type: 'hidden' },
    { tag: 'INPUT', type: 'text', autocomplete: 'one-time-code' },
    { tag: 'INPUT', type: 'text', autocomplete: 'cc-number' },
    { tag: 'INPUT', type: 'text', autocomplete: 'section-pay cc-csc' },
    { tag: 'INPUT', type: 'text', autocomplete: 'current-password' },
    { tag: 'INPUT', type: 'text', name: 'otp_code' },
    { tag: 'INPUT', type: 'text', name: 'mfaCode' },
    { tag: 'INPUT', type: 'text', id: 'totp' },
    { tag: 'INPUT', type: 'text', name: 'card_cvv' },
    { tag: 'INPUT', type: 'text', name: 'ssn' },
    { tag: 'INPUT', type: 'text', name: 'login_2fa' },
    { tag: 'INPUT', type: 'tel', name: 'passcode' },
    { tag: 'INPUT', type: 'text', ariaLabel: 'Verification code' },
    { tag: 'INPUT', type: 'text', placeholder: 'Enter one-time code' },
    { tag: 'INPUT', type: 'text', inputmode: 'numeric', maxLength: 6 },
    { tag: 'INPUT', type: 'number' },
    { tag: 'TEXTAREA', name: 'security_code' }
  ];
  for (const f of bad) assert.ok(m.sensitiveReason(f), JSON.stringify(f));
  const ok = [
    { tag: 'INPUT', type: 'text', name: 'subject' },
    { tag: 'INPUT', type: 'email', name: 'email', autocomplete: 'email' },
    { tag: 'INPUT', type: 'search', name: 'q' },
    { tag: 'INPUT', type: 'text', name: 'footprint' },
    { tag: 'INPUT', type: 'text', name: 'pincode' },
    { tag: 'INPUT', type: 'text', name: 'username', autocomplete: 'username' },
    { tag: 'INPUT', type: '', name: 'notes' },
    { tag: 'TEXTAREA', name: 'reply' },
    { tag: 'INPUT', type: 'text', inputmode: 'numeric', maxLength: 40 }
  ];
  for (const f of ok) assert.equal(m.sensitiveReason(f), '', JSON.stringify(f));
});

test('performance: 10,000 snippets compile fast and a keystroke lookup is O(1)', () => {
  const list = [];
  for (let i = 0; i < 10000; i++) list.push(sn(';s' + i.toString(36) + 'x'.repeat(i % 7), { id: 'id' + i }));
  let t0 = process.hrtime.bigint();
  const index = idx(list);
  const compileMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const typed = ['hello', list[342].trigger, 'the quick brown fox', ';zzz', list[9999].trigger, 'x', 'xxxxxx'];
  const N = 200000;
  t0 = process.hrtime.bigint();
  let found = 0;
  for (let i = 0; i < N; i++) {
    const t = typed[i % typed.length];
    if (m.findMatch(index, t, ' ' + t, 'delimiter')) found++;
  }
  const perLookupUs = Number(process.hrtime.bigint() - t0) / 1e3 / N;
  console.log(`    compile 10k: ${compileMs.toFixed(1)} ms · lookup: ${perLookupUs.toFixed(3)} µs/keystroke · hits ${found}`);
  assert.ok(compileMs < 250, 'compile under 250 ms');
  assert.ok(perLookupUs < 10, 'lookup under 10 µs (target budget is 2 ms)');
  assert.ok(found > 0);
});
