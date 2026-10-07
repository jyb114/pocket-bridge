'use strict';
// Test-only dependency injection. Never delete or reset the default server
// ledger: each fixture process gets a genuine private, bounded ReplayStore.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const replay = require('./replay-store.js');
let installed = null;
function install() {
  if (installed) return installed;
  const inherited = path.resolve(os.tmpdir());
  const parent = process.platform === 'win32' && !/^D:\\/i.test(inherited) && fs.existsSync('D:\\桥') ? 'D:\\桥\\security-fixtures-preview10' : inherited;
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'replay-test-process-'));
  const resolved = path.resolve(root), allowed = path.resolve(parent) + path.sep;
  if (!resolved.startsWith(allowed) || fs.lstatSync(resolved).isSymbolicLink()) throw Error('Unsafe isolated replay fixture path.');
  installed = new replay.ReplayStore({ file: path.join(resolved, 'receipts.jsonl') });
  replay.defaultStore = installed;
  process.once('exit', () => {
    try {
      if (!path.resolve(root).startsWith(allowed) || fs.lstatSync(root).isSymbolicLink()) throw Error('Isolated replay cleanup refused.');
      fs.rmSync(root, { recursive: true });
    } catch (_) { process.exitCode = 1; }
  });
  return installed;
}
module.exports = { install };
