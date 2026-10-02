'use strict';
// Isolated lifecycle regression: fake native children/services, real owned
// D-drive Codex journals, and extracted production gateway wiring. No gateway,
// desktop app, PowerShell, real RPC, browser, model request or DSH is started.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { createDesktopActionScheduler, createDesktopLifecycle } = require('./desktop-ui-action.js');
const { createDesktopRelayService } = require('./codex-desktop-relay.js');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const evidenceRoot = path.resolve(__dirname, '..', '..', 'desktop-lifecycle-check-20261001', `run-${Date.now()}-${process.pid}`);
if (path.parse(evidenceRoot).root.toLowerCase() !== 'd:\\') throw Error('Lifecycle fixtures must stay on D:.');
fs.mkdirSync(evidenceRoot, { recursive: true });
const THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b45';
const OTHER_THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b46';
let checks = 0, fixtureCount = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('fixture-timeout'); await tick(); }
}
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
function fakeChild() {
  const child = new EventEmitter();
  child.closed = false;
  child.promise = new Promise(resolve => child.once('close', () => { child.closed = true; resolve(); }));
  return child;
}
function lifecycleFixture(overrides = {}) {
  const scheduler = createDesktopActionScheduler();
  const dotGate = deferred(), relayGate = deferred(), helperGate = deferred();
  const events = [], states = [];
  const dot = { stopping: false, stop() { this.stopping = true; events.push('dot-stop'); },
    async close() { events.push('dot-close'); await dotGate.promise; return { closed: true }; } };
  const relay = { stopping: false, stop() { this.stopping = true; events.push('relay-stop'); },
    async drain() { events.push('relay-drain'); await relayGate.promise; return { drained: true }; } };
  const lifecycle = createDesktopLifecycle({ scheduler, dotRuntime: dot, codexRelay: relay,
    async spawnRestart() { events.push('spawn'); await helperGate.promise; events.push('helper-started'); },
    exit(code) { assert.equal(code, 0); events.push('exit'); }, onState: state => states.push(state), timeoutMs: 3000, ...overrides });
  return { lifecycle, scheduler, dot, relay, dotGate, relayGate, helperGate, events, states };
}
function relayFixture(options = {}) {
  const base = path.join(evidenceRoot, 'relay-' + (++fixtureCount));
  const cwd = path.join(base, 'project'); fs.mkdirSync(cwd, { recursive: true });
  const state = { history: [], calls: [], sends: 0, inspections: 0 };
  const scheduler = options.scheduler || createDesktopActionScheduler();
  const rpc = async (method, params) => {
    state.calls.push(method);
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd } };
    if (method === 'thread/turns/list') {
      if (options.history) return options.history(state);
      return { data: [{ id: 'fixture-turn', itemsView: 'full', items: state.history.slice() }] };
    }
    if (method === 'thread/queue/list') return { data: [], nextCursor: null };
    throw Error('Unexpected or mutating RPC.');
  };
  const driver = {
    inspect: () => scheduler.runDesktopAction('codex-inspect', async () => {
      state.inspections++; if (options.inspect) await options.inspect(); return { available: true };
    }),
    send: request => scheduler.runDesktopAction('codex-send', async () => {
      state.sends++; if (options.send) return options.send(request, state);
      state.history.push({ id: 'fixture-message', type: 'userMessage', content: [{ type: 'text', text: request.text }] });
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: cwd };
    })
  };
  const service = createDesktopRelayService(base, { rpc, driver, confirmTimeoutMs: options.confirmTimeoutMs || 2500, pollIntervalMs: 2 });
  return { base, cwd, state, scheduler, service,
    request: (id = 'fixture-request', threadId = THREAD) => ({ action: 'send', id, threadId, cwd, text: 'Synthetic lifecycle request.' }) };
}
function stopFixture() {
  const base = path.join(evidenceRoot, 'stop-' + (++fixtureCount)), logs = path.join(base, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const f = lifecycleFixture();
  const context = { fs, path, URL, Buffer, LOG_DIR: logs, PORT: 19099, HTTPS_PORT: 0,
    GATEWAY_BOOT_ID: '63dc1c8c-33aa-4238-91c4-44dd7047fa1b', INSTANCE_ID: '30b967a9-060a-4a2b-bf57-c03df0ef5fe4', process: { pid: 7 },
    desktopLifecycle: f.lifecycle, isLoopback: require('./request-origin.js').isLoopback };
  vm.createContext(context);
  vm.runInContext(extractFunction(source, 'requestControlledGatewayAction') + '\n' + extractFunction(source, 'handleConsole') +
    '\nglobalThis.requestControlledGatewayStop = requestControlledGatewayAction;', context);
  const body = { action: 'stop-gateway', expectedBootId: context.GATEWAY_BOOT_ID, expectedInstanceId: context.INSTANCE_ID };
  const req = () => ({ headers: { host: '127.0.0.1:19099', origin: 'http://127.0.0.1:19099' }, socket: { remoteAddress: '127.0.0.1' } });
  return { ...f, context, body, req, logs, flag: path.join(logs, 'user-stopped.flag') };
}

async function main() {
  await check('scheduler admission stops permanently and drain waits CLOSE rather than EXIT', async () => {
    const scheduler = createDesktopActionScheduler(), child = fakeChild(); let finished = false, callbacks = 0;
    const operation = scheduler.runDesktopAction('codex-send', () => child.promise);
    const drain = scheduler.drain(); drain.then(() => { finished = true; });
    assert.equal(scheduler.drain(), drain); assert.deepEqual(scheduler.status(), { stopping: true, busy: true });
    await assert.rejects(scheduler.runDesktopAction('dot-read', () => { callbacks++; }), error => error.code === 'desktop-stopping' && error.submitted === false && error.status === 503);
    await assert.rejects(scheduler.runDesktopAction('untrusted', () => { callbacks++; }), error => error.code === 'invalid-desktop-action');
    child.emit('exit', 0); await tick(); assert.equal(finished, false); assert.equal(callbacks, 0);
    child.emit('close', 0); await operation; assert.deepEqual(await drain, { drained: true });
    assert.deepEqual(scheduler.status(), { stopping: true, busy: false });
    await assert.rejects(scheduler.runDesktopAction('dot-send', async () => {}), error => error.code === 'desktop-stopping');
  });
  await check('one restart waits actual child CLOSE, Dot close, full receipt tail, and helper startup', async () => {
    const f = lifecycleFixture(), child = fakeChild();
    const operation = f.scheduler.runDesktopAction('codex-send', () => child.promise);
    assert.equal(f.lifecycle.scheduleRestart('fixture', { notifyAddress: true }), true);
    const completion = f.lifecycle.completion();
    assert.equal(f.lifecycle.scheduleRestart('duplicate'), true); assert.equal(f.lifecycle.completion(), completion);
    assert.equal(f.lifecycle.scheduleShutdown(), false);
    assert.equal(f.dot.stopping, true); assert.equal(f.relay.stopping, true); assert.equal(f.scheduler.status().stopping, true);
    await tick(); child.emit('exit', 0); f.dotGate.resolve(); await tick(); assert(!f.events.includes('spawn'));
    child.emit('close', 0); await operation; await tick(); assert(!f.events.includes('spawn'));
    f.relayGate.resolve(); await until(() => f.events.includes('spawn')); assert(!f.events.includes('exit'));
    f.helperGate.resolve(); assert.deepEqual(await completion, { closed: true, restartHelperStarted: true });
    assert.equal(f.events.filter(event => event === 'spawn').length, 1); assert.equal(f.events.filter(event => event === 'exit').length, 1);
    assert.equal(f.lifecycle.status().phase, 'closed'); assert.equal(f.lifecycle.scheduleRestart('after close'), true);
    assert.equal(f.events.filter(event => event === 'spawn').length, 1);
  });
  await check('signal shutdown shares one drain and never starts a restart helper', async () => {
    const f = lifecycleFixture(); assert.equal(f.lifecycle.scheduleShutdown(), true); const completion = f.lifecycle.completion();
    assert.equal(f.lifecycle.scheduleShutdown(), true); assert.equal(f.lifecycle.completion(), completion);
    assert.equal(f.lifecycle.scheduleRestart('too late'), false); await tick(); assert(!f.events.includes('exit'));
    f.relayGate.resolve(); await tick(); assert(!f.events.includes('exit'));
    f.dotGate.resolve(); assert.deepEqual(await completion, { closed: true, restartHelperStarted: false });
    assert(!f.events.includes('spawn')); assert.equal(f.events.filter(event => event === 'exit').length, 1);
  });
  await check('timeout retains stopped admission and late child CLOSE never spawns or exits', async () => {
    const f = lifecycleFixture({ timeoutMs: 10 }), child = fakeChild();
    const operation = f.scheduler.runDesktopAction('dot-send', () => child.promise);
    f.dotGate.resolve(); f.relayGate.resolve(); f.lifecycle.scheduleRestart('timeout');
    assert.deepEqual(await f.lifecycle.completion(), { closed: false, code: 'desktop-drain-timeout' });
    assert.equal(f.scheduler.status().busy, true); assert.equal(f.lifecycle.scheduleRestart('retry'), false);
    assert.equal(f.lifecycle.scheduleShutdown(), false); child.emit('close', 0); await operation; await tick();
    assert(!f.events.includes('spawn')); assert(!f.events.includes('exit')); assert.equal(f.lifecycle.status().phase, 'failed');
    await assert.rejects(f.scheduler.runDesktopAction('dot-read', async () => {}), error => error.code === 'desktop-stopping');
  });
  for (const owner of ['dot', 'relay', 'scheduler']) {
    await check(owner + ' drain failure retains evidence and refuses restart/exit', async () => {
      const f = lifecycleFixture();
      if (owner === 'dot') f.dot.close = async () => { throw Error('PRIVATE fixture failure'); };
      if (owner === 'relay') f.relay.drain = async () => { throw Error('PRIVATE fixture failure'); };
      if (owner === 'scheduler') {
        const scheduler = { stop() {}, drain: async () => { throw Error('PRIVATE fixture failure'); } };
        const other = lifecycleFixture({ scheduler });
        other.dotGate.resolve(); other.relayGate.resolve(); other.lifecycle.scheduleRestart('failure');
        assert.deepEqual(await other.lifecycle.completion(), { closed: false, code: 'desktop-drain-failed' });
        assert(!other.events.includes('spawn')); assert(!other.events.includes('exit')); return;
      }
      f.dotGate.resolve(); f.relayGate.resolve(); f.lifecycle.scheduleRestart('failure');
      assert.deepEqual(await f.lifecycle.completion(), { closed: false, code: 'desktop-drain-failed' });
      assert(!f.events.includes('spawn')); assert(!f.events.includes('exit')); assert.equal(f.scheduler.status().stopping, true);
      assert(!JSON.stringify(f.states).includes('PRIVATE'));
    });
  }
  await check('a false close claim and a failed restart helper never permit exit', async () => {
    const incomplete = lifecycleFixture(); incomplete.dot.close = async () => ({ closed: false }); incomplete.relayGate.resolve();
    incomplete.lifecycle.scheduleRestart('incomplete'); assert.equal((await incomplete.lifecycle.completion()).closed, false);
    assert(!incomplete.events.includes('spawn')); assert(!incomplete.events.includes('exit'));
    const failed = lifecycleFixture({ spawnRestart: async () => { throw Error('PRIVATE helper failure'); } });
    failed.dotGate.resolve(); failed.relayGate.resolve(); failed.lifecycle.scheduleRestart('helper failure');
    assert.deepEqual(await failed.lifecycle.completion(), { closed: false, code: 'restart-helper-failed' }); assert(!failed.events.includes('exit'));
  });
  await check('reentrant state notification cannot create a second transaction', async () => {
    let lifecycle, notifications = 0;
    const f = lifecycleFixture({ onState(state) { notifications++; if (state.phase === 'draining') lifecycle.scheduleRestart('reentrant'); } });
    lifecycle = f.lifecycle; f.dotGate.resolve(); f.relayGate.resolve(); f.helperGate.resolve(); lifecycle.scheduleRestart('first');
    assert.equal((await lifecycle.completion()).closed, true); assert.equal(f.events.filter(event => event === 'spawn').length, 1);
    assert.equal(notifications, 3);
  });
  await check('all other owners stop even if one stop callback fails', async () => {
    const f = lifecycleFixture({ scheduler: { stop() { throw Error('fixture'); }, drain: async () => ({ drained: true }) } });
    f.lifecycle.scheduleShutdown(); assert.equal(f.dot.stopping, true); assert.equal(f.relay.stopping, true);
    assert.deepEqual(await f.lifecycle.completion(), { closed: false, code: 'desktop-drain-failed' }); assert(!f.events.includes('exit'));
  });
  await check('failed Dot initialization preserves owned evidence and blocks helper and exit', async () => {
    const ownerFile = path.join(evidenceRoot, 'synthetic-incomplete-owner');
    const ownerBytes = Buffer.from('Synthetic unresolved owner evidence.'); fs.writeFileSync(ownerFile, ownerBytes);
    const child = fakeChild(); let closeCalls = 0, ownedDrained = false;
    const dot = { stop() {}, status: () => ({ initialization: 'failed' }),
      async drain() { await child.promise; ownedDrained = true; },
      async close() { closeCalls++; fs.unlinkSync(ownerFile); return { closed: true }; } };
    const f = lifecycleFixture({ dotRuntime: dot }); f.relayGate.resolve(); f.lifecycle.scheduleRestart('failed initialization');
    child.emit('exit', 0); await tick(); assert.equal(ownedDrained, false); assert.equal(f.lifecycle.status().phase, 'draining');
    child.emit('close', 0); assert.deepEqual(await f.lifecycle.completion(), { closed: false, code: 'desktop-drain-failed' });
    assert.equal(ownedDrained, true); assert.equal(closeCalls, 0); assert.deepEqual(fs.readFileSync(ownerFile), ownerBytes);
    assert(!f.events.includes('spawn')); assert(!f.events.includes('exit')); assert.equal(f.scheduler.status().stopping, true);
    assert.equal(f.lifecycle.scheduleShutdown(), false); assert.equal(f.lifecycle.scheduleRestart('retry'), false);
  });
  await check('real Codex relay drains final receipt polling and its complete queued tail', async () => {
    const child = fakeChild(), receiptGate = deferred(); let nativeReturned = false, confirmRead = false;
    const f = relayFixture({
      send: async request => { await child.promise; nativeReturned = true; return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd }; },
      history: async () => {
        if (nativeReturned) { confirmRead = true; return receiptGate.promise; }
        return { data: [] };
      }
    });
    const first = f.service.send(f.request('first')); await until(() => f.state.sends === 1);
    const second = f.service.send(f.request('queued-before-stop', OTHER_THREAD));
    f.service.stop(); f.scheduler.stop(); let drained = false;
    const draining = f.service.drain().then(value => { drained = true; return value; });
    await assert.rejects(f.service.send(f.request('new-after-stop')), error => error.code === 'desktop-stopping' && error.status === 503);
    child.emit('exit', 0); await tick(); assert.equal(drained, false);
    child.emit('close', 0); await until(() => confirmRead); assert.equal(drained, false);
    receiptGate.resolve({ data: [{ id: 'finished-turn', itemsView: 'full', items: [{ id: 'finished-user', type: 'userMessage', content: [{ type: 'text', text: f.request().text }] }] }] });
    assert.equal((await first).state, 'accepted'); assert.equal((await second).code, 'desktop-stopping');
    assert.deepEqual(await draining, { drained: true }); assert.equal(f.state.sends, 1);
    const calls = f.state.calls.length, inspections = f.state.inspections;
    assert.equal((await f.service.get('first', THREAD)).state, 'accepted');
    assert.deepEqual(await f.service.status(), { available: false, reason: 'desktop-stopping' });
    assert.equal(f.state.calls.length, calls); assert.equal(f.state.inspections, inspections);
  });
  await check('real Codex status inspection drains its owned child CLOSE', async () => {
    const child = fakeChild(), f = relayFixture({ inspect: () => child.promise });
    const status = f.service.status(); await until(() => f.state.inspections === 1);
    let drained = false; const operation = f.service.drain().then(value => { drained = true; return value; });
    child.emit('exit', 0); await tick(); assert.equal(drained, false);
    child.emit('close', 0); await status; assert.deepEqual(await operation, { drained: true });
  });
  await check('an admitted baseline that finishes after stop cannot begin native Send', async () => {
    const gate = deferred(); let baselineStarted = false;
    const f = relayFixture({ history: () => { baselineStarted = true; return gate.promise; } });
    const sent = f.service.send(f.request()); await until(() => baselineStarted); f.service.stop();
    let drained = false; const operation = f.service.drain().then(value => { drained = true; return value; });
    await tick(); assert.equal(drained, false); gate.resolve({ data: [] });
    assert.equal((await sent).code, 'desktop-stopping'); assert.equal(f.state.sends, 0); assert.deepEqual(await operation, { drained: true });
  });
  await check('already-running receipt reconciliation is included in Codex drain', async () => {
    const gate = deferred(); let reconcile = false, readPending = false;
    const f = relayFixture({ confirmTimeoutMs: 15,
      send: async request => ({ submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd }),
      history: () => { if (reconcile) { readPending = true; return gate.promise; } return { data: [] }; } });
    assert.equal((await f.service.send(f.request())).state, 'unknown'); reconcile = true;
    const receipt = f.service.get('fixture-request', THREAD); await until(() => readPending);
    let drained = false; const operation = f.service.drain().then(value => { drained = true; return value; });
    await tick(); assert.equal(drained, false); gate.resolve({ data: [] }); await receipt;
    assert.deepEqual(await operation, { drained: true });
    const calls = f.state.calls.length; assert.equal((await f.service.get('fixture-request', THREAD)).state, 'unknown'); assert.equal(f.state.calls.length, calls);
  });
  await check('a failed owned Codex journal prevents a graceful-drain claim', async () => {
    const f = relayFixture(); fs.mkdirSync(path.join(f.base, 'logs', 'codex-desktop-relay.json.tmp'), { recursive: true });
    await assert.rejects(f.service.send(f.request()), error => error.code === 'journal-unavailable');
    await assert.rejects(f.service.drain(), error => error.code === 'journal-unavailable'); assert.equal(f.state.sends, 0);
  });
  await check('production Dot wiring stays lazy, cached status starts zero native/provider operations', async () => {
    const cp = require('node:child_process'), originals = {}; let nativeCalls = 0, creations = 0;
    for (const method of ['spawn', 'execFileSync', 'execSync', 'exec', 'execFile', 'fork']) {
      originals[method] = cp[method]; cp[method] = () => { nativeCalls++; throw Error('Unexpected fixture native call.'); };
    }
    try {
      const real = require('./dot-desktop-runtime.js');
      const base = path.join(evidenceRoot, 'unprovisioned-production');
      const context = { BASE: base, require(name) {
        assert.equal(name, './dot-desktop-runtime.js');
        return { createDotDesktopRuntime(options) { creations++; assert.deepEqual(Object.keys(options), ['base']); return real.createDotDesktopRuntime(options); } };
      } };
      vm.createContext(context);
      const start = source.indexOf('const dotDesktopRuntime =');
      const end = source.indexOf('const dotDesktop = dotDesktopRuntime.service;', start) + 'const dotDesktop = dotDesktopRuntime.service;'.length;
      assert(start > 0 && end > start); vm.runInContext(source.slice(start, end) + '\nglobalThis.fixtureRuntime = dotDesktopRuntime;', context);
      const runtime = context.fixtureRuntime; assert.equal(creations, 1); assert.equal(runtime.status().initialization, 'empty');
      assert.equal((await runtime.service.status()).sendAvailable, false); assert.equal(nativeCalls, 0); assert.equal(fs.existsSync(base), false);
      assert.deepEqual(await runtime.close(), { closed: true }); assert.equal(nativeCalls, 0); assert.equal(fs.existsSync(base), false);
    } finally { for (const [method, original] of Object.entries(originals)) cp[method] = original; }
  });
  await check('actual gateway restart callback waits helper SPAWN and duplicate requests start it once', async () => {
    const scheduler = createDesktopActionScheduler(), dotGate = deferred(), relayGate = deferred(), child = new EventEmitter();
    let spawns = 0, exits = 0, unrefs = 0; child.unref = () => { unrefs++; };
    const context = { path, BASE: evidenceRoot, PORT: 19099, log() {},
      process: { execPath: 'D:\\isolated-fixture\\node.exe', exit(code) { assert.equal(code, 0); exits++; } },
      setTimeout: callback => setImmediate(callback),
      dotDesktopRuntime: { stop() {}, close: async () => { await dotGate.promise; return { closed: true }; } },
      codexDesktopRelay: { stop() {}, drain: async () => { await relayGate.promise; return { drained: true }; } },
      require(name) {
        if (name === './desktop-ui-action.js') return { ...scheduler, createDesktopLifecycle };
        assert.equal(name, 'child_process');
        return { spawn(exe, args, options) { spawns++; assert.equal(exe, context.process.execPath); assert(args.includes('--notify-address'));
          assert.equal(args[args.indexOf('--port') + 1], '19099'); assert.equal(options.cwd, evidenceRoot); assert.equal(options.windowsHide, true); return child; } };
      } };
    vm.createContext(context);
    const start = source.indexOf('const desktopLifecycle ='); const end = source.indexOf('\nasync function buildConsoleStatus', start);
    assert(start > 0 && end > start); vm.runInContext(source.slice(start, end) + '\nglobalThis.fixtureLifecycle = desktopLifecycle;', context);
    assert.equal(context.restartSelfSoon('fixture', { notifyAddress: true }), true);
    assert.equal(context.restartSelfSoon('duplicate'), true); await tick(); assert.equal(spawns, 0); assert.equal(exits, 0);
    dotGate.resolve(); await tick(); assert.equal(spawns, 0); relayGate.resolve(); await until(() => spawns === 1);
    assert.equal(exits, 0); assert.equal(unrefs, 0); child.emit('spawn');
    assert.equal((await context.fixtureLifecycle.completion()).closed, true); assert.equal(unrefs, 1); assert.equal(exits, 1); assert.equal(spawns, 1);
    const signals = source.match(/process\.on\('SIG(?:INT|TERM)',[^\n]+/g);
    assert.equal(signals.length, 2); assert(signals.every(handler => handler.includes('desktopLifecycle.scheduleShutdown()') && !handler.includes('process.exit')));
  });
  await check('actual health branch stays available during drain and failed shutdown', async () => {
    const at = source.indexOf("if (u.pathname === '/__health') {"); const open = source.indexOf('{', at), close = sliceBalanced(source, open, '{', '}');
    assert(at > 0 && close > open);
    const f = lifecycleFixture({ timeoutMs: 10 }); f.lifecycle.scheduleShutdown();
    const context = { isLoopback: () => true, portAlive: async () => false, TARGET_PORT: 1, PORT: 2, HTTPS_PORT: 0,
      INSTANCE_ID: 'persistent-installation', GATEWAY_BOOT_ID: 'owned-health-boot', process: { pid: 1 } };
    vm.createContext(context); vm.runInContext("function actualHealth(req,res) { const u={pathname:'/__health'}; " + source.slice(at, close + 1) + ' }', context);
    async function readHealth() {
      let code; const gate = deferred();
      context.actualHealth({}, { writeHead(value) { code = value; }, end(body) { gate.resolve(JSON.parse(body)); } });
      const result = await gate.promise; assert.equal(code, 200); assert.equal(result.service, 'pocket-bridge-gateway'); assert.equal(result.instanceId, 'persistent-installation'); assert.equal(result.bootId, 'owned-health-boot'); assert(!JSON.stringify(result).includes(evidenceRoot));
    }
    await readHealth(); assert.equal((await f.lifecycle.completion()).closed, false); await readHealth(); assert(!f.events.includes('exit'));
    f.dotGate.resolve(); f.relayGate.resolve();
  });
  await check('scoped stop rejects foreign socket relay host and missing or foreign Origin before admission', async () => {
    const f = stopFixture();
    const cases = [
      { headers: f.req().headers, socket: { remoteAddress: '192.168.1.8' } },
      { ...f.req(), headers: { ...f.req().headers, 'cf-ray': 'synthetic-relay' } },
      { ...f.req(), headers: { ...f.req().headers, host: 'foreign.example' } },
      { ...f.req(), headers: { host: '127.0.0.1:19099' } },
      { ...f.req(), headers: { ...f.req().headers, origin: 'https://foreign.example' } },
      { ...f.req(), headers: { ...f.req().headers, origin: 'http://127.0.0.1:19100' } },
      { ...f.req(), headers: { host: '127.0.0.1:19099/path', origin: 'http://127.0.0.1:19099/path' } }
    ];
    for (const request of cases) assert.equal(f.context.requestControlledGatewayStop(request, f.body).status, 403);
    assert.equal(f.lifecycle.status().phase, 'running'); assert.equal(f.scheduler.status().stopping, false);
    assert.equal(fs.existsSync(f.flag), false); assert.equal(f.events.length, 0);
  });
  await check('scoped stop requires exactly two matching UUID identities and no extra arguments', async () => {
    const f = stopFixture();
    for (const body of [null, [], { ...f.body, cwd: 'D:\\not-allowed' }, { ...f.body, expectedBootId: f.body.expectedBootId + '\n' },
      { ...f.body, expectedBootId: 1 }, { action: 'stop-gateway', expectedBootId: f.body.expectedBootId }]) {
      assert.equal(f.context.requestControlledGatewayStop(f.req(), body).status, 400);
    }
    for (const key of ['expectedBootId', 'expectedInstanceId']) {
      const response = f.context.requestControlledGatewayStop(f.req(), { ...f.body, [key]: crypto.randomUUID() });
      assert.equal(response.status, 409); assert.equal(response.body.code, 'gateway-identity-mismatch');
    }
    assert.equal(f.lifecycle.status().phase, 'running'); assert.equal(fs.existsSync(f.flag), false); assert.equal(f.events.length, 0);
  });
  await check('actual console stop returns scheduled 202 before CLOSE and preserves the own stop flag', async () => {
    const f = stopFixture(), child = fakeChild();
    const operation = f.scheduler.runDesktopAction('codex-send', () => child.promise);
    const request = Object.assign(new EventEmitter(), f.req(), { method: 'POST', url: '/__console/action' });
    const response = deferred(); let status;
    assert.equal(f.context.handleConsole(request, { writeHead(value) { status = value; }, end(body) { response.resolve(JSON.parse(body)); } }, new URL('http://127.0.0.1:19099/__console/action')), true);
    request.emit('data', Buffer.from(JSON.stringify(f.body))); request.emit('end');
    const result = await response.promise; assert.equal(status, 202); assert.equal(result.shutdownScheduled, true);
    assert.equal(result.shutdown.phase, 'draining'); assert.equal(result.bootId, f.body.expectedBootId); assert.equal(result.instanceId, f.body.expectedInstanceId); assert.equal(result.pid, 7);
    assert(!JSON.stringify(result).includes(f.logs)); assert.equal(fs.existsSync(f.flag), true); assert(!f.events.includes('exit'));
    const preserved = Buffer.from('Existing owned user-stop marker.'); fs.writeFileSync(f.flag, preserved);
    assert.equal(f.context.requestControlledGatewayStop(f.req(), f.body).status, 202); assert.deepEqual(fs.readFileSync(f.flag), preserved);
    f.dotGate.resolve(); f.relayGate.resolve(); child.emit('exit', 0); await tick(); assert(!f.events.includes('exit'));
    child.emit('close', 0); await operation; assert.equal((await f.lifecycle.completion()).closed, true);
    assert(!f.events.includes('spawn')); assert.equal(f.events.filter(event => event === 'exit').length, 1); assert.deepEqual(fs.readFileSync(f.flag), preserved);
    // The actual outer console route also refuses a non-local socket.
    const foreign = stopFixture(), denied = deferred(); let deniedStatus;
    const foreignRequest = Object.assign(new EventEmitter(), foreign.req(), { method: 'POST', socket: { remoteAddress: '192.168.1.8' } });
    foreign.context.handleConsole(foreignRequest, { writeHead(value) { deniedStatus = value; }, end(body) { denied.resolve(body); } }, new URL('http://127.0.0.1:19099/__console/action'));
    await denied.promise; assert.equal(deniedStatus, 403); assert.equal(foreign.lifecycle.status().phase, 'running'); assert.equal(fs.existsSync(foreign.flag), false);
  });
  await check('failed scoped stop never exits or reclaims evidence and unsafe marker refuses admission', async () => {
    const f = stopFixture(); f.dot.close = async () => { throw Error('synthetic retained private state'); }; f.relayGate.resolve();
    assert.equal(f.context.requestControlledGatewayStop(f.req(), f.body).status, 202);
    const flag = fs.readFileSync(f.flag); assert.equal((await f.lifecycle.completion()).closed, false);
    const retry = f.context.requestControlledGatewayStop(f.req(), f.body); assert.equal(retry.status, 503); assert.equal(retry.body.shutdownScheduled, false);
    assert.equal(retry.body.shutdown.phase, 'failed'); assert.deepEqual(fs.readFileSync(f.flag), flag); assert(!f.events.includes('exit')); assert(!f.events.includes('spawn'));
    const unsafe = stopFixture(); fs.mkdirSync(unsafe.flag);
    assert.equal(unsafe.context.requestControlledGatewayStop(unsafe.req(), unsafe.body).status, 503);
    assert.equal(unsafe.lifecycle.status().phase, 'running'); assert.equal(unsafe.scheduler.status().stopping, false); assert.equal(fs.lstatSync(unsafe.flag).isDirectory(), true);
  });
  await check('scoped restart rejects a different PID, malformed arguments and foreign Origin before admission', async () => {
    const f = stopFixture(), body = { ...f.body, action: 'restart-gateway', expectedPid: 7 };
    for (const request of [{ ...f.req(), headers: { ...f.req().headers, origin: 'http://foreign.example' } },
      { ...f.req(), socket: { remoteAddress: '192.168.1.8' } }]) assert.equal(f.context.requestControlledGatewayAction(request, body).status, 403);
    assert.equal(f.context.requestControlledGatewayAction(f.req(), { ...body, expectedPid: 8 }).status, 409);
    for (const bad of [{ ...body, expectedPid: '7' }, { ...body, expectedPid: 0 }, { ...body, expectedPid: Number.MAX_SAFE_INTEGER },
      { ...body, arbitraryPath: evidenceRoot }, { ...f.body, action: 'restart-gateway' }]) {
      assert.equal(f.context.requestControlledGatewayAction(f.req(), bad).status, 400);
    }
    assert.equal(f.lifecycle.status().phase, 'running'); assert.equal(fs.existsSync(f.flag), false); assert.equal(f.events.length, 0);
  });
  await check('scoped restart waits CLOSE then uses one coordinator and never writes the stop flag', async () => {
    const f = stopFixture(), child = fakeChild(), body = { ...f.body, action: 'restart-gateway', expectedPid: 7 };
    const operation = f.scheduler.runDesktopAction('dot-read', () => child.promise);
    const accepted = f.context.requestControlledGatewayAction(f.req(), body);
    assert.equal(accepted.status, 202); assert.equal(accepted.body.restartScheduled, true); assert.equal(accepted.body.restartBootId, f.body.expectedBootId);
    assert.equal(accepted.body.shutdown.kind, 'restart'); assert.equal(fs.existsSync(f.flag), false);
    assert.equal(f.context.requestControlledGatewayAction(f.req(), body).status, 202); f.dotGate.resolve(); f.relayGate.resolve();
    child.emit('exit', 0); await tick(); assert(!f.events.includes('spawn')); assert(!f.events.includes('exit'));
    child.emit('close', 0); await operation; await until(() => f.events.includes('spawn')); assert(!f.events.includes('exit'));
    f.helperGate.resolve(); assert.equal((await f.lifecycle.completion()).closed, true);
    assert.equal(f.events.filter(value => value === 'spawn').length, 1); assert.equal(f.events.filter(value => value === 'exit').length, 1); assert.equal(fs.existsSync(f.flag), false);
  });
  await check('scoped restart preserves an existing stop marker and rejects a conflicting stop transaction', async () => {
    const f = stopFixture(), body = { ...f.body, action: 'restart-gateway', expectedPid: 7 }, marker = Buffer.from('Existing owned stop intent.');
    fs.writeFileSync(f.flag, marker); f.dotGate.resolve(); f.relayGate.resolve(); f.helperGate.resolve();
    assert.equal(f.context.requestControlledGatewayAction(f.req(), body).status, 202); await f.lifecycle.completion(); assert.deepEqual(fs.readFileSync(f.flag), marker);
    const stopping = stopFixture(); stopping.context.requestControlledGatewayAction(stopping.req(), stopping.body);
    assert.equal(stopping.context.requestControlledGatewayAction(stopping.req(), { ...stopping.body, action: 'restart-gateway', expectedPid: 7 }).status, 409);
    stopping.dotGate.resolve(); stopping.relayGate.resolve(); await stopping.lifecycle.completion(); assert(!stopping.events.includes('spawn'));
  });
  await check('console status uses independent per-boot identity without changing installation identity', async () => {
    async function boot() {
      const context = { crypto, INSTANCE_ID: 'persistent-installation', PORT: 2, HTTPS_PORT: 0, TARGET_PORT: 1, ACCESS_KEY: 'fixture',
        LOG_DIR: evidenceRoot, LOG_FILE: 'not-read', NOTIFY_TARGETS_FILE: 'not-read', SUBSCRIPTIONS_FILE: 'not-read', targetCache: { at: Date.now(), list: [] },
        os: { hostname: () => 'fixture' }, process: { platform: 'win32' }, path, fs: { readFileSync() { throw Error('No fixture configuration.'); } },
        cfg: { detectNetwork: () => ({ lanV4: [] }), loadConfig: () => ({}) }, readJsonFile: () => ({}), refreshDshRuntime: async () => false,
        refreshTargets: async () => {}, e2eeBridge: { readSecret: () => null }, currentPairCode: () => null, DSH_UPSTREAM_AUTH_OK: null,
        dshRuntime: { serializeRuntime: () => null, peekRuntime: () => null }, sessions: { list: () => [] }, codexProxyInfo: () => ({}), tailFile: () => '',
        desktopLifecycle: { status: () => ({ phase: 'running', kind: null, code: null }) },
        require(name) { if (name === './make-cert.js') return { inspect: () => null, CA_CERT: null }; if (name === './targets.js') return { localize: () => [] }; throw Error('Unexpected fixture module.'); } };
      vm.createContext(context);
      const declaration = source.match(/const GATEWAY_BOOT_ID = crypto\.randomUUID\(\);/); assert(declaration);
      vm.runInContext(declaration[0] + '\nasync ' + extractFunction(source, 'buildConsoleStatus'), context);
      return context.buildConsoleStatus('en');
    }
    const first = await boot(), second = await boot(); assert.equal(first.instanceId, second.instanceId);
    assert.match(first.gateway.bootId, /^[a-f0-9-]{36}$/); assert.notEqual(first.gateway.bootId, second.gateway.bootId);
    assert.equal(first.gateway.desktopShutdown.phase, 'running'); assert.match(source, /result\.restartBootId = GATEWAY_BOOT_ID/);
    assert.match(source, /result\.restartScheduled = result\.restarting === true/); assert(!source.includes('restartInstanceId'));
  });
  fs.writeFileSync(path.join(evidenceRoot, 'result.json'), JSON.stringify({ checks, passed: checks, failed: 0,
    nativeDesktopActions: 0, modelRequests: 0, liveGatewayStarted: false, actualOsProviderTest: false }, null, 2));
  console.log(`${checks} isolated desktop lifecycle checks passed. Evidence: ${evidenceRoot}`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
