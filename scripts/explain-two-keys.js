// 两把钥匙分别是干什么的 —— 实测。
//
// 使用者的疑问（很合理）：
//   「它是有网址，但是没有后面的密钥，登录不进去啊。我试过了。」
//
// 混淆点在这里：链接里其实有**两串秘密**，作用完全不同 ——
//
//   https://域名 /k/<访问密钥>  #k=<加密密钥>
//                └─ ① 决定能不能进 ─┘  └─ ② 决定进来后看不看得懂 ─┘
//
// 这个脚本把四种组合都试一遍，看服务端到底认哪一串。
//
// 用法: node scripts/explain-two-keys.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim()) || 8080;
const TUNNEL = fs.readFileSync(path.join(BASE, 'logs', 'last-tunnel-url.txt'), 'utf8').trim();
const HOST = new URL(TUNNEL).host;
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const E2EE = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(74)); if (t) line(t); line('─'.repeat(74)); };

/**
 * 发一次请求，并把「浏览器实际发出的请求行」原样带回来。
 *
 * ★ 这里必须自己切掉 # 之后的内容 —— 因为**浏览器就是这么做的**。
 *   Node 的 http.request 是手工构造请求的，你不切它就照原样发出去，
 *   而浏览器不会。第一版没切，结果第二条的请求行里带着 #k=…，
 *   把要证明的事情搞反了（看起来像"服务器收到了 # 后面的东西"）。
 *   模拟一个协议行为，就得先把它模拟对。
 */
function call(rawUrl, cookie) {
  const hashAt = rawUrl.indexOf('#');
  const sentPath = hashAt >= 0 ? rawUrl.slice(0, hashAt) : rawUrl;
  const fragment = hashAt >= 0 ? rawUrl.slice(hashAt) : '';

  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: sentPath,
      headers: Object.assign({ host: HOST,
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
        cookie ? { cookie } : {})
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        asked: rawUrl,
        sentPath,
        fragment,
        status: res.statusCode,
        setCookie: (res.headers['set-cookie'] || []).map((x) => String(x).split('=')[0]),
        location: res.headers.location || null
      }));
    });
    req.on('error', (e) => resolve({ asked: rawUrl, sentPath, fragment, status: 0, err: e.message, setCookie: [] }));
    req.end();
  });
}

(async () => {
  hr('先看清这两串东西分别是什么');
  line(`  ① 访问密钥（在**路径**里）: ${KEY}`);
  line(`  ② 加密密钥（在 # 后面）  : ${E2EE.slice(0, 12)}…（${E2EE.length} 个字符）`);
  line('');
  line('  手机上那条完整链接：');
  line(`    ${TUNNEL}/k/${KEY}#k=${E2EE}`);
  line('');
  line('  ★ 关键事实：**# 后面的东西浏览器根本不发给服务器。**');
  line('    这一点上一轮实测过（往地址里塞标记再去日志里搜，一处都没有）。');
  line('    所以服务器从来没见过 ② —— 它拿什么去「验证」②？');
  line('    验证不了的东西，就不可能决定你能不能进。');

  // ────────────────────────────────────────────────────────────────────────
  hr('四种组合，看服务端认哪一串');

  const cases = [
    ['路径带密钥 + 不带 #', `/k/${KEY}`],
    ['路径带密钥 + 带 #（= 你手机上的完整链接）', `/k/${KEY}#k=${E2EE}`],
    ['路径**不带**密钥 + 带 #', `/#k=${E2EE}`],
    ['两样都不带', '/']
  ];

  for (const [name, p] of cases) {
    const r = await call(p);
    const gotSession = r.setCookie.some((c) => c.startsWith('dsh-'));
    const verdict = r.status === 403 ? '✗ 进不去'
      : (r.status === 302 || r.status === 200) && gotSession ? '★ 进去了，而且拿到了登录凭证'
      : r.status === 302 ? '★ 进去了' : `HTTP ${r.status}`;
    line('');
    line(`  【${name}】`);
    line(`    你输入的地址        : ${r.asked}`);
    line(`    浏览器实际发出的     : GET ${r.sentPath}` +
      (r.fragment ? `      ← # 后面那 ${r.fragment.length} 个字符被浏览器切掉了，没发` : ''));
    line(`    结果                : ${r.status}  ${verdict}`);
    if (r.setCookie.length) line(`    种下的 cookie       : ${r.setCookie.join(', ')}`);
    if (r.location) line(`    跳到                : ${r.location}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  hr('回头看上面「浏览器实际发出的」那一列');

  line('  第 1 条和第 2 条，**发出的东西一模一样**：');
  line(`      GET /k/${KEY}`);
  line('  第 2 条就是你手机上那条完整链接 —— 它和"把 # 删掉"发出去的东西');
  line('  **一个字节都不差**。# 后面那 34 个字符，浏览器就没发出去过。');
  line('');
  line('  第 3、4 条都被 403 挡了 —— 因为它们都没带路径里那串。');
  line('');
  line('  这说明了什么：');
  line('    · 让服务器放你进去的，是路径里那串 ①');
  line('    · # 后面的 ② 从头到尾没参与「能不能进」这件事');
  line('    · 它只参与「进去之后，传的东西看不看得懂」');

  // ────────────────────────────────────────────────────────────────────────
  hr('那隧道能拿到什么');

  line('  它转发你请求的时候，看到的就是上面那个「请求行」：');
  line(`      GET /k/${KEY}          ← ★ 这串它看得一清二楚`);
  line('  因为路径是 HTTP 请求行的一部分，而 TLS 在 Cloudflare 那儿就终止了。');
  line('');
  line('  所以它能做的：把这条请求**自己发一遍** → 拿到完全一样的登录凭证');
  line('  → 然后以你的身份访问所有普通接口（会话列表、文件、余额…）。');
  line('');
  line('  它做不到的：');
  line('    · 它没见过 ②，所以解不开端到端加密的内容');
  line('    · 但它可以**不主动要求加密** —— 不要求就是明文，上一轮实测过');
  line('      （同一个文件：不带 e2ee=1 是明文，带了才是密文）');

  // ────────────────────────────────────────────────────────────────────────
  hr('你自己怎么复现（在你的浏览器里）');

  line('  ① 把地址里 # 之后整段删掉，回车：');
  line(`      ${TUNNEL}/k/${KEY}`);
  line('     → 照样进得去，只是界面上会显示「未加密」');
  line('');
  line('  ② 再把 /k/… 这段也删掉，只留域名：');
  line(`      ${TUNNEL}/`);
  line('     → 这次进不去了（403）');
  line('');
  line('  ③ 反过来，只留 # 那一段：');
  line(`      ${TUNNEL}/#k=${E2EE.slice(0, 8)}…`);
  line('     → 也进不去 —— 因为 # 后面的东西压根没发给服务器');
  line('');
  line('  做完这三步你就清楚了：**决定能不能进的是路径里那串，不是 # 后面那串。**');
  line('');
  line('  （提醒：① 那一步会让你退回明文模式。看完记得用完整链接重新进一次。）');
  line('');
})();
