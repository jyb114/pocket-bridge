'use strict';

// Run the actual entry functions in an isolated HTTP/TCP harness. The upstream
// contains synthetic secret content so a mistaken catch-all is observable.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const http = require('http'), net = require('net'), os = require('os');
const { EventEmitter } = require('events');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const requestOrigin = require('./request-origin.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
const retiredTargets = require('./retired-targets.js');
const wsBridge = require('./ws-e2ee-bridge.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const ownAddress = vm.runInNewContext('(' + extractFunction(configSource, 'isOwnAddress') + ')', { os });
const SECRET = 'isolated-phone-surface-key-0123456789';
const PRIVATE = 'PRIVATE_SYNTHETIC_HISTORY_AND_FILE_BYTES';
let checks = 0, upstreamReads = 0, discoveries = 0, wsConnections = 0;
let key = SECRET, authenticated = true;
function statement(marker) {
  const at = source.indexOf(marker);
  assert(at >= 0, marker);
  const open = source.indexOf('{', at), end = sliceBalanced(source, open, '{', '}');
  assert(end > open, marker);
  return source.slice(at, end + 1);
}
const rootBranch = statement("if (u.pathname === '/' || u.pathname === '/index.html')");
const contentGate = statement('if (E2EE_CONTENT_PATHS.has(u.pathname)');
const contentPaths = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
assert(contentPaths);
const paths = new Set([...contentPaths[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
function check(name, fn) { return Promise.resolve().then(fn).then(() => { checks++; console.log('PASS ' + name); }); }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
function request(port, url, headers = {}, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers, method }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
function upgrade(port, url, extra = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }); let text = '';
    socket.setTimeout(2500, () => socket.destroy(Error('isolated upgrade timeout')));
    socket.on('connect', () => socket.write('GET ' + url + ' HTTP/1.1\r\nHost: public.fixture.invalid\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' + extra + '\r\n'));
    socket.on('data', b => text += b); socket.on('error', reject);
    socket.on('close', () => resolve(text));
  });
}
(async () => {
  const upstream = http.createServer((req, res) => {
    upstreamReads++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(PRIVATE);
  });
  const targetPort = await listen(upstream);
  const context = vm.createContext({ Buffer, URL, http, retiredTargets, dshPhoneSurface,
    requestOrigin, cfg: { isOwnAddress: ownAddress },
    EXPLICIT_TARGET_PORT: targetPort, TARGET_PORT: targetPort, TARGET_HOST: '127.0.0.1',
    refreshDshRuntime() { discoveries++; return Promise.resolve(true); },
    dshLazyImageStore: { originalModuleUrl: () => null },
    buildUpstreamHeaders: req => req.headers, cacheableAssetHeaders: (_req, up) => up.headers,
    markActivity() {}, log() {}, hasAuthCookie: () => authenticated,
    ensureDevice: () => ({ ok: true, device: null }), e2eeSecretOrNull: () => key,
    e2eeBridge: { readSecret: () => key, wanted: wsBridge.wanted },
    refuseEncryptionUnavailableUpgrade(socket) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); },
    net: { connect() { wsConnections++; return new EventEmitter(); } },
    targetCookie: () => 'fixture-target=dsh; Path=/', TARGET_COOKIE: 'fixture-target',
    servePwa(req, res, asset) { assert.equal(asset.file, 'dsh-lite.html'); res.writeHead(200, { 'content-type': asset.type }); res.end('OWNED_ENCRYPTED_LITE_SHELL'); },
    shouldShowLauncher: () => false, readTargetCookie: () => 'dsh',
    E2EE_CONTENT_PATHS: paths,
    refuseEncryptionUnavailable(res) { res.writeHead(503); res.end('encryption-unavailable'); },
    refusePlaintext(_req, res) { res.writeHead(403); res.end('encrypted-request-required'); },
    clientWantsE2ee: (req, u) => req.headers['x-dsh-e2ee'] === '1' || u.searchParams.get('e2ee') === '1'
  });
  vm.runInContext(extractFunction(source, 'isOwnAddress') + '\n' + extractFunction(source, 'isLocalRequest') + '\n' +
    extractFunction(source, 'proxyRequest') + '\n' + extractFunction(source, 'handleUpgrade') +
    '\nfunction root(req,res,u){' + rootBranch + ';return false;}' +
    '\nfunction gate(req,res,u){' + contentGate + ';return false;}', context);
  const gateway = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/root-fixture') { u.pathname = '/'; context.root(req, res, u); if (!res.writableEnded) context.proxyRequest(req, res); }
    else if (u.pathname === '/gate-fixture') { u.pathname = req.headers['fixture-content-path']; context.gate(req, res, u); if (!res.writableEnded) { res.writeHead(204); res.end(); } }
    else context.proxyRequest(req, res);
  });
  gateway.on('upgrade', (req, socket, head) => context.handleUpgrade(req, socket, head));
  const port = await listen(gateway), remote = { host: 'public.fixture.invalid', 'cf-ray': 'synthetic' };
  try {
    const rawPaths = ['/api/session/page/list', '/api/session/projections', '/api/workspaceFiles/readBytes',
      '/api/workspaceFiles/readText?path=synthetic', '/api/session/prompt?e2ee=1', '/api/session/uploadFileBinary',
      '/api/events.host', '/events', '/plugins/unknown/module.js', '/assets/image.png', '/files/download',
      '/unknown', '/%61pi/session/page/list', '/api%2fsession%2fpage%2flist', '//api/session/projections',
      '/api/remote.mux?e2ee=1', '/dsh/index.html'];
    for (const url of rawPaths) await check('raw remote HTTP never reaches upstream: ' + url, async () => {
      const before = upstreamReads, r = await request(port, url, remote, 'POST', PRIVATE);
      assert.equal(r.status, 410); assert.equal(JSON.parse(r.body).code, 'dsh-classic-retired');
      assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['set-cookie'], undefined);
      assert.doesNotMatch(r.body, new RegExp(PRIVATE)); assert.equal(upstreamReads, before); assert.equal(discoveries, 0);
    });
    await check('forwarding header cannot gain the direct-computer raw proxy exemption', async () => {
      for (const headers of [{ 'x-forwarded-for': '192.0.2.1' }, { forwarded: 'for=192.0.2.1' }, { 'cf-worker': 'synthetic' }]) {
        const r = await request(port, '/api/session/projections', headers); assert.equal(r.status, 410);
      }
    });
    await check('HEAD refusal has fixed metadata and no body', async () => {
      const r = await request(port, '/api/workspaceFiles/readBytes', remote, 'HEAD');
      assert.equal(r.status, 410); assert.equal(r.body, ''); assert(Number(r.headers['content-length']) > 0);
    });
    await check('direct computer raw HTTP remains usable', async () => {
      const before = upstreamReads, r = await request(port, '/api/session/projections');
      assert.equal(r.status, 200); assert.equal(r.body, PRIVATE); assert.equal(upstreamReads, before + 1);
    });
    for (const suffix of ['', '?target=dsh', '?target=pick', '?target=lite']) await check('remote root uses owned Lite without redirect: ' + suffix, async () => {
      const r = await request(port, '/root-fixture' + suffix, remote);
      assert.equal(r.status, 200); assert.equal(r.body, 'OWNED_ENCRYPTED_LITE_SHELL'); assert.equal(r.headers.location, undefined);
    });
    await check('explicit remote classic bookmark is harmless', async () => {
      const r = await request(port, '/root-fixture?target=dsh&view=classic', remote);
      assert.equal(r.status, 410); assert.equal(JSON.parse(r.body).openPath, '/dsh-lite');
    });
    await check('key-path phone shell leaves original URL intact', () => {
      const req = { url: '/k/synthetic-key?target=dsh', headers: remote, socket: { remoteAddress: '127.0.0.1' } };
      const res = { getHeader() {}, setHeader() {}, writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
      context.root(req, res, new URL('http://localhost/?target=dsh'));
      assert.equal(req.url, '/k/synthetic-key?target=dsh'); assert.equal(res.status, 200);
    });
    await check('LAN phone raw proxy is refused even with local Host', () => {
      const req = { method: 'GET', url: '/api/session/projections', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '192.0.2.4' } };
      const res = { writeHead(code) { this.status = code; }, end(body) { this.body = body; } };
      context.proxyRequest(req, res); assert.equal(res.status, 410); assert.doesNotMatch(res.body, new RegExp(PRIVATE));
    });
    for (const pathname of paths) await check('phone content channel still requires encryption: ' + pathname, async () => {
      const headers = { ...remote, 'fixture-content-path': pathname };
      assert.equal((await request(port, '/gate-fixture', headers)).status, 403);
      assert.equal((await request(port, '/gate-fixture?e2ee=1', headers)).status, 204);
      key = null; assert.equal((await request(port, '/gate-fixture?e2ee=1', headers)).status, 503); key = SECRET;
    });
    await check('LAN content gate cannot fall back to plaintext', () => {
      const req = { url: '/__dsh/lite-rpc', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '192.0.2.4' } };
      const res = { writeHead(code) { this.status = code; }, end() {} };
      context.gate(req, res, new URL('http://localhost/__dsh/lite-rpc')); assert.equal(res.status, 403); assert.equal(req.__dshRequireE2ee, true);
    });
    for (const url of ['/events?e2ee=1', '/api/events.mux?e2ee=1', '/api/events.host?e2ee=1', '/plugins/ws?e2ee=1',
      '/api/remote.mux/?e2ee=1', '/api/%72emote.mux?e2ee=1', '//api/remote.mux?e2ee=1']) await check('unknown/legacy remote WS is refused: ' + url, async () => {
      const r = await upgrade(port, url); assert.match(r, /^HTTP\/1\.1 410 Gone\r\n/); assert.equal(wsConnections, 0); assert.equal(discoveries, 0);
    });
    await check('WS auth still precedes transport retirement', async () => {
      authenticated = false; const r = await upgrade(port, '/events?e2ee=1'); authenticated = true;
      assert.match(r, /^HTTP\/1\.1 403 Forbidden/); assert.equal(wsConnections, 0);
    });
    await check('WS missing key and plaintext remain fail-closed', async () => {
      key = null; assert.match(await upgrade(port, '/api/remote.mux?e2ee=1'), /^HTTP\/1\.1 503/); key = SECRET;
      assert.match(await upgrade(port, '/api/remote.mux'), /^HTTP\/1\.1 403/); assert.equal(wsConnections, 0);
    });
    await check('only the exact encrypted Lite mux reaches connection setup with a pinned key', () => {
      const req = { method: 'GET', url: '/api/remote.mux?e2ee=1', headers: remote, socket: { remoteAddress: '127.0.0.1' } };
      const socket = new EventEmitter(); socket.destroyed = false; socket.write = () => { throw Error('must not refuse'); };
      context.handleUpgrade(req, socket, Buffer.alloc(0)); assert.equal(wsConnections, 1); assert.equal(req.__dshWsE2eeSecret, SECRET);
    });
    await check('direct computer legacy WS retains optional encryption', () => {
      const req = { method: 'GET', url: '/events', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
      const socket = new EventEmitter(); socket.destroyed = false; socket.write = () => { throw Error('must not refuse'); };
      context.handleUpgrade(req, socket, Buffer.alloc(0)); assert.equal(wsConnections, 2); assert.equal(req.__dshWsE2eeSecret, undefined);
    });
    await check('mux allowlist does not normalize aliases into action authority', () => {
      assert(dshPhoneSurface.isRemoteMux('/api/remote.mux?e2ee=1'));
      for (const url of ['http://localhost/api/remote.mux', 'api/remote.mux', '/api/remote.mux#fragment', '/api/%72emote.mux', '/API/remote.mux', '/api/remote.mux/']) assert(!dshPhoneSurface.isRemoteMux(url), url);
    });
    console.log(checks + ' isolated phone-surface checks passed. No production/native action.');
  } finally { await close(gateway); await close(upstream); }
})().catch(err => { console.error(err); process.exitCode = 1; });
