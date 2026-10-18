'use strict';

// Owned filesystem and RPC fault injection; no DSH, provider, credentials or
// production gateway. The mock upstream deliberately has no deduplication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createDshPromptState } = require('./dsh-prompt-state');
const { createDshLiteRpc } = require('./dsh-lite-rpc');
const output = path.resolve(__dirname, '..', '..', 'output');
fs.mkdirSync(output, { recursive: true });
const owned = fs.mkdtempSync(path.join(output, 'prompt-state-tests-'));
let checks = 0, clock = 1700000000000, serial = 0;
const ctx = { deviceId: 'owned-device-1234', runtimeId: 'owned-runtime-1', secret: 'owned-test-only-key-0123456789',
  verifiedRuntime: { kind: 'owned-test', port: 19999 } };
const request = (text = 'PRIVATE_PROMPT_NOT_FOR_DISK', sessionId = 'owned-session') => ({
  requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] });
function fixture(fileSystem) {
  const directory = path.join(owned, String(++serial));
  return { directory, state: createDshPromptState({ directory, fileSystem, now: () => ++clock }) };
}
const fail = (run, code) => assert.throws(run, error => error.code === code);
function files(directory) {
  const out = [];
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...files(target)); else out.push(target);
  }
  return out;
}
function file(f, suffix) { return files(f.directory).find(name => name.endsWith('.' + suffix + '.json')); }
function patchFileSystem(overrides) { return Object.assign({}, fs, overrides); }
async function invoke(handler, method, input, options = {}) {
  const req = Readable.from([JSON.stringify({ method, request: input })]);
  req.method = 'POST'; req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = { 'content-type': 'application/json', 'x-dsh-e2ee': '1' };
  const res = { destroyed: !!options.destroyed, writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; } };
  await handler(req, res); return res;
}
function rpc(f, callUpstream, context = () => ctx) {
  return createDshLiteRpc({ promptState: f.state, promptContext: context, callUpstream });
}
function accepted(input) {
  const wire = JSON.parse(input.body);
  return { statusCode: 200, body: JSON.stringify({ rpcId: wire.rpcId, result: { ok: true, value: { accepted: true } } }) };
}
async function check(name, test) { await test(); checks++; console.log('PASS ' + name); }

async function run() {
  await check('prepare is private and durable before dispatch; no plaintext or secret is stored', () => {
    const f = fixture(), r = request();
    assert.equal(fs.existsSync(f.directory), false);
    assert.equal(f.state.prepare(ctx, r).state, 'prepared');
    const stored = files(f.directory).map(name => fs.readFileSync(name, 'utf8')).join('');
    for (const value of [r.content[0].text, r.sessionId, ctx.deviceId, ctx.runtimeId, ctx.secret]) assert.equal(stored.includes(value), false);
    assert.equal(f.state.begin(ctx, r).dispatch, true);
    assert.equal(f.state.begin(ctx, r).dispatch, false);
  });
  await check('accepted receipt survives new module and does not dispatch again', () => {
    const f = fixture(), r = request(); f.state.prepare(ctx, r); f.state.begin(ctx, r); f.state.accepted(ctx, r);
    const restarted = createDshPromptState({ directory: f.directory });
    assert.equal(restarted.begin(ctx, r).dispatch, false);
    assert.equal(restarted.state(ctx, { sessionId: r.sessionId, action: 'list' }).operations[0].state, 'accepted');
    restarted.state(ctx, { ...r, action: 'acknowledge' });
    assert.equal(restarted.state(ctx, { sessionId: r.sessionId, action: 'list' }).operations.length, 0);
    const repeat = { ...r, requestId: crypto.randomUUID() };
    assert.equal(restarted.prepare(ctx, repeat).state, 'prepared', 'identical intentional text is not globally deduplicated');
    assert.equal(restarted.begin(ctx, repeat).dispatch, true);
    assert.equal(restarted.begin(ctx, r).dispatch, false, 'review never makes an old identity replayable');
  });
  await check('uncertain blocks every new identity until explicit history review, then old ID remains blocked', () => {
    const f = fixture(), r = request(); f.state.prepare(ctx, r); f.state.begin(ctx, r);
    const changed = request('different new draft');
    fail(() => f.state.prepare(ctx, changed), 'prompt-recovery-required');
    fail(() => f.state.state(ctx, { ...r, action: 'review-uncertain' }), 'prompt-recovery-required');
    f.state.state(ctx, { ...r, action: 'review-uncertain', confirm: true });
    assert.equal(f.state.prepare(ctx, changed).state, 'prepared');
    assert.equal(f.state.begin(ctx, r).dispatch, false);
    assert.equal(f.state.begin(ctx, changed).dispatch, true);
  });
  await check('prepare-only comparison exposes booleans, list/status never expose draft matching or digest', () => {
    const f = fixture(), r = request(); f.state.prepare(ctx, r); f.state.begin(ctx, r); f.state.accepted(ctx, r);
    for (const [next, expected] of [[{ ...r, requestId: crypto.randomUUID() }, true], [request('different'), false]]) {
      assert.throws(() => f.state.prepare(ctx, next), error => error.code === 'prompt-recovery-required' &&
        error.operations.length === 1 && error.operations[0].matchesDraft === expected && !('digest' in error.operations[0]));
    }
    assert.equal('matchesDraft' in f.state.state(ctx, { ...r, action: 'status' }).operation, false);
    assert.equal('matchesDraft' in f.state.state(ctx, { ...r, action: 'list' }).operations[0], false);
  });
  await check('device/session scope separates operations; runtime/key changes reveal recovery but forbid dispatch', () => {
    const f = fixture(), r = request(); f.state.prepare(ctx, r);
    assert.equal(f.state.state({ ...ctx, deviceId: 'other-owned-device' }, { ...r, action: 'list' }).operations.length, 0);
    assert.equal(f.state.state(ctx, { sessionId: 'another-session', action: 'list' }).operations.length, 0);
    for (const changed of [{ ...ctx, runtimeId: 'restarted-runtime' }, { ...ctx, secret: 'changed-test-key-0123456789' }]) {
      assert.equal(f.state.state(changed, { ...r, action: 'list' }).operations[0].contextChanged, true);
      fail(() => f.state.begin(changed, r), 'prompt-state-context-changed');
    }
    fail(() => f.state.begin(ctx, { ...r, content: [{ type: 'text', text: 'tampered' }] }), 'prompt-state-context-changed');
  });
  await check('cancel and dispatch share an exclusive decision; cancelled identities cannot be sent', () => {
    const f = fixture(), r = request(); f.state.prepare(ctx, r);
    assert.equal(f.state.state(ctx, { ...r, action: 'cancel-prepared' }).operation.state, 'cancelled');
    assert.equal(f.state.begin(ctx, r).dispatch, false);
    const other = request(); f.state.prepare(ctx, other); f.state.begin(ctx, other);
    fail(() => f.state.state(ctx, { ...other, action: 'cancel-prepared' }), 'prompt-recovery-required');
  });
  await check('intent fsync failure fails closed and never grants dispatch', () => {
    let block = true;
    const f = fixture(patchFileSystem({ fsyncSync(fd) { if (block) throw Error('injected fsync failure'); return fs.fsyncSync(fd); } }));
    const r = request(); fail(() => f.state.prepare(ctx, r), 'prompt-state-storage-unavailable');
    block = false;
    assert.equal(f.state.state(ctx, { ...r, action: 'status' }).operation.state, 'prepared');
    assert.equal(files(f.directory).some(name => name.endsWith('.decision.json')), false);
  });
  await check('decision fsync failure is uncertain after restart and can never dispatch twice', () => {
    let failDecision = false; const handles = new Map();
    const f = fixture(patchFileSystem({
      openSync(name, ...args) { const fd = fs.openSync(name, ...args); handles.set(fd, name); return fd; },
      closeSync(fd) { handles.delete(fd); return fs.closeSync(fd); },
      fsyncSync(fd) { if (failDecision && handles.get(fd).endsWith('.decision.json')) throw Error('injected'); return fs.fsyncSync(fd); }
    }));
    const r = request(); f.state.prepare(ctx, r); failDecision = true;
    fail(() => f.state.begin(ctx, r), 'prompt-state-storage-unavailable');
    const restarted = createDshPromptState({ directory: f.directory });
    assert.equal(restarted.begin(ctx, r).dispatch, false);
    assert.equal(restarted.state(ctx, { ...r, action: 'status' }).operation.state, 'uncertain');
  });
  await check('partial, unknown schema, oversized, orphan and hard-linked journal files fail closed', () => {
    for (const mutation of ['partial', 'schema', 'oversized', 'orphan', 'hardlink']) {
      const f = fixture(), r = request(); f.state.prepare(ctx, r); const name = file(f, 'intent');
      if (mutation === 'partial') fs.writeFileSync(name, '{');
      if (mutation === 'schema') { const value = JSON.parse(fs.readFileSync(name)); value.extra = true; fs.writeFileSync(name, JSON.stringify(value)); }
      if (mutation === 'oversized') fs.writeFileSync(name, ' '.repeat(4097));
      if (mutation === 'orphan') fs.writeFileSync(path.join(path.dirname(name), crypto.randomUUID() + '.receipt.json'), '{}');
      if (mutation === 'hardlink') fs.linkSync(name, path.join(owned, 'hard-link-' + serial));
      fail(() => f.state.state(ctx, { ...r, action: 'list' }), 'prompt-state-storage-unavailable');
    }
  });
  await check('journal errors and missing prepare never contact upstream', async () => {
    const f = fixture(); let calls = 0; const handler = rpc(f, input => { calls++; return accepted(input); });
    const r = request(); let result = await invoke(handler, 'session/prompt', r);
    assert.equal(result.body.result.ok, false); assert.equal(calls, 0);
    result = await invoke(handler, 'bridge/prompt-prepare', r); assert.equal(result.body.result.ok, true);
    fs.writeFileSync(file(f, 'intent'), '{');
    result = await invoke(handler, 'session/prompt', r); assert.equal(result.body.result.ok, false); assert.equal(calls, 0);
  });
  await check('lost response after acceptance is recoverable across runtime factory reload without a second upstream call', async () => {
    const f = fixture(), r = request(); let calls = 0;
    let handler = rpc(f, input => { calls++; assert.deepEqual(input.verifiedRuntime, ctx.verifiedRuntime); return accepted(input); });
    await invoke(handler, 'bridge/prompt-prepare', r);
    await invoke(handler, 'session/prompt', r, { destroyed: true });
    handler = rpc({ state: createDshPromptState({ directory: f.directory }) }, input => { calls++; return accepted(input); });
    const result = await invoke(handler, 'session/prompt', r);
    assert.equal(result.body.result.value.accepted, true); assert.equal(calls, 1);
    assert.equal(result.body.result.value.bridgeOperation.state, 'accepted');
    const blocked = await invoke(handler, 'bridge/prompt-prepare', { ...r, requestId: crypto.randomUUID() });
    assert.equal(blocked.body.result.error.operations[0].matchesDraft, true);
    assert.equal(JSON.stringify(blocked.body).includes(r.content[0].text), false);
  });
  await check('ambiguous upstream disconnect and descriptor rejection never trigger automatic prompt replay', async () => {
    for (const mode of ['throw', 'invalid', 'arguments-invalid']) {
      const f = fixture(), r = request(); let calls = 0;
      const handler = rpc(f, input => {
        calls++; if (mode === 'throw') throw Error('injected network failure');
        if (mode === 'invalid') return { statusCode: 502, body: 'bad upstream' };
        return { statusCode: 200, body: JSON.stringify({ rpcId: JSON.parse(input.body).rpcId,
          result: { ok: false, error: { code: 'gateway/arguments-invalid' } } }) };
      });
      await invoke(handler, 'bridge/prompt-prepare', r); await invoke(handler, 'session/prompt', r);
      await invoke(handler, 'session/prompt', r);
      assert.equal(calls, 1); assert.equal(f.state.state(ctx, { ...r, action: 'status' }).operation.state, 'uncertain');
    }
  });
  await check('concurrent RPC handlers and reloaded journal grant only one dispatch without upstream dedup', async () => {
    const f = fixture(), r = request(); let release, calls = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const call = async input => { calls++; await waiting; return accepted(input); };
    const first = rpc(f, call), second = rpc({ state: createDshPromptState({ directory: f.directory }) }, call);
    await invoke(first, 'bridge/prompt-prepare', r);
    const sent = invoke(first, 'session/prompt', r); await new Promise(resolve => setImmediate(resolve));
    const duplicate = await invoke(second, 'session/prompt', r);
    assert.equal(duplicate.body.result.error.code, 'prompt-recovery-required');
    assert.equal(calls, 1); release(); await sent;
  });
  await check('receipt write failure reports uncertainty rather than false acceptance or another dispatch', async () => {
    const f = fixture(patchFileSystem({ openSync(name, ...args) {
      if (name.endsWith('.receipt.json') && args[0] === 'wx') throw Error('injected disk failure');
      return fs.openSync(name, ...args);
    } }));
    const r = request(); let calls = 0; const handler = rpc(f, input => { calls++; return accepted(input); });
    await invoke(handler, 'bridge/prompt-prepare', r);
    const result = await invoke(handler, 'session/prompt', r);
    assert.equal(result.status, 502); assert.equal(result.body.error, 'prompt-state-storage-unavailable');
    await invoke(handler, 'session/prompt', r); assert.equal(calls, 1);
    assert.equal(f.state.state(ctx, { ...r, action: 'status' }).operation.state, 'uncertain');
  });
  await check('trusted context failures and plaintext shims cannot access the journal or upstream', async () => {
    const f = fixture(), r = request(); let calls = 0;
    const handler = rpc(f, () => { calls++; }, () => { throw Error('sensitive context/path'); });
    const result = await invoke(handler, 'bridge/prompt-prepare', r);
    assert.deepEqual(result.body, { result: { ok: false, error: { code: 'prompt-state-storage-unavailable' } } });
    assert.equal((await invoke(handler, 'bridge/prompt-state', { sessionId: r.sessionId, action: 'list' }, { decrypted: false })).status, 403);
    assert.equal(calls, 0); assert.equal(fs.existsSync(f.directory), false);
  });
  await check('two actual owned Node processes reading the same empty journal receive only one session admission', async () => {
    const directory = path.join(owned, 'cross-process'); fs.mkdirSync(directory, { recursive: true });
    const execute = promisify(execFile);
    const results = await Promise.all([1, 2].map(actor => execute(process.execPath,
      [__filename, '--admission-race-child', directory, String(actor)],
      { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 16384 })));
    const values = results.map(value => JSON.parse(value.stdout));
    assert.equal(values.filter(value => value.dispatched).length, 1);
    assert.equal(values.filter(value => value.error === 'prompt-recovery-required').length, 1);
    const journal = createDshPromptState({ directory: path.join(directory, 'journal') });
    const operations = journal.state(ctx, { sessionId: 'owned-session', action: 'list' }).operations;
    assert.equal(operations.length, 1); assert.equal(operations[0].state, 'uncertain');
    assert.equal(operations[0].requestId, values.find(value => value.dispatched).requestId);
    journal.state(ctx, { sessionId: 'owned-session', requestId: operations[0].requestId, action: 'review-uncertain', confirm: true });
    for (let i = 0; i < 50; i++) {
      const r = request(); journal.prepare(ctx, r); journal.begin(ctx, r); journal.accepted(ctx, r);
      journal.state(ctx, { ...r, action: 'acknowledge' });
    }
    let reads = 0;
    const afterRace = createDshPromptState({ directory: path.join(directory, 'journal'), fileSystem: patchFileSystem({
      readFileSync(...args) { reads++; return fs.readFileSync(...args); }
    }) });
    afterRace.prepare(ctx, request()); assert.ok(reads < 30, 'one cancelled race loser must not force a full normal-history scan: ' + reads);
  });
  await check('ordinary v2 send does not read every reviewed history receipt', () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) {
      const r = request(); f.state.prepare(ctx, r); f.state.begin(ctx, r); f.state.accepted(ctx, r);
      f.state.state(ctx, { ...r, action: 'acknowledge' });
    }
    let reads = 0;
    const bounded = createDshPromptState({ directory: f.directory,
      fileSystem: patchFileSystem({ readFileSync(...args) { reads++; return fs.readFileSync(...args); } }) });
    bounded.prepare(ctx, request()); assert.ok(reads < 20, 'normal preparation reads only active head and the new operation: ' + reads);
  });
  await check('corrupt/missing admission and legacy pending identity fail safely instead of dispatching another request', () => {
    for (const mutation of ['corrupt', 'missing', 'legacy']) {
      const f = fixture(), r = request(); f.state.prepare(ctx, r);
      const slot = files(f.directory).find(name => /admission-1\.json$/.test(name));
      if (mutation === 'corrupt') fs.writeFileSync(slot, '{');
      else fs.unlinkSync(slot);
      if (mutation === 'legacy') {
        const name = file(f, 'intent'), value = JSON.parse(fs.readFileSync(name)); delete value.admission; value.version = 1;
        fs.writeFileSync(name, JSON.stringify(value));
      }
      if (mutation === 'corrupt') fail(() => f.state.begin(ctx, r), 'prompt-state-storage-unavailable');
      else if (mutation === 'missing') assert.equal(f.state.begin(ctx, r).dispatch, false);
      else assert.equal(f.state.begin(ctx, r).dispatch, true, 'the same prior v1 identity remains recoverable');
      assert.throws(() => f.state.prepare(ctx, request('new')), error => /^prompt-/.test(error.code));
    }
  });
  fs.writeFileSync(path.join(owned, 'result.json'), JSON.stringify({ checks, passed: true }, null, 2));
  console.log('DSH durable prompt-state checks passed (' + checks + ' groups)');
}
function raceChild() {
  const directory = path.resolve(process.argv[3]), actor = Number(process.argv[4]);
  assert.ok([1, 2].includes(actor));
  let synchronized = false;
  const io = patchFileSystem({ readdirSync(name, ...args) {
    const result = fs.readdirSync(name, ...args);
    if (!synchronized) {
      synchronized = true; assert.deepEqual(result, []);
      fs.writeFileSync(path.join(directory, 'ready-' + actor), 'ready', { flag: 'wx' });
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(path.join(directory, 'ready-' + (actor === 1 ? 2 : 1)))) {
        if (Date.now() >= deadline) throw Error('Owned test barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  } });
  const journal = createDshPromptState({ directory: path.join(directory, 'journal'), fileSystem: io });
  const r = request();
  try { journal.prepare(ctx, r); console.log(JSON.stringify({ requestId: r.requestId, dispatched: journal.begin(ctx, r).dispatch })); }
  catch (error) { console.log(JSON.stringify({ requestId: r.requestId, dispatched: false, error: error.code })); }
}
if (process.argv[2] === '--admission-race-child') raceChild();
else run().catch(error => { console.error(error); process.exitCode = 1; });
