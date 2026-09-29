'use strict';

// Exercise the real Service Worker in a fake browser. No gateway, browser,
// network connection, or user session is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8');
const origin = 'https://phone.example';
const staticCacheName = 'dsh-static-modules-v1';

function fixture(outcomes) {
  const handlers = {};
  const stores = new Map();
  const calls = [];
  const waits = [];
  const queue = outcomes.slice();
  const cacheKey = (request) => typeof request === 'string' ? request : request.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) {
          const value = entries.get(cacheKey(request));
          return value ? value.clone() : null;
        },
        async put(request, response) {
          entries.set(cacheKey(request), response.clone());
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  const self = {
    location: { origin },
    addEventListener(type, handler) { handlers[type] = handler; }
  };
  const network = async (request) => {
    calls.push(request.url);
    if (!queue.length) throw new Error('unexpected network request');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body || '', { status: next.status });
  };
  vm.runInNewContext(source, {
    self, caches, fetch: network, URL, Response, Request, Headers,
    crypto: globalThis.crypto, console,
    setTimeout(resolve, ms) { waits.push(ms); resolve(); }
  }, { filename: 'pwa/sw.js' });

  async function dispatch(resource) {
    let reply;
    handlers.fetch({
      request: new Request(origin + resource),
      respondWith(promise) { reply = Promise.resolve(promise); }
    });
    assert.ok(reply, 'same-origin GET should be intercepted');
    return reply;
  }
  return {
    dispatch, calls, waits, stores,
    staticEntries() { return stores.get(staticCacheName) || new Map(); }
  };
}

async function test(name, run) {
  await run();
  console.log('PASS: ' + name);
}

(async () => {
  const asset = '/assets/index-Q6zc2uHV.js';
  const plugin = '/plugins/??@deepseek-ai/example/client.js&rev=dc9411e52426';

  await test('5xx retries and successful asset is reused from Cache Storage', async () => {
    const f = fixture([
      { status: 503 }, { status: 502 }, { status: 200, body: 'current module' }
    ]);
    assert.equal(await (await f.dispatch(asset)).text(), 'current module');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.waits, [300, 900]);
    assert.equal(f.staticEntries().size, 1);
    assert.equal(await (await f.dispatch(asset)).text(), 'current module');
    assert.equal(f.calls.length, 3, 'cache hit must avoid a second network request');
  });

  await test('network errors retry through the fourth attempt', async () => {
    const f = fixture([
      new Error('connection reset'), new Error('connection reset'),
      new Error('connection reset'), { status: 200, body: 'recovered plugin' }
    ]);
    assert.equal(await (await f.dispatch(plugin)).text(), 'recovered plugin');
    assert.equal(f.calls.length, 4);
    assert.deepEqual(f.waits, [300, 900, 2000]);
    assert.equal(f.staticEntries().size, 1);
    assert.equal(await (await f.dispatch(plugin)).text(), 'recovered plugin');
    assert.equal(f.calls.length, 4);
  });

  await test('exhausted 5xx and network failures are not cached', async () => {
    const server = fixture(Array.from({ length: 4 }, () => ({ status: 503 })));
    assert.equal((await server.dispatch(asset)).status, 503);
    assert.equal(server.calls.length, 4);
    assert.equal(server.staticEntries().size, 0);
    const network = fixture(Array.from({ length: 4 }, () => new Error('offline')));
    await assert.rejects(network.dispatch(plugin), /offline/);
    assert.equal(network.calls.length, 4);
    assert.equal(network.staticEntries().size, 0);
  });

  await test('403 returns immediately and never populates the cache', async () => {
    const f = fixture([{ status: 403 }]);
    assert.equal((await f.dispatch(asset)).status, 403);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
    assert.equal(f.staticEntries().size, 0);
  });

  await test('unversioned plugins, HMR events, and unhashed assets bypass static cache', async () => {
    for (const resource of [
      '/plugins/??@deepseek-ai/example/client.js',
      '/plugins/??@deepseek-ai/example/client.js&rev=short',
      '/plugins/events?rev=dc9411e52426',
      '/plugins/events/stream?rev=dc9411e52426',
      '/assets/index.js'
    ]) {
      const f = fixture([
        { status: 200, body: 'first' }, { status: 200, body: 'second' }
      ]);
      assert.equal(await (await f.dispatch(resource)).text(), 'first');
      assert.equal(await (await f.dispatch(resource)).text(), 'second');
      assert.equal(f.calls.length, 2, resource + ' should keep using the network');
      assert.equal(f.staticEntries().size, 0, resource + ' must not be cached');
    }
  });

  console.log('PASS: Service Worker static retry and cache boundary');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
