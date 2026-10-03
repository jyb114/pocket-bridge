// Source-only Windows install regression: no bundled runtime, no cloudflared,
// and no writes to the real desktop, Start menu, or running gateway.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const vm = require('vm');
const { readWindowsShortcut } = require('./windows-shortcut');

const ROOT = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-source-install-'));
// Always exercise a real Unicode installation path, even when CI's TEMP is
// ASCII. The same path also contains spaces so command quoting is tested.
const source = path.join(scratch, 'source-桥 with spaces');
const desktop = path.join(source, 'desktop');
// Also exercise Unicode in the .lnk file path, not only its saved arguments.
const home = path.join(scratch, "home-桥-\u{1f680}'s with spaces");
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

function run(exe, args, opts = {}) {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 30000, ...opts });
  if (result.error) throw result.error;
  return result;
}

function readUtf16(file) {
  return fs.readFileSync(file).toString('utf16le').replace(/^\ufeff/, '');
}

// Do not decode WScript.Echo's active Windows ANSI code page as UTF-8.
// Keep the probe result in a Unicode file, preserving exact non-ASCII paths.
function unicodeProbeOutput(expression, marker) {
  return 'Dim pbReport\r\n' +
    'Set pbReport = CreateObject("Scripting.FileSystemObject").CreateTextFile(WScript.Arguments(0), True, True)\r\n' +
    'pbReport.WriteLine "' + marker + '=" & ' + expression + '\r\n' +
    'pbReport.Close\r\n';
}

// Inspect the actual saved Unicode COM shortcut. Reading existence alone
// cannot catch broken paths, and WScript.Shell readback also uses ANSI.
function shortcutFields(link) { return readWindowsShortcut(link); }

// Independently parse persisted StringData using Microsoft's shell-link
// format, so sharing the Unicode getter cannot hide a writer/getter mistake.
// https://learn.microsoft.com/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b
function shortcutStringData(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length >= 76 && bytes.readUInt32LE(0) === 76, 'invalid shell-link header');
  const flags = bytes.readUInt32LE(20);
  assert(flags & 0x80, 'shortcut StringData is not Unicode');
  let offset = 76;
  const span = (size) => { assert(offset + size <= bytes.length, 'truncated shell-link data'); };
  if (flags & 1) { span(2); const size = bytes.readUInt16LE(offset); span(size + 2); offset += size + 2; }
  if (flags & 2) { span(4); const size = bytes.readUInt32LE(offset); assert(size >= 28); span(size); offset += size; }
  const result = {};
  for (const [name, bit] of [['Description', 4], ['RelativePath', 8], ['WorkingDirectory', 16], ['Arguments', 32], ['IconPath', 64]]) {
    if (!(flags & bit)) continue;
    span(2); const size = bytes.readUInt16LE(offset) * 2; offset += 2; span(size);
    result[name] = bytes.subarray(offset, offset + size).toString('utf16le'); offset += size;
  }
  return result;
}

function assertShortcutFields(actual, launcher, link, showCommand, description) {
  const expectedTarget = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  assert.strictEqual(actual.TargetPath.toLowerCase(), expectedTarget.toLowerCase(),
    'shortcut does not use the exact hidden WScript launcher');
  assert.strictEqual(actual.Arguments, `"${launcher}"`,
    'shortcut launcher arguments do not preserve the original installation path');
  assert.strictEqual(actual.WorkingDirectory.toLowerCase(), path.dirname(launcher).toLowerCase(),
    'shortcut working directory does not preserve the original installation path');
  assert.strictEqual(actual.IconLocation.toLowerCase(), path.join(path.dirname(launcher), 'icons', 'app.ico').toLowerCase() + ',0',
    'shortcut icon does not preserve the original installation path');
  assert.strictEqual(actual.ShowCommand, showCommand, 'shortcut window style changed');
  assert.strictEqual(actual.Description, description, 'shortcut description changed');
  const persisted = shortcutStringData(link);
  assert.strictEqual(persisted.Arguments, `"${launcher}"`, 'saved shortcut arguments lost Unicode');
  assert.strictEqual(persisted.WorkingDirectory, path.dirname(launcher), 'saved working directory lost Unicode');
  assert.strictEqual(persisted.IconPath, path.join(path.dirname(launcher), 'icons', 'app.ico'), 'saved icon path lost Unicode');
  assert.strictEqual(persisted.Description, actual.Description, 'saved description does not match Unicode COM readback');
}

async function main() {
try {
  // Copy only tracked source files; ignored private keys, logs, runtime and
  // cloudflared never enter this fixture.
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);
  // This explicit public dependency also permits testing before git staging.
  if (!names.includes('scripts/windows-shortcut.js')) names.push('scripts/windows-shortcut.js');
  for (const name of names) {
    const dest = path.join(source, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), dest);
  }
  assert(!fs.existsSync(path.join(source, 'runtime')));
  assert(!fs.existsSync(path.join(source, 'cloudflared')));

  await check('double-click installer resolves desktop/setup.cmd', () => {
    const original = readUtf16(path.join(desktop, '双击安装.vbs'));
    const lines = original.split(/\r?\n/);
    const end = lines.findIndex((line) => /^cmd\s*=/.test(line.trim()));
    assert(end >= 0, 'installer command assignment not found');
    const probe = path.join(desktop, 'probe-installer.vbs');
    const probeOutput = path.join(desktop, 'probe-installer-output.txt');
    fs.writeFileSync(probe, Buffer.from('\ufeff' + lines.slice(0, end + 1).join('\r\n') + '\r\n' + unicodeProbeOutput('cmd', 'PB_CMD'), 'utf16le'));
    const result = run('cscript.exe', ['//nologo', probe, probeOutput]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const actual = readUtf16(probeOutput).match(/PB_CMD=(.+)/)?.[1].trim();
    assert(actual, 'resolved command path missing');
    assert.strictEqual(path.resolve(actual).toLowerCase(), path.join(desktop, 'setup.cmd').toLowerCase());
  });

  await check('setup.cmd resolves repository root', () => {
    const lines = fs.readFileSync(path.join(desktop, 'setup.cmd'), 'ascii').split(/\r?\n/);
    const end = lines.findIndex((line) => /^set "NODE_EXE="/.test(line.trim()));
    assert(end >= 0, 'setup node assignment not found');
    const probe = path.join(desktop, 'probe-setup.cmd');
    fs.writeFileSync(probe, lines.slice(0, end).join('\r\n') + '\r\necho PB_BASE=%BASE%\r\nexit /b 0\r\n', 'ascii');
    // cmd's internal echo uses the OEM code page by default. /u writes its
    // redirected output as UTF-16LE, preserving the actual Unicode BASE value.
    const result = run('cmd.exe', ['/d', '/u', '/c', probe], { cwd: scratch, encoding: 'utf16le' });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const actual = result.stdout.match(/PB_BASE=(.+)/)?.[1].trim();
    assert(actual, 'resolved base path missing');
    assert.strictEqual(path.resolve(actual).toLowerCase(), source.toLowerCase());
  });

  await check('tray resolves system Node when runtime is absent', () => {
    const original = fs.readFileSync(path.join(desktop, 'tray.ps1'), 'utf8');
    const start = original.indexOf('$DesktopDir =');
    const end = original.indexOf('# ── 单实例', start);
    assert(start >= 0 && end > start, 'tray runtime lookup block not found');
    const probe = path.join(desktop, 'probe-tray.ps1');
    const script = '$ErrorActionPreference = \'Stop\'\r\n' + original.slice(start, end) + '\r\nWrite-Output "PB_NODE=$NodeExe"\r\n';
    fs.writeFileSync(probe, Buffer.from('\ufeff' + script, 'utf8'));
    // The source fixture deliberately has no bundled runtime. Supply the
    // current Node as the simulated system installation even on machines
    // where Node is not in the normal PATH (for example, package builders).
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
    env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { env });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const actual = result.stdout.match(/PB_NODE=(.+)/)?.[1].trim();
    assert(actual, 'resolved Node path missing');
    assert.strictEqual(path.resolve(actual).toLowerCase(), path.resolve(process.execPath).toLowerCase(),
      `tray did not resolve the simulated system Node: ${actual}`);
  });

  await check('tracked VBS launchers contain no machine-specific paths', () => {
    for (const name of ['launch-tray.vbs', 'open-desktop.vbs']) {
      const contents = readUtf16(path.join(desktop, name));
      assert(!/[a-z]:\\/i.test(contents), `${name} contains a machine-specific path`);
    }
  });

  await check('build succeeds with system Node only', () => {
    const result = run(process.execPath, [path.join(desktop, 'build.js')], { cwd: source });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    for (const name of ['launch-tray.vbs', 'open-desktop.vbs']) {
      const launcher = readUtf16(path.join(desktop, name));
      assert(!/[a-z]:\\/i.test(launcher), `${name} build output contains a machine-specific path`);
      assert(launcher.includes('WScript.ScriptFullName'), `${name} does not resolve relative to itself`);
    }
  });

  await check('portable VBS launchers resolve commands without launching them', () => {
    for (const [name, target] of [
      ['launch-tray.vbs', 'tray.ps1'],
      ['open-desktop.vbs', 'open-desktop-app.js']
    ]) {
      const lines = readUtf16(path.join(desktop, name)).split(/\r?\n/);
      const index = lines.findIndex((line) => /^s\.Run\s/.test(line.trim()));
      assert(index >= 0, `${name} has no run command`);
      const expression = lines[index].match(/^s\.Run\s+(.+),\s*0,\s*False$/)?.[1];
      assert(expression, `${name} run command is not in the expected form`);
      lines[index] = unicodeProbeOutput(expression, 'PB_COMMAND');
      const probe = path.join(desktop, `probe-${name}`);
      const probeOutput = path.join(desktop, `probe-${name}.txt`);
      fs.writeFileSync(probe, Buffer.from('\ufeff' + lines.join('\r\n'), 'utf16le'));
      const result = run('cscript.exe', ['//nologo', probe, probeOutput]);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      const command = readUtf16(probeOutput).match(/PB_COMMAND=(.+)/)?.[1].trim();
      assert(command, `${name} did not resolve a command`);
      assert(command.toLowerCase().includes(path.join(desktop, target).toLowerCase()), `${name} command targets the wrong file`);
      if (name === 'open-desktop.vbs') assert(command.toLowerCase().includes('node.exe'), 'app command cannot locate Node');
    }
  });

  await check('shortcut installs only into an isolated desktop', () => {
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
    const resolvedHome = run(process.execPath, ['-p', 'require("os").homedir()'], { env }).stdout.trim();
    assert.strictEqual(path.resolve(resolvedHome).toLowerCase(), home.toLowerCase(), 'USERPROFILE isolation is ineffective');
    const result = run(process.execPath, [path.join(desktop, 'install-shortcut.js'), '--desktop'], { cwd: source, env });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const link = path.join(home, 'Desktop', 'Pocket Bridge.lnk');
    assert(fs.existsSync(link), 'isolated desktop shortcut missing');
    assertShortcutFields(shortcutFields(link), path.join(desktop, 'open-desktop.vbs'), link, 7,
      'Pocket Bridge — 在手机浏览器使用本机的 DeepSeek Harness 或 Codex');
  });

  await check('autostart shortcut points to the original launcher, not a copied batch file', () => {
    const startup = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows',
      'Start Menu', 'Programs', 'Startup');
    const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
    const script = path.join(source, 'scripts', 'install-autostart.js');
    const installed = run(process.execPath, [script, 'install'], { cwd: source, env });
    assert.strictEqual(installed.status, 0, installed.stdout + installed.stderr);
    const link = path.join(startup, 'Pocket Bridge.lnk');
    assert(fs.existsSync(link), 'isolated autostart shortcut missing');
    assertShortcutFields(shortcutFields(link), path.join(desktop, 'launch-tray.vbs'), link, 1,
      'Pocket Bridge — 自动启动网关与托盘');
    const removed = run(process.execPath, [script, 'uninstall'], { cwd: source, env });
    assert.strictEqual(removed.status, 0, removed.stdout + removed.stderr);
    assert(!fs.existsSync(link), 'isolated autostart shortcut survived uninstall');
  });

  await check('desktop and autostart preserve paths outside the Windows ANSI code page', () => {
    // Supplementary Unicode is outside legacy ANSI code pages even on a
    // Chinese development machine, reproducing English CI's loss of "桥".
    const unicodeSource = path.join(scratch, "shortcut-桥-\u{1f600}'s with spaces");
    for (const name of ['scripts/install-autostart.js', 'scripts/windows-shortcut.js', 'desktop/install-shortcut.js',
      'desktop/launch-tray.vbs', 'desktop/open-desktop.vbs', 'desktop/open-desktop-app.js',
      'desktop/tray.ps1', 'desktop/icons/app.ico']) {
      const dest = path.join(unicodeSource, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(source, name), dest);
    }
    const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
    const unicodeDesktop = path.join(unicodeSource, 'desktop');
    const desktopLink = path.join(home, 'Desktop', 'Pocket Bridge.lnk');
    const installedDesktop = run(process.execPath, [path.join(unicodeDesktop, 'install-shortcut.js'), '--desktop'],
      { cwd: unicodeSource, env });
    assert.strictEqual(installedDesktop.status, 0, installedDesktop.stdout + installedDesktop.stderr);
    assertShortcutFields(shortcutFields(desktopLink), path.join(unicodeDesktop, 'open-desktop.vbs'), desktopLink, 7,
      'Pocket Bridge — 在手机浏览器使用本机的 DeepSeek Harness 或 Codex');
    const script = path.join(unicodeSource, 'scripts', 'install-autostart.js');
    const installedAuto = run(process.execPath, [script, 'install'], { cwd: unicodeSource, env });
    assert.strictEqual(installedAuto.status, 0, installedAuto.stdout + installedAuto.stderr);
    const autoLink = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows',
      'Start Menu', 'Programs', 'Startup', 'Pocket Bridge.lnk');
    assertShortcutFields(shortcutFields(autoLink), path.join(unicodeDesktop, 'launch-tray.vbs'), autoLink, 1,
      'Pocket Bridge — 自动启动网关与托盘');
    const removedAuto = run(process.execPath, [script, 'uninstall'], { cwd: unicodeSource, env });
    assert.strictEqual(removedAuto.status, 0, removedAuto.stdout + removedAuto.stderr);
    assert(!fs.existsSync(autoLink), 'Unicode autostart shortcut survived uninstall');
    const removedDesktop = run(process.execPath, [path.join(unicodeDesktop, 'install-shortcut.js'), '--desktop', '--remove'],
      { cwd: unicodeSource, env });
    assert.strictEqual(removedDesktop.status, 0, removedDesktop.stdout + removedDesktop.stderr);
    assert(!fs.existsSync(desktopLink), 'Unicode desktop shortcut survived uninstall');
  });

  await check('desktop launcher spawns the available Node executable for its verified own gateway', async () => {
    const code = fs.readFileSync(path.join(desktop, 'open-desktop-app.js'), 'utf8');
    const spawned = [];
    const instanceId = '86a537d0-7a4d-4a80-bf3f-0a1beac46ccb';
    const bootId = 'b31352cb-076c-430d-979b-7fd5a4e78418';
    const logDir = path.join(source, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'instance.json'), JSON.stringify({ instanceId }));
    fs.writeFileSync(path.join(logDir, 'gateway-port.txt'), '19269');
    const fakeHttp = {
      get(_options, callback) {
        const request = new EventEmitter();
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          callback(response);
          response.emit('data', Buffer.from(JSON.stringify({ service: 'pocket-bridge-gateway', instanceId, bootId, pid: 73, port: 19269 })));
          response.emit('end');
        });
        return request;
      }
    };
    const fakeSpawn = (exe) => {
      spawned.push(exe); const child = new EventEmitter(); child.unref = () => {};
      process.nextTick(() => child.emit('spawn')); return child;
    };
    const sandbox = {
      require(name) {
        if (name === 'http') return fakeHttp;
        if (name === 'child_process') return { spawn: fakeSpawn };
        return require(name);
      },
      module: { exports: {} },
      __dirname: desktop,
      process: { execPath: process.execPath, exitCode: 0 },
      setTimeout,
      clearTimeout,
      Buffer,
      console
    };
    try {
      vm.runInNewContext(code, sandbox, { filename: 'open-desktop-app.js' });
      await sandbox.module.exports.createDesktopLauncher().open();
      assert.strictEqual(spawned.length, 1, 'application launch not attempted');
      assert.strictEqual(spawned[0].toLowerCase(), process.execPath.toLowerCase());
    } finally {
      fs.unlinkSync(path.join(logDir, 'instance.json'));
      fs.unlinkSync(path.join(logDir, 'gateway-port.txt'));
    }
  });

  async function checkSetupFailure(stage) {
    const isolated = path.join(scratch, `failure-${stage}`);
    fs.cpSync(source, isolated, { recursive: true });
    const isolatedDesktop = path.join(isolated, 'desktop');
    const marker = path.join(isolated, 'unexpected-gateway-start.txt');
    fs.writeFileSync(path.join(isolatedDesktop, 'build.js'), stage === 'build' ? 'process.exit(7);\n' : 'process.exit(0);\n');
    fs.writeFileSync(path.join(isolatedDesktop, 'install-shortcut.js'), stage === 'shortcut' ? 'process.exit(7);\n' : 'process.exit(0);\n');
    fs.writeFileSync(path.join(isolated, 'scripts', 'gateway-daemon.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
    const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
    const result = spawnSync('cmd.exe', ['/d', '/c', path.join(isolatedDesktop, 'setup.cmd')], {
      cwd: scratch, env, input: '\r\n\r\n', encoding: 'utf8', timeout: 7000
    });
    assert(!fs.existsSync(marker), `${stage} failure still started the gateway`);
    assert(!result.stdout.includes('[3/4] Starting the service'), `${stage} failure continued to service startup`);
    assert(!result.error, result.error?.message);
    assert.notStrictEqual(result.status, 0, `${stage} failure returned success`);
  }

  await check('setup stops before service on build failure', () => checkSetupFailure('build'));
  await check('setup stops before service on shortcut failure', () => checkSetupFailure('shortcut'));
} finally {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const target = path.resolve(scratch);
  if (target.startsWith(tempRoot) && path.basename(target).startsWith('pb-source-install-')) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

process.exitCode = failures ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
