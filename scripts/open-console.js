// DSH 移动端网关 — 打开电脑端控制台
//
// 做三件事：确保服务在跑 → 找到中间层端口 → 打开浏览器指向控制台。
// 三个平台共用这一份实现。
//
// 用法：node open-console.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const cfg = require('./config.js');

const BASE = cfg.BASE;
const LOG_DIR = cfg.LOG_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__health', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve(j && j.service === 'pocket-bridge-gateway' ? j : null);
        } catch (err) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findGateway() {
  for (let p = 8080; p <= 8099; p++) {
    const info = await probeHealth(p);
    if (info) return { port: p, info };
  }
  return null;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // start 是 cmd 内建命令；第一个空参数是窗口标题占位
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return true;
  } catch (err) {
    return false;
  }
}

(async () => {
  let gw = await findGateway();

  if (!gw) {
    process.stdout.write('服务没在运行，正在启动...\n');
    const daemon = path.join(BASE, 'scripts', 'gateway-daemon.js');
    const child = spawn(process.execPath, [daemon], { detached: true, stdio: 'ignore', cwd: BASE });
    child.unref();

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      gw = await findGateway();
      if (gw) break;
    }
  }

  if (!gw) {
    process.stdout.write('服务起不来，请看 logs/daemon.log\n');
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${gw.port}/console`;
  process.stdout.write(`控制台: ${url}\n`);

  if (openBrowser(url)) {
    process.stdout.write('已请求浏览器打开。如果没自动弹出，手动把这个地址粘到浏览器即可。\n');
  } else {
    process.stdout.write('没能自动打开浏览器，请手动访问上面的地址。\n');
  }
})();
