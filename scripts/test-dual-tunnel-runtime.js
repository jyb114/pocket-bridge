'use strict';
// All children, OS identity checks, public probes and clocks are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const api = require('./tunnel-state.js');
const { createTunnelRuntime, nextDelay } = require('./tunnel-runtime.js');
const { createTunnelWatchdog } = require('./tunnel-watchdog.js');
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const BOOT = '22222222-2222-4222-8222-222222222222';
let passes = 0;
const check = async (name, operation) => { await operation(); passes++; console.log('PASS ' + name); };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-dual-synthetic-'));
  const state = { time: 1000000, generation: 0, pid: 100, processes: new Map(), calls: [],
    config: { tunnelProvider: 'cloudflare-quick', tunnelDomainMode: 'dynamic', tunnelBackup: { enabled: true } },
    probes: new Map(), gate: true, stopFails: false, unknown: false, emitUrl: true };
  const adapter = {
    async list() { state.calls.push('list'); return { state: state.unknown ? 'unknown' : 'ok', processes: [...state.processes.values()] }; },
    async capture(pid, launch) { state.calls.push('capture:' + launch.role); const proof = state.processes.get(pid);
      return proof ? { ...proof, role: launch.role, generation: launch.generation, logFile: launch.logFile, configFile: launch.configFile } : null; },
    async inspect(proof) { state.calls.push('inspect:' + proof.pid); return { state: state.unknown ? 'unknown' : state.processes.has(proof.pid) ? 'live' : 'exited' }; },
    async stop(proof) { state.calls.push('stop:' + proof.pid); if (state.stopFails) return { stopped: false };
      state.processes.delete(proof.pid); return { stopped: true }; }
  };
  const options = { logDir: directory, instanceId: INSTANCE, bootId: BOOT, port: 8081,
    admission: { beforeMutation() { if (!state.gate) throw Object.assign(Error('daemon-stop-requested'), { code: 'daemon-stop-requested' }); },
      observeSpawn: async () => { state.calls.push('observe'); } },
    loadConfig: () => state.config, discoverExecutable: () => { state.calls.push('discover'); return '/synthetic/cloudflared'; },
    verifyGateway: async () => { state.calls.push('gateway'); return state.gatewayReady !== false; } };
  const dependencies = { platform: 'win32', now: () => state.time, sleep: async ms => { state.time += ms; state.onWait?.(); },
    canonicalExecutable: value => value,
    generation: () => (++state.generation).toString(16).padStart(32, '0'), processAdapter: adapter,
    probe: async (origin, timeout, expected) => { state.calls.push('probe:' + origin); assert.equal(expected.expectedBootId, BOOT);
      state.onProbe?.(); return { ok: state.probes.get(origin) !== false, status: state.probes.get(origin) === false ? 502 : 204 }; },
    spawn(exe, args, opts) {
      state.calls.push('spawn'); assert.equal(exe, '/synthetic/cloudflared'); assert.equal(opts.windowsHide, true);
      assert.equal(args[2], 'http://127.0.0.1:8081'); assert.equal(args[7], '127.0.0.1:0');
      assert.equal(args.length, 10); assert.equal(args[8], '--config');
      assert.equal(fs.readFileSync(args[9], 'utf8'), '{}\n');
      assert(!Object.keys(opts.env).some(name => /^(?:TUNNEL_|CLOUDFLARED_)/i.test(name)));
      const pid = ++state.pid, proof = { pid, birth: 'birth-' + pid, exe, args: args.slice() };
      state.processes.set(pid, proof);
      if (state.emitUrl) fs.writeSync(opts.stdio[1], 'created ' + (state.forcedOrigin || ('https://synthetic-' + pid + '.trycloudflare.com')) + '\n');
      const child = new EventEmitter(); child.pid = pid; child.unref = () => {}; state.onSpawn?.(); return child;
    } };
  return { state, options, dependencies, read: () => api.readTunnelState(directory),
    cycle: args => createTunnelRuntime(options, dependencies).reconcile(args),
    clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

(async () => {
  await check('default opt-in and supported policies are explicit', () => {
    assert.equal(api.backupPolicy({}, 'win32').enabled, false);
    for (const provider of ['none', 'ngrok', 'cloudflare-named', 'typo']) {
      assert.equal(api.backupPolicy({ tunnelProvider: provider, tunnelBackup: { enabled: true } }, 'win32').enabled, false);
    }
    assert.equal(api.backupPolicy({ tunnelBackup: { enabled: true } }, 'linux').supported, false);
    assert.equal(api.backupPolicy({ tunnelBackup: { enabled: true }, tunnelDomainMode: 'fixed' }, 'win32').supported, false);
  });
  await check('two healthy independent processes share only the intended gateway origin', async () => {
    const f = fixture(); try {
      const result = await f.cycle(); assert.equal(f.state.processes.size, 2);
      assert.equal(result.public.backup.reachable, true); assert.equal(result.public.primary.reachable, true);
      assert.notEqual(result.public.backup.origin, result.public.primary.origin);
      const before = [...f.state.processes.keys()]; await f.cycle(); assert.deepEqual([...f.state.processes.keys()], before);
      assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
      const publicJson = JSON.stringify(result.public); assert(!publicJson.includes('proof')); assert(!publicJson.includes('birth-'));
      assert(!publicJson.includes('/k/')); assert(!publicJson.includes('#')); assert(!publicJson.includes('/t/'));
    } finally { f.clean(); }
  });
  await check('backup death repairs only backup and exposes new generation', async () => {
    const f = fixture(); try {
      await f.cycle(); const old = f.read(); const primary = old.slots.primary.proof.pid;
      f.state.processes.delete(old.slots.backup.proof.pid); f.state.time += 60001;
      const result = await f.cycle(); assert(f.state.processes.has(primary));
      assert.equal(f.read().slots.primary.generation, old.slots.primary.generation);
      assert.notEqual(result.public.backup.generation, old.slots.backup.generation);
      assert.equal(f.state.processes.size, 2);
    } finally { f.clean(); }
  });
  await check('three spaced failures rebuild primary without touching backup', async () => {
    const f = fixture(); try {
      await f.cycle(); const old = f.read(); f.state.probes.set(old.slots.primary.origin, false);
      for (let n = 0; n < 2; n++) { f.state.time += 60001; await f.cycle(); assert(f.state.processes.has(old.slots.primary.proof.pid)); }
      f.state.time += 60001; await f.cycle(); assert(!f.state.processes.has(old.slots.primary.proof.pid));
      assert(f.state.processes.has(old.slots.backup.proof.pid)); assert.equal(f.state.processes.size, 2);
    } finally { f.clean(); }
  });
  await check('failed public startup is never advertised as ready and does not thrash', async () => {
    const f = fixture(); try {
      f.state.probes.set('https://synthetic-101.trycloudflare.com', false);
      f.state.probes.set('https://synthetic-102.trycloudflare.com', false);
      const result = await f.cycle(); assert.equal(result.public.backup.url, null);
      for (let n = 0; n < 5; n++) await f.cycle(); assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
      assert.equal(nextDelay(1), 30000); assert.equal(nextDelay(9), 300000);
    } finally { f.clean(); }
  });
  await check('known failed spawn retries only after physical close and bounded delay', async () => {
    const f = fixture(); try {
      const spawn = f.dependencies.spawn, observe = f.options.admission.observeSpawn;
      f.dependencies.spawn = () => { f.state.calls.push('failed-spawn'); const child = new EventEmitter(); child.unref = () => {}; return child; };
      f.options.admission.observeSpawn = async child => { child.emit('error', Error('synthetic failed spawn'));
        queueMicrotask(() => child.emit('close', 1)); throw Object.assign(Error('daemon-spawn-unverified'), { code: 'daemon-spawn-unverified' }); };
      await f.cycle(); assert.equal(f.read().slots.backup.phase, 'unavailable');
      assert.equal(f.read().slots.backup.spawnUnconfirmed, false);
      await f.cycle(); assert.equal(f.state.calls.filter(x => x === 'failed-spawn').length, 2);
      f.state.time += 30001; f.dependencies.spawn = spawn; f.options.admission.observeSpawn = observe;
      await f.cycle(); assert.equal(f.state.processes.size, 2);
    } finally { f.clean(); }
  });
  await check('failed owned stop cannot create a replacement or interrupt the sibling', async () => {
    const f = fixture(); try {
      await f.cycle(); const before = f.read(); f.state.stopFails = true;
      const result = await f.cycle({ refreshRole: 'backup' });
      assert.equal(result.public.backup.phase, 'blocked'); assert.equal(result.public.backup.url, null);
      assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
      assert(f.state.processes.has(before.slots.primary.proof.pid)); assert.equal(f.state.processes.size, 2);
    } finally { f.clean(); }
  });
  await check('unknown inventory and unrelated extra processes block new public endpoints', async () => {
    for (const unknown of [true, false]) {
      const f = fixture(); try {
        if (unknown) f.state.unknown = true;
        else f.state.processes.set(500, { pid: 500, birth: 'other', args: ['tunnel', '--url', 'http://127.0.0.1:9090'] });
        await assert.rejects(f.cycle(), /unconfirmed/); assert.equal(f.state.calls.includes('spawn'), false);
      } finally { f.clean(); }
    }
  });
  await check('unmarked legacy singleton is left alive until a verified desktop stop/start', async () => {
    const f = fixture(); try {
      f.state.processes.set(600, { pid: 600, birth: 'legacy', exe: '/synthetic/cloudflared', args: ['tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate'] });
      await assert.rejects(f.cycle(), /tunnel-migration-unconfirmed/);
      assert(f.state.processes.has(600)); assert.equal(f.read().slots.primary.phase, 'blocked');
      assert.equal(f.state.calls.filter(x => x === 'spawn' || x.startsWith('stop:')).length, 0);
      f.state.processes.clear(); await f.cycle(); assert.equal(f.state.processes.size, 2);
    } finally { f.clean(); }
  });
  await check('policy none and unsupported platforms do not discover, probe, stop or spawn', async () => {
    for (const disabled of ['none', 'platform', 'fixed', 'off']) {
      const f = fixture(); try {
        if (disabled === 'none') f.state.config.tunnelProvider = 'none';
        if (disabled === 'fixed') { f.state.config.tunnelProvider = 'auto'; f.state.config.tunnelDomainMode = 'fixed'; }
        if (disabled === 'platform') f.dependencies.platform = 'linux';
        if (disabled === 'off') f.state.config.tunnelBackup.enabled = false;
        await f.cycle(); assert.deepEqual(f.state.calls, []);
      } finally { f.clean(); }
    }
  });
  await check('disabling backup retires only backup and cannot revive a dead primary', async () => {
    const f = fixture(); try {
      await f.cycle(); const original = f.read(); f.state.config.tunnelBackup.enabled = false;
      f.state.processes.delete(original.slots.primary.proof.pid); await f.cycle();
      assert.equal(f.state.processes.size, 0); assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
    } finally { f.clean(); }
  });
  await check('explicit Start restores only primary after disable and controlled Stop in either order', async () => {
    for (const stopFirst of [true, false]) {
      const f = fixture(); try {
        await f.cycle();
        if (stopFirst) f.state.processes.clear();
        f.state.config.tunnelBackup.enabled = false; await f.cycle();
        if (!stopFirst) f.state.processes.clear();
        const count = f.state.calls.filter(x => x === 'spawn').length;
        await f.cycle(); assert.equal(f.state.processes.size, 0, 'Disabled helper revived primary');
        const delayed = f.read(); delayed.slots.primary.retryAt = f.state.time + 300000;
        api.writeTunnelState(f.options.logDir, delayed);
        await f.cycle({ allowPrimaryStart: true });
        assert.equal(f.state.processes.size, 1); assert.equal(f.read().slots.primary.phase, 'ready');
        const visible = api.publicTunnelState(f.read(), { config: f.state.config, platform: 'win32', now: f.state.time,
          instanceId: INSTANCE, port: 8081, bootId: BOOT });
        assert.equal(visible.managed, true); assert.equal(visible.enabled, false);
        assert.equal(visible.primary.reachable, true); assert.equal(visible.backup.url, null);
        assert.equal(f.read().slots.backup.phase, 'disabled');
        assert.equal(f.state.calls.filter(x => x === 'spawn').length, count + 1);
        const primary = f.read().slots.primary.proof.pid;
        await f.cycle({ allowPrimaryStart: true, refreshRole: 'primary' });
        assert.equal(f.state.processes.size, 1); assert(!f.state.processes.has(primary));
        assert.equal(f.read().slots.backup.proof, null);
      } finally { f.clean(); }
    }
  });
  await check('opt-out periodically verifies the existing primary without recreating either slot', async () => {
    const f = fixture(); try {
      await f.cycle(); const original = f.read(); f.state.config.tunnelBackup.enabled = false;
      await f.cycle(); assert.equal(f.state.processes.size, 1);
      for (let tick = 0; tick < 5; tick++) {
        f.state.time += 60001; const result = await f.cycle();
        assert.equal(result.public.primary.url, original.slots.primary.origin + '/dsh-lite');
        assert.equal(result.public.backup.url, null); assert.equal(result.public.enabled, false);
      }
      assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
      f.state.probes.set(original.slots.primary.origin, false);
      for (let tick = 0; tick < 4; tick++) {
        f.state.time += 60001; const result = await f.cycle(); assert.equal(result.public.primary.url, null);
      }
      assert(f.state.processes.has(original.slots.primary.proof.pid));
      assert.equal(f.state.calls.filter(x => x === 'spawn').length, 2);
      assert(!f.state.calls.includes('stop:' + original.slots.primary.proof.pid));
      f.state.processes.clear(); const absent = await f.cycle(); assert.equal(absent.public.primary.url, null);
      f.state.time += 600000; await f.cycle(); assert.equal(f.state.processes.size, 0);
      f.state.config.tunnelProvider = 'none'; f.state.calls.length = 0; await f.cycle();
      assert.deepEqual(f.state.calls, []);
    } finally { f.clean(); }
  });
  await check('stop and policy changes after awaited work fence further startup', async () => {
    for (const mode of ['stop', 'policy']) {
      const f = fixture(); try {
        f.state.onWait = () => { if (mode === 'stop') f.state.gate = false; else f.state.config.tunnelProvider = 'none'; };
        await assert.rejects(f.cycle(), /daemon-/); assert.equal(f.state.calls.filter(x => x === 'spawn').length, 1);
      } finally { f.clean(); }
    }
  });
  await check('future health timestamps force revalidation instead of suppressing probes', async () => {
    const f = fixture(); try {
      await f.cycle(); const saved = f.read(); saved.slots.primary.checkedAt = f.state.time + 300000;
      api.writeTunnelState(f.options.logDir, saved);
      f.state.calls.length = 0; await f.cycle();
      assert(f.state.calls.includes('probe:' + saved.slots.primary.origin));
      assert.equal(f.read().slots.primary.checkedAt, f.state.time);
    } finally { f.clean(); }
  });
  await check('state corruption and installation mismatch never authorize replacement', async () => {
    const f = fixture(); try {
      fs.writeFileSync(path.join(f.options.logDir, 'tunnels.json'), '{broken');
      await assert.rejects(f.cycle(), /state-unavailable/); assert.equal(f.state.calls.length, 0);
      fs.unlinkSync(path.join(f.options.logDir, 'tunnels.json')); await f.cycle();
      f.options.instanceId = BOOT; const count = f.state.calls.filter(x => x === 'spawn').length;
      await assert.rejects(f.cycle(), /installation-mismatch/); assert.equal(f.state.calls.filter(x => x === 'spawn').length, count);
    } finally { f.clean(); }
  });
  await check('cross-install, wrong role, generation, target and unmarked persisted proofs cannot be signaled', async () => {
    for (const mutation of [
      slot => { slot.proof.exe = '/other-install/cloudflared'; },
      slot => { slot.proof.role = 'primary'; },
      slot => { slot.proof.generation = 'f'.repeat(32); },
      slot => { slot.proof.logFile = '/other-install/logs/tunnels/backup-' + slot.generation + '.log'; slot.proof.args[5] = slot.proof.logFile; },
      slot => { slot.proof.args[2] = 'http://127.0.0.1:9999'; },
      slot => { slot.legacy = true; slot.proof.args = ['tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate']; }
    ]) {
      const f = fixture(); try {
        await f.cycle(); const persisted = f.read(); mutation(persisted.slots.backup);
        api.writeTunnelState(f.options.logDir, persisted); const callsBefore = f.state.calls.length;
        await assert.rejects(f.cycle({ refreshRole: 'backup' }), /tunnel-slot-owner-mismatch/);
        assert(!f.state.calls.slice(callsBefore).some(call => call.startsWith('stop:') || call.startsWith('inspect:') || call === 'spawn'));
      } finally { f.clean(); }
    }
  });
  await check('new gateway boot cannot publish stored readiness until reverified', async () => {
    const f = fixture(); try {
      await f.cycle(); const nextBoot = '33333333-3333-4333-8333-333333333333';
      const projection = api.publicTunnelState(f.read(), { config: f.state.config, platform: 'win32', now: f.state.time,
        instanceId: INSTANCE, port: 8081, bootId: nextBoot });
      assert.equal(projection.backup.url, null); assert.equal(projection.primary.url, null);
      const mismatched = api.publicTunnelState(f.read(), { config: f.state.config, platform: 'win32', now: f.state.time,
        instanceId: BOOT, port: 8081, bootId: BOOT });
      assert.equal(mismatched.backup.url, null);
    } finally { f.clean(); }
  });
  await check('stale, future, invalid and credential-bearing origins are never copied', () => {
    const state = { instanceId: INSTANCE, port: 8081, slots: { backup: { phase: 'ready', reachable: true, checkedAt: 1000, targetPort: 8081, verifiedBootId: BOOT,
      generation: 'a'.repeat(32), origin: 'https://valid-synthetic.trycloudflare.com', proof: { secret: 'private' } } } };
    const options = { config: { tunnelBackup: { enabled: true } }, platform: 'win32', now: 1000, instanceId: INSTANCE, port: 8081, bootId: BOOT };
    assert.equal(api.publicTunnelState(state, options).backup.url, 'https://valid-synthetic.trycloudflare.com/dsh-lite');
    for (const time of [999, 1000 + api.FRESHNESS_MS + 1]) assert.equal(api.publicTunnelState(state, { ...options, now: time }).backup.url, null);
    for (const origin of ['https://valid-synthetic.trycloudflare.com/k/key', 'https://api.trycloudflare.com',
      'https://user:pass@valid-synthetic.trycloudflare.com', 'https://valid-synthetic.trycloudflare.com#key', 'http://valid-synthetic.trycloudflare.com']) {
      state.slots.backup.origin = origin; assert.equal(api.publicTunnelState(state, options).backup.url, null);
    }
  });
  await check('duplicate hostnames never become a usable backup', async () => {
    const f = fixture(); try {
      f.state.forcedOrigin = 'https://one-synthetic.trycloudflare.com';
      const result = await f.cycle(); assert.equal(result.public.primary.reachable, true);
      assert.equal(result.public.backup.reachable, false); assert.equal(result.public.backup.url, null);
      assert.equal(f.read().slots.backup.code, 'duplicate-tunnel-origin'); assert.equal(f.state.processes.size, 2);
      const corrupt = f.read(); corrupt.slots.backup = { ...corrupt.slots.primary, role: 'backup' };
      const projection = api.publicTunnelState(corrupt, { config: f.state.config, platform: 'win32', now: f.state.time,
        instanceId: INSTANCE, port: 8081, bootId: BOOT }); assert.equal(projection.backup.url, null);
    } finally { f.clean(); }
  });
  await check('missing or invalid expected gateway identity never exposes readiness', async () => {
    const f = fixture(); try {
      await f.cycle(); const base = { config: f.state.config, platform: 'win32', now: f.state.time };
      for (const partial of [{}, { instanceId: INSTANCE }, { instanceId: INSTANCE, port: 8081 },
        { instanceId: INSTANCE, port: '8081', bootId: BOOT }, { instanceId: INSTANCE, port: 8081, bootId: 'invalid' }]) {
        const projected = api.publicTunnelState(f.read(), { ...base, ...partial }); assert.equal(projected.backup.url, null);
      }
    } finally { f.clean(); }
  });
  await check('watchdog is boot-scoped, single-flight, none-aware and canceled at shutdown', () => {
    const children = [], timers = [], errors = [];
    const current = { phase: 'running', instanceId: INSTANCE, bootId: BOOT, pid: 101, port: 8081,
      config: { tunnelBackup: { enabled: true } } };
    const watcher = createTunnelWatchdog({ base: '/synthetic', context: () => current, onError: code => errors.push(code) }, {
      platform: 'win32', executable: '/synthetic/node', spawn(exe, args) {
        assert.equal(exe, '/synthetic/node'); assert(args.includes('--repair-tunnels')); assert(args.includes(BOOT));
        const child = new EventEmitter(); child.pid = 700; child.unref = () => {}; children.push(child); return child;
      }, setTimeout: fn => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.canceled = true; } });
    watcher.start(); assert.equal(watcher.request(), true); assert.equal(watcher.request(), false);
    children[0].emit('close', 0); current.config.tunnelProvider = 'none'; assert.equal(watcher.request(), false);
    delete current.config.tunnelProvider; current.phase = 'draining'; assert.equal(watcher.request(), false);
    current.phase = 'running'; watcher.stop(); assert.equal(watcher.request(), false); assert(timers[0].canceled);
    assert.equal(children.length, 1); assert.deepEqual(errors, []);
  });
  await check('queued explicit disable retires after pending start without admitting another start', () => {
    const children = [];
    const current = { phase: 'running', instanceId: INSTANCE, bootId: BOOT, pid: 101, port: 8081,
      config: { tunnelBackup: { enabled: true } } };
    const watcher = createTunnelWatchdog({ base: '/synthetic', context: () => current }, { platform: 'win32',
      spawn() { const child = new EventEmitter(); child.pid = 700 + children.length; child.unref = () => {}; children.push(child); return child; } });
    assert.equal(watcher.request(), true); current.config.tunnelBackup.enabled = false;
    assert.equal(watcher.request({ retireBackup: true }), false); assert.equal(children.length, 1);
    children[0].emit('close', 0); assert.equal(children.length, 2);
    children[1].emit('close', 0); assert.equal(watcher.request(), false); watcher.stop();
  });
  await check('disabled watchdog admits maintenance only for saved managed state, never none or unsupported', () => {
    const children = [];
    const current = { phase: 'running', instanceId: INSTANCE, bootId: BOOT, pid: 101, port: 8081,
      config: { tunnelBackup: { enabled: false } } };
    const watcher = createTunnelWatchdog({ base: '/synthetic', context: () => current }, { platform: 'win32',
      spawn(exe, args) { assert(!args.includes('--refresh-slot'));
        const child = new EventEmitter(); child.pid = 700; child.unref = () => {}; children.push(child); return child; } });
    assert.equal(watcher.request(), false); current.managed = true; assert.equal(watcher.request(), true);
    children[0].emit('close', 0); current.config.tunnelProvider = 'none'; assert.equal(watcher.request(), false);
    current.config.tunnelProvider = 'cloudflare-named'; assert.equal(watcher.request(), false);
    assert.equal(children.length, 1); watcher.stop();
  });
  console.log(`Dual tunnel runtime: ${passes} synthetic groups passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
