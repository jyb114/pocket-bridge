'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createDshLiteDownload, workspaceRootFor, MAX_FILE_BYTES } = require('./dsh-lite-download');

const win = path.win32;
const home = 'D:\\fixture-home';
const workspace = 'D:\\fixture-workspace';
const text = Buffer.from('safe file');
const store = JSON.stringify({ tables: { workspaces: { w1: {
  path: workspace, sessionIds: ['session-1']
} } } });
const mock = {
  statSync(file) {
    if (file === win.join(home, 'storages', 'workspace.json')) return { isFile: () => true, size: store.length };
    if (file === win.join(workspace, 'safe.txt')) return { isFile: () => true, size: text.length };
    if (file === win.join(workspace, 'large.bin')) return { isFile: () => true, size: MAX_FILE_BYTES + 1 };
    throw new Error('ENOENT');
  },
  readFileSync(file, encoding) {
    if (file === win.join(home, 'storages', 'workspace.json') && encoding === 'utf8') return store;
    if (file === win.join(workspace, 'safe.txt')) return text;
    throw new Error('ENOENT');
  },
  realpathSync(file) {
    if (file === workspace || file === win.join(workspace, 'safe.txt') ||
        file === win.join(workspace, 'large.bin')) return file;
    if (file === win.join(workspace, 'link', 'private.txt')) return 'C:\\private\\secret.txt';
    throw new Error('ENOENT');
  }
};
const handler = createDshLiteDownload({ fs: mock, path: win, homes: [home] });
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
async function invoke(input = { sessionId: 'session-1', path: 'safe.txt' }, options = {}) {
  const body = Buffer.from(JSON.stringify(input));
  const req = Readable.from([body]);
  req.url = options.url || '/__dsh/lite-download';
  req.method = options.method || 'POST';
  req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': options.encrypted === false ? '0' : '1',
    'content-type': options.contentType || 'application/json', 'content-length': String(body.length) };
  const res = { status: null, headers: null, data: null, destroyed: false, writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.data = value; this.writableEnded = true; } };
  await handler(req, res);
  return { status: res.status, headers: res.headers, bytes: res.data,
    body: Buffer.isBuffer(res.data) ? null : JSON.parse(res.data) };
}

(async () => {
  await check('known Session resolves exactly one DSH-owned workspace', async () => {
    assert.equal(workspaceRootFor('session-1', { fs: mock, path: win, homes: [home] }), workspace);
    assert.equal(workspaceRootFor('other-session', { fs: mock, path: win, homes: [home] }), null);
  });
  await check('safe workspace file returns bytes for encrypted response wrapper', async () => {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, text);
    assert.equal(result.headers['content-type'], 'application/octet-stream');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['content-disposition'], undefined, 'filename stays inside the encrypted request');
  });
  await check('plaintext, query metadata, invalid methods and paths are rejected', async () => {
    assert.equal((await invoke(undefined, { encrypted: false })).status, 403);
    assert.equal((await invoke(undefined, { decrypted: false })).status, 403);
    assert.equal((await invoke(undefined, { method: 'GET' })).status, 405);
    assert.equal((await invoke(undefined, { contentType: 'text/plain' })).status, 415);
    assert.equal((await invoke(undefined, { url: '/__dsh/lite-download?path=safe.txt' })).status, 400);
    for (const file of ['../private.txt', '.\\safe.txt', 'C:\\private\\secret.txt',
      '\\\\host\\share\\secret.txt', 'safe.txt:stream']) {
      assert.equal((await invoke({ sessionId: 'session-1', path: file })).status >= 400, true);
    }
    assert.equal((await invoke({ sessionId: 'other-session', path: 'safe.txt' })).status, 404);
  });
  await check('junction escape and oversize file are rejected before content read', async () => {
    assert.equal((await invoke({ sessionId: 'session-1', path: 'link\\private.txt' })).status, 403);
    assert.equal((await invoke({ sessionId: 'session-1', path: 'large.bin' })).status, 413);
  });
  console.log('DSH lite download: ' + checks + ' isolated groups passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
