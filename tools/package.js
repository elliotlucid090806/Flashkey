#!/usr/bin/env node
/*
 * Packages ./flashkey into dist/flashkey-v<version>.zip for the Chrome Web Store.
 * Dependency-free: writes a standard ZIP (deflate) using Node's zlib.
 * Also verifies every file the manifest references exists and reports the size budget.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'flashkey');
const DIST = path.join(ROOT, 'dist');
const BUDGET = 150 * 1024;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.name.startsWith('.') || d.name === 'node_modules') return [];
    return d.isDirectory() ? walk(p) : [p];
  });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed timestamp => reproducible builds
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function checkManifest(manifest) {
  const refs = new Set();
  const add = (p) => p && refs.add(p);
  Object.values(manifest.icons || {}).forEach(add);
  Object.values((manifest.action || {}).default_icon || {}).forEach(add);
  add((manifest.action || {}).default_popup);
  add(manifest.options_page);
  add((manifest.background || {}).service_worker);
  for (const cs of manifest.content_scripts || []) (cs.js || []).concat(cs.css || []).forEach(add);
  const missing = [...refs].filter((p) => !fs.existsSync(path.join(EXT, p)));
  for (const html of walk(EXT).filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(html, 'utf8');
    for (const m of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(html), m[1]))) missing.push(path.relative(EXT, html) + ' -> ' + m[1]);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(src)) missing.push(path.relative(EXT, html) + ': inline <script> is blocked by MV3 CSP');
  }
  return missing;
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const problems = checkManifest(manifest);
if (problems.length) { console.error('Manifest/asset problems:\n  ' + problems.join('\n  ')); process.exit(1); }
if (manifest.description.length > 132) { console.error('Description exceeds 132 characters.'); process.exit(1); }

const files = walk(EXT).sort().map((p) => ({ name: path.relative(EXT, p).split(path.sep).join('/'), data: fs.readFileSync(p) }));
const raw = files.reduce((n, f) => n + f.data.length, 0);
const out = zip(files);
fs.mkdirSync(DIST, { recursive: true });
const target = path.join(DIST, `flashkey-v${manifest.version}.zip`);
fs.writeFileSync(target, out);
console.log(`${files.length} files · ${(raw / 1024).toFixed(1)} KB unpacked · ${(out.length / 1024).toFixed(1)} KB zipped → ${path.relative(ROOT, target)}`);
console.log(out.length <= BUDGET ? `Packed size is within the ${BUDGET / 1024} KB budget.` : `Packed size is over the ${BUDGET / 1024} KB budget.`);
if (out.length > BUDGET) process.exit(1);
