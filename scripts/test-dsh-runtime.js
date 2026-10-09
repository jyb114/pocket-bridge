'use strict';

// No live DSH, npm execution, process termination or credentials are needed.
const assert = require('assert/strict');
const runtime = require('./dsh-runtime');
const api = require('./dsh-adapter');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

function virtualFs(files) {
  return {
    statSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error('missing');
      return { isFile: () => true, size: Buffer.byteLength(files[file]) };
    },
    readFileSync: file => { if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error('missing'); return files[file]; },
    realpathSync: file => file
  };
}
const cliRoot = 'C:\\npm\\node_modules\\@deepseek-ai\\dsh';
const entry = cliRoot + '\\dist\\bin.js';
const io = virtualFs({
  [cliRoot + '\\package.json']: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', bin: { dsh: 'dist/bin.js' } }),
  [entry]: '// bin', 'C:\\node.exe': 'node', 'C:\\npm\\dsh.cmd': 'shim', 'C:\\desktop\\DeepSeek Harness.exe': 'exe'
});
const metadataApi = { ...api, readDesktopVersion: () => ({ version: '0.1.7-rc.2', source: 'desktop-asar' }) };
const desktop = (pid, version = '0.1.7-rc.2') => ({ pid, kind: 'desktop', version, source: 'process',
  name: 'DeepSeek Harness.exe', executablePath: 'C:\\desktop\\DeepSeek Harness.exe' });
const cli = (pid, version = '0.1.7-rc.2') => ({ pid, kind: 'cli', version, source: 'process',
  name: 'node.exe', executablePath: 'C:\\node.exe', packageJsonPath: cliRoot + '\\package.json' });
const auth = { statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'dsh web authentication required' };
const html = { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<title>DSH</title><script src="/assets/app.js"></script>' };
const installed = (desktopRecord, cliRecord) => ({ installed: Boolean(desktopRecord || cliRecord),
  kind: desktopRecord ? 'desktop' : cliRecord ? 'cli' : null,
  version: (desktopRecord || cliRecord || {}).version || null,
  launch: (desktopRecord || cliRecord || {}).launch || null,
  desktop: desktopRecord, cli: cliRecord });

function fixture(state = {}) {
  let time = 1000, scans = 0, probes = 0, ownerCalls = 0;
  const resolver = runtime.createRuntimeResolver({
    adapter: api, now: () => time,
    scanProcesses: () => { scans++; return state.processes || []; },
    listeningPortsOf: (pids, options) => {
      ownerCalls++; equal(options, { withOwners: true }, 'request port owners in one OS query');
      return (state.owners || []).filter(owner => pids.includes(owner.pid));
    },
    detectInstallation: () => state.installation || installed(null, null),
    probeDshRuntime: async input => {
      probes++;
      if (state.wait) await state.wait;
      const response = (state.responses || {})[input.port];
      const capabilities = (state.capabilities || {})[input.port] || {};
      // Avoid re-reading real process package paths in the fixture.
      return api.createRuntimeRecord({ kind: input.kind, version: input.version,
        port: input.port, fingerprint: api.fingerprintDshHttp(response || {}), capabilities });
    }
  });
  return { resolver, state, advance: ms => { time += ms; }, counters: () => ({ scans, probes, ownerCalls }) };
}

(async () => {
  const record = { pid: 90, name: 'node.exe', executablePath: 'C:\\node.exe', commandLine: '"C:\\node.exe" "' + entry + '" web --no-open' };
  const classified = runtime.classifyProcess(record, { fs: io, adapter: metadataApi });
  equal(classified.kind, 'cli', 'recognize actual npx child entry');
  equal(classified.version, '0.1.7-rc.2', 'use installed package version');
  equal(classified.versionSource, 'cli-package', 'record actual metadata origin');
  for (const commandLine of [
    'node.exe server.js web', 'node.exe server.js "' + entry + '" web',
    'node.exe -e "require(\"' + entry + '\")" web',
    'node.exe "' + cliRoot + '\\not-the-bin.js" web',
    'node.exe "' + entry + '" serve'
  ]) equal(runtime.classifyProcess({ ...record, commandLine }, { fs: io, adapter: metadataApi }), null, 'reject unrelated Node server or non-web process');
  equal(runtime.classifyProcess({ pid: 3, name: 'Uninstall DeepSeek Harness.exe' }, { fs: io, adapter: metadataApi }), null, 'never identify the uninstaller');
  equal(runtime.scanProcesses({ processes: [record, { pid: 4, name: 'node.exe', commandLine: 'node.exe app.js web' }], fs: io, adapter: metadataApi }).map(p => p.pid), [90], 'strict process inventory');

  // Timeout admission is independent of a hosted Windows machine's cold
  // PowerShell startup. The production query must retain 8 seconds and fail closed.
  const timeoutCalls = [];
  const timedOut = runtime.scanProcesses({ platform: 'win32', execFileSync(file, args, options) {
    timeoutCalls.push({ file, args, options });
    throw Object.assign(Error('synthetic inventory timeout'), { code: 'ETIMEDOUT' });
  } });
  equal(timeoutCalls.length, 1, 'synchronous timeout check executes the production query once');
  equal(timeoutCalls[0].options.timeout, 8000, 'synchronous production inventory retains its 8-second deadline');
  equal(timedOut, [], 'synchronous process inventory timeout provides no runtime identity');

  if (process.platform === 'win32') {
    // This real-child fixture tests UTF-8 transport, not production startup latency.
    // Hosted runners can spend more than 8 seconds starting a cold PowerShell.
    // Give only the owned synthetic child a separate finite deadline; production
    // options and fail-closed timeout behavior are asserted independently above.
    // This does not certify that real discovery completes within 8 seconds.
    const fixtureTimeout = 20000;
    const unicodeRoot = 'D:\\桥\\实际使用\\node_modules\\@deepseek-ai\\dsh';
    const unicodeEntry = unicodeRoot + '\\lib\\bin.js';
    const unicodeIo = virtualFs({
      [unicodeRoot + '\\package.json']: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', bin: { dsh: 'lib/bin.js' } }),
      [unicodeEntry]: '// bin'
    });
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    const commandLine = '"C:\\node.exe" "' + unicodeEntry + '" web';
    const sample = '[pscustomobject]@{ProcessId=91;Name=\'node.exe\';ExecutablePath=\'C:\\node.exe\';CommandLine=' +
      quote(commandLine) + '} | ConvertTo-Json -Compress';
    let pipeFailure = null;
    const scanned = runtime.scanProcesses({ fs: unicodeIo, execFileSync(file, args, options) {
      equal(options.timeout, 8000, 'real synchronous Unicode fixture retains the production inventory deadline');
      // Exercise the real Windows PowerShell pipe/Node decoding boundary while
      // replacing only the OS inventory data; this is not a DSH compatibility test.
      const commandIndex = args.indexOf('-Command') + 1;
      const adjusted = args.slice();
      adjusted[commandIndex] = adjusted[commandIndex].replace(/Get-CimInstance[\s\S]*$/, sample);
      const started = performance.now();
      try {
        // Capture stderr only from this owned synthetic child, never real OS inventory.
        const output = require('child_process').execFileSync(file, adjusted,
          { ...options, timeout: fixtureTimeout, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log('Synthetic Unicode pipe evidence: ' + JSON.stringify({ mode: 'sync',
          node: process.version, elapsedMs: Math.round(performance.now() - started),
          productionTimeoutMs: options.timeout, fixtureTimeoutMs: fixtureTimeout, status: 0, stdout: String(output).slice(0, 2048) }));
        return output;
      } catch (error) {
        pipeFailure = Error('Synthetic Unicode pipe failure: ' + JSON.stringify({ mode: 'sync',
          node: process.version, elapsedMs: Math.round(performance.now() - started),
          productionTimeoutMs: options.timeout, fixtureTimeoutMs: fixtureTimeout, code: error.code, errno: error.errno, status: error.status,
          signal: error.signal, killed: error.killed, stdout: String(error.stdout || '').slice(0, 2048),
          stderr: String(error.stderr || '').slice(0, 2048) }));
        throw error;
      }
    } });
    // Production intentionally fails closed on child errors. Retain that behavior,
    // but report the owned fixture's original failure instead of only an empty array.
    if (pipeFailure) throw pipeFailure;
    equal(scanned.map(p => p.packageJsonPath), [unicodeRoot + '\\package.json'], 'Windows inventory preserves Chinese npm installation paths across the real UTF-8 pipe');
  }

  const installedDeps = { fs: io, adapter: metadataApi, platform: 'win32', execPath: 'C:\\node.exe',
    env: { PATH: 'C:\\npm' }, findDshExecutable: () => ({ path: null, source: 'missing' }),
    execFileSync: () => { throw new Error('Installation detection must not execute a command'); } };
  const global = runtime.detectInstallation({ dshMode: 'auto' }, installedDeps);
  equal(global.kind, 'cli', 'PATH npm launcher counts as installed CLI');
  equal(global.launch, { kind: 'cli', exe: 'C:\\node.exe', args: [entry, 'web', '--no-open'] }, 'resolve .cmd to safe node argv');
  equal(global.canStart, true, 'local official CLI can launch without installation');
  const configured = runtime.detectInstallation({ dshMode: 'web', dshWebEntry: entry, dshWebExecutable: 'C:\\node.exe', dshWebArguments: ['web', '--port', '19388'] }, installedDeps);
  equal(configured.launch.args, [entry, 'web', '--port', '19388'], 'preserve configured arguments without shell concatenation');
  const wrong = runtime.detectInstallation({ dshWebEntry: 'C:\\app.js' }, installedDeps);
  equal(wrong.installed, false, 'invalid explicit package entry must not launch unrelated or fallback program');
  equal(runtime.detectInstallation({ dshWebExecutable: 'C:\\missing\\dsh.cmd' }, installedDeps).installed, false, 'invalid explicit launcher must not select PATH fallback');
  equal(runtime.detectInstallation({ dshWebArguments: ['serve'] }, installedDeps).installed, false, 'CLI launch must request web mode');
  const ipcDeps = { ...installedDeps, env: {}, findDshExecutable: () => ({ path: 'C:\\desktop\\DeepSeek Harness.exe' }),
    adapter: { ...metadataApi, readDesktopVersion: () => ({ version: '0.1.5-rc.3', source: 'desktop-asar' }) } };
  const ipcInstall = runtime.detectInstallation({}, ipcDeps);
  equal(ipcInstall.installed, true, 'IPC desktop remains installed');
  equal(ipcInstall.profile, 'desktop-ipc', 'identify known IPC desktop transport');
  equal(ipcInstall.launch, null, 'IPC-only desktop cannot start web bridge');
  equal(runtime.detectInstallation({}, { ...ipcDeps, env: { PATH: 'C:\\npm' } }).kind, 'cli', 'prefer available CLI over IPC desktop');

  const onlyCli = fixture({ processes: [cli(2)], owners: [{ pid: 2, port: 19001 }], responses: { 19001: auth } });
  const cliRunning = await onlyCli.resolver.resolveRuntime({});
  check(cliRunning.running && cliRunning.installed, 'running CLI works with no installed desktop');
  equal(cliRunning.kind, 'cli', 'retain CLI runtime kind');
  equal(cliRunning.profile, 'remote-mux', 'modern CLI profile');

  const mixed = fixture({ processes: [desktop(1), cli(2)], owners: [{ pid: 1, port: 19005 }, { pid: 1, port: 19003 }, { pid: 2, port: 19002 }],
    responses: { 19003: auth, 19005: { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<title>Other Node Server</title>' }, 19002: auth } });
  equal((await mixed.resolver.resolveRuntime({})).port, 19003, 'select genuine desktop and exclude non-DSH port');
  equal(mixed.counters().ownerCalls, 1, 'inspect all process-owned ports with one query');
  mixed.advance(5000);
  equal((await mixed.resolver.resolveRuntime({ dshMode: 'web' })).port, 19003, 'keep prior genuine selection when mode preference changes');
  equal((await mixed.resolver.resolveRuntime({ dshPort: 19002 })).kind, 'cli', 'genuine explicit port overrides previous desktop');
  equal((await mixed.resolver.resolveRuntime({ dshPort: 19005 })).port, 19002, 'invalid explicit port never overrides genuine previous target');
  const cliPreferred = fixture({ processes: [desktop(1), cli(2)], owners: [{ pid: 1, port: 19003 }, { pid: 2, port: 19002 }], responses: { 19003: auth, 19002: auth } });
  equal((await cliPreferred.resolver.resolveRuntime({ dshMode: 'web' })).kind, 'cli', 'fresh web preference chooses CLI');
  const generic = fixture({ processes: [desktop(1)], owners: [{ pid: 1, port: 19008 }], responses: { 19008: { statusCode: 303, headers: { location: './' }, body: '' } } });
  equal((await generic.resolver.resolveRuntime({})).running, false, 'single process-owned port still requires genuine HTTP identity');
  const explicit = fixture({ responses: { 19006: auth }, capabilities: { 19006: { remoteMux: true } } });
  check((await explicit.resolver.resolveRuntime({ dshPort: 19006 })).running, 'genuine configured listener may work when process path inaccessible');
  const noSpoof = fixture({ responses: { 19006: html } });
  equal((await noSpoof.resolver.resolveRuntime({ dshPort: 70000 })).running, false, 'invalid configured port cannot be probed');

  for (const scenario of ['recovered', 'still-down', 'negative-http', 'unowned']) {
    let attempts = 0;
    const retry = runtime.createRuntimeResolver({ adapter: api,
      scanProcesses: () => scenario === 'unowned' ? [] : [cli(2, '0.1.0-rc.8')],
      listeningPortsOf: () => scenario === 'unowned' ? [] : [{ pid: 2, port: 19010 }],
      detectInstallation: () => installed(null, null),
      probeDshRuntime: async input => {
        attempts++;
        const recovered = scenario === 'recovered' && attempts === 2;
        return { ...api.createRuntimeRecord({ kind: input.kind, version: input.version, port: input.port,
          fingerprint: api.fingerprintDshHttp(recovered ? html : {}) }),
          transientProbeFailure: scenario !== 'negative-http' && !recovered };
      }
    });
    const result = await retry.resolveRuntime({ dshPort: 19010 }, { force: true });
    equal(attempts, ['recovered', 'still-down'].includes(scenario) ? 2 : 1, scenario + ': only one bounded transient retry on a verified owner');
    equal(result.running, scenario === 'recovered', scenario + ': fresh HTTP fingerprint remains mandatory');
  }

  const legacy = fixture({ processes: [cli(2, '0.1.0-rc.8')], owners: [{ pid: 2, port: 19010 }], responses: { 19010: html } });
  const legacyRuntime = await legacy.resolver.resolveRuntime({});
  equal(legacyRuntime.profile, 'legacy-events', 'inspected legacy CLI is supported');
  equal(legacyRuntime.supported, true, 'legacy transport diagnostic');
  const future = fixture({ processes: [cli(2, '0.9.0')], owners: [{ pid: 2, port: 19011 }], responses: { 19011: auth }, capabilities: { 19011: { remoteMux: true } } });
  equal((await future.resolver.resolveRuntime({})).supported, true, 'observed supported features accept unknown versions');
  const unknown = fixture({ processes: [cli(2, '0.9.0')], owners: [{ pid: 2, port: 19011 }], responses: { 19011: auth } });
  const unknownRuntime = await unknown.resolver.resolveRuntime({});
  check(unknownRuntime.running && !unknownRuntime.supported, 'genuine unknown DSH stays running for transparent native frontend');
  const ipc = fixture({ processes: [desktop(1, '0.1.5-rc.3')], installation: installed({ ...desktop(1, '0.1.5-rc.3'), launch: null }, null) });
  const ipcRuntime = await ipc.resolver.resolveRuntime({});
  equal(ipcRuntime.profile, 'desktop-ipc', 'no HTTP listener identifies IPC runtime');
  equal(ipcRuntime.running, false, 'IPC does not pretend to be a web listener');

  const cache = fixture({ processes: [cli(2)], owners: [{ pid: 2, port: 19001 }], responses: { 19001: auth } });
  await Promise.all([cache.resolver.resolveRuntime({}), cache.resolver.resolveRuntime({}), cache.resolver.resolveRuntime({})]);
  equal(cache.counters().scans, 1, 'concurrent reads share in-flight scan');
  cache.advance(4999); await cache.resolver.resolveRuntime({});
  equal(cache.counters().scans, 1, 'cache is valid below five seconds');
  cache.advance(1); equal(cache.resolver.peekRuntime(), null, 'synchronous readers never reuse expired verified port');
  await cache.resolver.resolveRuntime({});
  equal(cache.counters().scans, 2, 'refresh at five seconds');
  await cache.resolver.resolveRuntime({}, { force: true });
  equal(cache.counters().scans, 3, 'startup can force a fresh scan');
  cache.resolver.invalidateRuntime(); equal(cache.resolver.peekRuntime(), null, 'invalidation clears synchronous result');
  await cache.resolver.resolveRuntime({}); equal(cache.counters().scans, 4, 'invalidate then re-probe');
  let release;
  const delayed = fixture({ processes: [cli(2)], owners: [{ pid: 2, port: 19001 }], responses: { 19001: auth }, wait: new Promise(resolve => { release = resolve; }) });
  const pending = delayed.resolver.resolveRuntime({});
  while (!delayed.counters().probes) await Promise.resolve();
  delayed.resolver.invalidateRuntime();
  delayed.state.wait = null;
  delayed.state.owners = [{ pid: 2, port: 19002 }]; delayed.state.responses[19002] = auth;
  equal((await delayed.resolver.resolveRuntime({})).port, 19002, 'invalidation starts a fresh scan instead of joining old work');
  release(); await pending;
  equal(delayed.resolver.peekRuntime().port, 19002, 'invalidated pending result cannot restore stale cache');
  delayed.state.owners.push({ pid: 2, port: 19001 });
  equal((await delayed.resolver.resolveRuntime({}, { force: true })).port, 19002, 'older completion cannot overwrite remembered selection');

  const safe = runtime.serializeRuntime({ ...cliRunning, executablePath: 'secret-path', commandLine: '--token=SECRET',
    packageJsonPath: 'hidden-user-directory', launch: { exe: 'sensitive-location', args: ['--token=SECRET'] },
    candidates: [{ ...cliRunning, executablePath: 'secret-path', commandLine: '--token=SECRET' }] });
  const diagnostic = JSON.stringify(safe);
  check(!/SECRET|sensitive-location|secret-path|hidden-user-directory/.test(diagnostic), 'diagnostics exclude commands, package paths and launch argv');
  console.log('DSH runtime regression checks passed: ' + checks);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
