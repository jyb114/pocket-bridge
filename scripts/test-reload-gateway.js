'use strict';
// Isolated scoped reload admission: fake HTTP plus one disposable loopback
// fixture. No real gateway, native process, GUI, DSH or restart helper is run.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { requestScopedGatewayRestart, boundedHttpRequest, readOwnIdentity, MAX_RESPONSE_BYTES, main } = require('./reload-gateway.js');
const base = path.resolve(__dirname, '..', '..', 'reload-admission-check-20261001', `run-${Date.now()}-${process.pid}`);
if (path.parse(base).root.toLowerCase() !== 'd:\\') throw Error('Reload fixtures must stay on D:.');
fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
const ID = '30b967a9-060a-4a2b-bf57-c03df0ef5fe4', BOOT = '63dc1c8c-33aa-4238-91c4-44dd7047fa1b';
const PID = 7, PORT = 19099; let checks = 0;
fs.writeFileSync(path.join(base, 'logs', 'instance.json'), JSON.stringify({ instanceId: ID, fingerprint: 'PRIVATE synthetic metadata' }));
const health = (extra = {}) => ({ service: 'pocket-bridge-gateway', instanceId: ID, bootId: BOOT, pid: PID, port: PORT, ...extra });
const accepted = (extra = {}) => ({ ok: true, restarting: true, restartScheduled: true, bootId: BOOT, restartBootId: BOOT, instanceId: ID, pid: PID,
  shutdown: { phase: 'draining', kind: 'restart', code: null }, restartState: { phase: 'draining', kind: 'restart', code: null }, ...extra });
const response = (body, statusCode = 200) => ({ statusCode, body: JSON.stringify(body) });
function mock(healthResponse = response(health()), actionResponse = response(accepted(), 202)) {
  const calls = [];
  return { calls, request: async input => { calls.push(input); return input.method === 'GET' ? healthResponse : actionResponse; } };
}
const options = request => ({ base, expectedPid: PID, port: PORT, request, timeoutMs: 100 });
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
async function denied(code, fn) { await assert.rejects(fn, error => error.code === code && !error.message.includes('PRIVATE')); }
async function withServer(handler, run) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function run() {
  await check('own installation read returns only the UUID and never generates identity', async () => {
    assert.deepEqual(readOwnIdentity(base), { instanceId: ID });
    const missing = path.join(base, 'missing'); await denied('instance-unavailable', () => requestScopedGatewayRestart({ ...options(async () => assert.fail('No HTTP permitted')), base: missing }));
    assert.equal(fs.existsSync(missing), false);
  });
  await check('verified health produces one exact Origin and identity-bound restart POST with scheduled-only result', async () => {
    const f = mock(); const result = await requestScopedGatewayRestart(options(f.request)); assert.deepEqual(result, { scheduled: true, completed: false });
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].pathname, '/__health'); assert.equal(f.calls[1].pathname, '/__console/action');
    assert.equal(f.calls[1].headers.origin, 'http://127.0.0.1:19099'); assert.equal(f.calls[1].headers.host, '127.0.0.1:19099');
    assert.deepEqual(JSON.parse(f.calls[1].body), { action: 'restart-gateway', expectedBootId: BOOT, expectedInstanceId: ID, expectedPid: PID });
    assert(!JSON.stringify(result).includes(ID)); assert(!JSON.stringify(result).includes(base));
  });
  await check('old unverified health, malformed UUID and a non-gateway service cannot reach POST', async () => {
    for (const body of [health({ bootId: undefined }), health({ bootId: BOOT + '\n' }), health({ instanceId: 'bad' }),
      health({ service: 'another-service' }), health({ pid: '7' }), health({ port: 19100 })]) {
      const f = mock(response(body)); await denied('gateway-unverified', () => requestScopedGatewayRestart(options(f.request))); assert.equal(f.calls.length, 1);
    }
  });
  await check('different supplied PID or installation identity refuses all mutations', async () => {
    for (const body of [health({ pid: 8 }), health({ instanceId: '8a0c345f-de19-4878-8323-e9f83bba362c' })]) {
      const f = mock(response(body)); await denied('gateway-identity-mismatch', () => requestScopedGatewayRestart(options(f.request))); assert.equal(f.calls.length, 1);
    }
  });
  await check('generic legacy acceptance, changed boot, failed drain and inconsistent receipt never claim scheduled success', async () => {
    for (const value of [response({ ok: true }), response(accepted(), 200), response(accepted({ bootId: '8a0c345f-de19-4878-8323-e9f83bba362c' }), 202),
      response(accepted({ pid: 8 }), 202), response(accepted({ restartScheduled: false }), 202),
      response(accepted({ shutdown: { phase: 'failed', kind: 'restart', code: 'desktop-drain-failed' } }), 503),
      response(accepted({ restartState: { phase: 'closed', kind: 'restart', code: null } }), 202)]) {
      const f = mock(undefined, value); await denied('restart-not-scheduled', () => requestScopedGatewayRestart(options(f.request))); assert.equal(f.calls.length, 2);
    }
  });
  await check('missing corrupt or oversized own identity never performs an HTTP request', async () => {
    for (const readIdentity of [() => null, () => ({ instanceId: ID + '\n' }), () => { throw Error('PRIVATE config contents'); }]) {
      await denied('instance-unavailable', () => requestScopedGatewayRestart({ ...options(async () => assert.fail('No HTTP permitted')), readIdentity }));
    }
    const invalid = path.join(base, 'invalid'); fs.mkdirSync(path.join(invalid, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(invalid, 'logs', 'instance.json'), 'x'.repeat(MAX_RESPONSE_BYTES + 1));
    await denied('instance-unavailable', () => requestScopedGatewayRestart({ ...options(async () => assert.fail('No HTTP permitted')), base: invalid }));
  });
  await check('bounded response parsing rejects oversized and invalid JSON without forwarding private bytes', async () => {
    for (const [body, code] of [['PRIVATE'.repeat(MAX_RESPONSE_BYTES), 'gateway-response-too-large'], ['PRIVATE {broken', 'invalid-gateway-response'], ['null', 'invalid-gateway-response']]) {
      const f = mock({ statusCode: 200, body }); await denied(code, () => requestScopedGatewayRestart(options(f.request))); assert.equal(f.calls.length, 1);
    }
  });
  await check('a hanging mock exchange times out and aborts without attempting POST', async () => {
    let calls = 0, signal;
    await denied('transport-timeout', () => requestScopedGatewayRestart({ ...options(input => { calls++; signal = input.signal; return new Promise(() => {}); }), timeoutMs: 10 }));
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  });
  await check('invalid helper parameters and CLI arguments report only fixed sanitized messages', async () => {
    for (const extra of [{ expectedPid: 0 }, { port: 65536 }, { port: '19099' }, { base: 'relative' }, { arbitraryCommand: 'PRIVATE' }]) {
      await denied('invalid-reload-request', () => requestScopedGatewayRestart({ ...options(async () => assert.fail('No HTTP permitted')), ...extra }));
    }
    const printed = [];
    for (const argv of [[], ['0'], ['7; PRIVATE'], ['7', '0'], ['7', '19099', 'PRIVATE']]) {
      assert.equal(await main(argv, { log: value => printed.push(value), error: value => printed.push(value) }), 1);
    }
    assert(printed.every(value => value === 'Gateway restart was not scheduled (invalid-reload-request).'));
  });
  await check('successful reload admission cannot call native spawn, kill or signal APIs', async () => {
    const cp = require('node:child_process'), oldKill = process.kill, originals = {}; let nativeCalls = 0;
    process.kill = () => { nativeCalls++; throw Error('Unexpected native action.'); };
    for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync']) { originals[key] = cp[key]; cp[key] = process.kill; }
    try { assert.equal((await requestScopedGatewayRestart(options(mock().request))).scheduled, true); assert.equal(nativeCalls, 0); }
    finally { process.kill = oldKill; for (const [key, value] of Object.entries(originals)) cp[key] = value; }
  });
  await check('real disposable loopback HTTP uses the actual bounded transport and exact scoped POST', async () => {
    let posts = 0, ownedPort;
    await withServer((req, res) => {
      assert.equal(req.headers.host, `127.0.0.1:${ownedPort}`); assert.equal(req.headers.origin, `http://127.0.0.1:${ownedPort}`);
      if (req.method === 'GET' && req.url === '/__health') { res.writeHead(200); res.end(JSON.stringify(health({ port: ownedPort }))); return; }
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/__console/action'); posts++;
      const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { action: 'restart-gateway', expectedBootId: BOOT, expectedInstanceId: ID, expectedPid: PID });
        res.writeHead(202); res.end(JSON.stringify(accepted()));
      });
    }, async port => { ownedPort = port; assert.deepEqual(await requestScopedGatewayRestart({ base, expectedPid: PID, port, request: boundedHttpRequest }), { scheduled: true, completed: false }); });
    assert.equal(posts, 1);
  });
  await check('real disposable HTTP response flood and a silent peer are bounded and cannot reach POST', async () => {
    let posts = 0;
    await withServer((req, res) => { if (req.method === 'POST') posts++; res.writeHead(200); res.end('x'.repeat(MAX_RESPONSE_BYTES + 1)); },
      async port => { await denied('gateway-response-too-large', () => requestScopedGatewayRestart({ base, expectedPid: PID, port })); });
    assert.equal(posts, 0);
    await withServer(() => {}, async port => { await denied('transport-timeout', () => requestScopedGatewayRestart({ base, expectedPid: PID, port, timeoutMs: 20 })); });
  });
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ passed: checks, failed: 0, nativeActions: 0, liveGateway: false, helperSpawned: false }, null, 2));
  console.log(`${checks} isolated scoped reload checks passed. Evidence: ${base}`);
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
