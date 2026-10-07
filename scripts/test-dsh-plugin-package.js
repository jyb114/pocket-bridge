'use strict';

// Real npm-pack and system-tar regression in an owned source copy. No DSH,
// gateway, browser, Git mutation, production credentials or profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const builder = require('./build-dsh-plugin.js');

const root = path.resolve(__dirname, '..');
const tempBase = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempBase, 'pb-plugin-package-test-'));
const fixture = path.join(scratch, 'source');
const output = path.join(scratch, 'artifacts');
const PUBLIC_ADDITIONS = ['dsh-plugin/index.js', 'dsh-plugin/client.js', 'dsh-plugin/package.json',
  'dsh-plugin/cordis.patch.yml', 'scripts/dsh-plugin-controller.js', 'scripts/dsh-plugin-installation.js',
  'scripts/dsh-plugin-node.js',
  'docs/DSH-PLUGIN.md'];
let passed = 0;
function check(label, run) { run(); passed++; console.log('OK ' + label); }
function put(relative, bytes) {
  assert(builder.safeRelative(relative));
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
function packMap(entries, destination) {
  const blocks = [];
  for (const [relative, bytes] of entries) {
    let name = `package/${relative}`, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf('/');
      prefix = name.slice(0, split); name = name.slice(split + 1);
    }
    assert(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(destination, zlib.gzipSync(Buffer.concat(blocks)));
}
function altered(label, changes) {
  const files = new Map(accepted.files);
  changes(files);
  const archive = path.join(scratch, `${label}.tgz`);
  packMap(files, archive);
  return archive;
}
let accepted;
try {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const inventory = [...new Set([...tracked, ...PUBLIC_ADDITIONS.filter(relative => fs.existsSync(path.join(root, relative)))])];
  for (const relative of inventory.filter(builder.allowedPublicPath)) put(relative, fs.readFileSync(path.join(root, relative)));
  const packageFile = path.join(fixture, 'package.json');
  const originalPackage = fs.readFileSync(packageFile);
  const fixturePackage = { ...JSON.parse(originalPackage), version: '1.0.0-preview.13',
    exports: { '.': './dsh-plugin/index.js', './client': './dsh-plugin/client.js' },
    dsh: { bundle: { patch: './dsh-plugin/cordis.patch.yml' }, client: { platform: 'web' } },
    peerDependencies: { '@deepseek-ai/schemastery': '*', '@deepseek-ai/dsh-home-paths': '*' } };
  put('package.json', JSON.stringify(fixturePackage, null, 2) + '\n');
  const sourceBefore = fs.readFileSync(packageFile);
  const secretMarker = 'ISOLATED_PRIVATE_DATA_DO_NOT_PACKAGE_6e01d3d54c9b';
  const omitted = ['config.json', 'logs/access-key.txt', 'uploads/dsh/private/photo.txt',
    'runtime/node.exe', 'cloudflared/cloudflared.exe', 'scripts/watch-tunnel-notify.js',
    'scripts/test-dsh-private-fixture.js', 'scripts/fixtures/user-message.txt',
    'scripts/codex-desktop-driver.js', 'pwa/codex.html', 'pwa/dot.html', 'docs/dot-inbox-plugin.example.json',
    'dsh-plugin/private/devices.json', 'scripts/local-secret.key', 'output/screenshot.txt'];
  for (const relative of omitted) put(relative, secretMarker);
  const allInputs = [...inventory, ...omitted, '../outside-private.txt', 'scripts/../config.json', 'scripts\\unsafe.js'];
  const result = builder.buildPluginPackage({ root: fixture, outputDirectory: output, trackedPaths: allInputs });
  accepted = builder.verifyArchive(result.artifactPath);

  check('a real npm tarball has the complete validated bundle and gateway source manifest', () => {
    assert(result.bytes > 10000);
    assert(result.publicFileCount > 100);
    assert.equal(result.sourceManifestFileCount, result.publicFileCount - 1);
    assert(result.runtimeDependencyCount >= 25);
    assert.equal(accepted.manifest.exports['.'], './dsh-plugin/index.js');
    assert.equal(accepted.manifest.exports['./client'], './dsh-plugin/client.js');
    assert.equal(accepted.manifest.dsh.bundle.patch, './dsh-plugin/cordis.patch.yml');
    assert.equal(JSON.parse(accepted.files.get('dsh-plugin/package.json')).type, 'module');
  });
  check('system tar independently lists every real package member without private additions', () => {
    const list = execFileSync('tar', ['-tzf', result.artifactPath], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).filter(Boolean).filter(name => !name.endsWith('/'));
    assert.equal(list.length, accepted.files.size);
    assert.deepEqual(new Set(list), new Set([...accepted.files.keys()].map(relative => `package/${relative}`)));
    const bytes = execFileSync('tar', ['-xOf', result.artifactPath, 'package/package.json'], { windowsHide: true });
    assert(bytes.equals(accepted.files.get('package.json')));
  });
  check('every public member is source-hashed and manifest does not recursively hash itself', () => {
    const listed = new Set(accepted.source.files.map(item => item.relative));
    assert(!listed.has(builder.SOURCE_MANIFEST));
    for (const item of accepted.source.files) {
      const bytes = accepted.files.get(item.relative);
      assert.equal(item.size, bytes.length);
      assert.equal(item.sha256, builder.sha256(bytes));
    }
    assert(accepted.source.files.some(item => item.relative === 'scripts/gateway-daemon.js'));
    assert(accepted.source.files.some(item => item.relative === 'pwa/dsh-lite-ui.js'));
  });
  check('tracked private, retired and artifact paths are excluded and their bytes never enter the package', () => {
    for (const relative of omitted) assert(!accepted.files.has(relative), relative);
    for (const [relative, bytes] of accepted.files) {
      assert(relative === builder.SOURCE_MANIFEST || builder.allowedPublicPath(relative), relative);
      assert(!bytes.includes(Buffer.from(secretMarker)), relative);
    }
  });
  check('packaging leaves source bytes, isolated private data and generated state unchanged', () => {
    assert(fs.readFileSync(packageFile).equals(sourceBefore));
    for (const relative of omitted) assert.equal(fs.readFileSync(path.join(fixture, relative), 'utf8'), secretMarker);
    assert(!fs.existsSync(path.join(fixture, builder.SOURCE_MANIFEST)));
    assert(!fs.existsSync(path.join(fixture, 'node_modules')));
    assert(!fs.readdirSync(output).some(name => name.startsWith('.pb-plugin-stage-')));
  });
  check('frozen artifact sidecar and verification report match the actual archive bytes', () => {
    assert.equal(result.sha256, builder.sha256(fs.readFileSync(result.artifactPath)));
    assert.equal(fs.readFileSync(result.sumPath, 'utf8'), `${result.sha256}  ${path.basename(result.artifactPath)}\n`);
    const saved = JSON.parse(fs.readFileSync(result.reportPath));
    assert.equal(saved.sha256, result.sha256);
    assert.equal(saved.installHooks, false);
    assert.equal(saved.liveRuntimeTested, false);
    assert.throws(() => builder.buildPluginPackage({ root: fixture, outputDirectory: output, trackedPaths: allInputs }), /already exist/);
  });
  check('missing runtime dependency cannot produce an archive', () => {
    const file = path.join(fixture, 'scripts/gateway-daemon.js');
    const bytes = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, '\nrequire(\'./missing-packaged-module.js\');\n');
      assert.throws(() => builder.buildPluginPackage({ root: fixture, outputDirectory: path.join(scratch, 'missing-dependency'), trackedPaths: allInputs }), /Missing runtime dependency/);
    } finally { fs.writeFileSync(file, bytes); }
  });
  check('lifecycle hooks are rejected before npm can execute a hook', () => {
    const before = fs.readFileSync(packageFile);
    const value = JSON.parse(before);
    value.scripts.prepare = 'node -e "require(\'fs\').writeFileSync(\'HOOK_RAN\',\'unexpected\')"';
    try {
      put('package.json', JSON.stringify(value));
      assert.throws(() => builder.buildPluginPackage({ root: fixture, outputDirectory: path.join(scratch, 'hook-case'), trackedPaths: allInputs }), /lifecycle hooks/);
      assert(!fs.existsSync(path.join(fixture, 'HOOK_RAN')));
    } finally { fs.writeFileSync(packageFile, before); }
  });
  check('ordinary-source hard links are rejected without reading linked content into a package', () => {
    const linked = path.join(fixture, 'scripts/linked-private.js');
    fs.linkSync(path.join(fixture, 'logs/access-key.txt'), linked);
    try {
      assert.throws(() => builder.buildPluginPackage({ root: fixture, outputDirectory: path.join(scratch, 'linked-case'), trackedPaths: [...allInputs, 'scripts/linked-private.js'] }), /ordinary file/);
    } finally { fs.unlinkSync(linked); }
  });
  check('runtime rejects payload tampering despite a syntactically valid tarball', () => {
    const changed = altered('tampered-code', files => files.set('scripts/gateway-daemon.js', Buffer.concat([files.get('scripts/gateway-daemon.js'), Buffer.from('\n// changed\n')])));
    assert.throws(() => builder.verifyArchive(changed), /Source manifest mismatch/);
    const wrongHash = altered('tampered-manifest', files => {
      const value = JSON.parse(files.get(builder.SOURCE_MANIFEST));
      value.files[0].sha256 = '0'.repeat(64);
      files.set(builder.SOURCE_MANIFEST, Buffer.from(JSON.stringify(value)));
    });
    assert.throws(() => builder.verifyArchive(wrongHash), /Source manifest mismatch/);
  });
  check('runtime rejects unrecorded members, retired pages and traversal independently of Git', () => {
    assert.throws(() => builder.verifyArchive(altered('extra-code', files => files.set('scripts/unrecorded.js', Buffer.from('module.exports = {};')))), /exactly cover/);
    assert.throws(() => builder.verifyArchive(altered('retired-code', files => files.set('pwa/codex.html', Buffer.from('<html></html>')))), /Non-public archive member/);
    const traversal = path.join(scratch, 'traversal.tgz');
    packMap([['../outside.js', Buffer.from('not allowed')]], traversal);
    assert.throws(() => builder.readArchive(traversal), /Unsafe archive member/);
    const duplicate = path.join(scratch, 'duplicate.tgz');
    packMap([['package.json', Buffer.from('{}')], ['package.json', Buffer.from('{}')]], duplicate);
    assert.throws(() => builder.readArchive(duplicate), /Duplicate archive member/);
  });
  check('archive checksum damage and missing exports cannot pass package verification', () => {
    const invalid = zlib.gunzipSync(fs.readFileSync(result.artifactPath));
    invalid[0] ^= 1;
    const damaged = path.join(scratch, 'damaged-header.tgz');
    fs.writeFileSync(damaged, zlib.gzipSync(invalid));
    assert.throws(() => builder.readArchive(damaged), /header checksum/);
    const missingExports = altered('missing-exports', files => {
      const value = JSON.parse(files.get('package.json'));
      delete value.exports;
      files.set('package.json', Buffer.from(JSON.stringify(value)));
    });
    assert.throws(() => builder.verifyArchive(missingExports), /exact DSH plugin exports/);
  });
  console.log(`Passed ${passed} plugin package checks; ${result.publicFileCount} real tar members, ${result.runtimeDependencyCount} closed runtime dependencies. No live plugin compatibility was claimed.`);
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), tempBase);
  assert(path.basename(resolved).startsWith('pb-plugin-package-test-'));
  assert(!fs.lstatSync(resolved).isSymbolicLink());
  fs.rmSync(resolved, { recursive: true, force: true });
}
