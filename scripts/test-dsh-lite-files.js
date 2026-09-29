'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createDshLiteFiles } = require('./dsh-lite-files');

const win = path.win32;
const home = 'D:\\fixture-home';
const root = 'D:\\fixture-workspace';
const store = JSON.stringify({ tables: { workspaces: { w1: {
  path: root, sessionIds: ['session-1']
} } } });
const names = ['sub', 'outside-link', ...Array.from({ length: 105 }, (_, i) =>
  'file-' + String(i).padStart(3, '0') + '.txt')];
const mock = {
  statSync(file) {
    if (file === win.join(home, 'storages', 'workspace.json')) return { isFile: () => true, size: store.length };
    if (file === root || file === win.join(root, 'sub')) return { isDirectory: () => true, isFile: () => false };
    if (file.startsWith(root + '\\') && file.endsWith('.txt')) return {
      isDirectory: () => false, isFile: () => true, size: 9
    };
    throw new Error('ENOENT');
  },
  readFileSync(file, encoding) {
    if (file === win.join(home, 'storages', 'workspace.json') && encoding === 'utf8') return store;
    throw new Error('ENOENT');
  },
  realpathSync(file) {
    if (file === win.join(root, 'outside-link')) return 'C:\\private';
    if (file === root || file === win.join(root, 'sub') ||
        (file.startsWith(root + '\\') && file.endsWith('.txt'))) return file;
    throw new Error('ENOENT');
  },
  opendirSync(file) {
    if (file !== root && file !== win.join(root, 'sub')) throw new Error('ENOENT');
    const entries = file === root ? names : ['inside.txt'];
    let index = 0;
    return { readSync() { return index < entries.length ? { name: entries[index++] } : null; }, closeSync() {} };
  }
};
const handler = createDshLiteFiles({ fs: mock, path: win, homes: [home] });

async function invoke(body = { sessionId: 'session-1', path: '', offset: 0 }, options = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  const req = Readable.from([bytes]);
  req.method = options.method || 'POST';
  req.url = options.url || '/__dsh/lite-files';
  req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': options.encrypted === false ? '0' : '1',
    'content-type': options.contentType || 'application/json', 'content-length': String(bytes.length) };
  const res = { status: null, headers: null, body: null, destroyed: false, writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.body = JSON.parse(String(value)); this.writableEnded = true; } };
  await handler(req, res);
  return res;
}

(async () => {
  let checks = 0;
  async function check(label, run) { await run(); checks++; console.log('PASS ' + label); }
  await check('root directory lists only canonical workspace entries in stable pages', async () => {
    const first = await invoke();
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.body.path, '');
    assert.equal(first.body.entries.length, 100);
    assert.equal(first.body.entries[0].type, 'directory');
    assert.equal(first.body.entries[0].path, 'sub');
    assert.equal(first.body.entries.some(item => item.name === 'outside-link'), false);
    assert.equal(first.body.nextOffset, 100);
    const second = await invoke({ sessionId: 'session-1', path: '', offset: 100 });
    assert.equal(second.status, 200);
    assert.equal(second.body.entries.length, 6);
    assert.equal(second.body.nextOffset, null);
  });
  await check('relative child directory can be opened without exposing absolute root', async () => {
    const result = await invoke({ sessionId: 'session-1', path: 'sub', offset: 0 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.entries, [{ name: 'inside.txt', path: 'sub/inside.txt', type: 'file', bytes: 9 }]);
    assert.equal(JSON.stringify(result.body).includes(root), false);
  });
  await check('plaintext, query metadata and traversal never list files', async () => {
    assert.equal((await invoke(undefined, { decrypted: false })).status, 403);
    assert.equal((await invoke(undefined, { encrypted: false })).status, 403);
    assert.equal((await invoke(undefined, { method: 'GET' })).status, 405);
    assert.equal((await invoke(undefined, { url: '/__dsh/lite-files?path=sub' })).status, 400);
    for (const bad of ['..', '../secret', 'C:\\private', '\\\\host\\share', 'sub:ads', 'sub//next']) {
      assert.equal((await invoke({ sessionId: 'session-1', path: bad, offset: 0 })).status, 400);
    }
  });
  await check('unknown Session and invalid paging fail closed', async () => {
    assert.equal((await invoke({ sessionId: 'unknown', path: '', offset: 0 })).status, 404);
    assert.equal((await invoke({ sessionId: 'session-1', path: '', offset: -1 })).status, 400);
    assert.equal((await invoke({ sessionId: 'session-1', path: '', offset: 10001 })).status, 400);
  });
  console.log('DSH lite files: ' + checks + ' isolated groups passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
