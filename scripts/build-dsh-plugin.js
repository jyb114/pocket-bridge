'use strict';

// A plugin archive is built from Git's public file inventory, never by copying
// the installation directory. npm pack runs in an owned stage with hooks off.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { builtinModules } = require('node:module');
const { isPayloadPath } = require('./release-profile.js');

const SOURCE_MANIFEST = 'dsh-plugin/gateway-source-manifest.json';
const ROOT_FILES = new Set(['LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md',
  'package.json', 'CHANGELOG.md', 'RELEASE_NOTES.md']);
const DIRECTORIES = ['scripts/', 'pwa/', 'desktop/', 'docs/', 'dsh-plugin/'];
const OMIT = new Set(['scripts/build-dsh-plugin.js', 'scripts/run-ci-tests.js', 'scripts/run-all-tests.js',
  'scripts/watch-tunnel-notify.js', 'scripts/replay-isolated-fixture.js', 'scripts/cleanup-test-threads.js',
  'desktop/setup.cmd', 'desktop/双击安装.vbs', 'desktop/dsh-gateway.bat', 'desktop/fix-firewall.cmd']);
const REQUIRED = ['package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md',
  'dsh-plugin/package.json', 'dsh-plugin/index.js', 'dsh-plugin/client.js', 'dsh-plugin/cordis.patch.yml',
  'scripts/dsh-plugin-controller.js', 'scripts/gateway-daemon.js', 'scripts/mobile-proxy.js',
  'scripts/first-run.js', 'scripts/release-profile.js', 'scripts/gateway-listener.js',
  'scripts/gateway-lifecycle.js', 'scripts/dsh-runtime.js', 'scripts/dsh-runtime-identity.js',
  'scripts/dsh-lite-attachment.js', 'scripts/public-static-representation-cache.js',
  'pwa/dsh-lite.html', 'pwa/dsh-lite-ui.js', 'pwa/dsh-lite.css', 'pwa/e2ee.js', 'pwa/console.html',
  'desktop/open-desktop-app.js', 'desktop/open-console-app.js', 'desktop/icons/app.ico'];
const RUNTIME_ROOTS = ['scripts/gateway-daemon.js', 'scripts/mobile-proxy.js',
  'desktop/open-desktop-app.js', 'desktop/open-console-app.js', 'dsh-plugin/index.js', 'dsh-plugin/client.js'];
const HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare',
  'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish'];
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && relative.length < 512
    && !relative.includes('\\') && !/[\x00-\x1f\x7f:]/.test(relative) && !path.posix.isAbsolute(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..');
}
function allowedPublicPath(relative) {
  if (!safeRelative(relative) || relative === SOURCE_MANIFEST || OMIT.has(relative)) return false;
  if (!ROOT_FILES.has(relative) && !DIRECTORIES.some(dir => relative.startsWith(dir))) return false;
  if (!isPayloadPath(relative)) return false;
  if (relative.split('/').some(part => /^(?:\.git|node_modules|logs?|config|uploads?|runtime|cloudflared|caddy|tls|private|tests?|fixtures?|artifacts?|output|temp)$/i.test(part))) return false;
  if (/^scripts\/test-/i.test(relative) || /(?:^|[/.-])(?:codex|dot)(?:[./-]|$)/i.test(relative)) return false;
  if (/(?:^|\/)watch-tunnel-notify(?:\.|$)|(?:^|\/)(?:access-key|e2ee-secret|devices|pair-code|notify-targets|vapid)\.(?:json|txt)$/i.test(relative)) return false;
  if (/\.(?:pem|key|pfx|p12|log|pid|exe|dll|zip|tgz|bak|tmp|sqlite|db)$/i.test(relative)) return false;
  return true;
}
function assertNoLinks(absolute) {
  let current = path.resolve(absolute);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('A source or output ancestor is a link.');
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
}
function readRegular(root, relative) {
  if (!safeRelative(relative)) fail('Unsafe source path.');
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('Source escaped the repository.');
  assertNoLinks(file);
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) fail('Source must be a bounded ordinary file.');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== bytes.length || after.size !== bytes.length) fail('Source changed while being read.');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function validatePackage(files) {
  for (const relative of REQUIRED) if (!files.has(relative)) fail(`Missing public plugin dependency: ${relative}`);
  let manifest, scope;
  try { manifest = JSON.parse(files.get('package.json')); scope = JSON.parse(files.get('dsh-plugin/package.json')); }
  catch (_) { fail('Invalid package manifest.'); }
  if (manifest.name !== 'pocket-bridge' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(manifest.version || '')) fail('Unexpected plugin package identity.');
  if (manifest.type && manifest.type !== 'commonjs') fail('The gateway package must remain CommonJS.');
  if (scope.type !== 'module') fail('The nested DSH plugin must be an ES module.');
  if (manifest.exports?.['.'] !== './dsh-plugin/index.js' || manifest.exports?.['./client'] !== './dsh-plugin/client.js') fail('Missing exact DSH plugin exports.');
  if (manifest.dsh?.bundle?.patch !== './dsh-plugin/cordis.patch.yml') fail('Missing installable dsh.bundle patch.');
  if (manifest.dsh?.client?.platform !== 'web') fail('Missing DSH Web client declaration.');
  if (HOOKS.some(hook => Object.hasOwn(manifest.scripts || {}, hook))) fail('Install and packaging lifecycle hooks are prohibited.');
  if (Object.keys(manifest.dependencies || {}).length || Object.keys(manifest.devDependencies || {}).length) fail('The source plugin must not add installed dependency graphs.');
  for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths']) {
    if (typeof manifest.peerDependencies?.[name] !== 'string' || !manifest.peerDependencies[name]) fail(`Missing host peer declaration: ${name}`);
  }
  if (!/name:\s*pocket-bridge\b/.test(files.get('dsh-plugin/cordis.patch.yml').toString('utf8'))) fail('The bundle patch does not insert this package.');
  return manifest;
}
function validateDependencyClosure(files, manifest) {
  const seen = new Set();
  const pending = [...RUNTIME_ROOTS];
  while (pending.length) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (!files.has(relative)) fail(`Missing runtime dependency: ${relative}`);
    const text = files.get(relative).toString('utf8');
    const specifiers = [...text.matchAll(/\b(?:require|import)\(\s*['"]([^'"\r\n]+)['"]\s*\)/g),
      ...text.matchAll(/^\s*(?:import|export)\s+[^;\n]*?\bfrom\s*['"]([^'"\r\n]+)['"]/gm),
      ...text.matchAll(/^\s*import\s+['"]([^'"\r\n]+)['"]/gm)];
    for (const match of specifiers) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) {
        const name = specifier.replace(/^node:/, '');
        if (BUILTINS.has(name)) continue;
        // React is the DSH browser host's require() service, not a bundled copy.
        if (relative === 'dsh-plugin/client.js' && name === 'react') continue;
        if (relative.startsWith('dsh-plugin/') && Object.hasOwn(manifest.peerDependencies || {}, name)) continue;
        fail(`Undeclared runtime dependency: ${relative} -> ${specifier}`);
      }
      const requested = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!safeRelative(requested)) fail(`Runtime dependency escaped package: ${relative}`);
      const resolved = [requested, `${requested}.js`, `${requested}.json`, `${requested}/index.js`].find(candidate => files.has(candidate));
      if (!resolved) fail(`Missing runtime dependency: ${relative} -> ${specifier}`);
      if (/\.[cm]?js$/i.test(resolved)) pending.push(resolved);
    }
  }
  if (seen.size < 25) fail('Gateway runtime dependency inventory is unexpectedly small.');
  return seen;
}
function field(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}
function parsePax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < offset) fail('Malformed archive extension.');
    const length = Number(bytes.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length) fail('Malformed archive extension length.');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal < 1) fail('Malformed archive extension field.');
    result[record.slice(0, equal)] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}
// Parse the real npm tarball without extracting it. This also rejects links and
// traversal before any runtime source materialization can use the inventory.
function readArchive(archivePath) {
  const compressed = fs.readFileSync(archivePath);
  if (compressed.length > 32 * 1024 * 1024) fail('Plugin archive is too large.');
  const tar = zlib.gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  let offset = 0, pax = null;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    const stored = parseInt(field(block, 148, 8).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
    if (stored !== checksum) fail('Invalid archive header checksum.');
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || offset + 512 + size > tar.length) fail('Invalid archive entry size.');
    const type = String.fromCharCode(block[156]);
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { if (pax) fail('Repeated archive extension.'); pax = parsePax(bytes); continue; }
    const prefix = field(block, 345, 155);
    const name = pax?.path || (prefix ? `${prefix}/` : '') + field(block, 0, 100);
    if (pax?.size !== undefined && Number(pax.size) !== size) fail('Conflicting archive size.');
    pax = null;
    if (type === '5' && /^package(?:\/[a-zA-Z0-9_.-]+)*\/$/.test(name) && !name.split('/').includes('..')) continue;
    if (!['0', '\0'].includes(type)) fail('Archive links and special files are prohibited.');
    if (!name.startsWith('package/') || !safeRelative(name.slice(8))) fail('Unsafe archive member.');
    const relative = name.slice(8);
    if (files.has(relative)) fail('Duplicate archive member.');
    if (relative !== SOURCE_MANIFEST && !allowedPublicPath(relative)) fail(`Non-public archive member: ${relative}`);
    files.set(relative, Buffer.from(bytes));
    if (files.size > 1000) fail('Archive has too many members.');
  }
  if (pax || files.size === 0 || tar.subarray(offset).some(byte => byte !== 0)) fail('Malformed or trailing archive content.');
  return files;
}
function verifyArchive(archivePath, expectedFiles) {
  const files = readArchive(archivePath);
  const manifest = validatePackage(files);
  const dependencies = validateDependencyClosure(files, manifest);
  let source;
  try { source = JSON.parse(files.get(SOURCE_MANIFEST)); } catch (_) { fail('Missing gateway source manifest.'); }
  if (source.schemaVersion !== 1 || source.package?.name !== manifest.name || source.package?.version !== manifest.version || !Array.isArray(source.files)) fail('Invalid gateway source manifest identity.');
  const recorded = new Set();
  for (const item of source.files) {
    if (!item || !allowedPublicPath(item.relative) || recorded.has(item.relative) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256 || '')) fail('Invalid gateway source manifest entry.');
    recorded.add(item.relative);
    const bytes = files.get(item.relative);
    if (!bytes || bytes.length !== item.size || sha256(bytes) !== item.sha256) fail(`Source manifest mismatch: ${item.relative}`);
  }
  if (recorded.size !== files.size - 1 || [...files.keys()].some(relative => relative !== SOURCE_MANIFEST && !recorded.has(relative))) fail('Source manifest does not exactly cover the public archive.');
  if (expectedFiles) {
    if (expectedFiles.size !== files.size) fail('npm changed the staged public file inventory.');
    for (const [relative, bytes] of expectedFiles) if (!files.get(relative)?.equals(bytes)) fail(`npm changed staged bytes: ${relative}`);
  }
  return { files, manifest, source, runtimeDependencyCount: dependencies.size };
}
function ownedRemove(directory, parent) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(parent) || !/^\.pb-plugin-stage-[A-Za-z0-9]+$/.test(path.basename(resolved))) fail('Refusing to remove an unowned stage.');
  assertNoLinks(resolved);
  function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) fail('Refusing to remove a linked stage.');
    if (item.isDirectory()) walk(path.join(dir, item.name));
  } }
  walk(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}
function npmCliPath() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) fail('npm CLI is required beside the selected Node executable.');
  return found;
}
function buildPluginPackage(options) {
  if (!options?.outputDirectory) fail('Specify an output directory.');
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const output = path.resolve(options.outputDirectory);
  if (output === root || output.startsWith(root + path.sep)) fail('Artifacts must be outside the source checkout.');
  fs.mkdirSync(output, { recursive: true });
  assertNoLinks(root); assertNoLinks(output);
  const tracked = options.trackedPaths || execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
  if (!Array.isArray(tracked) || tracked.length > 10000) fail('Invalid Git inventory.');
  const selected = [...new Set(tracked)].filter(allowedPublicPath).sort();
  const original = new Map(selected.map(relative => [relative, readRegular(root, relative)]));
  const files = new Map(original);
  const manifest = validatePackage(files);
  validateDependencyClosure(files, manifest);
  // Explicit files avoids npm's inferred ignore rules changing the package. This
  // modification lives only in the stage; the repository package stays intact.
  files.set('package.json', Buffer.from(JSON.stringify({ ...manifest, files: [...selected, SOURCE_MANIFEST].sort() }, null, 2) + '\n'));
  const source = { schemaVersion: 1, package: { name: manifest.name, version: manifest.version },
    files: [...files].map(([relative, bytes]) => ({ relative, size: bytes.length, sha256: sha256(bytes) })).sort((a, b) => a.relative.localeCompare(b.relative, 'en')) };
  files.set(SOURCE_MANIFEST, Buffer.from(JSON.stringify(source, null, 2) + '\n'));
  const artifactName = `${manifest.name}-${manifest.version}.tgz`;
  const artifactPath = path.join(output, artifactName);
  const reportPath = path.join(output, `${artifactName}.verification.json`);
  const sumPath = path.join(output, `${artifactName}.sha256`);
  if ([artifactPath, reportPath, sumPath].some(file => fs.existsSync(file))) fail('Plugin artifacts already exist; use a fresh output directory.');
  const stage = fs.mkdtempSync(path.join(output, '.pb-plugin-stage-'));
  try {
    const packageStage = path.join(stage, 'package');
    fs.mkdirSync(packageStage);
    for (const [relative, bytes] of files) {
      const target = path.join(packageStage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    }
    const packTemp = path.join(stage, 'temp');
    fs.mkdirSync(packTemp);
    const env = { ...process.env, TEMP: packTemp, TMP: packTemp, TMPDIR: packTemp,
      npm_config_cache: process.env.npm_config_cache || path.join(output, '.npm-cache'),
      npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
    execFileSync(process.execPath, [npmCliPath(), 'pack', '--ignore-scripts', '--json', '--pack-destination', stage],
      { cwd: packageStage, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stagedArchive = path.join(stage, artifactName);
    const checked = verifyArchive(stagedArchive, files);
    // Fail if a concurrent editor changed any input after the snapshot.
    for (const [relative, bytes] of original) if (!readRegular(root, relative).equals(bytes)) fail(`Source changed during packaging: ${relative}`);
    const artifactBytes = fs.readFileSync(stagedArchive);
    const report = { schemaVersion: 1, artifact: artifactName, package: { name: manifest.name, version: manifest.version },
      bytes: artifactBytes.length, sha256: sha256(artifactBytes), publicFileCount: checked.files.size,
      sourceManifestFileCount: checked.source.files.length, runtimeDependencyCount: checked.runtimeDependencyCount,
      installHooks: false, privateDataIncluded: false, archivedTargetsIncluded: false,
      sourceModified: false, liveRuntimeTested: false };
    fs.writeFileSync(artifactPath, artifactBytes, { flag: 'wx', mode: 0o644 });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    fs.writeFileSync(sumPath, `${report.sha256}  ${artifactName}\n`, { flag: 'wx', mode: 0o644 });
    return { ...report, artifactPath, reportPath, sumPath };
  } finally { ownedRemove(stage, output); }
}

module.exports = { buildPluginPackage, allowedPublicPath, safeRelative, validatePackage,
  validateDependencyClosure, readArchive, verifyArchive, SOURCE_MANIFEST, sha256 };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) fail('Usage: node scripts/build-dsh-plugin.js <artifact-directory>');
    console.log(JSON.stringify(buildPluginPackage({ outputDirectory: process.argv[2] }), null, 2));
  } catch (error) { console.error(`Plugin packaging failed: ${error.message}`); process.exitCode = 1; }
}
