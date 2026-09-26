// 隧道端能看到构成网页的所有代码吗？—— 实测。
//
// 答案是**能，而且是完整的明文**。原因是链路分段：
//
//     手机  ──HTTPS──>  Cloudflare  ──HTTP(明文!)──>  你的电脑
//                        ↑
//                   TLS 在这里就结束了
//
// Cloudflare 是 TLS 终点：它跟手机之间是加密的，跟你电脑之间是**明文**的。
// 所以网页、脚本、接口返回，在它那里全都是可读的原文 —— 它必须能读，
// 因为它要重新加密了再发给手机。
//
// 这个脚本把「它实际转发的那串字节」按原样抓下来，看看到底能看到什么。
//
// 用法: node scripts/explain-tunnel-sees.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim()) || 8080;
const TUNNEL = fs.readFileSync(path.join(BASE, 'logs', 'last-tunnel-url.txt'), 'utf8').trim();
const TUNNEL_HOST = new URL(TUNNEL).host;

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(74)); if (t) line(t); line('─'.repeat(74)); };

/**
 * 按 cloudflared 的方式取一次。
 *
 * ★ 用隧道域名当 Host、连本机 8080 —— 这拿到的就是 cloudflared 收到的那串字节，
 *   一模一样。Cloudflare 做的事就是把它重新加密后发给手机，中间不改一个字节
 *   （除非它想改 —— 那正是上一个脚本演示的事）。
 */
function fetchAsTunnel(pathname, cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname,
      headers: Object.assign({ host: TUNNEL_HOST, 'user-agent': 'tunnel-view' },
        cookie ? { cookie } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', (e) => resolve({ status: 0, type: '', body: Buffer.from(e.message) }));
    req.end();
  });
}

(async () => {
  hr('链路长什么样');
  line(`  手机 ──HTTPS(加密)──> Cloudflare ──HTTP(明文)──> 127.0.0.1:${PORT}`);
  line(`  隧道域名: ${TUNNEL_HOST}`);
  line('');
  line('  cloudflared 自己记的源站地址（这是最直接的证据）：');
  const clog = path.join(BASE, 'logs', 'cloudflared.err.log');
  try {
    const m = fs.readFileSync(clog, 'utf8').match(/originService=(http:\/\/\S+)/);
    if (m) line(`    originService=${m[1]}    ← 明文的 http，不是 https`);
  } catch (err) { /* 没有就算了 */ }
  line('');
  line('  为什么必须是明文：Cloudflare 要**重新加密**了发给手机，');
  line('  它手上必须是可读的原文。加密到手机那一段，和它读不读得到，是两件事。');

  // ──────────────────────────────────────────────────────────────────────
  hr('它实际转发的字节 —— 网页的「代码」部分');

  // 先登录一次，好拿一台设备的 cookie（和手机拿到的那份是同一套机制）
  const login = await fetchAsTunnel('/k/' + fs.readFileSync(
    path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim());
  const cookie = (login.status === 302 || login.status === 200) ? '' : '';

  const files = [
    ['/', '工作台页面（DSH 本体）', true],
    ['/e2ee.js', '端到端加密的实现', false],
    ['/route.js', '路径角标 / 断线自救', false],
    ['/polyfill.js', '老浏览器兼容层', false],
    ['/boot.js', '启动引导', false],
    ['/custom.css', '界面样式', false]
  ];

  let total = 0;
  const rows = [];
  for (const [p, label] of files) {
    const r = await fetchAsTunnel(p);
    const ok = r.status === 200;
    if (ok) total += r.body.length;
    rows.push({ p, label, status: r.status, type: r.type, size: r.body.length, body: r.body });
    line(`  ${String(r.status).padEnd(4)} ${String(r.body.length).padStart(8)} 字节  ${p.padEnd(14)} ${label}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  hr('readable 到什么程度？直接在里面搜敏感代码');

  const probes = [
    ['location.hash', '读取地址栏里密钥的那一行'],
    ['#k=', '密钥参数的写法'],
    ['e2ee', '加密相关的标识'],
    ['__dshE2ee', '加密补丁挂的内部标记']
  ];
  for (const [needle, why] of probes) {
    const hits = rows.filter((r) => r.status === 200 && r.body.includes(needle));
    line(`  「${needle}」出现在 ${hits.length} 个文件里   —— ${why}`);
    for (const h of hits) line(`      ${h.p}（${h.size} 字节）`);
  }

  // 把那一行原样打出来
  const e2ee = rows.find((r) => r.p === '/e2ee.js');
  if (e2ee && e2ee.status === 200) {
    const txt = e2ee.body.toString('utf8');
    const idx = txt.indexOf('location.hash');
    if (idx >= 0) {
      line('');
      line('  在 /e2ee.js 里，处理密钥的那段原文（隧道看到的就是这个）：');
      const around = txt.slice(Math.max(0, idx - 220), idx + 220);
      for (const l of around.split('\n')) line('      ' + l.trimEnd());
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  hr('结论：隧道能看到的 / 看不到的');

  line(`  能看到（全部明文，合计 ${total.toLocaleString()} 字节的代码与页面）：`);
  line('    · 工作台页面本身的 HTML');
  line('    · 每一个 .js / .css 文件（包括端到端加密的实现）');
  line('    · 所有接口返回的 JSON（余额、会话列表、设备列表…）');
  line('    · 请求头、Cookie、以及**网址路径里的访问密钥**');
  line('');
  line('  看不到：');
  line('    · 地址里 # 之后的内容 —— 浏览器根本不发出去（上一节实测过）');
  line('    · WebSocket 和文件传输里被端到端加密过的载荷');
  line('');
  line('  ★ 但注意这两条的关系：');
  line('    「# 看不到」是真的，可**读取 # 的那段代码它看得一清二楚**。');
  line('    而且那段代码是它转发给手机的 —— 转发的时候顺手改一行，');
  line('    就读得到了（上一个脚本的实验二演示的就是这个）。');
  line('');
  line('  一句话总结：');
  line('    内容加密解决的是「中途被抄走」。');
  line('    但构成页面的**代码**必然经过它，而代码决定了一切。');
  line('');
})();
