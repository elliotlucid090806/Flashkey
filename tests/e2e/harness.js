/*
 * E2E harness: launches Chromium with the unpacked extension, serves the
 * fixture pages on localhost, and exposes helpers to seed storage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'flashkey');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const file = path.join(FIXTURES, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launch(opts = {}) {
  const { chromium } = loadPlaywright();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: opts.headless !== false,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  context.setDefaultTimeout(10000);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = sw.url().split('/')[2];
  // Wait until onInstalled seeding has completed.
  for (let i = 0; i < 100; i++) {
    const ok = await sw.evaluate(() => chrome.storage.local.get('snippets').then((r) => Array.isArray(r.snippets)));
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const { server, port } = await startServer();
  const errors = [];
  context.on('page', (p) => trackErrors(p, errors));
  for (const p of context.pages()) trackErrors(p, errors);

  const api = {
    context, sw, extensionId, port, errors,
    url: (p, host = 'localhost') => `http://${host}:${port}/pages/${p}`,
    extUrl: (p) => `chrome-extension://${extensionId}/${p}`,
    async setData(data) { await sw.evaluate((d) => chrome.storage.local.set(d), data); },
    async getData(keys) { return sw.evaluate((k) => chrome.storage.local.get(k), keys); },
    async setSnippets(list, settings) {
      const now = Date.now();
      const snippets = list.map((s, i) => Object.assign({ id: 'sn' + i, label: '', html: '', isRichText: false, folderId: 'default', tags: [], enabled: true, matchCase: null, triggerMode: null, pinned: false, useCount: 0, createdAt: now, updatedAt: now }, s));
      const cur = await api.getData('settings');
      const st = Object.assign({}, cur.settings || {}, { enabled: true, blockedDomains: [] }, settings || {});
      await api.setData({ snippets, settings: st });
    },
    async close() {
      server.close();
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
  return api;
}

function trackErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(`[pageerror] ${page.url()} ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[Violation\]/.test(m.text())) errors.push(`[console.${m.type()}] ${page.url()} ${m.text()}`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { launch, sleep, ROOT, EXT, FIXTURES, loadPlaywright };
