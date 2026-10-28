#!/usr/bin/env node
/* Builds the real-editor fixtures, then runs the end-to-end suite against the unpacked extension. */
const { spawnSync } = require('child_process');
const path = require('path');

(async () => {
  await require('../fixtures/build.js')();
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', '--test-reporter=spec', path.join(__dirname, 'extension.test.js')], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
})().catch((e) => { console.error(e); process.exit(1); });
