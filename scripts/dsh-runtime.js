'use strict';

// Runtime discovery does not run npm/npx or install packages. Process candidates
// need a DSH HTTP fingerprint before they become a running web target.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const CACHE_TTL_MS = 5000;
let installationCache = null;
let installationPending = null, installationGeneration = 0;
const INVENTORY_OPTIONS = { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024,
  windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
const INSTALLATION_TIMEOUT_MS = 65000;
// config's legacy finder has bounded synchronous process/registry/shortcut
// probes. Keep its exact cold discovery semantics off the gateway event loop.
const INSTALLATION_WORKER = `
  const { parentPort, workerData } = require('worker_threads');
  try { parentPort.postMessage(require(workerData.modulePath).detectInstallation(workerData.config)); }
  catch (_) { parentPort.postMessage(null); }
`;

function configKey(config) { return JSON.stringify([config.dshPort || 0, config.dshMode || 'auto', config.dshExecutable || '',
  config.dshWebExecutable || '', config.dshWebEntry || '', config.dshWebArguments || ['web', '--no-open']]); }

function adapter() { return require('./dsh-adapter'); }
function paths(value) { return /^[A-Za-z]:[\\/]/.test(value || '') || String(value || '').includes('\\') ? path.win32 : path; }
function validPort(value) { return Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535; }
function isFile(file, io = fs) { try { return Boolean(file && io.statSync(file).isFile()); } catch (_) { return false; } }
function readPackage(file, io = fs) {
  try {
    const stat = io.statSync(file);
    if (stat.size > 256 * 1024) return null;
    const data = JSON.parse(io.readFileSync(file, 'utf8'));
    return data && data.name === '@deepseek-ai/dsh' ? data : null;
  } catch (_) { return null; }
}

function packageOfEntry(entry, io = fs) {
  if (!entry) return null;
  const p = paths(entry);
  let dir = p.dirname(entry);
  for (let depth = 0; depth < 8; depth++) {
    const file = p.join(dir, 'package.json');
    const pkg = readPackage(file, io);
    if (pkg) return { pkg, packageJsonPath: file, root: dir };
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function cliEntry(info, io = fs) {
  if (!info) return null;
  const bin = typeof info.pkg.bin === 'string' ? info.pkg.bin : info.pkg.bin && info.pkg.bin.dsh;
  if (typeof bin !== 'string' || !bin) return null;
  const p = paths(info.root), entry = p.resolve(info.root, bin);
  const relative = p.relative(info.root, entry);
  if (relative.startsWith('..') || p.isAbsolute(relative) || !isFile(entry, io)) return null;
  return entry;
}

/** Strict candidates, not evidence that a usable web listener exists. */
function classifyProcess(record = {}, deps = {}) {
  const api = deps.adapter || adapter(), io = deps.fs || fs;
  const parsed = api.parseDshProcess(record);
  const pid = Number(record.pid || record.ProcessId);
  if (!parsed || !Number.isInteger(pid) || pid <= 0) return null;
  let version = null, versionSource = null;
  if (parsed.kind === 'desktop') {
    const local = api.readDesktopVersion(parsed.executablePath, { fs: io });
    version = local.version; versionSource = local.source;
  } else if (parsed.packageJsonPath) {
    // The real package's name and bin entry must agree with the process path.
    const pkg = readPackage(parsed.packageJsonPath, io);
    if (!pkg) return null;
    const p = paths(parsed.packageJsonPath), info = { pkg, root: p.dirname(parsed.packageJsonPath), packageJsonPath: parsed.packageJsonPath };
    const entry = cliEntry(info, io);
    const args = Array.isArray(record.args) ? record.args : api.tokenizeCommandLine(record.commandLine || record.command);
    if (!entry || !args.some(arg => p.resolve(String(arg)) === entry)) return null;
    const local = api.readCliVersion(parsed.packageJsonPath, { fs: io });
    version = local.version; versionSource = local.source;
  }
  return { ...parsed, pid, version, versionSource, source: 'process' };
}

function processQuery() {
  const filter = "Name='DeepSeek Harness.exe' OR Name='dsh-desktop.exe' OR Name='node.exe' OR Name='bun.exe' OR Name='npm.exe' OR Name='npx.exe' OR Name='dsh.exe'";
  // Windows PowerShell otherwise writes the system code page to pipes. Node
  // decodes UTF-8, corrupting non-ASCII installation paths before validation.
  return '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ' +
    'Get-CimInstance Win32_Process -Filter "' + filter + '" | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
}

function parseWindowsProcesses(out) {
  const raw = JSON.parse(out);
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(p => ({
    pid: p.ProcessId, name: p.Name, executablePath: p.ExecutablePath, commandLine: p.CommandLine
  }));
}

function parsePosixProcesses(namesText, argsText) {
  const names = new Map(String(namesText).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [[Number(match[1]), match[2].trim()]] : [];
  }));
  return String(argsText).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/), exe = match && names.get(Number(match[1]));
    return match && exe ? [{ pid: Number(match[1]), name: paths(exe).basename(exe), executablePath: exe, commandLine: match[2] }] : [];
  });
}

function processInventory(deps = {}) {
  const exec = deps.execFileSync || execFileSync, platform = deps.platform || process.platform;
  try {
    if (platform === 'win32') {
      return parseWindowsProcesses(exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', processQuery()], { ...INVENTORY_OPTIONS }));
    }
    return parsePosixProcesses(exec('ps', ['-ww', '-eo', 'pid=,comm='], { ...INVENTORY_OPTIONS }),
      exec('ps', ['-ww', '-eo', 'pid=,args='], { ...INVENTORY_OPTIONS }));
  } catch (_) { return []; }
}

function executeFile(exec, file, args, options) {
  return new Promise((resolve, reject) => {
    exec(file, args, options, (error, out) => error ? reject(error) : resolve(out));
  });
}

async function processInventoryAsync(deps = {}) {
  const exec = deps.execFile || execFile, platform = deps.platform || process.platform;
  try {
    if (platform === 'win32') return parseWindowsProcesses(await executeFile(exec, 'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', processQuery()], { ...INVENTORY_OPTIONS }));
    const [names, args] = await Promise.all([
      executeFile(exec, 'ps', ['-ww', '-eo', 'pid=,comm='], { ...INVENTORY_OPTIONS }),
      executeFile(exec, 'ps', ['-ww', '-eo', 'pid=,args='], { ...INVENTORY_OPTIONS })
    ]);
    return parsePosixProcesses(names, args);
  } catch (_) { return []; }
}

function scanProcesses(deps = {}) {
  const records = deps.processes || processInventory(deps);
  return records.map(p => classifyProcess(p, deps)).filter(Boolean).sort((a, b) => a.pid - b.pid);
}

async function scanProcessesAsync(deps = {}) {
  const records = deps.processes || await processInventoryAsync(deps);
  return records.map(p => classifyProcess(p, deps)).filter(Boolean).sort((a, b) => a.pid - b.pid);
}

function webArguments(config) {
  const args = Array.isArray(config.dshWebArguments) ? config.dshWebArguments : ['web', '--no-open'];
  // Keep argv separate all the way to spawn; no shell interpretation.
  if (!args.every(value => typeof value === 'string' && !value.includes('\0')) || !args.includes('web')) return null;
  return [...args];
}

function cliInstallation(config, deps = {}) {
  const io = deps.fs || fs, api = deps.adapter || adapter(), env = deps.env || process.env;
  const platform = deps.platform || process.platform, execPath = deps.execPath || process.execPath;
  const args = webArguments(config);
  if (!args) return null;
  const make = (info, node, source) => {
    const entry = cliEntry(info, io);
    if (!entry || !isFile(node, io)) return null;
    const local = api.readCliVersion(info.packageJsonPath, { fs: io });
    return { kind: 'cli', version: local.version, versionSource: local.source, source,
      packageJsonPath: info.packageJsonPath, launch: { kind: 'cli', exe: node, args: [entry, ...args] } };
  };
  if (config.dshWebEntry) {
    const info = packageOfEntry(config.dshWebEntry, io);
    if (info && cliEntry(info, io) === paths(config.dshWebEntry).resolve(config.dshWebEntry)) {
      const configured = make(info, config.dshWebExecutable || execPath, 'config.json');
      if (configured) return configured;
    }
    // An invalid explicit entry should not launch a different installation.
    return null;
  }
  const candidates = [];
  if (config.dshWebExecutable) candidates.push({ launcher: config.dshWebExecutable, source: 'config.json' });
  const p = platform === 'win32' ? path.win32 : path;
  for (const dir of (config.dshWebExecutable ? [] : String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean))) {
    for (const name of platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']) {
      candidates.push({ launcher: p.join(dir, name), source: 'PATH' });
    }
  }
  if (!config.dshWebExecutable && platform === 'win32' && env.APPDATA) candidates.push({ launcher: p.join(env.APPDATA, 'npm', 'dsh.cmd'), source: 'npm-global' });
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.launcher) || !isFile(candidate.launcher, io)) continue;
    seen.add(candidate.launcher);
    let resolved = candidate.launcher;
    try { resolved = io.realpathSync(candidate.launcher); } catch (_) { /* shim is still inspectable */ }
    let info = packageOfEntry(resolved, io);
    if (!info) {
      const dir = p.dirname(candidate.launcher);
      for (const root of [p.join(dir, 'node_modules', '@deepseek-ai', 'dsh'), p.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')]) {
        const packageJsonPath = p.join(root, 'package.json'), pkg = readPackage(packageJsonPath, io);
        if (pkg) { info = { pkg, root, packageJsonPath }; break; }
      }
    }
    // On Windows resolve npm's .cmd wrapper to node + the verified package bin;
    // never invoke cmd.exe or construct a shell command.
    const found = make(info, execPath, candidate.source);
    if (found) return found;
  }
  return null;
}

/** Installed means a launchable local distribution, never merely a cached npx string. */
function computeInstallation(config, deps = {}) {
  config = config || (deps.loadConfig || (() => require('./config').loadConfig()))();
  const io = deps.fs || fs, api = deps.adapter || adapter();
  const finder = deps.findDshExecutable || (explicit => require('./config').findDshExecutable(explicit));
  let desktop = null;
  try {
    const result = finder(config.dshExecutable);
    const exe = typeof result === 'string' ? result : result && result.path;
    if (isFile(exe, io)) {
      const local = api.readDesktopVersion(exe, { fs: io });
      desktop = { kind: 'desktop', version: local.version, versionSource: local.source,
        source: result.source || 'config.json', launch: { kind: 'desktop', exe, args: [] } };
    }
  } catch (_) { /* detection failure is not installation */ }
  const cli = cliInstallation(config, deps);
  const desktopProfile = desktop && api.detectProfile({ kind: 'desktop', version: desktop.version });
  const availableDesktop = desktopProfile && desktopProfile.profile === 'desktop-ipc' ? null : desktop;
  const selected = config.dshMode === 'web' ? (cli || availableDesktop || desktop) : (availableDesktop || cli || desktop);
  const profile = selected ? api.detectProfile({ kind: selected.kind, version: selected.version }) :
    { profile: 'unsupported', supported: false, capabilities: {}, reason: null };
  const canStart = Boolean(selected && profile.profile !== 'desktop-ipc');
  return { installed: Boolean(selected), kind: selected ? selected.kind : null,
    version: selected ? selected.version : null, source: selected ? selected.source : null,
    ...profile, canStart, launch: canStart ? selected.launch : null, desktop, cli };
}

function detectInstallation(config, deps = {}) {
  config = config || (deps.loadConfig || (() => require('./config').loadConfig()))();
  // Fixture dependencies must never share production cache state.
  if (Object.keys(deps).length) return computeInstallation(config, deps);
  const key = configKey(config), time = Date.now();
  if (installationCache && installationCache.key === key && time - installationCache.at < CACHE_TTL_MS) return installationCache.value;
  const value = computeInstallation(config);
  installationCache = { key, at: Date.now(), value };
  return value;
}

function noInstallation() {
  return { installed: false, kind: null, version: null, source: null,
    profile: 'unsupported', supported: false, capabilities: {}, reason: null,
    canStart: false, launch: null, desktop: null, cli: null };
}

function installationInWorker(config) {
  // Never transfer the gateway's authentication/configuration fields to this
  // read-only worker. Only the existing installation finder's inputs are used.
  const input = { dshPort: config.dshPort, dshMode: config.dshMode,
    dshExecutable: config.dshExecutable, dshWebExecutable: config.dshWebExecutable,
    dshWebEntry: config.dshWebEntry, dshWebArguments: config.dshWebArguments };
  return new Promise(resolve => {
    let worker, timer, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve(value || noInstallation());
    };
    try {
      worker = new Worker(INSTALLATION_WORKER, { eval: true, workerData: { modulePath: __filename, config: input } });
      worker.once('message', finish);
      worker.once('error', () => finish(null));
      worker.once('exit', () => finish(null));
      // The legacy query deadlines total at most 59 seconds. This bounds the
      // worker itself as well; termination never signals a discovered DSH app.
      timer = setTimeout(() => { finish(null); worker.terminate().catch(() => {}); }, INSTALLATION_TIMEOUT_MS);
    } catch (_) { finish(null); }
  });
}

async function detectInstallationAsync(config, deps = {}) {
  config = config || (deps.loadConfig || (() => require('./config').loadConfig()))();
  // Injectable filesystem/finder fixtures cannot be transferred to a worker.
  // They remain isolated from production caches and do not execute real OS scans.
  if (Object.keys(deps).length) return computeInstallation(config, deps);
  const key = configKey(config), time = Date.now();
  if (installationCache && installationCache.key === key && time - installationCache.at < CACHE_TTL_MS) return installationCache.value;
  if (installationPending && installationPending.key === key) return installationPending.promise;
  const started = installationGeneration;
  const work = installationInWorker(config).then(value => {
    if (installationPending && installationPending.promise === work && started === installationGeneration) {
      installationCache = { key, at: Date.now(), value };
    }
    return value;
  }).finally(() => { if (installationPending && installationPending.promise === work) installationPending = null; });
  installationPending = { key, promise: work };
  return work;
}

function publicCandidate(candidate) {
  return { kind: candidate.kind, pid: candidate.pid || null, port: candidate.port || null,
    version: candidate.version || null, profile: candidate.profile || 'unsupported',
    supported: Boolean(candidate.supported), confidence: candidate.confidence || 'low',
    httpEvidence: candidate.httpEvidence || null };
}

function serializeRuntime(runtime) {
  if (!runtime) return null;
  return { running: Boolean(runtime.running), installed: Boolean(runtime.installed),
    kind: runtime.kind || null, port: runtime.port || null, pid: runtime.pid || null,
    version: runtime.version || null, versionSource: runtime.versionSource || null,
    profile: runtime.profile || 'unsupported', supported: Boolean(runtime.supported),
    confidence: runtime.confidence || 'low', httpEvidence: runtime.httpEvidence || null,
    capabilities: { ...(runtime.capabilities || {}) }, source: runtime.source || null,
    reason: runtime.reason || null, candidates: (runtime.candidates || []).map(publicCandidate) };
}

/** Injectable OS, HTTP and time boundaries keep tests independent of installed apps. */
function createRuntimeResolver(deps = {}) {
  const now = deps.now || Date.now;
  const ttl = deps.ttlMs === undefined ? CACHE_TTL_MS : deps.ttlMs;
  const loadConfig = deps.loadConfig || (() => require('./config').loadConfig());
  const scan = deps.scanProcesses || (() => scanProcessesAsync(deps));
  // Lazy import avoids discover -> runtime -> discover initialization cycles.
  const portsOf = deps.listeningPortsOf || ((pids, options) => require('./discover').listeningPortsOfAsync(pids, options, deps));
  const probe = deps.probeDshRuntime || ((input) => (deps.adapter || adapter()).probeDshRuntime(input, { fs: deps.fs || fs }));
  const installation = deps.detectInstallation || ((config) => detectInstallationAsync(config, deps));
  let cached = null, cachedKey = null, cachedAt = 0, pending = null, pendingKey = null, previous = null, generation = 0;

  async function discover(config) {
    const [installed, processes] = await Promise.all([installation(config), scan()]);
    const owners = await portsOf(processes.map(record => record.pid), { withOwners: true });
    const byPid = new Map(processes.map(record => [record.pid, record]));
    const inputs = [];
    for (const owner of owners || []) {
      if (!owner || !validPort(owner.port) || !byPid.has(Number(owner.pid))) continue;
      const processInfo = byPid.get(Number(owner.pid));
      if (inputs.some(x => x.port === Number(owner.port))) continue;
      inputs.push({ ...processInfo, port: Number(owner.port), process: processInfo });
    }
    if (validPort(config.dshPort) && !inputs.some(x => x.port === Number(config.dshPort))) {
      inputs.push({ port: Number(config.dshPort), kind: 'unknown', source: 'config.json' });
    }
    const results = await Promise.all(inputs.map(async input => {
      try {
        let result = await probe(input);
        // Real legacy runtimes exposed a short OS/event-loop stall here: the
        // listener remained alive but a GET deadline expired during discovery.
        // Confirm it afresh once on the process-owned port. No RPC is retried,
        // no prior fingerprint authorizes a write, and negative HTTP stays final.
        if (input.pid && result.transientProbeFailure) result = await probe(input);
        return { ...input, ...result, pid: input.pid || null, source: input.source || 'process' };
      }
      catch (_) { return { ...input, identified: false, httpEvidence: null, supported: false, profile: 'unsupported' }; }
    }));
    const genuine = results.filter(result => result.identified && ['dsh-auth-challenge', 'dsh-app-html'].includes(result.httpEvidence));
    const preferred = config.dshMode === 'web' ? 'cli' : 'desktop';
    genuine.sort((a, b) => {
      const rank = value => [Number(value.port !== Number(config.dshPort)),
        Number(!(previous && value.port === previous.port && value.pid === previous.pid)),
        Number(value.kind !== preferred), value.kind === 'desktop' ? 0 : value.kind === 'cli' ? 1 : 2, value.port, value.pid || 0];
      const left = rank(a), right = rank(b);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
      return 0;
    });
    const chosen = genuine[0];
    if (chosen) {
      const launch = chosen.kind === 'desktop' ? installed.desktop && installed.desktop.launch :
        chosen.kind === 'cli' ? installed.cli && installed.cli.launch : installed.launch;
      return { ...chosen, running: true, installed: true, launch: launch || null,
        candidates: results.map(publicCandidate) };
    }
    // IPC desktop builds remain installed but are never treated as an HTTP server.
    const record = installed[installed.kind] || processes[0];
    const api = deps.adapter || adapter();
    const profile = record ? api.detectProfile({ kind: record.kind, version: record.version }) :
      { profile: 'unsupported', supported: false, capabilities: {}, reason: null };
    return { running: false, installed: Boolean(installed.installed || processes.length),
      kind: installed.kind || (processes[0] && processes[0].kind) || null,
      port: null, pid: null, version: installed.version || (processes[0] && processes[0].version) || null,
      versionSource: record && record.versionSource || null, ...profile,
      launch: installed.launch || null, confidence: processes.length ? 'medium' : 'low', httpEvidence: null,
      source: installed.source || (processes.length ? 'process' : null), candidates: results.map(publicCandidate),
      reason: profile.reason || (processes.length ? 'DSH was found without a confirmed HTTP listener.' : 'No running DSH web runtime was found.') };
  }

  async function resolveRuntime(config, options = {}) {
    config = config || loadConfig();
    const key = configKey(config);
    if (!options.force && cached && cachedKey === key && now() - cachedAt < ttl) return cached;
    if (pending && pendingKey === key) return pending;
    const started = generation;
    const work = discover(config).then(result => {
      // An older in-flight configuration may finish after a newer one.
      if (pending === work && started === generation) {
        cached = result; cachedKey = key; cachedAt = now();
        if (result.running) previous = { pid: result.pid, port: result.port };
      }
      return result;
    }).finally(() => { if (pending === work) { pending = null; pendingKey = null; } });
    pending = work; pendingKey = key;
    return work;
  }
  return { resolveRuntime,
    detectInstallation: config => (deps.detectInstallation || (value => detectInstallation(value, deps)))(config || loadConfig()),
    detectInstallationAsync: config => installation(config || loadConfig()),
    peekRuntime: () => cached && now() - cachedAt < ttl ? cached : null,
    invalidateRuntime: () => {
      generation++; cached = null; cachedKey = null; cachedAt = 0; pending = null; pendingKey = null;
      if (!deps.detectInstallation) {
        installationGeneration++; installationCache = null; installationPending = null;
      }
    } };
}

let singleton;
function resolver() { return singleton || (singleton = createRuntimeResolver()); }
module.exports = { CACHE_TTL_MS, classifyProcess, scanProcesses, scanProcessesAsync,
  detectInstallation, detectInstallationAsync, serializeRuntime, createRuntimeResolver,
  resolveRuntime: (...args) => resolver().resolveRuntime(...args),
  peekRuntime: () => resolver().peekRuntime(), invalidateRuntime: () => resolver().invalidateRuntime() };
