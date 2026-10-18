'use strict';

// Execute the real Browser.kill with owned synthetic handles. No browser or
// process is launched, enumerated, signaled, or removed by this regression.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'browser-check.js'), 'utf8');
let checks = 0;
function fixture(failWs = false, failProcess = false) {
  const scheduled = [], removed = [], external = [], closed = [], killed = [];
  const sandbox = { __dirname, Buffer, URL, console, process: { platform: 'win32', env: {}, argv: [] },
    module: { exports: {} }, setTimeout(fn, ms) { scheduled.push({ fn, ms }); },
    require(name) {
      if (name === 'fs') return { ...fs, rmSync(...args) { removed.push(args); } };
      if (name === 'child_process') return {
        spawn(...args) { external.push(['spawn', args]); throw Error('Unexpected process'); },
        execFileSync(...args) { external.push(['exec', args]); throw Error('Unexpected global cleanup'); }
      };
      return require(name);
    } };
  vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: 'scripts/browser-check.js' });
  const { Browser } = sandbox.module.exports;
  function browser(label) {
    const value = Object.create(Browser.prototype); value.profile = path.join('D:', 'owned-test-profiles', label);
    value.ws = { close() { closed.push(label); if (failWs) throw Error('Owned websocket already closed'); } };
    value.proc = { kill() { killed.push(label); if (failProcess) throw Error('Owned child already exited'); } };
    return value;
  }
  return { scheduled, removed, external, closed, killed, browser };
}
for (const [failWs, failProcess] of [[false, false], [true, false], [false, true], [true, true]]) {
  const f = fixture(failWs, failProcess), owned = f.browser('first'), untouched = f.browser('other');
  owned.kill();
  assert.deepEqual(f.closed, ['first']); assert.deepEqual(f.killed, ['first']);
  assert.equal(f.external.length, 0, 'cleanup must never enumerate, taskkill or signal a global pattern');
  assert.equal(f.scheduled.length, 1); assert.equal(f.scheduled[0].ms, 1500);
  f.scheduled[0].fn(); assert.equal(f.removed.length, 1); assert.equal(f.removed[0][0], owned.profile);
  assert.notEqual(f.removed[0][0], untouched.profile);
  assert.deepEqual(JSON.parse(JSON.stringify(f.removed[0][1])), { recursive: true, force: true });
  checks++;
}
for (const file of ['test-dsh-lite-ui.js', 'test-dsh-lite-actions.js', 'test-dsh-lite-backup-browser.js', 'test-backup-preparation-browser.js']) {
  const fixtureSource = fs.readFileSync(path.join(__dirname, file), 'utf8');
  assert.match(fixtureSource, /\.replace\((?:sweepCall|'    sweepOrphanBrowsers\(\);')/,
    'selected isolated browser fixture must still disable cross-session orphan sweeping: ' + file);
  checks++;
}
console.log('Browser cleanup scope: ' + checks + ' checks passed; only the instance-owned process and profile are touched.');
