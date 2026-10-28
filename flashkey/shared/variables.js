/*
 * FlashKey — dynamic variable parser & resolver (pure, DOM-free).
 *
 * Supported tags (names are case-insensitive, unknown {tags} are left verbatim):
 *   {cursor}                      caret lands here after expansion
 *   {clipboard}                   current clipboard text
 *   {tab}                         jump to the next form field and keep typing there
 *   {date} {date:FORMAT}          e.g. {date:YYYY-MM-DD} {date:DD/MM/YYYY} {date:MMM D, YYYY}
 *   {date+7d} {date-1d} {date+1m} {date+2w} {date+1y} {date+3bd}   (bd = business days)
 *   {date+1m+2d:Do MMMM}          offsets can be chained and combined with a format
 *   {time} {time:HH:mm} {time+2h} {time+30min}
 *   {day} {day+1d} {day:ddd}      weekday name
 *   {input:First Name}            fill-in field (same label => same value everywhere)
 *   {input:First Name=Sarah}      fill-in with a default
 *   {choice:A|B|C}                pick one option
 *   {choice:Priority=Low|High}    pick one, with a label
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FlashKey = root.FlashKey || {}).vars = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAG_RE = /\{(cursor|clipboard|tab|date|time|day|input|choice)((?:[+-]\d+(?:bd|min|d|w|m|y|h))*)(?::([^{}]*))?\}/gi;
  const OFFSET_RE = /([+-]\d+)(bd|min|d|w|m|y|h)/gi;

  /** Split a template into literal text and variable parts. */
  function parse(template) {
    const src = String(template == null ? '' : template).replace(/\r\n?/g, '\n');
    const parts = [];
    let last = 0;
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(src))) {
      const name = m[1].toLowerCase();
      const offset = m[2] || '';
      const arg = m[3];
      // Offsets only make sense on date/time/day; {input+1d:x} stays literal.
      if (offset && !['date', 'time', 'day'].includes(name)) continue;
      if ((name === 'input' || name === 'choice') && !(arg && arg.trim())) continue;
      if (m.index > last) parts.push({ t: 'text', v: src.slice(last, m.index) });
      parts.push({ t: 'var', name, offset, arg: arg == null ? '' : arg, raw: m[0] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ t: 'text', v: src.slice(last) });
    return parts;
  }

  function parseInputArg(arg) {
    const i = arg.indexOf('=');
    const label = (i >= 0 ? arg.slice(0, i) : arg).trim();
    const def = i >= 0 ? arg.slice(i + 1) : '';
    return { label, def };
  }

  function parseChoiceArg(arg) {
    const bar = arg.indexOf('|');
    const eq = arg.indexOf('=');
    let label = '';
    let rest = arg;
    if (eq >= 0 && (bar < 0 || eq < bar)) { label = arg.slice(0, eq).trim(); rest = arg.slice(eq + 1); }
    const options = rest.split('|').map((x) => x.trim()).filter((x) => x.length);
    return { label, options };
  }

  function promptKey(p) {
    if (p.name === 'input') return 'input:' + parseInputArg(p.arg).label.toLowerCase();
    return 'choice:' + p.arg.trim().toLowerCase();
  }

  /** Distinct fill-in prompts, in order of first appearance. */
  function collectPrompts(parts) {
    const out = [];
    const seen = new Set();
    let choiceN = 0;
    for (const p of parts) {
      if (p.t !== 'var' || (p.name !== 'input' && p.name !== 'choice')) continue;
      const key = promptKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.name === 'input') {
        const { label, def } = parseInputArg(p.arg);
        out.push({ key, type: 'input', label: label || 'Value', default: def });
      } else {
        const { label, options } = parseChoiceArg(p.arg);
        choiceN++;
        out.push({ key, type: 'choice', label: label || (choiceN > 1 ? 'Choose ' + choiceN : 'Choose'), options, default: options[0] || '' });
      }
    }
    return out;
  }

  function needsClipboard(parts) {
    return parts.some((p) => p.t === 'var' && p.name === 'clipboard');
  }

  function hasVariables(parts) {
    return parts.some((p) => p.t === 'var');
  }

  /* ------------------------------ Dates ------------------------------ */

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  function addMonths(d, n) {
    const r = new Date(d.getTime());
    const day = r.getDate();
    r.setDate(1);
    r.setMonth(r.getMonth() + n);
    r.setDate(Math.min(day, daysInMonth(r.getFullYear(), r.getMonth())));
    return r;
  }

  function addBusinessDays(d, n) {
    const r = new Date(d.getTime());
    const step = n < 0 ? -1 : 1;
    let left = Math.abs(n);
    while (left > 0) {
      r.setDate(r.getDate() + step);
      const wd = r.getDay();
      if (wd !== 0 && wd !== 6) left--;
    }
    return r;
  }

  function applyOffset(date, offset) {
    let d = new Date(date.getTime());
    if (!offset) return d;
    OFFSET_RE.lastIndex = 0;
    let m;
    while ((m = OFFSET_RE.exec(offset))) {
      const n = parseInt(m[1], 10);
      switch (m[2].toLowerCase()) {
        case 'd': d.setDate(d.getDate() + n); break;
        case 'w': d.setDate(d.getDate() + 7 * n); break;
        case 'm': d = addMonths(d, n); break;
        case 'y': d = addMonths(d, 12 * n); break;
        case 'bd': d = addBusinessDays(d, n); break;
        case 'h': d.setHours(d.getHours() + n); break;
        case 'min': d.setMinutes(d.getMinutes() + n); break;
      }
    }
    return d;
  }

  const nameCache = new Map();
  function names(locale) {
    const key = locale || '';
    let n = nameCache.get(key);
    if (n) return n;
    const loc = locale || undefined;
    const mk = (opts, type) => {
      try {
        const f = new Intl.DateTimeFormat(loc, opts);
        const out = [];
        for (let i = 0; i < (type === 'month' ? 12 : 7); i++) {
          // 2023-01-01 was a Sunday.
          const d = type === 'month' ? new Date(2023, i, 1) : new Date(2023, 0, 1 + i);
          out.push(f.format(d));
        }
        return out;
      } catch (_) { return null; }
    };
    n = {
      monthsLong: mk({ month: 'long' }, 'month') || ['January','February','March','April','May','June','July','August','September','October','November','December'],
      monthsShort: mk({ month: 'short' }, 'month') || ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
      daysLong: mk({ weekday: 'long' }, 'day') || ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
      daysShort: mk({ weekday: 'short' }, 'day') || ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    };
    nameCache.set(key, n);
    return n;
  }

  function ordinal(n) {
    const s = n % 100;
    if (s >= 11 && s <= 13) return n + 'th';
    switch (n % 10) { case 1: return n + 'st'; case 2: return n + 'nd'; case 3: return n + 'rd'; default: return n + 'th'; }
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const FORMAT_RE = /\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a/g;

  /** Moment-style formatting. Wrap literal text in [brackets]. */
  function formatDate(d, fmt, locale) {
    const n = names(locale);
    const H = d.getHours();
    const h12 = H % 12 === 0 ? 12 : H % 12;
    return String(fmt).replace(FORMAT_RE, (tok, lit) => {
      if (lit !== undefined) return lit;
      switch (tok) {
        case 'YYYY': return String(d.getFullYear());
        case 'YY': return pad(d.getFullYear() % 100);
        case 'MMMM': return n.monthsLong[d.getMonth()];
        case 'MMM': return n.monthsShort[d.getMonth()];
        case 'MM': return pad(d.getMonth() + 1);
        case 'M': return String(d.getMonth() + 1);
        case 'Do': return ordinal(d.getDate());
        case 'DD': return pad(d.getDate());
        case 'D': return String(d.getDate());
        case 'dddd': return n.daysLong[d.getDay()];
        case 'ddd': return n.daysShort[d.getDay()];
        case 'dd': return n.daysShort[d.getDay()].slice(0, 2);
        case 'd': return String(d.getDay());
        case 'HH': return pad(H);
        case 'H': return String(H);
        case 'hh': return pad(h12);
        case 'h': return String(h12);
        case 'mm': return pad(d.getMinutes());
        case 'm': return String(d.getMinutes());
        case 'ss': return pad(d.getSeconds());
        case 's': return String(d.getSeconds());
        case 'A': return H < 12 ? 'AM' : 'PM';
        case 'a': return H < 12 ? 'am' : 'pm';
      }
      return tok;
    });
  }

  function defaultDate(d, locale) {
    try { return d.toLocaleDateString(locale || undefined); } catch (_) { return formatDate(d, 'YYYY-MM-DD'); }
  }
  function defaultTime(d, locale) {
    try { return d.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' }); } catch (_) { return formatDate(d, 'HH:mm'); }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * Resolve a parsed template.
   * @param {Array} parts  from parse()
   * @param {object} ctx   { now?: Date, clipboard?: string, values?: {[promptKey]: string},
   *                         locale?, dateFormat?, timeFormat?, html?: boolean }
   * @returns {{text:string, cursor:number|null, segments:Array<{text:string,cursor:number|null}>}}
   *   segments are split at {tab}; text/cursor describe the whole thing with \t at the splits.
   */
  function render(parts, ctx) {
    const c = ctx || {};
    const now = c.now instanceof Date ? c.now : new Date();
    const values = c.values || {};
    const esc = c.html ? escapeHtml : (x) => x;
    const segments = [{ text: '', cursor: null }];
    let cursorPlaced = false;
    let seg = segments[0];
    const add = (s) => { seg.text += s; };

    for (const p of parts) {
      if (p.t === 'text') { add(p.v); continue; }
      switch (p.name) {
        case 'cursor':
          if (!cursorPlaced) { seg.cursor = seg.text.length; cursorPlaced = true; }
          break;
        case 'tab':
          seg = { text: '', cursor: null };
          segments.push(seg);
          break;
        case 'clipboard':
          add(esc(c.clipboard == null ? '' : String(c.clipboard).replace(/\r\n?/g, '\n')));
          break;
        case 'date': {
          const d = applyOffset(now, p.offset);
          const fmt = p.arg || c.dateFormat;
          add(esc(fmt ? formatDate(d, fmt, c.locale) : defaultDate(d, c.locale)));
          break;
        }
        case 'time': {
          const d = applyOffset(now, p.offset);
          const fmt = p.arg || c.timeFormat;
          add(esc(fmt ? formatDate(d, fmt, c.locale) : defaultTime(d, c.locale)));
          break;
        }
        case 'day': {
          const d = applyOffset(now, p.offset);
          add(esc(formatDate(d, p.arg || 'dddd', c.locale)));
          break;
        }
        case 'input': {
          const key = promptKey(p);
          const v = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : parseInputArg(p.arg).def;
          add(esc(v == null ? '' : v));
          break;
        }
        case 'choice': {
          const key = promptKey(p);
          const v = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : (parseChoiceArg(p.arg).options[0] || '');
          add(esc(v == null ? '' : v));
          break;
        }
      }
    }
    let text = '';
    let cursor = null;
    segments.forEach((s, i) => {
      if (i) text += '\t';
      if (cursor === null && s.cursor !== null) cursor = text.length + s.cursor;
      text += s.text;
    });
    return { text, cursor, segments };
  }

  /** One-call convenience: template string -> resolved text. */
  function resolve(template, ctx) {
    return render(parse(template), ctx);
  }

  /** Human-friendly preview: dynamic values resolved, prompts shown as [Label]. */
  function preview(template, ctx) {
    const parts = parse(template);
    const values = {};
    for (const p of collectPrompts(parts)) values[p.key] = p.default || '[' + p.label + ']';
    return render(parts, Object.assign({ clipboard: '[clipboard]' }, ctx || {}, { values })).text;
  }

  return {
    parse,
    collectPrompts,
    needsClipboard,
    hasVariables,
    render,
    resolve,
    preview,
    formatDate,
    applyOffset,
    addMonths,
    addBusinessDays,
    escapeHtml,
    promptKey
  };
});
