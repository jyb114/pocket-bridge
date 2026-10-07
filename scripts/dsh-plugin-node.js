'use strict';

// Find a genuine Node executable for this selected gateway. An Electron
// process executable is an application, not permission to launch its GUI as a
// daemon. No process environment, global PATH or user configuration is changed.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUNTIME_NAME = /^node-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-win-(x64|arm64|ia32)$/;
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\r?\n)?$/;
const codeError = code => Object.assign(new Error(code), { code });

function versionMajor(text, current = false) {
  if (typeof text !== 'string') return null;
  const match = VERSION.exec(current && !text.startsWith('v') ? `v${text}` : text);
  if (!match || !match.slice(1, 4).every(value => Number.isSafeInteger(Number(value)))) return null;
  return Number(match[1]);
}

function bound(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

/** Reject links instead of silently following a PATH alias or linked runtime. */
function canonicalRegular(io, candidate, basename) {
  try {
    if (typeof candidate !== 'string' || candidate.includes('\0') || !path.isAbsolute(candidate)
      || path.basename(candidate).toLowerCase() !== basename) return null;
    const absolute = path.resolve(candidate);
    let at = absolute;
    while (true) {
      const stat = io.lstatSync(at);
      if (stat.isSymbolicLink() || (at === absolute ? !stat.isFile() : !stat.isDirectory())) return null;
      const parent = path.dirname(at);
      if (parent === at) break;
      at = parent;
    }
    const resolved = io.realpathSync(absolute);
    if (typeof resolved !== 'string' || !path.isAbsolute(resolved) || path.basename(resolved).toLowerCase() !== basename) return null;
    // A no-link walk also has to retain the same canonical spelling.
    if (process.platform === 'win32' ? resolved.toLowerCase() !== absolute.toLowerCase() : resolved !== absolute) return null;
    const stat = io.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { path: resolved, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (_) { return null; }
}

function unchanged(io, identity, basename) {
  const current = canonicalRegular(io, identity.path, basename);
  return current && current.dev === identity.dev && current.ino === identity.ino
    && current.size === identity.size && current.mtimeMs === identity.mtimeMs;
}

function directDirectory(io, candidate) {
  try {
    let at = path.resolve(candidate);
    const absolute = at;
    while (true) {
      const stat = io.lstatSync(at);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const parent = path.dirname(at);
      if (parent === at) break;
      at = parent;
    }
    const resolved = io.realpathSync(absolute);
    return process.platform === 'win32' ? resolved.toLowerCase() === absolute.toLowerCase() : resolved === absolute;
  } catch (_) { return false; }
}

function runtimeCandidates(io, directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return [];
  const runtime = path.join(directory, 'runtime');
  if (!directDirectory(io, runtime)) return [];
  let handle;
  try {
    // Read only this installation's direct runtime children. No recursion or
    // broad search through AppData, home directories or installed applications.
    handle = io.opendirSync(runtime);
    const rows = [];
    for (let count = 0; count < 256; count++) {
      const entry = handle.readSync();
      if (!entry) break;
      const match = RUNTIME_NAME.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const numbers = match.slice(1, 4).map(Number);
      if (!numbers.every(Number.isSafeInteger)) continue;
      rows.push({ name: entry.name, version: numbers });
    }
    rows.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
    return rows.slice(0, 16).map(row => path.join(runtime, row.name, 'node.exe'));
  } catch (_) { return []; }
  finally { if (handle) { try { handle.closeSync(); } catch (_) {} } }
}

/** Real child-query deadline survives a faulty execFile wrapper/callback. */
function query(execute, executable, args, milliseconds, maxBuffer, environment) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => {
      finish(null);
      // This is exclusively our bounded --version/where child, never a native
      // DSH, desktop application or a discovered user's background process.
      try { child?.kill(); } catch (_) {}
    }, milliseconds);
    try {
      child = execute(executable, args, { cwd: path.dirname(executable),
        windowsHide: true, shell: false, encoding: 'utf8', timeout: milliseconds,
        maxBuffer, env: environment }, (error, stdout) => {
        if (error || typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > maxBuffer) finish(null);
        else finish(stdout);
      });
      child?.on?.('error', () => finish(null));
    } catch (_) { finish(null); }
  });
}

async function resolveBridgeNode(options = {}, deps = {}) {
  const io = deps.fs || fs;
  const execute = deps.execFile || execFile;
  const platform = deps.platform || process.platform;
  const environment = deps.env || process.env;
  // Node startup flags can run a --require/--import script even for --version.
  // Probe a plain binary without inheriting module injection or Electron flags;
  // keep the supplied/process environment itself unchanged.
  const queryEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())));
  const deadline = Date.now() + bound(deps.totalTimeoutMs, 6000, 20, 15000);
  const probeTimeout = bound(deps.probeTimeoutMs, 1200, 10, 3000);
  const discoveryTimeout = bound(deps.discoveryTimeoutMs, 1200, 10, 3000);
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const processExecutable = options.processExecutable === undefined ? process.execPath : options.processExecutable;
  const nodeVersion = options.nodeVersion === undefined ? process.versions.node : options.nodeVersion;
  const isElectron = options.isElectron === undefined ? Boolean(process.versions.electron) : Boolean(options.isElectron);
  let sawOldNode = false;
  const seen = new Set();
  const remaining = limit => Math.max(0, Math.min(limit, deadline - Date.now()));
  async function probe(candidate, basename = nodeName) {
    const identity = canonicalRegular(io, candidate, basename);
    if (!identity || seen.has(identity.path.toLowerCase())) return null;
    seen.add(identity.path.toLowerCase());
    const budget = remaining(probeTimeout);
    if (!budget) return null;
    const output = await query(execute, identity.path, ['--version'], budget, 1024, queryEnvironment);
    const major = versionMajor(output);
    if (major === null || !unchanged(io, identity, basename)) return null;
    if (major < 24) { sawOldNode = true; return null; }
    return identity.path;
  }

  if (platform === 'win32') {
    for (const candidate of runtimeCandidates(io, options.bridgeDirectory)) {
      const result = await probe(candidate);
      if (result) return result;
      if (!remaining(probeTimeout)) break;
    }
  }

  // This version is supplied by the running non-Electron Node process itself;
  // probing that same binary again is unnecessary. Its path is still checked.
  if (!isElectron) {
    const major = versionMajor(nodeVersion, true);
    const identity = canonicalRegular(io, processExecutable, nodeName);
    if (identity && major !== null) {
      if (major >= 24) return identity.path;
      sawOldNode = true;
    }
  }

  let candidates = [];
  const discoveryBudget = remaining(discoveryTimeout);
  if (discoveryBudget) {
    try {
      if (typeof deps.discoverCandidates === 'function') {
        // Bound injected discovery too; it never gets to bypass candidate checks.
        let timer;
        try { candidates = await Promise.race([Promise.resolve(deps.discoverCandidates({ platform, env: environment })),
          new Promise(resolve => { timer = setTimeout(() => resolve([]), discoveryBudget); })]); }
        finally { clearTimeout(timer); }
      } else if (platform === 'win32') {
        const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
        const where = typeof systemRoot === 'string'
          ? canonicalRegular(io, path.join(systemRoot, 'System32', 'where.exe'), 'where.exe') : null;
        if (where) {
          const output = await query(execute, where.path, ['node.exe'], discoveryBudget, 16384, queryEnvironment);
          if (typeof output === 'string') candidates = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        }
      } else {
        candidates = String(environment.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value))
          .slice(0, 64).map(value => path.join(value, 'node'));
      }
    } catch (_) { candidates = []; }
  }
  if (Array.isArray(candidates)) for (const candidate of candidates.slice(0, 24)) {
    const result = await probe(candidate);
    if (result) return result;
    if (!remaining(probeTimeout)) break;
  }
  throw codeError(sawOldNode ? 'node-24-required' : 'node-unavailable');
}

module.exports = { resolveBridgeNode };
