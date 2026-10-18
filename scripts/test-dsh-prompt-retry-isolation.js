'use strict';

// Actual browser adapter + RPC handler + owned persistent journal. Provider and
// browser APIs are fixtures; the provider deliberately has no deduplication.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createDshLiteRpc } = require('./dsh-lite-rpc');
const { createDshPromptState } = require('./dsh-prompt-state');
const { extractFunction } = require('./page-source');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pwa/dsh-lite-adapter.js'), 'utf8');
const output = path.resolve(root, '..', 'output'); fs.mkdirSync(output, { recursive: true });
const owned = fs.mkdtempSync(path.join(output, 'prompt-adapter-tests-'));
const flush = () => new Promise(resolve => setImmediate(resolve));
let serial = 0, checks = 0;
const input = (sessionId = 'A', text = 'Owned synthetic question', attachments) => ({ sessionId, text, attachments });
function fixture() {
  const state = createDshPromptState({ directory: path.join(owned, String(++serial)) });
  const context = { deviceId: 'owned-device-1234', runtimeId: 'owned-runtime-1', secret: 'owned-test-key-0123456789' };
  const requests = [], transport = [], held = [], faults = new Map(), upstreamModes = [];
  let proofs = 0;
  const handler = createDshLiteRpc({ promptState: state, promptContext: () => context,
    callUpstream: async call => {
      const wire = JSON.parse(call.body);
      assert.equal(wire.method, 'session/prompt');
      assert.deepEqual(Object.keys(wire.payload.args), ['request'], 'inspected 0.1.7 remote-mux argument form');
      requests.push(wire.payload.args.request);
      if (upstreamModes.shift() === 'disconnect') throw Error('Owned upstream disconnected');
      return { statusCode: 200, body: JSON.stringify({ rpcId: wire.rpcId,
        result: { ok: true, value: { accepted: true } } }) };
    } });
  async function invoke(init) {
    const packet = JSON.parse(init.body); transport.push(packet);
    const fault = (faults.get(packet.method) || []).shift();
    const req = Readable.from([init.body]); req.method = 'POST'; req.__dshE2eeDecrypted = true;
    req.headers = { 'content-type': 'application/json', 'x-dsh-e2ee': '1' };
    let status, body;
    await handler(req, { writeHead(value) { status = value; }, end(value) { body = value; this.writableEnded = true; } });
    const response = { status, ok: status === 200, json: async () => JSON.parse(body) };
    if (fault === 'lost') throw Error('Owned phone response lost');
    if (fault === '403') return { status: 403, ok: false, json: async () => ({}) };
    if (fault === 'hold') return new Promise(resolve => held.push(() => resolve(response)));
    return response;
  }
  function page(host = 'first-origin.invalid') {
    const runtime = { setTimeout, clearTimeout, crypto: { randomUUID: () => crypto.randomUUID() },
      location: { protocol: 'https:', host },
      document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
      __dshE2eeSecret: context.secret,
      DshE2EE: { available: () => true, prove: async () => { proofs++; return true; },
        encryptedFetch: async (_secret, _url, init) => invoke(init) } };
    runtime.window = runtime; vm.runInNewContext(source, runtime, { filename: 'pwa/dsh-lite-adapter.js' });
    return runtime.DshLiteAdapter;
  }
  return { state, context, requests, transport, held, page,
    faults(method, ...modes) { faults.set(method, modes); }, upstream(...modes) { upstreamModes.push(...modes); },
    get proofs() { return proofs; } };
}
async function check(name, run) { await run(fixture()); checks++; console.log('PASS ' + name); }
async function recovery(run) {
  try { await run(); assert.fail('Expected explicit recovery'); }
  catch (problem) { assert.equal(problem.code, 'prompt-recovery-required'); return problem; }
}
function loseAcceptedConfirmation(f) {
  f.faults('session/prompt', 'lost');
  f.faults('bridge/prompt-prepare', 'ok', 'lost');
}
async function run() {
  await check('positive receipts allow legitimate identical questions with distinct identities', async f => {
    const api = f.page(); await api.sendMessage(input()); await api.sendMessage(input());
    assert.equal(f.requests.length, 2); assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
    assert.equal((await api.listPromptOperations('A')).length, 0);
    assert.equal(f.transport.slice(0, 3).some(item => item.request.action === 'list'), false, 'normal send needs no preflight list');
  });
  await check('lost accepted response recovers after refresh/new origin without another dispatch', async f => {
    loseAcceptedConfirmation(f);
    assert.equal((await recovery(() => f.page().sendMessage(input()))).operations[0].state, 'accepted');
    const next = f.page('backup-origin.invalid'), problem = await recovery(() => next.sendMessage(input()));
    assert.equal(problem.operations[0].matchesDraft, true); assert.equal(f.requests.length, 1);
    await next.resolvePromptOperation({ sessionId: 'A', requestId: problem.operations[0].requestId, action: 'acknowledge' });
    assert.equal(f.requests.length, 1); await next.sendMessage(input('A', 'Another deliberate task')); assert.equal(f.requests.length, 2);
  });
  await check('new draft is distinguished using a boolean without exposing old text or hash', async f => {
    loseAcceptedConfirmation(f); await recovery(() => f.page().sendMessage(input('A', 'OLD_PRIVATE_TEXT')));
    const problem = await recovery(() => f.page('fresh.invalid').sendMessage(input('A', 'NEW_DRAFT')));
    assert.equal(problem.operations[0].matchesDraft, false);
    assert.equal(JSON.stringify(problem.operations).includes('OLD_PRIVATE_TEXT'), false);
    assert.equal(Object.hasOwn(problem.operations[0], 'digest'), false); assert.equal(f.requests.length, 1);
  });
  await check('uncertain is never replayed; explicit review only permits a separately requested operation', async f => {
    const api = f.page(); f.upstream('disconnect');
    assert.equal((await recovery(() => api.sendMessage(input()))).operations[0].state, 'uncertain');
    await recovery(() => api.sendMessage(input()));
    const next = f.page('next.invalid'), problem = await recovery(() => next.sendMessage(input()));
    assert.equal(f.requests.length, 1);
    await assert.rejects(next.resolvePromptOperation({ sessionId: 'A', requestId: problem.operations[0].requestId, action: 'review-uncertain' }));
    await next.resolvePromptOperation({ sessionId: 'A', requestId: problem.operations[0].requestId, action: 'review-uncertain', confirm: true });
    assert.equal(f.requests.length, 1); await next.sendMessage(input());
    assert.equal(f.requests.length, 2); assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
  });
  await check('simultaneous same-payload clicks share one identity and in-flight request', async f => {
    const api = f.page(); f.faults('session/prompt', 'hold');
    const first = api.sendMessage(input()), second = api.sendMessage(input());
    for (let i = 0; !f.held.length && i < 20; i++) await flush();
    assert.equal(f.requests.length, 1); assert.equal(f.held.length, 1); f.held[0](); await Promise.all([first, second]);
    assert.equal(f.requests.length, 1);
  });
  await check('two pages cannot send separate identities while a receipt is unacknowledged', async f => {
    f.faults('session/prompt', 'hold'); const first = f.page().sendMessage(input());
    for (let i = 0; !f.held.length && i < 20; i++) await flush();
    await recovery(() => f.page('other.invalid').sendMessage(input('A', 'different task')));
    assert.equal(f.requests.length, 1); f.held[0](); await first;
  });
  await check('lost preparation leaves only a cancellable unsent operation', async f => {
    f.faults('bridge/prompt-prepare', 'lost'); await assert.rejects(f.page().sendMessage(input())); assert.equal(f.requests.length, 0);
    const api = f.page('fresh.invalid'), problem = await recovery(() => api.sendMessage(input()));
    assert.equal(problem.operations[0].state, 'prepared');
    await api.resolvePromptOperation({ sessionId: 'A', requestId: problem.operations[0].requestId, action: 'cancel-prepared' });
    assert.equal(f.requests.length, 0); await api.sendMessage(input()); assert.equal(f.requests.length, 1);
  });
  await check('403 for session/prompt never reproves then replays a potentially completed write', async f => {
    f.faults('session/prompt', '403'); const result = await f.page().sendMessage(input());
    assert.equal(result.accepted, true); assert.equal(result.recovered, true);
    assert.equal(f.proofs, 0); assert.equal(f.requests.length, 1);
    assert.equal(f.transport.filter(item => item.method === 'session/prompt').length, 1);
  });
  await check('different sessions are independent while attachment receipts remain bound to the draft', async f => {
    const api = f.page(), files = [{ receiptId: 'receipt-owned-one', file: { name: 'owned.txt' } }];
    loseAcceptedConfirmation(f); await recovery(() => api.sendMessage(input('A', 'Read', files)));
    await api.sendMessage(input('B', 'Read', files)); assert.equal(f.requests.length, 2);
    const problem = await recovery(() => f.page().sendMessage(input('A', 'Read', [{ receiptId: 'receipt-owned-two' }])));
    assert.equal(problem.operations[0].matchesDraft, false); assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(await api.listPromptOperations('A')).includes('receipt-owned'), false);
  });
  await check('changed verified runtime requires review and cannot receive a previous operation', async f => {
    f.upstream('disconnect'); await recovery(() => f.page().sendMessage(input())); f.context.runtimeId = 'owned-runtime-2';
    const problem = await recovery(() => f.page('restarted.invalid').sendMessage(input()));
    assert.equal(problem.operations[0].contextChanged, true); assert.equal(problem.operations[0].matchesDraft, false);
    assert.equal(f.requests.length, 1);
  });
  await check('factory binds only verified destination cookie/proof/runtime, never phone fields', async () => {
    const src = fs.readFileSync(path.join(root, 'scripts/mobile-proxy.js'), 'utf8');
    const begin = src.indexOf("const dshPromptState = require('./dsh-prompt-state.js')"), end = src.indexOf('const serveDshLiteUploadE2ee', begin);
    assert.ok(begin > 0 && end > begin);
    let options, hasCookie = true, proof = true, verified = true, cookieAuthority = 'backup.invalid';
    const device = { id: 'owned-device-1234' }, target = { kind: 'remote-mux', pid: 1234, port: 19101, profile: 'web', version: '0.1.7-rc.2' };
    const sandbox = { path, Buffer, LOG_DIR: path.join(owned, 'binding-fixture'),
      hasAuthCookie: () => hasCookie,
      readDeviceToken: () => 'owned.' + Buffer.from(JSON.stringify({ a: cookieAuthority })).toString('base64url') + '.test',
      sessions: { verify: (_token, { authority }) => { assert.equal(authority, 'backup.invalid'); return { ok: verified, device }; } },
      authProvenAt: id => { assert.equal(id, device.id); return proof; },
      refreshDshRuntimeState: async () => ({ ready: true, runtime: target }), e2eeSecretOrNull: () => 'owned-test-key-0123456789',
      DSH_UPSTREAM_AUTH_OK: true, dshRuntimeIdentity: value => JSON.stringify([value.pid, value.port, value.profile, value.version]),
      e2eeWrap: value => value, callDshLiteUpstream() {}, require(name) {
        if (name === './dsh-prompt-state.js') return { createDshPromptState(value) {
          assert.equal(value.directory, path.join(sandbox.LOG_DIR, 'prompt-operations')); return { owned: true }; } };
        if (name === './dsh-lite-rpc.js') return { createDshLiteRpc(value) { options = value; return () => {}; } };
        throw Error('Unexpected dependency');
      } };
    vm.createContext(sandbox); vm.runInContext(extractFunction(src, 'verifiedBackupPreparationDevice') + '\n' + src.slice(begin, end), sandbox);
    const req = { headers: { host: 'backup.invalid' }, __dshE2eeDecryptionKey: 'owned-test-key-0123456789',
      body: { deviceId: 'ATTACKER_CHOSEN', secret: 'ATTACKER_CHOSEN' } };
    const bound = await options.promptContext(req);
    assert.equal(bound.deviceId, device.id); assert.equal(bound.verifiedRuntime, target);
    assert.equal(bound.runtimeId, JSON.stringify([1234, 19101, 'web', '0.1.7-rc.2']));
    for (const fault of ['cookie', 'proof', 'verify', 'authority', 'runtime', 'key', 'upstream-auth']) {
      hasCookie = fault !== 'cookie'; proof = fault !== 'proof'; verified = fault !== 'verify';
      cookieAuthority = fault === 'authority' ? 'previous.invalid' : 'backup.invalid';
      sandbox.refreshDshRuntimeState = async () => ({ ready: fault !== 'runtime', runtime: target });
      sandbox.e2eeSecretOrNull = () => fault === 'key' ? null : 'owned-test-key-0123456789'; sandbox.DSH_UPSTREAM_AUTH_OK = fault !== 'upstream-auth';
      await assert.rejects(options.promptContext(req), problem => problem.code === 'prompt-state-context-unavailable');
    }
    const reissue = extractFunction(fs.readFileSync(path.join(root, 'scripts/sessions.js'), 'utf8'), 'reissue');
    const db = { devices: [{ id: device.id, fps: [], expiresAt: '2099-01-01' }] }; let saved = false;
    const sessions = { load: () => db, KEEP_FINGERPRINTS: 4, fingerprint: () => 'owned-fingerprint',
      mintToken(id, authority) { assert.equal(id, device.id); assert.equal(authority, 'new-origin.invalid'); return 'owned-reissued-token'; },
      save(value) { assert.equal(value, db); saved = true; } };
    vm.createContext(sessions); vm.runInContext(reissue, sessions);
    assert.equal(sessions.reissue(device.id, 'new-origin.invalid'), 'owned-reissued-token'); assert.equal(saved, true);
    assert.equal(db.devices[0].id, device.id, 'actual reissue function retains the device ID');

    hasCookie = proof = verified = true; cookieAuthority = 'backup.invalid'; sandbox.DSH_UPSTREAM_AUTH_OK = true;
    for (const mutation of ['revoke', 'rotate']) {
      let release;
      sandbox.e2eeSecretOrNull = () => 'owned-test-key-0123456789';
      sandbox.refreshDshRuntimeState = () => new Promise(resolve => { release = resolve; });
      const waiting = options.promptContext(req);
      if (mutation === 'revoke') verified = false;
      else sandbox.e2eeSecretOrNull = () => 'rotated-test-key-0123456789';
      release({ ready: true, runtime: target });
      await assert.rejects(waiting, problem => problem.code === 'prompt-state-context-unavailable');
      verified = true;
    }
    sandbox.e2eeSecretOrNull = () => 'owned-test-key-0123456789';
    sandbox.refreshDshRuntimeState = async () => ({ ready: true, runtime: target });
    await assert.rejects(options.promptContext({ ...req, __dshE2eeDecryptionKey: 'old-test-key-0123456789' }),
      problem => problem.code === 'prompt-state-context-unavailable');

    // Exercise the second async refresh window in the actual upstream factory.
    let release, valid = true, httpCalls = 0;
    const upstream = { refreshDshRuntimeState: () => new Promise(resolve => { release = resolve; }),
      http: { request() { httpCalls++; throw Error('Must never reach network'); } }, DSH_UPSTREAM_AUTH_OK: true };
    vm.createContext(upstream); vm.runInContext(extractFunction(src, 'callDshLiteUpstream'), upstream);
    const waiting = upstream.callDshLiteUpstream({ verifyPromptContext: () => valid });
    valid = false; release({ ready: true, runtime: target });
    await assert.rejects(waiting, problem => problem.code === 'prompt-state-context-unavailable'); assert.equal(httpCalls, 0);
  });
  await check('actual encrypted wrapper attaches only its successful decryption key as immutable non-enumerable metadata', async () => {
    const src = fs.readFileSync(path.join(root, 'scripts/mobile-proxy.js'), 'utf8');
    const key = 'owned-wrapper-key-0123456789';
    const sandbox = { Buffer, URL, Readable, MAX_E2EE_BODY: 4096, e2eeSecretOrNull: () => key,
      clientWantsE2ee: () => true, log() {}, refuseEncryptionUnavailable() { throw Error('Unexpected missing fixture key'); },
      privateHttpsAdmission: { inheritRemote() {} }, e2ee: { openIncoming(secret) {
        assert.equal(secret, key); return { ok: true, plain: Buffer.from('{}') }; } } };
    vm.createContext(sandbox); vm.runInContext(extractFunction(src, 'e2eeWrap'), sandbox);
    const req = Readable.from([Buffer.from('owned-ciphertext-fixture')]);
    req.method = 'POST'; req.url = '/__dsh/lite-rpc'; req.__dshRequireE2ee = true;
    req.headers = { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1', 'x-dsh-e2ee-key': 'ATTACKER_CHOSEN' };
    const shim = await new Promise(resolve => sandbox.e2eeWrap(resolve, { responseEncryptedByHandler: true })(req, {}));
    assert.equal(shim.__dshE2eeDecryptionKey, key); assert.equal(shim.__dshE2eeDecrypted, true);
    const descriptor = Object.getOwnPropertyDescriptor(shim, '__dshE2eeDecryptionKey');
    assert.equal(descriptor.enumerable, false); assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
    assert.equal(JSON.stringify(Object.keys(shim)).includes('__dshE2eeDecryptionKey'), false);
  });
  fs.writeFileSync(path.join(owned, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log('DSH durable prompt adapter checks passed (' + checks + ' groups)');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
