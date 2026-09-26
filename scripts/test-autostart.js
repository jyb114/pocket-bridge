// DSH 移动端网关 — 验证「DSH 没在运行时自动拉起」这条路径
'use strict';

const fs = require('fs');

const [, , baseUrl, cookieFile, logFile] = process.argv;

// 这不是一个能独立跑的检查 —— 地址、cookie 文件、输出文件都从 argv 传进来，
// 由 test-autostart-e2e.js 调用。少了参数就直接说清楚，
// 不要让它走到 writeFileSync(undefined) 上抛一个看起来像代码坏了的栈。
if (!baseUrl || !cookieFile || !logFile) {
  console.log('这个脚本由 test-autostart-e2e.js 调用，需要三个参数：');
  console.log('  node scripts/test-autostart.js <baseUrl> <cookieFile> <outFile>');
  process.exit(2); // 2 = 用法不对，和「检查失败」(1) 区分开
}

(async () => {
  const out = { ranAt: new Date().toISOString(), baseUrl };

  let cookie = '';
  try {
    cookie = fs.readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (err) {
    out.cookieError = err.message;
  }

  try {
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      signal: AbortSignal.timeout(20000)
    });
    const html = await res.text();
    out.status = res.status;
    out.gotStartingPage = html.includes('正在启动 DSH');
    out.hasAutoRefresh = /http-equiv="refresh"/i.test(html);
    out.bytes = html.length;
    out.preview = html.slice(0, 240);
  } catch (err) {
    out.error = err.message;
  }

  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
