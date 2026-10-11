'use strict';

// Execute the actual refresh entry point in a closed VM. Every filesystem
// operation, HTTP exchange, clock and child/native operation is synthetic.
// Reading the three checked-in source files is the only real filesystem work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'refresh-tunnel.js'), 'utf8');
const tunnelSource = fs.readFileSync(path.join(__dirname, 'tunnel.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(__dirname, 'tunnel-state.js'), 'utf8');
const BASE = '/synthetic/pocket-bridge';
const LOG_DIR = BASE + '/logs';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const BOOT = '22222222-2222-4222-8222-222222222222';
const PORT = 8081, PID = 4321;
const HEALTH = { service: 'pocket-bridge-gateway', instanceId: INSTANCE, bootId: BOOT, pid: PID, port: PORT };
const normalize = value => JSON.parse(JSON.stringify(value));
const enabled = () => ({ tunnelBackup: { enabled: true }, tunnelProvider: 'cloudflare-quick', tunnelDomainMode: 'dynamic' });
let checks = 0;

function fixture(options = {}) {
  const f = { config: options.config || enabled(), argv: options.argv || [], managed: options.managed === true,
    health: options.health === undefined ? { ...HEALTH } : options.health, portText: options.portText ?? String(PORT),
    instanceText: options.instanceText ?? JSON.stringify({ instanceId: INSTANCE }),
    statusCode: options.statusCode ?? 200, reads: [], writes: [], exists: [], http: [], spawn: [], native: [],
    timers: new Map(), unrefs: 0, destroyed: 0, errors: [], logs: [] };
  let timerId = 0;
  const forbidden = name => () => { throw Error('Unexpected native dependency: ' + name); };
  const fakeFs = {
    existsSync(file) { f.exists.push(file); assert.equal(file, LOG_DIR + '/tunnels.json');
      if (options.existsError) throw Error('synthetic state denial'); return f.managed; },
    readFileSync(file, encoding) {
      f.reads.push(file); assert.equal(encoding, 'utf8');
      if (file === LOG_DIR + '/gateway-port.txt') {
        if (options.portError) throw Error('synthetic port denial'); return f.portText;
      }
      if (file === LOG_DIR + '/instance.json') {
        if (options.instanceError) throw Error('synthetic identity denial'); return f.instanceText;
      }
      if (file === LOG_DIR + '/last-tunnel-url.txt') return 'https://old-synthetic.trycloudflare.com';
      throw Error('Unexpected fixture file read: ' + file);
    },
    mkdirSync(file, flags) { assert.equal(file, LOG_DIR); assert.equal(flags.recursive, true); },
    appendFileSync(file, value) { assert.equal(file, LOG_DIR + '/daemon.log'); f.logs.push(value); },
    writeFileSync(...args) { f.writes.push(args); throw Error('Unexpected state mutation'); }
  };
  const fakeHttp = { get(input, receive) {
    f.http.push(normalize(input));
    assert.deepEqual(normalize(input), { host: '127.0.0.1', port: PORT, path: '/__health' });
    if (options.httpThrow) throw Error('synthetic synchronous HTTP failure');
    const request = new EventEmitter(); request.destroy = () => { f.destroyed++; };
    queueMicrotask(() => {
      if (options.httpMode === 'silent') return;
      if (options.httpMode === 'request-error') { request.emit('error', Error('synthetic request error')); return; }
      const response = new EventEmitter(); response.statusCode = f.statusCode;
      response.destroy = () => { f.destroyed++; };
      receive(response);
      if (options.httpMode === 'response-error') { response.emit('error', Error('synthetic response error')); return; }
      if (options.httpMode === 'aborted') { response.emit('aborted'); return; }
      const text = options.rawBody === undefined ? JSON.stringify(f.health) : options.rawBody;
      const chunks = options.chunks || [Buffer.from(text)];
      for (const chunk of chunks) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  } };
  const fakeChild = {
    spawn(exe, args, settings) {
      f.spawn.push(normalize({ exe, args, settings }));
      const child = new EventEmitter(); child.unref = () => { f.unrefs++; };
      queueMicrotask(() => child.emit(options.spawnError ? 'error' : 'spawn', options.spawnError ? Error('synthetic spawn failure') : undefined));
      return child;
    },
    execFileSync(...args) { f.native.push(normalize(args));
      if (!options.allowLegacy) throw Error('Legacy native cleanup must never execute for managed refresh'); return ''; },
    exec: forbidden('exec'), execFile: forbidden('execFile'), spawnSync: forbidden('spawnSync'), execSync: forbidden('execSync')
  };
  const fakeProcess = { platform: options.platform || 'win32', execPath: '/synthetic/runtime/node.exe',
    argv: ['/synthetic/runtime/node.exe', BASE + '/scripts/refresh-tunnel.js', ...f.argv],
    kill: forbidden('process.kill'), exit: forbidden('process.exit') };
  const fakeConfig = { BASE, LOG_DIR, loadConfig: () => f.config };
  const cache = new Map();
  const dependencies = {
    fs: fakeFs, 'node:fs': fakeFs, path: path.posix, 'node:path': path.posix,
    http: fakeHttp, 'node:http': fakeHttp, 'child_process': fakeChild, 'node:child_process': fakeChild,
    './config.js': fakeConfig, 'node:crypto': { randomBytes: forbidden('randomBytes') }
  };
  function controlledRequire(id) {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id === './tunnel.js' || id === './tunnel-state.js') {
      if (!cache.has(id)) cache.set(id, evaluate(id === './tunnel.js' ? tunnelSource : stateSource).module.exports);
      return cache.get(id);
    }
    throw Error('Unexpected VM import: ' + id);
  }
  function evaluate(code) {
    const context = {
      module: { exports: {} }, exports: {}, require: controlledRequire, __dirname: BASE + '/scripts',
      process: fakeProcess, Buffer, URL, console: { log: value => f.logs.push(value), error: value => f.errors.push(value) },
      setTimeout(fn, ms) {
        const id = ++timerId; f.timers.set(id, { fn, ms });
        // Health deadline is held for explicit timeout tests; legacy sleeps are
        // advanced asynchronously without waiting on the actual wall clock.
        if (ms !== 2000) queueMicrotask(() => { const timer = f.timers.get(id); if (timer) { f.timers.delete(id); timer.fn(); } });
        return id;
      },
      clearTimeout(id) { f.timers.delete(id); }
    };
    vm.runInNewContext(code, context, { filename: 'synthetic-refresh-import.js', timeout: 1000 });
    return context;
  }
  const marker = '\n(async () => {';
  assert.equal(source.split(marker).length, 2, 'One refresh CLI entry point must remain identifiable');
  f.direct = () => {
    const context = evaluate(source.slice(0, source.indexOf(marker)) + '\nmodule.exports = { refreshManaged };');
    return context.module.exports.refreshManaged();
  };
  f.run = () => evaluate(source.replace(marker, '\nmodule.exports.finished = (async () => {')).module.exports.finished;
  f.fireDeadline = () => { for (const [id, timer] of [...f.timers]) if (timer.ms === 2000) { f.timers.delete(id); timer.fn(); } };
  f.process = fakeProcess;
  return f;
}
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
function noOperationalEffects(f) {
  assert.equal(f.spawn.length, 0); assert.equal(f.native.length, 0); assert.equal(f.writes.length, 0);
}
function exactRepair(f, role) {
  assert.equal(f.spawn.length, 1); assert.equal(f.native.length, 0); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.spawn[0], { exe: '/synthetic/runtime/node.exe', args: [BASE + '/scripts/gateway-daemon.js',
    '--repair-tunnels', '--port', String(PORT), '--expected-instance', INSTANCE, '--expected-boot', BOOT,
    '--expected-pid', String(PID), '--refresh-slot', role],
  settings: { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true } });
  assert.equal(f.unrefs, 1); assert.equal(f.http.length, 1); assert.equal(f.timers.size, 0);
}

async function main() {
  await check('default/off returns legacy eligibility only with no persisted managed state', async () => {
    for (const config of [{}, { tunnelBackup: { enabled: false } }, { tunnelBackup: { enabled: 'true' } }]) {
      const f = fixture({ config }); assert.equal(await f.direct(), false);
      noOperationalEffects(f); assert.equal(f.http.length, 0); assert.equal(f.reads.length, 0);
    }
    const f = fixture({ config: {}, allowLegacy: true, argv: ['--expect-same-address'] });
    await f.run(); assert.equal(f.native.length, 1); assert.equal(f.spawn.length, 1);
    assert.deepEqual(f.spawn[0].args, [BASE + '/scripts/gateway-daemon.js']);
  });
  await check('none and unknown providers cause no public/native/HTTP operations with or without saved state', async () => {
    for (const provider of ['none', 'ngrok', 'invalid']) for (const managed of [false, true]) {
      const f = fixture({ config: { ...enabled(), tunnelProvider: provider }, managed });
      await f.run(); noOperationalEffects(f); assert.equal(f.http.length, 0); assert.equal(f.reads.length, 0);
    }
  });
  await check('enabled default primary and explicit backup use one exact boot-bound repair helper', async () => {
    for (const argv of [[], ['--slot', 'primary'], ['--slot', 'backup']]) {
      const f = fixture({ argv }); await f.run(); exactRepair(f, argv.at(-1) || 'primary');
      assert.equal(f.process.exitCode, undefined);
    }
  });
  await check('disabled config with saved managed state permits primary only and cannot enter legacy cleanup', async () => {
    for (const config of [{}, { tunnelBackup: { enabled: false } }]) {
      const primary = fixture({ config, managed: true, argv: ['--slot', 'primary'] });
      await primary.run(); exactRepair(primary, 'primary');
      const backup = fixture({ config, managed: true, argv: ['--slot', 'backup'] });
      await backup.run(); noOperationalEffects(backup); assert.equal(backup.http.length, 0);
    }
  });
  await check('unsupported managed provider/domain/platform refuses fallback and preserves endpoints', async () => {
    for (const options of [
      { config: { ...enabled(), tunnelProvider: 'cloudflare-named' } },
      { config: { ...enabled(), tunnelProvider: 'auto', tunnelDomainMode: 'fixed' } },
      { platform: 'linux' }, { platform: 'darwin' }
    ]) {
      const f = fixture({ ...options, managed: true }); await f.run(); noOperationalEffects(f); assert.equal(f.http.length, 0);
      const dormant = fixture(options); assert.equal(await dormant.direct(), false);
      noOperationalEffects(dormant); assert.equal(dormant.http.length, 0);
    }
  });
  await check('invalid or absent slot is blocked before local health or native work', async () => {
    for (const argv of [['--slot'], ['--slot', 'both'], ['--slot', '--primary'], ['--slot', 'PRIMARY'], ['--slot', '']]) {
      const f = fixture({ argv }); await f.run(); noOperationalEffects(f);
      assert.equal(f.http.length, 0); assert.equal(f.process.exitCode, 1);
    }
  });
  await check('invalid, missing or denied stored gateway port cannot reach HTTP or fallback', async () => {
    for (const portText of ['', '0', '-1', '65536', '8081x', '8081.5', 'NaN', '9007199254740993']) {
      const f = fixture({ portText }); await f.run(); noOperationalEffects(f);
      assert.equal(f.http.length, 0); assert.equal(f.process.exitCode, 1);
    }
    const denied = fixture({ portError: true }); await denied.run(); noOperationalEffects(denied); assert.equal(denied.http.length, 0);
  });
  await check('missing, corrupt, denied or malformed matching installation identity blocks repair', async () => {
    for (const options of [
      { instanceError: true }, { instanceText: '{bad' }, { instanceText: 'null' },
      { instanceText: '{}', health: { ...HEALTH, instanceId: undefined } },
      { instanceText: JSON.stringify({ instanceId: 'invalid' }), health: { ...HEALTH, instanceId: 'invalid' } },
      { instanceText: JSON.stringify({ instanceId: '-'.repeat(36) }), health: { ...HEALTH, instanceId: '-'.repeat(36) } }
    ]) {
      const f = fixture(options); await f.run(); noOperationalEffects(f); assert.equal(f.process.exitCode, 1);
    }
  });
  await check('foreign health, mismatched identity/port and malformed PID/boot never authorize helper or cleanup', async () => {
    for (const health of [null, {}, [], { ...HEALTH, service: 'other' }, { ...HEALTH, instanceId: BOOT },
      { ...HEALTH, port: PORT + 1 }, { ...HEALTH, port: String(PORT) }, { ...HEALTH, pid: 0 },
      { ...HEALTH, pid: -1 }, { ...HEALTH, pid: String(PID) }, { ...HEALTH, pid: 1.5 },
      { ...HEALTH, bootId: undefined }, { ...HEALTH, bootId: 'invalid' }, { ...HEALTH, bootId: '-'.repeat(36) }]) {
      const f = fixture({ health }); await f.run(); noOperationalEffects(f); assert.equal(f.process.exitCode, 1);
    }
  });
  await check('HTTP failures, non-success status, invalid JSON and oversized body cannot authorize repair', async () => {
    for (const options of [
      { httpThrow: true }, { httpMode: 'request-error' }, { httpMode: 'response-error' }, { httpMode: 'aborted' },
      { statusCode: 301 }, { statusCode: 403 }, { statusCode: 500 }, { rawBody: '{invalid' },
      { rawBody: 'x'.repeat(16385) }, { chunks: [Buffer.from(' '.repeat(9000)), Buffer.from(' '.repeat(9000)), Buffer.from(JSON.stringify(HEALTH))] }
    ]) {
      const f = fixture(options); await f.run(); noOperationalEffects(f); assert.equal(f.process.exitCode, 1);
    }
  });
  await check('silent local health reaches one synthetic deadline and no spawn or broad fallback', async () => {
    const f = fixture({ httpMode: 'silent' }), result = f.run();
    await Promise.resolve(); f.fireDeadline(); await result;
    noOperationalEffects(f); assert.equal(f.process.exitCode, 1); assert.equal(f.destroyed, 1); assert.equal(f.timers.size, 0);
  });
  await check('helper spawn failure never unreferences or falls back to broad native cleanup', async () => {
    const f = fixture({ spawnError: true }); await f.run();
    assert.equal(f.spawn.length, 1); assert.equal(f.native.length, 0); assert.equal(f.unrefs, 0); assert.equal(f.process.exitCode, 1);
  });
  await check('unreadable managed-state detection blocks before legacy cleanup', async () => {
    const f = fixture({ config: {}, existsError: true }); await f.run();
    noOperationalEffects(f); assert.equal(f.process.exitCode, 1); assert.equal(f.http.length, 0);
  });
  console.log(`${checks} managed refresh synthetic groups passed; no actual child, native process, private state or network was used.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
