'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vars = require('../../flashkey/shared/variables.js');

// Saturday 31 January 2026, 09:05:07 local time.
const NOW = new Date(2026, 0, 31, 9, 5, 7);
const ctx = (extra) => Object.assign({ now: NOW, locale: 'en-US' }, extra || {});
const r = (tpl, extra) => vars.resolve(tpl, ctx(extra)).text;

test('plain text and unknown tags pass through untouched', () => {
  assert.equal(r('Hello {name}, {{x}} {date+1x} {input:} {foo:bar}'), 'Hello {name}, {{x}} {date+1x} {input:} {foo:bar}');
  assert.equal(r('function f() { return {a: 1}; }'), 'function f() { return {a: 1}; }');
});

test('{date} with explicit formats', () => {
  assert.equal(r('{date:YYYY-MM-DD}'), '2026-01-31');
  assert.equal(r('{date:DD/MM/YYYY}'), '31/01/2026');
  assert.equal(r('{date:MMM D, YYYY}'), 'Jan 31, 2026');
  assert.equal(r('{date:dddd, Do MMMM YY}'), 'Saturday, 31st January 26');
  assert.equal(r('{date:[Week of] MMM D}'), 'Week of Jan 31');
  assert.equal(r('{date:M/D}'), '1/31');
  assert.equal(r('{DATE:YYYY}'), '2026', 'tag names are case-insensitive');
});

test('{date} default uses locale or the configured default format', () => {
  assert.equal(r('{date}'), '1/31/2026');
  assert.equal(r('{date}', { dateFormat: 'DD.MM.YYYY' }), '31.01.2026');
  assert.equal(r('{date}', { locale: 'en-GB' }), '31/01/2026');
});

test('relative date math: days, weeks, months, years, business days, chains', () => {
  assert.equal(r('{date+7d:YYYY-MM-DD}'), '2026-02-07');
  assert.equal(r('{date-1d:YYYY-MM-DD}'), '2026-01-30');
  assert.equal(r('{date+2w:YYYY-MM-DD}'), '2026-02-14');
  assert.equal(r('{date+1m:YYYY-MM-DD}'), '2026-02-28', 'Jan 31 + 1 month clamps to Feb 28');
  assert.equal(r('{date-2m:YYYY-MM-DD}'), '2025-11-30', 'Jan 31 - 2 months clamps to Nov 30');
  assert.equal(r('{date+1y:YYYY-MM-DD}'), '2027-01-31');
  assert.equal(r('{date+1m+2d:YYYY-MM-DD}'), '2026-03-02');
  assert.equal(r('{date+1bd:ddd YYYY-MM-DD}'), 'Mon 2026-02-02', 'Saturday + 1 business day = Monday');
  assert.equal(r('{date-1bd:ddd YYYY-MM-DD}'), 'Fri 2026-01-30');
  assert.equal(r('{date+5bd:YYYY-MM-DD}'), '2026-02-06');
  const leap = new Date(2028, 0, 31);
  assert.equal(vars.resolve('{date+1m:YYYY-MM-DD}', { now: leap }).text, '2028-02-29', 'leap year');
  assert.equal(vars.resolve('{date+1y:YYYY-MM-DD}', { now: new Date(2028, 1, 29) }).text, '2029-02-28');
  assert.equal(r('{date+365d:YYYY-MM-DD}'), '2027-01-31');
});

test('{time} and {day}', () => {
  assert.equal(r('{time:HH:mm}'), '09:05');
  assert.equal(r('{time:h:mm A}'), '9:05 AM');
  assert.equal(r('{time:HH:mm:ss}'), '09:05:07');
  assert.equal(r('{time+2h:HH:mm}'), '11:05');
  assert.equal(r('{time+30min:HH:mm}'), '09:35');
  assert.equal(r('{time+16h:hh:mm a}'), '01:05 am');
  assert.match(r('{time}'), /^0?9:05\sAM$/);
  assert.equal(r('{day}'), 'Saturday');
  assert.equal(r('{day+1d}'), 'Sunday');
  assert.equal(r('{day:ddd}'), 'Sat');
});

test('{cursor}: position of the first occurrence, tag removed', () => {
  const out = vars.resolve('Hi {cursor}there{cursor}!', ctx());
  assert.equal(out.text, 'Hi there!');
  assert.equal(out.cursor, 3);
  assert.equal(vars.resolve('No cursor', ctx()).cursor, null);
});

test('{clipboard} is inserted with normalised newlines', () => {
  assert.equal(r('[{clipboard}]', { clipboard: 'a\r\nb' }), '[a\nb]');
  assert.equal(r('[{clipboard}]'), '[]');
});

test('{input} prompts: dedupe by label, defaults, values fill every slot', () => {
  const parts = vars.parse('Hi {input:First Name}, {input:first name} again. {input:City=Jhansi}');
  const prompts = vars.collectPrompts(parts);
  assert.deepEqual(prompts.map((p) => [p.type, p.label, p.default]), [['input', 'First Name', ''], ['input', 'City', 'Jhansi']]);
  const out = vars.render(parts, ctx({ values: { [prompts[0].key]: 'Sarah' } }));
  assert.equal(out.text, 'Hi Sarah, Sarah again. Jhansi');
});

test('{choice} prompts: options, labels and default', () => {
  const parts = vars.parse('Priority: {choice:Low|Medium|High} / {choice:Day=Mon|Tue}');
  const prompts = vars.collectPrompts(parts);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].options, ['Low', 'Medium', 'High']);
  assert.equal(prompts[0].label, 'Choose');
  assert.equal(prompts[1].label, 'Day');
  assert.deepEqual(prompts[1].options, ['Mon', 'Tue']);
  assert.equal(vars.render(parts, ctx()).text, 'Priority: Low / Mon');
  assert.equal(vars.render(parts, ctx({ values: { [prompts[0].key]: 'High', [prompts[1].key]: 'Tue' } })).text, 'Priority: High / Tue');
});

test('{tab} splits output into per-field segments', () => {
  const out = vars.resolve('Elliot{tab}Alderson{tab}{cursor}India', ctx());
  assert.deepEqual(out.segments.map((s) => s.text), ['Elliot', 'Alderson', 'India']);
  assert.equal(out.segments[2].cursor, 0);
  assert.equal(out.text, 'Elliot\tAlderson\tIndia');
});

test('html mode escapes inserted values but not the template', () => {
  const out = vars.resolve('<b>{input:Name}</b> {clipboard}', ctx({ html: true, clipboard: '<script>x</script>', values: { 'input:name': 'A & B' } }));
  assert.equal(out.text, '<b>A &amp; B</b> &lt;script&gt;x&lt;/script&gt;');
});

test('preview shows prompts as placeholders', () => {
  assert.equal(vars.preview('Hi {input:Name}! {choice:A|B} {clipboard}', ctx()), 'Hi [Name]! A [clipboard]');
});
