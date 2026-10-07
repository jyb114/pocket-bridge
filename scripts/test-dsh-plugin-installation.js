#!/usr/bin/env node
'use strict';
// Real filesystem tests for the managed gateway copy. No native process,
// browser, production installation, private user data or npm cache is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createManagedInstallation, parseManifest, publicPath } = require('./dsh-plugin-installation');
const MANIFEST = 'dsh-plugin/gateway-source-manifest.json';
const MARKER = '.pocket-bridge-managed.json';
const LOCK = '.pocket-bridge-install.lock';
const fixtureRoot = path.resolve(process.env.PB_PLUGIN_INSTALL_TEST_DIR || 'D:\\桥\\dsh-plugin-validation-preview13\\installation-tests');
if (!/^D:\\.+/i.test(fixtureRoot) || fixtureRoot === path.parse(fixtureRoot).root) throw new Error('Owned test artifacts must stay below D:');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'owned-'));
process.env.TEMP = workspace; process.env.TMP = workspace; process.env.TMPDIR = workspace;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const FILES = [
  'package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'RELEASE_NOTES.md',
  'scripts/gateway-daemon.js', 'scripts/mobile-proxy.js', 'scripts/security-audit.js', 'scripts/prune-data.js', 'scripts/self-check.js', 'scripts/dsh-runtime.js',
  'pwa/dsh-lite.html', 'pwa/e2ee.js', 'pwa/dsh-lite-ui.js', 'pwa/dsh-lite.css', 'pwa/manifest.webmanifest', 'pwa/pocket-bridge.svg',
  'desktop/launcher.js', 'desktop/launcher.css', 'docs/DSH_PLUGIN.md', 'docs/retired.md',
  'dsh-plugin/index.js', 'dsh-plugin/client.js', 'dsh-plugin/cordis.patch.yml', 'dsh-plugin/package.json'
];
const results = [];
function test(label, fn) {
  try { fn(); results.push({ label, passed: true }); console.log('PASS ' + label); }
  catch (error) { results.push({ label, passed: false, error: String(error.message).slice(0, 800) }); console.error('FAIL ' + label + ': ' + error.message); }
}
function makeFixture(name, revision = 1, options = {}) {
  const root = path.join(workspace, name); fs.mkdirSync(root);
  const source = path.join(root, 'source'), target = path.join(root, 'managed-gateway');
  fs.mkdirSync(source); const files = options.files || FILES;
  const version = options.version || '1.0.0-fixture.' + revision;
  for (const relative of files) {
    const destination = path.join(source, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    const value = relative === 'package.json' ? Buffer.from(JSON.stringify({ name: 'pocket-bridge', version, private: true })) : Buffer.from('Owned fixture: ' + relative + '\nRevision: ' + revision + '\n');
    fs.writeFileSync(destination, value, { flag: 'wx' });
  }
  const manifest = { schemaVersion: 1, package: { name: 'pocket-bridge', version }, files: files.map(relative => { const value = fs.readFileSync(path.join(source, relative)); return { relative, size: value.length, sha256: hash(value) }; }) };
  fs.writeFileSync(path.join(source, MANIFEST), JSON.stringify(manifest, null, 2));
  return { root, source, target, manifest, manager: createManagedInstallation({ sourceDirectory: source, bridgeDirectory: target }) };
}
function writeManifest(fixture, change) {
  const value = JSON.parse(JSON.stringify(fixture.manifest)); change(value);
  fs.writeFileSync(path.join(fixture.source, MANIFEST), JSON.stringify(value)); return value;
}
function snapshot(directory) {
  const result = {};
  if (!fs.existsSync(directory)) return result;
  function visit(at, prefix) {
    for (const item of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + item.name : item.name, actual = path.join(at, item.name);
      if (item.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(actual) };
      else if (item.isDirectory()) { result[relative + '/'] = 'directory'; visit(actual, relative); }
      else result[relative] = { size: fs.statSync(actual).size, sha256: hash(fs.readFileSync(actual)) };
    }
  }
  visit(directory, ''); return result;
}
function reject(fn, codes) { assert.throws(fn, error => !!error && (!codes || codes.includes(error.code)), codes && ('Expected ' + codes.join(' / '))); }
function put(directory, relative, value) { const destination = path.join(directory, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, value); return destination; }
const fresh = makeFixture('fresh');
test('public fixture contains at least 20 fixed files and real content SHA-256', () => { assert(FILES.length >= 20); assert.equal(fresh.manifest.files.length, FILES.length); for (const row of fresh.manifest.files) assert.equal(hash(fs.readFileSync(path.join(fresh.source, row.relative))), row.sha256); });
test('first install copies the complete source to a stable managed directory', () => { assert.equal(fresh.manager.hasInstallation(), false); const result = fresh.manager.ensure(); assert.equal(result.version, '1.0.0-fixture.1'); assert.equal(result.files, FILES.length); assert.equal(fresh.manager.hasInstallation(), true); for (const row of fresh.manifest.files) assert.equal(hash(fs.readFileSync(path.join(fresh.target, row.relative))), row.sha256); });
test('installed public files are independent regular copies, not hardlinks or symlinks', () => { for (const relative of FILES) { const source = fs.statSync(path.join(fresh.source, relative), { bigint: true }); const target = fs.lstatSync(path.join(fresh.target, relative), { bigint: true }); assert(target.isFile()); assert(!target.isSymbolicLink()); assert.equal(target.nlink, 1n); assert.notEqual(target.ino, source.ino); } });
test('marker pins the source manifest, owner and installed version', () => { const marker = JSON.parse(fs.readFileSync(path.join(fresh.target, MARKER))); assert.equal(marker.schemaVersion, 1); assert.equal(marker.owner, 'pocket-bridge-dsh-plugin'); assert.deepEqual(marker.source, fresh.manifest); });
test('successful first install leaves no installation lock or temporary marker', () => assert(!fs.existsSync(path.join(fresh.target, LOCK))));
test('idempotent install preserves the stable path and exact file bytes', () => { const before = snapshot(fresh.target); fresh.manager.ensure(); assert.deepEqual(snapshot(fresh.target), before); assert.equal(path.basename(fresh.target), 'managed-gateway'); });

const upgrade = makeFixture('upgrade'); upgrade.manager.ensure();
const privateBytes = {
  'config.json': Buffer.from('{"privateEndpoint":"local-only","unknownSetting":{"preserve":true}}\n'),
  'current-url.txt': crypto.randomBytes(93),
  'logs/keys.json': crypto.randomBytes(80),
  'logs/e2ee-key.json': crypto.randomBytes(57),
  'logs/events.jsonl': Buffer.from('Private diagnostic evidence\n'),
  'logs/user-stopped.flag': Buffer.from('Owned private test marker\n'),
  'uploads/image.bin': crypto.randomBytes(130),
  'uploads/nested/document.pdf': crypto.randomBytes(178),
  'private/credentials.json': crypto.randomBytes(63),
  'docs/user-notes.txt': Buffer.from('Keep my unknown public directory notes.\n'),
  'scripts/user-tool.js': Buffer.from('Custom user tool, not owned by the bundle.\n'),
  'my-unknown-root-file.txt': Buffer.from('Keep the user file.\n')
};
for (const [relative, value] of Object.entries(privateBytes)) put(upgrade.target, relative, value);
const oldRetired = fs.readFileSync(path.join(upgrade.target, 'docs/retired.md'));
const revisionTwo = makeFixture('revision-two', 2, { files: FILES.filter(relative => relative !== 'docs/retired.md').concat('docs/added.md') });
const secondManager = createManagedInstallation({ sourceDirectory: revisionTwo.source, bridgeDirectory: upgrade.target });
test('upgrade replaces only matching previous owned public content', () => { const result = secondManager.ensure(); assert.equal(result.version, '1.0.0-fixture.2'); for (const row of revisionTwo.manifest.files) assert.equal(hash(fs.readFileSync(path.join(upgrade.target, row.relative))), row.sha256); });
test('upgrade preserves private keys, uploads, log evidence and unknown configuration byte for byte', () => { for (const [relative, value] of Object.entries(privateBytes)) assert.deepEqual(fs.readFileSync(path.join(upgrade.target, relative)), value, relative); });
test('retired public files and user files are not deleted during upgrade', () => { assert.deepEqual(fs.readFileSync(path.join(upgrade.target, 'docs/retired.md')), oldRetired); assert(fs.existsSync(path.join(upgrade.target, 'scripts/user-tool.js'))); });
test('upgrade updates the marker to the new source manifest and removes its own empty lock', () => { const marker = JSON.parse(fs.readFileSync(path.join(upgrade.target, MARKER))); assert.deepEqual(marker.source, revisionTwo.manifest); assert(!fs.existsSync(path.join(upgrade.target, LOCK))); });
test('later changes to npm source do not change an already installed copy', () => { const destination = path.join(upgrade.target, 'README.md'), before = fs.readFileSync(destination); fs.appendFileSync(path.join(revisionTwo.source, 'README.md'), 'Changed source after installation.\n'); assert.deepEqual(fs.readFileSync(destination), before); });
test('modified source with stale SHA is rejected before any destination write', () => { const before = snapshot(upgrade.target); reject(() => secondManager.ensure(), ['source-changed']); assert.deepEqual(snapshot(upgrade.target), before); });

const currentVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).version;
const stableVersion = makeFixture('current-version-upgrade-target'); stableVersion.manager.ensure();
for (const [relative, value] of Object.entries(privateBytes)) put(stableVersion.target, relative, value);
const currentSourceFixture = makeFixture('current-version-upgrade-source', 3, { version: currentVersion });
test('upgrade to the current source package version retains the stable managed path and every private byte', () => {
  const manager = createManagedInstallation({ sourceDirectory: currentSourceFixture.source, bridgeDirectory: stableVersion.target });
  const result = manager.ensure(); assert.equal(result.version, currentVersion);
  for (const [relative, value] of Object.entries(privateBytes)) assert.deepEqual(fs.readFileSync(path.join(stableVersion.target, relative)), value, relative);
  for (const row of currentSourceFixture.manifest.files) assert.equal(hash(fs.readFileSync(path.join(stableVersion.target, row.relative))), row.sha256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stableVersion.target, MARKER))).source.package.version, currentVersion);
});
const pnpmSource = makeFixture('pnpm-source-hardlinks');
fs.linkSync(path.join(pnpmSource.source, 'package.json'), path.join(pnpmSource.root, 'pnpm-store-package.json'));
fs.linkSync(path.join(pnpmSource.source, 'scripts/gateway-daemon.js'), path.join(pnpmSource.root, 'pnpm-store-gateway-daemon.js'));
test('read-only pnpm-style source hardlinks are accepted and copied into independent target files', () => {
  assert(fs.statSync(path.join(pnpmSource.source, 'package.json')).nlink > 1); pnpmSource.manager.ensure();
  for (const relative of ['package.json', 'scripts/gateway-daemon.js']) { const source = fs.statSync(path.join(pnpmSource.source, relative), { bigint: true }); const target = fs.statSync(path.join(pnpmSource.target, relative), { bigint: true }); assert.equal(target.nlink, 1n); assert.notEqual(target.ino, source.ino); assert.deepEqual(fs.readFileSync(path.join(pnpmSource.source, relative)), fs.readFileSync(path.join(pnpmSource.target, relative))); }
});

const sourceMismatch = makeFixture('source-sha'); writeManifest(sourceMismatch, value => { value.files.at(-1).sha256 = '0'.repeat(64); });
test('manifest SHA mismatch refuses first install without creating the target', () => { reject(() => sourceMismatch.manager.ensure(), ['source-changed']); assert(!fs.existsSync(sourceMismatch.target)); });
const wrongSize = makeFixture('source-size'); writeManifest(wrongSize, value => { value.files.at(-1).size++; });
test('source size mismatch refuses first install without creating the target', () => { reject(() => wrongSize.manager.ensure(), ['source-changed']); assert(!fs.existsSync(wrongSize.target)); });
const wrongPackage = makeFixture('source-package'); put(wrongPackage.source, 'package.json', JSON.stringify({ name: 'other-package', version: wrongPackage.manifest.package.version }));
test('package identity mismatch refuses installation', () => { reject(() => wrongPackage.manager.ensure(), ['source-changed']); assert(!fs.existsSync(wrongPackage.target)); });
test('manifest rejects traversal, absolute, backslash and private paths', () => {
  for (const relative of ['../README.md', '/README.md', 'scripts/../README.md', 'scripts\\gateway-daemon.js', 'scripts//nested.js', 'scripts/./nested.js', 'logs/keys.json', 'uploads/private.bin', 'config.json', 'current-url.txt', 'pwa/private/item.js', 'scripts/runtime/node.exe', 'scripts/.git/index', 'scripts/watch-tunnel-notify.js', 'pwa/codex-ui.js', MANIFEST, MARKER]) {
    assert.equal(publicPath(relative), false, relative); const invalid = JSON.parse(JSON.stringify(fresh.manifest)); invalid.files.at(-1).relative = relative; reject(() => parseManifest(Buffer.from(JSON.stringify(invalid))), ['unsafe-bundle-manifest']);
  }
});
test('Windows case variants cannot bypass the private path exclusions', () => {
  for (const relative of ['scripts/Logs/keys.json', 'pwa/Private/content.js', 'docs/Config.JSON', 'scripts/Runtime/node.exe', 'pwa/Current-URL.TXT', 'scripts/Watch-Tunnel-Notify.js', 'pwa/Codex-ui.js']) assert.equal(publicPath(relative), false, relative);
});
test('manifest rejects Windows alternate streams, device names and ambiguous filename segments', () => {
  for (const relative of ['scripts/file.js:secret', 'scripts/name./main.js', 'scripts/name /main.js', 'scripts/CON', 'docs/NUL.txt', 'scripts/LPT1.js', 'scripts/aux.js']) assert.equal(publicPath(relative), false, relative);
});
test('manifest rejects duplicates, oversized files, bad hashes and incomplete payloads', () => {
  for (const change of [value => { value.files[1].relative = 'scripts/mobile-proxy.js'; }, value => { value.files[1].size = 2 * 1024 * 1024 + 1; }, value => { value.files[1].size = -1; }, value => { value.files[1].size = 1.5; }, value => { value.files[1].sha256 = 'invalid'; }]) { const value = JSON.parse(JSON.stringify(fresh.manifest)); change(value); reject(() => parseManifest(Buffer.from(JSON.stringify(value))), ['unsafe-bundle-manifest']); }
  const missing = JSON.parse(JSON.stringify(fresh.manifest)); missing.files = missing.files.filter(row => row.relative !== 'scripts/mobile-proxy.js'); reject(() => parseManifest(Buffer.from(JSON.stringify(missing))), ['incomplete-bundle-manifest']);
});
const conflict = makeFixture('nonempty-conflict'); put(conflict.target, 'my-user-file.txt', 'User data\n');
test('unmarked nonempty target refuses installation and preserves its unknown files', () => { const before = snapshot(conflict.target); reject(() => conflict.manager.ensure(), ['managed-installation-conflict']); assert.deepEqual(snapshot(conflict.target), before); });
const falseMarker = makeFixture('bad-marker'); put(falseMarker.target, MARKER, '{"owner":"somebody-else","schemaVersion":1}'); put(falseMarker.target, 'user.txt', 'Preserve');
test('incorrect ownership marker refuses installation without modifying the target', () => { const before = snapshot(falseMarker.target); reject(() => falseMarker.manager.ensure(), ['managed-installation-unverified']); assert.deepEqual(snapshot(falseMarker.target), before); });
const interrupted = makeFixture('interrupted'); interrupted.manager.ensure(); const held = path.join(interrupted.target, LOCK); fs.mkdirSync(held); put(held, 'evidence.json', '{"previousAttempt":"interrupted"}');
test('interrupted installation lock is not adopted or deleted', () => { const before = snapshot(interrupted.target); reject(() => interrupted.manager.ensure(), ['managed-installation-pending']); assert.deepEqual(snapshot(interrupted.target), before); assert(fs.existsSync(path.join(held, 'evidence.json'))); });
const changedTarget = makeFixture('modified-target'); changedTarget.manager.ensure(); const revisedTarget = makeFixture('modified-target-next', 2); const nextTargetManager = createManagedInstallation({ sourceDirectory: revisedTarget.source, bridgeDirectory: changedTarget.target });
put(changedTarget.target, 'dsh-plugin/package.json', 'User changed an owned file late in the copy order.\n');
test('modified owned public file refuses upgrade and is never overwritten', () => { const value = fs.readFileSync(path.join(changedTarget.target, 'dsh-plugin/package.json')); reject(() => nextTargetManager.ensure(), ['managed-source-modified']); assert.deepEqual(fs.readFileSync(path.join(changedTarget.target, 'dsh-plugin/package.json')), value); });
const atomicTarget = makeFixture('preflight-modification'); atomicTarget.manager.ensure(); const atomicNext = makeFixture('preflight-next', 2); const atomicManager = createManagedInstallation({ sourceDirectory: atomicNext.source, bridgeDirectory: atomicTarget.target }); put(atomicTarget.target, 'dsh-plugin/package.json', 'Changed late-order owned file.\n');
test('all destination ownership is checked before the first upgrade write', () => { const before = snapshot(atomicTarget.target); reject(() => atomicManager.ensure(), ['managed-source-modified']); assert.deepEqual(snapshot(atomicTarget.target), before); });
const newConflict = makeFixture('new-owned-conflict'); newConflict.manager.ensure(); put(newConflict.target, 'docs/added.md', 'Unknown user document using the future asset filename.\n');
test('future public filename cannot overwrite an existing unowned user file', () => {
  const extra = 'docs/added.md'; const nextSource = makeFixture('new-file-next', 2, { files: FILES.concat(extra) }); const manager = createManagedInstallation({ sourceDirectory: nextSource.source, bridgeDirectory: newConflict.target }); const before = fs.readFileSync(path.join(newConflict.target, extra)); reject(() => manager.ensure(), ['managed-source-modified']); assert.deepEqual(fs.readFileSync(path.join(newConflict.target, extra)), before);
});
test('source and target directory overlap is rejected', () => {
  for (const target of [fresh.source, path.join(fresh.source, 'managed'), path.dirname(fresh.source)]) reject(() => createManagedInstallation({ sourceDirectory: fresh.source, bridgeDirectory: target }), ['unsafe-managed-directory']);
});
test('Windows case differences cannot bypass source/target overlap checks', () => {
  if (process.platform !== 'win32') return;
  for (const target of [fresh.source.toUpperCase(), path.join(fresh.source.toUpperCase(), 'managed'), path.dirname(fresh.source).toUpperCase()]) reject(() => createManagedInstallation({ sourceDirectory: fresh.source, bridgeDirectory: target }), ['unsafe-managed-directory']);
});

const linkedPublic = makeFixture('hardlinked-public'); linkedPublic.manager.ensure(); const linkedPublicFile = path.join(linkedPublic.target, 'README.md'); fs.linkSync(linkedPublicFile, path.join(linkedPublic.root, 'external-owned-fixture.md'));
test('existing hardlinked public destination is refused rather than retaining an external association', () => { const before = snapshot(linkedPublic.target); reject(() => linkedPublic.manager.ensure(), ['unsafe-installation', 'managed-source-modified']); assert.deepEqual(snapshot(linkedPublic.target), before); });

const sourceLink = makeFixture('source-link'); const linkedSource = path.join(sourceLink.root, 'source-junction'); fs.symlinkSync(sourceLink.source, linkedSource, 'junction');
test('source directory junction is refused before destination mutation', () => { const manager = createManagedInstallation({ sourceDirectory: linkedSource, bridgeDirectory: sourceLink.target }); reject(() => manager.ensure(), ['unsafe-installation']); assert(!fs.existsSync(sourceLink.target)); });
const targetLink = makeFixture('target-link'); const linkedTarget = path.join(targetLink.root, 'managed-junction'); fs.mkdirSync(targetLink.target); put(targetLink.target, 'private.txt', 'No link traversal'); fs.symlinkSync(targetLink.target, linkedTarget, 'junction');
test('target directory junction is refused and its real data is preserved', () => { const before = snapshot(targetLink.target); const manager = createManagedInstallation({ sourceDirectory: targetLink.source, bridgeDirectory: linkedTarget }); reject(() => manager.ensure(), ['unsafe-installation']); assert.deepEqual(snapshot(targetLink.target), before); });
const nestedLink = makeFixture('nested-target-link'); nestedLink.manager.ensure(); const originalPwa = path.join(nestedLink.root, 'private-pwa-copy'); fs.renameSync(path.join(nestedLink.target, 'pwa'), originalPwa); fs.symlinkSync(originalPwa, path.join(nestedLink.target, 'pwa'), 'junction');
test('nested destination junction refuses upgrade without changing linked private data', () => { const before = snapshot(originalPwa); const manager = createManagedInstallation({ sourceDirectory: atomicNext.source, bridgeDirectory: nestedLink.target }); reject(() => manager.ensure(), ['unsafe-installation']); assert.deepEqual(snapshot(originalPwa), before); });

// Optional actual staged npm bundle acceptance. The source is read-only; all
// destination bytes remain in this invocation's newly created D: workspace.
const bundleIndex = process.argv.indexOf('--bundle-source');
if (bundleIndex >= 0) {
  const source = path.resolve(process.argv[bundleIndex + 1] || '');
  if (!/^D:\\.+/i.test(source)) throw new Error('Prepared bundle source must be on D:');
  const actualBundle = makeFixture('actual-bundle-upgrade-target'); actualBundle.manager.ensure();
  for (const [relative, value] of Object.entries(privateBytes)) put(actualBundle.target, relative, value);
  const beforeSource = snapshot(source);
  const manager = createManagedInstallation({ sourceDirectory: source, bridgeDirectory: actualBundle.target });
  const actualManifest = manager.manifest();
  test('actual prepared npm bundle upgrades owned public files while preserving private state', () => {
    const result = manager.ensure(); assert.equal(result.version, actualManifest.package.version);
    for (const row of actualManifest.files) assert.equal(hash(fs.readFileSync(path.join(actualBundle.target, row.relative))), row.sha256, row.relative);
    for (const [relative, value] of Object.entries(privateBytes)) assert.deepEqual(fs.readFileSync(path.join(actualBundle.target, relative)), value, relative);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(actualBundle.target, MARKER))).source, actualManifest);
    assert(!fs.existsSync(path.join(actualBundle.target, LOCK)));
  });
  test('actual prepared bundle acceptance leaves its complete source tree byte-identical', () => assert.deepEqual(snapshot(source), beforeSource));
}

const report = { schemaVersion: 1, createdAt: new Date().toISOString(), ownedWorkspace: workspace, fixtureFileCount: FILES.length, checks: results.length, passed: results.every(result => result.passed), results, productionOrBrowserTouched: false, sourceHelperChanged: false };
fs.writeFileSync(path.join(workspace, 'result.json'), JSON.stringify(report, null, 2));
console.log(`${report.passed ? 'PASS' : 'FAIL'} ${results.filter(result => result.passed).length}/${results.length} managed installation checks. Report: ${path.join(workspace, 'result.json')}`);
if (!report.passed) process.exitCode = 1;
