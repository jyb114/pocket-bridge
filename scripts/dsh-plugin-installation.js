'use strict';

// Keep the runnable gateway and its private state outside node_modules. npm
// plugin uninstall must not delete a user's pairing identity or uploaded files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MANIFEST = 'dsh-plugin/gateway-source-manifest.json';
const MARKER = '.pocket-bridge-managed.json';
const ROOT_FILES = new Set(['package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'RELEASE_NOTES.md']);
const publicPath = relative => typeof relative === 'string' && !relative.includes('\\') && !path.posix.isAbsolute(relative) &&
  !relative.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) &&
  (ROOT_FILES.has(relative) || /^(?:scripts|pwa|desktop|docs|dsh-plugin)\//.test(relative)) &&
  !/^(?:scripts\/(?:test-|codex-|dot-|watch-tunnel-notify)|pwa\/(?:codex|dot)(?:[.-]|$))/i.test(relative) &&
  !/(?:^|\/)(?:node_modules|logs|uploads|runtime|cloudflared|\.git|private|config\.json|current-url\.txt)(?:\/|$)/i.test(relative) &&
  relative !== MANIFEST && relative !== MARKER;
const failure = code => Object.assign(Error(code), { code });
function checkPath(file) {
  for (let at = file; at; at = path.dirname(at) === at ? '' : path.dirname(at)) {
    try { if (fs.lstatSync(at).isSymbolicLink()) throw failure('unsafe-installation'); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('unsafe-installation'); }
  }
}
function bytes(file, limit = 2 * 1024 * 1024, singleEntry = false) {
  checkPath(file); let fd;
  try {
    fd = fs.openSync(file, 'r'); const stat = fs.fstatSync(fd);
    if (!stat.isFile() || singleEntry && stat.nlink !== 1 || stat.size > limit) throw failure('unsafe-installation');
    const value = fs.readFileSync(fd); const after = fs.fstatSync(fd);
    if (value.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || value.length > limit) throw failure('source-changed');
    return value;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function parseManifest(value) {
  let manifest; try { manifest = JSON.parse(value.toString('utf8')); } catch (_) { throw failure('bundle-manifest-unavailable'); }
  if (manifest?.schemaVersion !== 1 || manifest.package?.name !== 'pocket-bridge' || !/^1\.0\.0(?:-[a-z0-9.-]+)?$/i.test(manifest.package.version || '') ||
      !Array.isArray(manifest.files) || manifest.files.length < 20 || manifest.files.length > 2048) throw failure('bundle-manifest-unavailable');
  const seen = new Set();
  for (const row of manifest.files) {
    if (!publicPath(row.relative) || seen.has(row.relative.toLowerCase()) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 2 * 1024 * 1024 ||
        !/^[0-9a-f]{64}$/i.test(row.sha256 || '')) throw failure('unsafe-bundle-manifest');
    seen.add(row.relative.toLowerCase());
  }
  for (const required of ['package.json', 'scripts/gateway-daemon.js', 'scripts/mobile-proxy.js', 'pwa/dsh-lite.html', 'pwa/e2ee.js']) {
    if (!seen.has(required)) throw failure('incomplete-bundle-manifest');
  }
  return manifest;
}

function createManagedInstallation({ sourceDirectory, bridgeDirectory }) {
  const source = path.resolve(sourceDirectory), target = path.resolve(bridgeDirectory);
  const compareSource = process.platform === 'win32' ? source.toLowerCase() : source;
  const compareTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  if (compareSource === compareTarget || compareTarget.startsWith(compareSource + path.sep) || compareSource.startsWith(compareTarget + path.sep)) throw failure('unsafe-managed-directory');
  function manifest() {
    const result = parseManifest(bytes(path.join(source, MANIFEST)));
    const actualPackage = JSON.parse(bytes(path.join(source, 'package.json')).toString('utf8'));
    if (actualPackage.name !== result.package.name || actualPackage.version !== result.package.version) throw failure('source-changed');
    return result;
  }
  function hasInstallation() {
    checkPath(target);
    return fs.existsSync(path.join(target, 'package.json'));
  }
  function ensure() {
    const next = manifest();
    // Verify the entire input before the first destination write.
    const input = new Map();
    for (const row of next.files) {
      const value = bytes(path.join(source, row.relative));
      if (value.length !== row.size || digest(value) !== row.sha256.toLowerCase()) throw failure('source-changed');
      input.set(row.relative, value);
    }
    checkPath(target);
    let previous = null;
    if (fs.existsSync(target)) {
      const entries = fs.readdirSync(target);
      if (entries.length && !entries.includes(MARKER)) throw failure('managed-installation-conflict');
      if (entries.includes(MARKER)) {
        let saved; try { saved = JSON.parse(bytes(path.join(target, MARKER), undefined, true).toString('utf8')); } catch (_) { throw failure('managed-installation-unverified'); }
        if (saved.owner !== 'pocket-bridge-dsh-plugin' || saved.schemaVersion !== 1) throw failure('managed-installation-unverified');
        previous = parseManifest(Buffer.from(JSON.stringify(saved.source)));
      }
    }
    fs.mkdirSync(target, { recursive: true });
    const lock = path.join(target, '.pocket-bridge-install.lock');
    try { fs.mkdirSync(lock); } catch (_) { throw failure('managed-installation-pending'); }
    const prior = new Map((previous?.files || []).map(row => [row.relative, row]));
    try {
      // Reject modified, linked or otherwise unowned public files before any
      // public destination is replaced, rather than discovering one mid-copy.
      for (const row of next.files) {
        const destination = path.join(target, row.relative); checkPath(destination);
        if (!fs.existsSync(destination)) continue;
        const existing = bytes(destination, undefined, true), hash = digest(existing);
        if (hash === row.sha256.toLowerCase() && existing.length === row.size) continue;
        const old = prior.get(row.relative);
        if (!old || old.size !== existing.length || old.sha256.toLowerCase() !== hash) throw failure('managed-source-modified');
      }
      for (const row of next.files) {
        const destination = path.join(target, row.relative); checkPath(destination);
        if (fs.existsSync(destination)) {
          const existing = bytes(destination, undefined, true), hash = digest(existing);
          if (hash === row.sha256.toLowerCase() && existing.length === row.size) continue;
          const old = prior.get(row.relative);
          if (!old || old.size !== existing.length || old.sha256.toLowerCase() !== hash) throw failure('managed-source-modified');
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true }); checkPath(path.dirname(destination));
        const temporary = path.join(path.dirname(destination), `.pb-${crypto.randomBytes(12).toString('hex')}.tmp`);
        let fd;
        try {
          fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, input.get(row.relative)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          checkPath(destination); fs.renameSync(temporary, destination);
        } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (_) {} }
      }
      // No deletion pass: private or unknown files, including retired assets,
      // remain intact. The new source manifest tracks only owned public files.
      const markerBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, owner: 'pocket-bridge-dsh-plugin', source: next }, null, 2));
      const markerPath = path.join(target, MARKER), temporary = path.join(lock, 'marker.json');
      fs.writeFileSync(temporary, markerBytes, { flag: 'wx', mode: 0o600 }); checkPath(markerPath); fs.renameSync(temporary, markerPath);
      return { version: next.package.version, files: next.files.length };
    } finally {
      // Only the empty lock created by this invocation is removed. No recursive
      // deletion, private cleanup, or interrupted-install takeover is performed.
      try { fs.rmdirSync(lock); } catch (_) { /* Retain uncertain install evidence. */ }
    }
  }
  return { manifest, hasInstallation, ensure };
}
module.exports = { createManagedInstallation, parseManifest, publicPath };
