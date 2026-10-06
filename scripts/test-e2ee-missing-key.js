'use strict';

// Production gateway gates/wrappers and DSH Lite handlers over owned HTTP/WS,
// synthetic authentication, key storage, upstream results and workspace bytes.
// No production key, desktop, model, process or filesystem content is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source.js');
const e2ee = require('./e2ee.js');
const origin = require('./request-origin.js');
const wsBridge = require('./ws-e2ee-bridge.js');

const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const secretSource = fs.readFileSync(path.join(__dirname, 'ws-e2ee-bridge.js'), 'utf8');
const SECRET = 'isolated-missing-key-secret-0123456789';
const LOGIN = 'isolated-login-cookie';
const PRIVATE_TEXT = 'Private synthetic DSH conversation content';
const SESSION = 'isolated-dsh-session';
const BODY = { method: 'session/projections', request: { sessionId: SESSION } };
const FILE_ROOT = 'D:\\isolated-project', FILE_PATH = FILE_ROOT + '\\result.txt';
const FILE_BYTES = Buffer.from('Private synthetic file bytes');
const FAILURE = JSON.stringify({ ok: false, code: 'encryption-unavailable',
  message: 'Encrypted content is temporarily unavailable. Check the computer gateway and retry.' });
let storedSecret = SECRET, readError = null, keyReads = 0, unavailableAfter = Infinity;
let fileReads = 0, dispatches = 0, wsDispatches = 0, checkedWsKey = null, checks = 0;
let loseKeyDuringFileRead = false;
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
  Buffer, URL, Readable, e2ee, path, crypto, net, setTimeout, setImmediate, process: { env: {} },
  MAX_E2EE_BODY: 64 * 1024 * 1024, retiredTargets: require('./retired-targets.js'),
  dshPhoneSurface: require('./dsh-phone-surface.js'),
  COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN, GATEWAY_AUTH_COOKIE: 'fixture-login',
  ACCESS_KEY: 'fixture-access-key', DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device',
  e2eeBridge: { readSecret: keyContext.readSecret, wanted: keyContext.wanted,
    attach(secret) { checkedWsKey = secret; return wsBridge.attach(secret); } },
  viaRelay: origin.viaRelay, isLocalRequest: origin.isLoopback,
  isSelfCheck: () => false, isSelfClientRequest: () => false,
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
  buildUpstreamHeaders: req => req.headers, markActivity() {}
};
const names = ['readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie',
  'keyMatches', 'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof',
  'e2eeSecretOrNull', 'refuseEncryptionUnavailable', 'refuseEncryptionUnavailableUpgrade', 'refusePlaintext', 'clientWantsE2ee',
  'wrapEncryptedResponse', 'e2eeWrap', 'handleRequest', 'handleRequestInner', 'handleUpgrade'];
vm.createContext(context);
vm.runInContext(names.map(name => {
  if (name === 'ensureDevice') {
    const start = source.indexOf('function ensureDevice('), brace = source.indexOf(') {', start) + 2;
    return source.slice(start, brace) + extractFunction('function isolatedBody() ' + source.slice(brace), 'isolatedBody')
      .replace('function isolatedBody() ', '');
  }
  const body = extractFunction(source, name); assert.ok(body, name); return body;
}).join('\n'), context);
const pathList = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(pathList);
context.E2EE_CONTENT_PATHS = new Set([...pathList[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
assert.ok(['/__dsh/lite-rpc', '/__dsh/lite-files', '/__dsh/lite-upload', '/__dsh/lite-download']
  .every(value => context.E2EE_CONTENT_PATHS.has(value)));

const io = {
  statSync(file) { return { isFile: () => file !== FILE_ROOT, isDirectory: () => file === FILE_ROOT,
    size: file === FILE_PATH ? FILE_BYTES.length : 512 }; },
  realpathSync(value) { return value; },
  readFileSync(file) {
    if (file === FILE_PATH) {
      fileReads++; if (loseKeyDuringFileRead) readError = 'ENOENT'; return FILE_BYTES;
    }
    assert.equal(file, 'D:\\isolated-home\\storages\\workspace.json');
    return JSON.stringify({ tables: { workspaces: { fixture: { path: FILE_ROOT, sessionIds: [SESSION] } } } });
  },
  opendirSync(directory) {
    assert.equal(directory, FILE_ROOT); let read = false;
    return { readSync() { if (read) return null; read = true; return { name: 'result.txt' }; }, closeSync() {} };
  }
};
const fileOptions = { fs: io, path: path.win32, homes: ['D:\\isolated-home'] };
const callUpstream = async call => {
  dispatches++;
  if (call.path === '/api/session/projections') {
    const wire = JSON.parse(call.body.toString('utf8'));
    assert.equal(wire.method, BODY.method); assert.deepEqual(wire.payload.args, { request: BODY.request });
    return { statusCode: 200, body: JSON.stringify({ rpcId: wire.rpcId,
      result: { ok: true, value: { content: PRIVATE_TEXT } } }) };
  }
  assert.equal(call.path, '/api/session/uploadFileBinary?sessionId=' + SESSION + '&name=result.txt');
  assert.deepEqual(call.body, FILE_BYTES);
  return { statusCode: 200, body: JSON.stringify({ ok: true, value: { receiptId: 'fixture-receipt',
    file: { attachmentId: 'fixture-attachment', name: 'result.txt', bytes: FILE_BYTES.length } } }) };
};
context.serveDshLiteRpcE2ee = context.e2eeWrap(require('./dsh-lite-rpc.js').createDshLiteRpc({ callUpstream }));
context.serveDshLiteUploadE2ee = context.e2eeWrap(require('./dsh-lite-upload.js').createDshLiteUpload({ callUpstream }));
context.serveDshLiteDownloadE2ee = context.e2eeWrap(require('./dsh-lite-download.js').createDshLiteDownload(fileOptions));
context.serveDshLiteFilesE2ee = context.e2eeWrap(require('./dsh-lite-files.js').createDshLiteFiles(fileOptions));
const server = http.createServer((req, res) => {
  try { context.handleRequest(req, res); }
  catch (_error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Fixture route failed'); }
});
server.on('upgrade', (req, socket, head) => context.handleUpgrade(req, socket, head));
const upstream = http.createServer();
upstream.on('upgrade', (req, socket) => {
  wsDispatches++;
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] +
    '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
});
function configure({ value = SECRET, error = null, after = Infinity, disabled = false } = {}) {
  storedSecret = value; readError = error; unavailableAfter = after; keyReads = 0; loseKeyDuringFileRead = false;
  checkedWsKey = null;
  if (disabled) keyEnv.DSH_GW_NO_E2EE = '1'; else delete keyEnv.DSH_GW_NO_E2EE;
}
function uploadPacket() {
  const meta = Buffer.from(JSON.stringify({ sessionId: SESSION, name: 'result.txt' }));
  const count = Buffer.alloc(4); count.writeUInt32BE(meta.length);
  return Buffer.concat([count, meta, FILE_BYTES]);
}
async function request({ pathname = '/__dsh/lite-rpc', method = 'POST', body = BODY,
  encrypted = true, headers = {}, type = 'application/json' } = {}) {
  const bytes = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const wire = encrypted && bytes.length ? e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, bytes) : bytes;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      headers: { host: 'fixture.trycloudflare.com', cookie: `fixture-login=${LOGIN}; fixture-device=valid-device`,
        accept: 'application/json', 'content-length': wire.length,
        ...(encrypted ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': type, 'content-type': 'application/octet-stream' }
          : { 'content-type': type }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('Fixture request timed out'))); req.end(wire);
  });
}
function unavailable(result) {
  assert.equal(result.status, 503); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(result.body.toString('utf8'), FAILURE);
  assert.ok(!result.body.includes(Buffer.from(PRIVATE_TEXT)) && !result.body.includes(FILE_BYTES));
}
function opened(result) {
  assert.equal(result.status, 200); assert.equal(result.headers['x-dsh-e2ee'], '1');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.ok(!result.body.includes(Buffer.from(PRIVATE_TEXT)) && !result.body.includes(FILE_BYTES));
  return e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, result.body);
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
    req.on('upgrade', (res, socket, head) => { socket.end(); resolve({ status: res.statusCode, headers: res.headers, body: head }); });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('Fixture upgrade timed out'))); req.end();
  });
}
(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  context.EXPLICIT_TARGET_PORT = context.TARGET_PORT = upstream.address().port; context.TARGET_HOST = '127.0.0.1';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Retained proof and valid cookies cannot bypass missing key material.
    for (const failure of [{ error: 'ENOENT' }, { value: 'too-short' }, { error: 'EACCES' }, { disabled: true }]) {
      configure(failure);
      for (const pathname of context.E2EE_CONTENT_PATHS) {
        for (const options of [{ encrypted: false }, { encrypted: true }, { method: 'GET', body: null, encrypted: true }])
          unavailable(await request({ pathname, ...options }));
        checks++;
      }
      for (const pathname of ['/api/remote.mux', '/events']) {
        unavailable(await upgrade(pathname)); unavailable(await upgrade(pathname + '?e2ee=1')); checks++;
      }
    }
    assert.equal(dispatches, 0); assert.equal(fileReads, 0); assert.equal(wsDispatches, 0);
    configure({ error: 'ENOENT' });
    unavailable(await request({ encrypted: false, headers: { host: 'localhost:8080',
      'x-forwarded-host': 'fixture.trycloudflare.com' } })); checks++;
    for (const pathname of ['/__dsh/lite-rpc', '/__dsh/lite-files', '/__dsh/lite-upload', '/__dsh/lite-download']) {
      configure({ after: 1 }); unavailable(await request({ pathname })); checks++;
    }
    assert.equal(dispatches, 0); assert.equal(fileReads, 0);

    // Encryption is not authentication or proof. None of the independent
    // refusal paths may reach a handler, read workspace bytes or open a WS.
    configure();
    const refusedBefore = { dispatches, fileReads, wsDispatches };
    for (const pathname of ['/__dsh/lite-rpc', '/__dsh/lite-files', '/__dsh/lite-upload', '/__dsh/lite-download']) {
      let denied = await request({ pathname, encrypted: false });
      assert.equal(denied.status, 403); checks++;
      denied = await request({ pathname, headers: { cookie: '' } });
      assert.equal(denied.status, 403); assert.equal(denied.headers['x-dsh-auth-required'], '1'); checks++;
      denied = await request({ pathname, headers: { cookie: `fixture-login=${LOGIN}; fixture-device=revoked` } });
      assert.equal(denied.status, 403); checks++;
      context.authProvenAt = () => false;
      denied = await request({ pathname });
      assert.equal(denied.status, 403); assert.equal(denied.headers['x-dsh-need-proof'], '1'); checks++;
      context.authProvenAt = id => id === 'fixture-proven';
      denied = await request({ pathname, encrypted: false,
        headers: { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json' } });
      assert.equal(denied.status, 400); checks++;
    }
    for (const headers of [{ cookie: '' }, { cookie: `fixture-login=${LOGIN}; fixture-device=revoked` }]) {
      assert.equal((await upgrade('/api/remote.mux?e2ee=1', headers)).status, 403); checks++;
    }
    context.authProvenAt = () => false;
    const noProofWs = await upgrade('/api/remote.mux?e2ee=1');
    assert.equal(noProofWs.status, 403); assert.equal(noProofWs.headers['x-dsh-need-proof'], '1'); checks++;
    context.authProvenAt = id => id === 'fixture-proven';
    assert.deepEqual({ dispatches, fileReads, wsDispatches }, refusedBefore);

    configure(); let result = await request();
    assert.equal(JSON.parse(opened(result)).result.value.content, PRIVATE_TEXT); checks++;
    result = await request({ pathname: '/__dsh/lite-files', body: { sessionId: SESSION, path: '', offset: 0 } });
    assert.deepEqual(JSON.parse(opened(result)).entries, [{ name: 'result.txt', path: 'result.txt', type: 'file', bytes: FILE_BYTES.length }]); checks++;
    result = await request({ pathname: '/__dsh/lite-upload', body: uploadPacket(), type: 'application/octet-stream' });
    assert.equal(JSON.parse(opened(result)).ok, true); checks++;
    result = await request({ pathname: '/__dsh/lite-download', body: { sessionId: SESSION, path: FILE_PATH } });
    assert.deepEqual(opened(result), FILE_BYTES); checks++;
    // Once the wrapper has pinned a usable key, reads must retain encryption,
    // never reselect plaintext after key storage disappears.
    configure(); loseKeyDuringFileRead = true;
    result = await request({ pathname: '/__dsh/lite-download', body: { sessionId: SESSION, path: FILE_PATH } });
    assert.equal(readError, 'ENOENT'); assert.deepEqual(opened(result), FILE_BYTES); checks++;
    configure({ after: 1 }); result = await upgrade('/api/remote.mux?e2ee=1');
    assert.equal(result.status, 101); assert.equal(checkedWsKey, SECRET); checks++;
    configure(); result = await upgrade('/api/remote.mux'); assert.equal(result.status, 403); checks++;
    result = await upgrade('/events?e2ee=1'); assert.equal(result.status, 410); checks++;

    // Local Lite handlers still require the decrypted in-process marker.
    // Their contract does not become a plaintext LAN file API.
    configure({ error: 'ENOENT' });
    for (const pathname of ['/__dsh/lite-rpc', '/__dsh/lite-files', '/__dsh/lite-upload', '/__dsh/lite-download']) {
      result = await request({ pathname, encrypted: false, headers: { host: 'localhost:8080' } });
      assert.equal(result.status, 403); assert.equal(result.headers['x-dsh-e2ee'], undefined);
      assert.equal(JSON.parse(result.body).error, 'encrypted-request-required'); checks++;
    }
    result = await request({ pathname: '/__probe', method: 'GET', body: null, encrypted: false });
    assert.equal(result.status, 204); assert.equal(result.body.length, 0); checks++;
    result = await upgrade('/api/remote.mux', { host: 'localhost:8080' });
    assert.equal(result.status, 101); assert.equal(checkedWsKey, null); checks++;
    // Retired routes remain harmless with missing keys and valid cookies.
    const before = { dispatches, fileReads, wsDispatches };
    for (const pathname of ['/codex/desktop-relay', '/codex/file', '/dot/send']) {
      result = await request({ pathname }); assert.equal(result.status, 410); checks++;
    }
    result = await upgrade('/codex/ws?e2ee=1'); assert.equal(result.status, 410); checks++;
    assert.deepEqual({ dispatches, fileReads, wsDispatches }, before);
    console.log(checks + ' missing-key DSH HTTP/upgrade checks passed across ' + context.E2EE_CONTENT_PATHS.size +
      ' protected routes: key loss/refusal, real Lite handlers, pinned recovery, local boundaries and retired410.');
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
