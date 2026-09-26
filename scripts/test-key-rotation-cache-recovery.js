'use strict';

// 回归：换访问密钥后，手机可能还 pin 着旧版 e2ee.js。
// 旧脚本不会给 DSH 的 WebSocket 加 e2ee=1，网关会正确拒绝明文，
// 但用户看到的就是“项目和文件一直加载不出来”。
//
// 此测试直接运行真实 sw.js：收到一个已由网关验证过的 /k/ 跳转，且其中
// 的密钥版本改变后，必须清掉旧 pin/body；下一次取 e2ee.js 必须是网络新版本。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8');
const listeners = {};
const stores = new Map();

function store(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const data = stores.get(name);
  return {
    async match(key) { const value = data.get(String(key)); return value ? value.clone() : null; },
    async put(key, value) { data.set(String(key), value.clone()); }
  };
}

const caches = {
  async open(name) { return store(name); },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); }
};

const self = {
  location: { origin: 'https://phone.example' },
  addEventListener(type, fn) { listeners[type] = fn; }
};

const network = async (request) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/k/')) {
    return new Response('', {
      status: 302,
      headers: { 'x-dsh-access-key-epoch': 'after-rotation' }
    });
  }
  if (url.pathname === '/e2ee.js') {
    return new Response('new-e2ee-code', { status: 200, headers: { 'content-type': 'application/javascript' } });
  }
  return new Response('', { status: 404 });
};

vm.runInNewContext(source, {
  self, caches, fetch: network, URL, Response, Request, Headers,
  crypto: globalThis.crypto, console, setTimeout, clearTimeout
}, { filename: 'sw.js' });

async function dispatch(url) {
  let response;
  listeners.fetch({
    request: new Request(url),
    respondWith(promise) { response = Promise.resolve(promise); }
  });
  return response;
}

(async () => {
  const pins = await caches.open('dsh-code-pin-v1');
  await pins.put('/__dsh-code-pin', new Response(JSON.stringify({
    files: { '/e2ee.js': 'old-hash' }, accessKeyEpoch: 'before-rotation'
  })));
  const bodies = await caches.open('dsh-code-body-v1');
  await bodies.put('/e2ee.js', new Response('old-e2ee-code'));

  const enter = await dispatch('https://phone.example/k/new-access-key');
  assert.equal(enter.status, 302, 'a correct new-key entry must still redirect normally');

  const script = await dispatch('https://phone.example/e2ee.js');
  assert.equal(await script.text(), 'new-e2ee-code',
    'after an access-key epoch change, stale pinned e2ee.js must not be served');

  const pin = await (await caches.open('dsh-code-pin-v1')).match('/__dsh-code-pin');
  assert.equal(pin, null, 'the obsolete code pin must be removed');
  const epoch = await (await caches.open('dsh-code-key-epoch-v1')).match('/__dsh-access-key-epoch');
  assert.ok(epoch, 'the new key epoch must be recorded for future normal entries');
  assert.equal(await epoch.text(), 'after-rotation');
  console.log('PASS: a new access-key epoch replaces stale pinned code before DSH reconnects.');
})().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
