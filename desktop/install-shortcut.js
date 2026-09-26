// Pocket Bridge — create desktop and Start-menu shortcuts for source installs.
//
// 为什么不用现成的打包工具：那些工具会拖进来一个安装器、写注册表、要求管理员权限。
// 这个项目从头到尾的原则是「不装东西」—— 快捷方式本身就是一个 .lnk 文件，
// 用系统自带的 WScript.Shell 就能建，不需要管理员，也随时可以整个删掉。
//
// 用法:
//   node desktop/install-shortcut.js            装到桌面 + 开始菜单
//   node desktop/install-shortcut.js --remove   全部删掉
//   node desktop/install-shortcut.js --desktop  只装桌面
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DESKTOP_DIR = __dirname;
const NAME = 'Pocket Bridge';
const ICON = path.join(DESKTOP_DIR, 'icons', 'app.ico');
const TRAY = path.join(DESKTOP_DIR, 'tray.ps1');
const OPEN_APP = path.join(DESKTOP_DIR, 'open-desktop-app.js');
const OPEN_VBS = path.join(DESKTOP_DIR, 'open-desktop.vbs');
const NODE = process.execPath;

const REMOVE = process.argv.includes('--remove');
const ONLY_DESKTOP = process.argv.includes('--desktop');

function say(m = '') { console.log(m); }

/** 用 PowerShell 的 WScript.Shell COM 建快捷方式 —— 系统自带，无需额外依赖。 */
function ps(script) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 30000 });
}

function q(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function desktopPath() {
  return path.join(os.homedir(), 'Desktop');
}

function startMenuPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function removeShortcut(dir) {
  const lnk = path.join(dir, `${NAME}.lnk`);
  if (fs.existsSync(lnk)) {
    fs.unlinkSync(lnk);
    return { dir, removed: true };
  }
  return { dir, removed: false };
}

function createShortcut(dir) {
  if (!fs.existsSync(dir)) {
    // 桌面被重定向到别处（OneDrive 之类）时会出现这种情况，如实报告而不是假装成功
    return { dir, ok: false, reason: '目录不存在' };
  }
  if (!fs.existsSync(OPEN_APP) || !fs.existsSync(OPEN_VBS) || !fs.existsSync(NODE)) {
    return { dir, ok: false, reason: '缺少桌面启动组件，请先跑 desktop/build.js' };
  }

  const lnk = path.join(dir, `${NAME}.lnk`);
  // 快捷方式只做一件事：直接打开应用窗口。托盘是后台菜单，不能成为
  // “双击桌面图标却什么都没弹出”的中间步骤。
  const target = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const args = `"${OPEN_VBS}"`;

  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${q(lnk)})`,
    `$sc.TargetPath = ${q(target)}`,
    `$sc.Arguments = ${q(args)}`,
    `$sc.WorkingDirectory = ${q(DESKTOP_DIR)}`,
    `$sc.Description = 'Pocket Bridge — 在手机浏览器使用本机的 DeepSeek Harness 或 Codex'`,
    fs.existsSync(ICON) ? `$sc.IconLocation = ${q(ICON + ',0')}` : '',
    '$sc.WindowStyle = 7',
    '$sc.Save()',
    `if (Test-Path ${q(lnk)}) { Write-Output 'SAVED' } else { Write-Output 'MISSING' }`
  ].filter(Boolean).join('; ');

  try {
    const out = ps(script).trim();
    if (!out.includes('SAVED')) return { dir, ok: false, reason: `保存后文件不存在（输出: ${out}）` };
    const size = fs.statSync(lnk).size;
    return { dir, ok: true, lnk, size };
  } catch (err) {
    const msg = (err.stdout || '') + (err.stderr || '') || err.message;
    return { dir, ok: false, reason: msg.trim().slice(0, 300) };
  }
}

say('\nPocket Bridge — 快捷方式\n' + '='.repeat(56) + '\n');

const targets = ONLY_DESKTOP
  ? [['桌面', desktopPath()]]
  : [['桌面', desktopPath()], ['开始菜单', startMenuPath()]];

let problems = 0;

if (REMOVE) {
  for (const [label, dir] of targets) {
    const r = removeShortcut(dir);
    say(`  ${r.removed ? '✓' : '·'} ${label}: ${r.removed ? '已删除' : '本来就没有'}`);
  }
  say('\n已移除。程序本体没有任何改动 —— 想彻底清干净的话，');
  say('删掉 desktop\\ 和 runtime\\ 目录即可，系统里不留别的东西。\n');
} else {
  if (!fs.existsSync(TRAY)) {
    say('  ✗ 还没构建。先运行: node desktop/build.js');
    process.exitCode = 1;
    return;
  }

  for (const [label, dir] of targets) {
    const r = createShortcut(dir);
    if (r.ok) {
      say(`  ✓ ${label}: ${r.lnk}（${r.size} 字节）`);
    } else {
      problems++;
      say(`  ✗ ${label}: ${r.reason}`);
    }
  }

  say('\n双击桌面或开始菜单的「Pocket Bridge」会直接打开控制台。');
  say('托盘在后台运行时，可用来管理服务和复制链接。');
  say('卸载: node desktop/install-shortcut.js --remove\n');
}

process.exitCode = problems ? 1 : 0;
