'use strict';
// Real gateway authentication, device proof, AES and Dot service over isolated
// HTTP. Native history is synthetic; this test never operates the desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const vm = require('node:vm'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source.js');
const e2ee = require('./e2ee.js'), requestOrigin = require('./request-origin.js');
const { createDotDesktopService } = require('./dot-desktop-service.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const SECRET = 'isolated-dot-gateway-key-0123456789';
const LOGIN = 'isolated-dot-login';
const THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b45';
const PRIVATE = 'Synthetic private Dot conversation 中文';
let nativeReads = 0, checks = 0;
const context = {
  Buffer, URL, Readable, e2ee, crypto, setTimeout, MAX_E2EE_BODY: 64 * 1024 * 1024,
  COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN, GATEWAY_AUTH_COOKIE: 'fixture-login', ACCESS_KEY: 'fixture-access',
  DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device',
  e2eeSecretOrNull: () => SECRET, viaRelay: requestOrigin.viaRelay, isLocalRequest: requestOrigin.isLoopback,
  isSelfCheck: () => false, isSelfClientRequest: () => false, routes: { clientIpOf: req => req.socket.remoteAddress },
  sessions: { verify(token) { return token === 'valid-device' ? { ok: true, device: { id: 'proven', label: 'Fixture' } } :
    token === 'unproven-device' ? { ok: true, device: { id: 'unproven', label: 'Fixture' } } : { ok: false, reason: 'revoked' }; } },
  authProvenAt: id => id === 'proven', authObserved: new Set(), proofBootWindowOpen: () => false, proofLooksInProgress: () => false,
  proofWaitHits: new Map(), PROOF_WAIT_FULL_MS: 100, PROOF_WAIT_MS: 100, PROOF_WAIT_MAX_PER_DEVICE: 1,
  PWA_ROUTES: {}, dshLazyImageStore: { imageDigestFromPath: () => null },
  handleConsole: () => false, isBootstrapRequest: () => false, log() {}, pageLanguage: () => 'en',
  pageText: () => ({ errors: { noKey: 'Authentication required: ' } }), deviceErrorPage: () => 'Device rejected', pickLang: () => 'en',
  PLAINTEXT_REFUSED: { en: { head: 'Encrypted request required', body: '', how: '' } }
};
vm.createContext(context);
const names = ['readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie', 'keyMatches',
  'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof', 'refusePlaintext',
  'clientWantsE2ee', 'wrapEncryptedResponse', 'e2eeWrap', 'handleRequestInner'];
vm.runInContext(names.map(name => {
  if (name !== 'ensureDevice') return extractFunction(source, name);
  const start = source.indexOf('function ensureDevice('), brace = source.indexOf(') {', start) + 2;
  return source.slice(start, brace) + extractFunction('function isolatedBody() ' + source.slice(brace), 'isolatedBody').replace('function isolatedBody() ', '');
}).join('\n'), context);
const paths = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
context.E2EE_CONTENT_PATHS = new Set([...paths[1].matchAll(/'([^']+)'/g)].map(value => value[1]));
assert(context.E2EE_CONTENT_PATHS.has('/dot/desktop'));
assert.match(source, /const dotDesktopHandleE2ee = e2eeWrap\(dotDesktop\.handle\.bind\(dotDesktop\)\)/);
const service = createDotDesktopService({ driver: {
  async inspect() { return { available: true, desktopRunning: true, version: '26.928.3736' }; },
  async snapshot({ threadId }) {
    nativeReads++; assert(!threadId || threadId === THREAD);
    return { hostId: 'durable', threadId: THREAD, observedAt: Date.now(), historyScope: 'materialized-recent', materializedRowCount: 1,
      messages: [{ observationId: 'a'.repeat(64), role: 'assistant', text: PRIVATE, hasText: true }] };
  }
} });
context.dotDesktopHandleE2ee = context.e2eeWrap(service.handle);
function check(name, condition) { assert(condition, name); checks++; console.log('PASS ' + name); }
const server = http.createServer((req, res) => {
  try { context.handleRequestInner(req, res, 0); }
  catch (error) { res.writeHead(500); res.end(error.stack); }
});
async function request({ body = { action: 'connect' }, cookie = `fixture-login=${LOGIN}; fixture-device=valid-device`, encrypted = true,
  headers = {}, method = 'POST', query = '' } = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const wire = encrypted ? e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, data) : data;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/dot/desktop' + query, method,
      headers: { host: 'fixture.trycloudflare.com', cookie, accept: 'application/json', 'x-dsh-dot': '1', 'content-length': wire.length,
        ...(encrypted ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks), wire }));
    }); req.on('error', reject); req.end(wire);
  });
}
function opened(value) { return JSON.parse(e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, value.data).toString('utf8')); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const cookie of ['', `fixture-login=forged; fixture-device=valid-device`, `fixture-login=${LOGIN}; fixture-device=revoked-device`,
      `fixture-login=${LOGIN}; fixture-device=unproven-device`]) {
      const value = await request({ cookie }); check('invalid login/device/proof refuses native Dot reads', value.status === 403 && nativeReads === 0);
    }
    let value = await request({ encrypted: false }); check('public Dot plaintext is refused', value.status === 403 && nativeReads === 0);
    value = await request({ encrypted: false, query: '?e2ee=1' }); check('query flag cannot authenticate plaintext', value.status === 400 && nativeReads === 0);
    value = await request({ headers: { 'x-dsh-dot': '0' } }); check('wrong page source cannot read Dot', value.status === 403 && opened(value).code === 'invalid-source' && nativeReads === 0);
    value = await request({ headers: { origin: 'https://other.trycloudflare.com' } }); check('cross-origin Dot action is refused', value.status === 403 && nativeReads === 0);
    value = await request({ method: 'GET' }); check('GET cannot trigger native Dot', value.status === 405 && nativeReads === 0);
    value = await request(); const snapshot = opened(value);
    check('actual route decrypts Connect and independently binds the durable Dot', value.status === 200 && nativeReads === 1 && snapshot.threadId === THREAD && snapshot.hostId === 'durable');
    check('recent Dot content is encrypted on the response wire', value.headers['x-dsh-e2ee'] === '1' && !value.data.includes(Buffer.from(PRIVATE)) && snapshot.messages[0].text === PRIVATE);
    check('read-only connection does not claim sending or local execution', snapshot.sendAvailable === false && snapshot.localComputerAccess === 'unverified' && snapshot.taskExecution === 'unknown');
    value = await request({ body: { action: 'snapshot', threadId: THREAD } }); check('refresh is bound to the previously verified durable ID', value.status === 200 && nativeReads === 2);
    value = await request({ body: { action: 'snapshot', threadId: '01a0f60e-881d-7ed0-8cfe-a5c356738b46' } }); check('different Dot cannot replace the bound conversation', value.status === 409 && nativeReads === 2);
    value = await request({ body: { action: 'send', text: 'Do not send this synthetic request' } }); check('unverified send never invokes the native driver', value.status === 409 && opened(value).submitted === false && nativeReads === 2);
    const damaged = e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, Buffer.from('{"action":"connect"}')); damaged[damaged.length - 1] ^= 1;
    value = await request({ body: damaged, encrypted: false, headers: { 'x-dsh-e2ee': '1', 'content-type': 'application/octet-stream' } });
    check('tampered Dot ciphertext never reaches native history', value.status === 400 && nativeReads === 2);
    console.log(checks + ' actual Dot gateway checks passed; native history is synthetic.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
