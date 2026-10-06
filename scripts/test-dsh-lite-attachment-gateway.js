'use strict';

// Run the actual gateway collector against owned HTTP sockets and join it to
// the real attachment/AES handlers. No DSH, installation, credentials or UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source');
const attachment = require('./dsh-lite-attachment');
const dshRuntimeIdentity = require('./dsh-runtime-identity').runtimeIdentity;
const legacyRuntimeIdentity = require('./dsh-legacy-interactions').runtimeIdentity;
const e2ee = require('./e2ee');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const ROUTE = '/__dsh/lite-attachment', API = '/api/session/attachment';
const MiB = 1024 * 1024;
let checks = 0, received = 0, activity = 0, mode;
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
function close(server) { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
function crc32(bytes) {
  let result = -1;
  for (const byte of bytes) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ (0xedb88320 & -(result & 1)); }
  return (result ^ -1) >>> 0;
}
function pngChunk(kind, data) {
  const tag = Buffer.from(kind), out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length); tag.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, data])), out.length - 4); return out;
}
function makePng() {
  const width = 700, height = 700, rows = Buffer.alloc(height * (1 + 3 * width));
  let random = 123456789;
  for (let y = 0; y < height; y++) for (let x = 1; x <= 3 * width; x++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    rows[y * (1 + 3 * width) + x] = random & 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const png = makePng(), imageId = 'sha256:' + crypto.createHash('sha256').update(png).digest('hex');
assert(png.length > MiB && png.length < attachment.MAX_IMAGE_BYTES);
const SECRET = 'isolated-gateway-attachment-secret-0123456789';

(async () => {
  const server = http.createServer((req, res) => {
    received++; const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.host, 'owned-upstream.fixture');
      assert.equal(req.headers.origin, 'http://owned-upstream.fixture');
      assert.equal(req.headers.cookie, 'synthetic-cookie=synthetic-value');
      if (mode.kind === 'hang') return;
      if (mode.kind === 'reset') { req.socket.destroy(); return; }
      if (mode.kind === 'truncated') {
        res.writeHead(200, { 'content-length': 4096 }); res.write(Buffer.alloc(512, 82));
        setTimeout(() => res.destroy(), 10); return;
      }
      let body = mode.body;
      if (mode.kind === 'attachment') {
        assert.equal(req.url, API);
        const request = JSON.parse(Buffer.concat(chunks));
        assert.equal(request.method, 'session/attachment');
        assert.deepEqual(request.payload.args.request, { sessionId: 'synthetic-session', attachmentId: imageId });
        body = Buffer.from(JSON.stringify({ type: 'client-response', rpcId: request.rpcId, result: { ok: true, value: {
          attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: png.length, width: 700, height: 700 },
          data: png.toString('base64')
        } } }));
      }
      res.writeHead(mode.status || 200, { 'content-type': 'application/json' });
      for (let at = 0; at < body.length; at += 65536) res.write(body.subarray(at, at + 65536));
      res.end();
    });
  });
  await listen(server);
  const runtime = { running: true, profile: 'remote-mux', pid: 1001, port: server.address().port, version: '0.1.7-rc.2' };
  let state = { ready: true, runtime };
  const ownedHttp = { request(options, callback) {
    assert.equal(options.timeout, 15000, 'production timeout stays bounded');
    return http.request({ ...options, timeout: mode?.shortTimeout ? 30 : options.timeout }, callback);
  } };
  const context = vm.createContext({ Buffer, URL, Error, http: ownedHttp, Readable, e2ee, dshLiteAttachment: attachment,
    TARGET_HOST: '127.0.0.1', TARGET_PORT: runtime.port, INTERNAL_HOST: 'owned-upstream.fixture',
    DSH_UPSTREAM_AUTH_OK: true, UPSTREAM_COOKIE: { name: 'synthetic-cookie', value: 'synthetic-value' },
    refreshDshRuntimeState: async () => state, dshRuntimeIdentity, legacyRuntimeIdentity,
    markActivity() { activity++; }, log() {}, MAX_E2EE_BODY: 64 * MiB, e2eeSecretOrNull: () => SECRET });
  vm.runInContext(extractFunction(source, 'callDshLiteUpstream'), context);
  const call = extras => ({ path: API, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    verifiedRuntime: runtime, maxResponseBytes: attachment.MAX_RESPONSE_BYTES, ...extras });
  async function rejects(extras, message = 'dsh-response-too-large') {
    const before = received;
    await assert.rejects(context.callDshLiteUpstream(call(extras)), error => error.message === message);
    assert.equal(received, before + 1, 'a collector refusal never retries');
  }
  try {
    await check('actual exported guards distinguish modern identity from unchanged legacy event binding', () => {
      assert.throws(() => legacyRuntimeIdentity(runtime), error => error.code === 'legacy-runtime-unavailable');
      assert.equal(dshRuntimeIdentity(runtime), JSON.stringify([runtime.pid, runtime.port, runtime.profile, runtime.version]));
      const legacy = { ...runtime, profile: 'legacy-events', version: '0.1.1-rc.2' };
      assert.equal(dshRuntimeIdentity(legacy), legacyRuntimeIdentity(legacy));
    });
    await check('exact image POST collects complete multi-megabyte bytes and status', async () => {
      mode = { body: Buffer.alloc(3 * MiB + 17, 83), status: 201 };
      const result = await context.callDshLiteUpstream(call());
      assert.equal(result.statusCode, 201); assert.deepEqual(result.body, mode.body);
    });
    await check('exact 12 MiB upper boundary is accepted in full', async () => {
      mode = { body: Buffer.alloc(attachment.MAX_RESPONSE_BYTES, 84) };
      assert.deepEqual((await context.callDshLiteUpstream(call())).body, mode.body);
    });
    await check('one byte above image envelope cap is refused without partial success', async () => {
      mode = { body: Buffer.alloc(attachment.MAX_RESPONSE_BYTES + 1, 85) }; await rejects();
    });
    for (const request of [
      { path: '/api/session/page/list' }, { path: API + '?alias=1' }, { path: API + '/' },
      { path: '/api/session/%61ttachment' }, { method: 'GET' }, { method: 'post' }, { method: undefined }
    ]) await check('nonexact path or method cannot raise its collector cap: ' + JSON.stringify(request), async () => {
      mode = { body: Buffer.alloc(512 * 1024 + 1, 86) }; await rejects(request);
    });
    await check('ordinary RPC still permits its explicit existing 1 MiB boundary', async () => {
      mode = { body: Buffer.alloc(MiB, 87) };
      assert.deepEqual((await context.callDshLiteUpstream(call({ path: '/api/session/page/list', maxResponseBytes: MiB }))).body, mode.body);
    });
    await check('ordinary RPC above its explicit 1 MiB cap stays refused', async () => {
      mode = { body: Buffer.alloc(MiB + 1, 88) }; await rejects({ path: '/api/session/page/list', maxResponseBytes: MiB });
    });
    for (const cap of [0, -1, attachment.MAX_RESPONSE_BYTES + 1, 1.5, Number.NaN, '12582912', undefined])
      await check('invalid cap keeps old 512 KiB default: ' + String(cap), async () => {
        mode = { body: Buffer.alloc(512 * 1024 + 1, 89) }; await rejects({ maxResponseBytes: cap });
      });
    await check('smaller explicit image budget remains enforced', async () => {
      mode = { body: Buffer.alloc(1025, 90) }; await rejects({ maxResponseBytes: 1024 });
    });
    for (const refusal of ['not-ready', 'auth-unavailable', 'runtime-changed']) await check('runtime gate refuses before any HTTP: ' + refusal, async () => {
      const before = received, marked = activity;
      state = refusal === 'not-ready' ? { ready: false, runtime } : { ready: true, runtime };
      context.DSH_UPSTREAM_AUTH_OK = refusal !== 'auth-unavailable';
      await assert.rejects(context.callDshLiteUpstream(call(refusal === 'runtime-changed' ?
        { verifiedRuntime: { ...runtime, pid: 1002 } } : {})), error =>
        error.message === (refusal === 'runtime-changed' ? 'legacy-runtime-changed' : 'dsh-unavailable'));
      assert.equal(received, before); assert.equal(activity, marked);
      state = { ready: true, runtime }; context.DSH_UPSTREAM_AUTH_OK = true;
    });
    for (const field of ['pid', 'port', 'profile', 'version']) await check('actual runtime identity change refuses before HTTP: ' + field, async () => {
      const changes = { pid: runtime.pid + 1, port: runtime.port === 65535 ? 65534 : runtime.port + 1,
        profile: 'legacy-events', version: '0.1.7-rc.3' };
      const before = received;
      state = { ready: true, runtime: { ...runtime, [field]: changes[field] } };
      await assert.rejects(context.callDshLiteUpstream(call()), error => error.message === 'legacy-runtime-changed');
      assert.equal(received, before); state = { ready: true, runtime };
    });
    for (const mutation of [{ running: false }, { pid: null }, { pid: '1001' }, { pid: 0 },
      { pid: Number.MAX_SAFE_INTEGER + 1 }, { port: 0 }, { port: 65536 }, { port: '8080' }, { profile: 'unsupported' }])
      await check('actual exported modern guard refuses invalid current snapshot: ' + JSON.stringify(mutation), async () => {
        const before = received;
        state = { ready: true, runtime: { ...runtime, ...mutation } };
        await assert.rejects(context.callDshLiteUpstream(call()), error => error.code === 'dsh-runtime-unavailable');
        assert.equal(received, before); state = { ready: true, runtime };
      });
    await check('actual legacy runtime guard still permits its exact matched owned collector request', async () => {
      const legacy = { ...runtime, profile: 'legacy-events', version: '0.1.1-rc.2' };
      state = { ready: true, runtime: legacy }; mode = { body: Buffer.from('synthetic legacy response') };
      const result = await context.callDshLiteUpstream(call({ path: '/api/respond', maxResponseBytes: 65536, verifiedRuntime: legacy }));
      assert.deepEqual(result.body, mode.body); state = { ready: true, runtime };
    });
    await check('already-aborted read never opens an upstream request', async () => {
      const controller = new AbortController(); controller.abort(); const before = received;
      await assert.rejects(context.callDshLiteUpstream(call({ signal: controller.signal })), error => error.code === 'ABORT_ERR');
      assert.equal(received, before);
    });
    await check('live abort closes one owned read and never retries', async () => {
      mode = { kind: 'hang' }; const controller = new AbortController(); const before = received;
      const promise = context.callDshLiteUpstream(call({ signal: controller.signal }));
      const deadline = Date.now() + 2000;
      while (received === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(received, before + 1, 'owned HTTP read began within the fixture deadline');
      controller.abort(); await assert.rejects(promise, error => error.code === 'ABORT_ERR'); assert.equal(received, before + 1);
    });
    await check('upstream disconnect returns an error without retry or plaintext fallback', async () => {
      mode = { kind: 'reset' }; const before = received;
      await assert.rejects(context.callDshLiteUpstream(call())); assert.equal(received, before + 1);
    });
    await check('partial upstream response never resolves as complete image bytes', async () => {
      mode = { kind: 'truncated' }; const before = received;
      await assert.rejects(context.callDshLiteUpstream(call())); assert.equal(received, before + 1);
    });
    await check('owned HTTP timeout settles once and closes without socket error or retry', async () => {
      mode = { kind: 'hang', shortTimeout: true }; await rejects({}, 'dsh-timeout');
    });
    await check('real image handler plus collector and AES wrapper return full protected raster', async () => {
      mode = { kind: 'attachment' };
      vm.runInContext(['clientWantsE2ee', 'wrapEncryptedResponse', 'e2eeWrap'].map(name => extractFunction(source, name)).join('\n'), context);
      const handler = attachment.createDshLiteAttachment({ callUpstream: context.callDshLiteUpstream, resolveRuntime: async () => runtime });
      const wrapped = context.e2eeWrap(handler), keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
      const encrypted = e2ee.encrypt(keys.a, Buffer.from(JSON.stringify({ sessionId: 'synthetic-session', attachmentId: imageId })));
      const req = Readable.from([encrypted]); req.method = 'POST'; req.url = ROUTE; req.socket = {};
      req.headers = { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', 'content-type': 'application/octet-stream' };
      const result = await new Promise((resolve, reject) => {
        const res = { destroyed: false, writableEnded: false, headersSent: false,
          writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, getHeader() { return null; },
          end(body) { this.writableEnded = true; resolve({ status: this.status, headers: this.headers, body }); },
          destroy() { this.destroyed = true; reject(Error('encrypted response refused')); } };
        wrapped(req, res);
      });
      assert.equal(result.status, 200); assert.equal(result.headers['content-type'], 'application/octet-stream');
      assert.equal(result.headers['x-dsh-e2ee-type'], 'image/png'); assert.equal(result.headers['x-dsh-e2ee'], '1');
      assert.equal(result.headers['cache-control'], 'no-store'); assert(!result.body.includes(png));
      assert.deepEqual(e2ee.decrypt(keys.b, result.body), png);
    });
    await check('image dispatcher is exact, encrypted and follows actual auth/device/proof gate', () => {
      const inner = source.indexOf('function handleRequestInner('), dispatch = source.indexOf("if (u.pathname === '" + ROUTE + "')", inner);
      const proof = source.indexOf('authProvenAt(dev.device.id)', inner);
      assert(proof > inner && dispatch > proof);
      assert.match(source.slice(dispatch, dispatch + 170), /serveDshLiteAttachmentE2ee\(req, res\)/);
      assert.match(source, /const serveDshLiteAttachmentE2ee = e2eeWrap\(dshLiteAttachment\.createDshLiteAttachment\(/);
      const content = source.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/); assert(content);
      const paths = [...content[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
      assert.equal(paths.filter(value => value === ROUTE).length, 1);
    });
  } finally { await close(server); }
  console.log('DSH attachment gateway: ' + checks + ' isolated HTTP/encryption checks passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
