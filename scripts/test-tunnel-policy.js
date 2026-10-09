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
  for (const provider of ['none', 'auto']) {
    const build = vm.runInNewContext('(async ' + extractFunction(gateway, 'buildConsoleStatus') + ')', {
      cfg: { detectNetwork: () => ({ lanV4: [] }), loadConfig: () => ({ tunnelProvider: provider }) },
      readJsonFile: () => ({ tunnel: { url: 'https://old-fixture.invalid', provider: 'cloudflare-quick', running: true, reachable: true } }),
      path, LOG_DIR: '/fixture', refreshDshRuntime: async () => true,
      targetCache: { at: Date.now(), list: [] }, refreshTargets: async () => {},
      e2eeBridge: { readSecret: () => 'fixture-encryption' }, currentPairCode: () => null,
      PORT: 18080, HTTPS_PORT: 0, ACCESS_KEY: 'fixture-key', os: { hostname: () => 'fixture' },
      process: { platform: 'fixture' }, INSTANCE_ID: 'fixture', GATEWAY_BOOT_ID: 'fixture', TARGET_PORT: 18081,
      desktopLifecycle: { status: () => ({}) }, dshRuntime: { serializeRuntime: () => ({}), peekRuntime: () => ({}) },
      DSH_UPSTREAM_AUTH_OK: false, sessions: { list: () => [] },
      require: name => name === './targets.js' ? { localize: () => [] } : {},
      fs: { readFileSync() { throw Error('No fixture notifications'); } }, NOTIFY_TARGETS_FILE: '', SUBSCRIPTIONS_FILE: '',
      tailFile: () => '', LOG_FILE: ''
    });
    const result = await build('en');
    if (provider === 'none') {
      assert.equal(result.entries.wan, null); assert.equal(result.tunnel.url, null);
      assert.equal(result.tunnel.running, null); assert.equal(result.tunnel.reachable, null); assert.equal(result.tunnel.disabled, true);
    } else { assert(result.entries.wan.startsWith('https://old-fixture.invalid/')); assert.equal(result.tunnel.running, true); }
  }
  console.log('PASS tunnel policy: none and invalid providers have zero side effects; default, alias and explicit provider selection preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
