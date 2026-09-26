// DSH 移动端网关 — 桌面客户端构建
//
// 这个脚本做四件事，每件都对应一个踩过的坑：
//
//   1. 生成图标（.ico 无法用代码以外的方式可靠产出，且要按状态换色）
//   2. 给 .ps1 补 UTF-8 BOM —— Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，
//      中文会变成乱码，而且是那种「看起来只是显示问题、实际语法都错了」的乱码
//   3. 生成启动用的 .vbs（Unicode 编码）—— .bat 里的中文路径在 OEM 码页下会烂掉
//   4. 校验：.bat 必须是纯 ASCII + CRLF；.ps1 交给 PowerShell 自己的解析器验语法
//
// 用法: node desktop/build.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DESKTOP = __dirname;
const BASE = path.resolve(DESKTOP, '..');

let failures = 0;
function step(name) { console.log(`\n[${name}]`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { failures++; console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }

// ── 1. 图标 ───────────────────────────────────────────────────────────────────
step('生成图标');
try {
  const out = execFileSync(process.execPath, [path.join(DESKTOP, 'make-icons.js')],
    { encoding: 'utf8' });
  const last = out.trim().split('\n').slice(-4).join(' | ');
  ok(last);
} catch (err) {
  bad(`图标生成失败: ${err.message}`);
}

// ── 2. 给 PowerShell 脚本补 BOM ───────────────────────────────────────────────
step('PowerShell 脚本编码');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
for (const f of fs.readdirSync(DESKTOP).filter((x) => x.endsWith('.ps1'))) {
  const p = path.join(DESKTOP, f);
  const buf = fs.readFileSync(p);
  if (buf.slice(0, 3).equals(BOM)) {
    ok(`${f} 已有 UTF-8 BOM`);
  } else {
    fs.writeFileSync(p, Buffer.concat([BOM, buf]));
    ok(`${f} 已补上 UTF-8 BOM（否则中文会乱码）`);
  }
  // 顺便确认里面确实有非 ASCII 字符 —— 没有的话这个检查是多余的
  const txt = fs.readFileSync(p, 'utf8');
  info(`含中文: ${/[^\x00-\x7F]/.test(txt) ? '是' : '否'}　行数: ${txt.split('\n').length}`);
}

// ── 3. 启动器 ─────────────────────────────────────────────────────────────────

/** 优先用项目自带的 Node；源码安装时使用运行本构建脚本的 Node。 */
function findNode() {
  const direct = path.join(BASE, 'runtime', 'node-v24.18.1-win-x64', 'node.exe');
  if (fs.existsSync(direct)) return direct;
  const runtime = path.join(BASE, 'runtime');
  if (fs.existsSync(runtime)) {
    for (const d of fs.readdirSync(runtime)) {
      const p = path.join(runtime, d, 'node.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return fs.existsSync(process.execPath) ? process.execPath : null;
}

const nodeExe = findNode();
step('生成启动器');
if (!nodeExe) {
  bad('找不到可用的 node.exe，启动器无法生成');
} else {
  info(`node: ${nodeExe}`);

  // .vbs 用 Unicode（UTF-16LE）写：路径里有中文，ASCII 会把它们写成问号，
  // 结果就是「明明文件在，脚本说找不到」。
  const vbs = [
    "' DSH 移动端网关 — 静默启动托盘客户端",
    "' 由 desktop/build.js 生成，不要手改（改了会被覆盖）",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set s = CreateObject("WScript.Shell")',
    'desktopDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    's.CurrentDirectory = desktopDir',
    's.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File " & Chr(34) & fso.BuildPath(desktopDir, "tray.ps1") & Chr(34), 0, False'
  ].join('\r\n');
  const vbsPath = path.join(DESKTOP, 'launch-tray.vbs');
  fs.writeFileSync(vbsPath, Buffer.from('\ufeff' + vbs, 'utf16le'));
  ok(`launch-tray.vbs（Unicode）${fs.statSync(vbsPath).size} 字节`);

  // 直达控制台也必须经由 wscript.exe 启动。若快捷方式直接指向 node.exe，
  // Windows 会先弹出一个黑色命令行窗口，即使 node 随后又启动了浏览器应用。
  const appVbs = [
    "' DSH 移动端网关 — 静默打开控制台",
    "' 由 desktop/build.js 生成，不要手改（改了会被覆盖）",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set s = CreateObject("WScript.Shell")',
    'desktopDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'baseDir = fso.GetParentFolderName(desktopDir)',
    's.CurrentDirectory = baseDir',
    'nodeExe = "node.exe"',
    'runtimeDir = fso.BuildPath(baseDir, "runtime")',
    'If fso.FolderExists(runtimeDir) Then',
    '  For Each folder In fso.GetFolder(runtimeDir).SubFolders',
    '    candidate = fso.BuildPath(folder.Path, "node.exe")',
    '    If fso.FileExists(candidate) Then',
    '      nodeExe = candidate',
    '      Exit For',
    '    End If',
    '  Next',
    'End If',
    'appJs = fso.BuildPath(desktopDir, "open-desktop-app.js")',
    's.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & appJs & Chr(34), 0, False'
  ].join('\r\n');
  const appVbsPath = path.join(DESKTOP, 'open-desktop.vbs');
  fs.writeFileSync(appVbsPath, Buffer.from('\ufeff' + appVbs, 'utf16le'));
  ok(`open-desktop.vbs（Unicode）${fs.statSync(appVbsPath).size} 字节`);

  // 双击入口。cmd.exe 按 OEM 码页读 .bat，所以这里必须是纯 ASCII + CRLF。
  const bat = [
    '@echo off',
    'rem PocketBridge Gateway - desktop client',
    'rem ASCII only, CRLF only: cmd.exe reads this file in the OEM code page.',
    'setlocal',
    'set "HERE=%~dp0"',
    'start "" wscript.exe "%HERE%launch-tray.vbs"',
    'exit /b 0',
    ''
  ].join('\r\n');
  const batPath = path.join(DESKTOP, 'dsh-gateway.bat');
  fs.writeFileSync(batPath, Buffer.from(bat, 'ascii'));
  ok(`dsh-gateway.bat（ASCII + CRLF）${fs.statSync(batPath).size} 字节`);
}

// ── 4. 校验 ───────────────────────────────────────────────────────────────────
step('校验');

// 4a. .bat 必须是纯 ASCII、纯 CRLF —— 这两条都真实踩过
for (const f of fs.readdirSync(DESKTOP).filter((x) => x.endsWith('.bat'))) {
  const p = path.join(DESKTOP, f);
  const buf = fs.readFileSync(p);
  const nonAscii = buf.filter((b) => b > 0x7f).length;
  const lf = buf.filter((b) => b === 0x0a).length;
  const crlf = buf.toString('latin1').split('\r\n').length - 1;
  if (nonAscii) bad(`${f} 含 ${nonAscii} 个非 ASCII 字节（cmd.exe 会解析错）`);
  else if (lf !== crlf) bad(`${f} 有 ${lf - crlf} 个裸 LF（应为 CRLF）`);
  else ok(`${f} 纯 ASCII + 全部 CRLF`);
}

// 4b. 用 PowerShell 自己的解析器验语法 —— 比肉眼可靠
const ps1 = path.join(DESKTOP, 'tray.ps1');
if (fs.existsSync(ps1)) {
  const script = `
    $errors = $null
    $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
      $errors | ForEach-Object { Write-Output ("LINE " + $_.Extent.StartLineNumber + ": " + $_.Message) }
      exit 1
    }
    Write-Output ("OK tokens=" + $tokens.Count)
  `;
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 60000 });
    const line = out.trim();
    if (line.includes('OK')) ok(`tray.ps1 语法正确（${line}）`);
    else bad(`tray.ps1 语法错误:\n${line}`);
  } catch (err) {
    const msg = (err.stdout || '') + (err.stderr || '') || err.message;
    bad(`tray.ps1 语法检查未通过:\n${msg}`);
  }
}

// 4c. 需要的支撑文件都在
for (const f of ['open-console-app.js', 'open-desktop-app.js', 'open-desktop.vbs', 'make-icons.js']) {
  if (fs.existsSync(path.join(DESKTOP, f))) ok(`${f} 存在`);
  else bad(`${f} 缺失`);
}
for (const f of ['green.ico', 'amber.ico', 'red.ico', 'grey.ico', 'app.ico']) {
  if (fs.existsSync(path.join(DESKTOP, 'icons', f))) ok(`icons/${f} 存在`);
  else bad(`icons/${f} 缺失`);
}

console.log(`\n${failures ? `构建有 ${failures} 处问题` : '构建完成，全部通过'}\n`);
process.exitCode = failures ? 1 : 0;
