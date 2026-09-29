// DSH 移动端网关 — 隧道模块自测
//
// 验证三件事：
//   · 能列出安全启用的 Cloudflare 隧道方案
//   · 只从 Cloudflare 输出提取公网地址，拒绝其他提供方地址
//   · 不可用时给出明确结论而不是静默失败
'use strict';

const fs = require('fs');
const path = require('path');
const tunnel = require('./tunnel.js');

const OUT = path.join(__dirname, '..', 'logs', 'test-tunnel.json');
const out = { ranAt: new Date().toISOString() };

(async () => {
  try {
    // ① 提供方清单
    out.providers = tunnel.listProviders();

    // ② 只接受 Cloudflare 地址；曾支持的 ngrok 地址不能复活
    out.extract = {
      cloudflare: tunnel.extractPublicUrl(
        'INF |  Your quick Tunnel has been created! Visit it at https://tidy-lamp-dances-early.trycloudflare.com  |'
      ),
      ngrokFreeRejected: tunnel.extractPublicUrl('msg="started tunnel" url=https://1a2b-3c4d.ngrok-free.app') === null,
      ngrokIoRejected: tunnel.extractPublicUrl('Forwarding  https://abc123.ngrok.io -> http://localhost:8080') === null,
      nothing: tunnel.extractPublicUrl('this line has no url in it')
    };

    // ③ 未知提供方：应回退到自动选择而不是崩掉
    out.unknownProvider = await tunnel.startTunnel(1, 'definitely-not-a-provider');
    out.unknownProvider.url = out.unknownProvider.url;   // 端口 1 上没人监听，但启动本身应正常

    // ④ 真实启动一次（用真正的中间层端口）
    const port = Number(process.argv[2] || 8080);
    out.realStart = { port };
    const res = await tunnel.startTunnel(port, 'auto');
    out.realStart.provider = res.provider;
    out.realStart.url = res.url;
    out.realStart.attempts = res.attempts;
    out.realStart.succeeded = !!res.url;

    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
    out.stack = String(err.stack).slice(0, 400);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
})();
