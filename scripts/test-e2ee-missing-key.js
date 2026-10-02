'use strict';

// Actual gateway functions over isolated HTTP, with synthetic authentication,
// key storage and file bytes. No production key, desktop, model or file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source.js');
const e2ee = require('./e2ee.js');
const origin = require('./request-origin.js');

const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const secretSource = fs.readFileSync(path.join(__dirname, 'ws-e2ee-bridge.js'), 'utf8');
const SECRET = 'isolated-missing-key-secret-0123456789';
const LOGIN = 'isolated-login-cookie';
const PRIVATE_TEXT = 'Private synthetic desktop instruction';
const BODY = { action: 'send', id: 'isolated-request',
  threadId: '01a0f60e-881d-7ed0-8cfe-a5c356738b45', cwd: 'D:\\isolated-project', text: PRIVATE_TEXT };
const FILE_PATH = 'D:\\isolated-project\\result.txt';
const FILE_BYTES = Buffer.from('Private synthetic file bytes');
const FAILURE = JSON.stringify({ ok: false, code: 'encryption-unavailable',
  message: 'Encrypted content is temporarily unavailable. Check the computer gateway and retry.' });
let storedSecret = SECRET, readError = null, keyReads = 0, unavailableAfter = Infinity;
let fileReads = 0, plaintextStreams = 0, dispatches = 0, wsDispatches = 0, checkedWsKey = null, checks = 0;
const keyEnv = {};
const keyContext = vm.createContext({ URL, process: { env: keyEnv }, SECRET_FILE: 'synthetic-key-storage',
  fs: { readFileSync() {
    keyReads++;
    if (readError || keyReads > unavailableAfter)
      throw Object.assign(Error('Synthetic key storage failure'), { code: readError || 'ENOENT' });
    return storedSecret;
  } } });
vm.runInContext(extractFunction(secretSource, 'readSecret') + '\n' + extractFunction(secretSource, 'wanted') +
  '; this.readSecret = readSecret; this.wanted = wanted;', keyContext);
const context = {
  Buffer, URL, Readable, e2ee, path, crypto, setTimeout, setImmediate, MAX_E2EE_BODY: 64 * 1024 * 1024,
  COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN, GATEWAY_AUTH_COOKIE: 'fixture-login',
  ACCESS_KEY: 'fixture-access-key', DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device',
  e2eeBridge: { readSecret: keyContext.readSecret, wanted: keyContext.wanted }, viaRelay: origin.viaRelay,
  isLocalRequest: origin.isLoopback, isSelfCheck: () => false, isSelfClientRequest: () => false,
  routes: { clientIpOf: req => req.socket.remoteAddress },
  sessions: { verify: token => token === 'valid-device'
    ? { ok: true, device: { id: 'fixture-proven', label: 'Fixture' } }
    : { ok: false, reason: 'revoked' } },
  authProvenAt: id => id === 'fixture-proven', authObserved: new Set(),
  proofBootWindowOpen: () => false, proofLooksInProgress: () => false,
  proofWaitHits: new Map(), PROOF_WAIT_FULL_MS: 100, PROOF_WAIT_MS: 100, PROOF_WAIT_MAX_PER_DEVICE: 1,
  PWA_ROUTES: {}, dshLazyImageStore: { imageDigestFromPath: () => null },
  handleConsole: () => false, isBootstrapRequest: () => false, log() {},
  pageLanguage: () => 'en', pageText: () => ({ errors: { noKey: 'Authentication required: ' } }),
  deviceErrorPage: () => 'Device authentication failed.',
  PLAINTEXT_REFUSED: { zh: { head: 'Encrypted request required', body: '', how: '' },
    en: { head: 'Encrypted request required', body: '', how: '' } }, pickLang: () => 'en',
  resolveRequestedPath: value => value, resolveCodexFileAccess: value => ({ realPath: value }),
  FILE_MIME: { '.txt': 'text/plain; charset=utf-8' },
  fs: {
    stat(_file, callback) { setImmediate(() => callback(null, { isFile: () => true })); },
    statSync() { return { size: FILE_BYTES.length }; },
    readFile(_file, callback) { fileReads++; setImmediate(() => callback(null, FILE_BYTES)); },
    createReadStream() { plaintextStreams++; return Readable.from([FILE_BYTES]); }
  }
};
const names = ['readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie',
  'keyMatches', 'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof',
  'e2eeSecretOrNull', 'refuseEncryptionUnavailable', 'refuseEncryptionUnavailableUpgrade', 'refusePlaintext', 'clientWantsE2ee',
  'wrapEncryptedResponse', 'e2eeWrap', 'serveCodexPrivateFile', 'serveCodexFile', 'sendFile', 'handleRequestInner', 'handleUpgrade'];
vm.createContext(context);
vm.runInContext(names.map(name => {
  let body;
  if (name === 'ensureDevice') {
    const start = source.indexOf('function ensureDevice('), brace = source.indexOf(') {', start) + 2;
    body = source.slice(start, brace) + extractFunction('function isolatedBody() ' + source.slice(brace), 'isolatedBody')
      .replace('function isolatedBody() ', '');
  } else body = extractFunction(source, name);
  assert.ok(body, name);
  return name === 'serveCodexPrivateFile' ? 'async ' + body : body;
}).join('\n'), context);
const pathList = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(pathList);
context.E2EE_CONTENT_PATHS = new Set([...pathList[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
context.codexDesktopRelayHandleE2ee = context.e2eeWrap((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    dispatches++;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ text: Buffer.concat(chunks).toString('utf8'), required: req.__dshRequireE2ee === true }));
  }); req.resume();
});
context.serveCodexPrivateFileE2ee = context.e2eeWrap(context.serveCodexPrivateFile, { responseEncryptedByHandler: true });
const server = http.createServer((req, res) => {
  try { context.handleRequestInner(req, res, 0); }
  catch (_error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Fixture route failed'); }
});
context.proxyCodexWs = (req, socket) => {
  wsDispatches++; checkedWsKey = req.__dshWsE2eeSecret || null;
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
};
server.on('upgrade', (req, socket, head) => context.handleUpgrade(req, socket, head));
function configure({ value = SECRET, error = null, after = Infinity, disabled = false } = {}) {
  storedSecret = value; readError = error; unavailableAfter = after; keyReads = 0;
  if (disabled) keyEnv.DSH_GW_NO_E2EE = '1'; else delete keyEnv.DSH_GW_NO_E2EE;
}
async function request({ pathname = '/codex/desktop-relay', method = 'POST', body = BODY,
  encrypted = true, headers = {} } = {}) {
  const bytes = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const wire = encrypted && bytes.length ? e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, bytes) : bytes;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      headers: { host: 'fixture.trycloudflare.com', cookie: `fixture-login=${LOGIN}; fixture-device=valid-device`,
        accept: 'application/json', 'content-length': wire.length, 'x-dsh-desktop-relay': '1',
        ...(encrypted ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', 'content-type': 'application/octet-stream' }
          : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('Fixture request timed out'))); req.end(wire);
  });
}
function unavailable(result) {
  assert.equal(result.status, 503);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(result.body.toString('utf8'), FAILURE);
  assert.ok(!result.body.includes(Buffer.from(PRIVATE_TEXT)) && !result.body.includes(FILE_BYTES));
}
async function upgrade(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname,
      headers: { host: 'fixture.trycloudflare.com', cookie: `fixture-login=${LOGIN}; fixture-device=valid-device`,
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'), ...headers } });
    req.on('response', res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('upgrade', (res, socket, head) => {
      socket.end(); resolve({ status: res.statusCode, headers: res.headers, body: head });
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('Fixture upgrade timed out'))); req.end();
  });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Retained proof and valid login/device cookies must not bypass key loss.
    for (const failure of [{ error: 'ENOENT' }, { value: 'too-short' }, { error: 'EACCES' }, { disabled: true }]) {
      configure(failure);
      for (const pathname of context.E2EE_CONTENT_PATHS) {
        for (const options of [{ encrypted: false }, { encrypted: true }, { method: 'GET', body: null, encrypted: true }])
          unavailable(await request({ pathname, ...options }));
        checks++;
      }
    }
    assert.equal(dispatches, 0); assert.equal(fileReads, 0); assert.equal(plaintextStreams, 0);
    for (const failure of [{ error: 'ENOENT' }, { value: 'too-short' }, { error: 'EACCES' }, { disabled: true }]) {
      configure(failure);
      for (const pathname of ['/codex/ws', '/events']) {
        unavailable(await upgrade(pathname)); unavailable(await upgrade(pathname + '?e2ee=1')); checks++;
      }
    }
    assert.equal(wsDispatches, 0);
    configure({ error: 'ENOENT' });
    unavailable(await request({ encrypted: false,
      headers: { host: 'localhost:8080', 'x-forwarded-host': 'fixture.trycloudflare.com' } })); checks++;
    // The key can become unreadable between the entry gate and wrapper.
    configure({ after: 1 });
    unavailable(await request()); assert.equal(dispatches, 0); checks++;
    // File stat/read is asynchronous; losing the key must not select plaintext.
    configure({ after: 2 });
    unavailable(await request({ pathname: '/codex/file', body: { path: FILE_PATH } }));
    assert.equal(plaintextStreams, 0); checks++;

    // Restoring the key restores exact request/response encryption.
    configure();
    let result = await request();
    assert.equal(result.status, 200); assert.equal(result.headers['x-dsh-e2ee'], '1');
    const opened = e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, result.body);
    assert.equal(JSON.parse(opened.toString('utf8')).text, JSON.stringify(BODY));
    assert.equal(JSON.parse(opened.toString('utf8')).required, true); checks++;
    result = await request({ pathname: '/codex/file', body: { path: FILE_PATH } });
    assert.equal(result.status, 200); assert.equal(result.headers['x-dsh-e2ee'], '1');
    assert.deepEqual(e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, result.body), FILE_BYTES);
    assert.ok(!result.body.includes(FILE_BYTES)); checks++;
    configure({ after: 1 });
    result = await upgrade('/codex/ws?e2ee=1');
    assert.equal(result.status, 101); assert.equal(checkedWsKey, SECRET); checks++;
    configure();
    result = await upgrade('/codex/ws'); assert.equal(result.status, 403); checks++;

    // Existing direct-computer behavior and the public empty probe remain usable.
    configure({ error: 'ENOENT' });
    result = await request({ encrypted: false, headers: { host: 'localhost:8080' } });
    assert.equal(result.status, 200); assert.equal(result.headers['x-dsh-e2ee'], undefined);
    assert.equal(JSON.parse(result.body.toString('utf8')).text, JSON.stringify(BODY)); checks++;
    result = await request({ pathname: '/codex/file?path=' + encodeURIComponent(FILE_PATH),
      method: 'GET', body: null, encrypted: false, headers: { host: 'localhost:8080' } });
    assert.equal(result.status, 200); assert.deepEqual(result.body, FILE_BYTES); checks++;
    result = await request({ pathname: '/__probe', method: 'GET', body: null, encrypted: false });
    assert.equal(result.status, 204); assert.equal(result.body.length, 0); checks++;
    result = await upgrade('/codex/ws', { host: 'localhost:8080' });
    assert.equal(result.status, 101); assert.equal(checkedWsKey, null); checks++;
    console.log(checks + ' missing-key HTTP/upgrade checks passed across ' + context.E2EE_CONTENT_PATHS.size +
      ' protected routes and DSH/Codex upgrades: missing/short/unreadable/disabled keys, mid-request loss, recovery and local compatibility.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
