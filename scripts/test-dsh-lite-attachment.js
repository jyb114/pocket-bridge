'use strict';
require('./replay-isolated-fixture.js').install();

// Exact production entry/AES/attachment handler with a synthetic Session-aware
// official transport. No installed DSH, user store, native UI or model writes.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source');
const e2ee = require('./e2ee');
const origin = require('./request-origin');
const { createDshLiteAttachment, MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES } = require('./dsh-lite-attachment');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const png = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'icon-192.png'));
const digest = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const id = digest(png);
const SECRET = 'isolated-attachment-encryption-secret-0123456789', LOGIN = 'isolated-login';
const runtime = { profile: 'remote-mux', port: 19003, pid: 1234, kind: 'desktop' };
let currentRuntime = runtime, proved = true, revision = 1, fault = null, calls = 0, checks = 0;
const success = () => ({ attachment: { attachmentId: id, mediaType: 'image/png',
  bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), name: 'Synthetic public icon.png' }, data: png.toString('base64') });
const box = vm.createContext({ Buffer, URL, Readable, crypto, path, e2ee, setTimeout,
  privateHttpsAdmission: require('./private-https-admission.js'), cfg: { loadConfig: () => ({ privateHttps: { enabled: false, origin: '' } }) },
  retiredTargets: require('./retired-targets'), MAX_E2EE_BODY: 64 * 1024 * 1024,
  e2eeBridge: { readSecret: () => SECRET }, isLocalRequest: origin.isLoopback, viaRelay: origin.viaRelay,
  isSelfCheck: () => false, isSelfClientRequest: () => false, COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN,
  GATEWAY_AUTH_COOKIE: 'fixture-login', DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device', ACCESS_KEY: 'fixture-access',
  routes: { clientIpOf: req => req.socket.remoteAddress }, sessions: { verify: token => token === 'valid-device' ?
    { ok: true, device: { id: 'synthetic', label: 'Fixture' } } : { ok: false, reason: 'revoked' } },
  authProvenAt: () => proved, authObserved: new Set(), proofWaitHits: new Map(), proofBootWindowOpen: () => false, proofLooksInProgress: () => false,
  PROOF_WAIT_FULL_MS: 100, PROOF_WAIT_MS: 100, PROOF_WAIT_MAX_PER_DEVICE: 1, PWA_ROUTES: {}, dshLazyImageStore: { imageDigestFromPath: () => null },
  E2EE_CONTENT_PATHS: new Set(['/__dsh/lite-attachment']), handleConsole: () => false, isBootstrapRequest: () => false,
  pageLanguage: () => 'en', pageText: () => ({ errors: { noKey: 'Authentication required: ' } }), deviceErrorPage: () => 'Device authentication failed.',
  pickLang: () => 'en', PLAINTEXT_REFUSED: { en: { head: 'Encrypted request required', body: '', how: '' } }, log() {}
});
const names = ['readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie', 'keyMatches',
  'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof', 'e2eeSecretOrNull',
  'refuseEncryptionUnavailable', 'refusePlaintext', 'clientWantsE2ee', 'wrapEncryptedResponse', 'e2eeWrap', 'handleRequest', 'handleRequestInner'];
vm.runInContext(names.map(name => {
  if (name === 'ensureDevice') { const at = source.indexOf('function ensureDevice('), open = source.indexOf(') {', at) + 2;
    return source.slice(at, open) + extractFunction('function body() ' + source.slice(open), 'body').replace('function body() ', ''); }
  const code = extractFunction(source, name); assert(code, name); return code;
}).join('\n'), box);
const handler = createDshLiteAttachment({ resolveRuntime: async () => currentRuntime,
  callUpstream: async call => {
    calls++;
    assert.equal(call.path, '/api/session/attachment'); assert.equal(call.method, 'POST');
    assert.equal(call.maxResponseBytes, MAX_RESPONSE_BYTES); assert.equal(call.verifiedRuntime, runtime);
    assert.equal(call.headers['accept-encoding'], 'identity'); assert.equal(call.headers['content-length'], String(call.body.length));
    const wire = JSON.parse(call.body);
    assert.equal(wire.type, 'client-request'); assert.equal(wire.method, 'session/attachment');
    assert.deepEqual(Object.keys(wire.payload.args), ['request']);
    assert.deepEqual(Object.keys(wire.payload.args.request).sort(), ['attachmentId', 'sessionId']);
    assert.equal(call.signal instanceof AbortSignal, true);
    if (fault === 'throw') throw Error('private upstream detail should never reach the phone');
    if (fault === 'overflow-error') throw Error('dsh-response-too-large');
    if (fault === 'raw') return { statusCode: 200, body: '<html>private upstream raw page</html>' };
    if (fault === 'status') return { statusCode: 302, body: JSON.stringify({ location: 'private upstream URL' }) };
    if (fault === 'envelope-large') return { statusCode: 200, body: Buffer.alloc(MAX_RESPONSE_BYTES + 1) };
    const request = wire.payload.args.request;
    let result = request.sessionId !== 'session-a' || request.attachmentId !== id || revision !== 1 ?
      { ok: false, error: { code: 'session/attachment-invalid', message: 'private attachment path', details: { reason: 'ATTACHMENT_NOT_REFERENCED', secret: 'private-field' } } } :
      { ok: true, value: success() };
    if (fault === 'not-found') result = { ok: false, error: { code: 'session/not-found', message: 'private Session ID' } };
    if (fault === 'unknown-method') result = { ok: false, error: { code: 'gateway/method-not-found', message: 'private method detail' } };
    if (fault === 'unknown-domain') result = { ok: false, error: { code: 'custom/private-code', message: 'private secret error', data: { path: 'private' } } };
    if (result.ok) {
      const value = result.value, ref = value.attachment;
      if (fault === 'id') ref.attachmentId = 'sha256:' + '0'.repeat(64);
      if (fault === 'bytes') ref.bytes++;
      if (fault === 'base64') value.data += '\n';
      if (fault === 'digest') value.data = Buffer.alloc(png.length, 65).toString('base64');
      if (fault === 'svg') ref.mediaType = 'image/svg+xml';
      if (fault === 'mime') ref.mediaType = 'image/jpeg';
      if (fault === 'dimensions') ref.width++;
      if (fault === 'null') result.value = null;
      if (fault === 'extra') ref.path = 'private attachment store path';
      if (fault === 'name') ref.name = 'private\u0000name';
      if (fault === 'pixels') { ref.width = 8192; ref.height = 8192; }
      if (fault === 'oversize') ref.bytes = MAX_IMAGE_BYTES + 1;
    }
    return { statusCode: 200, body: JSON.stringify({ type: 'client-response', rpcId: fault === 'rpc' ? 'wrong-response' : wire.rpcId, result }) };
  } });
box.serveDshLiteAttachmentE2ee = box.e2eeWrap(handler);
const server = http.createServer((req, res) => { try { box.handleRequest(req, res); } catch (error) { res.writeHead(500); res.end('Isolated entry failed.'); console.error(error); } });
async function send(input = { sessionId: 'session-a', attachmentId: id }, options = {}) {
  const body = Buffer.from(options.raw === undefined ? JSON.stringify(input) : options.raw);
  const wire = options.plain ? body : e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: options.url || '/__dsh/lite-attachment', method: options.method || 'POST', headers: {
      host: 'public.fixture.invalid', cookie: `fixture-login=${LOGIN}; fixture-device=valid-device`,
      'content-type': 'application/octet-stream', 'content-length': wire.length, 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks); let opened = raw;
        if (res.headers['x-dsh-e2ee'] === '1') {
          opened = e2ee.candidateKeys(SECRET).map(keys => e2ee.decrypt(keys.b, raw)).find(Boolean);
          assert(opened, 'Response is authentic AES ciphertext'); assert(!raw.includes(png));
          assert.equal(res.headers['cache-control'], 'no-store');
        }
        let value; try { value = JSON.parse(opened.toString()); } catch (_) { value = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, opened, value });
      }); res.on('error', reject);
    }); req.on('error', reject); req.setTimeout(4000, () => req.destroy(Error('Isolated attachment timed out'))); req.end(wire);
  });
}
async function check(name, test) { await test(); checks++; console.log('PASS ' + name); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await check('actual authenticated gateway/AES returns exact authorized public PNG', async () => {
      const before = calls, response = await send(); assert.equal(response.status, 200); assert.equal(calls, before + 1);
      assert.equal(response.headers['content-type'], 'application/octet-stream');
      assert.equal(response.headers['x-dsh-e2ee-type'], 'image/png'); assert.equal(response.headers['x-dsh-e2ee'], '1');
      assert.deepEqual(response.opened, png); assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.raw.includes(Buffer.from(id)), false); assert.equal(response.raw.includes(Buffer.from('session-a')), false);
    });
    await check('cross-session and unreferenced IDs are official-denied and never cached', async () => {
      const before = calls;
      assert.equal((await send({ sessionId: 'session-b', attachmentId: id })).status, 404);
      assert.equal((await send({ sessionId: 'session-a', attachmentId: 'sha256:' + '0'.repeat(64) })).status, 404);
      revision = 2; assert.equal((await send()).status, 404); revision = 1;
      assert.equal((await send()).status, 200); assert.equal(calls, before + 4);
    });
    await check('strict encrypted metadata refuses paths, URLs, receipt IDs, extra fields and controls before dispatch', async () => {
      const before = calls;
      for (const request of [null, [], {}, { sessionId: '', attachmentId: id }, { sessionId: 'a\u0000b', attachmentId: id },
        { sessionId: 'a'.repeat(513), attachmentId: id }, { sessionId: 'session-a', attachmentId: 'receipt-id' },
        { sessionId: 'session-a', attachmentId: 'https://foreign.example/private' }, { sessionId: 'session-a', attachmentId: '../private' },
        { sessionId: 'session-a', attachmentId: id, path: 'private' }, { sessionId: 'session-a', attachmentId: id.toUpperCase() }])
        assert.equal((await send(request)).status, 400);
      assert.equal((await send(undefined, { raw: '{malformed' })).status, 400);
      assert.equal((await send(undefined, { raw: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
      assert.equal((await send(undefined, { url: '/__dsh/lite-attachment?attachmentId=private' })).status, 400);
      assert.equal(calls, before);
    });
    await check('legacy and unavailable runtimes return explicit unsupported without any upstream call', async () => {
      const before = calls; currentRuntime = { ...runtime, profile: 'legacy-events' };
      assert.equal((await send()).status, 501); currentRuntime = null; assert.equal((await send()).status, 503);
      currentRuntime = runtime; assert.equal(calls, before);
    });
    await check('wrong IDs, SHA, byte counts, MIME, dimensions and metadata are rejected without raw details', async () => {
      for (const scenario of ['id', 'bytes', 'base64', 'digest', 'svg', 'mime', 'dimensions', 'null', 'extra', 'name', 'pixels', 'rpc', 'raw', 'status', 'throw', 'unknown-domain']) {
        fault = scenario; const before = calls, response = await send();
        assert.equal(response.status, 502, scenario); assert.equal(calls, before + 1, 'No retry for ' + scenario);
        assert.doesNotMatch(response.opened.toString(), /private|secret|path|location/);
      }
      fault = null;
    });
    await check('both declared and transport oversize remain bounded with actionable fixed errors', async () => {
      for (const scenario of ['oversize', 'envelope-large', 'overflow-error']) {
        fault = scenario; const response = await send(); assert.equal(response.status, 413); assert.equal(response.value.error, 'image-too-large');
      } fault = null;
    });
    await check('official not-found/not-referenced/unsupported errors expose only bounded fixed categories', async () => {
      for (const scenario of ['not-found', 'unknown-method']) {
        fault = scenario; const response = await send(); assert.equal(response.status, scenario === 'not-found' ? 404 : 501);
        assert.doesNotMatch(response.opened.toString(), /private|secret|details/);
      } fault = null;
    });
    await check('login/device/proof, authenticated decryption and MIME remain mandatory', async () => {
      const before = calls;
      assert.equal((await send(undefined, { headers: { cookie: '' } })).status, 403);
      assert.equal((await send(undefined, { headers: { cookie: `fixture-login=${LOGIN}; fixture-device=revoked` } })).status, 403);
      proved = false; const response = await send(); proved = true; assert.equal(response.status, 403); assert.equal(response.headers['x-dsh-need-proof'], '1');
      assert.equal((await send(undefined, { headers: { 'x-dsh-e2ee': '0' } })).status, 403);
      assert.equal((await send(undefined, { plain: true })).status, 400);
      assert.equal((await send(undefined, { headers: { 'x-dsh-e2ee-type': 'text/plain' } })).status, 415);
      assert.equal(calls, before);
    });
    await check('GET, foreign plaintext and preflight have no read or CORS bypass', async () => {
      const before = calls;
      assert.equal((await send(undefined, { method: 'GET', plain: true, raw: '' })).status, 405);
      const foreign = { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site', 'x-dsh-e2ee': '0' };
      const response = await send(undefined, { plain: true, headers: foreign }); assert.equal(response.status, 403);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      const preflight = await send(undefined, { method: 'OPTIONS', raw: '', plain: true, headers: foreign });
      assert.equal(preflight.status, 403); assert.equal(preflight.headers['access-control-allow-origin'], undefined); assert.equal(calls, before);
    });
    await check('closing an owned response cancels only its pending image read and releases the handler', async () => {
      let signal, started, writes = 0, dispatched = 0;
      const ready = new Promise(resolve => { started = resolve; });
      const pending = createDshLiteAttachment({ resolveRuntime: async () => runtime,
        callUpstream: call => new Promise((resolve, reject) => {
          dispatched++; signal = call.signal; started();
          signal.addEventListener('abort', () => reject(Error('owned read cancelled')), { once: true });
        }) });
      const body = Buffer.from(JSON.stringify({ sessionId: 'session-a', attachmentId: id }));
      const req = Readable.from([body]); req.method = 'POST'; req.url = '/__dsh/lite-attachment';
      req.headers = { 'content-type': 'application/json', 'content-length': body.length, 'x-dsh-e2ee': '1' }; req.__dshE2eeDecrypted = true;
      const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false;
      res.writeHead = res.end = () => { writes++; };
      const work = pending(req, res); await ready;
      res.destroyed = true; res.emit('close');
      await work; assert.equal(signal.aborted, true); assert.equal(dispatched, 1); assert.equal(writes, 0);
      assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
    });
    console.log(checks + ' encrypted durable-image groups passed; no production/native/model/filesystem attachment actions.');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
