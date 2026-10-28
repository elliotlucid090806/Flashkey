/*
 * FlashKey — minimal MV3 service worker.
 *
 * Jobs: first-install seeding (never overwrites), forward-only migrations,
 * context menus, batching usage stats, routing popup "insert" requests to the
 * focused frame, and reading the clipboard via an offscreen document.
 * Zero network access. Zero telemetry.
 */
/* global importScripts, FlashKey */
importScripts('shared/matcher.js', 'shared/formats.js', 'shared/storage.js');

const store = FlashKey.storage.createStore(chrome.storage.local);
const MENU_SAVE = 'fk-save-selection';
const MENU_INSERT = 'fk-insert-snippet';

/* ------------------------------ lifecycle ------------------------------ */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    await store.init({ seedIfEmpty: true });
  } catch (err) {
    console.error('[FlashKey] init failed', err);
  }
  setupMenus();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') });
});

chrome.runtime.onStartup.addListener(() => { setupMenus(); });

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SAVE, title: 'Save selection as FlashKey snippet', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_INSERT, title: 'Insert FlashKey snippet…', contexts: ['editable'] });
    void chrome.runtime.lastError;
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_SAVE) {
    let picked = null;
    if (tab && tab.id >= 0) {
      try { picked = await chrome.tabs.sendMessage(tab.id, { type: 'fk:getSelection' }, { frameId: info.frameId || 0 }); } catch (_) { picked = null; }
    }
    const draft = {
      body: (picked && picked.text) || info.selectionText || '',
      html: (picked && picked.html) || '',
      source: info.pageUrl ? safeHost(info.pageUrl) : ''
    };
    await chrome.storage.session.set({ pendingDraft: draft });
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#new-from-selection') });
  } else if (info.menuItemId === MENU_INSERT && tab && tab.id >= 0) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'fk:openPicker' }, { frameId: info.frameId || 0 }); } catch (_) {}
  }
});

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

/* ------------------------- focused-frame routing ------------------------- */

const focusedFrame = new Map(); // tabId -> frameId (memory; mirrored to session storage)

async function rememberFrame(tabId, frameId) {
  focusedFrame.set(tabId, frameId);
  try { await chrome.storage.session.set({ ['frame:' + tabId]: frameId, lastFocus: { tabId, frameId, at: Date.now() } }); } catch (_) {}
}

async function frameFor(tabId) {
  if (focusedFrame.has(tabId)) return focusedFrame.get(tabId);
  try {
    const r = await chrome.storage.session.get('frame:' + tabId);
    if (r && Number.isInteger(r['frame:' + tabId])) return r['frame:' + tabId];
  } catch (_) {}
  return 0;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  focusedFrame.delete(tabId);
  chrome.storage.session.remove('frame:' + tabId).catch(() => {});
});

/* ------------------------------- usage stats ------------------------------- */

let pendingCounts = {};
let pendingChars = 0;
let flushTimer = 0;

function queueUsage(id, saved) {
  if (id) pendingCounts[id] = (pendingCounts[id] || 0) + 1;
  pendingChars += Math.max(0, Number(saved) || 0);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushUsage, 1500);
}

async function flushUsage() {
  const counts = pendingCounts;
  const chars = pendingChars;
  pendingCounts = {};
  pendingChars = 0;
  if (!Object.keys(counts).length && !chars) return;
  try { await store.recordUsage(counts, chars); } catch (err) { console.error('[FlashKey] stats', err); }
}

/* ---------------------------- clipboard (offscreen) ---------------------------- */

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Read the clipboard text for the {clipboard} snippet variable.'
  }).catch((err) => {
    if (!String(err && err.message).includes('single offscreen')) throw err;
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function readClipboard() {
  const granted = await chrome.permissions.contains({ permissions: ['clipboardRead'] });
  if (!granted) return { ok: false, reason: 'permission' };
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'fk:offscreen-read' });
    return res && typeof res.text === 'string' ? { ok: true, text: res.text } : { ok: false, reason: 'empty' };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
}

/* -------------------------------- messages -------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'fk:expanded':
      queueUsage(msg.id, msg.saved);
      return;
    case 'fk:focused':
      if (sender.tab && sender.tab.id >= 0) rememberFrame(sender.tab.id, sender.frameId || 0);
      return;
    case 'fk:readClipboard':
      readClipboard().then(sendResponse);
      return true;
    case 'fk:insertInTab':
      (async () => {
        const frameId = await frameFor(msg.tabId);
        try {
          const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'fk:insert', id: msg.id }, { frameId });
          sendResponse(r || { ok: false });
        } catch (_) { sendResponse({ ok: false }); }
      })();
      return true;
    case 'fk:flush':
      flushUsage().then(() => sendResponse({ ok: true }));
      return true;
  }
});
