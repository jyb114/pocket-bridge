'use strict';
// Actual adapter in a controlled VM: no DSH, browser, network or native input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let checks = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); checks++; }
function deep(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label); checks++; }
const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-adapter.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
function projection(revision = 17) {
  return { asOfSeq: revision, values: {
    permissions: { currentValue: 'workspace-write' },
    modelSelection: { next: { provider: 'fixture', model: 'model-one', reasoningEffort: 'low' } },
    agentPreset: 'standard', sessionListMetadata: { blank: false }, plan: { active: true, pending: false },
    inbox: { 'next-turn': [{ id: 'queue-one', content: [{ type: 'text', text: 'Retained queue text' }] }], 'next-step': [] },
    goal: { goal: { id: 'goal-one', revision, objective: 'Retained goal', phase: 'active' } }
  } };
}
function fixture() {
  const calls = [], sockets = [], timers = new Map(), listeners = new Map();
  let timerId = 0, clock = 100, dateClock = 100000;
  const runtime = {
    window: null, Map, Promise, Uint8Array, DataView, TextEncoder, Blob,
    Event: class { constructor(type) { this.type = type; } },
    location: { protocol: 'https:', host: 'fixture.test' },
    crypto: { randomUUID: () => 'fixture-request-id', getRandomValues: bytes => bytes.fill(1) },
    performance: { now: () => clock },
    Date: class extends Date { static now() { return dateClock; } },
    __dshE2eeSecret: 'fixture-key-one',
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { visibilityState: 'visible', dispatchEvent() {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } },
    DshE2EE: { available: () => true, prove: async () => true,
      encryptedFetch(secret, url, init) {
        assert.equal(url, '/__dsh/lite-rpc');
        const body = JSON.parse(init.body);
        const call = { secret, body, init, settled: false };
        calls.push(call);
        if (body.method === 'session/list') return Promise.resolve({ status: 200, ok: true,
          json: async () => ({ result: { ok: true, value: { items: [] } } }) });
        return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
      } }
  };
  runtime.WebSocket = class {
    constructor() { this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen(); }); }
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.endpoint === 'workspace/follow') queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [] } }
      }) }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
    drop() { this.readyState = 3; this.onclose({ code: 1006 }); }
  };
  runtime.window = runtime;
  vm.runInNewContext(source, runtime, { filename: 'dsh-lite-adapter.js' });
  return { runtime, api: runtime.DshLiteAdapter, calls, sockets,
    setClock(value) { clock = value; },
    setDateClock(value) { dateClock = value; },
    reads() { return calls.filter(call => call.body.method === 'session/projections'); },
    pendingWrites() { return calls.filter(call => call.resolve && !call.settled && call.body.method !== 'session/projections'); },
    succeed(call, value = projection()) {
      assert.ok(call && call.resolve && !call.settled, 'only the admitted fixture request can settle');
      call.settled = true; call.decoded = value;
      call.resolve({ status: 200, ok: true, json: async () => ({ result: { ok: true, value } }) });
    },
    reject(call, message = 'controlled network failure') { call.settled = true; call.reject(new Error(message)); },
    fail(call) { call.settled = true; call.resolve({ status: 200, ok: true,
      json: async () => ({ result: { ok: false, error: { code: 'fixture-read-failure', message: 'Controlled refusal' } } }) }); },
    runTimer(ms) { const pair = [...timers].find(([, item]) => item.ms === ms); assert.ok(pair, 'exact fixture timer exists');
      timers.delete(pair[0]); pair[1].fn(); },
    visible(state) { runtime.document.visibilityState = state; const handler = listeners.get('visibilitychange'); if (handler) handler(); }
  };
}

(async () => {
  {
    const f = fixture();
    const readers = [f.api.readSelection('session-one'), f.api.readPermission('session-one'),
      f.api.listQueued('session-one'), f.api.readGoal('session-one')];
    await flush();
    equal(f.reads().length, 1, 'four simultaneous projections use one encrypted HTTP request');
    deep(f.reads()[0].body, { method: 'session/projections', request: { sessionId: 'session-one' } }, 'wire contract is unchanged');
    equal(f.reads()[0].init.credentials, 'same-origin', 'credentials retained');
    equal(f.reads()[0].init.cache, 'no-store', 'HTTP caching remains disabled');
    f.succeed(f.reads()[0]);
    const [selection, permission, queue, goal] = await Promise.all(readers);
    deep(selection.modelSelection, { provider: 'fixture', model: 'model-one', reasoningEffort: 'low' }, 'model extraction retained');
    deep(permission, { presetId: 'workspace-write', asOfSeq: 17 }, 'permission sequence retained');
    deep(queue, [{ id: 'queue-one', text: 'Retained queue text', target: 'turn' }], 'queue text and target retained');
    equal(goal.revision, 17, 'optimistic goal revision retained');
    equal(Object.isFrozen(f.reads()[0].decoded.values.inbox['next-turn'][0].content), true, 'shared nested response is immutable');
    assert.throws(() => { f.reads()[0].decoded.values.permissions.currentValue = 'danger-full-access'; }, TypeError); checks++;
    selection.modelSelection.model = 'consumer-owned-edit'; queue[0].text = 'consumer-owned-edit';
    equal(f.reads()[0].decoded.values.modelSelection.next.model, 'model-one', 'reader output edits do not change shared model');
    equal(f.reads()[0].decoded.values.inbox['next-turn'][0].content[0].text, 'Retained queue text', 'queue output edit does not change shared message');
    const next = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 2, 'settled success is never cached'); f.succeed(f.reads()[1], projection(18));
    equal((await next).asOfSeq, 18, 'fresh response remains authoritative');
  }
  {
    const f = fixture();
    const reads = [f.api.readPermission('session-one'), f.api.readPermission('session-two')]; await flush();
    equal(f.reads().length, 2, 'different sessions never share a flight');
    f.reads().forEach(call => f.succeed(call)); await Promise.all(reads);
    const rejected = Promise.allSettled([f.api.readGoal('session-one'), f.api.listQueued('session-one')]); await flush();
    equal(f.reads().length, 3, 'two readers share the pending failure'); f.fail(f.reads()[2]);
    const errors = await rejected;
    equal(errors.every(item => item.status === 'rejected' && item.reason.code === 'fixture-read-failure'), true, 'the original domain error reaches both readers');
    const retry = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 4, 'failed flight is removed without caching'); f.succeed(f.reads()[3]); await retry;
  }
  {
    const f = fixture();
    const old = f.api.readPermission('session-one'); await flush();
    const write = f.api.runCommand('session-one', '/plan'); const rejectedWrite = Promise.allSettled([write]); await flush();
    const during = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 2, 'write entry separates a new reader from the prior flight');
    equal(f.pendingWrites().length, 1, 'write is dispatched exactly once');
    f.reject(f.pendingWrites()[0], 'uncertain write outcome'); await rejectedWrite;
    const after = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 3, 'failed or uncertain settlement fences reads started during the write');
    f.succeed(f.reads()[0]); await old;
    const joining = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 3, 'an old finalizer cannot erase the newer current flight');
    f.succeed(f.reads()[1], projection(18)); f.succeed(f.reads()[2], projection(19));
    const results = await Promise.all([during, after, joining]);
    equal(results[1].asOfSeq, 19, 'post-settlement permission reads the new response');
    equal(results[2].revision, 19, 'joining goal receives that same new response');
    equal(f.calls.filter(call => call.body.method === 'commands/execute').length, 1, 'no writer retry was added');
  }
  const methods = ['session/selectModel', 'agentPresets/select', 'commands/execute', 'session/updateQueue',
    'session/prompt', 'session/cancel', '$events/result', 'session/create', 'workspace/create',
    'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear'];
  for (const method of methods) {
    const f = fixture(), old = f.api.readGoal('session-one'); await flush();
    const write = f.api.liteRpc(method, { sessionId: 'session-one' }); await flush();
    const during = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 2, `${method} entry invalidates projection admission`);
    f.succeed(f.pendingWrites()[0], { accepted: true }); await write;
    const after = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 3, `${method} settlement requires fresh readback`);
    f.reads().forEach(call => f.succeed(call)); await Promise.all([old, during, after]);
    equal(f.calls.filter(call => call.body.method === method).length, 1, `${method} dispatch count unchanged`);
  }
  for (const method of ['prompt', 'cancel', 'createSession', 'createProject']) {
    const f = fixture(), old = f.api.readGoal('session-one'); await flush();
    const write = method === 'prompt' ? f.api.sendMessage({ sessionId: 'session-one', text: 'fixture' }) :
      method === 'cancel' ? f.api.cancelSession('session-one') : method === 'createSession' ?
      f.api.createSession({ projectId: 'workspace-one' }) : f.api.createProject({ path: 'D:\\fixture' });
    await flush(); const during = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 2, `${method} also invalidates through the separate core RPC transport`);
    f.succeed(f.pendingWrites()[0], { accepted: true, sessionId: 'new-session', workspace: { workspaceId: 'new-workspace' } }); await write;
    const after = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 3, `${method} core RPC settlement invalidates`);
    f.reads().forEach(call => f.succeed(call)); await Promise.all([old, during, after]);
  }
  {
    const f = fixture(), old = f.api.readGoal('session-one'); await flush();
    const catalog = f.api.listModels(); await flush();
    const joined = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 1, 'an unrelated catalog read does not invalidate projections');
    f.succeed(f.pendingWrites()[0], { models: [] }); await catalog;
    const stillJoined = f.api.readSelection('session-one'); await flush();
    equal(f.reads().length, 1, 'catalog settlement also preserves the current projection flight');
    f.succeed(f.reads()[0]); await Promise.all([old, joined, stillJoined]);
  }
  {
    const f = fixture(), old = f.api.readGoal('session-one'); await flush();
    f.runtime.__dshE2eeSecret = undefined;
    const denied = await Promise.allSettled([f.api.readPermission('session-one')]);
    equal(denied[0].status, 'rejected', 'missing key cannot join a still-pending authenticated read');
    equal(f.reads().length, 1, 'missing key refusal does not dispatch HTTP');
    f.runtime.__dshE2eeSecret = 'fixture-key-one';
    const fresh = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 2, 'restoring the key requires a new admission');
    f.reads().forEach(call => f.succeed(call)); await Promise.all([old, fresh]);
  }
  {
    const f = fixture(), old = f.api.readGoal('session-one'); await flush();
    f.runtime.__dshE2eeSecret = 'fixture-key-two';
    const next = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 2, 'replacement key never joins the old-key flight');
    equal(f.reads()[1].secret, 'fixture-key-two', 'the new underlying request uses the exact current key');
    f.succeed(f.reads()[0]); await old;
    const joining = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 2, 'old-key finalizer does not remove new-key flight');
    f.succeed(f.reads()[1]); await Promise.all([next, joining]);
    f.runtime.__dshE2eeSecret = 'fixture-key-one';
    const returnedKey = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 3, 'returning to an earlier key is still a fresh admission');
    f.succeed(f.reads()[2]); await returnedKey;
  }
  {
    const f = fixture(); await f.api.connect(() => {}); await flush();
    const old = f.api.readGoal('session-one'); await flush(); f.sockets.at(-1).drop();
    const afterClose = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 2, 'socket close fences the pending flight before auto reconnect');
    f.runTimer(500); await flush();
    const afterReplacement = f.api.readGoal('session-one'); await flush();
    equal(f.sockets.length, 2, 'actual adapter reconnect creates a new socket without explicit connect');
    equal(f.reads().length, 3, 'replacement socket also fences reads within the same adapter generation');
    f.sockets[0].onclose({ code: 1006 });
    const staleCloseJoined = f.api.readPermission('session-one'); await flush();
    equal(f.reads().length, 3, 'a stale socket close cannot clear the current flight');
    f.visible('hidden'); const hidden = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 4, 'background close clears pending projections');
    f.visible('visible'); await flush();
    const visible = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 5, 'foreground resync fences old background reads');
    f.api.disconnect(); const disconnected = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 6, 'disconnect clears pending flights');
    await f.api.connect(() => {});
    const reconnected = f.api.readGoal('session-one'); await flush();
    equal(f.reads().length, 7, 'a new adapter generation cannot join the disconnected flight');
    f.reads().forEach(call => f.succeed(call));
    await Promise.all([old, afterClose, afterReplacement, staleCloseJoined, hidden, visible, disconnected, reconnected]);
    f.api.disconnect();
  }
  {
    const f = fixture(), held = [];
    for (let index = 0; index < 16; index++) held.push(f.api.readPermission(`capacity-${index}`));
    await flush(); equal(f.reads().length, 16, 'sixteen distinct flights are admitted');
    held.push(f.api.readPermission('capacity-overflow'), f.api.readGoal('capacity-overflow')); await flush();
    equal(f.reads().length, 18, 'capacity overflow bypasses coalescing rather than rejecting or growing the map');
    held.push(f.api.readGoal('capacity-0')); await flush();
    equal(f.reads().length, 18, 'an already admitted flight remains joinable at capacity');
    f.succeed(f.reads()[0]); await held[0];
    const freed = f.api.readGoal('capacity-new'), joining = f.api.readPermission('capacity-new'); await flush();
    equal(f.reads().length, 19, 'settlement releases one slot for a new coalesced flight');
    f.reads().filter(call => !call.settled).forEach(call => f.succeed(call)); await Promise.all([...held, freed, joining]);
  }
  {
    const f = fixture(), held = [f.api.readGoal('session-one')]; await flush();
    f.setClock(1100); held.push(f.api.readPermission('session-one')); await flush();
    equal(f.reads().length, 1, 'an in-flight read can join at the exact one-second boundary');
    f.setClock(1101); held.push(f.api.readGoal('session-one')); await flush();
    equal(f.reads().length, 2, 'later explicit read dispatches fresh after a stalled flight ages out');
    equal(f.reads()[0].settled, false, 'age expiration does not cancel or fabricate an error for the original request');
    f.succeed(f.reads()[0]); await held[0];
    held.push(f.api.readPermission('session-one')); await flush();
    equal(f.reads().length, 2, 'expired original finalizer cannot delete the fresh flight');
    f.setClock(1099); held.push(f.api.readGoal('session-one')); await flush();
    equal(f.reads().length, 3, 'monotonic-clock rollback refuses joining');
    f.setClock(NaN); held.push(f.api.readGoal('session-one'), f.api.readPermission('session-one')); await flush();
    equal(f.reads().length, 5, 'nonfinite clock values never admit a shared flight');
    f.runtime.performance.now = () => { throw new Error('controlled clock failure'); };
    held.push(f.api.readGoal('session-one')); await flush();
    equal(f.reads().length, 6, 'clock failure refuses joining without changing the RPC result/error contract');
    f.reads().filter(call => !call.settled).forEach(call => f.succeed(call)); await Promise.all(held);
  }
  {
    const f = fixture(); delete f.runtime.performance;
    const held = [f.api.readGoal('session-one')]; await flush();
    f.setDateClock(100050); held.push(f.api.readPermission('session-one')); await flush();
    equal(f.reads().length, 1, 'Date.now fallback still coalesces concurrent reads');
    f.setDateClock(99999); held.push(f.api.readGoal('session-one')); await flush();
    equal(f.reads().length, 2, 'Date.now rollback refuses joining');
    f.runtime.performance = { now: () => 100 };
    held.push(f.api.readGoal('session-one')); await flush();
    equal(f.reads().length, 3, 'different clock domains cannot join an older flight');
    f.reads().forEach(call => f.succeed(call)); await Promise.all(held);
  }
  {
    const f = fixture(), held = [];
    for (let index = 0; index < 16; index++) held.push(f.api.readPermission(`expired-${index}`));
    await flush(); f.setClock(1101);
    held.push(f.api.readGoal('new-flight'), f.api.readPermission('new-flight')); await flush();
    equal(f.reads().length, 17, 'expired entries release bounded capacity even while original HTTP remains pending');
    for (const call of f.reads().slice(0, 16)) f.succeed(call);
    await Promise.all(held.slice(0, 16));
    const join = f.api.readPermission('new-flight'); await flush();
    equal(f.reads().length, 17, 'pruned old finalizers cannot erase a newer admitted flight');
    f.succeed(f.reads()[16]); await Promise.all([...held, join]);
  }
  equal(checks, 111, 'the complete fixed regression count executes');
  console.log(`DSH projection coalescing: ${checks} checks passed (isolated adapter; no live DSH/phone acceptance).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
