/*
 * FlashKey — content script: zero-lag expansion engine + on-demand shadow UI.
 *
 * Performance contract
 *   • Nothing is read from storage until the user focuses an editable field in
 *     this frame (ad iframes and read-only pages cost ~nothing).
 *   • Listeners: focusin, pointerdown, input, compositionend (passive) and one
 *     keydown (non-passive, only cancels Enter/Tab/Ctrl+Shift+Space when they
 *     complete a trigger). No MutationObserver, no scroll/touch/mouse-move.
 *   • A keystroke costs one Map lookup + a few endsWith() checks.
 *
 * Safety contract
 *   • Password / OTP / card / hidden fields are never touched.
 *   • The trigger must be what the user just typed AND what sits right before
 *     the caret — otherwise nothing happens (no overwriting of existing data).
 *   • Blocked domains are checked against this frame and all its ancestors.
 *   • No network calls, no page-world script injection, no fetch/XHR patching.
 */
(() => {
  'use strict';
  if (globalThis.__flashkeyEngine) return;
  const FK = globalThis.FlashKey || {};
  const { matcher, vars, sanitize } = FK;
  if (!matcher || !vars || !sanitize || !FK.fillin || !FK.caret || !FK.insert || !FK.overlay) return;

  const SANDBOX = globalThis.FLASHKEY_SANDBOX || null; // set by the Studio's live test sandbox

  /**
   * One engine per window. The top-level call boots this frame; a frame may also
   * "adopt" a same-origin child (script-built about:blank composers used by
   * Zendesk, Intercom, HubSpot, Freshdesk…) where Chrome never injects scripts.
   */
  function boot(win, adopted) {
  const doc = win.document;
  const IS_TOP = win.top === win;
  const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);

  let settings = Object.assign({}, matcher.DEFAULT_SETTINGS);
  let snippets = [];
  let index = null;
  let loaded = false;
  let loading = null;
  let blocked = false;
  let buffer = '';
  let bufferEl = null;
  let expanding = false; // synchronous DOM writes of our own are in flight
  let busy = false;      // an expansion (possibly waiting on a prompt) is running
  let reportedFocus = false;
  let checkTimer = 0;
  let pendingKeys = '';
  let dead = false;

  const caret = FK.caret.create(win);
  const { targetOf, deepActive, editingHost, fieldInfo, getSel, inputCaret, inputContext, ceContext, capture } = caret;
  const overlay = FK.overlay.create(win);
  // resolveEditable is a hoisted function declaration, so it can be handed over now.
  const inserter = FK.insert.create(win, caret, resolveEditable);
  const { insertInput, insertCEPlain, insertCERich, focusNext, fillField } = inserter;

  /* ------------------------------ plumbing ------------------------------ */

  function alive() {
    try { return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function send(msg) {
    if (!alive()) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch (_) { return Promise.resolve(null); }
  }

  function frameHosts() {
    const hosts = [win.location.host];
    try {
      const ao = win.location.ancestorOrigins;
      if (ao) for (let i = 0; i < ao.length; i++) { try { hosts.push(new URL(ao[i]).host); } catch (_) {} }
    } catch (_) {}
    if (!IS_TOP) { try { hosts.push(win.top.location.host); } catch (_) {} }
    return hosts.filter(Boolean);
  }

  function computeBlocked() {
    blocked = !SANDBOX && matcher.isBlocked(settings.blockedDomains, frameHosts());
  }

  function rebuild() {
    let list = snippets;
    if (SANDBOX && typeof SANDBOX.draft === 'function') {
      const d = SANDBOX.draft();
      if (d && d.trigger) list = list.filter((s) => s.id !== d.id).concat([Object.assign({}, d, { enabled: true })]);
    }
    index = matcher.compile(list, settings);
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    let dirty = false;
    if (changes.settings) {
      settings = Object.assign({}, matcher.DEFAULT_SETTINGS, changes.settings.newValue || {});
      computeBlocked();
      dirty = true;
    }
    if (changes.snippets) {
      snippets = Array.isArray(changes.snippets.newValue) ? changes.snippets.newValue : [];
      dirty = true;
    }
    if (dirty) rebuild();
  }

  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    if (!alive()) return Promise.resolve();
    loading = chrome.storage.local.get(['settings', 'snippets']).then((r) => {
      settings = Object.assign({}, matcher.DEFAULT_SETTINGS, (r && r.settings) || {});
      snippets = Array.isArray(r && r.snippets) ? r.snippets : [];
      computeBlocked();
      rebuild();
      loaded = true;
      chrome.storage.onChanged.addListener(onStorageChanged);
      // Build the Intl month/day-name tables while idle so the first {date} expansion is instant.
      const idle = win.requestIdleCallback || ((fn) => setTimeout(fn, 200));
      idle(() => { try { vars.resolve('{date:MMMM MMM dddd ddd}{time}{date}', { locale: settings.locale }); } catch (_) {} });
    }).catch(() => {}).finally(() => { loading = null; });
    return loading;
  }

  function active() {
    return !dead && loaded && !!index && (SANDBOX ? true : settings.enabled !== false && !blocked);
  }

  /* --------------------------- element helpers --------------------------- */


  function fromOurUI(e) {
    return overlay.isFrom(e);
  }




  /** Normalise any event target to {el, kind} or null. kind: 'input' | 'ce'. */
  function resolveEditable(node) {
    let el = node;
    if (!el) return null;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) return null;
    if (overlay.owns(el)) return null;
    if (SANDBOX && !(el.closest && el.closest(SANDBOX.scope))) return null;
    if (el.closest && el.closest('[data-flashkey="off"]')) return null;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (el.disabled || el.readOnly) return null;
      if (matcher.sensitiveReason(fieldInfo(el))) return null;
      return { el, kind: 'input' };
    }
    if (el.isContentEditable) {
      const host = editingHost(el);
      if (host.getAttribute('aria-readonly') === 'true' || host.getAttribute('aria-disabled') === 'true') return null;
      if (matcher.sensitiveReason({ tag: 'DIV', name: host.getAttribute('name'), id: host.id, ariaLabel: host.getAttribute('aria-label') })) return null;
      return { el: host, kind: 'ce' };
    }
    return null;
  }


  /* ------------------------- text before the caret ------------------------- */






  /* ---------------------------- typed buffer ---------------------------- */

  function resetBuffer() { buffer = ''; }

  function capBuffer() {
    const max = (index && index.maxLen ? index.maxLen : matcher.MAX_TRIGGER_LENGTH) + 2;
    if (buffer.length > max) buffer = buffer.slice(-max);
  }

  function onFocusIn(e) {
    if (fromOurUI(e)) return;
    resetBuffer();
    const r = resolveEditable(targetOf(e));
    bufferEl = r ? r.el : null;
    if (!r) return;
    ensureLoaded();
    if (!reportedFocus && !SANDBOX) { reportedFocus = true; send({ type: 'fk:focused' }); }
  }

  function onPointerDown(e) {
    adoptFrames(false);
    if (overlay.isOpen() && !fromOurUI(e)) overlay.close(true);
    if (!fromOurUI(e)) resetBuffer();
  }

  function onInput(e) {
    if (expanding || dead || !e.isTrusted || fromOurUI(e)) return;
    const r = resolveEditable(targetOf(e));
    if (!r) { resetBuffer(); return; }
    if (r.el !== bufferEl) { resetBuffer(); bufferEl = r.el; }
    switch (e.inputType) {
      case 'insertText':
        if (e.data == null) { resetBuffer(); return; }
        buffer += e.data;
        break;
      case 'insertCompositionText':
        return; // committed at compositionend
      case 'deleteContentBackward':
        buffer = buffer.slice(0, -1);
        return;
      default:
        resetBuffer();
        return;
    }
    capBuffer();
    if (!loaded) { ensureLoaded(); return; }
    if (!active() || busy) return;
    // Detect right now (read-only), act after the page has handled this keystroke.
    const job = detect(r.el, r.kind);
    if (job) claim(job);
    else scheduleCheck(r.el, r.kind); // editors that commit text asynchronously
  }

  /** Reserve the engine for an expansion; keys typed meanwhile are queued and replayed. */
  function claim(job) {
    busy = true;
    clearTimeout(checkTimer);
    nextTask(() => expand(job, true));
  }

  // A MessageChannel task runs right after the page has handled the current event,
  // without setTimeout's scheduling lag (measured 2–11 ms under load).
  const channel = new MessageChannel();
  const taskQueue = [];
  channel.port1.onmessage = () => { const fn = taskQueue.shift(); if (fn) fn(); };
  function nextTask(fn) { taskQueue.push(fn); channel.port2.postMessage(0); }

  function onCompositionEnd(e) {
    if (expanding || dead || fromOurUI(e) || !e.data) return;
    const r = resolveEditable(targetOf(e));
    if (!r) return;
    if (r.el !== bufferEl) { resetBuffer(); bufferEl = r.el; }
    buffer += e.data;
    capBuffer();
    if (!active() || busy) return;
    const job = detect(r.el, r.kind);
    if (job) claim(job); else scheduleCheck(r.el, r.kind);
  }

  function scheduleCheck(el, kind) {
    clearTimeout(checkTimer);
    const snap = buffer;
    // Let the page/editor finish processing this keystroke first.
    checkTimer = setTimeout(() => {
      if (buffer !== snap || bufferEl !== el || busy || !active()) return;
      const job = detect(el, kind);
      if (job) expand(job);
    }, 0);
  }

  function readContext(el, kind) {
    const want = index.maxLen + 3;
    return kind === 'input' ? inputContext(el, want) : ceContext(el, want);
  }

  /** Pure detection: returns an expansion job or null. Never touches the DOM. */
  function detect(el, kind) {
    if (!buffer) return null;
    const ctx = readContext(el, kind);
    if (!ctx) return null;
    const last = buffer.slice(-1);
    let m = null;
    let delim = '';
    // type=email strips whitespace from its value, so the delimiter never shows up.
    if (kind === 'input' && ctx.selectable === false && /\s/.test(last) && !ctx.text.endsWith(last)) {
      m = matcher.findMatch(index, buffer.slice(0, -1), ctx.text, 'delimiter');
      if (m) return { el, kind, snippet: m.snippet, removeLen: m.len, delimiter: '' };
    }
    if (matcher.isDelimiterChar(last) && ctx.text.endsWith(last === ' ' ? ' ' : last)) {
      m = matcher.findMatch(index, buffer.slice(0, -1), ctx.text.slice(0, -1), 'delimiter');
      if (m) delim = last === ' ' ? ' ' : last;
    }
    if (!m) m = matcher.findMatch(index, buffer, ctx.text, 'immediate');
    if (!m) return null;
    return { el, kind, snippet: m.snippet, removeLen: m.len + delim.length, delimiter: settings.keepDelimiter ? delim : '' };
  }

  function onKeyDown(e) {
    if (dead || !e.isTrusted || fromOurUI(e)) return;
    const key = e.key;

    // An expansion is being applied (a few ms): hold keystrokes and replay them after,
    // so fast typists never get characters inserted in the middle of a snippet.
    if (busy && !overlay.isOpen() && !e.isComposing) {
      const plainKey = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plainKey || key === 'Backspace' || key === 'Enter' || key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (plainKey) pendingKeys += key;
        else if (key === 'Backspace') pendingKeys += '\b';
        return;
      }
    }

    // Optional Quick-Picker.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'Space' || key === ' ')) {
      const r = resolveEditable(targetOf(e));
      if (!r) return;
      if (!loaded) { e.preventDefault(); ensureLoaded().then(() => { if (settings.quickPickerShortcut && !blocked) openPicker(r.el, r.kind); }); return; }
      if (!settings.quickPickerShortcut || blocked) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openPicker(r.el, r.kind);
      return;
    }
    if (e.isComposing || key === 'Process') return;
    if (NAV_KEYS.has(key) || ((e.ctrlKey || e.metaKey || e.altKey) && key !== 'Shift' && key !== 'Control' && key !== 'Alt' && key !== 'Meta' && key !== 'AltGraph')) {
      if (!(e.ctrlKey && e.altKey)) resetBuffer(); // AltGr on Windows reports ctrl+alt
      return;
    }
    // Enter / Tab complete a delimiter-mode trigger and are consumed (never sent on).
    if ((key === 'Enter' || (key === 'Tab' && !e.shiftKey)) && buffer && active() && !busy) {
      const r = resolveEditable(targetOf(e));
      if (!r || r.el !== bufferEl) return;
      const ctx = readContext(r.el, r.kind);
      if (!ctx) return;
      const m = matcher.findMatch(index, buffer, ctx.text, 'delimiter');
      if (!m) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      claim({ el: r.el, kind: r.kind, snippet: m.snippet, removeLen: m.len, delimiter: '' });
    }
  }

  /* ------------------------------ expansion ------------------------------ */


  function restoreFocus(el, kind, loc) {
    try { el.focus({ preventScroll: true }); } catch (_) {}
    if (!loc) return;
    if (kind === 'input') {
      if (loc.selectable) { try { el.setSelectionRange(loc.end, loc.end); } catch (_) {} }
    } else if (loc.caretRange) {
      const sel = getSel(el);
      try { sel.removeAllRanges(); sel.addRange(loc.removeLen === 0 ? loc.range : loc.caretRange); } catch (_) {}
    }
  }

  async function expand(job, claimed) {
    if (busy && !claimed) return;
    busy = true;
    try {
      const sn = job.snippet;
      const rich = job.kind === 'ce' && !!sn.isRichText && !!sn.html;
      const parts = vars.parse(rich ? sn.html : sn.body);
      const plainParts = rich ? vars.parse(sn.body || sanitize.htmlToText(sn.html)) : parts;
      const prompts = vars.collectPrompts(parts);
      let loc = capture(job);
      if (!loc) return;
      loc.removeLen = job.removeLen;
      let values = {};
      let clipboard = '';
      if (vars.needsClipboard(parts)) clipboard = await readClipboard();
      const renderCtx = () => ({ values, clipboard, locale: settings.locale, dateFormat: settings.dateFormat, timeFormat: settings.timeFormat });
      if (prompts.length) {
        const res = await openFillin(job.el, prompts, sn, plainParts, () => renderCtx());
        restoreFocus(job.el, job.kind, loc);
        if (!res) return; // cancelled: the trigger stays exactly as typed
        values = res;
        const again = capture(job);
        if (!again || again.expect !== loc.expect) return;
        again.removeLen = job.removeLen;
        loc = again;
      } else if (clipboard) {
        restoreFocus(job.el, job.kind, null);
      }
      const plain = vars.render(plainParts, renderCtx());
      const richOut = rich ? vars.render(parts, Object.assign(renderCtx(), { html: true })) : null;
      await insertAll(job, loc, plain, richOut);
      if (!SANDBOX) send({ type: 'fk:expanded', id: sn.id, saved: Math.max(0, plain.text.length - job.removeLen) });
    } catch (err) {
      // Never break the page because of us.
      if (globalThis.FLASHKEY_DEBUG) console.warn('[FlashKey]', err);
    } finally {
      busy = false;
      resetBuffer();
      if (pendingKeys) replayKeys(job.el);
    }
  }

  function replayKeys(el) {
    const keys = pendingKeys;
    pendingKeys = '';
    try { if (deepActive(doc) !== el && !el.contains(deepActive(doc))) el.focus({ preventScroll: true }); } catch (_) {}
    for (const run of keys.match(/\x08|[^\x08]+/g) || []) {
      try { if (run === '\b') doc.execCommand('delete'); else doc.execCommand('insertText', false, run); } catch (_) {}
    }
  }

  async function insertAll(job, loc, plain, richOut) {
    const segs = plain.segments;
    const tail = (i) => (i === segs.length - 1 ? job.delimiter || '' : '');
    expanding = true;
    try {
      if (job.kind === 'input') {
        insertInput(job.el, loc, segs[0].text + tail(0), segs[0].cursor);
      } else if (richOut) {
        await insertCERich(job.el, loc, richOut, segs.length === 1 ? job.delimiter || '' : '');
      } else {
        await insertCEPlain(job.el, loc, segs[0].text + tail(0), segs[0].cursor);
      }
      let cur = job.el;
      for (let i = 1; i < segs.length; i++) {
        cur = focusNext(cur);
        if (!cur) break;
        await fillField(cur, segs[i].text + tail(i), segs[i].cursor);
      }
    } finally {
      expanding = false;
    }
  }

  /* ---------- Tier 1: <input> / <textarea> (incl. React/Vue/Angular) ---------- */



  /* ------------- Tier 2: contenteditable & framework rich editors ------------- */











  /* ----------------------- {tab}: fill the next field ----------------------- */





  /* ------------------------------ clipboard ------------------------------ */

  async function readClipboard() {
    const res = await send({ type: 'fk:readClipboard' });
    if (res && res.ok) return res.text || '';
    try {
      return await Promise.race([
        navigator.clipboard.readText(),
        new Promise((resolve) => setTimeout(() => resolve(''), 4000))
      ]);
    } catch (_) { return ''; }
  }

  /* ---------------- shadow-DOM UI (only when explicitly asked for) ---------------- */

  function openFillin(el, prompts, sn, plainParts, ctxFn) {
    return overlay.fillin({
      anchor: el,
      theme: settings.theme,
      prompts,
      title: sn.label || sn.trigger,
      preview: (values) => vars.render(plainParts, Object.assign(ctxFn(), { values })).text
    });
  }

  function openPicker(el, kind) {
    if (busy) return;
    const loc = capture({ el, kind, removeLen: 0 });
    const restore = () => restoreFocus(el, kind, loc ? Object.assign({ removeLen: 0 }, loc) : null);
    overlay.picker({
      anchor: el,
      theme: settings.theme,
      snippets,
      onCancel: restore,
      onPick: (s) => { restore(); expand({ el, kind, snippet: s, removeLen: 0, delimiter: '' }); }
    });
  }

  /* ------------------------- messages from the extension ------------------------- */

  function waitForFocus(ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => (doc.hasFocus() || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 25));
      tick();
    });
  }

  /** Engine of an adopted same-origin child frame that currently holds focus, if any. */
  function focusedChildEngine() {
    const a = doc.activeElement;
    if (!a || (a.tagName !== 'IFRAME' && a.tagName !== 'FRAME')) return null;
    try { const e = a.contentWindow && a.contentWindow.__flashkeyEngine; return e && e !== api ? e : null; } catch (_) { return null; }
  }

  async function insertById(id) {
    await waitForFocus(800);
    const child = focusedChildEngine();
    if (child) return child.insertById(id);
    await ensureLoaded();
    const r = resolveEditable(deepActive(doc));
    const sn = snippets.find((s) => s.id === id);
    if (!r || !sn || blocked) return { ok: false };
    try { r.el.focus({ preventScroll: true }); } catch (_) {}
    await expand({ el: r.el, kind: r.kind, snippet: sn, removeLen: 0, delimiter: '' });
    return { ok: true };
  }

  async function pickerHere() {
    const child = focusedChildEngine();
    if (child) return child.pickerHere();
    await ensureLoaded();
    const r = resolveEditable(deepActive(doc));
    if (r && !blocked) openPicker(r.el, r.kind);
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'fk:getSelection') {
      const s = win.getSelection();
      if (!s || !s.rangeCount || s.isCollapsed) { sendResponse(null); return; }
      const div = doc.createElement('div');
      div.appendChild(s.getRangeAt(0).cloneContents());
      sendResponse({ text: s.toString(), html: div.innerHTML });
      return;
    }
    if (msg.type === 'fk:openPicker') { pickerHere(); return; }
    if (msg.type === 'fk:insert') {
      insertById(msg.id).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
  }

  /* ------------------ adopting script-built same-origin frames ------------------ */

  let lastScan = 0;
  function adoptFrames(force) {
    if (SANDBOX || dead) return;
    const now = Date.now();
    if (!force && now - lastScan < 500) return;
    lastScan = now;
    const frames = doc.getElementsByTagName('iframe');
    for (let i = 0; i < frames.length; i++) {
      let cw = null;
      try {
        cw = frames[i].contentWindow;
        if (!cw) continue;
        void cw.document.body; // throws when cross-origin (those get their own engine)
        const existing = cw.__flashkeyEngine;
        if (existing) {
          // document.open()/write() — how many composers build their iframe — erases every
          // listener in that frame. Ping the engine; if nobody answers, boot a fresh one.
          existing.pong = false;
          cw.dispatchEvent(new cw.Event('flashkey:ping'));
          if (existing.pong) continue;
        }
        cw.__flashkeyEngine = boot(cw, true);
      } catch (_) {}
    }
  }

  /* -------------------------------- wiring -------------------------------- */

  const passive = { capture: true, passive: true };
  const listeners = [
    [win, 'focusin', onFocusIn, passive],
    [win, 'pointerdown', onPointerDown, passive],
    [win, 'load', () => adoptFrames(true), passive],
    [win, 'input', onInput, passive],
    [win, 'compositionend', onCompositionEnd, passive],
    [win, 'keydown', onKeyDown, { capture: true }],
    [win, 'blur', () => { resetBuffer(); reportedFocus = false; setTimeout(() => adoptFrames(true), 0); }, passive],
    [doc, 'visibilitychange', resetBuffer, passive],
    [win, 'flashkey:ping', () => { api.pong = true; }, passive]
  ];
  for (const [t, ev, fn, o] of listeners) t.addEventListener(ev, fn, o);
  if (!adopted && alive() && chrome.runtime.onMessage && !SANDBOX) chrome.runtime.onMessage.addListener(onMessage);

  function teardown() {
    dead = true;
    for (const [t, ev, fn, o] of listeners) t.removeEventListener(ev, fn, o);
    overlay.close(false);
  }

  // If the extension is reloaded/updated, this orphaned copy goes quiet.
  if (!SANDBOX) {
    const guard = () => { if (!alive()) { teardown(); win.removeEventListener('focusin', guard, true); } };
    win.addEventListener('focusin', guard, true);
  }

  // A field may already be focused (autofocus / adopted frame) when we arrive.
  try {
    const r = resolveEditable(deepActive(doc));
    if (r) { bufferEl = r.el; ensureLoaded(); }
  } catch (_) {}

  const api = {
    adopted: !!adopted,
    insertById,
    pickerHere,
    refresh: () => { if (loaded) rebuild(); },
    reload: () => { loaded = false; return ensureLoaded(); },
    state: () => ({ loaded, blocked, buffer, count: index ? index.count : 0 })
  };
  return api;
  } // end boot

  globalThis.__flashkeyEngine = boot(window, false);
})();
