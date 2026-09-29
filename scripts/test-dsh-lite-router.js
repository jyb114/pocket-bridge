'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-router.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite.html'), 'utf8');
assert.match(gateway, /'\/__dsh\/legacy-rpc'/);
assert.match(gateway, /DSH_LAST_CONFIRMED_PROFILE === 'remote-mux'[\s\S]{0,90}DSH_LAST_CONFIRMED_PROFILE === 'legacy-events'/,
  'mobile tunnel should default to the encrypted Lite adapter for both verified DSH protocols');
assert.match(gateway, /'\/dsh-lite-router\.js': \{ file: 'dsh-lite-router\.js'/);
const order = ['/e2ee.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
  '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-ui.js'].map(name => html.indexOf(name));
assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]),
  'the router must defer UI mount until both adapters and encryption are loaded');

async function fixture(profile, options = {}) {
  const nodes = new Map();
  const scripts = [];
  const attempts = new Map();
  for (const id of ['connection-status', 'error-banner', 'error-text', 'error-retry',
    'reconnect', 'rail-reconnect', 'classic-view', 'settings-classic']) {
    nodes.set(id, { id, hidden: true, dataset: {}, textContent: '', href: '', onclick: null });
  }
  const events = {};
  const head = {
    appendChild(script) {
      script.parentNode = head;
      scripts.push(script.src);
      const count = attempts.get(script.src) || 0;
      attempts.set(script.src, count + 1);
      const outcome = (options.scriptLoads && options.scriptLoads[script.src] || [])[count] || 'error';
      Promise.resolve().then(() => {
        if (outcome === 'hang') return;
        if (outcome === 'success') {
          if (script.src === '/dsh-lite-adapter.js') window.DshLiteRemoteAdapter = remote;
          if (script.src === '/dsh-lite-legacy.js') window.DshLegacyAdapter = legacy;
          if (script.src === '/dsh-lite-ui.js')
            window.DshLiteUI = { mount: adapter => mounts.push(adapter) };
        }
        if (outcome === 'error') script.onerror();
        else script.onload();
      });
    },
    removeChild(script) { script.parentNode = null; }
  };
  const document = { readyState: 'loading', getElementById: id => nodes.get(id),
    addEventListener: (name, callback) => { events[name] = callback; },
    createElement: () => ({ src: '', async: false, parentNode: null, onload: null, onerror: null }),
    head };
  const mounts = [];
  const remote = { profile: 'remote-mux' };
  const legacy = { profile: 'legacy-events' };
  const location = { href: 'https://example.test/k/ACCESS?target=lite#k=SECRET', reload() {} };
  const window = { document, location, DshE2EE: { available: () => true,
    prove: async () => options.proof !== false }, __dshE2eeSecret: 'secret',
    DshLiteRemoteAdapter: options.missingRemote ? null : remote,
    DshLegacyAdapter: options.missingLegacy ? null : legacy,
    DshLiteUI: options.missingUI ? null : { mount: adapter => mounts.push(adapter) },
    setTimeout: (callback, delay) => setTimeout(callback,
      options.fastTimers ? 0 : delay), clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ targets: [{ id: 'dsh', profile }] }) }) };
  vm.runInNewContext(source, { window, URL });
  assert.equal(window.__dshLiteDeferAutoMount, true);
  await events.DOMContentLoaded();
  return { mounts, remote, legacy, nodes, scripts };
}

(async () => {
  const newRuntime = await fixture('remote-mux');
  assert.equal(newRuntime.mounts[0], newRuntime.remote);
  assert.equal(newRuntime.nodes.get('classic-view').href,
    'https://example.test/k/ACCESS?target=dsh&view=classic#k=SECRET');
  const oldRuntime = await fixture('legacy-events');
  assert.equal(oldRuntime.mounts[0], oldRuntime.legacy);
  const unknown = await fixture('unsupported');
  assert.equal(unknown.mounts.length, 0);
  assert.equal(unknown.nodes.get('error-banner').hidden, false);
  const missing = await fixture('legacy-events', { missingLegacy: true });
  assert.equal(missing.mounts.length, 0);
  assert.match(missing.nodes.get('error-text').textContent, /旧版 DSH 连接组件.*dsh-lite-legacy\.js/);
  assert.deepEqual(missing.scripts, ['/dsh-lite-legacy.js', '/dsh-lite-legacy.js']);

  const recoveredLegacy = await fixture('legacy-events', {
    missingLegacy: true,
    scriptLoads: { '/dsh-lite-legacy.js': ['error', 'success'] }
  });
  assert.equal(recoveredLegacy.mounts[0], recoveredLegacy.legacy,
    'the legacy adapter can recover after one failed script load');
  assert.deepEqual(recoveredLegacy.scripts, ['/dsh-lite-legacy.js', '/dsh-lite-legacy.js']);

  const recoveredRemote = await fixture('remote-mux', {
    missingRemote: true, missingUI: true,
    scriptLoads: { '/dsh-lite-adapter.js': ['missing', 'success'],
      '/dsh-lite-ui.js': ['success'] }
  });
  assert.equal(recoveredRemote.mounts[0], recoveredRemote.remote,
    'onload without adapter registration still needs a second verified load');
  assert.deepEqual(recoveredRemote.scripts,
    ['/dsh-lite-adapter.js', '/dsh-lite-ui.js', '/dsh-lite-adapter.js']);

  const missingUI = await fixture('remote-mux', { missingUI: true });
  assert.equal(missingUI.mounts.length, 0);
  assert.match(missingUI.nodes.get('error-text').textContent, /手机界面组件.*dsh-lite-ui\.js/);
  assert.deepEqual(missingUI.scripts, ['/dsh-lite-ui.js', '/dsh-lite-ui.js']);

  const stalledUI = await fixture('remote-mux', {
    missingUI: true, fastTimers: true,
    scriptLoads: { '/dsh-lite-ui.js': ['hang', 'hang'] }
  });
  assert.equal(stalledUI.mounts.length, 0);
  assert.deepEqual(stalledUI.scripts, ['/dsh-lite-ui.js', '/dsh-lite-ui.js'],
    'a stalled script has a finite retry budget');
  assert.match(stalledUI.nodes.get('error-text').textContent, /手机界面组件/);
  const unauthorized = await fixture('remote-mux', { proof: false });
  assert.equal(unauthorized.mounts.length, 0);
  assert.match(unauthorized.nodes.get('error-text').textContent, /授权/);
  assert.deepEqual(unauthorized.scripts, [], 'auth failure must not load components');
  assert.deepEqual(unknown.scripts, [], 'unknown profile must not load arbitrary scripts');
  console.log('DSH phone adapter router: bounded component recovery and auth cases passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
