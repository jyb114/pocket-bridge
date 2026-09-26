// 桌面快捷方式的直达入口：确保网关在跑，然后直接开应用窗口。
// 它不依赖托盘脚本的状态，因此双击图标不会出现“只看见右下角图标”的体验。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const NODE = process.execPath;
const DAEMON = path.join(BASE, 'scripts', 'gateway-daemon.js');
const APP = path.join(__dirname, 'open-console-app.js');
const STOP_FLAG = path.join(BASE, 'logs', 'user-stopped.flag');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__health', timeout: 900 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const status = JSON.parse(body);
          resolve(status && status.service === 'pocket-bridge-gateway' ? port : 0);
        } catch (err) { resolve(0); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

async function findGateway() {
  for (let port = 8080; port <= 8099; port++) {
    const found = await health(port);
    if (found) return found;
  }
  return 0;
}

// Clicking the desktop icon is an explicit request to start and open Pocket Bridge.
// The tray's “stop service” flag is for background/automatic starts only;
// carrying it into this deliberate launch made the shortcut appear broken.
function resumeForExplicitLaunch() {
  try { fs.unlinkSync(STOP_FLAG); } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

(async () => {
  let port = await findGateway();
  if (!port) {
    resumeForExplicitLaunch();
    const child = spawn(NODE, [DAEMON], { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 30 && !port; i++) { await sleep(1000); port = await findGateway(); }
  }
  if (!port) process.exitCode = 1;
  else {
    const child = spawn(NODE, [APP, String(port), 'console'], { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
})();
