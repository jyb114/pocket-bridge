'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real gateway refresh functions without starting a gateway,
// scanning desktop processes, or sending any model request.
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const begin = source.indexOf('async function refreshDshRuntimeState(');
const end = source.indexOf('\n/**', begin);
assert.ok(begin >= 0 && end > begin, 'gateway refresh functions are present');
const refreshCode = source.slice(begin, end);

function fixture(explicitPort, runtime) {
  const resolutions = [], authentications = [];
  const context = vm.createContext({
    EXPLICIT_TARGET_PORT: explicitPort, TARGET_PORT: explicitPort || 58347,
    DSH_UPSTREAM_AUTH_OK: null, UPSTREAM_COOKIE: null,
    cfg: { loadConfig: () => ({ dshPort: 19003, dshMode: 'web' }) },
    dshRuntime: {
      async resolveRuntime(config, options) { resolutions.push({ config, options }); return runtime.value; },
      // A resolver cache can expire during auth I/O. Reads must use the
      // result just verified instead of asking this expired synchronous view.
      peekRuntime() { throw new Error('must not depend on an expiring cache'); }
    },
    dshUpstreamAuth: { async resolve(actual, options) {
      authentications.push({ actual, options });
      return runtime.auth || { ok: true, cookie: null };
    } },
    log() {}
  });
  vm.runInContext(refreshCode, context);
  return { context, resolutions, authentications,
    refresh: force => context.refreshDshRuntimeState(force),
    ready: force => context.refreshDshRuntime(force) };
}

(async () => {
  const runtime = { value: { running: true, port: 19087, profile: 'legacy-events', kind: 'cli', version: '0.1.0-rc.8' } };
  const fixed = fixture(19087, runtime);
  const initial = await fixed.refresh(false);
  assert.equal(initial.ready, true);
  assert.equal(initial.runtime.profile, 'legacy-events');
  assert.equal(fixed.resolutions[0].config.dshPort, 19087, 'environment target overrides config preference');
  assert.equal(fixed.authentications.length, 1, 'fixed target still authenticates the verified runtime');
  assert.equal(initial.runtime, runtime.value, 'the profile belongs to this exact verified runtime, not remembered discovery');
  assert.equal(await fixed.ready(true), true);
  assert.equal(fixed.resolutions[1].options.force, true, 'writes request a fresh runtime verification');
  assert.equal(fixed.authentications[1].options.force, true);
  runtime.value = { ...runtime.value, profile: 'remote-mux', version: '0.1.7-rc.2' };
  const upgraded = await fixed.refresh(true);
  assert.equal(upgraded.runtime.profile, 'remote-mux', 'genuine same-port protocol upgrade remains detectable');
  assert.equal(upgraded.runtime, runtime.value);
  assert.equal(initial.runtime.profile, 'legacy-events', 'later discovery cannot mutate an earlier request result');
  runtime.auth = { ok: false, cookie: null };
  const rejected = await fixed.refresh();
  assert.equal(rejected.ready, false, 'auth failure cannot masquerade as a healthy fixed target');
  assert.equal(rejected.runtime, runtime.value, 'failed auth reports the current runtime without a stale profile');
  assert.equal(fixed.context.UPSTREAM_COOKIE, null);
  runtime.auth = { ok: true, cookie: { name: 'dsh-auth', value: 'temporary-test-only' } };
  await fixed.refresh();
  assert.ok(fixed.context.UPSTREAM_COOKIE);
  const authBefore = fixed.authentications.length;
  runtime.value = { ...runtime.value, port: 19003 };
  const wrongListener = await fixed.refresh(true);
  assert.equal(wrongListener.ready, false, 'another genuine runtime never replaces an unavailable fixed target');
  assert.equal(wrongListener.runtime, null);
  assert.equal(fixed.context.TARGET_PORT, 19087);
  assert.equal(fixed.context.UPSTREAM_COOKIE, null, 'wrong-target auth cookie cannot remain usable');
  assert.equal(fixed.authentications.length, authBefore);
  runtime.value = { ...runtime.value, running: false, port: null };
  assert.equal(await fixed.ready(), false);

  runtime.value = { ...runtime.value, running: true, port: 19003 };
  const automatic = fixture(null, runtime);
  assert.equal(await automatic.ready(), true);
  assert.equal(automatic.context.TARGET_PORT, 19003, 'automatic discovery still follows verified port changes');
  console.log('DSH fixed target: live protocol/auth, expired-cache safety, upgrade detection and port isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
