'use strict';

// Exercise the actual encrypted-body file handler in isolation. No running
// gateway, Codex process, real workspace, or credentials are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const e2ee = require('./e2ee.js');
const { extractFunction } = require('./page-source.js');

const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const names = ['clientWantsE2ee', 'e2eeWrap', 'serveCodexPrivateFile'];
const functions = names.map(name => {
  const body = extractFunction(source, name);
  assert.ok(body, `missing ${name}`);
  return name === 'serveCodexPrivateFile' ? 'async ' + body : body;
}).join('\n');
const secret = 'isolated-codex-private-file-secret-012345';
const seen = [];
let responseWrapperCalls = 0;
const context = vm.createContext({
  Buffer, URL, Readable, e2ee, MAX_E2EE_BODY: 64 * 1024 * 1024,
  e2eeSecretOrNull: () => secret,
  log() {},
  wrapEncryptedResponse() { responseWrapperCalls++; },
  serveCodexFile(req, res, url) {
    seen.push({ path: url.searchParams.get('path'), width: url.searchParams.get('w'), requestUrl: req.url });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1' });
    res.end(Buffer.from('encrypted-file-response'));
  }
});
vm.runInContext(functions + '\nthis.privateFile = e2eeWrap(serveCodexPrivateFile, { responseEncryptedByHandler: true });', context);

function invoke({ body, encrypted = true, url = '/codex/file', type = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const wire = encrypted ? e2ee.encrypt(e2ee.deriveKeys(secret, e2ee.slotAt()).a, bytes) : bytes;
    const req = Readable.from([wire]);
    req.method = 'POST';
    req.url = url;
    req.headers = encrypted
      ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': type, 'content-type': 'application/octet-stream' }
      : { 'content-type': type };
    req.socket = {};
    const res = {
      destroyed: false, writableEnded: false, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
      end(data) { this.writableEnded = true; this.body = data; resolve(this); },
      destroy() { this.destroyed = true; reject(new Error('unexpected response destroy')); }
    };
    const timer = setTimeout(() => reject(new Error('file handler timed out')), 2000);
    const finish = resolve;
    resolve = value => { clearTimeout(timer); finish(value); };
    context.privateFile(req, res);
  });
}

(async () => {
  const value = await invoke({ body: { path: 'D:\\work\\figure.png', w: 640 } });
  assert.equal(value.status, 200);
  assert.equal(value.headers['x-dsh-e2ee'], '1');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { path: 'D:\\work\\figure.png', width: '640', requestUrl: '/codex/file' });
  assert.equal(responseWrapperCalls, 0, 'streaming response must use sendFile encryption only');

  let response = await invoke({ body: { path: 'D:\\work\\figure.png' }, encrypted: false });
  assert.equal(response.status, 403);
  assert.equal(seen.length, 1, 'plaintext request reached the file reader');
  response = await invoke({ body: { path: 'D:\\work\\figure.png' }, url: '/codex/file?path=visible' });
  assert.equal(response.status, 400);
  response = await invoke({ body: { path: 'D:\\work\\figure.png', w: 2001 } });
  assert.equal(response.status, 400);
  response = await invoke({ body: { path: 'D:\\work\\figure.png', root: 'D:\\' } });
  assert.equal(response.status, 400);
  response = await invoke({ body: { path: 'D:\\work\\figure.png' }, type: 'text/plain' });
  assert.equal(response.status, 415);
  response = await invoke({ body: Buffer.from('not a valid encrypted envelope'), encrypted: false,
    type: 'application/octet-stream' });
  assert.equal(response.status, 403);
  assert.equal(seen.length, 1);

  const route = source.slice(source.indexOf("if (u.pathname === '/codex/file')"));
  assert.match(route, /if \(req\.method === 'POST'\) serveCodexPrivateFileE2ee\(req, res\)/);
  assert.match(route, /else if \(req\.method === 'GET' && viaRelay\(req\)\)[\s\S]{0,500}writeHead\(426/,
    'legacy GET must be unavailable through a tunnel, even when its bytes are encrypted');
  assert.match(route, /else if \(req\.method === 'GET'\) serveCodexFile\(req, res, u\)/,
    'legacy direct LAN GET must remain available');
  assert.match(source, /'\/codex\/file',\s*\/\/ 图片与附件字节/);
  assert.match(source, /const wantE2ee = clientWantsE2ee\(req, u\) && !!e2eeBridge\.readSecret\(\)/);
  // The private POST intentionally skips e2eeWrap's generic response writer:
  // the existing sendFile encryptor must actually seal the returned bytes.
  const sendFileSource = extractFunction(source, 'sendFile');
  const payload = Buffer.from('private file body never visible to tunnel');
  const fileContext = vm.createContext({
    Buffer, e2ee, path, log() {},
    fs: { statSync() { return { size: payload.length }; }, readFile(_file, callback) { callback(null, payload); } },
    e2eeBridge: { readSecret() { return secret; } }
  });
  const sendFile = vm.runInContext(`${sendFileSource}; sendFile`, fileContext);
  const encryptedFile = await new Promise(resolve => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(body) { this.body = body; resolve(this); }
    };
    sendFile(res, 'D:\\work\\figure.png', 'image/png', true);
  });
  assert.equal(encryptedFile.status, 200);
  assert.equal(encryptedFile.headers['x-dsh-e2ee'], '1');
  assert.ok(!encryptedFile.body.includes(payload));
  const unsealed = e2ee.decrypt(e2ee.deriveKeys(secret, e2ee.slotAt()).b, encryptedFile.body);
  assert.deepEqual(unsealed, payload);
  fileContext.e2eeBridge.readSecret = () => { throw new Error('missing key'); };
  const failedFile = await new Promise(resolve => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(body) { this.body = body; resolve(this); }
    };
    sendFile(res, 'D:\\work\\figure.png', 'image/png', true);
  });
  assert.equal(failedFile.status, 500);
  assert.ok(!String(failedFile.body).includes(payload.toString('utf8')));
  console.log('PASS Codex file POST keeps paths in authenticated ciphertext, rejects plaintext/query/invalid bodies, and retains encrypted file response');
})().catch(error => { console.error(error); process.exitCode = 1; });
