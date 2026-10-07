'use strict';

// Exercise the complete Host adapter with real node:http requests. The two
// plugin-loader imports are fixture substitutions: CI has no third-party npm
// dependencies, and neither the production controller nor DSH is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pathToFileURL, fileURLToPath } = require('node:url');

const filename = path.resolve(__dirname, '../dsh-plugin/index.js');
let checks = 0;
function check(name, run) {
  run(); checks += 1;
  process.stdout.write(`PASS ${name}\n`);
}
function loadHost(createBridgeController = () => { throw Error('unused-controller'); }) {
  let source = fs.readFileSync(filename, 'utf8');
  for (const declaration of ["import z from '@deepseek-ai/schemastery';",
    "import { dshHomePath } from '@deepseek-ai/dsh-home-paths';",
    "import controllerModule from '../scripts/dsh-plugin-controller.js';",
    "import path from 'node:path';", "import { fileURLToPath } from 'node:url';",
    "import { randomBytes, timingSafeEqual } from 'node:crypto';"]) {
    assert.equal(source.split(declaration).length, 2, `Fixture import drift: ${declaration}`);
    source = source.replace(declaration, '');
  }
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
  source = source.replace(/^export (const|function) /gm, '$1 ');
  source += '\n;({ createBridgeHostAdapter, apply, inject, Config });';
  return vm.runInNewContext(source, { Buffer, AbortController, setTimeout, clearTimeout,
    path, fileURLToPath, randomBytes, timingSafeEqual, dshHomePath: (...parts) => path.join('D:\\Fixture DSH Home', ...parts),
    controllerModule: { createBridgeController },
    z: { object: shape => ({ shape }), string: () => ({
      default(value) { this.defaultValue = value; return this; },
      description(value) { this.descriptionText = value; return this; },
    }) } }, { filename });
}

async function fixture({ timeout = 1000 } = {}) {
  const calls = [];
  let disposed = 0;
  const behavior = {};
  const controller = {};
  for (const name of ['status', 'connection', 'diagnostics', 'action']) controller[name] = async payload => {
    calls.push({ name, payload });
    return behavior[name] ? behavior[name](payload) : { ok: true, operation: name };
  };
  controller.dispose = () => { disposed += 1; };
  let adapter;
  const server = http.createServer((req, res) => {
    const route = adapter.routes.find(value => value.path === new URL(req.url, 'http://localhost').pathname);
    if (route) route.handler(req, res); else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browserCookie = 'owned-fixture-browser-session=only-this-owned-http-fixture';
  const connection = { requestRejection: req => req.headers['x-fixture-auth'] === 'local'
    || req.headers.cookie === browserCookie ? undefined : 401 };
  adapter = loadHost().createBridgeHostAdapter({ controller, connection, port, requestTimeoutMs: timeout });
  const request = (pathname, options = {}) => new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const headers = { host: `127.0.0.1:${port}`, 'x-fixture-auth': 'local', ...options.headers };
    if (method === 'POST') {
      if (options.origin !== false && !Object.hasOwn(headers, 'origin')) headers.origin = origin;
      if (!Object.hasOwn(headers, 'content-type')) headers['content-type'] = 'application/json';
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          value: text ? JSON.parse(text) : undefined });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body !== undefined ? options.body : method === 'POST' ? '{}' : undefined);
  });
  return { get adapter() { return adapter; }, port, origin, calls, behavior, controller, connection, browserCookie, request,
    reload() { adapter.dispose(); adapter = loadHost().createBridgeHostAdapter({ controller, connection, port, requestTimeoutMs: timeout }); },
    get disposed() { return disposed; }, async close() {
      adapter.dispose(); await new Promise(resolve => server.close(resolve));
    } };
}

async function main() {
  const module = loadHost();
  check('Host has no required services and leaves bridge directory explicit', () => {
    assert.equal(module.inject.length, 0);
    assert.equal(module.Config.shape.bridgeDirectory.defaultValue, '');
    assert.match(module.Config.shape.bridgeDirectory.descriptionText, /does not scan personal folders/);
  });
  let injected;
  module.apply({ inject(names) { injected = [...names]; } });
  check('An IPC-only profile can load without mounting or launching anything', () =>
    assert.deepEqual(injected, ['webServer', 'connection']));

  const fx = await fixture();
  try {
    let result = await fx.request('/pocket-bridge/status');
    check('Authenticated direct local GET reads real route with no Origin', () => {
      assert.equal(result.status, 200); assert.equal(result.value.operation, 'status');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.match(result.value.controlToken, /^[A-Za-z0-9_-]{43}$/);
    });
    const controlToken = result.value.controlToken;
    result = await fx.request('/pocket-bridge/status');
    check('Direct authenticated status returns a stable per-host capability only in JSON', () => {
      assert.equal(result.value.controlToken, controlToken);
      assert.equal(result.headers['x-pocket-bridge-control-token'], undefined);
      assert.equal(result.headers['access-control-allow-headers'], undefined);
    });
    fx.behavior.status = () => ({ ok: false, state: 'unconfigured', code: 'installation-unavailable' });
    result = await fx.request('/pocket-bridge/status');
    check('An authenticated unconfigured status still supplies its capability so explicit Start can recover', () => {
      assert.equal(result.status, 200); assert.equal(result.value.state, 'unconfigured');
      assert.equal(result.value.controlToken, controlToken);
    });
    delete fx.behavior.status;
    result = await fx.request('/pocket-bridge/status', { headers: { host: `localhost:${fx.port}`, origin: `http://localhost:${fx.port}` } });
    check('Literal localhost authority is accepted with its exact origin', () => assert.equal(result.status, 200));
    result = await fx.request('/pocket-bridge/status', { headers: { host: `[::1]:${fx.port}`, origin: `http://[::1]:${fx.port}` } });
    check('Literal IPv6 loopback authority is accepted with its exact origin', () => assert.equal(result.status, 200));

    for (const [name, headers] of [
      ['no DSH authentication', { 'x-fixture-auth': 'missing' }],
      ['public authority', { host: `example.test:${fx.port}` }],
      ['LAN authority', { host: `192.168.1.2:${fx.port}` }],
      ['other local port', { host: `127.0.0.1:${fx.port === 65535 ? 65534 : fx.port + 1}` }],
      ['missing explicit port', { host: '127.0.0.1' }],
      ['cross-site Origin', { origin: 'https://example.test' }],
      ['null Origin', { origin: 'null' }],
      ['Origin with path', { origin: `${fx.origin}/` }],
      ['forwarded authority', { 'x-forwarded-host': 'example.test' }],
      ['forwarded IP', { 'x-forwarded-for': '127.0.0.1' }],
      ['forwarded protocol', { 'x-forwarded-proto': 'http' }],
      ['arbitrary forwarding header', { 'x-forwarded-custom': 'local' }],
      ['Forwarded chain', { forwarded: 'for=127.0.0.1' }],
      ['Cloudflare relay', { 'cf-ray': 'fixture' }],
      ['arbitrary Cloudflare header', { 'cf-custom': 'fixture' }],
      ['real IP relay', { 'x-real-ip': '127.0.0.1' }],
      ['true client IP relay', { 'true-client-ip': '127.0.0.1' }],
      ['Via relay', { via: 'fixture-proxy' }],
      ['original authority relay', { 'x-original-host': 'localhost' }],
    ]) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/status', { headers });
      check(`Admission rejects ${name} before invoking controller`, () => {
        assert.equal(result.status, 403); assert.equal(fx.calls.length, before);
        assert.deepEqual(result.value, { ok: false, code: 'local-authenticated-request-required' });
      });
    }
    for (const operation of ['connection', 'diagnostics']) {
      result = await fx.request(`/pocket-bridge/${operation}`, { method: 'POST' });
      check(`Actual ${operation} route dispatches a local JSON POST`, () => {
        assert.equal(result.status, 200); assert.equal(result.value.operation, operation);
      });
      const before = fx.calls.length;
      result = await fx.request(`/pocket-bridge/${operation}`, { method: 'POST', origin: false });
      check(`${operation} requires Origin even with authenticated local socket`, () => {
        assert.equal(result.status, 403); assert.equal(fx.calls.length, before);
      });
      result = await fx.request(`/pocket-bridge/${operation}`, { method: 'POST', origin: false,
        headers: { 'x-fixture-auth': 'missing', cookie: fx.browserCookie, 'x-pocket-bridge-control-token': controlToken } });
      check(`Native proxy ${operation} preserves real cookie admission after Origin is removed`, () => {
        assert.equal(result.status, 200); assert.equal(result.value.operation, operation);
        assert.equal(result.value.controlToken, undefined);
        assert.equal(result.headers['access-control-allow-origin'], undefined);
        assert.equal(result.headers['access-control-allow-headers'], undefined);
      });
    }
    for (const [name, value] of [['wrong capability', 'A'.repeat(43)], ['future capability', randomBytes(32).toString('base64url')],
      ['short capability', controlToken.slice(1)], ['long capability', controlToken + 'A'], ['duplicate capabilities', [controlToken, controlToken]]]) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/action', { method: 'POST', origin: false, body: '{"action":"start"}',
        headers: { 'x-fixture-auth': 'missing', cookie: fx.browserCookie, 'x-pocket-bridge-control-token': value } });
      check(`Missing-Origin write rejects ${name} before invoking controller`, () => {
        assert.equal(result.status, 403); assert.equal(fx.calls.length, before);
        assert.equal(result.value.controlToken, undefined);
      });
    }
    for (const [name, headers] of [['invalid DSH cookie', { 'x-fixture-auth': 'missing', cookie: 'invalid-owned-cookie' }],
      ['wrong attached Origin', { origin: 'https://external.example' }], ['native scheme attached instead of stripped Origin', { origin: 'dsh-app://app' }],
      ['relay header', { via: 'owned-proxy' }]]) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/action', { method: 'POST', origin: false, body: '{"action":"start"}',
        headers: { 'x-fixture-auth': 'missing', cookie: fx.browserCookie, 'x-pocket-bridge-control-token': controlToken, ...headers } });
      check(`A valid capability cannot bypass ${name}`, () => {
        assert.equal(result.status, 403); assert.equal(fx.calls.length, before);
        assert.equal(result.value.controlToken, undefined);
      });
    }
    result = await fx.request('/pocket-bridge/action', { method: 'POST', origin: false, body: '{"action":"start"}',
      headers: { 'x-fixture-auth': 'missing', cookie: fx.browserCookie, 'x-pocket-bridge-control-token': controlToken } });
    check('A native carrier can explicitly Start with its private capability and authenticated cookie', () => {
      assert.equal(result.status, 200); assert.equal(fx.calls.at(-1).name, 'action');
      assert.equal(fx.calls.at(-1).payload.action, 'start');
    });
    result = await fx.request('/pocket-bridge/status', { method: 'POST' });
    check('Wrong method on status returns 405 and Allow GET', () => {
      assert.equal(result.status, 405); assert.equal(result.headers.allow, 'GET');
    });
    result = await fx.request('/pocket-bridge/connection');
    check('Wrong method on connection returns 405 and Allow POST', () => {
      assert.equal(result.status, 405); assert.equal(result.headers.allow, 'POST');
    });
    for (const method of ['HEAD', 'DELETE', 'OPTIONS']) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/status', { method });
      check(`Authenticated ${method} is rejected with 405, without an operation`, () => {
        assert.equal(result.status, 405); assert.equal(fx.calls.length, before);
        assert.equal(result.headers['access-control-allow-origin'], undefined);
      });
    }
    const badBodies = [
      ['non-JSON content type', 415, '{}', { 'content-type': 'text/plain' }],
      ['oversized declared JSON', 413, ' '.repeat(2049), {}],
      ['oversized streamed JSON', 413, ' '.repeat(2049), { 'transfer-encoding': 'chunked' }],
      ['broken JSON', 400, '{', {}],
      ['JSON null', 400, 'null', {}],
      ['JSON array', 400, '[]', {}],
      ['JSON string', 400, '"text"', {}],
      ['unexpected parameters', 400, '{"path":"D:/private"}', {}],
    ];
    for (const [name, status, body, headers] of badBodies) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/connection', { method: 'POST', body, headers });
      check(`Body validation rejects ${name} before dispatch`, () => {
        assert.equal(result.status, status); assert.equal(fx.calls.length, before);
      });
    }
    for (const body of [{ action: 'shell' }, { action: 'stop' }, { action: 'start', path: 'D:/private' },
      { action: 'stop', expectedBootId: [], expectedInstanceId: 'fixture' },
      { action: 'stop', expectedBootId: 'fixture', expectedInstanceId: 'x'.repeat(129) }]) {
      const before = fx.calls.length;
      result = await fx.request('/pocket-bridge/action', { method: 'POST', body: JSON.stringify(body) });
      check('Action rejects arbitrary commands, paths and incomplete identity', () => {
        assert.equal(result.status, 400); assert.equal(fx.calls.length, before);
      });
    }
    result = await fx.request('/pocket-bridge/action', { method: 'POST', body: '{"action":"start"}' });
    check('Explicit start dispatches only the bounded action', () => {
      assert.equal(result.status, 200); assert.equal(fx.calls.at(-1).payload.action, 'start');
      assert.equal(Object.keys(fx.calls.at(-1).payload).length, 1);
    });
    result = await fx.request('/pocket-bridge/action', { method: 'POST',
      body: '{"action":"stop","expectedBootId":"boot-fixture","expectedInstanceId":"instance-fixture"}' });
    check('Stop preserves the caller observed boot and installation identity', () => {
      assert.equal(result.status, 200);
      assert.equal(fx.calls.at(-1).payload.expectedBootId, 'boot-fixture');
      assert.equal(fx.calls.at(-1).payload.expectedInstanceId, 'instance-fixture');
    });
    fx.behavior.status = () => { throw Object.assign(Error('SECRET D:/private/config.json'), { code: 'body-too-large', status: 403 }); };
    result = await fx.request('/pocket-bridge/status');
    check('A controller exception cannot expose paths, secrets or forge an adapter validation error', () => {
      assert.equal(result.status, 503); assert.deepEqual(result.value, { ok: false, code: 'bridge-unavailable' });
      assert.doesNotMatch(result.text, /SECRET|private|config\.json|body-too-large/);
      assert.equal(result.value.controlToken, undefined);
    });
    fx.behavior.status = () => ({ huge: 'x'.repeat(256 * 1024) });
    result = await fx.request('/pocket-bridge/status');
    check('Oversized controller data has a bounded response', () => {
      assert.equal(result.status, 502); assert.equal(result.value.code, 'invalid-controller-response');
    });
    fx.behavior.status = () => undefined;
    result = await fx.request('/pocket-bridge/status');
    check('Controller must return an actual JSON object', () => assert.equal(result.status, 502));

    const fakeReq = new EventEmitter();
    fakeReq.method = 'GET'; fakeReq.headers = { host: `127.0.0.1:${fx.port}`, 'x-fixture-auth': 'local' };
    fakeReq.socket = { remoteAddress: '192.168.1.5' };
    const fakeRes = new EventEmitter();
    fakeRes.writeHead = status => { fakeRes.status = status; };
    fakeRes.end = bytes => { fakeRes.bytes = bytes; fakeRes.writableEnded = true; };
    const before = fx.calls.length;
    await fx.adapter.routes[0].handler(fakeReq, fakeRes);
    check('LAN socket is rejected despite spoofed localhost Host', () => {
      assert.equal(fakeRes.status, 403); assert.equal(fx.calls.length, before);
    });
  } finally { await fx.close(); }
  check('Adapter disposes controller exactly once', () => {
    fx.adapter.dispose(); assert.equal(fx.disposed, 1);
  });

  const reloaded = await fixture();
  try {
    const before = (await reloaded.request('/pocket-bridge/status')).value.controlToken;
    reloaded.reload();
    const current = (await reloaded.request('/pocket-bridge/status')).value.controlToken;
    check('Reloading the adapter on the same listener replaces and invalidates the old capability', () => {
      assert.match(current, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(current, before);
    });
    let result = await reloaded.request('/pocket-bridge/action', { method: 'POST', origin: false, body: '{"action":"start"}',
      headers: { 'x-fixture-auth': 'missing', cookie: reloaded.browserCookie, 'x-pocket-bridge-control-token': before } });
    check('The previous adapter capability cannot authorize a write after a reload', () => assert.equal(result.status, 403));
    result = await reloaded.request('/pocket-bridge/action', { method: 'POST', origin: false, body: '{"action":"start"}',
      headers: { 'x-fixture-auth': 'missing', cookie: reloaded.browserCookie, 'x-pocket-bridge-control-token': current } });
    check('The new adapter capability can authorize the same owned native carrier', () => assert.equal(result.status, 200));
  } finally { await reloaded.close(); }

  const slow = await fixture({ timeout: 40 });
  let release;
  slow.behavior.status = () => new Promise(resolve => { release = resolve; });
  try {
    const result = await slow.request('/pocket-bridge/status');
    check('One request budget returns 504 for an unfinished controller operation', () => {
      assert.equal(result.status, 504); assert.equal(result.value.code, 'request-timeout');
      assert.equal(slow.calls.length, 1);
    });
    release({ ok: true, secret: 'late-result' });
    await new Promise(resolve => setTimeout(resolve, 5));
    check('Late completion cannot retry the action or expose its result', () => {
      assert.equal(slow.calls.length, 1); assert.doesNotMatch(result.text, /late-result/);
    });
  } finally { await slow.close(); }

  const pending = await fixture();
  let finish;
  pending.behavior.status = () => new Promise(resolve => { finish = resolve; });
  try {
    const waiting = pending.request('/pocket-bridge/status');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    pending.adapter.dispose();
    const result = await waiting;
    check('Unloading rejects in-flight requests and disposes without stopping native applications', () => {
      assert.equal(result.status, 503); assert.equal(result.value.code, 'plugin-unloaded');
      assert.equal(pending.disposed, 1);
    });
    finish({ ok: true });
    const before = pending.calls.length;
    const after = await pending.request('/pocket-bridge/status');
    check('Disposed adapter rejects new operations before controller dispatch', () => {
      assert.equal(after.status, 503); assert.equal(pending.calls.length, before);
    });
  } finally { await pending.close(); }

  let controlled;
  let options;
  const activeRoutes = new Map();
  const disposers = [];
  const plugin = loadHost(value => {
    options = value;
    controlled = { disposeCount: 0, dispose() { this.disposeCount += 1; } };
    return controlled;
  });
  const child = { webServer: { port: 19387, host: '127.0.0.1', register(route) {
    activeRoutes.set(route.path, route);
    return () => activeRoutes.delete(route.path);
  } }, connection: { requestRejection: () => undefined }, get: () => ({ name: 'web-fixture' }),
  effect(setup) { disposers.push(setup()); } };
  plugin.apply({ inject(_, mounted) { mounted(child); } }, { bridgeDirectory: 'D:\\Explicit Bridge' });
  check('Optional services mount exactly four routes and pass the real DSH host port', () => {
    assert.equal(activeRoutes.size, 4); assert.equal(options.hostRuntime.port, 19387);
    assert.equal(options.bridgeDirectory, 'D:\\Explicit Bridge');
    assert.equal(options.managed, false);
    assert.equal(options.hostRuntime.version, undefined);
  });
  disposers.forEach(dispose => dispose());
  check('Cordis teardown unregisters every route and disposes its controller', () => {
    assert.equal(activeRoutes.size, 0); assert.equal(controlled.disposeCount, 1);
  });
  plugin.apply({ inject(_, mounted) { mounted(child); } });
  check('Default managed installation uses stable DSH data and leaves plugin source read-only', () => {
    assert.equal(options.bridgeDirectory, path.join('D:\\Fixture DSH Home', 'pocket-bridge', 'gateway'));
    assert.equal(options.managed, true);
    assert.equal(options.sourceDirectory, path.resolve(__dirname, '..'));
  });
  disposers.at(-1)();
  process.stdout.write(`Pocket Bridge plugin Host: ${checks} checks passed.\n`);
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
