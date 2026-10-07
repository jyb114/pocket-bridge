'use strict';
// Owned D/temp files, subprocesses and loopback HTTP only. No gateway service,
// native app, production configuration, real key, account or tunnel is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), http = require('node:http'), vm = require('node:vm');
const { Readable } = require('node:stream');
const { spawnSync, fork } = require('node:child_process');
const replay = require('./replay-store.js'), e2ee = require('./e2ee.js');
const { WsCrypto } = require('./ws-crypt.js'), frames = require('./ws-frame.js');
const { extractFunction } = require('./page-source.js');
const SECRET = 'synthetic-replay-secret-0123456789', SECOND = 'synthetic-other-key-9876543210';
const PRIVATE = 'Synthetic content that must not appear in receipts';
function encrypted(secret, text, slot = e2ee.slotAt(), iv) {
  if (!iv) return e2ee.encrypt(e2ee.deriveKeys(secret, slot).a, text);
  const cipher = crypto.createCipheriv('aes-256-gcm', e2ee.deriveKeys(secret, slot).a, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
if (process.argv[2] === '--child') {
  const input = JSON.parse(process.argv[3]);
  const run = () => e2ee.openIncoming(SECRET, Buffer.from(input.packet, 'base64'), { store: new replay.ReplayStore({ file: input.file }) });
  const safe = result => ({ ok: result.ok, code: result.code || null });
  if (process.send) { process.send({ ready: true }); process.once('message', () => { process.send(safe(run())); process.disconnect(); }); }
  else process.stdout.write(JSON.stringify(safe(run())));
} else {
  let checks = 0;
  const parent = process.platform === 'win32' && fs.existsSync('D:\\桥') ? 'D:\\桥\\security-fixtures-preview10' : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'replay-admission-'));
  const file = label => path.join(root, label + '.jsonl');
  const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
  const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  function disk(store) { return fs.readFileSync(store.file, 'utf8'); }
  function child(target, packet) {
    const result = spawnSync(process.execPath, [__filename, '--child', JSON.stringify({ file: target, packet: packet.toString('base64') })], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  }
  async function concurrent(target, packet) {
    const packets = Array.isArray(packet) ? packet : [packet, packet];
    const children = packets.map(bytes => fork(__filename, ['--child', JSON.stringify({ file: target, packet: bytes.toString('base64') })], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    let timer;
    try {
      await Promise.race([Promise.all(children.map(c => new Promise((resolve, reject) => { c.once('message', message => { assert.equal(message.ready, true); resolve(); }); c.once('error', reject); }))), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned child readiness timeout')), 10000); })]);
      clearTimeout(timer);
      const results = await Promise.race([Promise.all(children.map(c => new Promise((resolve, reject) => { c.once('message', resolve); c.once('error', reject); c.send({ go: true }); }))), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned child admission timeout')), 10000); })]);
      clearTimeout(timer);
      await Promise.all(children.map(c => new Promise(resolve => c.exitCode !== null ? resolve() : c.once('exit', resolve)))); return results;
    } finally { clearTimeout(timer); for (const c of children) if (c.exitCode === null) c.kill(); }
  }
  function controlledClock(start, options = {}) {
    let now = start;
    const target = file('clock-' + crypto.randomBytes(4).toString('hex'));
    return { store: new replay.ReplayStore({ file: target, clock: () => now, ...options }), set: value => { now = value; }, target };
  }
  function corruptFixture(label, mutation) {
    const store = new replay.ReplayStore({ file: file(label) });
    const packet = encrypted(SECRET, PRIVATE); assert.equal(e2ee.openIncoming(SECRET, packet, { store }).ok, true);
    mutation(store); return e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: new replay.ReplayStore({ file: store.file }) });
  }
  (async () => {
    const persistentFile = file('restart'), packet = encrypted(SECRET, PRIVATE);
    check('fresh authenticated frame is durably admitted in an actual process', () => assert.equal(child(persistentFile, packet).ok, true));
    check('fresh second process rejects the same ciphertext after restart', () => assert.equal(child(persistentFile, packet).code, 'replayed-request'));
    check('same plaintext with a fresh IV is admitted', () => assert.equal(child(persistentFile, encrypted(SECRET, PRIVATE)).ok, true));
    check('journal contains neither secret nor prompt nor proof response', () => { const text = fs.readFileSync(persistentFile, 'utf8'); assert(!text.includes(SECRET)); assert(!text.includes(PRIVATE)); assert(!text.includes(packet.toString('base64'))); });
    const store = new replay.ReplayStore({ file: file('scope') }), iv = crypto.randomBytes(12);
    check('identical IV in another derived long-term-key scope is independent', () => { assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE, undefined, iv), { store }).ok); assert(e2ee.openIncoming(SECOND, encrypted(SECOND, PRIVATE, undefined, iv), { store }).ok); });
    check('derived slots have independent nonce domains but each exact packet stays fenced', () => { const at = 10000 * e2ee.SLOT_MS + 1000, timed = controlledClock(at), sameIv = crypto.randomBytes(12); const current = encrypted(SECRET, PRIVATE, e2ee.slotAt(at), sameIv), prior = encrypted(SECRET, PRIVATE, e2ee.slotAt(at)-1, sameIv); assert(e2ee.openIncoming(SECRET,current,{store:timed.store,now:at}).ok); assert(e2ee.openIncoming(SECRET,prior,{store:timed.store,now:at}).ok); assert.equal(e2ee.openIncoming(SECRET,prior,{store:timed.store,now:at}).code,'replayed-request'); });
    check('tampered ciphertext does not create storage or consume an IV', () => { const badStore = new replay.ReplayStore({ file: file('tampered') }); const bad = Buffer.from(packet); bad[bad.length - 1] ^= 1; assert.equal(e2ee.openIncoming(SECRET, bad, { store: badStore }).code, 'invalid-ciphertext'); assert(!fs.existsSync(badStore.file)); });
    check('plaintext is rejected before persistent admission', () => assert.equal(e2ee.openIncoming(SECRET, Buffer.from(PRIVATE), { store }).code, 'invalid-ciphertext'));
    check('client cannot authenticate with the server-to-phone key', () => assert.equal(e2ee.openIncoming(SECRET, e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, PRIVATE), { store }).code, 'invalid-ciphertext'));
    const start = 10000 * e2ee.SLOT_MS + 1000, timed = controlledClock(start);
    const priorPacket = encrypted(SECRET, PRIVATE, e2ee.slotAt(start) - 1);
    check('previous derived slot is admitted and remains remembered beyond ten minutes', () => { assert(e2ee.openIncoming(SECRET, priorPacket, { store: timed.store, now: start }).ok); timed.set(start + 11 * 60000); assert.equal(e2ee.openIncoming(SECRET, priorPacket, { store: timed.store, now: start + 11 * 60000 }).code, 'replayed-request'); });
    check('a ciphertext outside current/previous slots fails authentication', () => { timed.set(start + e2ee.SLOT_MS); assert.equal(e2ee.openIncoming(SECRET, priorPacket, { store: timed.store, now: start + e2ee.SLOT_MS }).code, 'invalid-ciphertext'); });
    const clock = controlledClock(start);
    check('clock watermark persists across a normal store restart', () => { assert(clock.store.consume(replay.scopeOf(SECRET), 'proof:one', start + 10000).ok); clock.set(start + 1000); assert(clock.store.consume(replay.scopeOf(SECRET), 'proof:two', start + 10000).ok); const next = new replay.ReplayStore({ file: clock.target, clock: () => start }); assert.equal(next.consume(replay.scopeOf(SECRET), 'proof:three', start + 10000).code, 'replay-clock-rollback'); });
    const capacity = controlledClock(start, { maxEntries: 2, maxPerScope: 2 });
    check('capacity never evicts a still-valid oldest receipt', () => { const scope = replay.scopeOf(SECRET); assert(capacity.store.consume(scope, 'proof:a', start + 10000).ok); assert(capacity.store.consume(scope, 'proof:b', start + 10000).ok); assert.equal(capacity.store.consume(scope, 'proof:c', start + 10000).code, 'replay-capacity'); assert.equal(capacity.store.consume(scope, 'proof:a', start + 10000).code, 'replayed-request'); });
    check('only expired receipts compact, while the watermark survives', () => { capacity.set(start + 10001); assert(capacity.store.consume(replay.scopeOf(SECRET), 'proof:c', start + 20000).ok); assert(disk(capacity.store).split('\n').length <= 3); const back = new replay.ReplayStore({ file: capacity.target, clock: () => start }); assert.equal(back.consume(replay.scopeOf(SECRET), 'proof:d', start + 10000).code, 'replay-clock-rollback'); });
    check('per-key and active-key-scope capacity are both bounded', () => { const bounded = controlledClock(start, { maxPerScope: 1, maxScopes: 1 }); assert(bounded.store.consume(replay.scopeOf(SECRET), 'proof:one', start + 1000).ok); assert.equal(bounded.store.consume(replay.scopeOf(SECRET), 'proof:two', start + 1000).code, 'replay-capacity'); assert.equal(bounded.store.consume(replay.scopeOf(SECOND), 'proof:one', start + 1000).code, 'replay-capacity'); });
    check('byte capacity refuses growth without truncating valid receipts', () => { const bounded = controlledClock(start, { maxBytes: 400 }); const scope = replay.scopeOf(SECRET); assert(bounded.store.consume(scope, 'proof:first', start + 10000).ok); assert.equal(bounded.store.consume(scope, 'proof:second', start + 10000).code, 'replay-capacity'); assert(fs.statSync(bounded.target).size <= 400); assert.equal(bounded.store.consume(scope, 'proof:first', start + 10000).code, 'replayed-request'); });
    check('truncated journal refuses fresh requests', () => assert.match(corruptFixture('truncated', s => fs.truncateSync(s.file, fs.statSync(s.file).size - 1)).code, /^replay-store-/));
    check('complete-record truncation cannot silently restore an old valid chain', () => assert.equal(corruptFixture('whole-record-truncated', s => { const bytes = Buffer.from(disk(s).split('\n')[0] + '\n'); fs.writeFileSync(s.file, bytes); }).code, 'replay-store-corrupt'));
    check('a stale checkpoint cannot approve an appended but uncommitted receipt', () => { const target = file('stale-checkpoint'), s = new replay.ReplayStore({ file: target }); assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: s }).ok); const checkpoint = fs.readFileSync(s.marker); assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: s }).ok); fs.writeFileSync(s.marker, checkpoint); assert.equal(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: new replay.ReplayStore({ file: target }) }).code, 'replay-store-corrupt'); });
    check('modified receipt checksum refuses fresh requests', () => assert.match(corruptFixture('corrupt', s => { const text = disk(s); fs.writeFileSync(s.file, text.replace('body:', 'b0dy:')); }).code, /^replay-store-/));
    check('deleted initialized journal is not silently recreated', () => assert.match(corruptFixture('deleted', s => fs.unlinkSync(s.file)).code, /^replay-store-/));
    check('deleted initialization marker is not silently regenerated', () => assert.match(corruptFixture('marker', s => fs.unlinkSync(s.marker)).code, /^replay-store-/));
    check('oversized journal refuses before decoding it', () => assert.match(corruptFixture('oversized', s => { fs.truncateSync(s.file, replay.MAX_BYTES + 1); }).code, /^replay-store-/));
    check('a leftover crash/concurrent lock is refused without takeover', () => { const s = new replay.ReplayStore({ file: file('locked') }); fs.mkdirSync(s.lock); assert.equal(e2ee.openIncoming(SECRET, packet, { store: s }).code, 'replay-store-busy'); assert(fs.existsSync(s.lock)); assert(!fs.existsSync(s.file)); });
    check('read failure never falls back to empty in-memory receipts', () => { const target = file('read-failure'), s = new replay.ReplayStore({ file: target }); assert(e2ee.openIncoming(SECRET, packet, { store: s }).ok); const failing = new replay.ReplayStore({ file: target, fs: { ...fs, readFileSync() { throw Object.assign(Error('Synthetic read failure'), { code: 'EACCES' }); } } }); assert.equal(e2ee.openIncoming(SECRET, packet, { store: failing }).ok, false); assert.equal(e2ee.openIncoming(SECRET, packet, { store: new replay.ReplayStore({ file: target }) }).code, 'replayed-request'); });
    check('write failure refuses admission, then a genuinely unsent packet can retry', () => { const target = file('write-failure'), s = new replay.ReplayStore({ file: target }); assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: s }).ok); const next = encrypted(SECRET, PRIVATE), failing = new replay.ReplayStore({ file: target, fs: { ...fs, writeSync() { throw Object.assign(Error('Synthetic write failure'), { code: 'EIO' }); } } }); assert.equal(e2ee.openIncoming(SECRET, next, { store: failing }).ok, false); assert(e2ee.openIncoming(SECRET, next, { store: new replay.ReplayStore({ file: target }) }).ok); });
    check('journal fsync failure never returns success or admits an ambiguous nonce again', () => { const target = file('fsync-failure'), s = new replay.ReplayStore({ file: target }); assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: s }).ok); const next = encrypted(SECRET, PRIVATE), failing = new replay.ReplayStore({ file: target, fs: { ...fs, fsyncSync() { throw Object.assign(Error('Synthetic fsync failure'), { code: 'EIO' }); } } }); assert.equal(e2ee.openIncoming(SECRET, next, { store: failing }).ok, false); assert.equal(e2ee.openIncoming(SECRET, next, { store: new replay.ReplayStore({ file: target }) }).code, 'replay-store-corrupt'); });
    check('checkpoint commit failure fences both the written packet and fresh packets', () => { const target = file('checkpoint-failure'), s = new replay.ReplayStore({ file: target }); assert(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: s }).ok); const next = encrypted(SECRET, PRIVATE), failing = new replay.ReplayStore({ file: target, fs: { ...fs, renameSync(from, to) { if (to === s.marker) throw Object.assign(Error('Synthetic checkpoint failure'), { code: 'EIO' }); return fs.renameSync(from, to); } } }); assert.equal(e2ee.openIncoming(SECRET, next, { store: failing }).ok, false); const reopened = new replay.ReplayStore({ file: target }); assert.equal(e2ee.openIncoming(SECRET, next, { store: reopened }).code, 'replay-store-corrupt'); assert.equal(e2ee.openIncoming(SECRET, encrypted(SECRET, PRIVATE), { store: reopened }).code, 'replay-store-corrupt'); });
    check('lock-release failure cannot falsely report successful dispatch admission', () => { const target = file('lock-release'), s = new replay.ReplayStore({ file: target, fs: { ...fs, rmdirSync() { throw Object.assign(Error('Synthetic lock release failure'), { code: 'EACCES' }); } } }); assert.equal(e2ee.openIncoming(SECRET, packet, { store: s }).code, 'replay-store-lock-unavailable'); assert(fs.existsSync(s.lock)); assert.equal(e2ee.openIncoming(SECRET, packet, { store: new replay.ReplayStore({ file: target }) }).code, 'replay-store-busy'); });
    check('a linked owned ledger parent is refused without touching its destination', () => { const destination = path.join(root, 'link-destination'), linked = path.join(root, 'linked-parent'); fs.mkdirSync(destination); fs.symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir'); const s = new replay.ReplayStore({ file: path.join(linked, 'ledger.jsonl') }); assert.equal(e2ee.openIncoming(SECRET, packet, { store: s }).code, 'replay-store-linked'); assert.deepEqual(fs.readdirSync(destination), []); });
    check('HTTP and reconnecting WS share one inbound IV admission scope', () => { const s = new replay.ReplayStore({ file: file('http-ws') }), body = encrypted(SECRET, PRIVATE); assert(e2ee.openIncoming(SECRET, body, { store: s }).ok); const ws = new WsCrypto(SECRET, 'decrypt', { store: new replay.ReplayStore({ file: s.file }) }); assert.equal(ws.push(frames.buildFrame(frames.OP_BIN, body, true)).length, 0); assert.equal(ws.replayed, 1); });
    check('downstream token encryption performs no receipt writes', () => { const s = new replay.ReplayStore({ file: file('downstream') }), ws = new WsCrypto(SECRET, 'encrypt', { store: s }); for (let i = 0; i < 100; i++) assert(ws.push(frames.buildFrame(frames.OP_TEXT, Buffer.from(PRIVATE), false)).length); assert(!fs.existsSync(s.file)); });
    const race = await concurrent(file('two-processes'), encrypted(SECRET, PRIVATE));
    check('two actual processes admit one exact ciphertext at most once', () => { assert.equal(race.filter(r => r.ok).length, 1); assert(['replayed-request', 'replay-store-busy'].includes(race.find(r => !r.ok).code)); });
    const distinctFile = file('distinct-processes'), distinctPackets = [encrypted(SECRET, 'one'), encrypted(SECRET, 'two')], distinct = await concurrent(distinctFile, distinctPackets);
    check('concurrent distinct processes keep all committed receipts without lost updates', () => { for (let i = 0; i < distinct.length; i++) { if (!distinct[i].ok) { assert.equal(distinct[i].code, 'replay-store-busy'); assert.equal(child(distinctFile, distinctPackets[i]).ok, true); } } for (const bytes of distinctPackets) assert.equal(child(distinctFile, bytes).code, 'replayed-request'); });

    // Actual production functions, synthetic key and owned HTTP request stream.
    let activeStore = new replay.ReplayStore({ file: file('http') }), dispatched = 0;
    const context = vm.createContext({ Buffer, URL, Readable, crypto,
      privateHttpsAdmission: require('./private-https-admission.js'),
      e2ee: { ...e2ee, openIncoming(secret, bytes) { return e2ee.openIncoming(secret, bytes, { store: activeStore }); } },
      e2eeSecretOrNull: () => SECRET, log() {}, MAX_E2EE_BODY: 1024 * 1024,
      clientWantsE2ee: req => req.headers['x-dsh-e2ee'] === '1', refuseEncryptionUnavailable() { assert.fail('Key unexpectedly unavailable'); } });
    vm.runInContext(extractFunction(source, 'wrapEncryptedResponse') + '\n' + extractFunction(source, 'e2eeWrap'), context);
    const wrapped = context.e2eeWrap((req, res) => { dispatched++; const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: PRIVATE, received: Buffer.concat(parts).toString() })); }); });
    const server = http.createServer((req, res) => { req.__dshRequireE2ee = true; wrapped(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (bytes, method = 'POST') => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/__dsh/lite-rpc', method, headers: { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json' } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }); req.on('error', reject); req.end(bytes); });
    try {
      const httpPacket = encrypted(SECRET, JSON.stringify({ prompt: PRIVATE })), first = await request(httpPacket);
      check('durable HTTP admission precedes actual handler dispatch and response stays encrypted', () => { assert.equal(first.status, 200); assert.equal(dispatched, 1); assert.equal(first.headers['x-dsh-e2ee'], '1'); assert(!first.body.includes(Buffer.from(PRIVATE))); assert(e2ee.decrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).b, first.body)); });
      activeStore = new replay.ReplayStore({ file: activeStore.file }); const repeat = await request(httpPacket);
      check('HTTP replay after store restart returns409 without another dispatch or resend advice', () => { assert.equal(repeat.status, 409); assert.equal(dispatched, 1); const result = JSON.parse(repeat.body); assert.equal(result.code, 'replayed-request'); assert.equal(result.originalOutcomeUnknown, true); assert.equal(result.attemptDispatched, false); });
      const empty = await request(Buffer.alloc(0));
      check('empty protected mutation cannot claim decryption success', () => { assert.equal(empty.status, 400); assert.equal(JSON.parse(empty.body).code, 'encrypted-body-required'); assert.equal(dispatched, 1); });
      const read = await request(Buffer.alloc(0), 'GET');
      check('bodyless readonly response remains encrypted', () => { assert.equal(read.status, 200); assert.equal(read.headers['x-dsh-e2ee'], '1'); assert(!read.body.includes(Buffer.from(PRIVATE))); });
      fs.writeFileSync(activeStore.file, 'broken\n'); const denied = await request(encrypted(SECRET, PRIVATE));
      check('persistent HTTP corruption returns identifiable503 without handler execution or false prior-unsent proof', () => { assert.equal(denied.status, 503); const result=JSON.parse(denied.body); assert.match(result.code, /^replay-store-/); assert.equal(result.attemptDispatched,false); assert.equal(result.originalOutcomeUnknown,true); assert.equal(dispatched, 2); assert(!denied.body.includes(Buffer.from(SECRET))); });
    } finally { await new Promise(resolve => server.close(resolve)); }

    let proofStore = new replay.ReplayStore({ file: file('proof') });
    const proof = vm.createContext({ Buffer, crypto, Date,
      AUTH_TS_SKEW_MS: 5 * 60000, AUTH_USED_NONCE_TTL_MS: 15 * 60000,
      e2eeBridge: { readSecret: () => SECRET }, require,
      replayAdmission: { scopeOf: replay.scopeOf, get defaultStore() { return proofStore; } } });
    vm.runInContext(extractFunction(source, 'authKeyOf') + '\n' + extractFunction(source, 'verifyOneShotProof'), proof);
    const ts = Date.now(), nonce = 'synthetic-proof-nonce-0123456789';
    const response = crypto.createHmac('sha256', proof.authKeyOf(SECRET)).update(`${ts}|${nonce}`).digest('base64url');
    check('actual one-shot proof commits only after HMAC verification', () => { assert.equal(proof.verifyOneShotProof(ts, nonce, 'bad').ok, false); assert(!fs.existsSync(proofStore.file)); assert.equal(proof.verifyOneShotProof(ts, nonce, response).ok, true); });
    check('one-shot proof replay stays rejected after a new store instance', () => { proofStore = new replay.ReplayStore({ file: proofStore.file }); assert.equal(proof.verifyOneShotProof(ts, nonce, response).code, 'replayed'); });
    check('stale timestamp and bounded nonce refuse before writing', () => { assert.equal(proof.verifyOneShotProof(ts - 6 * 60000, nonce, response).code, 'stale-ts'); assert.equal(proof.verifyOneShotProof(ts, 'x'.repeat(257), response).code, 'bad-nonce'); const text = disk(proofStore); assert(!text.includes(nonce)); assert(!text.includes(response)); });
    console.log(`Persistent replay checks passed (${checks})`);
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(parent) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true });
  });
}
