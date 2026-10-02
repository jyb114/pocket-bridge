'use strict';
// Actual gateway routing/auth gates and encryption wrappers over local HTTP.
// Device verification uses synthetic records; the endpoint handler records a
// synthetic delivery. No production keys, native desktop, or model are used.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const http = require('node:http'), vm = require('node:vm'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source.js');
const e2ee = require('./e2ee.js'), requestOrigin = require('./request-origin.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const SECRET = 'isolated-desktop-relay-secret-0123456789', LOGIN = 'isolated-login-cookie';
const THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b45';
const BODY = { action: 'send', id: 'isolated-relay-request', threadId: THREAD, cwd: 'D:\\isolated-project', text: 'Private desktop relay instruction. 中文内容。' };
const seen = [], wire = [], proven = new Set(['fixture-proven']);
let checks = 0;
const context = {
  Buffer, URL, Readable, e2ee, crypto, setTimeout, MAX_E2EE_BODY: 64 * 1024 * 1024,
  COOKIE_NAME: 'fixture-legacy-login', COOKIE_VALUE: LOGIN, GATEWAY_AUTH_COOKIE: 'fixture-login', ACCESS_KEY: 'fixture-access-key',
  DEVICE_COOKIE: 'fixture-device', LEGACY_DEVICE_COOKIE: 'fixture-legacy-device',
  e2eeSecretOrNull: () => SECRET,
  viaRelay: requestOrigin.viaRelay, isLocalRequest: requestOrigin.isLoopback,
  isSelfCheck: () => false, isSelfClientRequest: () => false,
  routes: { clientIpOf: req => req.socket.remoteAddress },
  sessions: { verify(token) { return token === 'valid-device' ? { ok: true, device: { id: 'fixture-proven', label: 'Fixture' } } :
    token === 'unproven-device' ? { ok: true, device: { id: 'fixture-unproven', label: 'Fixture' } } : { ok: false, reason: 'revoked' }; } },
  authProvenAt: id => proven.has(id), authObserved: new Set(),
  proofBootWindowOpen: () => false, proofLooksInProgress: () => false,
  proofWaitHits: new Map(), PROOF_WAIT_FULL_MS: 100, PROOF_WAIT_MS: 100, PROOF_WAIT_MAX_PER_DEVICE: 1,
  PWA_ROUTES: {}, dshLazyImageStore: { imageDigestFromPath: () => null },
  handleConsole: () => false, isBootstrapRequest: () => false,
  log() {}, pageLanguage: () => 'en', pageText: () => ({ errors: { noKey: 'Authentication required: ' } }),
  deviceErrorPage: () => 'Device authentication failed.',
  PLAINTEXT_REFUSED: { zh: { head: 'Encrypted request required', body: '', how: '' }, en: { head: 'Encrypted request required', body: '', how: '' } },
  pickLang: () => 'en'
};
const functions = ['readNamedCookie', 'readDeviceToken', 'hasLegacyAuthCookie', 'safeEqualStr', 'hasAuthCookie', 'keyMatches',
  'installCookieMerger', 'migrateLegacyRequestCookies', 'ensureDevice', 'rejectNeedProof', 'refusePlaintext',
  'clientWantsE2ee', 'wrapEncryptedResponse', 'e2eeWrap', 'handleRequestInner'];
vm.createContext(context);
vm.runInContext(functions.map(name => {
  let text;
  if(name==='ensureDevice'){
    // The shared extractor starts at the first brace, including a default {} in
    // a parameter list. Preserve the actual signature and extract its body.
    const start=source.indexOf('function ensureDevice('), brace=source.indexOf(') {',start)+2;
    text=source.slice(start,brace)+extractFunction('function isolatedBody() '+source.slice(brace),'isolatedBody').replace('function isolatedBody() ','');
  }else text=extractFunction(source,name);
  assert.ok(text,name);return text;
}).join('\n'), context);
const pathList = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(pathList); context.E2EE_CONTENT_PATHS = new Set([...pathList[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
assert(context.E2EE_CONTENT_PATHS.has('/codex/desktop-relay'));
assert.match(source, /const codexDesktopRelayHandleE2ee = e2eeWrap\(codexDesktopRelay\.handle\.bind\(codexDesktopRelay\)\)/);
context.codexDesktopRelayHandleE2ee = context.e2eeWrap((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, decrypted: req.__dshE2eeDecrypted === true, text });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ requestId: BODY.id, threadId: THREAD, state: 'accepted', delivery: 'message', deliveryConfirmed: true, executionConfirmed: false }));
  }); req.resume();
});
function check(name, condition) { assert.ok(condition, name); checks++; console.log('PASS ' + name); }
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => wire.push(Buffer.concat(chunks)));
  try { context.handleRequestInner(req, res, 0); }
  catch (error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(error.stack); }
});
async function request({ method = 'POST', query = '', cookie = `fixture-login=${LOGIN}; fixture-device=valid-device`, body,
  encrypted = true, headers = {} } = {}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const raw = encrypted && bytes.length ? e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, bytes) : bytes;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/codex/desktop-relay' + query, method,
      headers: { host: 'fixture.trycloudflare.com', cookie, accept: 'application/json',
        ...(encrypted ? { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }),
        'content-length': raw.length, 'x-dsh-desktop-relay': '1', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const data=Buffer.concat(chunks);if(res.statusCode===500)return reject(Error(data.toString('utf8')));
        resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    }); req.on('error', reject); req.end(raw);
  });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let result = await request({ body: BODY, cookie: '' });
    check('an encrypted relay POST without the correct login cookie never reaches its handler', result.status === 403 && result.headers['x-dsh-auth-required'] === '1' && seen.length === 0);
    result = await request({ body: BODY, cookie: `fixture-login=forged; fixture-device=valid-device` });
    check('cookie names and a valid device token alone cannot bypass login authentication', result.status === 403 && seen.length === 0);
    result = await request({ body: BODY, cookie: `fixture-login=${LOGIN}; fixture-device=revoked-device` });
    check('a revoked device cannot dispatch desktop relay requests', result.status === 403 && seen.length === 0);
    result = await request({ body: BODY, cookie: `fixture-login=${LOGIN}; fixture-device=unproven-device` });
    check('an unproven device is refused before relay dispatch', result.status === 403 && result.headers['x-dsh-need-proof'] === '1' && seen.length === 0);
    result = await request({ body: BODY, encrypted: false });
    check('an authenticated public-host request cannot send relay plaintext', result.status === 403 && seen.length === 0);
    result = await request({ body: BODY, encrypted: false, headers: { 'x-dsh-e2ee': '1' } });
    check('a forged encryption header does not forward plaintext to the relay handler', result.status === 400 && seen.length === 0);
    result = await request({ body: BODY, encrypted: false, query: '?e2ee=1' });
    check('a query encryption flag does not turn plaintext into a valid encrypted body', result.status === 400 && seen.length === 0);
    const damaged = e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, Buffer.from(JSON.stringify(BODY))); damaged[damaged.length - 1] ^= 1;
    result = await request({ body: damaged, encrypted: false, headers: { 'x-dsh-e2ee': '1', 'content-type': 'application/octet-stream' } });
    check('an altered ciphertext cannot reach the handler', result.status === 400 && seen.length === 0);
    result = await request({ body: BODY });
    const opened = e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, result.body);
    check('the real route decrypts exact JSON and marks only the authenticated in-process request', result.status === 200 && seen.length === 1 && seen[0].decrypted && seen[0].text === JSON.stringify(BODY));
    check('the wire carries an encrypted response without plaintext receipt IDs or input text', result.headers['x-dsh-e2ee'] === '1' && result.headers['content-type'] === 'application/octet-stream' && !!opened && !result.body.includes(Buffer.from(BODY.id)) && !wire.at(-1).includes(Buffer.from(BODY.text)));
    const receipt = JSON.parse(opened.toString('utf8')); check('decryption restores the exact receipt without claiming execution', receipt.requestId === BODY.id && receipt.deliveryConfirmed && receipt.executionConfirmed === false);
    result = await request({ method: 'GET', query: '?id=' + BODY.id + '&threadId=' + THREAD });
    check('receipt GET also goes through auth and encrypts its response', result.status === 200 && result.headers['x-dsh-e2ee'] === '1' && seen.at(-1).method === 'GET');

    // Execute the actual client crypto implementation, not a replacement API.
    const client = { Buffer, URL, Headers, Response, TextEncoder, TextDecoder, btoa, atob, crypto: crypto.webcrypto,
      location: { href: 'http://fixture.trycloudflare.com', hash: '' }, navigator: {},
      fetch: (url, init) => fetch('http://127.0.0.1:' + server.address().port + new URL(url, 'http://fixture.trycloudflare.com').pathname,
        { ...init, headers: { ...init.headers, host: 'fixture.trycloudflare.com' } }) };
    client.window = client; vm.createContext(client);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pwa', 'e2ee.js'), 'utf8'), client);
    client.DshE2EE.installFetchDecrypt(SECRET);
    const browserResponse = await client.DshE2EE.encryptedFetch(SECRET, '/codex/desktop-relay', { method: 'POST',
      headers: { cookie: `fixture-login=${LOGIN}; fixture-device=valid-device`, 'x-dsh-desktop-relay': '1', 'content-type': 'application/json' }, body: JSON.stringify(BODY) });
    const browserReceipt = await browserResponse.json();
    check('the actual client encryptedFetch and decrypt wrapper interoperate with the actual HTTP route', browserResponse.ok && browserResponse.headers.get('x-dsh-e2ee-decrypted') === '1' && browserReceipt.requestId === BODY.id && seen.at(-1).text === JSON.stringify(BODY) && !wire.at(-1).includes(Buffer.from(BODY.text)));
    console.log(checks + ' desktop relay auth and E2EE HTTP checks passed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
