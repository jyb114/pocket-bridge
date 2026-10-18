'use strict';

// Actual worker bytes, owned in-memory storage and synthetic responses only.
// No browser profile, gateway, credentials, real network or process is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'pwa/sw.js'), 'utf8');
const sha = body => createHash('sha256').update(body).digest('hex');
const ORIGIN = 'https://phone.example';
const PIN = 'dsh-code-pin-v1', BODY = 'dsh-code-body-v1', EPOCH = 'dsh-code-key-epoch-v1';
const PIN_KEY = '/__dsh-code-pin', EPOCH_KEY = '/__dsh-access-key-epoch';
const UI = '/dsh-lite-ui.js';
const hashKey = (pathname, body) => pathname + '?__dsh_code_sha256=' + sha(body);
let checks = 0;
async function test(name, action) { await action(); checks++; console.log('PASS ' + name); }
function gate() {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { ready, release, async pause() { entered(); await wait; } };
}

function fixture() {
  const handlers = {}, stores = new Map(), network = new Map(), calls = [], notices = [];
  const hooks = { match: null, remove: null, digest: null, fetch: null, put: null };
  let digests = 0;
  const keyOf = key => typeof key === 'string' ? key : key.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(key) {
          const value = entries.get(keyOf(key));
          if (hooks.match) await hooks.match(name, keyOf(key));
          return value ? value.clone() : null;
        },
        async put(key, response) {
          if (hooks.put) await hooks.put(name, keyOf(key));
          entries.set(keyOf(key), response.clone());
        },
        async delete(key) { return entries.delete(keyOf(key)); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) {
      if (hooks.remove) await hooks.remove(name);
      return stores.delete(name);
    }
  };
  const context = vm.createContext({
    self: { location: { origin: ORIGIN }, addEventListener(type, fn) { handlers[type] = fn; },
      clients: { async matchAll() { return [{ postMessage(value) { notices.push(value); } }]; } } },
    caches, URL, Response, Request, Headers, setTimeout,
    console: { warn() {}, error() {} },
    crypto: { subtle: { async digest(algorithm, bytes) {
      digests++;
      if (hooks.digest) await hooks.digest(Buffer.from(bytes));
      return webcrypto.subtle.digest(algorithm, bytes);
    } } },
    async fetch(request, options) {
      const url = new URL(keyOf(request), ORIGIN); calls.push({ pathname: url.pathname, options });
      if (hooks.fetch) await hooks.fetch(url.pathname);
      const value = network.get(url.pathname);
      if (value instanceof Error) throw value;
      assert(value, 'unexpected network: ' + url.pathname);
      return new Response(value.body || '', { status: value.status || 200, headers: value.headers || {} });
    }
  });
  vm.runInContext(source, context, { filename: 'pwa/sw.js' });
  return {
    caches, stores, network, calls, notices, hooks,
    get digests() { return digests; },
    async seedPin(files, epoch = 'epoch-a') {
      await (await caches.open(PIN)).put(PIN_KEY, new Response(JSON.stringify({ files })));
      await (await caches.open(EPOCH)).put(EPOCH_KEY, new Response(epoch));
    },
    async seedBody(pathname, body, stored = body) {
      await (await caches.open(BODY)).put(hashKey(pathname, body), new Response(stored));
    },
    async pinValue() { const entry = await (await caches.open(PIN)).match(PIN_KEY); return entry && entry.json(); },
    async writePin(files) {
      context.__manifest = { files };
      const operation = vm.runInContext('writePin(__manifest)', context);
      delete context.__manifest;
      await operation;
    },
    async message(data) {
      const replies = []; let done = Promise.resolve();
      handlers.message({ data, source: { postMessage(value) { replies.push(value); } }, waitUntil(value) { done = value; } });
      await done; return replies;
    },
    async get(resource, options = {}) {
      let reply;
      const request = new Request(new URL(resource, ORIGIN), options);
      handlers.fetch({ request, respondWith(value) { reply = Promise.resolve(value); } });
      return reply ? reply : null;
    }
  };
}

async function warm(body = 'old-ui') {
  const f = fixture(); await f.seedPin({ [UI]: sha(body) }); await f.seedBody(UI, body);
  return f;
}

(async () => {
  await test('all ten fixed Lite scripts reuse verified bodies without network or background work', async () => {
    const paths = ['/e2ee.js', '/i18n.js', '/dsh-lite-lang.js', '/voice.js', '/dsh-lite-pin.js',
      '/dsh-lite-adapter.js', '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-backup-prepare.js', UI];
    const f = fixture(), files = Object.fromEntries(paths.map(p => [p, sha('code:' + p)]));
    await f.seedPin(files);
    for (const p of paths) await f.seedBody(p, 'code:' + p);
    for (const p of paths) assert.equal(await (await f.get(p)).text(), 'code:' + p);
    await Promise.resolve(); assert.equal(f.calls.length, 0); assert.equal(f.digests, paths.length);
  });
  await test('every cache hit rehashes the source bytes', async () => {
    const f = await warm(); await f.get(UI); await f.get(UI);
    assert.equal(f.digests, 2); assert.equal(f.calls.length, 0);
  });
  await test('missing body performs one verified network fill then serves the warm cache', async () => {
    const f = fixture(); await f.seedPin({ [UI]: sha('current') }); f.network.set(UI, { body: 'current' });
    assert.equal(await (await f.get(UI)).text(), 'current'); assert.equal(f.calls.length, 1);
    assert.equal(await (await f.get(UI)).text(), 'current'); assert.equal(f.calls.length, 1);
  });
  await test('corrupt hash-keyed and legacy bodies are deleted before a verified network fill', async () => {
    const f = await warm('current'); await f.seedBody(UI, 'current', 'corrupt');
    await (await f.caches.open(BODY)).put(UI, new Response('also corrupt'));
    f.network.set(UI, { body: 'current' });
    assert.equal(await (await f.get(UI)).text(), 'current'); assert.equal(f.calls.length, 1);
    assert.equal(f.stores.get(BODY).has(UI), false);
    assert.equal(await f.stores.get(BODY).get(hashKey(UI, 'current')).clone().text(), 'current');
  });
  await test('a valid path-only legacy body is hashed and migrated without network', async () => {
    const f = fixture(); await f.seedPin({ [UI]: sha('legacy') });
    await (await f.caches.open(BODY)).put(UI, new Response('legacy'));
    assert.equal(await (await f.get(UI)).text(), 'legacy'); assert.equal(f.calls.length, 0);
    assert(f.stores.get(BODY).has(hashKey(UI, 'legacy')));
  });
  await test('unpinned or invalid-hash scripts cannot use a leftover body', async () => {
    for (const files of [{}, { [UI]: 'not-a-hash' }]) {
      const f = fixture(); await f.seedPin(files); await f.seedBody(UI, 'old'); f.network.set(UI, { body: 'online' });
      assert.equal(await (await f.get(UI)).text(), 'online'); assert.equal(f.calls.length, 1); assert.equal(f.digests, 0);
    }
  });
  await test('HTML, JSON, API, auth, unknown and emergency updater stay online even with a forged pin/cache', async () => {
    for (const pathname of ['/dsh-lite.html', '/code-manifest.json', '/__targets', '/__auth/verify',
      '/api/lite/rpc', '/unknown.js', '/sw.js', '/dsh-lite-update.js']) {
      const f = fixture(); await f.seedPin({ [pathname]: sha('cached') }); await f.seedBody(pathname, 'cached');
      f.network.set(pathname, { body: 'fresh' });
      assert.equal(await (await f.get(pathname)).text(), 'fresh', pathname);
      assert.equal(await (await f.get(pathname)).text(), 'fresh', pathname);
      assert.equal(f.calls.length, 2); assert.equal(f.digests, 0);
    }
  });
  await test('cache storage failure cannot block fresh HTML, manifest, updater or protected API reads', async () => {
    const f = await warm(); f.hooks.match = async name => { if (name === EPOCH) throw new Error('read denied'); };
    for (const pathname of ['/dsh-lite.html', '/code-manifest.json', '/dsh-lite-update.js', '/__auth/verify', '/api/lite/rpc']) {
      f.network.set(pathname, { body: 'fresh:' + pathname, headers: { 'content-type': 'application/json' } });
      const response = await f.get(pathname);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(await response.text(), 'fresh:' + pathname);
    }
    assert.equal(f.calls.length, 5); assert.equal(f.digests, 0);
  });
  await test('query variants and other public pinned scripts retain network validation', async () => {
    for (const resource of [UI + '?reload=1', '/compat.js']) {
      const pathname = resource.split('?')[0], f = fixture();
      await f.seedPin({ [pathname]: sha('same') }); await f.seedBody(pathname, 'same');
      f.network.set(pathname, { body: 'same' });
      assert.equal(await (await f.get(resource)).text(), 'same'); assert.equal(f.calls.length, 1);
    }
  });
  await test('POST and other origins are not intercepted', async () => {
    const f = await warm(); assert.equal(await f.get(UI, { method: 'POST' }), null);
    assert.equal(await f.get('https://other.example/dsh-lite-ui.js'), null); assert.equal(f.calls.length, 0);
  });
  await test('wrong network bytes with no valid cache are refused and reported', async () => {
    const f = fixture(); await f.seedPin({ [UI]: sha('expected') }); f.network.set(UI, { body: 'untrusted' });
    const response = await f.get(UI), body = await response.text();
    assert(!body.includes('untrusted')); assert(body.includes('dsh-tamper-bar')); assert.equal(f.notices.length, 1);
    assert.equal(f.stores.get(BODY)?.size || 0, 0);
  });
  await test('initial pinning during an unpinned public fetch prevents unverified bytes from returning', async () => {
    const f = fixture(), paused = gate(); let first = true;
    await f.seedPin({}); f.network.set(UI, { body: 'untrusted' });
    f.hooks.fetch = async pathname => { if (pathname === UI && first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready; await f.writePin({ [UI]: sha('trusted') }); paused.release();
    const response = await result, body = await response.text();
    assert(!body.includes('untrusted')); assert(body.includes('dsh-tamper-bar')); assert.equal(f.notices.length, 1);
    assert.equal(f.calls.length, 2);
  });
  await test('a definite HTTP refusal with no cache is not a successful script', async () => {
    const f = fixture(); await f.seedPin({ [UI]: sha('expected') }); f.network.set(UI, { status: 403, body: 'denied' });
    assert.equal((await f.get(UI)).status, 403); assert.equal(f.calls.length, 1);
  });
  await test('pin replacement during SHA never returns the old body', async () => {
    const f = await warm(), paused = gate(); let first = true;
    await f.seedBody(UI, 'new-ui'); f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready; await f.writePin({ [UI]: sha('new-ui') }); paused.release();
    assert.equal(await (await result).text(), 'new-ui'); assert.equal(f.calls.length, 0);
  });
  await test('same-hash ABA changes are detected through the worker revision', async () => {
    const f = await warm(), paused = gate(); let first = true;
    f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready;
    await f.writePin({ [UI]: sha('other') }); await f.writePin({ [UI]: sha('old-ui') }); paused.release();
    assert.equal(await (await result).text(), 'old-ui'); assert.equal(f.digests, 2); assert.equal(f.calls.length, 0);
  });
  await test('persisted pin changes from another worker are detected without a local revision change', async () => {
    const f = await warm(), paused = gate(); let first = true;
    await f.seedBody(UI, 'other-worker'); f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready; await f.seedPin({ [UI]: sha('other-worker') }); paused.release();
    assert.equal(await (await result).text(), 'other-worker'); assert.equal(f.calls.length, 0);
  });
  await test('whole-pin changes are detected even if this script hash is unchanged', async () => {
    const f = await warm(), paused = gate(); let first = true;
    f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready;
    await f.seedPin({ [UI]: sha('old-ui'), '/e2ee.js': sha('another-release') }); paused.release();
    assert.equal(await (await result).text(), 'old-ui'); assert.equal(f.digests, 2); assert.equal(f.calls.length, 0);
  });
  await test('persisted epoch changes are detected even if the full pin is unchanged', async () => {
    const f = await warm(), paused = gate(); let first = true;
    f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    const result = f.get(UI); await paused.ready;
    await (await f.caches.open(EPOCH)).put(EPOCH_KEY, new Response('epoch-b')); paused.release();
    assert.equal(await (await result).text(), 'old-ui'); assert.equal(f.digests, 2); assert.equal(f.calls.length, 0);
  });
  await test('epoch rotation during SHA clears old trust before the cached body can return', async () => {
    const f = await warm(), paused = gate(); let first = true;
    f.hooks.digest = async () => { if (first) { first = false; await paused.pause(); } };
    f.network.set('/k/new', { status: 302, headers: { 'x-dsh-access-key-epoch': 'epoch-b' } });
    f.network.set(UI, { body: 'current-online' });
    const result = f.get(UI); await paused.ready; await f.get('/k/new'); paused.release();
    assert.equal(await (await result).text(), 'current-online'); assert.equal(await f.pinValue(), null);
    assert.equal(f.calls.filter(x => x.pathname === UI).length, 1);
  });
  await test('same-epoch navigation preserves the existing pin and verified body', async () => {
    const f = await warm(); f.network.set('/k/same', { status: 302, headers: { 'x-dsh-access-key-epoch': 'epoch-a' } });
    await f.get('/k/same'); assert(await f.pinValue());
    assert.equal(await (await f.get(UI)).text(), 'old-ui'); assert.equal(f.calls.length, 1);
  });
  await test('a cache request cannot return old trust while epoch deletion is suspended', async () => {
    const f = await warm(), paused = gate(); f.hooks.remove = async name => { if (name === PIN) await paused.pause(); };
    f.network.set('/k/new', { status: 302, headers: { 'x-dsh-access-key-epoch': 'epoch-b' } });
    const rotation = f.get('/k/new'); await paused.ready;
    assert.equal((await f.get(UI)).status, 503); assert.equal(f.calls.length, 1);
    for (const pathname of ['/dsh-lite.html', '/code-manifest.json', '/dsh-lite-update.js', '/__auth/verify', '/api/lite/rpc']) {
      f.network.set(pathname, { body: 'fresh:' + pathname });
      assert.equal(await (await f.get(pathname)).text(), 'fresh:' + pathname);
    }
    assert.equal(f.calls.length, 6);
    paused.release(); await rotation;
  });
  await test('unreadable epoch storage fails closed instead of treating it as an empty epoch', async () => {
    const f = await warm(); f.hooks.match = async name => { if (name === EPOCH) throw new Error('read denied'); };
    assert.equal((await f.get(UI)).status, 503); assert.equal(f.calls.length, 0);
  });
  await test('continual trust mutation is bounded and cannot return an earlier cached body', async () => {
    const f = await warm(); f.hooks.digest = async () => { await f.writePin({ [UI]: sha('old-ui') }); };
    assert.equal((await f.get(UI)).status, 503); assert.equal(f.digests, 3); assert.equal(f.calls.length, 0);
  });

  const required = ['/e2ee.js', '/i18n.js', '/dsh-lite-lang.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
    '/dsh-lite-legacy.js', '/dsh-lite-router.js', UI, '/dsh-backup-prepare.js', '/dsh-lite-switch.js'];
  function prepareStage(f, prefix) {
    const files = Object.fromEntries(required.map(p => [p, sha(prefix + p)]));
    for (const p of required) f.network.set(p, { body: prefix + p });
    return { files };
  }
  await test('a staged repin cannot resurrect a pin after access-key rotation', async () => {
    const f = await warm(), paused = gate(), manifest = prepareStage(f, 'new:'); let first = true;
    f.hooks.fetch = async pathname => { if (pathname === required[0] && first) { first = false; await paused.pause(); } };
    const update = f.message({ type: 'dsh-repin-code-verified', requestId: 'old-stage', manifest });
    await paused.ready; f.network.set('/k/new', { status: 302, headers: { 'x-dsh-access-key-epoch': 'epoch-b' } });
    await f.get('/k/new'); paused.release();
    assert.equal((await update)[0].ok, false); assert.equal(await f.pinValue(), null);
  });
  await test('a slow earlier repin cannot overwrite a newer completed repin', async () => {
    const f = await warm(), paused = gate(), manifest = prepareStage(f, 'new:'); let first = true;
    f.hooks.fetch = async pathname => { if (pathname === required[0] && first) { first = false; await paused.pause(); } };
    const slow = f.message({ type: 'dsh-repin-code-verified', requestId: 'slow', manifest }); await paused.ready;
    assert.equal((await f.message({ type: 'dsh-repin-code-verified', requestId: 'fast', manifest }))[0].ok, true);
    const accepted = await f.pinValue(); paused.release(); assert.equal((await slow)[0].ok, false);
    assert.deepEqual(await f.pinValue(), accepted);
  });
  await test('repin refuses an unknown or private entry without caching it', async () => {
    const f = await warm(), manifest = prepareStage(f, 'new:'); manifest.files['/unknown.js'] = sha('private');
    const result = await f.message({ type: 'dsh-repin-code-verified', requestId: 'unknown', manifest });
    assert.equal(result[0].ok, false); assert.equal(f.calls.some(x => x.pathname === '/unknown.js'), false);
    assert.equal(f.stores.get(BODY).has(hashKey('/unknown.js', 'private')), false);
  });
  await test('a failed pin commit leaves the old verified version intact', async () => {
    const f = await warm(), manifest = prepareStage(f, 'new:');
    f.hooks.put = async (name, key) => { if (name === PIN && key === PIN_KEY) throw new Error('storage full'); };
    const result = await f.message({ type: 'dsh-repin-code-verified', requestId: 'write-failed', manifest });
    assert.equal(result[0].ok, false); assert.deepEqual(await f.pinValue(), { files: { [UI]: sha('old-ui') } });
    assert.equal(await (await f.get(UI)).text(), 'old-ui');
  });
  console.log('PASS: ' + checks + ' pinned-public cache and trust-context checks');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
