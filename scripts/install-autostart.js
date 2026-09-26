// DSH 移动端网关 — 开机/登录自启的安装与卸载（跨平台）
//
// 三个平台的机制完全不同，所以在 Node 里统一封装：
//   Windows  「启动」文件夹放一个指向原安装目录的 .lnk
//   macOS    ~/Library/LaunchAgents 下一个 launchd plist
//   Linux    ~/.config/systemd/user 下一个 systemd user service
//
// 用法：
//   node install-autostart.js install     安装
//   node install-autostart.js uninstall   卸载
//   node install-autostart.js status      查看当前状态
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const DAEMON = path.join(BASE, 'scripts', 'gateway-daemon.js');
const LABEL = 'com.dsh.mobile-gateway';
const TASK_NAME = 'Pocket Bridge';

function log(msg) { process.stdout.write(`${msg}\n`); }

/** 找一个能用的 Node：打包进来的优先。 */
function resolveNode() {
  const runtimeDir = path.join(BASE, 'runtime');
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  try {
    for (const e of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('node-')) continue;
      for (const rel of [path.join(e.name, exeName), path.join(e.name, 'bin', exeName)]) {
        const p = path.join(runtimeDir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (err) { /* 没有 runtime 目录 */ }
  return process.execPath;
}

// ── Windows ───────────────────────────────────────────────────────────────────
function winStartupDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup');
}

function winStartupPath() {
  return path.join(winStartupDir(), `${TASK_NAME}.lnk`);
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function removeOwnedLegacyBat() {
  for (const name of ['DSH Gateway.bat', 'PocketBridge-Gateway.bat']) {
    const file = path.join(winStartupDir(), name);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    if (/gateway-daemon\.js/i.test(body)) fs.unlinkSync(file);
  }
}

function winInstall() {
  const target = winStartupPath();
  const launcher = path.join(BASE, 'desktop', 'launch-tray.vbs');
  const icon = path.join(BASE, 'desktop', 'icons', 'app.ico');
  if (!fs.existsSync(launcher) || !fs.existsSync(icon)) {
    throw new Error('缺少桌面启动器或图标；请先构建桌面客户端');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$shortcut = $ws.CreateShortcut(${psLiteral(target)})`,
    `$shortcut.TargetPath = ${psLiteral(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$shortcut.Arguments = ${psLiteral(`"${launcher}"`)}`,
    `$shortcut.WorkingDirectory = ${psLiteral(path.dirname(launcher))}`,
    `$shortcut.IconLocation = ${psLiteral(`${icon},0`)}`,
    `$shortcut.Description = ${psLiteral('Pocket Bridge — 自动启动网关与托盘')}`,
    '$shortcut.Save()'
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000 });
  if (!fs.existsSync(target)) throw new Error('创建开机自启快捷方式失败');
  removeOwnedLegacyBat();
  return target;
}

function winUninstall() {
  const target = winStartupPath();
  let removed = false;
  try { fs.unlinkSync(target); removed = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  removeOwnedLegacyBat();
  return removed ? target : null;
}

function winStatus() {
  const target = winStartupPath();
  return { mechanism: '启动文件夹', path: target, installed: fs.existsSync(target) };
}

// ── macOS ─────────────────────────────────────────────────────────────────────
function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function macInstall() {
  const p = macPlistPath();
  const node = resolveNode();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${DAEMON}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${path.join(BASE, 'logs', 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(BASE, 'logs', 'launchd.err.log')}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });
  fs.writeFileSync(p, plist, 'utf8');
  try {
    execFileSync('launchctl', ['load', '-w', p], { timeout: 10000 });
  } catch (err) {
    log(`（plist 已写入，但 launchctl load 失败：${err.message}）`);
  }
  return p;
}

function macUninstall() {
  const p = macPlistPath();
  try { execFileSync('launchctl', ['unload', '-w', p], { timeout: 10000 }); } catch (err) { }
  try { fs.unlinkSync(p); return p; } catch (err) { return null; }
}

function macStatus() {
  const p = macPlistPath();
  return { mechanism: 'launchd LaunchAgent', path: p, installed: fs.existsSync(p) };
}

// ── Linux ─────────────────────────────────────────────────────────────────────
function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'pocket-bridge-gateway.service');
}

function linuxInstall() {
  const p = linuxUnitPath();
  const node = resolveNode();
  const unit = `[Unit]
Description=PocketBridge Gateway
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${node} ${DAEMON}
StandardOutput=append:${path.join(BASE, 'logs', 'systemd.out.log')}
StandardError=append:${path.join(BASE, 'logs', 'systemd.err.log')}

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });
  fs.writeFileSync(p, unit, 'utf8');
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 });
    execFileSync('systemctl', ['--user', 'enable', 'pocket-bridge-gateway.service'], { timeout: 10000 });
  } catch (err) {
    log(`（unit 已写入，但 systemctl 配置失败：${err.message}）`);
    log('  可能需要先执行：loginctl enable-linger $USER');
  }
  return p;
}

function linuxUninstall() {
  const p = linuxUnitPath();
  try {
    execFileSync('systemctl', ['--user', 'disable', 'pocket-bridge-gateway.service'], { timeout: 10000 });
  } catch (err) { }
  try { fs.unlinkSync(p); return p; } catch (err) { return null; }
}

function linuxStatus() {
  const p = linuxUnitPath();
  return { mechanism: 'systemd user service', path: p, installed: fs.existsSync(p) };
}

// ── 分发 ──────────────────────────────────────────────────────────────────────
const PLATFORMS = {
  win32: { install: winInstall, uninstall: winUninstall, status: winStatus },
  darwin: { install: macInstall, uninstall: macUninstall, status: macStatus },
  linux: { install: linuxInstall, uninstall: linuxUninstall, status: linuxStatus }
};

function main() {
  const action = (process.argv[2] || 'status').toLowerCase();
  const impl = PLATFORMS[process.platform];

  if (!impl) {
    log(`暂不支持的平台: ${process.platform}`);
    process.exitCode = 1;
    return;
  }

  if (action === 'install') {
    const p = impl.install();
    log(`✓ 已安装自启（${process.platform}）`);
    log(`  位置: ${p}`);
    log('  下次登录时会自动启动网关。现在就启动请运行 start-gateway 脚本。');
  } else if (action === 'uninstall') {
    const p = impl.uninstall();
    log(p ? `✓ 已移除自启: ${p}` : '（本来就没有安装）');
  } else if (action === 'status') {
    const s = impl.status();
    log(`平台   : ${process.platform}`);
    log(`机制   : ${s.mechanism}`);
    log(`位置   : ${s.path}`);
    log(`已安装 : ${s.installed ? '是' : '否'}`);
  } else {
    log('用法: node install-autostart.js [install|uninstall|status]');
    process.exitCode = 1;
  }
}

main();
