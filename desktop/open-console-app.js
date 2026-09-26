// DSH 移动端网关 — 用「应用窗口」打开本地控制台
//
// 为什么要借浏览器而不是自己写窗口：
//   控制台的界面是 HTML（pwa/console.html），自己写窗口等于要拖一个浏览器内核进来。
//   而 Windows 上一定有 Edge，Chrome 也常见 —— 用它们的 --app 模式打开，
//   出来的窗口没有地址栏、没有标签页、没有菜单，看着和原生程序一样，
//   代价是零。找不到浏览器时退回默认浏览器，功能不减，只是多个地址栏。
//
// 用法: node desktop/open-console-app.js <端口> [console|go|workbench]
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.argv[2] || 8080);
const target = process.argv[3] || 'console';

const PATHS = {
  console: '/console',
  go: '/go',
  workbench: '/'
};

const p = PATHS[target] || PATHS.console;
const url = `http://127.0.0.1:${port}${p}`;

/** 常见浏览器位置。顺序即偏好：Edge 在 Windows 上必然存在，所以排前面。 */
function candidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';

  const list = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  // 也可以手动指定
  if (process.env.DSH_GW_BROWSER) list.unshift(process.env.DSH_GW_BROWSER);
  return list;
}

function findBrowser() {
  for (const c of candidates()) {
    try { if (fs.existsSync(c)) return c; } catch (err) { }
  }
  return null;
}

/**
 * 每次开一个独立的用户数据目录，好处有两个：
 *   - 不受你日常浏览器的扩展、缓存、登录态影响
 *   - 这个窗口不会污染你的浏览器配置
 * 代价是那个目录会一直存在（几十兆）。放在 logs 下，随日志一起清理。
 */
function profileDir() {
  const d = path.join(path.resolve(__dirname, '..'), 'logs', 'app-window-profile');
  try { fs.mkdirSync(d, { recursive: true }); } catch (err) { }
  return d;
}

function openWithDefault(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
    console.log(`已用系统默认浏览器打开: ${url}`);
  } catch (err) {
    console.error(`打不开浏览器: ${err.message}`);
    console.error(`请手动访问: ${url}`);
    process.exitCode = 1;
  }
}

const browser = findBrowser();
if (!browser) {
  openWithDefault(url);
  process.exit(0);
}

const args = [
  `--app=${url}`,
  `--user-data-dir=${profileDir()}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,msEdgeSidebar,msEdgeShoppingAssistant',
  // 控制台是固定的本地页面，开大一点好读，位置给个不挡事的默认值
  '--window-size=580,820',
  '--window-position=80,60'
];

try {
  const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  console.log(`已作为应用窗口打开: ${url}`);
  console.log(`浏览器: ${browser}`);
} catch (err) {
  console.error(`启动应用窗口失败（${err.message}），改用默认浏览器`);
  openWithDefault(url);
}
