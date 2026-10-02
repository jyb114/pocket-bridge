'use strict';
// Actual launcher orchestration with synthetic HTTP and child events. No live
// process inventory, native launch, browser, gateway, DSH or Codex is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createDesktopLauncher, readOwnGatewayRecord, probeHealth, MAX_RESPONSE_BYTES } = require('../desktop/open-desktop-app.js');
const temporaryRoot = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'pb-desktop-gateway-scope-'));
const ID = 'ca8ccbf7-22c2-4f6b-9882-b9dbf4d1405f', OTHER = '76d448d9-0e64-41ed-8fb9-3b4cdd206f3b';
const BOOT = '20e53591-486e-49b7-b5ec-a6b634027f34', NEW_BOOT = '8ca2db49-238d-4d1a-be1d-f7374ff9bcea';
const PORT = 19267, PID = 37;
let passed = 0, fixtureNumber = 0;
const health = extra => ({ service: 'pocket-bridge-gateway', instanceId: ID, bootId: BOOT, pid: PID, port: PORT, ...extra });
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function refused(fn) { await assert.rejects(fn, error => error.code === 'desktop-launch-unverified' && error.message === 'desktop-launch-unverified'); }
function fixture({ noRecord = false } = {}) {
  const base = path.join(scratch, 'installation-' + (++fixtureNumber)); fs.mkdirSync(base);
  if (!noRecord) writeRecord(base);
  return base;
}
function writeRecord(base, { instanceId = ID, port = PORT } = {}) {
  fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(base, 'logs', 'instance.json'), JSON.stringify({ instanceId, fingerprint: 'synthetic fixture' }));
  fs.writeFileSync(path.join(base, 'logs', 'gateway-port.txt'), String(port));
}
function httpFixture(answers = [health()]) {
  const calls = []; let destroyed = 0;
  const get = (options, callback) => {
    const request = new EventEmitter(); request.destroy = () => { destroyed++; request.emit('error', Error('synthetic transport failure')); };
    calls.push(options);
    queueMicrotask(() => {
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (typeof answer === 'function') { answer({ options, callback, request }); return; }
      const response = new EventEmitter(); response.statusCode = answer?.statusCode ?? 200;
      callback(response);
      response.emit('data', Buffer.from(answer?.body ?? JSON.stringify(answer)));
      response.emit('end');
    });
    return request;
  };
  return { get, calls, destroyed: () => destroyed };
}
function harness(base, extras = {}) {
  const network = extras.network || httpFixture(); const launches = []; let clock = 0;
  const launch = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => { extras.onSpawn?.(args); child.emit('spawn'); });
    return child;
  };
  const launcher = createDesktopLauncher({ base, executable: process.execPath, fileSystem: fs,
    get: network.get, launch, timeoutMs: 30, startupTimeoutMs: 3000,
    now: () => clock, sleep: async ms => { clock += ms; }, ...extras.options });
  return { launcher, launches, network, clock: () => clock };
}

async function run() {
  await check('missing first-run records perform no scan and create no identity', async () => {
    const base = fixture({ noRecord: true }), h = harness(base);
    assert.deepEqual(readOwnGatewayRecord(base), { instanceId: null, port: null });
    assert.equal(await h.launcher.findGateway(), null);
    assert.equal(h.network.calls.length, 0); assert.equal(fs.existsSync(path.join(base, 'logs')), false); assert.equal(h.launches.length, 0);
  });
  await check('only the own advertised port is read and two matching current boot observations are required', async () => {
    const base = fixture(), h = harness(base);
    assert.deepEqual(await h.launcher.findGateway(), { port: PORT, instanceId: ID, bootId: BOOT, pid: PID });
    assert.equal(h.network.calls.length, 2);
    for (const call of h.network.calls) assert.deepEqual(call, { host: '127.0.0.1', port: PORT, path: '/__health', agent: false, timeout: 30 });
    assert.equal(h.launches.length, 0);
  });
  await check('an already verified own gateway opens only its console using current Node without clearing stop', async () => {
    const base = fixture(), flag = path.join(base, 'logs', 'user-stopped.flag'); fs.writeFileSync(flag, 'retained-stop');
    const h = harness(base); assert.deepEqual(await h.launcher.open(), { opened: true });
    assert.equal(h.launches.length, 1);
    assert.deepEqual(h.launches[0], { executable: process.execPath,
      args: [path.join(base, 'desktop', 'open-console-app.js'), String(PORT), 'console'],
      options: { cwd: base, detached: true, stdio: 'ignore', windowsHide: true } });
    assert.equal(fs.readFileSync(flag, 'utf8'), 'retained-stop');
  });
  await check('a different installation at the advertised port is never selected', async () => {
    const base = fixture(), h = harness(base, { network: httpFixture([health({ instanceId: OTHER })]) });
    assert.equal(await h.launcher.findGateway(), null); assert.equal(h.network.calls.length, 1); assert.equal(h.launches.length, 0);
  });
  await check('different installation replies throughout startup never open a console or launch twice', async () => {
    const base = fixture(), h = harness(base, { network: httpFixture([health({ instanceId: OTHER })]) });
    await refused(() => h.launcher.open()); assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].args[0], path.join(base, 'scripts', 'gateway-daemon.js'));
    assert(h.network.calls.every(call => call.port === PORT)); assert.equal(h.clock(), 3000);
  });
  await check('legacy incomplete or malformed health cannot satisfy this launch boundary', async () => {
    const invalid = [health({ bootId: undefined }), health({ bootId: BOOT + '\n' }), health({ instanceId: null }),
      health({ pid: '37' }), health({ pid: 0 }), health({ pid: 0x100000000 }), health({ port: PORT + 1 }),
      health({ service: 'other-service' }), { statusCode: 302, body: JSON.stringify(health()) },
      { body: 'PRIVATE malformed {' }, { body: 'null' }, { body: '[]' }];
    for (const value of invalid) {
      const h = harness(fixture(), { network: httpFixture([value]) });
      assert.equal(await h.launcher.findGateway(), null); assert.equal(h.network.calls.length, 1); assert.equal(h.launches.length, 0);
    }
  });
  await check('boot or PID changes between current observations refuse the candidate', async () => {
    for (const changed of [health({ bootId: NEW_BOOT }), health({ pid: PID + 1 }), health({ instanceId: OTHER })]) {
      const h = harness(fixture(), { network: httpFixture([health(), changed]) });
      assert.equal(await h.launcher.findGateway(), null); assert.equal(h.network.calls.length, 2); assert.equal(h.launches.length, 0);
    }
  });
  await check('an own installation or port swap during the first observation refuses before second HTTP', async () => {
    for (const change of [{ instanceId: OTHER }, { port: PORT + 1 }]) {
      const base = fixture();
      const network = httpFixture([({ callback }) => {
        writeRecord(base, change); const response = new EventEmitter(); response.statusCode = 200; callback(response);
        response.emit('data', Buffer.from(JSON.stringify(health()))); response.emit('end');
      }]);
      const h = harness(base, { network }); assert.equal(await h.launcher.findGateway(), null); assert.equal(network.calls.length, 1);
    }
  });
  await check('an own record swap during the second observation also refuses before opening', async () => {
    const base = fixture(), network = httpFixture([health(), ({ callback }) => {
      writeRecord(base, { instanceId: OTHER }); const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit('data', Buffer.from(JSON.stringify(health()))); response.emit('end');
    }]);
    const h = harness(base, { network }); assert.equal(await h.launcher.findGateway(), null); assert.equal(h.launches.length, 0);
  });
  await check('a missing advertised port never falls back to arbitrary standard ports', async () => {
    const base = fixture(); fs.unlinkSync(path.join(base, 'logs', 'gateway-port.txt')); const h = harness(base);
    assert.equal(await h.launcher.findGateway(), null); assert.equal(h.network.calls.length, 0);
  });
  await check('corrupt oversized and invalid own records never clear stop or launch a process', async () => {
    const cases = [['instance.json', '{PRIVATE broken'], ['instance.json', JSON.stringify({ instanceId: ID + '\n' })],
      ['instance.json', 'x'.repeat(MAX_RESPONSE_BYTES + 1)], ['gateway-port.txt', '0'], ['gateway-port.txt', '65536'],
      ['gateway-port.txt', '8080/private'], ['gateway-port.txt', 'x'.repeat(33)]];
    for (const [name, text] of cases) {
      const base = fixture(), flag = path.join(base, 'logs', 'user-stopped.flag'); fs.writeFileSync(flag, 'keep');
      fs.writeFileSync(path.join(base, 'logs', name), text); const h = harness(base);
      await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0); assert.equal(h.network.calls.length, 0);
      assert.equal(fs.readFileSync(flag, 'utf8'), 'keep');
    }
  });
  await check('regular-file hardlink aliasing of own state is refused', async () => {
    for (const name of ['instance.json', 'gateway-port.txt']) {
      const base = fixture(), file = path.join(base, 'logs', name); fs.linkSync(file, path.join(base, 'alias'));
      const h = harness(base); await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0); assert.equal(h.network.calls.length, 0);
    }
  });
  await check('linked log directory and state metadata are refused without filesystem mutation', async () => {
    const base = fixture();
    for (const name of ['logs', path.join('logs', 'instance.json'), path.join('logs', 'gateway-port.txt')]) {
      const fileSystem = { ...fs, lstatSync(file) {
        const stat = fs.lstatSync(file); if (file === path.join(base, name)) stat.isSymbolicLink = () => true; return stat;
      } };
      const h = harness(base, { options: { fileSystem } }); await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0);
    }
  });
  await check('state replacement during the regular-file read is refused', async () => {
    const base = fixture(), file = path.join(base, 'logs', 'instance.json'); let replaced = false;
    const fileSystem = { ...fs, readFileSync(target) {
      const bytes = fs.readFileSync(target);
      if (target === file && !replaced) { replaced = true; const replacement = file + '.replacement'; fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, file); }
      return bytes;
    } };
    const h = harness(base, { options: { fileSystem } }); await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0);
  });
  await check('a fresh explicit installation starts its daemon then follows its newly advertised identity and port', async () => {
    const base = fixture({ noRecord: true }), h = harness(base, { onSpawn: args => {
      if (args[0] === path.join(base, 'scripts', 'gateway-daemon.js')) writeRecord(base);
    } });
    assert.deepEqual(await h.launcher.open(), { opened: true }); assert.equal(h.launches.length, 2);
    assert.equal(h.launches[0].args[0], path.join(base, 'scripts', 'gateway-daemon.js'));
    assert.equal(h.launches[1].args[0], path.join(base, 'desktop', 'open-console-app.js'));
    assert.equal(h.network.calls.length, 2);
  });
  await check('explicit restart removes only its own regular stop flag before starting its own daemon', async () => {
    const base = fixture(), unrelated = fixture(), flag = path.join(base, 'logs', 'user-stopped.flag');
    const unrelatedFlag = path.join(unrelated, 'logs', 'user-stopped.flag'); fs.writeFileSync(flag, 'own'); fs.writeFileSync(unrelatedFlag, 'other');
    const network = httpFixture([health({ instanceId: OTHER }), health(), health()]);
    const h = harness(base, { network, onSpawn: args => { if (args[0].endsWith('gateway-daemon.js')) assert.equal(fs.existsSync(flag), false); } });
    assert.equal((await h.launcher.open()).opened, true); assert.equal(h.launches.length, 2); assert.equal(fs.readFileSync(unrelatedFlag, 'utf8'), 'other');
  });
  await check('an unsafe stop marker is retained and cannot be cleared to start another daemon', async () => {
    const base = fixture(), flag = path.join(base, 'logs', 'user-stopped.flag'); fs.writeFileSync(flag, 'keep'); fs.linkSync(flag, path.join(base, 'stop-alias'));
    const h = harness(base, { network: httpFixture([health({ instanceId: OTHER })]) });
    await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0); assert.equal(fs.readFileSync(flag, 'utf8'), 'keep');
  });
  await check('pending or incomplete daemon ownership retains stop and is never reclaimed by a shortcut', async () => {
    for (const directory of [true, false]) {
      const base = fixture(), flag = path.join(base, 'logs', 'user-stopped.flag'); fs.writeFileSync(flag, 'keep');
      const lease = path.join(base, 'logs', 'daemon-operation.lock');
      if (directory) fs.mkdirSync(lease); else fs.writeFileSync(lease, 'incomplete-owner-evidence');
      const h = harness(base, { network: httpFixture([health({ instanceId: OTHER })]) });
      await refused(() => h.launcher.open()); assert.equal(h.launches.length, 0);
      assert.equal(fs.readFileSync(flag, 'utf8'), 'keep'); assert.equal(fs.existsSync(lease), true);
    }
  });
  await check('a failed native spawn is reported without repeated daemon or console launch', async () => {
    const base = fixture(); let attempts = 0;
    const h = harness(base, { options: { launch() {
      attempts++; const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('error', Error('PRIVATE executable detail'))); return child;
    } } });
    await refused(() => h.launcher.open()); assert.equal(attempts, 1);
  });
  await check('health floods are size bounded and destroy only the own request', async () => {
    const network = httpFixture([{ body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }]);
    assert.equal(await probeHealth(PORT, { get: network.get, timeoutMs: 30 }), null); assert.equal(network.destroyed(), 1);
  });
  await check('a silent synthetic health peer has an absolute deadline', async () => {
    const network = httpFixture([() => {}]), started = Date.now();
    assert.equal(await probeHealth(PORT, { get: network.get, timeoutMs: 20 }), null);
    assert.equal(network.destroyed(), 1); assert(Date.now() - started < 1000);
  });
  await check('trickled synthetic response bytes cannot extend the absolute deadline', async () => {
    let interval, destroyed = false;
    const network = httpFixture([({ callback, request }) => {
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      interval = setInterval(() => response.emit('data', Buffer.from(' ')), 2);
      request.destroy = () => { destroyed = true; clearInterval(interval); request.emit('error', Error('synthetic cutoff')); };
    }]);
    const started = Date.now(); try { assert.equal(await probeHealth(PORT, { get: network.get, timeoutMs: 20 }), null); }
    finally { clearInterval(interval); }
    assert.equal(destroyed, true); assert(Date.now() - started < 1000);
  });
  await check('an aborted synthetic response settles without selecting or launching a gateway', async () => {
    const network = httpFixture([({ callback }) => { const response = new EventEmitter(); response.statusCode = 200; callback(response); response.emit('aborted'); }]);
    const h = harness(fixture(), { network }); assert.equal(await h.launcher.findGateway(), null); assert.equal(h.launches.length, 0);
  });
  console.log(`${passed} isolated desktop gateway scope checks passed; no native action or live gateway access.`);
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(scratch);
  assert(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('pb-desktop-gateway-scope-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
