'use strict';

// Detection only: no credentials, process management, package installation or RPC writes.
// Version labels help diagnostics; observed protocol capabilities take precedence.
const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024;
const PROFILES = Object.freeze({
  'legacy-events': Object.freeze({
    muxPath: '/api/events.mux', hostEventsPath: '/api/events.host',
    bootstrapMethod: 'host.describe', browserAuth: false
  }),
  'remote-mux': Object.freeze({
    muxPath: '/api/remote.mux', bootstrapStream: '$events', bootstrapEvent: 'ready',
    followMethod: 'workspace.follow', browserAuth: true
  }),
  'desktop-ipc': Object.freeze({ transport: 'electron-ipc', supported: false })
});
// These are inspected upstream builds, not a promise about every past/future release.
const VERIFIED_VERSIONS = Object.freeze({
  '0.1.0-rc.8': 'legacy-events', '0.1.1-rc.2': 'legacy-events',
  '0.1.5-rc.3': 'remote-mux', '0.1.7-rc.2': 'remote-mux',
  // Exact published npm build: authenticated events ready + workspace baseline
  // were exercised against the installed runtime, rather than inferred by range.
  '0.2.0-rc.2': 'remote-mux'
});

function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^v/, '');
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(text) ? text : null;
}

function pathApi(file) {
  return /^[A-Za-z]:[\\/]/.test(file) || file.includes('\\') ? path.win32 : file.startsWith('/') ? path.posix : path;
}

function readExactly(io, fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = io.readSync(fd, buffer, read, length - read, position + read);
    if (!count) throw new Error('Truncated ASAR data');
    read += count;
  }
  return buffer;
}

function readPackageVersion(packageJsonPath, deps = {}) {
  const io = deps.fs || fs;
  try {
    const size = io.statSync(packageJsonPath).size;
    if (!Number.isSafeInteger(size) || size < 2 || size > MAX_PACKAGE_BYTES) return null;
    const pkg = JSON.parse(io.readFileSync(packageJsonPath, 'utf8'));
    return normalizeVersion(pkg.version);
  } catch (_) { return null; }
}

/** Read package.json inside an Electron ASAR without loading the archive into memory. */
function readAsarVersion(archivePath, deps = {}) {
  const io = deps.fs || fs;
  let fd;
  try {
    const archiveSize = io.statSync(archivePath).size;
    if (!Number.isSafeInteger(archiveSize) || archiveSize < 16) return null;
    fd = io.openSync(archivePath, 'r');
    const prefix = readExactly(io, fd, 8, 0);
    // Outer pickle contains a uint32 telling us the complete header pickle length.
    if (prefix.readUInt32LE(0) !== 4) return null;
    const pickleSize = prefix.readUInt32LE(4);
    if (pickleSize < 8 || pickleSize > MAX_HEADER_BYTES || 8 + pickleSize > archiveSize) return null;
    const header = readExactly(io, fd, pickleSize, 8);
    const payloadSize = header.readUInt32LE(0);
    const jsonSize = header.readUInt32LE(4);
    if (payloadSize !== pickleSize - 4 || jsonSize > payloadSize - 4) return null;
    const tree = JSON.parse(header.subarray(8, 8 + jsonSize).toString('utf8'));
    const files = tree && tree.files;
    if (!files) return null;
    // Desktop builds have used both nested dsh/app packages and a root package.
    // Only these known package locations are read; no recursive archive scan.
    const entries = [files.dsh && files.dsh.files && files.dsh.files['package.json'],
      files.app && files.app.files && files.app.files['package.json'], files['package.json']];
    const dataStart = 8 + pickleSize;
    for (const entry of entries) {
      if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) ||
          entry.size < 2 || entry.size > MAX_PACKAGE_BYTES || !/^\d+$/.test(String(entry.offset))) continue;
      const entryOffset = Number(entry.offset);
      if (!Number.isSafeInteger(entryOffset) || entryOffset < 0 ||
          !Number.isSafeInteger(dataStart + entryOffset + entry.size) ||
          dataStart + entryOffset + entry.size > archiveSize) continue;
      try {
        const pkg = JSON.parse(readExactly(io, fd, entry.size, dataStart + entryOffset).toString('utf8'));
        const version = normalizeVersion(pkg.version);
        if (version) return version;
      } catch (_) { /* A malformed candidate cannot suppress the next known package. */ }
    }
    return null;
  } catch (_) { return null; }
  finally { if (fd !== undefined) { try { io.closeSync(fd); } catch (_) {} } }
}

/** Prefer the package beside the actual running executable over registry guesses. */
function readDesktopVersion(executablePath, deps = {}) {
  if (typeof executablePath !== 'string' || !executablePath) return { version: null, source: null };
  const p = pathApi(executablePath), dir = p.dirname(executablePath);
  const archives = [p.join(dir, 'resources', 'app.asar')];
  if (p.basename(dir) === 'MacOS') archives.push(p.join(dir, '..', 'Resources', 'app.asar'));
  for (const archive of archives) {
    const version = readAsarVersion(archive, deps);
    if (version) return { version, source: 'desktop-asar', packagePath: archive };
  }
  // Electron development/unpacked distribution; still adjacent to the executable.
  const unpacked = p.join(dir, 'resources', 'app', 'package.json');
  const version = readPackageVersion(unpacked, deps);
  return { version, source: version ? 'desktop-package' : null, packagePath: version ? unpacked : null };
}

function readCliVersion(packageJsonPath, deps = {}) {
  const version = typeof packageJsonPath === 'string' ? readPackageVersion(packageJsonPath, deps) : null;
  return { version, source: version ? 'cli-package' : null, packagePath: version ? packageJsonPath : null };
}

function tokenizeCommandLine(commandLine) {
  const tokens = String(commandLine || '').match(/"(?:[^"]|"")*"|'[^']*'|[^\s]+/g) || [];
  return tokens.map(token => ((token[0] === '"' && token.endsWith('"')) ||
    (token[0] === "'" && token.endsWith("'"))) ? token.slice(1, -1).replace(/""/g, '"') : token);
}

function commandBase(value) {
  return path.win32.basename(String(value || '').replace(/\//g, '\\')).toLowerCase();
}

/** Identify desktop and CLI web process candidates without matching arbitrary node apps. */
function parseDshProcess(record = {}) {
  const commandLine = record.commandLine || record.command || '';
  const args = Array.isArray(record.args) ? record.args.map(String) : tokenizeCommandLine(commandLine);
  const executablePath = record.executablePath || record.exe || null;
  const name = commandBase(record.name || executablePath || args[0]);
  if (name === 'deepseek harness.exe' || name === 'deepseek harness' || name === 'dsh-desktop' || name === 'dsh-desktop.exe') {
    return { kind: 'desktop', executablePath, commandLine, packageJsonPath: null, advertisedVersion: null };
  }
  const hasWeb = args.some(arg => arg === 'web');
  if (!hasWeb) return null;
  const bases = args.slice(0, 2).map(commandBase);
  const npmLauncher = [name, ...bases].some(base => /^(?:npm|npx)(?:\.cmd|\.exe)?$/.test(base) || /^(?:npm|npx)-cli\.js$/.test(base));
  const scoped = args.find(arg => /^(?:--package=)?@deepseek-ai\/dsh(?:@[^\s]+)?$/.test(arg));
  if (npmLauncher && scoped) {
    const match = scoped.replace(/^--package=/, '').match(/^@deepseek-ai\/dsh@(.+)$/);
    return { kind: 'cli', executablePath, commandLine, packageJsonPath: null, advertisedVersion: match ? normalizeVersion(match[1]) : null };
  }
  if (/^dsh(?:\.cmd|\.exe)?$/.test(name)) {
    return { kind: 'cli', executablePath, commandLine, packageJsonPath: record.packageJsonPath || null, advertisedVersion: null };
  }
  if (!/^node(?:\.exe)?$/.test(name)) return null;
  // The first script argument must be the scoped package entry. A package path
  // mentioned in an unrelated application's data argument is not sufficient.
  let script = null;
  const scriptStart = /^node(?:\.exe)?$/.test(commandBase(args[0])) ? 1 : 0;
  for (let i = scriptStart; i < args.length; i++) {
    if (['-e', '--eval', '-p', '--print'].includes(args[i])) return null;
    if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    script = args[i]; break;
  }
  if (!script) return null;
  const normalized = script.replace(/\\/g, '/');
  const scopedEntry = normalized.match(/^(.*\/(?:node_modules\/)?@deepseek-ai\/dsh)\/(.+\.(?:cjs|mjs|js))$/i);
  if (!scopedEntry) return null;
  const p = pathApi(script);
  const packageRoot = script.slice(0, script.length - scopedEntry[2].length - 1);
  return { kind: 'cli', executablePath, commandLine, packageJsonPath: p.join(packageRoot, 'package.json'), advertisedVersion: null };
}

/** A generic HTML 200 and a ./ redirect are not a DSH identity proof. */
function fingerprintDshHttp(response = {}) {
  const status = Number(response.statusCode || response.status);
  const headers = response.headers || {};
  const type = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const body = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body || '');
  if (status === 401 && /^\s*dsh web authentication required(?:; reopen the URL printed by dsh web\.)?\s*$/i.test(body)) {
    return { identified: true, confidence: 'high', evidence: 'dsh-auth-challenge', capabilities: { browserAuth: true } };
  }
  const title = /<title[^>]*>\s*(?:DeepSeek\s+Harness|DSH(?:\s+Web)?)\s*<\/title>/i.test(body);
  const appAsset = /<(?:script|link)\b[^>]*(?:src|href)=["'][^"']*(?:\.\/|\/)assets\/[^"']+\.(?:js|css)(?:[?#][^"']*)?["']/i.test(body);
  const appMarker = /(?:name=["'](?:application-name|apple-mobile-web-app-title)["'][^>]*content=["'](?:DeepSeek Harness|DSH)["']|data-dsh(?:-app)?(?:[\s=>]))/i.test(body);
  if (status === 200 && type.includes('text/html') && title && (appAsset || appMarker)) {
    return { identified: true, confidence: 'high', evidence: 'dsh-app-html', capabilities: {} };
  }
  return { identified: false, confidence: 'low', evidence: null, capabilities: {} };
}

function detectProfile(input = {}) {
  const capabilities = { ...(input.capabilities || {}) };
  const bundle = typeof input.bundleText === 'string' ? input.bundleText : '';
  if (/\/api\/remote\.mux\b/.test(bundle)) capabilities.remoteMux = true;
  if (/\/api\/events\.mux\b/.test(bundle) && /\/api\/events\.host\b/.test(bundle)) capabilities.legacyEvents = true;
  if (/workspace\.follow\b/.test(bundle)) capabilities.workspaceFollow = true;
  if (/host\.describe\b/.test(bundle)) capabilities.hostDescribe = true;
  if (capabilities.remoteMux && capabilities.legacyEvents) {
    return { profile: 'unsupported', capabilities, supported: false, evidence: 'conflicting-capabilities', reason: 'Multiple DSH protocols were observed; select the active application before connecting.' };
  }
  if (capabilities.remoteMux) {
    return { profile: 'remote-mux', capabilities, supported: true, evidence: 'observed-capabilities', reason: null };
  }
  if (capabilities.legacyEvents) {
    return { profile: 'legacy-events', capabilities, supported: true, evidence: 'observed-capabilities', reason: null };
  }
  const version = normalizeVersion(input.version);
  if (version === '0.1.5-rc.3' && input.kind === 'desktop') {
    return { profile: 'desktop-ipc', capabilities: { ...capabilities, desktopIpc: true }, supported: false,
      evidence: 'verified-desktop-version', reason: 'This desktop build uses Electron IPC without a web listener. Use the CLI web runtime or a desktop build exposing the inspected HTTP gateway.' };
  }
  if (version === '0.1.5-rc.3' && input.kind !== 'cli') {
    return { profile: 'unsupported', capabilities, supported: false, evidence: 'runtime-kind-required',
      reason: 'This version has different desktop and CLI transports; identify the running runtime.' };
  }
  if (version === '0.2.0-rc.2' && input.kind !== 'cli') {
    return { profile: 'unsupported', capabilities, supported: false, evidence: 'runtime-kind-required',
      reason: 'Only the inspected npm web runtime is verified for this version.' };
  }
  const known = version && VERIFIED_VERSIONS[version];
  if (known) {
    // Authentication on a build whose inspected protocol has none is conflicting
    // evidence, rather than a reason to silently route it to the old endpoint.
    if (known === 'legacy-events' && capabilities.browserAuth === true) {
      return { profile: 'unsupported', capabilities, supported: false, evidence: 'conflicting-version', reason: 'Authentication contradicts the inspected legacy protocol; inspect the active bundle.' };
    }
    return { profile: known, capabilities, supported: true, evidence: 'verified-version', reason: null };
  }
  return { profile: 'unsupported', capabilities, supported: false, evidence: 'unknown-protocol', reason: 'DSH protocol has not been identified; inspect its capabilities before connecting.' };
}

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** Assemble the same diagnostic record for desktop installs and CLI web servers. */
function createRuntimeRecord(input = {}, deps = {}) {
  const processInfo = input.process ? parseDshProcess(input.process) : null;
  const kind = processInfo ? processInfo.kind : (['desktop', 'cli'].includes(input.kind) ? input.kind : 'unknown');
  let local = { version: null, source: null };
  const executablePath = input.executablePath || (processInfo && processInfo.executablePath);
  const packageJsonPath = input.packageJsonPath || (processInfo && processInfo.packageJsonPath);
  if (kind === 'desktop' && executablePath) local = readDesktopVersion(executablePath, deps);
  if (kind === 'cli' && packageJsonPath) local = readCliVersion(packageJsonPath, deps);
  const advertised = normalizeVersion(input.version || input.advertisedVersion || (processInfo && processInfo.advertisedVersion));
  const version = local.version || advertised;
  const versionSource = local.source || (advertised ? 'advertised' : null);
  const fingerprint = input.fingerprint || (input.httpResponse ? fingerprintDshHttp(input.httpResponse) : null);
  const selected = detectProfile({ kind, version, bundleText: input.bundleText,
    capabilities: { ...((fingerprint && fingerprint.capabilities) || {}), ...(input.capabilities || {}) } });
  const identified = Boolean((fingerprint && fingerprint.identified) || processInfo);
  return {
    kind, version, port: validPort(input.port) ? input.port : null,
    profile: selected.profile, capabilities: selected.capabilities,
    confidence: fingerprint && fingerprint.identified ? 'high' : processInfo ? 'medium' : 'low',
    identified, supported: selected.supported, versionSource,
    evidence: selected.evidence, httpEvidence: fingerprint ? fingerprint.evidence : null,
    reason: selected.reason
  };
}

/** Loopback-only, unauthenticated GET /. No redirect following or RPC invocation. */
async function probeDshRuntime(input = {}, deps = {}) {
  if (!validPort(input.port)) return createRuntimeRecord(input, deps);
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(50, Math.min(deps.timeoutMs, 10000)) : 1500;
  const maxBodyBytes = Number.isInteger(deps.maxBodyBytes) ? Math.max(256, Math.min(deps.maxBodyBytes, 256 * 1024)) : 64 * 1024;
  const request = deps.request || http.request;
  let transientProbeFailure = false, observedStatusCode = null;
  const response = await new Promise(resolve => {
    let settled = false, req, deadline;
    const finish = (value, transient = false) => {
      if (settled) return;
      settled = true;
      // Once negative HTTP headers arrived, a truncated body or later timeout
      // must not turn an authorization refusal into a transport retry.
      transientProbeFailure = transient && (observedStatusCode === null || observedStatusCode === 200);
      clearTimeout(deadline);
      resolve(value);
    };
    deadline = setTimeout(() => { finish(null, true); if (req) req.destroy(); }, timeoutMs);
    try {
      req = request({ hostname: '127.0.0.1', port: input.port, path: '/', method: 'GET',
        agent: false, headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' }, timeout: timeoutMs }, res => {
        observedStatusCode = res.statusCode;
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBodyBytes) {
            finish(null);
            if (req) req.destroy();
            if (typeof res.destroy === 'function') res.destroy();
            return;
          }
          chunks.push(bytes);
        });
        res.on('end', () => finish({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => finish(null, true));
        res.on('aborted', () => finish(null, true));
        res.on('close', () => { if (!res.complete) finish(null, true); });
      });
      req.on('timeout', () => { finish(null, true); req.destroy(); });
      req.on('error', () => finish(null, true));
      req.end();
    } catch (_) { finish(null); if (req) req.destroy(); }
  });
  // Failed/oversized responses must not inherit a stale positive fingerprint.
  const fingerprint = response ? fingerprintDshHttp(response) : { identified: false, confidence: 'low', evidence: null, capabilities: {} };
  return { ...createRuntimeRecord({ ...input, fingerprint }, deps), transientProbeFailure };
}

module.exports = {
  PROFILES, VERIFIED_VERSIONS, normalizeVersion, readAsarVersion,
  readPackageVersion, readDesktopVersion, readCliVersion, tokenizeCommandLine,
  parseDshProcess, fingerprintDshHttp, detectProfile, createRuntimeRecord,
  probeDshRuntime, validPort
};
