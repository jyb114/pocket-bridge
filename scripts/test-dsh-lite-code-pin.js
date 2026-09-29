'use strict';

// The Lite page can be the first page on a new tunnel origin. Exercise its
// code-pin bootstrap without a gateway, browser profile, or real credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'dsh-lite.html'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'pwa', 'dsh-lite-pin.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const manifestBlock = gateway.match(/if \(u\.pathname === '\/code-manifest\.json'\) \{[\s\S]*?const files = \[([\s\S]*?)\];/);
assert.ok(manifestBlock, 'gateway must expose its code-fingerprint manifest');
const listed = [...manifestBlock[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
const liteFiles = ['/dsh-lite-pin.js', '/dsh-lite-adapter.js', '/dsh-lite-legacy.js',
  '/dsh-lite-router.js', '/dsh-lite-ui.js', '/dsh-lite-switch.js',
  // C8：界面文案（中/英/西）和决定语言的机制都在名单里 ——
  // 它们决定界面"说什么话"，不钉住就等于留了一个没人看着的口子。
  '/i18n.js', '/dsh-lite-lang.js'];
for (const asset of liteFiles) {
  assert.ok(listed.includes(asset), asset + ' must be pinned');
  assert.ok(gateway.includes("'" + asset + "': { file: '" + path.basename(asset) + "'"),
    asset + ' must be served as a local PWA asset');
  assert.ok(gateway.includes("'" + asset + "',"), asset + ' must be available before proof');
}
assert.match(html, /<script src="\/dsh-lite-pin\.js" defer><\/script>/,
  'a direct Lite visit must start its own pin bootstrap');
assert.ok(html.indexOf('/e2ee.js') < html.indexOf('/dsh-lite-pin.js') &&
  html.indexOf('/dsh-lite-pin.js') < html.indexOf('/dsh-lite-adapter.js'),
  'the bootstrap should start after E2EE and before the Lite adapter');

const manifest = { files: Object.fromEntries(
  ['/e2ee.js', ...liteFiles].map((name) => [name, 'a'.repeat(64)])
) };

function fixture() {
  const events = {};
  const sent = [];
  const requests = [];
  const nodes = new Map();
  let confirmResult = false;
  let reloads = 0;
  const worker = { postMessage(message) { sent.push(message); } };
  const serviceWorker = {
    ready: Promise.resolve({ active: worker }),
    register(url, options) {
      assert.equal(url, '/sw.js');
      assert.equal(options.scope, '/');
      return Promise.resolve();
    },
    addEventListener(type, callback) { events[type] = callback; }
  };
  function element(tag) {
    return {
      tagName: tag.toUpperCase(), children: [], style: {}, disabled: false,
      setAttribute() {},
      addEventListener(type, callback) { this[type] = callback; },
      appendChild(child) { this.children.push(child); }
    };
  }
  const document = {
    body: { appendChild(node) { nodes.set(node.id, node); } },
    getElementById(id) { return nodes.get(id) || null; },
    createElement: element,
    querySelector(selector) {
      return selector === '#dsh-lite-pin-notice button' ?
        (nodes.get('dsh-lite-pin-notice') || {}).children?.[1] : null;
    }
  };
  const context = {
    navigator: { serviceWorker }, document,
    window: { DshE2EE: { prove: async () => true } },
    location: { reload() { reloads++; } },
    confirm() { return confirmResult; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(url, '/code-manifest.json');
      assert.equal(options.cache, 'no-store');
      return { ok: true, status: 200, json: async () => manifest };
    },
    console, Promise
  };
  vm.runInNewContext(bootstrap, context, { filename: 'pwa/dsh-lite-pin.js' });
  return {
    sent, requests, nodes,
    emit(data) { events.message({ data }); },
    setConfirm(value) { confirmResult = value; },
    get reloads() { return reloads; }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function workerFixture() {
  const handlers = {};
  const stores = new Map();
  const network = new Map();
  const fetchOptions = [];
  let rejectNextBodyWrite = false;
  const keyOf = (key) => typeof key === 'string' ? key : key.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(key) { const found = entries.get(keyOf(key)); return found ? found.clone() : null; },
        async put(key, response) {
          if (name === 'dsh-code-body-v1' && rejectNextBodyWrite) {
            rejectNextBodyWrite = false;
            throw new Error('storage full');
          }
          entries.set(keyOf(key), response.clone());
        },
        async delete(key) { return entries.delete(keyOf(key)); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  const self = {
    location: { origin: 'https://phone.example' },
    addEventListener(type, callback) { handlers[type] = callback; }
  };
  const fetch = async (request, options) => {
    const pathname = new URL(keyOf(request), self.location.origin).pathname;
    fetchOptions.push({ pathname, options });
    const value = network.get(pathname);
    if (value instanceof Error) throw value;
    if (!value) throw new Error('unexpected script fetch: ' + pathname);
    return new Response(value.body, { status: value.status || 200 });
  };
  vm.runInNewContext(workerSource, {
    self, caches, fetch, URL, Response, Request, Headers,
    crypto: webcrypto, console, setTimeout
  }, { filename: 'pwa/sw.js' });
  return {
    caches, network, fetchOptions,
    failNextBodyWrite() { rejectNextBodyWrite = true; },
    async message(data) {
      const replies = [];
      let completion = Promise.resolve();
      handlers.message({
        data, source: { postMessage(reply) { replies.push(reply); } },
        waitUntil(promise) { completion = promise; }
      });
      await completion;
      return replies;
    },
    async get(pathname) {
      let completion;
      handlers.fetch({
        request: new Request(self.location.origin + pathname),
        respondWith(promise) { completion = Promise.resolve(promise); }
      });
      assert.ok(completion);
      return completion;
    }
  };
}

const sha = (body) => createHash('sha256').update(body).digest('hex');

(async () => {
  const fresh = fixture();
  await tick();
  assert.equal(fresh.sent[0].type, 'dsh-pin-status');
  fresh.emit({ type: 'dsh-pin-status-result', pinned: false, files: 0, paths: [] });
  await tick();
  assert.equal(fresh.requests.length, 1);
  assert.equal(fresh.sent.at(-1).type, 'dsh-pin-code');
  assert.deepEqual(Object.keys(fresh.sent.at(-1).manifest.files).sort(),
    Object.keys(manifest.files).sort(), 'fresh Lite-only origin pins every required script');

  const old = fixture();
  await tick();
  old.emit({ type: 'dsh-pin-status-result', pinned: true, files: 1, paths: ['/e2ee.js'] });
  await tick();
  assert.equal(old.requests.length, 0, 'an existing pin must never be replaced automatically');
  assert.equal(old.sent.length, 1, 'only the read-only pin status may be requested');
  const banner = old.nodes.get('dsh-lite-pin-notice');
  assert.ok(banner, 'a legacy pin must produce an explicit update notice');
  const button = banner.children[1];
  // ★ 一次点击就够，不再叠一层系统 confirm()。
  //   为什么改掉：手机上要点两次、而且那个弹窗的文字还看不全 ——
  //   实际效果是使用者干脆放弃更新、继续跑旧代码。按钮文字本身已经写明了
  //   条件（「我刚更新过，信任新版本」），那就是明确同意了。
  assert.equal(old.setConfirm, old.setConfirm);   // 保留 fixture 的接口，不再使用
  button.click();
  await tick();
  assert.ok(old.requests.length >= 1, 'the click must read the manifest before repinning');
  assert.equal(old.sent.at(-1).type, 'dsh-repin-code',
    'a deliberate click may request a new pin');
  old.emit({ type: 'dsh-repin-result', ok: true });
  assert.equal(old.reloads, 1);

  const current = fixture();
  await tick();
  current.emit({ type: 'dsh-pin-status-result', pinned: true, files: 8,
    paths: ['/e2ee.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
      '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-ui.js',
      '/i18n.js', '/dsh-lite-lang.js'] });
  assert.equal(current.nodes.size, 0);
  assert.equal(current.requests.length, 0);
  current.emit({ type: 'dsh-code-mismatch', path: '/dsh-lite-ui.js' });
  assert.ok(current.nodes.get('dsh-lite-pin-notice'), 'code mismatch must be visible');
  assert.equal(current.requests.length, 0, 'a mismatch must not silently repin');
  current.emit({ type: 'dsh-repin-result', ok: true });
  assert.equal(current.reloads, 0, 'another listener\'s repin must not reload this page');

  // The real worker must stage and verify every script before changing the
  // persistent pin. This tests the failed first reload seen on a live phone.
  const f = workerFixture();
  const oldCode = 'old-ui-code';
  const oldHash = sha(oldCode);
  const oldManifest = { files: { '/dsh-lite-ui.js': oldHash } };
  const pinStore = await f.caches.open('dsh-code-pin-v1');
  await pinStore.put('/__dsh-code-pin', new Response(JSON.stringify(oldManifest)));
  const bodyStore = await f.caches.open('dsh-code-body-v1');
  await bodyStore.put('/dsh-lite-ui.js?__dsh_code_sha256=' + oldHash,
    new Response(oldCode));
  const newBodies = Object.fromEntries(listed.map((name) =>
    [name, 'updated code for ' + name]));
  const nextManifest = { files: Object.fromEntries(Object.entries(newBodies).map(
    ([name, body]) => [name, sha(body)])) };
  for (const [name, body] of Object.entries(newBodies)) {
    f.network.set(name, { body });
  }
  const capability = await f.message({
    type: 'dsh-verified-update-capability', requestId: 'cap-1'
  });
  assert.equal(capability[0].type, 'dsh-verified-update-ready');
  assert.equal(capability[0].requestId, 'cap-1');

  f.network.set('/dsh-lite-router.js', { status: 503, body: 'unavailable' });
  const failedStage = await f.message({
    type: 'dsh-repin-code-verified', requestId: 'stage-failed', manifest: nextManifest
  });
  assert.equal(failedStage[0].type, 'dsh-repin-verified-result');
  assert.equal(failedStage[0].ok, false);
  assert.deepEqual(await (await pinStore.match('/__dsh-code-pin')).json(), oldManifest,
    'failed prewarm must leave the old pin in place');
  assert.equal(await (await bodyStore.match('/dsh-lite-ui.js?__dsh_code_sha256=' + oldHash)).text(),
    oldCode, 'failed prewarm must preserve the old verified body');

  f.network.set('/dsh-lite-router.js', { body: 'tampered script' });
  const mismatch = await f.message({
    type: 'dsh-repin-code-verified', requestId: 'stage-mismatch', manifest: nextManifest
  });
  assert.equal(mismatch[0].ok, false, 'a 200 response with wrong bytes cannot switch pins');
  assert.deepEqual(await (await pinStore.match('/__dsh-code-pin')).json(), oldManifest);

  f.network.set('/dsh-lite-router.js', { body: newBodies['/dsh-lite-router.js'] });
  f.failNextBodyWrite();
  const cacheFailure = await f.message({
    type: 'dsh-repin-code-verified', requestId: 'cache-full', manifest: nextManifest
  });
  assert.equal(cacheFailure[0].ok, false, 'cache storage failure cannot switch pins');
  assert.deepEqual(await (await pinStore.match('/__dsh-code-pin')).json(), oldManifest);

  const installed = await f.message({
    type: 'dsh-repin-code-verified', requestId: 'stage-good', manifest: nextManifest
  });
  assert.equal(installed[0].ok, true);
  assert.equal(installed[0].type, 'dsh-repin-verified-result',
    'old dsh-lite-pin.js must not mistake a verified update for its own result');
  assert.deepEqual(await (await pinStore.match('/__dsh-code-pin')).json(), nextManifest);
  for (const [name, body] of Object.entries(newBodies)) {
    const hashed = await bodyStore.match(name + '?__dsh_code_sha256=' + nextManifest.files[name]);
    assert.equal(await hashed.text(), body, name + ' must be staged under its content hash');
  }
  assert.ok(f.fetchOptions.every((call) => call.options && call.options.cache === 'no-store'),
    'prewarm must bypass the browser HTTP cache');

  // An earlier worker can finish writing a path-only old body after the new
  // pin is installed. The new worker must still serve the verified new body.
  await bodyStore.put('/dsh-lite-ui.js', new Response(oldCode));
  f.network.set('/dsh-lite-ui.js', new Error('tunnel temporarily offline'));
  assert.equal(await (await f.get('/dsh-lite-ui.js')).text(), newBodies['/dsh-lite-ui.js']);
  f.network.set('/dsh-lite-router.js', { status: 502, body: 'temporary upstream failure' });
  assert.equal(await (await f.get('/dsh-lite-router.js')).text(),
    newBodies['/dsh-lite-router.js'], 'first reload may use staged verified code on 5xx');
  assert.equal(await (await bodyStore.match('/dsh-lite-ui.js?__dsh_code_sha256=' + oldHash)).text(),
    oldCode, 'old version remains isolated for in-flight requests');

  console.log('PASS: Lite code pin stages verified scripts transactionally and isolates old caches');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
