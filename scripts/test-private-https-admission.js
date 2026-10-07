'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source.js');
const admission = require('./private-https-admission.js');
const originPolicy = require('./request-origin.js');
const e2ee = require('./e2ee.js');
const replay = require('./replay-store.js');
const wsBridge = require('./ws-e2ee-bridge.js');
let checks = 0;
function check(name, callback) { callback(); checks++; console.log('PASS ' + name); }
const config = { enabled: true, origin: 'https://bridge.test-tailnet.ts.net:8443' };
const authority = 'bridge.test-tailnet.ts.net:8443';
function synthetic(overrides = {}) {
  return { url: '/__dsh/lite-rpc', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    ...overrides, headers: { host: authority, 'x-forwarded-host': authority,
      'x-forwarded-proto': 'https', origin: config.origin, ...(overrides.headers || {}) } };
}
function unit() {
  const accepted = admission.evaluateRequest(synthetic(), config);
  check('exact loopback private HTTPS admission is remote-only, never auth', () => { assert.equal(accepted.allowed, true); assert.equal(accepted.forceRemote, true); assert.equal(accepted.code, 'private-https-admitted'); assert.deepEqual(Object.keys(accepted).sort(), ['allowed', 'applies', 'code', 'forceRemote', 'status']); });
  check('default is disabled for ts.net entrance', () => assert.equal(admission.evaluateRequest(synthetic()).code, 'private-https-disabled'));
  check('direct localhost and ordinary tunnel remain outside this optional restriction', () => {
    for (const host of ['127.0.0.1', 'localhost:8081', 'fixture.trycloudflare.com']) {
      const req = synthetic({ headers: { host, 'x-forwarded-host': host, origin: 'https://' + host } });
      assert.equal(admission.evaluateRequest(req).applies, false); assert.equal(admission.isForceRemote(req), false);
    }
  });
  for (const badConfig of [{ enabled: 'true', origin: config.origin }, { enabled: true, origin: 'http://' + authority }, { enabled: true, origin: config.origin + '/k/private' }, { enabled: true, origin: 'https://*.test-tailnet.ts.net' }]) {
    check('invalid or disabled configuration cannot admit ' + checks, () => assert.equal(admission.evaluateRequest(synthetic(), badConfig).allowed, false));
  }
  const changes = [
    { headers: { host: 'other.test-tailnet.ts.net:8443' } },
    { headers: { host: 'localhost:8081' } },
    { headers: { host: authority + ', localhost' } },
    { headers: { host: [authority] } },
    { headers: { host: authority.toUpperCase() } },
    { headers: { 'x-forwarded-host': 'other.test-tailnet.ts.net:8443' } },
    { headers: { 'x-forwarded-host': undefined } },
    { headers: { 'x-forwarded-proto': 'http' } },
    { headers: { 'x-forwarded-proto': 'https,http' } },
    { headers: { 'x-forwarded-proto': undefined } },
    { headers: { origin: 'https://foreign.example' } },
    { headers: { origin: 'null' } },
    { headers: { origin: undefined } },
    { headers: { origin: [config.origin] } },
    { socket: { remoteAddress: '192.0.2.1' } },
    { headers: { 'tailscale-funnel-request': '?1' } },
    { headers: { 'tailscale-funnel-request': '?0' } },
    { headers: { 'tailscale-funnel-request': '' } },
    { method: 'post' },
    { url: 'https://foreign.example/__dsh/lite-rpc' },
    { url: '//foreign.example/__dsh/lite-rpc' },
    { url: '/%FF' },
    { url: '/%255f%255fconsole/action' },
    { url: '/a/../__console/action' },
    { url: '/%2f__console/action' },
    { url: '/%25252525255f__console/action' }
  ];
  for (const change of changes) check('malformed/foreign/public proxy refuses ' + checks, () => assert.equal(admission.evaluateRequest(synthetic(change), config).allowed, false));
  for (const url of ['/console', '/console/', '/console.html', '/__console/status', '/__console/action', '/__health', '/__notify', '/__recover', '/__gateway-action', '/__private-https/status']) {
    check('management path is unavailable privately ' + url, () => assert.equal(admission.evaluateRequest(synthetic({ url }), config).code, 'private-https-management-refused'));
  }
  for (const method of ['GET', 'HEAD']) check('bootstrap navigation may omit Origin ' + method, () => assert.equal(admission.evaluateRequest(synthetic({ url: '/dsh-lite', method, headers: { origin: undefined } }), config).allowed, true));
  check('browser upgrade requires exact Origin even when GET', () => assert.equal(admission.evaluateRequest(synthetic({ method: 'GET', headers: { origin: undefined } }), config, { upgrade: true }).allowed, false));
  check('Tailscale identity headers do not change admission authority', () => assert.deepEqual(admission.evaluateRequest(synthetic({ headers: { 'tailscale-user-login': 'identity-is-not-auth', 'tailscale-user-name': 'not-a-device' } }), config), accepted));
  for (const name of ['Host', 'Origin', 'X-Forwarded-Host', 'X-Forwarded-Proto']) {
    const req = synthetic(); req.rawHeaders = Object.entries(req.headers).flat(); req.rawHeaders.push(name, req.headers[name.toLowerCase()]);
    check('duplicate raw security header refuses ' + name, () => assert.equal(admission.evaluateRequest(req, config).code, 'private-https-malformed-request'));
  }
  check('normalized/raw header disagreement refuses', () => { const req = synthetic(); req.rawHeaders = Object.entries(req.headers).flat(); req.rawHeaders[1] = 'other.test-tailnet.ts.net:8443'; assert.equal(admission.evaluateRequest(req, config).allowed, false); });
  check('client flags cannot fabricate the remote marker', () => assert.equal(admission.isForceRemote({ 'private-https-remote-only': true, __privateHttpsRemote: true, headers: { 'x-private-https-remote-only': 'true' } }), false));
  const req = synthetic({ method: 'GET', url: '/dsh-lite' });
  const untouched = { writeHead() { throw Error('Valid admission wrote a response'); }, end() { throw Error('Valid admission ended a response'); } };
  check('admission only marks req and leaves all existing gates next', () => { assert.equal(admission.enforceHttp(req, untouched, config), false); assert.equal(admission.isForceRemote(req), true); assert.equal(admission.enforceHttp(req, untouched, config), false); assert.equal(originPolicy.isLoopback(req), false); });
  check('internal shim inheritance can only make classification stricter', () => { const shim = {}; admission.inheritRemote(req, shim); assert.equal(admission.isForceRemote(shim), true); admission.inheritRemote({}, shim); assert.equal(admission.isForceRemote(shim), true); const other = {}; admission.inheritRemote({}, other); assert.equal(admission.isForceRemote(other), false); });
}

async function gateway() {
  const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  const SECRET = 'isolated-private-https-secret-0123456789', LOGIN = 'isolated-login';
  const PRIVATE = 'Synthetic private conversation: never raw on the wire';
  let currentConfig = config, proven = true, usableSecret = true, dispatches = 0, wsDispatches = 0, checkedKey = null;
  let statusDiscoveries = 0, statusCommands = 0;
  const gatewayErrors = [];
  const temporaryRoot = path.resolve(process.env.PB_TEST_TMP || os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'pb-private-https-'));
  const store = new replay.ReplayStore({ file: path.join(temporary, 'replay.jsonl') });
  const context = {
    Buffer, URL, Readable, path, crypto, net, setTimeout, setImmediate, process: { env: {} },
    privateHttpsAdmission: admission, cfg: { loadConfig: () => ({ privateHttps: currentConfig }), isOwnAddress: () => true },
    privateHttpsStatus: { readStatus: options => require('./tailscale-private-https.js').readStatus(options, { findInstalledCli: () => { statusDiscoveries++; return null; }, runReadOnly: () => { statusCommands++; throw Error('An absent or disabled client ran a command'); } }) },
    requestOrigin: originPolicy, viaRelay: originPolicy.viaRelay,
    retiredTargets: require('./retired-targets.js'), dshPhoneSurface: require('./dsh-phone-surface.js'),
    MAX_E2EE_BODY: 1024 * 1024,
    e2ee: { ...e2ee, openIncoming: (secret, bytes) => e2ee.openIncoming(secret, bytes, { store }) },
    e2eeBridge: { readSecret: () => usableSecret ? SECRET : null, wanted: (url, secret) => !!secret && new URL(url, 'http://localhost').searchParams.get('e2ee') === '1', attach: secret => { checkedKey = secret; return wsBridge.attach(secret); } },
    COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN, GATEWAY_AUTH_COOKIE: 'fixture-login', ACCESS_KEY: 'fixture-access', DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device',
    routes: { clientIpOf: req => req.headers['x-forwarded-for'] || req.socket.remoteAddress },
    sessions: { verify: token => token === 'valid' ? { ok: true, device: { id: 'fixture', label: 'Fixture' } } : { ok: false, reason: 'revoked' }, isSelfClient: () => true, labelFromUa: () => 'Desktop' },
    authProvenAt: () => proven, authObserved: new Set(), proofBootWindowOpen: () => false, proofLooksInProgress: () => false,
    proofWaitHits: new Map(), PROOF_WAIT_FULL_MS: 100, PROOF_WAIT_MS: 100, PROOF_WAIT_MAX_PER_DEVICE: 1,
    PWA_ROUTES: {}, dshLazyImageStore: { imageDigestFromPath: () => null }, isBootstrapRequest: () => false, log() {}, markActivity() {},
    pageLanguage: () => 'en', pickLang: () => 'en', pageText: () => ({ errors: { noKey: 'Authentication required' } }), deviceErrorPage: () => 'Authentication required.',
    PLAINTEXT_REFUSED: { en: { head: 'Encrypted request required', body: '', how: '' } }, buildUpstreamHeaders: req => req.headers
  };
  const names = ['isOwnAddress', 'isLocalRequest', 'isSelfClientRequest', 'isSelfCheck', 'isLoopback', 'readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie', 'keyMatches', 'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof', 'e2eeSecretOrNull', 'refuseEncryptionUnavailable', 'refuseEncryptionUnavailableUpgrade', 'refusePlaintext', 'clientWantsE2ee', 'wrapEncryptedResponse', 'e2eeWrap', 'handleConsole', 'handleRequest', 'handleRequestInner', 'handleUpgrade'];
  vm.createContext(context);
  vm.runInContext(names.map(name => {
    if (name === 'ensureDevice') {
      const start = source.indexOf('function ensureDevice('), brace = source.indexOf(') {', start) + 2;
      return source.slice(start, brace) + extractFunction('function isolatedBody() ' + source.slice(brace), 'isolatedBody').replace('function isolatedBody() ', '');
    }
    const text = extractFunction(source, name); assert.ok(text, name); return text;
  }).join('\n'), context);
  const contentPaths = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(contentPaths); context.E2EE_CONTENT_PATHS = new Set([...contentPaths[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
  context.serveDshLiteRpcE2ee = context.e2eeWrap((req, res) => {
    assert.equal(admission.isForceRemote(req), true, 'The actual decrypted request lost private remote classification');
    dispatches++; req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, value: PRIVATE })); });
  });
  const server = http.createServer((req, res) => {
    try { context.handleRequest(req, res); } catch (error) { gatewayErrors.push(error); res.writeHead(500); res.end('Isolated gateway failed'); }
  });
  server.on('upgrade', (req, socket, head) => context.handleUpgrade(req, socket, head));
  const upstream = http.createServer();
  const sockets = new Set();
  for (const s of [server, upstream]) s.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (req, socket) => {
    wsDispatches++;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  context.EXPLICIT_TARGET_PORT = context.TARGET_PORT = upstream.address().port; context.TARGET_HOST = '127.0.0.1';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.PORT = server.address().port;
  const headersFor = () => ({ host: authority, 'x-forwarded-host': authority, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', origin: config.origin, cookie: 'fixture-login=' + LOGIN + '; fixture-device=valid', accept: 'application/json', 'tailscale-user-login': 'cannot-authenticate', 'x-dsh-selfcheck': '1', 'user-agent': 'Desktop' });
  async function request(extra = {}, url = '/__dsh/lite-rpc', method = 'POST', encrypted = true) {
    const plain = Buffer.from('{"method":"session/projections","request":{"sessionId":"fixture"}}');
    const body = method === 'GET' ? Buffer.alloc(0) : encrypted ? e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, plain) : plain;
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(Object.entries({ ...headersFor(), 'content-length': body.length, 'content-type': encrypted ? 'application/octet-stream' : 'application/json', ...(encrypted ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json' } : {}), ...extra }).filter(([, value]) => value !== undefined));
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
      req.on('error', reject); req.setTimeout(2500, () => req.destroy(Error('Owned fixture timed out'))); req.end(body);
    });
  }
  async function upgrade(extra = {}, url = '/api/remote.mux?e2ee=1') {
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(Object.entries({ ...headersFor(), connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), ...extra }).filter(([, value]) => value !== undefined));
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, headers });
      req.on('response', res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
      req.on('upgrade', (res, socket, head) => { socket.end(); resolve({ status: res.statusCode, headers: res.headers, body: head }); });
      req.on('error', reject); req.setTimeout(2500, () => req.destroy(Error('Owned upgrade timed out'))); req.end();
    });
  }
  try {
    const localShape = synthetic({ url: '/__dsh/lite-rpc', headers: { 'x-forwarded-for': '100.64.0.2', 'user-agent': 'Desktop' } });
    admission.enforceHttp(localShape, { writeHead() {}, end() {} }, config);
    check('actual gateway local/self-check/self-client cannot bypass marked private ingress', () => { assert.equal(context.isLocalRequest(localShape), false); assert.equal(context.isSelfCheck(localShape), false); assert.equal(context.isSelfClientRequest(localShape), false); assert.equal(context.isLoopback(localShape), false); });
    let result = await request();
    assert.equal(gatewayErrors.length, 0, gatewayErrors[0] && gatewayErrors[0].message);
    check('actual private HTTP dispatch requires auth/proof and returns AES ciphertext', () => { assert.equal(result.status, 200); assert.equal(result.headers['x-dsh-e2ee'], '1'); assert.ok(!result.body.includes(Buffer.from(PRIVATE))); const plain = e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, result.body); assert.equal(JSON.parse(plain).value, PRIVATE); assert.equal(dispatches, 1); });
    const before = dispatches;
    for (const extra of [{ cookie: '' }, { cookie: 'fixture-login=' + LOGIN + '; fixture-device=revoked' }, { origin: 'https://foreign.example' }, { 'tailscale-funnel-request': '?1' }, { host: 'other.test-tailnet.ts.net:8443' }]) {
      result = await request(extra); check('actual HTTP authentication/ingress refusal ' + checks, () => { assert.equal(result.status, 403); assert.equal(dispatches, before); assert.ok(!result.body.includes(Buffer.from(PRIVATE))); });
    }
    proven = false; result = await request(); check('actual private challenge proof remains compulsory', () => { assert.equal(result.status, 403); assert.equal(result.headers['x-dsh-need-proof'], '1'); assert.equal(dispatches, before); }); proven = true;
    result = await request({}, undefined, undefined, false); check('actual private plaintext HTTP remains forbidden', () => { assert.equal(result.status, 403); assert.equal(dispatches, before); });
    usableSecret = false; result = await request(); check('actual private missing key cannot fall back to raw data', () => { assert.equal(result.status, 503); assert.equal(dispatches, before); }); usableSecret = true;
    currentConfig = { enabled: false }; result = await request(); check('actual gateway optional entrance disabled', () => { assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).code, 'private-https-disabled'); assert.equal(dispatches, before); }); currentConfig = config;
    for (const url of ['/console', '/__console/status', '/__console/action', '/__health', '/__notify', '/__recover', '/__private-https/status']) {
      result = await request({}, url, 'GET'); check('real private request cannot reach management ' + url, () => { assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).code, 'private-https-management-refused'); });
    }
    result = await upgrade(); check('actual private encrypted WS upgrade retains checked key', () => { assert.equal(result.status, 101); assert.equal(wsDispatches, 1); assert.equal(checkedKey, SECRET); });
    const wsBefore = wsDispatches;
    for (const [extra, url] of [[{ cookie: '' }], [{ cookie: 'fixture-login=' + LOGIN + '; fixture-device=revoked' }], [{ origin: 'https://foreign.example' }], [{ origin: undefined }], [{ 'tailscale-funnel-request': '?1' }], [{}, '/api/remote.mux']]) {
      result = await upgrade(extra, url); check('actual private WS ingress/auth/encryption refusal ' + checks, () => { assert.equal(result.status, 403); assert.equal(wsDispatches, wsBefore); });
    }
    proven = false; result = await upgrade(); check('actual private WS challenge proof cannot be bypassed by identity/self-client', () => { assert.equal(result.status, 403); assert.equal(result.headers['x-dsh-need-proof'], '1'); assert.equal(wsDispatches, wsBefore); }); proven = true;
    usableSecret = false; result = await upgrade(); check('actual private WS missing key refuses with no upstream', () => { assert.equal(result.status, 503); assert.equal(wsDispatches, wsBefore); }); usableSecret = true;
    currentConfig = { enabled: false }; result = await upgrade(); check('actual optional WS entrance is disabled too', () => { assert.equal(result.status, 403); assert.equal(wsDispatches, wsBefore); });
    const localHeaders = { host: '127.0.0.1', 'x-forwarded-host': undefined, 'x-forwarded-proto': undefined, 'x-forwarded-for': undefined, origin: undefined, cookie: '' };
    result = await request(localHeaders, '/__private-https?enabled=true&origin=https://foreign.example', 'GET', false);
    check('actual local status is disabled, read-only, zero CLI and has no phone claim', () => { assert.equal(result.status, 200); const body = JSON.parse(result.body); assert.equal(body.code, 'disabled'); assert.equal(body.gatewayPort, server.address().port); assert.equal(body.gatewayAdmissionImplemented, true); assert.equal(body.phoneVerified, false); assert.equal(body.mutationPerformed, false); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(statusDiscoveries, 0); assert.equal(statusCommands, 0); });
    result = await request(localHeaders, '/__private-https', 'POST', false);
    check('actual status rejects a local write method without an action', () => assert.equal(result.status, 405));
    result = await request({ ...localHeaders, 'x-forwarded-host': 'public.trycloudflare.com', 'x-forwarded-for': '192.0.2.1' }, '/__private-https', 'GET', false);
    check('actual status rejects forwarded localhost authority before discovery', () => { assert.equal(result.status, 403); assert.equal(statusDiscoveries, 0); assert.equal(statusCommands, 0); });
    currentConfig = config;
    result = await request(localHeaders, '/__private-https', 'GET', false);
    check('actual local enabled status truthfully reports unavailable client without CLI', () => { assert.equal(result.status, 200); const body = JSON.parse(result.body); assert.equal(body.code, 'not-installed'); assert.equal(body.installed, false); assert.equal(body.connected, false); assert.equal(body.configurationReady, false); assert.equal(body.phoneVerified, false); assert.equal(body.mutationPerformed, false); assert.equal(statusDiscoveries, 1); assert.equal(statusCommands, 0); });
  } finally {
    for (const socket of sockets) socket.destroy(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    if (path.dirname(path.resolve(temporary)) !== temporaryRoot || !path.basename(temporary).startsWith('pb-private-https-')) throw Error('Owned fixture cleanup scope changed');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => { unit(); if (!process.argv.includes('--policy-only')) await gateway(); console.log(checks + ' private HTTPS admission checks passed; owned sockets/synthetic identity only, no Tailscale or phone connection claim.'); })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
