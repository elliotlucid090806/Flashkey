/*
 * FlashKey — trigger matcher, guardrails & defaults (pure, DOM-free).
 *
 * Shared by the content script, the service worker, the extension pages and
 * the Node test-suite. Nothing in here touches the DOM or chrome.* APIs.
 *
 * Matching model
 * --------------
 * compile() builds an exact Map<trigger, entry> plus the set of distinct
 * trigger lengths and possible last characters. A keystroke first checks the
 * last-character Set (rejects almost everything in one lookup); otherwise it
 * does one Map.get() per distinct trigger length (≤ 64), longest first. The
 * cost is independent of library size: 10 snippets or 10,000 cost the same.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.FlashKey = root.FlashKey || {}).matcher = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    theme: 'system',            // 'light' | 'dark' | 'system'
    triggerMode: 'delimiter',   // 'immediate' | 'delimiter'
    keepDelimiter: true,        // re-insert the Space / punctuation that fired the expansion
    caseSensitive: false,       // false => CAPS LOCK still expands
    matchInsideWords: false,    // true => expand mid-word (language / character replacements)
    quickPickerShortcut: true,  // Ctrl+Shift+Space opens the shadow-DOM picker
    soundOrToast: false,        // reserved — FlashKey never shows notifications by default
    backupReminder: true,       // gentle banner inside the Studio only, never on websites
    dateFormat: '',             // '' => browser locale default for {date}
    timeFormat: '',             // '' => browser locale default for {time}
    locale: '',                 // '' => navigator.language
    blockedDomains: Object.freeze([
      '*.bank.*',
      'duosecurity.com',
      '*.okta.com',
      'login.microsoftonline.com'
    ])
  });

  const MAX_TRIGGER_LENGTH = 64;

  // Characters that end a token in "delimiter" mode (Enter/Tab are handled as keys).
  const DELIMITER_RE = /[\s.,!?;:)\]}"'»…]/u;
  const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

  function isDelimiterChar(ch) { return !!ch && DELIMITER_RE.test(ch); }
  function isWordChar(ch) { return !!ch && WORD_CHAR_RE.test(ch); }

  /** Returns an error string, or '' when the trigger is valid. */
  function validateTrigger(trigger) {
    const t = String(trigger == null ? '' : trigger);
    if (!t.trim()) return 'Trigger is required.';
    if (/\s/.test(t)) return 'Triggers cannot contain spaces or line breaks.';
    if (t.length > MAX_TRIGGER_LENGTH) return `Triggers are limited to ${MAX_TRIGGER_LENGTH} characters.`;
    return '';
  }

  /**
   * Build the in-memory lookup index.
   *   byKey    Map<lower-cased trigger, entry[]>  — exact O(1) lookups
   *   lengths  distinct trigger lengths, longest first (at most 64 of them)
   *   lastChars Set of possible final characters — rejects ~all keystrokes instantly
   * @param {Array} snippets
   * @param {object} settings
   */
  function compile(snippets, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const byKey = new Map();
    const byId = new Map();
    const lastChars = new Set();
    const lengthSet = new Set();
    let maxLen = 0;
    let count = 0;
    for (const sn of snippets || []) {
      if (!sn || sn.enabled === false) continue;
      const trigger = typeof sn.trigger === 'string' ? sn.trigger : '';
      if (validateTrigger(trigger)) continue;
      const cs = sn.matchCase == null ? !!s.caseSensitive : !!sn.matchCase;
      const mode = sn.triggerMode === 'immediate' || sn.triggerMode === 'delimiter' ? sn.triggerMode : s.triggerMode;
      const lower = trigger.toLowerCase();
      const entry = { id: sn.id, trigger, lower, len: trigger.length, cs, mode, snippet: sn };
      let list = byKey.get(lower);
      if (!list) byKey.set(lower, (list = []));
      list.push(entry);
      byId.set(sn.id, sn);
      lastChars.add(lower.charAt(lower.length - 1));
      lengthSet.add(trigger.length);
      if (trigger.length > maxLen) maxLen = trigger.length;
      count++;
    }
    const lengths = [...lengthSet].sort((a, b) => b - a);
    return { byKey, byId, lastChars, lengths, maxLen, count, insideWords: !!s.matchInsideWords };
  }

  function sameText(a, b, cs) {
    return cs ? a === b : a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Find the snippet whose trigger ends `typed`.
   *
   * @param {object} index   result of compile()
   * @param {string} typed   rolling buffer of what the user actually typed, ending at the trigger end
   * @param {string} context real text before the caret in the field, ending at the trigger end
   *                         (used to double-check and for the word-boundary rule)
   * @param {'immediate'|'delimiter'} mode
   * @returns {object|null}  index entry
   */
  function findMatch(index, typed, context, mode) {
    if (!index || !index.count || !typed) return null;
    if (!index.lastChars.has(typed.charAt(typed.length - 1).toLowerCase())) return null;
    const ctx = context == null ? typed : context;
    for (const len of index.lengths) {
      if (len > typed.length || len > ctx.length) continue;
      const list = index.byKey.get(typed.slice(-len).toLowerCase());
      if (!list) continue;
      for (const e of list) {
        if (e.mode !== mode) continue;
        if (!sameText(typed.slice(-len), e.trigger, e.cs)) continue;
        if (!sameText(ctx.slice(-len), e.trigger, e.cs)) continue;
        if (!index.insideWords && isWordChar(ctx.charAt(ctx.length - len - 1))) continue;
        return e;
      }
    }
    return null;
  }

  /** Duplicate triggers and prefix shadowing (only relevant in immediate mode). */
  function findConflicts(snippets, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const list = (snippets || []).filter((x) => x && x.enabled !== false && x.trigger);
    const seen = new Map();
    const duplicates = [];
    for (const sn of list) {
      const k = sn.trigger.toLowerCase();
      if (seen.has(k)) duplicates.push([seen.get(k), sn]);
      else seen.set(k, sn);
    }
    const prefixes = [];
    const immediate = list.filter((sn) => (sn.triggerMode || s.triggerMode) === 'immediate');
    for (const a of immediate) {
      for (const b of list) {
        if (a === b) continue;
        const al = a.trigger.toLowerCase();
        const bl = b.trigger.toLowerCase();
        if (bl.length > al.length && bl.startsWith(al)) prefixes.push([a, b]);
      }
    }
    return { duplicates, prefixes };
  }

  /* ----------------------------- Blocklist ----------------------------- */

  function normalizePattern(p) {
    let s = String(p || '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/^www\./, '');
    return s;
  }

  const patternCache = new Map();
  function patternToRegex(pattern) {
    let re = patternCache.get(pattern);
    if (re) return re;
    const hasPort = pattern.includes(':');
    let body = pattern;
    let prefix = '';
    if (body.startsWith('*.')) { body = body.slice(2); prefix = '(?:.*\\.)?'; }
    const esc = body.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    // A bare "example.com" also covers its subdomains.
    if (!prefix && !pattern.includes('*')) prefix = '(?:.*\\.)?';
    re = { regex: new RegExp('^' + prefix + esc + '$'), hasPort };
    patternCache.set(pattern, re);
    return re;
  }

  /**
   * @param {string} pattern e.g. "example.com", "*.chase.com", "*.bank.*", "localhost:*"
   * @param {string} host    location.host (hostname[:port])
   */
  function hostMatches(pattern, host) {
    const p = normalizePattern(pattern);
    if (!p || !host) return false;
    const h = String(host).toLowerCase().replace(/^www\./, '');
    const { regex, hasPort } = patternToRegex(p);
    const target = hasPort ? (h.includes(':') ? h : h + ':') : h.split(':')[0];
    return regex.test(target);
  }

  function isBlocked(patterns, hosts) {
    const hs = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);
    for (const p of patterns || []) for (const h of hs) if (hostMatches(p, h)) return true;
    return false;
  }

  /* ------------------------ Sensitive field guard ------------------------ */

  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email']);
  const SENSITIVE_WORD_RE = /(^|[^a-z0-9])(otp|totp|hotp|2fa|mfa|tfa|passcode|passwd|password|pwd|cvv|cvc|cvv2|ssn|iban)([^a-z0-9]|$)/i;
  const SENSITIVE_PHRASE_RE = /one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|auth[\s_-]?code|card[\s_-]?number|cc[\s_-]?num|credit[\s_-]?card|social[\s_-]?security/i;

  function splitWords(s) {
    return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /**
   * Decide whether a field must never be touched.
   * @param {{tag:string,type?:string,autocomplete?:string,name?:string,id?:string,
   *          inputmode?:string,maxLength?:number,ariaLabel?:string,placeholder?:string}} f
   * @returns {string} reason when sensitive, '' when safe
   */
  function sensitiveReason(f) {
    const tag = String(f.tag || '').toUpperCase();
    if (tag === 'INPUT') {
      const type = String(f.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden') return 'type=' + type;
      if (!TEXT_INPUT_TYPES.has(type)) return 'unsupported type ' + type;
    }
    const ac = String(f.autocomplete || '').toLowerCase();
    if (/\bone-time-code\b/.test(ac)) return 'autocomplete=one-time-code';
    if (/\bcc-/.test(ac)) return 'autocomplete=cc-*';
    if (/\b(current|new)-password\b/.test(ac)) return 'autocomplete=password';
    for (const key of ['name', 'id']) {
      const v = splitWords(f[key]);
      if (SENSITIVE_WORD_RE.test(v) || SENSITIVE_PHRASE_RE.test(v)) return key + ' looks sensitive';
    }
    for (const key of ['ariaLabel', 'placeholder']) {
      const v = splitWords(f[key]);
      if (SENSITIVE_PHRASE_RE.test(v) || /(^|[^a-z])(otp|2fa|cvv|cvc|ssn|passcode)([^a-z]|$)/i.test(v)) return key + ' looks sensitive';
    }
    const im = String(f.inputmode || '').toLowerCase();
    const ml = Number(f.maxLength);
    if (tag === 'INPUT' && im === 'numeric' && ml > 0 && ml <= 8) return 'short numeric code field';
    return '';
  }

  return {
    DEFAULT_SETTINGS,
    MAX_TRIGGER_LENGTH,
    TEXT_INPUT_TYPES,
    isDelimiterChar,
    isWordChar,
    validateTrigger,
    compile,
    findMatch,
    findConflicts,
    normalizePattern,
    hostMatches,
    isBlocked,
    sensitiveReason
  };
});
