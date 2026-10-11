'use strict';

// Every native query/termination and every /proc read is a synthetic fixture.
// Never start cloudflared, query the host process table, or send a real signal.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProcessAdapter } = require('./tunnel-process.js');
const { quickLaunch, quickEnvironment } = require('./tunnel-runtime.js');

const PID = 4123;
const GENERATION = '0123456789abcdef0123456789abcdef';
const EXE = 'C:\\Program Files\\Pocket Bridge\\cloudflared\\cloudflared.exe';
const LOG = `C:\\Program Files\\Pocket Bridge\\logs\\tunnels\\primary-${GENERATION}.log`;
const CONFIG = LOG.replace(/\.log$/, '.yml');
const BIRTH = '639010000001234567';
const ARGS = ['tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate', '--logfile', LOG, '--metrics', '127.0.0.1:0', '--config', CONFIG];
const quote = value => /\s/.test(value) ? `"${value}"` : value;
const commandLine = [EXE, ...ARGS].map(quote).join(' ');
const record = () => ({ pid: PID, nativeExe: EXE, commandLine, birth: BIRTH });
const launch = () => ({ exe: EXE, args: [...ARGS], role: 'primary', generation: GENERATION, logFile: LOG, configFile: CONFIG });
const clone = value => JSON.parse(JSON.stringify(value));
const forbidden = async () => { throw Error('Unexpected real filesystem access'); };
let checks = 0;

function windowsFixture() {
  const fixture = { response: { state: 'live', process: record() }, calls: [], resolves: [], error: null };
  fixture.adapter = createProcessAdapter({
    platform: 'win32', timeoutMs: 5000, readFile: forbidden, readlink: forbidden,
    realpath: async value => { fixture.resolves.push(value); return fixture.realpath ? fixture.realpath(value) : path.win32.normalize(value); },
    execFile: (exe, args, options, callback) => {
      assert.equal(path.win32.basename(exe), 'powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      assert.equal(args.length, 5);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.shell, undefined);
      const script = Buffer.from(args[4], 'base64').toString('utf16le');
      const encodedInput = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
      assert(encodedInput, 'Native inputs travel as base64 JSON');
      const input = JSON.parse(Buffer.from(encodedInput[1], 'base64').toString('utf8'));
      fixture.calls.push({ script, input });
      queueMicrotask(() => callback(fixture.error, fixture.raw === undefined ? JSON.stringify(fixture.response) : fixture.raw));
    }
  });
  return fixture;
}
async function check(name, body) {
  await body(); checks++; console.log(`OK ${name}`);
}

async function main() {
  await check('runtime launch builder satisfies the real process-adapter contract and isolates environment', async () => {
    const built = quickLaunch('C:\\Program Files\\Pocket Bridge\\logs', 'primary', GENERATION, 8081, path.win32);
    assert.deepEqual(built.args, ARGS); assert.equal(built.logFile, LOG); assert.equal(built.configFile, CONFIG);
    const fixture = windowsFixture(); assert(await fixture.adapter.capture(PID, { exe: EXE, ...built }));
    assert.deepEqual(quickEnvironment({ PATH: 'synthetic-path', TUNNEL_TOKEN: 'synthetic-token',
      TUNNEL_ORIGIN_CERT: 'synthetic-cert', CLOUDFLARED_CONFIG: 'synthetic-config', tunnel_name: 'named', HOME: 'synthetic-home' }),
    { PATH: 'synthetic-path', HOME: 'synthetic-home' });
  });
  await check('capture binds exact native birth, executable, argv and generation marker', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    assert(proof);
    assert.equal(proof.version, 1); assert.equal(proof.platform, 'win32');
    assert.equal(proof.pid, PID); assert.equal(proof.exe, EXE); assert.equal(proof.nativeExe, EXE);
    assert.equal(proof.birth, BIRTH); assert.equal(typeof proof.birth, 'string');
    assert.equal(proof.commandLine, commandLine); assert.deepEqual(proof.args, ARGS);
    assert.equal(proof.generation, GENERATION); assert.equal(proof.role, 'primary'); assert.equal(proof.logFile, LOG);
    assert.equal(proof.configFile, CONFIG);
    assert.deepEqual(fixture.calls[0].input, { pid: PID });
    assert.equal((await fixture.adapter.inspect(proof)).state, 'live');
  });
  await check('capture refuses invalid marker, reordered or expanded argv before native access', async () => {
    for (const mutate of [
      value => { delete value.generation; }, value => { value.generation = 'same'; },
      value => { value.role = 'other'; }, value => { value.logFile = LOG.replace('tunnels', 'elsewhere'); },
      value => { value.args[5] += '.other'; }, value => { value.args.push('--extra'); },
      value => { value.args[1] = '--url=http://127.0.0.1:8081'; },
      value => { value.args[2] = 'http://localhost:8081'; }, value => { value.args[2] = 'http://127.0.0.1:65536'; },
      value => { value.args[6] = '--metrics=127.0.0.1:0'; }, value => { value.args[7] = '0.0.0.0:0'; },
      value => { delete value.configFile; }, value => { value.args.splice(8); },
      value => { value.args[8] = '--config=' + CONFIG; }, value => { value.args[9] += '.other'; },
      value => { value.configFile = value.args[9] = CONFIG.replace('primary-', 'backup-'); },
      value => { value.configFile = value.args[9] = CONFIG.replace(GENERATION, 'f'.repeat(32)); },
      value => { value.configFile = value.args[9] = CONFIG.replace('\\logs\\', '\\other\\'); },
      value => { value.configFile = value.args[9] = CONFIG.replace('\\tunnels\\', '\\tunnels\\..\\tunnels\\'); },
      value => { value.logFile = value.args[5] = LOG.replace('\\tunnels\\', '\\tunnels\\..\\tunnels\\'); }
    ]) {
      const fixture = windowsFixture(), data = launch(); mutate(data);
      assert.equal(await fixture.adapter.capture(PID, data), null);
      assert.equal(fixture.calls.length, 0);
    }
    const fixture = windowsFixture();
    for (const pid of [0, -1, 1.5, NaN, '4123', 0x80000000]) assert.equal(await fixture.adapter.capture(pid, launch()), null);
    assert.equal(fixture.calls.length, 0);
  });
  await check('capture refuses sibling executable, native PID mismatch and unowned argv', async () => {
    for (const mutate of [
      value => { value.nativeExe = EXE.replace('Pocket Bridge', 'Pocket Bridge-old'); value.commandLine = commandLine.replace('Pocket Bridge', 'Pocket Bridge-old'); },
      value => { value.pid++; }, value => { value.commandLine += ' --extra'; },
      value => { value.commandLine = commandLine.replace(GENERATION, 'f'.repeat(32)); },
      value => { value.commandLine = commandLine.replace('primary-', 'backup-'); },
      value => { value.commandLine = commandLine.replace('8081', '8082'); },
      value => { value.commandLine = `"C:\\other\\cloudflared.exe" ${ARGS.map(quote).join(' ')}`; },
      value => { value.commandLine = `"${EXE}\\" tunnel`; },
      value => { value.commandLine = `"${EXE}" "unclosed`; },
      value => { value.commandLine = `"${EXE}"x tunnel`; },
      value => { value.birth = null; }, value => { value.nativeExe = null; }
    ]) {
      const fixture = windowsFixture(); mutate(fixture.response.process);
      assert.equal(await fixture.adapter.capture(PID, launch()), null);
    }
  });
  await check('resolved executable aliases are compared exactly, never by prefix or basename', async () => {
    const fixture = windowsFixture();
    fixture.realpath = value => value === 'C:\\alias\\cloudflared.exe' ? EXE : path.win32.normalize(value);
    assert(await fixture.adapter.capture(PID, { ...launch(), exe: 'C:\\alias\\cloudflared.exe' }));
    assert(await fixture.adapter.capture(PID, { ...launch(), exe: EXE.toUpperCase() }));
    assert.equal(await fixture.adapter.capture(PID, { ...launch(), exe: 'cloudflared.exe' }), null);
    fixture.realpath = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    assert.equal(await fixture.adapter.capture(PID, launch()), null);
  });
  await check('only absence or a changed birth proves exit; identity mismatch remains unknown', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    fixture.response.process.birth = '639010000001234568';
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'exited', code: 'birth-changed' });
    fixture.response = { state: 'exited' };
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'exited' });
    fixture.response = { state: 'live', process: record() };
    fixture.response.process.commandLine += ' --extra';
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'unknown', code: 'identity-changed' });
    fixture.response.process = record();
    fixture.response.process.commandLine = commandLine.replace(' tunnel ', '  tunnel ');
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'unknown', code: 'identity-changed' });
    fixture.response.process = record();
    fixture.response.process.nativeExe = EXE.replace('Pocket Bridge', 'Other Bridge');
    fixture.response.process.commandLine = commandLine.replace('Pocket Bridge', 'Other Bridge');
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'unknown', code: 'identity-changed' });
  });
  await check('native denied, timed-out, malformed and partial queries fail closed', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    for (const response of [null, [], {}, { state: 'ok' }, { state: 'live' }, { state: 'live', process: {} }, { state: 'unknown' }]) {
      fixture.response = response;
      assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    }
    for (const raw of ['', 'not json', '{"state":"exited"}\nextra']) {
      fixture.raw = raw; assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    }
    delete fixture.raw; fixture.error = Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
    assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    assert.equal(await fixture.adapter.capture(PID, launch()), null);
  });
  await check('invalid or altered proof never reaches native stop', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    const before = fixture.calls.length;
    for (const mutate of [
      value => { value.version = 2; }, value => { value.platform = 'linux'; },
      value => { value.pid = 0; }, value => { delete value.birth; },
      value => { value.birth = Number(BIRTH); },
      value => { value.commandLine += ' --extra'; }, value => { value.args.push('--extra'); },
      value => { value.generation = '0'.repeat(32); }, value => { value.logFile += '.changed'; },
      value => { value.configFile += '.changed'; },
      value => { value.exe = 'cloudflared.exe'; }, value => { value.nativeExe = null; }
    ]) {
      const bad = clone(proof); mutate(bad);
      assert.deepEqual(await fixture.adapter.stop(bad), { stopped: false, code: 'invalid-proof' });
      assert.equal((await fixture.adapter.inspect(bad)).state, 'unknown');
    }
    assert.equal(fixture.calls.length, before);
  });
  await check('in-flight native actions use a snapshot rather than caller-mutable proof or launch argv', async () => {
    const fixture = windowsFixture(), input = launch();
    const capture = fixture.adapter.capture(PID, input);
    input.args[5] = 'changed'; input.generation = 'f'.repeat(32);
    const proof = await capture;
    assert(proof); assert.equal(proof.generation, GENERATION); assert.deepEqual(proof.args, ARGS);
    const original = clone(proof);
    fixture.response = { stopped: true, code: 'stopped' };
    const stop = fixture.adapter.stop(proof);
    proof.pid++; proof.birth = '639999999999999999'; proof.args.push('changed');
    assert.equal((await stop).stopped, true);
    assert.equal(fixture.calls.at(-1).input.pid, original.pid);
    assert.equal(fixture.calls.at(-1).input.birth, original.birth);
    assert.deepEqual(fixture.calls.at(-1).input.args, original.args);
  });
  await check('Windows stop request pins handle before birth/CIM checks, exact command and held kill/wait', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    fixture.response = { stopped: true, code: 'stopped' };
    assert.deepEqual(await fixture.adapter.stop(proof), { stopped: true, code: 'stopped' });
    const { script, input } = fixture.calls.at(-1);
    assert.equal(input.birth, BIRTH); assert.equal(input.nativeExe, EXE); assert.equal(input.commandLine, commandLine);
    assert.equal(input.waitMs, 3000);
    const body = script.slice(script.lastIndexOf('$held = $null'));
    const positions = ['$held = Get-Process', '$null = $held.Handle', '$birth = $held.StartTime', '$info = Read-Info',
      '[StringComparison]::Ordinal)', '$held.Kill()', '$held.WaitForExit', '$held.Dispose()'].map(text => body.indexOf(text));
    assert(positions.every(value => value >= 0));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert(body.includes("$birth -cne [string]$inputData.birth"));
    assert(body.includes('Same-Birth $info $held'));
    assert(body.includes('Same-Path $info.ExecutablePath $inputData.nativeExe'));
    assert(!/\b(?:Stop-Process|taskkill|pkill)\b/.test(body.replace(/#.*$/gm, '')));
    assert.equal((body.match(/Get-Process /g) || []).length, 1);
    assert(!script.includes(EXE), 'User paths must not be interpolated into script syntax');
  });
  await check('stop remains unconfirmed after rejected identity, timeout, failed wait or malformed success', async () => {
    const fixture = windowsFixture(), proof = await fixture.adapter.capture(PID, launch());
    for (const code of ['process-changed', 'identity-changed', 'stop-unconfirmed']) {
      fixture.response = { stopped: false, code };
      assert.deepEqual(await fixture.adapter.stop(proof), { stopped: false, code });
    }
    for (const response of [{ stopped: true }, { stopped: 'true', code: 'stopped' }, { stopped: true, code: 'ignored' }, null]) {
      fixture.response = response;
      assert.deepEqual(await fixture.adapter.stop(proof), { stopped: false, code: 'stop-unconfirmed' });
    }
    fixture.error = Error('native stop timeout');
    assert.deepEqual(await fixture.adapter.stop(proof), { stopped: false, code: 'stop-unconfirmed' });
    fixture.error = null; fixture.response = { stopped: true, code: 'already-exited' };
    assert.deepEqual(await fixture.adapter.stop(proof), { stopped: true, code: 'already-exited' });
    const before = fixture.calls.length;
    fixture.realpath = () => EXE.replace('Pocket Bridge', 'Somebody Else');
    assert.deepEqual(await fixture.adapter.stop(proof), { stopped: false, code: 'identity-changed' });
    assert.equal(fixture.calls.length, before);
  });
  await check('Windows discovery returns exact executable candidates, retaining legacy argv for manager admission', async () => {
    const fixture = windowsFixture(), legacy = record(), other = record();
    legacy.commandLine = [EXE, 'tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate'].map(quote).join(' ');
    other.pid++; other.nativeExe = EXE.replace('Pocket Bridge', 'Pocket Bridge-old');
    other.commandLine = commandLine.replace('Pocket Bridge', 'Pocket Bridge-old');
    fixture.response = { state: 'ok', processes: [legacy, other] };
    const result = await fixture.adapter.list({ exe: EXE });
    assert.equal(result.state, 'ok'); assert.equal(result.processes.length, 1);
    assert.deepEqual(result.processes[0].args, ['tunnel', '--url', 'http://127.0.0.1:8081', '--no-autoupdate']);
    assert.equal(result.processes[0].role, undefined);
    fixture.response = { state: 'live', process: legacy };
    assert.equal((await fixture.adapter.inspect(result.processes[0])).state, 'live');
    fixture.response = { state: 'ok', processes: [] };
    assert.deepEqual(await fixture.adapter.list({ exe: EXE }), { state: 'ok', processes: [] });
  });
  await check('discovery never converts denied, malformed, duplicate or partial candidates to ok-empty', async () => {
    const fixture = windowsFixture();
    for (const response of [
      { state: 'unknown', processes: [] }, { state: 'ok' }, { state: 'ok', processes: null },
      { state: 'ok', processes: [{}] }, { state: 'ok', processes: [record(), record()] },
      { state: 'ok', processes: [{ ...record(), commandLine: null }] },
      { state: 'ok', processes: [{ ...record(), nativeExe: null }] }
    ]) {
      fixture.response = response;
      const result = await fixture.adapter.list({ exe: EXE });
      assert.equal(result.state, 'unknown'); assert.deepEqual(result.processes, []);
    }
    fixture.error = Error('CIM denied');
    assert.equal((await fixture.adapter.list({ exe: EXE })).state, 'unknown');
  });

  const LINUX_EXE = '/opt/pocket bridge/cloudflared';
  const LINUX_LOG = `/opt/pocket bridge/logs/tunnels/primary-${GENERATION}.log`;
  const LINUX_CONFIG = LINUX_LOG.replace(/\.log$/, '.yml');
  const linuxArgs = [...ARGS]; linuxArgs[5] = LINUX_LOG; linuxArgs[9] = LINUX_CONFIG;
  const linuxLaunch = { exe: LINUX_EXE, args: linuxArgs, role: 'primary', generation: GENERATION, logFile: LINUX_LOG, configFile: LINUX_CONFIG };
  const bootId = '01234567-89ab-cdef-0123-456789abcdef';
  const stat = (start = '70123', state = 'S') => `${PID} (cloudflare ) weird) ${[state, ...Array(18).fill('0'), start, '0'].join(' ')}\n`;
  function linuxFixture() {
    const fixture = { stats: [stat(), stat()], count: 0, reads: [], bytes: Buffer.from([LINUX_EXE, ...linuxArgs, ''].join('\0')) };
    fixture.adapter = createProcessAdapter({ platform: 'linux', execFile: () => { throw Error('Native exec forbidden'); },
      realpath: async value => { assert.equal(value, LINUX_EXE); return value; },
      readlink: async value => { assert.equal(value, `/proc/${PID}/exe`); return fixture.exe || LINUX_EXE; },
      readFile: async value => {
        fixture.reads.push(value);
        if (fixture.failure) throw Object.assign(Error('synthetic denied'), { code: fixture.failure });
        if (value === `/proc/${PID}/stat`) return fixture.stats[Math.min(fixture.count++, fixture.stats.length - 1)];
        if (value === `/proc/${PID}/cmdline`) return fixture.bytes;
        if (value === '/proc/sys/kernel/random/boot_id') return bootId;
        throw Error('Unexpected /proc path');
      }
    });
    return fixture;
  }
  await check('Linux inspection uses boot ID, exact start tick, resolved executable and NUL-separated argv', async () => {
    const fixture = linuxFixture(), proof = await fixture.adapter.capture(PID, linuxLaunch);
    assert(proof); assert.equal(proof.birth, `${bootId}:70123`); assert.deepEqual(proof.args, linuxArgs);
    assert.equal((await fixture.adapter.inspect(proof)).state, 'live');
    fixture.stats = [stat('70124')]; fixture.count = 0;
    assert.deepEqual(await fixture.adapter.inspect(proof), { state: 'exited', code: 'birth-changed' });
  });
  await check('Linux PID reuse mid-query, missing argv, deleted executable and access denial remain unknown', async () => {
    const fixture = linuxFixture(), proof = await fixture.adapter.capture(PID, linuxLaunch);
    fixture.stats = [stat(), stat('99999')]; fixture.count = 0;
    assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    fixture.stats = [stat()]; fixture.count = 0; fixture.bytes = Buffer.from('missing trailing NUL');
    assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    fixture.exe = `${LINUX_EXE} (deleted)`;
    assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    fixture.failure = 'EACCES';
    assert.equal((await fixture.adapter.inspect(proof)).state, 'unknown');
    fixture.failure = 'ENOENT';
    assert.equal((await fixture.adapter.inspect(proof)).state, 'exited');
    fixture.failure = null; fixture.stats = [stat('70123', 'Z')];
    assert.equal((await fixture.adapter.inspect(proof)).state, 'exited');
  });
  await check('Linux persisted stop/discovery refuse unsupported ownership binding without signalling', async () => {
    const fixture = linuxFixture(), proof = await fixture.adapter.capture(PID, linuxLaunch);
    const before = fixture.reads.length;
    assert.deepEqual(await fixture.adapter.stop(proof), { stopped: false, code: 'pidfd-required' });
    assert.deepEqual(await fixture.adapter.list({ exe: LINUX_EXE }), { state: 'unknown', processes: [], code: 'discovery-unsupported' });
    assert.equal(fixture.reads.length, before);
    const unsupported = createProcessAdapter({ platform: 'darwin', execFile: forbidden, readFile: forbidden, realpath: forbidden, readlink: forbidden });
    assert.equal((await unsupported.inspect(proof)).state, 'unknown');
    assert.equal((await unsupported.list({ exe: LINUX_EXE })).state, 'unknown');
    assert.equal(await unsupported.capture(PID, linuxLaunch), null);
  });
  console.log(`\n${checks} synthetic process-proof groups passed; real Windows execution and real tunnels were not exercised.`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
