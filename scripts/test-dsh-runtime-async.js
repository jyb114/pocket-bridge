'use strict';

// Real owned HTTP/subprocess scheduling with synthetic OS inventory data. No
// installed DSH is executed, model request sent, or external process stopped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const child = require('node:child_process');
const runtime = require('./dsh-runtime');
const discover = require('./discover');
const adapter = require('./dsh-adapter');

let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function check(value, message) { assert.ok(value, message); checks++; }
const auth = { statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'dsh web authentication required' };
const desktop = pid => ({ ProcessId: pid, Name: 'DeepSeek Harness.exe', ExecutablePath: 'D:\\synthetic\\DeepSeek Harness.exe', CommandLine: '"D:\\synthetic\\DeepSeek Harness.exe"' });
const desktopApi = { ...adapter, readDesktopVersion: () => ({ version: '0.1.7-rc.2', source: 'desktop-asar' }) };
const none = { installed: false, desktop: null, cli: null, launch: null };

function fileCall(exec, file, args, options) {
  return new Promise((resolve, reject) => exec(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function queryResult(file, pid = 9123, port = 19003) {
  if (file === 'powershell') return JSON.stringify([desktop(pid), { ProcessId: 11, Name: 'node.exe', CommandLine: 'node.exe unrelated.js web' }]);
  if (file === 'netstat') return '  TCP 127.0.0.1:' + port + ' 0.0.0.0:0 LISTENING ' + pid + '\r\n' +
    '  TCP 127.0.0.1:19999 0.0.0.0:0 LISTENING 91234\r\n' +
    '  TCP 127.0.0.1:19888 0.0.0.0:0 ESTABLISHED ' + pid + '\r\n';
  throw Error('Unexpected inventory command');
}
function validateInventory(file, args, options) {
  check(options.windowsHide === true && options.encoding === 'utf8' && !options.shell, 'hidden UTF-8 direct argv, never shell execution');
  equal(options.stdio, ['ignore', 'pipe', 'ignore'], 'no process stderr is disclosed');
  equal(options.timeout, file === 'netstat' ? 10000 : 8000, 'existing command deadline retained');
  equal(options.maxBuffer, (file === 'netstat' ? 1 : 4) * 1024 * 1024, 'inventory output remains bounded');
  if (file === 'powershell') {
    equal(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'], 'CIM inventory has separate PowerShell argv');
    check(args[3].startsWith('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; '), 'Windows pipe explicitly emits UTF-8');
    check(args[3].includes('Get-CimInstance Win32_Process -Filter') && args[3].includes('ExecutablePath,CommandLine'), 'original filtered process identity fields retained');
  } else equal(args, ['-ano'], 'one bounded owner inventory for all PIDs');
}

function loadDiscover(execFileSync) {
  const filename = path.join(__dirname, 'discover.js'), mod = { exports: {} }, local = createRequire(filename);
  const context = vm.createContext({ module: mod, exports: mod.exports,
    process: { platform: 'win32', env: process.env },
    require(name) { return name === 'child_process' ? { execFile: child.execFile, execFileSync } : local(name); } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return mod.exports;
}

async function responsiveness(asynchronous) {
  let phase = 'not-started', calls = 0;
  const runner = (file, args, options, callback) => {
    calls++;
    phase = file === 'powershell' ? 'process-inventory' : 'listener-inventory';
    const code = 'setTimeout(()=>process.stdout.write(' + JSON.stringify(queryResult(file)) + '),600)';
    if (callback) return child.execFile(process.execPath, ['-e', code], options, (error, stdout) => {
      phase = file === 'powershell' ? 'process-complete' : 'listener-complete'; callback(error, stdout);
    });
    const value = child.execFileSync(process.execPath, ['-e', code], options);
    phase = file === 'powershell' ? 'process-complete' : 'listener-complete'; return value;
  };
  const syncDiscover = loadDiscover(runner);
  const deps = { platform: 'win32', adapter: desktopApi, detectInstallation: () => none,
    probeDshRuntime: async input => {
      phase = 'http-probe';
      return adapter.createRuntimeRecord({ ...input, fingerprint: adapter.fingerprintDshHttp(auth) });
    } };
  if (asynchronous) deps.execFile = runner;
  else {
    // The synchronous exports reconstruct the old hot path as a positive
    // blocking control, using the same synthetic child output and delays.
    deps.scanProcesses = () => runtime.scanProcesses({ platform: 'win32', adapter: desktopApi, execFileSync: runner });
    deps.listeningPortsOf = syncDiscover.listeningPortsOf;
  }
  const resolver = runtime.createRuntimeResolver(deps);
  equal(resolver.detectInstallation({}), none, 'cold resolver installation export retains its synchronous contract');
  equal(await resolver.detectInstallationAsync({}), none, 'resolver separately exposes asynchronous installation');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/refresh') {
      const result = await resolver.resolveRuntime({}, { force: true });
      res.end(JSON.stringify({ running: result.running, port: result.port, pid: result.pid }));
    } else res.end(JSON.stringify({ phase }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = `
      const http=require('node:http'),p=${port};
      function read(route){const start=performance.now();return new Promise((resolve,reject)=>{
        const req=http.get({host:'127.0.0.1',port:p,path:route},res=>{let s='';res.on('data',c=>s+=c);
          res.on('end',()=>resolve({ms:performance.now()-start,result:JSON.parse(s)}));});
        req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('test deadline')));});}
      (async()=>{const refresh=read('/refresh');await new Promise(r=>setTimeout(r,100));
        const health=await read('/health');console.log(JSON.stringify({health,refresh:await refresh}));})()
        .catch(e=>{console.error(e.stack);process.exitCode=1;});
    `;
    const output = await fileCall(child.execFile, process.execPath, ['-e', client], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true
    });
    const measured = JSON.parse(output);
    equal(calls, 2, 'process and all-listener inventory each execute once');
    equal(measured.refresh.result, { running: true, port: 19003, pid: 9123 }, 'fresh matching process/listener/HTTP identity remains mandatory');
    if (asynchronous) check(['process-inventory', 'listener-inventory'].includes(measured.health.result.phase), 'real HTTP health completes while slow OS query is still pending');
    else equal(measured.health.result.phase, 'http-probe', 'positive synchronous control blocks health until both queries finish');
    return { mode: asynchronous ? 'async' : 'sync-control', healthMs: Math.round(measured.health.ms), refreshMs: Math.round(measured.refresh.ms) };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function inventoryAndCache() {
  let time = 1000, pid = 9123, port = 19003, scans = 0, listeners = 0, probes = 0, deny = false, fail = null, held = null;
  const execFile = (file, args, options, callback) => {
    validateInventory(file, args, options);
    if (file === 'powershell') scans++; else listeners++;
    const finish = () => fail === file ? callback(Object.assign(Error('synthetic inventory failure'), { code: 'ETIMEDOUT' })) : callback(null, queryResult(file, pid, port));
    if (held && file === 'powershell') held.push(finish); else setImmediate(finish);
  };
  const resolver = runtime.createRuntimeResolver({ platform: 'win32', execFile, adapter: desktopApi, now: () => time,
    detectInstallation: () => none, probeDshRuntime: async input => {
      probes++; equal(input.pid, pid, 'probe binds the exact current process owner');
      equal(input.port, port, 'foreign PID and non-listener never reach HTTP probe');
      return adapter.createRuntimeRecord({ ...input, fingerprint: adapter.fingerprintDshHttp(deny ? {} : auth) });
    } });
  await Promise.all([resolver.resolveRuntime({}), resolver.resolveRuntime({}), resolver.resolveRuntime({}, { force: true })]);
  equal([scans, listeners, probes], [1, 1, 1], 'normal and forced concurrent callers share one pending fresh scan');
  time += 4999; await resolver.resolveRuntime({});
  equal(scans, 1, 'existing 5-second TTL is retained');
  time++; equal(resolver.peekRuntime(), null, 'expired fingerprint never becomes synchronous admission');
  held = []; const refresh = resolver.resolveRuntime({});
  await new Promise(resolve => setImmediate(resolve));
  equal(resolver.peekRuntime(), null, 'pending refresh does not return an expired last-good fingerprint');
  held.shift()(); held = null; await refresh;
  equal(scans, 2, 'expired cache performs a new OS query');
  pid = 9124; port = 19004;
  equal((await resolver.resolveRuntime({}, { force: true })).port, 19004, 'forced refresh follows newly verified process and listener');
  deny = true;
  equal((await resolver.resolveRuntime({}, { force: true })).running, false, 'negative fresh HTTP cannot inherit the prior positive fingerprint');
  deny = false; fail = 'netstat';
  equal((await resolver.resolveRuntime({}, { force: true })).running, false, 'listener query timeout is no listener evidence');
  fail = 'powershell';
  equal((await resolver.resolveRuntime({}, { force: true })).running, false, 'process inventory timeout cannot authorize an unrelated listener');
  fail = null; resolver.invalidateRuntime();
  equal(resolver.peekRuntime(), null, 'invalidation clears remembered runtime');
  equal((await resolver.resolveRuntime({})).pid, 9124, 'fresh discovery after invalidation retains exact identity');

  const corrupted = await runtime.scanProcessesAsync({ platform: 'win32', execFile(file, args, options, callback) { callback(null, '{bad JSON'); } });
  equal(corrupted, [], 'malformed process inventory fails closed');
  equal(await discover.listeningPortsOfAsync([], {}, { execFile() { throw Error('empty owners must not query OS'); } }), [], 'empty owner set avoids unnecessary queries');
  const owners = await discover.listeningPortsOfAsync([12, 'bad', 0, -1], { withOwners: true }, {
    platform: 'linux', execFile(file, args, options, callback) {
      equal(options.timeout, 8000, 'POSIX query keeps existing deadline');
      check(options.maxBuffer === 1024 * 1024 && options.windowsHide, 'POSIX inventory output and process windows remain bounded');
      if (file === 'lsof') {
        equal(args, ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '12'], 'only canonical positive PID enters owner argv');
        callback(Error('lsof unavailable'));
      } else {
        equal(file, 'ss', 'existing POSIX fallback retained');
        callback(null, 'LISTEN 0 128 127.0.0.1:19001 0.0.0.0:* users:(("dsh",pid=123,fd=8))\n' +
          'LISTEN 0 128 [::1]:19002 *:* users:(("dsh",pid=12,fd=8))');
      }
    }
  });
  equal(owners, [{ pid: 12, port: 19002 }], 'fallback requires exact PID, never a prefix match');
  const posix = await runtime.scanProcessesAsync({ platform: 'linux', adapter: desktopApi,
    execFile(file, args, options, callback) {
      equal(file, 'ps', 'POSIX process inventory uses original ps command');
      equal(options.maxBuffer, 4 * 1024 * 1024, 'POSIX process output keeps 4 MiB limit');
      callback(null, args[2] === 'pid=,comm=' ? '51 /opt/DeepSeek Harness\n52 node' : '51 "/opt/DeepSeek Harness"\n52 node unrelated.js web');
    } });
  equal(posix.map(p => p.pid), [51], 'asynchronous POSIX two-inventory join still rejects unrelated Node');
}

async function workerBoundaries() {
  // Cache/generation/timeout/worker-data checks run the exact source module with
  // an injected Worker constructor; neither finder nor native APIs execute.
  const filename = path.join(__dirname, 'dsh-runtime.js'), mod = { exports: {} }, local = createRequire(filename);
  const workers = [], timers = [];
  let time = 1000;
  class FakeWorker extends EventEmitter {
    constructor(code, options) { super(); this.code = code; this.options = options; this.terminated = 0; workers.push(this); }
    terminate() { this.terminated++; return Promise.resolve(); }
  }
  const context = vm.createContext({ module: mod, exports: mod.exports, __filename: filename, Date: { now: () => time }, process,
    setTimeout(fn, ms) { const token = { fn, ms, cleared: false }; timers.push(token); return token; },
    clearTimeout(token) { if (token) token.cleared = true; },
    require(name) { return name === 'worker_threads' ? { Worker: FakeWorker } : local(name); } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = mod.exports;
  const config = { dshExecutable: 'D:\\测试😀\\DeepSeek Harness.exe', dshMode: 'auto', dshWebArguments: ['web', '--no-open'],
    bridgeKey: 'synthetic-secret-not-transferred', notificationSettings: { private: true } };
  const a = api.detectInstallationAsync(config), b = api.detectInstallationAsync(config);
  equal(workers.length, 1, 'concurrent cold installation reads share one worker');
  check(workers[0].options.eval && workers[0].code.includes('.detectInstallation(workerData.config)'), 'worker invokes the unchanged cold finder by exact module path');
  equal(workers[0].options.workerData.modulePath, filename, 'worker module belongs to this installation');
  const data = JSON.stringify(workers[0].options.workerData);
  check(!data.includes('synthetic-secret') && !data.includes('notificationSettings'), 'only DSH installation fields cross the worker boundary');
  check(data.includes('测试😀'), 'Unicode installation argv is passed as structured data');
  equal(timers[0].ms, 65000, 'cold worker has a finite overall deadline beyond existing per-query limits');
  workers[0].emit('message', { installed: true, kind: 'desktop', version: '0.1.7-rc.2' });
  await Promise.all([a, b]);
  check(timers[0].cleared && workers[0].terminated === 0, 'successful finder clears deadline without process termination');
  time += 4999; await api.detectInstallationAsync(config);
  equal(workers.length, 1, 'cold worker result uses the existing installation TTL');
  time++; const old = api.detectInstallationAsync(config);
  equal(workers.length, 2, 'expired installation starts a fresh worker');
  api.invalidateRuntime();
  const fresh = api.detectInstallationAsync(config);
  equal(workers.length, 3, 'invalidation never joins stale installation work');
  workers[2].emit('message', { installed: true, kind: 'desktop', version: '0.1.8' }); await fresh;
  workers[1].emit('message', { installed: true, kind: 'desktop', version: '0.1.0' }); await old;
  equal((await api.detectInstallationAsync(config)).version, '0.1.8', 'older completion cannot replace current installation cache');
  const changed = api.detectInstallationAsync({ ...config, dshWebArguments: ['web', '--port', '19005'] });
  equal(workers.length, 4, 'argv change belongs to a distinct installation cache key');
  workers[3].emit('error', Error('synthetic worker failure')); equal((await changed).installed, false, 'worker failure reports no installation');
  const timed = api.detectInstallationAsync({ ...config, dshPort: 19006 });
  timers.at(-1).fn();
  equal((await timed).installed, false, 'worker deadline cannot reuse a prior positive result');
  equal(workers.at(-1).terminated, 1, 'only the owned worker is terminated on its deadline');

  const tmpBase = process.env.POCKET_BRIDGE_TEST_TEMP || os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const owned = fs.mkdtempSync(path.join(tmpBase, 'dsh-runtime-worker-'));
  try {
    const exe = path.join(owned, 'DeepSeek Harness.exe'), packageDir = path.join(owned, 'resources', 'app');
    fs.mkdirSync(packageDir, { recursive: true }); fs.writeFileSync(exe, 'synthetic file, never executed');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.1.7-rc.2' }));
    const actual = await runtime.detectInstallationAsync({ dshExecutable: exe, dshWebExecutable: path.join(owned, 'absent-cli') });
    equal(actual.version, '0.1.7-rc.2', 'actual Worker reads bounded adjacent version metadata');
    equal(actual.desktop.launch.exe, exe, 'actual Worker preserves exact configured executable without running it');
  } finally {
    const target = path.resolve(owned), root = path.resolve(tmpBase);
    assert.equal(path.dirname(target), root, 'recursive cleanup stays inside the owned test root');
    assert.ok(path.basename(target).startsWith('dsh-runtime-worker-'), 'cleanup is restricted to the newly created fixture');
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function unicodePipe() {
  if (process.platform !== 'win32') return;
  const root = 'D:\\桥\\中文😀\\node_modules\\@deepseek-ai\\dsh', entry = root + '\\dist\\bin.js';
  const files = { [root + '\\package.json']: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', bin: 'dist/bin.js' }), [entry]: '// fixture' };
  const io = { statSync(file) { if (!(file in files)) throw Error('missing'); return { isFile: () => true, size: Buffer.byteLength(files[file]) }; },
    readFileSync(file) { if (!(file in files)) throw Error('missing'); return files[file]; } };
  const command = '"C:\\node.exe" "' + entry + '" web --no-open';
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const records = await runtime.scanProcessesAsync({ fs: io, execFile(file, args, options, callback) {
    const adjusted = args.slice(), index = args.indexOf('-Command') + 1;
    adjusted[index] = adjusted[index].replace(/Get-CimInstance[\s\S]*$/, '[pscustomobject]@{ProcessId=94;Name=\'node.exe\';ExecutablePath=\'C:\\node.exe\';CommandLine=' + quote(command) + '} | ConvertTo-Json -Compress');
    return child.execFile(file, adjusted, options, callback);
  } });
  equal(records.map(record => record.packageJsonPath), [root + '\\package.json'], 'actual asynchronous Windows UTF-8 pipe preserves Chinese and supplementary Unicode package paths');
}

(async () => {
  const baseline = await responsiveness(false), improved = await responsiveness(true);
  await inventoryAndCache(); await workerBoundaries(); await unicodePipe();
  console.log(JSON.stringify({ checks, responsiveness: [baseline, improved], scope: 'isolated owned HTTP/child inventory and worker fixtures; no live DSH' }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
