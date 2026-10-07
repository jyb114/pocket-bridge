'use strict';

// Real, exclusively owned HTTP sockets and disposable installation fixtures.
// Only child creation is simulated. No DSH, tunnel or production gateway is
// started, stopped, scanned or used as a target by this acceptance fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createBridgeController } = require('./dsh-plugin-controller.js');

let passed = 0;
const failed = [];
async function check(name, run) {
  try { await run(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed.push({ name, message: error.message }); process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}

async function fixture(options = {}) {
  const temporaryBase = fs.realpathSync(process.env.TMPDIR || process.env.TEMP || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryBase, 'pb-plugin-controller-'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'logs'));
  const identity = crypto.randomUUID();
  const boot = crypto.randomUUID();
  const hostPort = 19389;
  const access = 'FixtureAccessValue1234567890123456';
  const secret = 'FixtureEncryption1234567890123456';
  const writes = [];
  const reads = [];
  const children = [];
  const sockets = new Set();
  let hangingChild = false;
  const state = { healthStatus: 200, encrypted: true, health: { service: 'pocket-bridge-gateway',
    instanceId: identity, bootId: boot, pid: process.pid, port: 0, dshPort: hostPort, dshAlive: true },
    consoleStatus: null, ack: null, onHealth: null, onConsole: null, onAction: null, onLite: null };
  const respond = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer((req, res) => {
    reads.push({ path: req.url, method: req.method, host: req.headers.host, origin: req.headers.origin });
    if (req.url === '/__health') {
      if (state.onHealth?.(req, res, reads.filter(value => value.path === '/__health').length)) return;
      respond(res, state.healthStatus, state.health); return;
    }
    if (req.url === '/__dsh/lite-status') {
      if (state.onLite?.(req, res)) return;
      respond(res, 200, { ok: true, encrypted: state.encrypted, needsKey: true }); return;
    }
    if (req.url === '/__console/status') {
      if (state.onConsole?.(req, res)) return;
      respond(res, 200, state.consoleStatus); return;
    }
    if (req.url === '/__console/action') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        writes.push(value);
        if (state.onAction?.(req, res, value)) return;
        respond(res, 202, state.ack);
      }); return;
    }
    respond(res, 404, {});
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  state.health.port = port;
  state.consoleStatus = { instanceId: identity,
    gateway: { port, bootId: boot, pid: process.pid, dshPort: hostPort, dshAlive: true },
    entries: { encrypted: true, wan: `https://fixture-bridge.example/k/${access}#k=${secret}`,
      lan: [`http://127.0.0.1:${port}/k/${access}#k=${secret}`], pairCode: '123456' },
    tunnel: { url: 'https://fixture-bridge.example', running: true, reachable: true },
    devices: [{ token: 'PRIVATE_FIXTURE_DEVICE' }], notify: { ntfy: 'PRIVATE_FIXTURE_NOTIFY' },
    recentLog: 'PRIVATE_FIXTURE_MESSAGE' };
  state.ack = { ok: true, shutdownScheduled: true, bootId: boot, instanceId: identity, pid: process.pid };
  const config = { gatewayPort: port, dshPort: hostPort, tunnelProvider: 'cloudflare',
    unknownSetting: { retained: 'PRIVATE_FIXTURE_CONFIG' } };
  const recorded = { instanceId: identity, gateway: { port }, updatedAt: new Date().toISOString(),
    tunnel: { url: 'https://fixture-bridge.example', running: true, reachable: true } };
  function write(relative, value) {
    fs.writeFileSync(path.join(directory, relative), typeof value === 'string' ? value : JSON.stringify(value));
  }
  write('package.json', { name: 'pocket-bridge', version: '1.0.0-preview.13' });
  write('scripts/gateway-daemon.js', '// owned fixture source; never executed\n');
  write('scripts/mobile-proxy.js', '// owned fixture source; never executed\n');
  write('logs/instance.json', { instanceId: identity });
  write('logs/status.json', recorded);
  write('config.json', config);
  const requestOwned = (requestOptions, callback) => {
    if (requestOptions.port === port) return http.request(requestOptions, callback);
    // Reject fallback ports without even opening a socket. This is essential on
    // a development machine whose real bridge lives inside the fallback range.
    const refused = new EventEmitter();
    let closed = false;
    refused.end = () => queueMicrotask(() => { if (!closed) refused.emit('error', Error('fixture-refused')); });
    refused.destroy = () => { if (!closed) { closed = true; queueMicrotask(() => refused.emit('error', Error('fixture-closed'))); } };
    return refused;
  };
  const spawnOwned = (executable, args, launchOptions) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    child.kill = () => { throw Error('The plugin must not kill a DSH/native process'); };
    children.push({ executable, args, launchOptions, child });
    if (!hangingChild) queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const dependencies = { request: requestOwned, spawn: spawnOwned, startTimeoutMs: 40, ...options.dependencies };
  const controller = createBridgeController({ bridgeDirectory: directory, hostRuntime: { port: hostPort }, ...options.controller }, dependencies);
  const stop = () => controller.action({ action: 'stop', expectedBootId: boot, expectedInstanceId: identity });
  return { controller, directory, port, hostPort, identity, boot, access, secret, state, reads, writes, children,
    config, recorded, write, stop, set hangingChild(value) { hangingChild = value; },
    async close() {
      controller.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      const target = fs.realpathSync(directory);
      const relative = path.relative(temporaryBase, target);
      assert(!path.isAbsolute(relative) && !relative.startsWith('..') && relative.startsWith('pb-plugin-controller-'));
      assert.equal(path.dirname(target), temporaryBase);
      fs.rmSync(target, { recursive: true, force: true });
    } };
}

async function use(name, run, options) {
  await check(name, async () => { const fx = await fixture(options); try { await run(fx); } finally { await fx.close(); } });
}
async function bounded(promise, milliseconds = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('operation did not settle inside the test deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function main() {
  await use('Status is read-only and never returns connection secrets, notification URLs or messages', async fx => {
    const value = await fx.controller.status();
    assert.equal(value.state, 'running'); assert.equal(value.gateway.port, fx.port);
    const serialized = JSON.stringify(value);
    for (const forbidden of [fx.access, fx.secret, 'PRIVATE_FIXTURE_CONFIG', 'PRIVATE_FIXTURE_NOTIFY', 'PRIVATE_FIXTURE_MESSAGE', fx.directory]) assert(!serialized.includes(forbidden));
    assert.equal(fx.reads.some(value => value.path === '/__console/status'), false);
    assert.equal(fx.writes.length, 0); assert.equal(fx.children.length, 0);
  });
  await use('Connection exports only a verified complete HTTPS lightweight entrance', async fx => {
    const value = await fx.controller.connection();
    assert.equal(value.ok, true);
    const url = new URL(value.url);
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'fixture-bridge.example');
    assert.equal(url.pathname, `/k/${fx.access}`); assert.equal(url.searchParams.get('target'), 'lite');
    assert.equal(url.hash, `#k=${fx.secret}`);
    assert(!JSON.stringify(value).includes('PRIVATE_FIXTURE'));
    assert.equal(fx.reads.filter(value => value.path === '/__health').length, 2);
  });
  for (const [name, transform] of [
    ['plaintext URL', url => url.replace('https:', 'http:')],
    ['missing fragment key', url => url.split('#')[0]],
    ['unexpected query parameters', url => url.replace('#', '?raw=yes#')],
    ['mismatched tunnel origin', url => url.replace('fixture-bridge.example', 'different.example')],
    ['credentials in URL', url => url.replace('https://', 'https://user:password@')],
  ]) await use(`Connection rejects ${name}`, async fx => {
    fx.state.consoleStatus.entries.wan = transform(fx.state.consoleStatus.entries.wan);
    assert.equal((await fx.controller.connection()).ok, false);
  });
  await use('Connection rejects an unencrypted bridge rather than downgrading', async fx => {
    fx.state.consoleStatus.entries.encrypted = false;
    assert.equal((await fx.controller.connection()).ok, false);
  });
  await use('Connection rejects a known unreachable tunnel', async fx => {
    fx.state.consoleStatus.tunnel.reachable = false;
    assert.equal((await fx.controller.connection()).ok, false);
  });
  await use('Private HTTPS works without a public tunnel or wan entry', async fx => {
    fx.write('config.json', { ...fx.config, tunnelProvider: 'none', privateHttps: { enabled: true, origin: 'https://owned-private.example' } });
    fx.write('logs/status.json', { ...fx.recorded, tunnel: { url: null, running: false } });
    fx.state.consoleStatus.entries.wan = null;
    fx.state.consoleStatus.tunnel = { url: null, running: false };
    const result = await fx.controller.connection();
    assert.equal(result.ok, true); assert.equal(result.mode, 'private-https');
    assert.equal(new URL(result.url).origin, 'https://owned-private.example');
    assert.equal(new URL(result.url).hash, `#k=${fx.secret}`);
  });
  await use('A gateway targeting another DSH is not advertised and yields no QR', async fx => {
    fx.state.health.dshPort = fx.hostPort + 1;
    const status = await fx.controller.status();
    assert.equal(status.state, 'unavailable'); assert.equal(status.code, 'dsh-target-mismatch');
    assert.equal(status.connection.available, false);
    const result = await fx.controller.connection();
    assert.equal(result.ok, false); assert.equal(result.code, 'dsh-target-mismatch');
    assert.equal(fx.reads.some(value => value.path === '/__console/status'), false);
  });
  await use('A different installation UUID is never adopted from a preferred local port', async fx => {
    fx.state.health.instanceId = crypto.randomUUID();
    const status = await fx.controller.status();
    assert.equal(status.connection.available, false);
    assert.equal((await fx.controller.connection()).ok, false);
    assert.equal(fx.reads.some(value => value.path === '/__console/status'), false);
  });
  for (const field of ['bootId', 'instanceId', 'pid', 'dshPort', 'port', 'service']) await use(`Connection rejects changed ${field} during its final health confirmation`, async fx => {
    fx.state.onHealth = (req, res, count) => {
      if (count !== 2) return false;
      const value = { ...fx.state.health,
        [field]: ['bootId', 'instanceId'].includes(field) ? crypto.randomUUID()
          : field === 'service' ? 'unrelated-service' : fx.state.health[field] + 1 };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return true;
    };
    assert.equal((await fx.controller.connection()).ok, false);
  });
  await use('Connection rejects installation identity changed while the console responds', async fx => {
    fx.state.onConsole = (req, res) => {
      fx.write('logs/instance.json', { instanceId: crypto.randomUUID() });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fx.state.consoleStatus)); return true;
    };
    assert.equal((await fx.controller.connection()).ok, false);
  });
  await use('Stop sends only the observed matching installation and boot identity', async fx => {
    const result = await fx.stop();
    assert.equal(result.ok, true); assert.equal(result.phase, 'stopping');
    assert.deepEqual(fx.writes, [{ action: 'stop-gateway', expectedBootId: fx.boot, expectedInstanceId: fx.identity }]);
    assert.equal(fx.children.length, 0);
    const posted = fx.reads.find(value => value.path === '/__console/action');
    assert.equal(posted.origin, `http://127.0.0.1:${fx.port}`);
  });
  for (const field of ['expectedBootId', 'expectedInstanceId']) await use(`Stop rejects a stale ${field} before any write`, async fx => {
    const body = { action: 'stop', expectedBootId: fx.boot, expectedInstanceId: fx.identity, [field]: crypto.randomUUID() };
    assert.equal((await fx.controller.action(body)).ok, false); assert.equal(fx.writes.length, 0);
  });
  for (const field of ['ok', 'shutdownScheduled', 'bootId', 'instanceId', 'pid']) await use(`Stop never claims success with a mismatched acknowledgement ${field}`, async fx => {
    fx.state.ack[field] = ['ok', 'shutdownScheduled'].includes(field) ? false
      : ['bootId', 'instanceId'].includes(field) ? crypto.randomUUID() : process.pid + 1;
    assert.equal((await fx.stop()).ok, false);
  });
  await use('Explicit Start preserves unknown private configuration fields', async fx => {
    fx.state.healthStatus = 503;
    fx.write('config.json', { ...fx.config, dshPort: 0, extraNewField: { preserve: true } });
    const result = await fx.controller.action({ action: 'start' });
    assert.equal(result.ok, true); assert.equal(fx.children.length, 1);
    const config = JSON.parse(fs.readFileSync(path.join(fx.directory, 'config.json'), 'utf8'));
    assert.deepEqual(config.unknownSetting, fx.config.unknownSetting);
    assert.deepEqual(config.extraNewField, { preserve: true }); assert.equal(config.dshPort, fx.hostPort);
    assert.equal(fx.children[0].launchOptions.windowsHide, true);
    assert.equal(fx.children[0].launchOptions.cwd, fx.directory);
  });
  await use('Plugin Start pins its own DSH port in the child environment without changing the process environment', async fx => {
    fx.state.healthStatus = 503;
    const previous = process.env.DSH_GW_TARGET_PORT;
    const unrelated = String(fx.hostPort + 1);
    process.env.DSH_GW_TARGET_PORT = unrelated;
    try {
      const result = await fx.controller.action({ action: 'start' });
      assert.equal(result.ok, true); assert.equal(fx.children.length, 1);
      assert.equal(fx.children[0].launchOptions.env.DSH_GW_TARGET_PORT, String(fx.hostPort));
      assert.notEqual(fx.children[0].launchOptions.env, process.env);
      assert.equal(process.env.DSH_GW_TARGET_PORT, unrelated);
    } finally {
      if (previous === undefined) delete process.env.DSH_GW_TARGET_PORT;
      else process.env.DSH_GW_TARGET_PORT = previous;
    }
  });
  await use('Explicit Start never overwrites a previously selected different DSH port', async fx => {
    fx.state.healthStatus = 503;
    fx.write('config.json', { ...fx.config, dshPort: fx.hostPort + 1 });
    const before = fs.readFileSync(path.join(fx.directory, 'config.json'));
    const result = await fx.controller.action({ action: 'start' });
    assert.equal(result.ok, false); assert.equal(result.code, 'dsh-target-mismatch');
    assert.equal(fx.children.length, 0); assert(fs.readFileSync(path.join(fx.directory, 'config.json')).equals(before));
  });
  await use('Multiple Start actions are mutually exclusive during their lookup', async fx => {
    fx.state.healthStatus = 503;
    const first = fx.controller.action({ action: 'start' });
    const second = await fx.controller.action({ action: 'start' });
    assert.equal(second.ok, false); assert.equal(second.code, 'operation-pending');
    assert.equal((await first).ok, true); assert.equal(fx.children.length, 1);
  });
  await use('Status cannot unlock an unfinished Start spawn to admit a concurrent Stop', async fx => {
    fx.state.healthStatus = 503; fx.hangingChild = true;
    const starting = fx.controller.action({ action: 'start' });
    while (!fx.children.length) await new Promise(resolve => setTimeout(resolve, 1));
    fx.state.healthStatus = 200;
    await fx.controller.status();
    const stopped = await fx.stop();
    fx.children[0].child.emit('spawn'); await starting;
    assert.equal(stopped.ok, false); assert.equal(stopped.code, 'operation-pending');
    assert.equal(fx.writes.length, 0);
  });
  await use('An unconfirmed child spawn settles on a deadline without kill or retry', async fx => {
    fx.state.healthStatus = 503; fx.hangingChild = true;
    const startedAt = Date.now();
    const result = await bounded(fx.controller.action({ action: 'start' }));
    assert.equal(result.ok, false); assert(Date.now() - startedAt < 500);
    assert.equal(fx.children.length, 1); assert.equal(fx.writes.length, 0);
  });
  await use('Dispose aborts a waiting child spawn and settles its pending action', async fx => {
    fx.state.healthStatus = 503; fx.hangingChild = true;
    const pending = fx.controller.action({ action: 'start' });
    while (!fx.children.length) await new Promise(resolve => setTimeout(resolve, 1));
    fx.controller.dispose();
    const result = await bounded(pending);
    assert.equal(result.ok, false); assert.equal(result.code, 'plugin-unloaded');
    assert.equal(fx.children.length, 1); assert.equal(fx.writes.length, 0);
  });
  await use('Dispose aborts an active real HTTP transfer rather than awaiting its network timeout', async fx => {
    fx.state.onConsole = () => true;
    const pending = fx.controller.connection();
    while (!fx.reads.some(value => value.path === '/__console/status')) await new Promise(resolve => setTimeout(resolve, 1));
    fx.controller.dispose();
    const result = await bounded(pending);
    assert.equal(result.ok, false);
  });
  await use('An unresponsive owned health socket settles within its network deadline', async fx => {
    fx.state.onHealth = () => true;
    const startedAt = Date.now();
    const result = await bounded(fx.controller.status(), 1500);
    assert.equal(result.connection.available, false); assert(Date.now() - startedAt < 1500);
    assert.equal(fx.writes.length, 0); assert.equal(fx.children.length, 0);
  });
  await use('A failed child spawn restores the exact user pause marker', async fx => {
    fx.state.healthStatus = 503;
    const marker = Buffer.from('user chose pause\r\n');
    fs.writeFileSync(path.join(fx.directory, 'logs/user-stopped.flag'), marker);
    const result = await fx.controller.action({ action: 'start' });
    assert.equal(result.ok, false); assert.equal(result.code, 'start-unavailable');
    assert(fs.readFileSync(path.join(fx.directory, 'logs/user-stopped.flag')).equals(marker));
  }, { dependencies: { spawn() {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', Error('fixture spawn failure')));
    return child;
  } } });
  await use('Read-only package and source files may be pnpm hardlinks', async fx => {
    for (const relative of ['package.json', 'scripts/gateway-daemon.js', 'scripts/mobile-proxy.js']) {
      fs.linkSync(path.join(fx.directory, relative), path.join(fx.directory, `${path.basename(relative)}.store-link`));
    }
    assert.equal((await fx.controller.status()).state, 'running');
  });
  for (const relative of ['config.json', 'logs/instance.json', 'logs/status.json']) await use(`Mutable ${relative} hardlinks are refused before gateway use`, async fx => {
    fs.linkSync(path.join(fx.directory, relative), path.join(fx.directory, `${path.basename(relative)}.private-link`));
    const result = await fx.controller.status();
    assert.equal(result.ok, false); assert.equal(result.connection.available, false); assert.equal(fx.reads.length, 0);
  });
  await use('Diagnostics remains a finite redacted checklist without exposing configuration or message content', async fx => {
    const result = await fx.controller.diagnostics();
    assert.equal(result.ok, true); assert(result.checks.length > 0);
    const serialized = JSON.stringify(result);
    for (const secret of [fx.access, fx.secret, 'PRIVATE_FIXTURE', fx.directory]) assert(!serialized.includes(secret));
    assert.equal(fx.writes.length, 0); assert.equal(fx.children.length, 0);
  });
  process.stdout.write(`Pocket Bridge controller: ${passed} passed, ${failed.length} failed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
