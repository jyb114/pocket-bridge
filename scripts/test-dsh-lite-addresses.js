'use strict';

// Isolated address-route regression: no running gateway, credentials, or
// project data. Address paths are sensitive because they contain the access key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source');
const e2ee = require('./e2ee');

const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const handlerSource = extractFunction(source, 'serveDshLiteAddresses');
const consoleSource = extractFunction(source, 'handleConsole');
assert.ok(handlerSource && consoleSource, 'address and console handlers exist');
assert.ok(!consoleSource.includes("u.pathname === '/__dsh/lite-addresses'"),
  'addresses must not be served by the pre-auth console handler');
const requestPath = "if (u.pathname === '/__dsh/lite-addresses')";
const requestAt = source.indexOf(requestPath, source.indexOf('function handleRequestInner('));
const proofAt = source.indexOf('authProvenAt(dev.device.id)', source.indexOf('function handleRequestInner('));
assert.ok(requestAt > proofAt, 'address route must follow device and proof gates');
assert.match(source, /const serveDshLiteAddressesE2ee = e2eeWrap\(serveDshLiteAddresses\)/);
assert.ok(source.slice(requestAt, requestAt + 140).includes('serveDshLiteAddressesE2ee(req, res)'),
  'address route must use the encrypted request and response wrapper');

let statusCalls = 0;
const handler = vm.runInNewContext('(' + handlerSource + ')', {
  buildConsoleStatus: async () => {
    statusCalls++;
    return { entries: { lan: ['http://local.test/k/access-token#k=secret-key'],
      lanHttps: ['https://local.test/k/access-token#k=secret-key'],
      wan: 'https://remote.test/k/access-token#k=secret-key',
      pairPage: 'https://remote.test/pair#k=secret-key', encrypted: true } };
  },
  pickLang: () => 'zh',
  log: () => {}
});
function invoke(method, decrypted, header) {
  return new Promise(resolve => {
    const req = { method, __dshE2eeDecrypted: decrypted, headers: { 'x-dsh-e2ee': header } };
    const res = { writableEnded: false, destroyed: false, status: null,
      writeHead(status) { this.status = status; },
      end(body) { this.writableEnded = true; resolve({ status: this.status, body: JSON.parse(String(body)) }); } };
    handler(req, res);
  });
}

(async () => {
  assert.equal((await invoke('POST', false, '1')).status, 403, 'forged header alone must fail');
  assert.equal((await invoke('POST', true, '0')).status, 403, 'decryption marker without header must fail');
  assert.equal((await invoke('GET', true, '1')).status, 405, 'only the intended method is accepted');
  assert.equal(statusCalls, 0, 'unauthorized requests must not build sensitive addresses');
  const reply = await invoke('POST', true, '1');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(statusCalls, 1);
  assert.equal(reply.body.lan[0], 'http://local.test/k/access-token');
  assert.equal(reply.body.wan, 'https://remote.test/k/access-token');
  assert.ok(!JSON.stringify(reply.body).includes('secret-key'), 'fragment secret is never duplicated');

  // Exercise the real gateway wrapper with a synthetic key and encrypted body.
  // A plain JSON body from this route would expose the access-key URL to the relay.
  const secret = 'isolated-address-test-secret';
  const context = { Buffer, URL, Readable, e2ee, MAX_E2EE_BODY: 64 * 1024 * 1024, log: () => {},
    e2eeSecretOrNull: () => secret, buildConsoleStatus: async () => ({ entries: {
      lan: ['http://local.test/k/access-token#k=secret-key'], encrypted: true } }),
    pickLang: () => 'zh' };
  vm.runInNewContext([
    extractFunction(source, 'clientWantsE2ee'),
    extractFunction(source, 'wrapEncryptedResponse'),
    extractFunction(source, 'e2eeWrap'),
    handlerSource,
    'globalThis.wrapped = e2eeWrap(serveDshLiteAddresses);'
  ].join('\n'), context);
  const keys = e2ee.deriveKeys(secret, e2ee.slotAt());
  const ciphertext = e2ee.encrypt(keys.a, Buffer.from('{}'));
  const encrypted = await new Promise(resolve => {
    const req = Readable.from([ciphertext]);
    req.method = 'POST'; req.url = '/__dsh/lite-addresses';
    req.headers = { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json; charset=utf-8' };
    req.socket = {};
    const res = { destroyed: false, writableEnded: false, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
      getHeader() { return null; },
      end(body) { this.writableEnded = true; resolve({ status: this.status, headers: this.headers, body }); },
      destroy() { this.destroyed = true; resolve({ status: null, headers: {}, body: null }); } };
    context.wrapped(req, res);
  });
  assert.equal(encrypted.status, 200);
  assert.equal(encrypted.headers['x-dsh-e2ee'], '1');
  assert.equal(encrypted.headers['content-type'], 'application/octet-stream');
  assert.ok(!encrypted.body.includes(Buffer.from('access-token')));
  const opened = JSON.parse(e2ee.decrypt(keys.b, encrypted.body).toString('utf8'));
  assert.equal(opened.lan[0], 'http://local.test/k/access-token');
  console.log('DSH Lite address gate and encrypted response: 6 isolated checks passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
