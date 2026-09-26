'use strict';

// A pagehide request must never mark plaintext as an E2EE body. This runs
// the real pagehide handler, if present, without a gateway or browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'codex.html'), 'utf8');
const start = source.indexOf("try {\n  window.addEventListener('pagehide'");
if (start < 0) {
  console.log('  ✓ no pagehide lock request; server disconnect fallback owns release');
  process.exit(0);
}
const end = source.indexOf('\n} catch (e) { }', start);
assert(end > start, 'pagehide handler must be extractable');
let handler;
const requests = [];
vm.runInNewContext(source.slice(start, end + '\n} catch (e) { }'.length), {
  window: {
    __dshE2eeSecret: 'fixture-secret',
    addEventListener(name, callback) { if (name === 'pagehide') handler = callback; }
  },
  state: { thread: { id: 'thread-fixture' }, resumed: true },
  fetch(url, init) { requests.push({ url, init }); return Promise.resolve({ ok: true }); },
  JSON
});
assert.strictEqual(typeof handler, 'function');
handler();
const mislabeled = requests.some(({ url, init }) => {
  if (url !== '/codex/lock' || !init || !init.body) return false;
  const headers = init.headers || {};
  return headers['x-dsh-e2ee'] === '1' &&
    typeof init.body === 'string' && init.body.includes('thread-fixture');
});
assert(!mislabeled, 'pagehide sends plaintext thread ID while claiming E2EE');
console.log('  ✓ pagehide lock request never mislabels plaintext as E2EE');
