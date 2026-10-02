'use strict';
// Execute the actual daemon/provider orchestration with disposable files,
// synthetic HTTP and owned ChildProcess doubles. No network, GUI, process
// lookup, signal, real spawn or live gateway/tunnel is used by this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const repo = path.resolve(__dirname, '..');
const temporary = path.resolve(process.env.DAEMON_OPERATION_TEST_DIRECTORY || path.join(repo, 'logs', 'isolated-tests'));
fs.mkdirSync(temporary, { recursive: true });
const evidence = fs.mkdtempSync(path.join(temporary, 'daemon-stop-'));
const daemonSource = fs.readFileSync(path.join(__dirname, 'gateway-daemon.js'), 'utf8');
const tunnelSource = fs.readFileSync(path.join(__dirname, 'tunnel.js'), 'utf8');
const INSTANCE = '92a0bb7a-7e41-4fc0-8d98-204f29a71894', BOOT = 'd46e8d73-812c-458a-b5f7-0b0776381d7a';
let checks = 0, count = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function virtualClock() {
  let now = 0; const timers = new Map();
  return { set(operation, milliseconds) { const handle = { fixtureTimer: true, unref() {} }; timers.set(handle, { operation, at: now + milliseconds }); return handle; },
    clear(handle) { timers.delete(handle); }, advance(milliseconds) { now += milliseconds;
      for (const [handle, value] of [...timers]) if (value.at <= now && timers.delete(handle)) value.operation(); },
    pending() { return timers.size; } };
}
async function until(condition) { for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); } throw Error('Fixture did not reach the expected stage.'); }
async function check(name, operation) { await operation(); checks++; console.log('PASS ' + name); }
function fixture({ statusOnly = false, realTunnel = false } = {}) {
  const base = path.join(evidence, 'case-' + (++count)), logs = path.join(base, 'logs'); fs.mkdirSync(logs, { recursive: true });
  const flag = path.join(logs, 'user-stopped.flag'), directory = path.join(logs, 'daemon-operation.lock');
  fs.writeFileSync(path.join(logs, 'instance.json'), JSON.stringify({ instanceId: INSTANCE }));
  const state = { gateway: { port: 8081, info: { service: 'pocket-bridge-gateway', instanceId: INSTANCE, bootId: BOOT, pid: 501, port: 8081 } },
    tunnelUp: false, targetPort: 8081, tunnelUrl: 'https://synthetic.trycloudflare.com', probes: 0, stopTunnels: 0,
    tunnelCreates: 0, spawns: [], stopPosts: [], identityCreates: 0, writes: [], calls: [], kills: 0, children: [], healthByPort: new Map(), requestsDestroyed: 0 };
  const cfg = { BASE: base, LOG_DIR: logs,
    ensureInstanceIdentity() { state.identityCreates++; return { instanceId: INSTANCE }; },
    loadConfig: () => state.config || ({ tunnelDomainMode: 'dynamic', tunnelProvider: 'cloudflare-quick' }),
    detectNetwork: () => ({ lanV4: [] }), detectTunnelProviders: () => ({ cloudflared: path.join(base, 'cloudflared', 'cloudflared.exe') }) };
  const fakeProcess = { argv: statusOnly ? ['node', 'gateway-daemon.js', '--status'] : ['node', 'gateway-daemon.js'],
    pid: 101, execPath: path.join(base, 'runtime', 'node.exe'), platform: 'win32', exitCode: 0, stdout: { write() {} },
    kill(pid, signal) { assert.equal(signal, 0, 'Only a fake liveness check is permitted'); return true; } };
  function child(pid = 501) {
    const value = new EventEmitter(); if (pid) value.pid = pid;
    value.unref = () => {}; value.kill = () => { state.kills++; assert.fail('No fixture may force-kill a process'); };
    state.children.push(value); return value;
  }
  const spawn = (exe, args, options) => {
    const value = child(); state.spawns.push({ exe, args, options, child: value });
    queueMicrotask(() => { value.emit('spawn'); state.onSpawn?.(value, exe, args); }); return value;
  };
  const http = {
    get(options, callbackOrOptions, maybeCallback) {
      const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : maybeCallback;
      const request = new EventEmitter(); request.destroy = () => { state.requestsDestroyed++; };
      state.healthRequested = (state.healthRequested || 0) + 1;
      if (state.suppressHealthHeaders) return request;
      queueMicrotask(() => { const response = new EventEmitter(); response.resume = () => {}; callback(response);
        if (state.onHealthResponse) { state.onHealthResponse(response, request); return; }
        response.emit('data', Buffer.from(JSON.stringify(state.healthByPort.get(options.port) || {}))); response.emit('end'); }); return request;
    },
    request(options, callback) {
      const request = new EventEmitter(); request.destroy = () => { state.requestsDestroyed++; };
      request.end = bytes => {
        state.stopPosts.push({ options, body: JSON.parse(bytes) });
        queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 202; callback(response);
          if (state.onStopResponse) { state.onStopResponse(response, request); return; }
          response.emit('data', Buffer.from(JSON.stringify({ ok: true, shutdownScheduled: true, bootId: BOOT, instanceId: INSTANCE, pid: 501 })));
          response.emit('end'); state.onStopPost?.(); });
      }; return request;
    }
  };
  const fakeTimers = (operation, milliseconds) => state.timerControl ? state.timerControl(operation, milliseconds) :
    milliseconds < 10000 ? setTimeout(operation, 0) : setTimeout(operation, milliseconds);
  const clearFixtureTimer = handle => handle?.fixtureTimer ? state.timerClear(handle) : clearTimeout(handle);
  function contextFor(source, name, imports) {
    const module = { exports: {} };
    const context = { Buffer, URL, Promise, Date, console, module, exports: module.exports,
      __dirname, __filename: path.join(__dirname, name), process: fakeProcess, setTimeout: fakeTimers, clearTimeout: clearFixtureTimer,
      require(name) {
        if (Object.hasOwn(imports, name)) return imports[name];
        if (['fs', 'os', 'path', 'crypto'].includes(name)) return require(name);
        throw Error('Unexpected fixture dependency: ' + name);
      } };
    vm.createContext(context); vm.runInContext(source, context, { filename: name }); return context;
  }
  const fakeTunnel = { ownTunnelPids: () => [], extractPublicUrl: () => state.tunnelUrl,
    probeUrl: async () => { state.probes++; return state.onProbe ? state.onProbe() : { ok: true, ms: 1 }; },
    stopTunnels() { state.stopTunnels++; state.onTunnelStop?.(); return 0; },
    async startTunnel(port, provider, admission) { state.tunnelCreates++; admission.beforeMutation(); return { url: null, provider: null }; } };
  let provider = fakeTunnel;
  if (realTunnel) provider = contextFor(tunnelSource, 'tunnel.js', {
    http, child_process: { spawn, execFileSync: () => assert.fail('No real process lookup') }, './config.js': cfg
  }).module.exports;
  const context = contextFor(daemonSource, 'gateway-daemon.js', {
    http, child_process: { spawn, execFileSync: () => assert.fail('No real process lookup') }, './config.js': cfg, './tunnel.js': provider,
    './webpush-notify.js': { sendStored: async () => assert.fail('No notification') }, './ws-e2ee-bridge.js': {},
    './runtime-requirements.js': { assertSupportedRuntime() {} }
  });
  context.fixtureState = state;
  vm.runInContext(`findRunningGateway = async expected => { fixtureState.calls.push(expected);
    return fixtureState.onFind ? fixtureState.onFind(expected) : fixtureState.gateway; };
    tunnelRunning = () => fixtureState.tunnelUp; readTunnelTargetPort = () => fixtureState.targetPort;
    readTunnelUrl = () => fixtureState.tunnelUrl; readProbeState = () => ({ fails: 4 });
    writeStatus = value => fixtureState.writes.push(value); resolveNodeExecutable = () => process.execPath;
    module.exports.actualProbe = probeGateway;
    module.exports.actualFind = ${daemonSource.match(/async function findRunningGateway\(expected = \{\}\) \{[\s\S]*?\n\}/)[0]};`, context);
  return { base, logs, flag, directory, state, provider, fakeProcess, context, child,
    lease: () => context.module.exports.createDaemonOperationLease({ logDir: logs, owner: { pid: 101, base, executable: fakeProcess.execPath, script: path.join(base, 'scripts', 'gateway-daemon.js') } }),
    run: () => context.module.exports.runDaemon(), stop: () => fs.writeFileSync(flag, 'Synthetic stop intent.'),
    clock(value) { state.timerControl = value.set; state.timerClear = value.clear; } };
}
async function run() {
  await check('atomic lease excludes concurrent runs and never reclaims old or incomplete evidence', async () => {
    const f = fixture(), lease = f.lease();
    assert.throws(f.lease, error => error.code === 'daemon-operation-pending');
    const owner = path.join(f.directory, 'owner.json'); const original = fs.readFileSync(owner);
    const old = new Date('2001-01-01'); fs.utimesSync(owner, old, old);
    assert.throws(f.lease, error => error.code === 'daemon-operation-pending'); assert.deepEqual(fs.readFileSync(owner), original);
    lease.release(); fs.mkdirSync(f.directory); assert.throws(f.lease, error => error.code === 'daemon-operation-pending');
    assert(fs.existsSync(f.directory));
  });
  await check('stop intent remains latched even if the marker is subsequently removed', async () => {
    const f = fixture(), lease = f.lease(); f.stop();
    assert.throws(lease.checkpoint, error => error.code === 'daemon-stop-requested'); fs.unlinkSync(f.flag);
    assert.throws(lease.checkpoint, error => error.code === 'daemon-stop-requested'); lease.release({ stopRequested: true });
  });
  await check('owner corruption or directory replacement cannot release another operation', async () => {
    const f = fixture(), lease = f.lease(); fs.writeFileSync(path.join(f.directory, 'owner.json'), '{}');
    assert.throws(lease.release, error => error.code === 'daemon-operation-unverified'); assert(fs.existsSync(f.directory));
    const g = fixture(), other = g.lease(); fs.renameSync(g.directory, g.directory + '.original'); fs.mkdirSync(g.directory);
    fs.writeFileSync(path.join(g.directory, 'owner.json'), '{}'); assert.throws(other.release, error => error.code === 'daemon-operation-unverified');
    assert(fs.existsSync(g.directory));
  });
  await check('identical manifest replacement is refused by file identity, not only its nonce and bytes', async () => {
    const f = fixture(), lease = f.lease(), owner = path.join(f.directory, 'owner.json'), bytes = fs.readFileSync(owner);
    fs.renameSync(owner, owner + '.original'); fs.writeFileSync(owner, bytes);
    assert.throws(lease.release, error => error.code === 'daemon-operation-unverified');
    assert.deepEqual(fs.readFileSync(owner), bytes); assert(fs.existsSync(f.directory));
  });
  await check('manifest substituted during release is retained rather than deleted as foreign evidence', async () => {
    const f = fixture(), owner = path.join(f.directory, 'owner.json'); let substituted = false;
    const fileSystem = { ...fs, renameSync(from, to) {
      if (from === owner && path.basename(to).startsWith('release-')) {
        const bytes = fs.readFileSync(owner); fs.renameSync(owner, owner + '.original'); fs.writeFileSync(owner, bytes); substituted = true;
      }
      return fs.renameSync(from, to);
    } };
    const lease = f.context.module.exports.createDaemonOperationLease({ logDir: f.logs, owner: { pid: 101, base: f.base }, fileSystem });
    assert.throws(lease.release, error => error.code === 'daemon-operation-unverified'); assert(substituted);
    assert(fs.readdirSync(f.directory).some(value => value.startsWith('release-'))); assert(fs.existsSync(f.directory));
  });
  await check('stop arriving during asynchronous gateway discovery prevents gateway and tunnel creation', async () => {
    const f = fixture(), gate = deferred(); f.state.onFind = () => gate.promise;
    const running = f.run(); await until(() => f.state.calls.length === 1); assert(fs.existsSync(f.directory));
    f.stop(); gate.resolve(null); await running;
    assert.equal(f.state.spawns.length, 0); assert.equal(f.state.tunnelCreates, 0); assert.equal(f.state.stopTunnels, 0);
    assert(!fs.existsSync(f.directory)); assert(fs.existsSync(f.flag));
  });
  await check('stop after the pre-create sleep prevents a fresh tunnel and leaves stop intent intact', async () => {
    const f = fixture(); f.state.onTunnelStop = f.stop; await f.run();
    assert.equal(f.state.stopTunnels, 1); assert.equal(f.state.tunnelCreates, 0); assert(!fs.existsSync(f.directory)); assert(fs.existsSync(f.flag));
  });
  await check('stop after a real provider spawn quiesces and hands known tunnel to fresh tray capture', async () => {
    const f = fixture({ realTunnel: true }); f.state.onSpawn = f.stop; await f.run();
    assert.equal(f.state.spawns.length, 1); assert.equal(f.state.kills, 0); assert(!fs.existsSync(f.directory));
    assert(fs.existsSync(f.flag)); assert.deepEqual(Array.from(f.state.spawns[0].args), ['tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate']);
  });
  await check('stop after a failed provider await forbids every fallback', async () => {
    const f = fixture({ realTunnel: true }); let first = 0, second = 0;
    f.provider.PROVIDERS.splice(0, f.provider.PROVIDERS.length,
      { id: 'cloudflare-quick', label: 'synthetic-first', available: () => 'unused', start: async () => { first++; f.stop(); return { url: null }; } },
      { id: 'synthetic-fallback', label: 'synthetic-second', available: () => 'unused', start: async () => { second++; return { url: null }; } });
    await f.run(); assert.equal(first, 1); assert.equal(second, 0); assert.equal(f.state.spawns.length, 0); assert(!fs.existsSync(f.directory));
  });
  await check('named provider also observes its exact child and stops after spawn without a fallback', async () => {
    const f = fixture({ realTunnel: true }); f.state.config = { tunnelDomainMode: 'fixed', tunnelProvider: 'cloudflare-named',
      fixedTunnel: { name: 'synthetic-only', hostname: 'synthetic.invalid' } }; f.state.onSpawn = f.stop;
    await f.run(); assert.equal(f.state.spawns.length, 1); assert(!fs.existsSync(f.directory)); assert.equal(f.state.kills, 0);
    assert.deepEqual(Array.from(f.state.spawns[0].args), ['tunnel', '--config', path.join(f.logs, 'cloudflared-named.yml'),
      'run', 'synthetic-only', '--no-autoupdate']);
  });
  await check('read-only status never mutates stale or dead tunnels, provisions identity, or takes a lease', async () => {
    for (const mode of ['stale', 'dead', 'absent']) {
      const f = fixture({ statusOnly: true }); f.state.tunnelUp = mode !== 'absent'; f.state.targetPort = mode === 'stale' ? 8098 : 8081;
      const before = fs.readdirSync(f.logs).sort().map(name => [name, fs.readFileSync(path.join(f.logs, name)).toString('base64')]);
      f.state.onProbe = () => ({ ok: false, status: 0, ms: 1 }); await f.run();
      assert.equal(f.state.stopTunnels, 0); assert.equal(f.state.tunnelCreates, 0); assert.equal(f.state.spawns.length, 0);
      assert.equal(f.state.identityCreates, 0); assert.equal(f.state.writes.length, 0); assert(!fs.existsSync(f.directory));
      assert.deepEqual(fs.readdirSync(f.logs).sort().map(name => [name, fs.readFileSync(path.join(f.logs, name)).toString('base64')]), before);
    }
  });
  await check('own spawned gateway uses exact instance and PID, graceful stop, and physical CLOSE', async () => {
    const f = fixture(); f.state.gateway = null;
    f.state.onFind = expected => expected.pid ? { port: 8081, info: { service: 'pocket-bridge-gateway', instanceId: INSTANCE, bootId: BOOT, pid: 501, port: 8081 } } : null;
    f.state.onSpawn = value => { f.stop(); value.emit('exit', 0); };
    const running = f.run(); await until(() => f.state.stopPosts.length === 1);
    assert(fs.existsSync(f.directory)); assert.equal(f.state.kills, 0);
    assert.equal(f.state.calls[1].instanceId, INSTANCE); assert.equal(f.state.calls[1].pid, 501);
    assert.equal(f.state.stopPosts[0].options.headers.Origin, 'http://127.0.0.1:8081');
    assert.deepEqual(f.state.stopPosts[0].body, { action: 'stop-gateway', expectedBootId: BOOT, expectedInstanceId: INSTANCE });
    await tick(); assert(fs.existsSync(f.directory), 'exit must not substitute for CLOSE');
    f.state.children[0].emit('close', 0); await running; assert(!fs.existsSync(f.directory));
  });
  await check('an unverified owned gateway remains pending without any force kill or lease removal', async () => {
    const f = fixture(); f.state.gateway = null; f.state.onFind = () => null; f.state.onSpawn = f.stop;
    await f.run(); assert(fs.existsSync(f.directory)); assert.equal(f.fakeProcess.exitCode, 1);
    assert.equal(f.state.kills, 0); assert.equal(f.state.stopPosts.length, 0);
  });
  await check('normal owned gateway startup with no matching health retains the lease and exposes no tunnel', async () => {
    const f = fixture(); f.state.gateway = null; f.state.onFind = () => null;
    await f.run(); assert.equal(f.state.spawns.length, 1); assert.equal(f.state.tunnelCreates, 0);
    assert.equal(f.state.stopTunnels, 0); assert.equal(f.state.kills, 0); assert(fs.existsSync(f.directory));
    assert.equal(f.fakeProcess.exitCode, 1);
  });
  await check('unknown physical spawn retains evidence even if a later callback reports closure', async () => {
    const f = fixture(), lease = f.lease(), value = f.child(null), ready = lease.observeSpawn(value, 'tunnel');
    value.emit('spawn'); await assert.rejects(ready, error => error.code === 'daemon-spawn-unverified');
    value.emit('close', 1); await lease.quiesce();
    assert.throws(lease.release, error => error.code === 'daemon-operation-unverified'); assert(fs.existsSync(f.directory));
  });
  await check('known spawn failure waits its physical CLOSE before clean lease release', async () => {
    const f = fixture(), lease = f.lease(), value = f.child(null), ready = lease.observeSpawn(value, 'gateway');
    value.emit('error', Error('Synthetic spawn denial')); await assert.rejects(ready);
    let drained = false; const draining = lease.quiesce().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    value.emit('close', -1); await draining; lease.release({ stopRequested: true }); assert(!fs.existsSync(f.directory));
  });
  await check('premature CLOSE without a spawn or error boundary settles unverified and retains the lease', async () => {
    const f = fixture(), lease = f.lease(), value = f.child(), ready = lease.observeSpawn(value, 'gateway'); value.emit('close', 0);
    await assert.rejects(ready, error => error.code === 'daemon-spawn-unverified'); await lease.quiesce();
    assert.throws(lease.release, error => error.code === 'daemon-operation-unverified'); assert(fs.existsSync(f.directory));
  });
  await check('actual health discovery rejects foreign instance and mismatched owned PID', async () => {
    const f = fixture(); f.state.healthByPort.set(8080, { service: 'pocket-bridge-gateway', instanceId: 'different', pid: 501, port: 8080 });
    f.state.healthByPort.set(8081, { service: 'pocket-bridge-gateway', instanceId: INSTANCE, pid: 501, port: 8081 });
    assert.equal((await f.context.module.exports.actualFind({ instanceId: INSTANCE })).port, 8081);
    assert.equal(await f.context.module.exports.actualFind({ instanceId: INSTANCE, pid: 502 }), null);
  });
  await check('continuous health bytes cannot extend the absolute deadline or revive a late success', async () => {
    const f = fixture(), clock = virtualClock(); f.clock(clock); let response;
    f.state.onHealthResponse = value => { response = value; value.emit('data', Buffer.from('{')); };
    const probing = f.context.module.exports.actualProbe(8081, 1500, { instanceId: INSTANCE }); await until(() => response);
    clock.advance(1499); response.emit('data', Buffer.from(' ')); assert.equal(f.state.requestsDestroyed, 0);
    clock.advance(1); assert.equal(await probing, null); assert.equal(f.state.requestsDestroyed, 1); assert.equal(clock.pending(), 0);
    response.emit('data', Buffer.from('"service":"pocket-bridge-gateway","port":8081,"pid":501,"instanceId":"' + INSTANCE + '"}'));
    response.emit('end'); assert.equal(await probing, null);
  });
  await check('an oversized health body destroys only its owned request and clears its deadline', async () => {
    const f = fixture(), clock = virtualClock(); f.clock(clock);
    f.state.onHealthResponse = response => response.emit('data', Buffer.alloc(16385));
    assert.equal(await f.context.module.exports.actualProbe(8081, 1500, { instanceId: INSTANCE }), null);
    assert.equal(f.state.requestsDestroyed, 1); assert.equal(clock.pending(), 0); assert.equal(f.state.kills, 0);
  });
  await check('dribbling owned graceful-stop response times out absolutely and retains live child evidence', async () => {
    const f = fixture(), clock = virtualClock(); f.clock(clock); let response;
    f.state.onFind = expected => expected.pid ? { port: 8081, info: { instanceId: INSTANCE, bootId: BOOT, pid: 501 } } : null;
    f.state.onSpawn = f.stop; f.state.onStopResponse = value => { response = value; value.emit('data', Buffer.from('{')); };
    const running = f.run(); await until(() => response); assert(fs.existsSync(f.directory));
    clock.advance(4999); response.emit('data', Buffer.from(' ')); assert.equal(f.state.requestsDestroyed, 0);
    clock.advance(1); await running; assert.equal(f.state.requestsDestroyed, 1); assert.equal(clock.pending(), 0);
    assert(fs.existsSync(f.directory)); assert.equal(f.fakeProcess.exitCode, 1); assert.equal(f.state.kills, 0);
    response.emit('end'); assert(fs.existsSync(f.directory));
  });
  await check('tunnel probe absolute deadline also covers DNS or incomplete headers before socket timeout', async () => {
    const f = fixture({ realTunnel: true }), clock = virtualClock(); f.clock(clock); f.state.suppressHealthHeaders = true;
    const probing = f.provider.probeUrl('http://synthetic.invalid', 12000); assert.equal(f.state.healthRequested, 1);
    clock.advance(11999); assert.equal(f.state.requestsDestroyed, 0);
    clock.advance(1); const result = await probing;
    assert.equal(result.ok, false); assert.equal(result.status, 0); assert.equal(f.state.requestsDestroyed, 1);
    assert.equal(clock.pending(), 0); assert.equal(f.state.kills, 0); assert.equal(f.state.spawns.length, 0);
  });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: checks, failed: 0, nativeActions: 0, networkCalls: 0,
    liveGateway: false, scope: 'actual daemon/provider code with synthetic services and exact owned child doubles' }, null, 2));
  console.log(`${checks} isolated daemon operation checks passed. Evidence: ${evidence}`);
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
