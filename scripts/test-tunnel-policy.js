'use strict';
// Execute the actual provider policy with strict side-effect spies. No process,
// network, runtime config, or user's tunnel is accessed by this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'tunnel.js'), 'utf8');
function fixture(mode = 'dynamic') {
  const calls = [], module = { exports: {} };
  const unexpected = name => () => { calls.push(name); throw Error('Unexpected side effect: ' + name); };
  const io = new Proxy({}, { get: (_, name) => unexpected('fs.' + String(name)) });
  const cfg = { LOG_DIR: '/owned-fixture/logs', loadConfig() { calls.push('config'); return { tunnelDomainMode: mode }; },
    detectTunnelProviders: unexpected('discovery') };
  vm.runInNewContext(source, { module, exports: module.exports, URL, Buffer, Date,
    require(name) {
      if (name === 'path') return path;
      if (name === 'fs') return io;
      if (name === './config.js') return cfg;
      if (name === 'child_process') return { spawn: unexpected('spawn'), execFileSync: unexpected('exec') };
      if (name === 'http' || name === 'https') return new Proxy({}, { get: (_, key) => unexpected(name + '.' + String(key)) });
      throw Error('Unexpected import: ' + name);
    }, setTimeout: unexpected('timer'), clearTimeout: unexpected('clearTimer') });
  return { api: module.exports, calls };
}
(async () => {
  for (const mode of ['dynamic', 'fixed']) {
    const f = fixture(mode);
    const result = await f.api.startTunnel(18080, 'none', {
      beforeMutation() { f.calls.push('admission'); }, observeSpawn() { f.calls.push('observe'); }
    });
    assert.equal(result.disabled, true); assert.equal(result.url, null); assert.equal(result.attempts.length, 0);
    assert.deepEqual(f.calls, [], 'none must return before config, logs, discovery, processes, timers or network');
  }
  for (const preference of ['typo', '', null, false, 0, {}, 'ngrok', 'NONE', ' cloudflare']) {
    const f = fixture(); const result = await f.api.startTunnel(18080, preference);
    assert.equal(result.code, 'unsupported-tunnel-provider'); assert.equal(result.url, null);
    assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].ok, false);
    assert.deepEqual(f.calls, [], 'invalid provider must never silently fall back to a public provider');
  }
  for (const mode of ['dynamic', 'fixed']) for (const preference of [undefined, 'auto', 'cloudflare', 'cloudflare-quick', 'cloudflare-named']) {
    const f = fixture(mode);
    const events = [];
    for (const p of f.api.PROVIDERS) {
      p.available = () => { events.push('detect:' + p.id); return 'inert-fixture'; };
      p.start = async () => { events.push('start:' + p.id); return { url: 'https://fixture.invalid', pid: 123 }; };
    }
    const result = await f.api.startTunnel(18080, preference);
    const expected = preference === 'cloudflare-quick' || preference === 'cloudflare-named' ? preference :
      mode === 'fixed' ? 'cloudflare-named' : 'cloudflare-quick';
    assert.equal(result.provider, expected);
    assert.deepEqual(events, ['detect:' + expected, 'start:' + expected]);
    assert(!f.calls.some(name => /^(?:spawn|exec|discovery|https?\.|timer)/.test(name)));
  }
  // Execute the real console status builder against an old healthy public URL.
  // A policy change must hide that URL before a daemon can rewrite status.json.
  const { extractFunction } = require('./page-source.js');
  const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  const tunnelStateApi = require('./tunnel-state.js');
  const instanceId = '10000000-0000-4000-8000-000000000001', bootId = '20000000-0000-4000-8000-000000000002';
  function statusFixture({ provider = 'auto', lanOn = true, privateOn = false, managedState = null, requested = false, platform = 'win32' } = {}) {
    return vm.runInNewContext('(async ' + extractFunction(gateway, 'buildConsoleStatus') + ')', {
      cfg: { detectNetwork: () => ({ lanV4: [{ address: '192.0.2.12' }] }), loadConfig: () => ({ tunnelProvider: provider, enableLanAccess: lanOn,
        tunnelBackup: { enabled: requested }, privateHttps: { enabled: privateOn, origin: 'https://fixture.tailnet.ts.net' } }) },
      privateHttpsStatus: require('./tailscale-private-https.js'),
      // Only the pure projection is real. Its filesystem input and platform are
      // injected explicitly; this fixture cannot inspect a user's tunnel state.
      tunnelState: { readTunnelState: () => managedState,
        publicTunnelState: (value, options) => tunnelStateApi.publicTunnelState(value, { ...options, platform }) },
      readJsonFile: () => ({ tunnel: { url: 'https://old-fixture.invalid', provider: 'cloudflare-quick', running: true, reachable: true } }),
      path, LOG_DIR: '/fixture', refreshDshRuntime: async () => true,
      targetCache: { at: Date.now(), list: [] }, refreshTargets: async () => {},
      e2eeBridge: { readSecret: () => 'fixture-encryption' }, currentPairCode: () => null,
      PORT: 18080, HTTPS_PORT: 0, ACCESS_KEY: 'fixture-key', os: { hostname: () => 'fixture' },
      process: { platform: 'fixture' }, INSTANCE_ID: instanceId, GATEWAY_BOOT_ID: bootId, TARGET_PORT: 18081,
      desktopLifecycle: { status: () => ({}) }, dshRuntime: { serializeRuntime: () => ({}), peekRuntime: () => ({}) },
      DSH_UPSTREAM_AUTH_OK: false, sessions: { list: () => [] },
      require: name => name === './targets.js' ? { localize: () => [] } : {},
      fs: { readFileSync() { throw Error('No fixture notifications'); } }, NOTIFY_TARGETS_FILE: '', SUBSCRIPTIONS_FILE: '',
      tailFile: () => '', LOG_FILE: ''
    });
  }
  for (const provider of ['none', 'auto']) for (const lanOn of [false, true]) for (const privateOn of [false, true]) {
    const result = await statusFixture({ provider, lanOn, privateOn })('en');
    assert.equal(result.entries.lan.length, lanOn ? 1 : 0);
    assert.equal(result.entries.lanDisabled, !lanOn);
    if (!lanOn) assert.equal(result.entries.pairPage, null);
    assert.equal(Boolean(result.entries.privateHttps), privateOn);
    if (privateOn) assert(result.entries.privateHttps.startsWith('https://fixture.tailnet.ts.net/k/'));
    if (provider === 'none') {
      assert.equal(result.entries.wan, null); assert.equal(result.tunnel.url, null);
      assert.equal(result.tunnel.running, null); assert.equal(result.tunnel.reachable, null); assert.equal(result.tunnel.disabled, true);
      assert.equal(result.tunnels.primary.url, null); assert.equal(result.tunnels.backup.url, null);
    } else { assert(result.entries.wan.startsWith('https://old-fixture.invalid/')); assert.equal(result.tunnel.running, true); }
  }
  for (const options of [{ provider: 'cloudflare-named' }, { platform: 'linux' }]) {
    const result = await statusFixture({ ...options, requested: true })('en');
    assert.equal(result.tunnels.supported, false); assert.equal(result.tunnels.managed, false);
    assert.equal(result.entries.publicTunnelManaged, false);
    assert.match(result.entries.wan, /^https:\/\/old-fixture\.invalid\//, 'dormant unsupported opt-in without managed state preserves legacy primary');
  }
  const readyState = () => ({ version: 1, instanceId, port: 18080, slots: {
    primary: { phase: 'ready', origin: 'https://current-primary.trycloudflare.com', generation: 'a'.repeat(32), targetPort: 18080,
      verifiedBootId: bootId, reachable: true, checkedAt: Date.now() },
    backup: { phase: 'ready', origin: 'https://current-backup.trycloudflare.com', generation: 'b'.repeat(32), targetPort: 18080,
      verifiedBootId: bootId, reachable: true, checkedAt: Date.now() } } });
  for (const requested of [true, false]) {
    const result = await statusFixture({ managedState: readyState(), requested })('en');
    assert.equal(result.entries.publicTunnelManaged, true); assert.equal(result.entries.publicTunnelVerified, true);
    assert.match(result.entries.wan, /^https:\/\/current-primary\.trycloudflare\.com\//);
    assert.equal(result.tunnel.url, 'https://current-primary.trycloudflare.com'); assert.equal(result.tunnel.reachable, true);
    assert.equal(result.tunnel.running, null, 'external reachability does not invent a process-running observation');
    assert.equal(Boolean(result.tunnels.backup.url), requested, 'disabling backup preserves only a freshly verified managed primary');
  }
  for (const modify of [value => { value.slots.primary.checkedAt = Date.now() - 180001; },
    value => { value.slots.primary.verifiedBootId = '30000000-0000-4000-8000-000000000003'; },
    value => { value.slots.primary.targetPort++; }, value => { value.instanceId = '40000000-0000-4000-8000-000000000004'; },
    value => { value.slots.primary.phase = 'blocked'; }, value => { value.slots.primary.reachable = false; }]) {
    const managedState = readyState(); modify(managedState);
    const result = await statusFixture({ managedState, requested: true })('en');
    assert.equal(result.entries.wan, null); assert.equal(result.entries.publicTunnelVerified, false);
    assert.equal(result.tunnel.url, null); assert.equal(result.tunnel.reachable, false, 'stale legacy status never restores managed readiness');
  }
  for (const managedState of [null, { invalid: true, code: 'tunnel-state-unavailable' }]) {
    const result = await statusFixture({ managedState, requested: true })('en');
    assert.equal(result.entries.wan, null); assert.equal(result.tunnel.url, null); assert.equal(result.tunnel.reachable, false);
  }
  {
    const result = await statusFixture({ managedState: readyState(), requested: true, provider: 'none' })('en');
    assert.equal(result.entries.wan, null); assert.equal(result.tunnel.url, null); assert.equal(result.tunnel.reachable, null);
    assert.equal(result.tunnels.primary.url, null); assert.equal(result.tunnels.backup.url, null);
  }
  console.log('PASS tunnel policy: none and invalid providers have zero side effects; default, alias and explicit provider selection preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
