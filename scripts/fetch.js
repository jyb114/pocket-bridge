// DSH 移动端网关 — 通用下载器
// 用法（通过 Electron 当 Node 跑）：
//   <Electron.exe> fetch.js <url> <输出路径> [日志json路径]
//
// 为什么不用 PowerShell 的 Invoke-WebRequest / curl：
//   沙箱进程走 Windows schannel，拿不到证书凭证（SEC_E_NO_CREDENTIALS），
//   所有 HTTPS 请求都会失败。Electron 自带 BoringSSL，不受影响。
'use strict';

const fs = require('fs');
const path = require('path');

const [, , url, outPath, logPath] = process.argv;

const log = {
  ranAt: new Date().toISOString(),
  url,
  outPath,
  status: 'attempting'
};

(async () => {
  try {
    if (!url || !outPath) throw new Error('usage: fetch.js <url> <outPath> [logPath]');

    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(600000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);

    log.status = 'ok';
    log.bytes = buf.length;
    // 前两个字节，用来识别真实格式（MZ = exe，PK = zip，1f8b = gzip）
    log.header = buf.subarray(0, 4).toString('hex');
  } catch (err) {
    log.status = 'error';
    log.error = err.message;
  }

  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  }
})();
