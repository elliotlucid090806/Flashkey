/*
 * FlashKey — anti-hostage import/export formats (pure, DOM-free).
 *
 * Import:  FlashKey JSON backup · generic / Magical / Text Blaze / ProKeys /
 *          Auto Text Expander JSON (arrays, nested folders, key→value maps) ·
 *          CSV / TSV / semicolon CSV (auto column detection + manual mapping) ·
 *          AutoHotKey hotstrings (single-line, options, continuation sections, Send lines)
 * Export:  FlashKey JSON backup · RFC-4180 CSV · AutoHotKey .ahk
 *
 * Every parser returns "raw" snippet objects:
 *   { trigger, label, body, html, isRichText, folder, tags[], enabled, matchCase, triggerMode }
 * storage.js normalises them and handles merge/replace/conflicts.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FlashKey = root.FlashKey || {}).formats = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BACKUP_FORMAT = 'flashkey-backup';

  /* ------------------------------ helpers ------------------------------ */

  const TRIGGER_KEYS = ['trigger', 'shortcut', 'abbreviation', 'abbr', 'command', 'keyword', 'hotstring', 'shortcode', 'key', 'code', 'snippetshortcut'];
  const LABEL_KEYS = ['label', 'title', 'name', 'description', 'desc'];
  const BODY_KEYS = ['body', 'text', 'expansion', 'snippet', 'content', 'template', 'value', 'phrase', 'replacement', 'message', 'plaintext', 'plain', 'output'];
  const HTML_KEYS = ['html', 'richtext', 'rich', 'bodyhtml', 'htmlbody'];
  const FOLDER_KEYS = ['folder', 'foldername', 'category', 'group', 'collection', 'section'];
  const TAG_KEYS = ['tags', 'tag', 'labels', 'keywords'];
  const ENABLED_KEYS = ['enabled', 'active'];

  const lc = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');

  function pick(obj, keys) {
    const map = {};
    for (const k of Object.keys(obj)) map[lc(k)] = k;
    for (const k of keys) if (map[k] !== undefined) {
      const v = obj[map[k]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function toTags(v) {
    if (v == null) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[,;|]/);
    return [...new Set(arr.map((t) => String(typeof t === 'object' && t ? t.name || '' : t).trim()).filter(Boolean))];
  }

  function toBool(v, dflt = true) {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled', 'n'].includes(s)) return false;
    return true;
  }

  function stripBom(text) { return String(text || '').replace(/^﻿/, ''); }

  function htmlToTextBasic(html) {
    return String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/, '');
  }

  /** Convert Text Blaze / common competitor placeholders into FlashKey variables. */
  function convertForeignPlaceholders(body) {
    let s = String(body == null ? '' : body);
    // Text Blaze: {formtext: name=First name; default=Sarah}
    s = s.replace(/\{formtext:\s*([^{}]*)\}/gi, (_, args) => {
      const a = tbArgs(args);
      const label = a.name || a._[0] || 'Value';
      return '{input:' + label + (a.default ? '=' + a.default : '') + '}';
    });
    // Text Blaze: {formmenu: default=A; B; C; name=Priority}
    s = s.replace(/\{formmenu:\s*([^{}]*)\}/gi, (_, args) => {
      const a = tbArgs(args);
      const opts = [];
      if (a.default) opts.push(a.default);
      for (const o of a._) if (!opts.includes(o)) opts.push(o);
      return '{choice:' + (a.name ? a.name + '=' : '') + opts.join('|') + '}';
    });
    // Text Blaze: {time: YYYY-MM-DD; shift=+1D}
    s = s.replace(/\{time:(\s+[^{}]*|[^{}]*;[^{}]*)\}/gi, (whole, args) => {
      const a = tbArgs(args);
      const fmt = a._[0];
      if (!fmt) return whole;
      let off = '';
      if (a.shift) {
        const m = /^([+-]?\d+)\s*([a-z]+)/i.exec(a.shift.trim());
        if (m) {
          const n = m[1].startsWith('-') || m[1].startsWith('+') ? m[1] : '+' + m[1];
          const u = { d: 'd', w: 'w', m: 'm', y: 'y', h: 'h', b: 'bd', bd: 'bd' }[m[2].toLowerCase()] || (/^mi/i.test(m[2]) ? 'min' : 'd');
          off = n + u;
        }
      }
      return '{date' + off + ':' + fmt + '}';
    });
    // Text Blaze: {key: tab} / {key: enter}
    s = s.replace(/\{key:\s*tab\s*\}/gi, '{tab}').replace(/\{key:\s*enter\s*\}/gi, '\n');
    return s;
  }

  function tbArgs(args) {
    const out = { _: [] };
    for (const raw of String(args).split(';')) {
      const part = raw.trim();
      if (!part) continue;
      const m = /^([a-z_]+)\s*=\s*(.*)$/i.exec(part);
      if (m) out[m[1].toLowerCase()] = m[2].trim();
      else out._.push(part);
    }
    return out;
  }

  /* ------------------------------- JSON ------------------------------- */

  function snippetFromObject(obj, folderName) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let trigger = pick(obj, TRIGGER_KEYS);
    let label = pick(obj, LABEL_KEYS);
    let body = pick(obj, BODY_KEYS);
    const html = pick(obj, HTML_KEYS);
    // ProKeys uses {name, body}: the "name" is the abbreviation.
    if (trigger === undefined && label !== undefined && (body !== undefined || html !== undefined) && !/\s/.test(String(label)) && String(label).length <= 32) {
      trigger = label; label = undefined;
    }
    if (trigger === undefined || (body === undefined && html === undefined)) return null;
    if (typeof trigger !== 'string' && typeof trigger !== 'number') return null;
    if (typeof body === 'object' && body) body = body.text || body.plain || JSON.stringify(body);
    const hasHtml = typeof html === 'string' && /<[a-z][\s\S]*>/i.test(html);
    const plain = body !== undefined ? String(body) : htmlToTextBasic(html);
    return {
      trigger: String(trigger).trim(),
      label: label !== undefined ? String(label) : '',
      body: convertForeignPlaceholders(plain),
      html: hasHtml ? convertForeignPlaceholders(String(html)) : '',
      isRichText: hasHtml && toBool(pick(obj, ['isrichtext', 'rich']), !!hasHtml),
      folder: String(pick(obj, FOLDER_KEYS) || folderName || ''),
      tags: toTags(pick(obj, TAG_KEYS)),
      enabled: toBool(pick(obj, ENABLED_KEYS), true),
      matchCase: obj.matchCase === true || obj.matchCase === false ? obj.matchCase : null,
      triggerMode: obj.triggerMode === 'immediate' || obj.triggerMode === 'delimiter' ? obj.triggerMode : null,
      pinned: obj.pinned === true,
      useCount: Number.isFinite(obj.useCount) ? obj.useCount : 0
    };
  }

  /** Walk arbitrary JSON looking for snippet-shaped records. */
  function collectFromJson(node, folderName, out, depth) {
    if (depth > 12 || node == null) return;
    if (Array.isArray(node)) {
      // ProKeys folder: ["Folder name", timestamp, ...children]
      if (typeof node[0] === 'string' && typeof node[1] === 'number' && node.length >= 2) {
        const name = node[0] === 'Snippets' ? folderName : node[0];
        for (const child of node.slice(2)) collectFromJson(child, name, out, depth + 1);
        return;
      }
      for (const item of node) collectFromJson(item, folderName, out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const sn = snippetFromObject(node, folderName);
    if (sn) { out.push(sn); return; }
    // Folder-ish object: { name, snippets: [...] } / { title, items: [...] }
    const fname = node.name || node.title || node.folder || node.label;
    const childKeys = Object.keys(node).filter((k) => node[k] && typeof node[k] === 'object');
    const listKeys = childKeys.filter((k) => /snippet|template|item|shortcut|children|entries|data|folder|group|macro|phrase|expansion/i.test(k));
    const keys = listKeys.length ? listKeys : childKeys;
    const nextFolder = typeof fname === 'string' && listKeys.length ? fname : folderName;
    for (const k of keys) collectFromJson(node[k], nextFolder, out, depth + 1);
  }

  function isKeyValueMap(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const vals = Object.values(obj);
    return vals.length > 0 && vals.every((v) => typeof v === 'string') &&
      Object.keys(obj).every((k) => !/\s/.test(k) && k.length <= 64);
  }

  function parseJson(text) {
    const data = JSON.parse(stripBom(text));
    const warnings = [];
    if (data && data.format === BACKUP_FORMAT && Array.isArray(data.snippets)) {
      const folders = Array.isArray(data.folders) ? data.folders : [];
      const byId = new Map(folders.map((f) => [f.id, f.name]));
      const snippets = data.snippets.map((s) => Object.assign({}, s, { folder: byId.get(s.folderId) || s.folder || '' }));
      return { format: 'flashkey', snippets, folders, settings: data.settings || null, warnings };
    }
    if (isKeyValueMap(data)) {
      const snippets = Object.entries(data).map(([k, v]) => ({ trigger: k, label: '', body: convertForeignPlaceholders(v), html: '', isRichText: false, folder: '', tags: [], enabled: true }));
      return { format: 'json-map', snippets, warnings };
    }
    const out = [];
    collectFromJson(data, '', out, 0);
    if (!out.length) warnings.push('No snippet-like records were found in this JSON file.');
    let label = 'json';
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (Array.isArray(data.folders) && JSON.stringify(data).includes('shortcut')) label = 'textblaze';
    }
    if (Array.isArray(data) && data[0] === 'Snippets') label = 'prokeys';
    return { format: label, snippets: out, warnings };
  }

  /* -------------------------------- CSV -------------------------------- */

  function detectDelimiter(text) {
    const firstLine = (() => {
      let inQ = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') inQ = !inQ;
        else if ((ch === '\n' || ch === '\r') && !inQ) return text.slice(0, i);
      }
      return text;
    })();
    const counts = { ',': 0, '\t': 0, ';': 0 };
    let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch in counts) counts[ch]++;
    }
    if (counts['\t'] > 0 && counts['\t'] >= counts[',']) return '\t';
    if (counts[';'] > counts[',']) return ';';
    return ',';
  }

  /** RFC-4180 parser: quoted fields, "" escapes, embedded newlines, CRLF/LF. */
  function parseCSV(text, delimiter) {
    const src = stripBom(text);
    const d = delimiter || detectDelimiter(src);
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;
    while (i < src.length) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
      if (ch === d) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        if (ch === '\r' && src[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function csvField(v, d) {
    const s = v == null ? '' : String(v);
    return /["\r\n]/.test(s) || s.includes(d) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function serializeCSV(rows, delimiter) {
    const d = delimiter || ',';
    return rows.map((r) => r.map((v) => csvField(v, d)).join(d)).join('\r\n') + '\r\n';
  }

  const COLUMN_ALIASES = {
    trigger: ['trigger', 'shortcut', 'abbreviation', 'abbr', 'command', 'keyword', 'hotstring', 'shortcode', 'key', 'code'],
    body: ['body', 'content', 'expansion', 'text', 'snippet', 'template', 'value', 'phrase', 'replacement', 'message', 'plaintext'],
    html: ['html', 'richtext', 'bodyhtml'],
    label: ['label', 'title', 'name', 'description'],
    folder: ['folder', 'foldername', 'category', 'group', 'collection'],
    tags: ['tags', 'tag', 'labels', 'keywords'],
    enabled: ['enabled', 'active']
  };

  function guessMapping(headers) {
    const map = {};
    const used = new Set();
    for (const field of ['trigger', 'body', 'html', 'label', 'folder', 'tags', 'enabled']) {
      for (const alias of COLUMN_ALIASES[field]) {
        const idx = headers.findIndex((h, i) => !used.has(i) && lc(h) === alias);
        if (idx >= 0) { map[field] = idx; used.add(idx); break; }
      }
    }
    return map;
  }

  function rowsToSnippets(rows, mapping) {
    const out = [];
    for (const r of rows) {
      const get = (f) => (mapping[f] === undefined || mapping[f] === null || mapping[f] < 0 ? undefined : r[mapping[f]]);
      const trigger = (get('trigger') || '').trim();
      const html = get('html') || '';
      let body = get('body');
      if (!trigger || (body === undefined && !html)) continue;
      if (body === undefined || body === '') body = html ? htmlToTextBasic(html) : '';
      const hasHtml = /<[a-z][\s\S]*>/i.test(html);
      out.push({
        trigger,
        label: get('label') || '',
        body: convertForeignPlaceholders(body),
        html: hasHtml ? convertForeignPlaceholders(html) : '',
        isRichText: hasHtml,
        folder: get('folder') || '',
        tags: toTags(get('tags')),
        enabled: toBool(get('enabled'), true)
      });
    }
    return out;
  }

  function parseDelimited(text, opts) {
    const o = opts || {};
    const delimiter = o.delimiter || detectDelimiter(stripBom(text));
    const rows = parseCSV(text, delimiter);
    const warnings = [];
    if (!rows.length) return { format: 'csv', snippets: [], warnings: ['The file is empty.'], headers: [], rows: [] };
    const headers = rows[0].map((h) => String(h).trim());
    let mapping = o.mapping || guessMapping(headers);
    let dataRows = rows.slice(1);
    let needsMapping = false;
    if (!o.mapping && (mapping.trigger === undefined || (mapping.body === undefined && mapping.html === undefined))) {
      if (headers.length >= 2 && !Object.keys(mapping).length) {
        // No recognisable header row: assume "trigger, body[, label, folder, tags]".
        mapping = { trigger: 0, body: 1 };
        if (headers.length > 2) mapping.label = 2;
        if (headers.length > 3) mapping.folder = 3;
        if (headers.length > 4) mapping.tags = 4;
        dataRows = rows;
        warnings.push('No header row detected — assumed columns: trigger, body, label, folder, tags.');
      } else {
        needsMapping = true;
      }
    }
    const snippets = needsMapping ? [] : rowsToSnippets(dataRows, mapping);
    return {
      format: delimiter === '\t' ? 'tsv' : 'csv',
      delimiter, headers, rows: dataRows, mapping, needsMapping, snippets, warnings
    };
  }

  /* --------------------------- AutoHotKey (.ahk) --------------------------- */

  function ahkUnescape(s) {
    return s.replace(/`(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '', '`': '`', ';': ';', '%': '%', ',': ',', ':': ':', '{': '{', '}': '}', s: ' ', b: '', a: '', f: '', v: '' }[c] ?? c));
  }

  function ahkTranslateKeys(s) {
    return s
      .replace(/\{Enter(?:\s+(\d+))?\}/gi, (_, n) => '\n'.repeat(n ? +n : 1))
      .replace(/\{Tab(?:\s+(\d+))?\}/gi, (_, n) => '{tab}'.repeat(n ? +n : 1))
      .replace(/\{Space(?:\s+(\d+))?\}/gi, (_, n) => ' '.repeat(n ? +n : 1))
      .replace(/\{(!|\+|\^|#|\{|\})\}/g, '$1')
      .replace(/\{(?:Left|Right|Up|Down|Home|End|BS|Backspace|Del|Delete|Esc|Escape)(?:\s+\d+)?\}/gi, '');
  }

  function stripAhkComment(line) {
    // " ;comment" (whitespace + semicolon) starts a comment unless escaped `;
    const m = /[ \t];/.exec(line.replace(/`;/g, '\u0000'));
    const restored = (m ? line.replace(/`;/g, '\u0000').slice(0, m.index) : line.replace(/`;/g, '\u0000'));
    return restored.replace(/\u0000/g, '`;').replace(/[ \t]+$/, '');
  }

  function parseAHK(text) {
    const lines = stripBom(text).replace(/\r\n?/g, '\n').split('\n');
    const snippets = [];
    const warnings = [];
    const HS_RE = /^\s*:([^:\s]*):(.+?)::(.*)$/;
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inBlockComment) { if (/^\s*\*\//.test(line) || /\*\/\s*$/.test(line)) inBlockComment = false; continue; }
      if (/^\s*\/\*/.test(line)) { if (!/\*\/\s*$/.test(line)) inBlockComment = true; continue; }
      if (/^\s*;/.test(line) || !line.trim()) continue;
      const m = HS_RE.exec(line);
      if (!m) continue;
      const opts = m[1].toUpperCase();
      const trigger = m[2];
      let rest = m[3];
      const raw = /[RT]/.test(opts.replace(/[RT]0/g, ''));
      if (/X/.test(opts)) { warnings.push(`Skipped "${trigger}": X (execute) hotstrings run code, not text.`); continue; }
      let body = null;
      if (rest.trim() === '' || /^\s+;/.test(rest)) {
        // Multi-line: continuation section "(" ... ")" or Send/SendInput lines up to "return".
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && /^\s*\(/.test(lines[j])) {
          const contOpts = lines[j].trim().slice(1);
          const ltrim = /\bLTrim\b(?!0)/i.test(contOpts);
          const buf = [];
          let k = j + 1;
          for (; k < lines.length; k++) { if (/^\s*\)/.test(lines[k])) break; buf.push(ltrim ? lines[k].replace(/^[ \t]+/, '') : lines[k]); }
          body = ahkUnescape(buf.join('\n'));
          if (!raw) body = ahkTranslateKeys(body);
          i = k;
        } else {
          const sends = [];
          let k = j;
          for (; k < lines.length; k++) {
            const t = lines[k].trim();
            if (/^return\b/i.test(t) || HS_RE.test(lines[k]) || t === '}') break;
            const sm = /^(Send(?:Input|Raw|Play|Event|Text)?)[\s,(]+["']?(.*?)["']?\)?$/i.exec(t);
            if (sm) {
              let v = ahkUnescape(stripAhkComment(sm[2]));
              if (/^(SendRaw|SendText)$/i.test(sm[1])) sends.push(v);
              else sends.push(ahkTranslateKeys(v.replace(/^\{Raw\}/i, '')));
            } else if (t && !/^;/.test(t) && t !== '{') {
              warnings.push(`"${trigger}" contains script logic that was not imported: ${t.slice(0, 40)}`);
            }
          }
          if (sends.length) { body = sends.join(''); i = k; }
        }
        if (body === null) { warnings.push(`Skipped "${trigger}": empty replacement.`); continue; }
      } else {
        rest = stripAhkComment(rest);
        body = ahkUnescape(rest);
        if (!raw) body = ahkTranslateKeys(body);
      }
      snippets.push({
        trigger: trigger,
        label: '',
        body,
        html: '',
        isRichText: false,
        folder: 'AutoHotKey',
        tags: ['ahk'],
        enabled: true,
        matchCase: /C(?!0|1)/.test(opts) ? true : null,
        triggerMode: opts.includes('*') && !opts.includes('*0') ? 'immediate' : null
      });
    }
    return { format: 'ahk', snippets, warnings };
  }

  function ahkEscape(s) {
    return s.replace(/`/g, '``');
  }

  function toAHK(snippets) {
    const out = [
      '; FlashKey export — AutoHotKey v1.1.27+ / v2 hotstrings',
      '; Generated ' + new Date().toISOString(),
      '; T = send text literally. Multi-line snippets use continuation sections.',
      ''
    ];
    for (const s of snippets) {
      if (!s.trigger || /[\s:]/.test(s.trigger)) continue;
      let opts = 'T';
      if (s.triggerMode === 'immediate') opts += '*';
      if (s.matchCase === true) opts += 'C';
      const body = String(s.body || '');
      if (s.label) out.push('; ' + s.label.replace(/\n/g, ' '));
      if (!body.includes('\n') && !/^\s|\s$/.test(body)) {
        out.push(`:${opts}:${s.trigger}::${ahkEscape(body).replace(/(\s);/g, '$1`;')}`);
      } else {
        out.push(`:${opts}:${s.trigger}::`);
        out.push('(');
        out.push(ahkEscape(body).replace(/^\)/gm, '`)'));
        out.push(')');
      }
    }
    return out.join('\r\n') + '\r\n';
  }

  /* ---------------------------- detection & API ---------------------------- */

  function detectFormat(text, filename) {
    const name = String(filename || '').toLowerCase();
    const src = stripBom(text).trimStart();
    if (name.endsWith('.ahk')) return 'ahk';
    if (name.endsWith('.json') || src.startsWith('{') || src.startsWith('[')) {
      try { JSON.parse(stripBom(text)); return 'json'; } catch (_) { if (name.endsWith('.json')) return 'json'; }
    }
    if (name.endsWith('.tsv')) return 'tsv';
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      if (/^\s*:[^:\s]*:[^\n]+::/m.test(src) && !name.endsWith('.csv')) return 'ahk';
      return 'csv';
    }
    if (/^\s*:[^:\s]*:[^\n]+::/m.test(src)) return 'ahk';
    return 'csv';
  }

  /**
   * @param {string} text
   * @param {{filename?:string, format?:string, mapping?:object, delimiter?:string}} opts
   */
  function parseImport(text, opts) {
    const o = opts || {};
    const fmt = o.format && o.format !== 'auto' ? o.format : detectFormat(text, o.filename);
    try {
      if (fmt === 'json') return parseJson(text);
      if (fmt === 'ahk') return parseAHK(text);
      if (fmt === 'tsv') return parseDelimited(text, Object.assign({ delimiter: '\t' }, o));
      return parseDelimited(text, o);
    } catch (err) {
      return { format: fmt, snippets: [], warnings: ['Could not read this file: ' + (err && err.message ? err.message : err)] };
    }
  }

  function toCSV(snippets, folders) {
    const names = new Map((folders || []).map((f) => [f.id, f.name]));
    const rows = [['trigger', 'label', 'body', 'folder', 'tags', 'enabled']];
    for (const s of snippets) rows.push([s.trigger, s.label || '', s.body || '', names.get(s.folderId) || s.folder || '', (s.tags || []).join(', '), s.enabled === false ? 'false' : 'true']);
    // BOM so Excel opens UTF-8 (emoji, accents, Devanagari…) correctly.
    return '﻿' + serializeCSV(rows, ',');
  }

  function toJSONBackup(state) {
    const usage = state.usage || {};
    return {
      app: 'FlashKey',
      format: BACKUP_FORMAT,
      schemaVersion: state.schemaVersion || 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings || {},
      folders: state.folders || [],
      snippets: (state.snippets || []).map((s) => Object.assign({}, s, { useCount: (s.useCount || 0) + (usage[s.id] || 0) })),
      stats: state.stats || {}
    };
  }

  function backupFilename(ext, date) {
    const d = date || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `flashkey-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
  }

  return {
    BACKUP_FORMAT,
    detectFormat,
    detectDelimiter,
    parseImport,
    parseJson,
    parseCSV,
    serializeCSV,
    parseDelimited,
    guessMapping,
    rowsToSnippets,
    parseAHK,
    toAHK,
    toCSV,
    toJSONBackup,
    backupFilename,
    convertForeignPlaceholders,
    htmlToTextBasic
  };
});
