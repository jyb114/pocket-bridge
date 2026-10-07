'use strict';
require('./replay-isolated-fixture.js').install();
// Actual isolated gateway upgrade function, HTTP/TCP sockets and AES bridge.
// No live gateway, app process, account, model or tunnel is accessed.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), net = require('net');
const { extractFunction } = require('./page-source.js');
const bridge = require('./ws-e2ee-bridge.js'), e2ee = require('./e2ee.js'), frames = require('./ws-frame.js');
const { WsCrypto, MAX_FRAME_BYTES, MAX_BUFFER_BYTES, MAX_FRAMES_PER_BATCH } = require('./ws-crypt.js');
const origin = require('./request-origin.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const SECRET = 'isolated-upgrade-failclosed-0123456789', PRIVATE = 'PRIVATE_SYNTHETIC_UPSTREAM_CONTENT';
const GOOD = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
let mode = 'valid', checks = 0, starts = 0, closeCalls = 0;
let attackWire = Buffer.alloc(0);
const logs = [], upstreamWire = [], owned = new Set();
function own(socket) { owned.add(socket); socket.once('close', () => owned.delete(socket)); socket.on('error', () => {}); return socket; }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function check(name, fn) { return Promise.resolve().then(fn).then(() => { checks++; console.log('PASS ' + name); }); }
(async () => {
  const upstream = net.createServer(socket => {
    own(socket); let header = Buffer.alloc(0), ready = false;
    socket.on('data', chunk => {
      upstreamWire.push(chunk);
      if (ready) {
        if (mode === 'controlClient') socket.end(frames.buildFrame(frames.OP_TEXT, Buffer.from(PRIVATE), false));
        return;
      }
      header = Buffer.concat([header, chunk]); const end = header.indexOf('\r\n\r\n'); if (end < 0) return;
      ready = true;
      if (mode === 'oversized') socket.end(Buffer.from('HTTP/1.1 ' + PRIVATE + 'x'.repeat(8300)));
      else if (mode === 'not101') socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' + PRIVATE);
      else if (mode === 'badHeaders') socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: invalid\r\n\r\n' + PRIVATE);
      else if (mode === 'split') {
        socket.write(GOOD.slice(0, 18)); setTimeout(() => socket.end(Buffer.concat([Buffer.from(GOOD.slice(18)), frames.buildFrame(frames.OP_TEXT, Buffer.from(PRIVATE), false)])), 5);
      } else if (mode === 'clientThrows') socket.write(GOOD);
      else if (mode === 'framingClient' || mode === 'controlClient') socket.write(GOOD);
      else if (mode === 'framingServer') socket.end(Buffer.concat([Buffer.from(GOOD), attackWire]));
      else socket.end(Buffer.concat([Buffer.from(GOOD), frames.buildFrame(frames.OP_TEXT, Buffer.from(PRIVATE), false)]));
    });
  });
  const targetPort = await listen(upstream);
  const context = vm.createContext({ Buffer, URL, net, process: { env: {} },
    privateHttpsAdmission: require('./private-https-admission.js'), cfg: { loadConfig: () => ({ privateHttps: { enabled: false, origin: '' } }) },
    retiredTargets: require('./retired-targets.js'), dshPhoneSurface: require('./dsh-phone-surface.js'),
    isLocalRequest: origin.isLoopback, hasAuthCookie: () => true, ensureDevice: () => ({ ok: true, device: null }),
    e2eeSecretOrNull: () => SECRET, EXPLICIT_TARGET_PORT: targetPort, TARGET_PORT: targetPort, TARGET_HOST: '127.0.0.1',
    buildUpstreamHeaders: req => req.headers, log: text => logs.push(String(text)), markActivity() {},
    ensureDshRunning: async () => { starts++; return false; },
    e2eeBridge: { readSecret: () => SECRET, wanted: bridge.wanted, attach(secret) {
      if (mode === 'attachThrows') throw Error(PRIVATE);
      if (mode === 'unsafeErrorCode') throw Object.assign(Error(PRIVATE), { code: PRIVATE });
      if (mode === 'safeErrorCode') throw Object.assign(Error(PRIVATE), { code: 'replay-store-corrupt' });
      if (['headThrows', 'clientThrows', 'upstreamThrows', 'nonBuffer'].includes(mode)) return {
        fromClient() { throw Error(PRIVATE); },
        fromUpstream(chunk) { if (mode === 'clientThrows') return chunk; if (mode === 'nonBuffer') return undefined; throw Error(PRIVATE); },
        close() { closeCalls++; }, stats: () => ({})
      };
      return bridge.attach(secret);
    } }
  });
  vm.runInContext(extractFunction(source, 'handleUpgrade'), context);
  const gateway = http.createServer(); gateway.on('connection', own);
  gateway.on('upgrade', (req, socket, head) => context.handleUpgrade(req, socket, head));
  const port = await listen(gateway);
  async function get(extra = Buffer.alloc(0)) {
    return await new Promise((resolve, reject) => {
      const socket = own(net.connect({ host: '127.0.0.1', port })), chunks = []; let sentClient = false;
      socket.setTimeout(3000, () => socket.destroy(Error('isolated WS refusal timeout')));
      socket.on('connect', () => socket.write(Buffer.concat([Buffer.from('GET /api/remote.mux?e2ee=1 HTTP/1.1\r\nHost: public.fixture.invalid\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'), extra])));
      socket.on('data', chunk => {
        chunks.push(chunk);
        if (mode === 'clientThrows' && !sentClient && Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) {
          sentClient = true; socket.write(Buffer.from(PRIVATE));
        }
        if ((mode === 'framingClient' || mode === 'controlClient') && !sentClient && Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) {
          sentClient = true; socket.write(attackWire);
        }
      });
      socket.on('error', error => { if (error.message.includes('timeout')) reject(error); });
      socket.on('close', () => resolve(Buffer.concat(chunks)));
    });
  }
  try {
    for (const kind of ['valid', 'split']) await check('valid ' + kind + ' handshake keeps the complete content encrypted', async () => {
      mode = kind; const wire = await get(), end = wire.indexOf('\r\n\r\n');
      assert(end > 0); assert.equal(wire.subarray(0, end + 4).toString(), GOOD);
      assert(!wire.includes(Buffer.from(PRIVATE)));
      const parsed = frames.parseFrames(wire.subarray(end + 4)); assert.equal(parsed.rest.length, 0); assert.equal(parsed.frames.length, 1);
      assert.equal(parsed.frames[0].opcode, frames.OP_BIN);
      assert.equal(e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, parsed.frames[0].payload).toString(), PRIVATE);
    });
    for (const kind of ['oversized', 'not101', 'badHeaders']) await check('actual malformed/non-upgrade upstream never escapes as plaintext: ' + kind, async () => {
      mode = kind; const wire = await get(); assert.equal(wire.length, 0); assert(!wire.includes(Buffer.from(PRIVATE)));
    });
    for (const kind of ['attachThrows', 'unsafeErrorCode', 'safeErrorCode', 'upstreamThrows', 'nonBuffer']) await check('transform refusal closes only its owned pair without fallback: ' + kind, async () => {
      mode = kind; const wire = await get(); assert.equal(wire.length, 0);
    });
    await check('coalesced client head transform failure never forwards private head bytes', async () => {
      mode = 'headThrows'; upstreamWire.length = 0; const wire = await get(Buffer.from(PRIVATE));
      assert.equal(wire.length, 0); assert(!Buffer.concat(upstreamWire).includes(Buffer.from(PRIVATE)));
    });
    await check('late client transform failure terminates without forwarding private data', async () => {
      mode = 'clientThrows'; upstreamWire.length = 0; const wire = await get(); assert.equal(wire.toString(), GOOD);
      assert(!Buffer.concat(upstreamWire).includes(Buffer.from(PRIVATE)));
    });
    const advertised = count => { const out = Buffer.alloc(10); out[0] = 0x82; out[1] = 0x7f; out.writeBigUInt64BE(BigInt(count), 2); return out; };
    const encryptedFrame = () => frames.buildFrame(frames.OP_BIN, e2ee.encrypt(e2ee.deriveKeys(SECRET,e2ee.slotAt()).a, PRIVATE), true);
    const changedHeader = change => { const out = encryptedFrame(); out[0] = change(out[0]); return out; };
    const attacks = [
      ['reserved data opcode', () => frames.buildFrame(0x3, Buffer.from(PRIVATE), true)],
      ['reserved control opcode', () => frames.buildFrame(0xb, Buffer.from(PRIVATE), true)],
      ['nonfinal authenticated data', () => changedHeader(value => value & 0x7f)],
      ['continuation data', () => frames.buildFrame(frames.OP_CONT, Buffer.from(PRIVATE), true)],
      ['reserved-bit authenticated data', () => changedHeader(value => value | 0x40)],
      ['fragmented ping', () => { const out = frames.buildFrame(frames.OP_PING, Buffer.from(PRIVATE), true); out[0] &= 0x7f; return out; }],
      ['oversized ping', () => frames.buildFrame(frames.OP_PING, Buffer.alloc(126, 0x61), true)],
      ['one-byte close', () => frames.buildFrame(frames.OP_CLOSE, Buffer.from([0x03]), true)],
      ['reserved close code', () => frames.buildFrame(frames.OP_CLOSE, Buffer.from([0x03,0xed]), true)],
      ['invalid UTF-8 close reason', () => frames.buildFrame(frames.OP_CLOSE, Buffer.from([0x03,0xe8,0xff]), true)],
      ['huge advertised frame without a body', () => advertised(1024 * 1024 * 1024)],
      ['unsafe 64-bit advertised length', () => advertised(0xffffffffffffffffn)],
      ['one byte above explicit frame cap', () => advertised(MAX_FRAME_BYTES + 1)],
      ['nonminimal 16-bit payload length', () => Buffer.from([0x82,0xfe,0,1,0,0,0,0,0x61])],
      ['nonminimal 64-bit payload length', () => advertised(65535)],
      ['plaintext application frame', () => frames.buildFrame(frames.OP_TEXT, Buffer.from(PRIVATE), true)],
      ['coalesced control-frame flood', () => Buffer.concat(Array.from({length:MAX_FRAMES_PER_BATCH+1}, () => frames.buildFrame(frames.OP_PING, Buffer.alloc(0), true)))]
    ];
    function upstreamApplicationFrames() {
      const wire = Buffer.concat(upstreamWire), end = wire.indexOf('\r\n\r\n');
      return end < 0 ? [] : frames.parseFrames(wire.subarray(end+4)).frames;
    }
    for (const [label, create] of attacks) await check('actual client framing refusal closes without an upstream application action: ' + label, async () => {
      mode='framingClient'; attackWire=create(); upstreamWire.length=0;
      const wire=await get(); assert.equal(wire.toString(),GOOD); assert.equal(upstreamApplicationFrames().length,0);
      assert(!wire.includes(Buffer.from(PRIVATE)));
    });
    for (const [label, create] of attacks.filter(([label]) => label!=='plaintext application frame')) await check('actual malformed upstream closes without plaintext or normalized data: ' + label, async () => {
      mode='framingServer'; attackWire=create(); const wire=await get(); assert.equal(wire.length,0); assert(!wire.includes(Buffer.from(PRIVATE)));
    });
    for (const opcode of [frames.OP_PING,frames.OP_PONG,frames.OP_CLOSE]) await check('actual legitimate control retains opcode/payload while application data remains encrypted: '+opcode, async () => {
      mode='controlClient'; attackWire=frames.buildFrame(opcode,opcode===frames.OP_CLOSE?Buffer.from([0x03,0xe8]):Buffer.from('status-check'),true); upstreamWire.length=0;
      const wire=await get(), end=wire.indexOf('\r\n\r\n'), parsed=frames.parseFrames(wire.subarray(end+4));
      assert.equal(parsed.frames.length,1); assert.equal(parsed.frames[0].opcode,frames.OP_BIN); assert(!wire.includes(Buffer.from(PRIVATE)));
      const forwarded=upstreamApplicationFrames(); assert.equal(forwarded.length,1); assert.equal(forwarded[0].opcode,opcode); assert.deepEqual(forwarded[0].payload,frames.parseFrames(attackWire).frames[0].payload);
    });
    await check('buffer bounds refuse before concatenation and cannot be reopened', () => {
      const up=new WsCrypto(SECRET,'decrypt'); const header=advertised(MAX_FRAME_BYTES); assert.equal(up.push(header).length,0);
      assert.equal(up.push(Buffer.alloc(MAX_BUFFER_BYTES)).length,0); assert.equal(up.buf.length,0); assert.equal(up.lastFailureCode,'ws-buffer-too-large');
      assert.equal(up.push(encryptedFrame()).length,0);
    });
    await check('exact encrypted frame boundary is accepted and one-byte larger is refused', () => {
      const body=e2ee.encrypt(e2ee.deriveKeys(SECRET,e2ee.slotAt()).a,Buffer.alloc(MAX_FRAME_BYTES-28,0x61));
      const up=new WsCrypto(SECRET,'decrypt'), output=up.push(frames.buildFrame(frames.OP_BIN,body,true));
      assert.equal(frames.parseFrames(output).frames[0].payload.length,MAX_FRAME_BYTES-28);
      const rejected=new WsCrypto(SECRET,'decrypt'); assert.equal(rejected.push(advertised(MAX_FRAME_BYTES+1)).length,0); assert.equal(rejected.lastFailureCode,'ws-frame-too-large');
    });
    await check('exceptions log no private body and never start or stop an application', () => {
      assert(!logs.some(line => line.includes(PRIVATE))); assert(logs.some(line => line.includes('owned sockets closed')));
      const refusals=logs.filter(line=>line.includes('owned sockets closed'));
      assert(refusals.some(line=>line.endsWith('(ws-encrypted-stream-refused)')));
      for(const code of ['replay-store-corrupt','ws-frame-invalid','ws-fragmentation-unsupported','invalid-ciphertext'])
        assert(refusals.some(line=>line.endsWith('('+code+')')),code);
      assert(refusals.every(line=>/^WS encrypted channel refused an invalid stream; owned sockets closed \((?:ws-[a-z-]+|invalid-ciphertext|replayed-request|replay-[a-z-]+)\)$/.test(line)));
      assert(closeCalls >= 4); assert.equal(starts, 0);
    });
    console.log(checks + ' actual isolated WS fail-closed gateway checks passed; no live runtime/native action.');
  } finally {
    for (const socket of owned) socket.destroy();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
