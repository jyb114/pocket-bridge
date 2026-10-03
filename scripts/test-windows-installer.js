'use strict';

// Source contracts only: no compiler, installer, registry, desktop or gateway.
// Interpret the actual marked/unmarked NSIS branches to guard shared state.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'packaging/windows/installer.nsi'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'packaging/windows/build.ps1'), 'utf8');
const stager = fs.readFileSync(path.join(root, 'packaging/windows/stage.js'), 'utf8');
const registryKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PocketBridge';
let passed = 0;
function check(name, operation) {
  operation();
  passed++;
  console.log(`OK ${name}`);
}
function tokens(line) {
  return (line.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g) || [])
    .map(value => /^['"]/.test(value) ? value.slice(1, -1) : value);
}
function activeLines(source) {
  return source.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith(';') && !line.startsWith('#'));
}
function installDefaults(source) {
  const lines = activeLines(source);
  const defaultDirectories = lines.filter(line => /^InstallDir\s/.test(line)).map(tokens);
  const registeredDirectories = lines.filter(line => /^InstallDirRegKey\s/.test(line)).map(tokens);
  assert.equal(defaultDirectories.length, 1);
  assert.deepEqual(defaultDirectories[0], ['InstallDir', '$LOCALAPPDATA\\Programs\\Pocket Bridge']);
  assert.equal(registeredDirectories.length, 1);
  assert.deepEqual(registeredDirectories[0], ['InstallDirRegKey', 'HKCU', registryKey, 'InstallLocation']);
  const languages = lines.filter(line => /^!insertmacro\s+MUI_LANGUAGE\s/.test(line))
    .map(line => tokens(line)[2]);
  assert.deepEqual(languages, ['English'], 'Windows UI locale must not select a non-English installer language');
  assert(!lines.some(line => /^StrCpy\s+\$INSTDIR\s/i.test(line)),
    'a custom directory assignment must not override standard registry and /D selection');
  return registeredDirectories[0];
}
function section(source, name) {
  const lines = activeLines(source);
  const start = lines.findIndex(line => tokens(line)[0] === 'Section' && tokens(line)[1] === name);
  assert(start >= 0, `${name} section is required`);
  const end = lines.findIndex((line, index) => index > start && line === 'SectionEnd');
  assert(end > start);
  return lines.slice(start + 1, end);
}
function sharedActions(source, name, hasMarker) {
  const lines = section(source, name);
  const labels = new Map(lines.flatMap((line, index) => /^\w+:$/.test(line) ? [[line.slice(0, -1), index]] : []));
  const result = [];
  for (let index = 0, steps = 0; index < lines.length; index++) {
    assert(++steps <= lines.length * 2, 'installer branch must terminate');
    const line = lines[index], parts = tokens(line), command = parts[0];
    if (/^\w+:$/.test(line)) continue;
    if (command === 'IfFileExists') {
      assert.equal(parts[1], '$INSTDIR\\installer-test.flag', 'only the installation-local test marker gates shared state');
      assert.equal(parts.length, 3, 'unexpected alternate marker branch');
      assert(labels.has(parts[2]), 'marker skip target must exist');
      if (hasMarker) index = labels.get(parts[2]);
      continue;
    }
    if (command === 'WriteRegStr' || command === 'WriteRegDWORD' || command === 'DeleteRegKey') {
      assert.equal(parts[1], 'HKCU', 'installer shared writes must remain per user');
      assert.equal(parts[2], registryKey, 'installer must not alter unrelated registration');
      result.push(parts);
      continue;
    }
    if (command === 'CreateShortCut' || (command === 'Delete' && /^\$(?:DESKTOP|SMPROGRAMS)\\/.test(parts[1] || ''))) {
      assert(/^\$(?:DESKTOP|SMPROGRAMS)\\(?:Uninstall )?Pocket Bridge\.lnk$/.test(parts[1] || ''),
        'installer must not alter unrelated shortcuts');
      result.push(parts);
      continue;
    }
    assert(['SetShellVarContext', 'SetOutPath', 'File', 'WriteUninstaller', 'Delete', '!include', 'RMDir'].includes(command),
      `Unreviewed installer instruction ${command}`);
    if (command === 'SetShellVarContext') assert.equal(parts[1], 'current');
    if (command === 'Delete') assert(parts[1].startsWith('$INSTDIR\\'), 'non-shortcut deletion must stay inside the installation');
    if (command === 'RMDir') {
      assert.equal(parts[1], '$INSTDIR', 'uninstaller root removal stays inside the installation');
      assert(!parts.includes('/r'), 'uninstaller must not recursively remove private data');
    }
  }
  return result;
}
function smokeContract(source) {
  const marker = source.indexOf("[IO.File]::WriteAllText((Join-Path $testInstall 'installer-test.flag')");
  const install = source.indexOf('$install = Start-Process -FilePath $setup');
  assert(marker >= 0 && install > marker, 'create the installation-local marker before the installer runs');
  const invocations = source.match(/\$(?:install|upgrade)\s*=\s*Start-Process[^\r\n]+/g) || [];
  assert.equal(invocations.length, 2, 'both fresh install and upgrade require isolated destination overrides');
  for (const invocation of invocations) {
    assert.match(invocation, /-ArgumentList\s+@\('\/S',\s*"\/D=\$testInstall"\)/,
      'absolute scratch /D must be the final argument without literal quotes');
    assert.match(invocation, /-WindowStyle Hidden -Wait -PassThru/);
  }
  assert.match(source, /\$testInstall\s*=\s*Join-Path\s+\$work\s+'installed'/);
  assert(!/Remove-Item[^\r\n]*installer-test\.flag/.test(source), 'never remove the test marker before uninstall');
  assert.match(source, /& \$nodeCommand \(Join-Path \$root 'scripts\\test-windows-installer\.js'\)/,
    'build must check its installer contracts before staging and compilation');
}

check('installer uses the existing per-user InstallLocation with a clean-install fallback', () => {
  const registered = installDefaults(installer);
  const normal = sharedActions(installer, 'Pocket Bridge', false);
  const location = normal.find(parts => parts[0] === 'WriteRegStr' && parts[3] === registered[3]);
  assert(location);
  assert.deepEqual(location.slice(1), [registered[1], registered[2], 'InstallLocation', '$INSTDIR']);
});
check('English is the only included installer language, including on Chinese Windows', () => {
  installDefaults(installer);
  assert.throws(() => installDefaults(installer.replace('!insertmacro MUI_LANGUAGE "English"',
    '!insertmacro MUI_LANGUAGE "English"\n!insertmacro MUI_LANGUAGE "SimpChinese"')));
});
check('marked installation and upgrade bypass every shared registry and shortcut write', () => {
  assert.deepEqual(sharedActions(installer, 'Pocket Bridge', true), []);
  const normal = sharedActions(installer, 'Pocket Bridge', false);
  assert.equal(normal.filter(parts => parts[0] === 'CreateShortCut').length, 3);
  assert.equal(normal.filter(parts => parts[0].startsWith('WriteReg')).length, 7);
});
check('marked uninstall bypasses shared registrations and shortcuts', () => {
  assert.deepEqual(sharedActions(installer, 'Uninstall', true), []);
  const normal = sharedActions(installer, 'Uninstall', false);
  assert.equal(normal.filter(parts => parts[0] === 'Delete').length, 3);
  assert.equal(normal.filter(parts => parts[0] === 'DeleteRegKey').length, 1);
});
check('a registration write inserted before the marker is detected', () => {
  const unsafe = installer.replace('  IfFileExists "$INSTDIR\\installer-test.flag" LinksDone',
    `  WriteRegStr HKCU "${registryKey}" "InstallLocation" "$INSTDIR"\n  IfFileExists "$INSTDIR\\installer-test.flag" LinksDone`);
  assert.throws(() => assert.deepEqual(sharedActions(unsafe, 'Pocket Bridge', true), []));
});
check('missing uninstall isolation and mismatched upgrade registry fields are detected', () => {
  const unsafe = installer.replace('  IfFileExists "$INSTDIR\\installer-test.flag" LinksRemoved\n', '')
    .replace('  IfFileExists "$INSTDIR\\installer-test.flag" LinksRemoved\r\n', '');
  assert.throws(() => assert.deepEqual(sharedActions(unsafe, 'Uninstall', true), []));
  assert.throws(() => installDefaults(installer.replace(
    `InstallDirRegKey HKCU "${registryKey}" "InstallLocation"`,
    `InstallDirRegKey HKCU "${registryKey}" "UninstallString"`)));
});
check('smoke install and upgrade explicitly override the remembered destination and keep isolation', () => {
  smokeContract(builder);
  assert.throws(() => smokeContract(builder.replace("@('/S', \"/D=$testInstall\")", "@(\"/D=$testInstall\", '/S')")));
  const markerLine = builder.match(/[^\r\n]*\[IO\.File\]::WriteAllText\(\(Join-Path \$testInstall 'installer-test\.flag'\)[^\r\n]*/)?.[0];
  assert(markerLine);
  const reordered = builder.replace(markerLine, '').replace('$installedNode =', markerLine + '\n    $installedNode =');
  assert.throws(() => smokeContract(reordered));
});
check('uninstall remains payload-only and preserves private data without recursive cleanup', () => {
  const commands = section(installer, 'Uninstall');
  assert(commands.some(line => line === '!include "${UNINSTALL_INCLUDE}"'));
  assert(!commands.some(line => /(?:config\.json|\\logs|\\uploads|\\tls|current-url\.txt)/i.test(line)),
    'private data must not be a direct uninstall deletion target');
  assert(!commands.some(line => /^RMDir\s+\/r\b/i.test(line)));
  assert.match(builder, /Get-ChildItem -LiteralPath \$payload -File -Recurse/,
    'generated deletions must derive from the allowlisted payload, not the live installation');
  assert.match(builder, /RMDir[^\r\n]+\$INSTDIR/);
  assert(!/\$lines\s*\+=\s*["'][^\r\n]*RMDir[^\r\n]*\/r/i.test(builder));
});

function requiredPayloadFiles(source) {
  const match = source.match(/for\s*\(const required of\s*\[([\s\S]*?)\]\)/);
  assert(match, 'stager required-file boundary is required');
  return [...match[1].matchAll(/'([^']+)'/g)].map(value => value[1]);
}
function nativeDependencies() {
  const pending = ['scripts/codex-desktop-driver.js', 'scripts/codex-desktop-relay.js',
    'scripts/dot-desktop-driver.js', 'scripts/dot-desktop-service.js',
    'scripts/dot-desktop-send-driver.js', 'scripts/dot-desktop-journal.js',
    'scripts/dot-desktop-private-store.js', 'scripts/dot-desktop-runtime.js'];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.shift();
    if (visited.has(relative)) continue;
    assert(relative.startsWith('scripts/') && !relative.includes('..'), 'native helper dependency must stay in scripts');
    visited.add(relative);
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      pending.push(path.posix.extname(dependency) ? dependency : dependency + '.js');
    }
    // Both JS helper launches and PS dot-sourcing/readback use these literal
    // basenames. Reading the source does not execute any native helper.
    for (const match of source.matchAll(/(?:path\.join\(__dirname,\s*|Join-Path\s+\$PSScriptRoot\s+)['"]([^'"]+\.(?:js|ps1))['"]/g)) {
      pending.push(path.posix.join(path.posix.dirname(relative), match[1]));
    }
  }
  return visited;
}
const requiredPayload = requiredPayloadFiles(stager);
check('the actual gateway loopback listener is a hard payload requirement before compilation', () => {
  const gateway = fs.readFileSync(path.join(root, 'scripts/mobile-proxy.js'), 'utf8');
  assert.match(gateway, /require\(['"]\.\/gateway-listener\.js['"]\)\.bindGateway/);
  assert(requiredPayload.includes('scripts/gateway-listener.js'),
    'the gateway must never be packaged without its actual loopback listener');
});
check('all current native imports and dot-sourced guards are hard payload requirements and installed hash checks', () => {
  const dependencies = nativeDependencies();
  const installed = builder.match(/foreach\s*\(\$relative\s+in\s+@\(([\s\S]*?)\)\)\s*\{/);
  assert(installed, 'installed-source hash checks are required');
  const checked = new Set([...installed[1].matchAll(/'([^']+)'/g)].map(value => value[1].replace(/\\/g, '/')));
  assert(dependencies.size >= 19, 'guarded native closure unexpectedly lost a dependency');
  for (const relative of dependencies) {
    assert(requiredPayload.includes(relative), `${relative} must be a hard staging requirement`);
    assert(checked.has(relative), `${relative} must be compared with installed source bytes`);
  }
  for (const relative of ['pwa/codex.html', 'pwa/dot.html', 'pwa/e2ee.js']) {
    assert(checked.has(relative), `${relative} must be compared with installed source bytes`);
  }
});
check('real staging rejects each missing new required module and excludes private fixture artifacts', () => {
  const tempBase = path.resolve(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempBase, 'pb-installer-staging-'));
  const sourceRoot = path.join(scratch, 'source');
  const privateFixtureFiles = ['config.json', 'logs/e2ee-secret.txt', 'uploads/private.txt',
    'private/dot-journal-prototype.js', 'private/notify-wechat.js'];
  try {
    for (const relative of requiredPayload) {
      const destination = path.join(sourceRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relative), destination);
    }
    for (const relative of privateFixtureFiles) {
      const destination = path.join(sourceRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, 'isolated private fixture; never a real credential', 'utf8');
    }
    const newRequired = ['scripts/gateway-listener.js', 'scripts/codex-history-transport.js', 'scripts/dot-desktop-protocol.js', 'scripts/dot-desktop-owner.js',
      'scripts/dot-desktop-journal.js', 'scripts/dot-desktop-send-driver.js', 'scripts/dot-desktop-send.ps1',
      'scripts/dot-desktop-source-guard.ps1', 'scripts/dot-desktop-navigation-guard.ps1',
      'scripts/codex-desktop-source-guard.ps1', 'scripts/dot-desktop-private-store.js',
      'scripts/dot-desktop-runtime.js'];
    function stage(label, tracked) {
      const output = path.join(scratch, label);
      vm.runInNewContext(stager, {
        __dirname: path.join(sourceRoot, 'packaging/windows'),
        process: { argv: [process.execPath, 'stage.js', output] },
        console: { log() {} },
        require(name) {
          if (name === 'child_process') return { execFileSync(command, args, options) {
            assert.equal(command, 'git'); assert.deepEqual(Array.from(args), ['ls-files', '-z']);
            assert.equal(options.cwd, sourceRoot);
            return Buffer.from(tracked.join('\0') + '\0');
          } };
          return require(name);
        }
      }, { timeout: 10000 });
      return output;
    }
    const tracked = [...requiredPayload, ...privateFixtureFiles];
    const clean = stage('complete', tracked);
    for (const relative of requiredPayload) {
      assert.equal(fs.readFileSync(path.join(clean, relative)).equals(fs.readFileSync(path.join(sourceRoot, relative))), true);
    }
    for (const relative of privateFixtureFiles) assert.equal(fs.existsSync(path.join(clean, relative)), false);
    for (let index = 0; index < newRequired.length; index++) {
      const absent = newRequired[index];
      // The file exists in the checkout but is untracked, exactly the failure
      // mode observed during review. Staging must refuse that partial payload.
      assert.throws(() => stage('missing-' + index, tracked.filter(value => value !== absent)),
        error => error.message === `Missing required payload file: ${absent}`);
    }
  } finally {
    const resolved = path.resolve(scratch);
    assert(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith('pb-installer-staging-'),
      'cleanup must stay within the explicitly created temporary fixture');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

console.log(`Passed ${passed} Windows installer source contracts; no build/install/runtime acceptance was run.`);
