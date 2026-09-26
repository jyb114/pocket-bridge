'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const { isSupportedRuntime } = require('./runtime-requirements.js');

assert.equal(isSupportedRuntime('18.20.8', false), false);
assert.equal(isSupportedRuntime('20.20.2', false), false);
assert.equal(isSupportedRuntime('24.18.1', false), false);
assert.equal(isSupportedRuntime('24.18.1', true), true);

const unsupported = spawnSync(process.execPath, ['-e',
  "globalThis.WebSocket=undefined;require('./scripts/runtime-requirements.js').assertSupportedRuntime()"],
{ cwd: root, encoding: 'utf8' });
assert.notEqual(unsupported.status, 0);
assert.match(unsupported.stderr, /requires Node\.js 24 or newer/);

for (const entry of ['scripts/gateway-daemon.js', 'scripts/mobile-proxy.js']) {
  const source = fs.readFileSync(path.join(root, entry), 'utf8');
  assert(/require\(['"]\.\/runtime-requirements\.js['"]\)\.assertSupportedRuntime\(\)/.test(source),
    `${entry} must reject unsupported source runtimes before starting`);
}
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node, '>=24');
assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Source users need Node\.js 24 or newer/);
assert.match(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'), /node-version:\s*['"]24['"]/);
const setup = fs.readFileSync(path.join(root, 'desktop/setup.cmd'), 'ascii');
assert.match(setup, /Node\.js 24\+/);
assert.match(setup, /runtime-requirements\.js/);

console.log('Node.js 24 requirement is enforced and documented');
