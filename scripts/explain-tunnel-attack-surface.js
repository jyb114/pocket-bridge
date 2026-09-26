// 「我是隧道」—— 对**当前版本**做一次完整的攻击面梳理。
//
// 检查隧道可接触到哪些传输信息。
//
// 这个脚本按「代价从低到高」把手段排出来，每一条都真的试一次。
// 注意：访问密钥是隧道**天然看得到**的（它在网址路径里，TLS 在 Cloudflare
// 那里就终止了），所以下面很多条根本不需要「攻击」，只需要「使用」。
//
// 用法: node scripts/explain-tunnel-attack-surface.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim()) || 8080;
const TUNNEL = fs.readFileSync(path.join(BASE, 'logs', 'last-tunnel-url.txt'), 'utf8').trim();
const TUNNEL_HOST = new URL(TUNNEL).host;
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const sessions = require('./sessions.js');

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(74)); if (t) line(t); line('─'.repeat(74)); };

// 隧道转发请求时的视角：源站是明文 HTTP，Host 是隧道域名
function asTunnel(pathname, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname,
      method: opts.method || 'GET',
      headers: Object.assign({ host: TUNNEL_HOST,
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
        opts.headers || {})
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(c), headers: res.headers,
        setCookie: res.headers['set-cookie'] || []
      }));
    });
    req.on('error', (e) => resolve({ status: 0, body: Buffer.from(e.message), setCookie: [] }));
    req.end();
  });
}

(async () => {
  hr('第 0 层：隧道天然就能看到的东西（不需要任何"攻击"）');
  line('  cloudflared 连你电脑用的是明文 HTTP —— 这是它自己日志里写的：');
  try {
    const m = fs.readFileSync(path.join(BASE, 'logs', 'cloudflared.err.log'), 'utf8')
      .match(/originService=(http:\/\/\S+)/);
    if (m) line(`    originService=${m[1]}`);
  } catch (err) { }
  line('');
  line('  所以下面这些它是**直接读**的，谈不上"破解"：');
  line('    · 每个网页的 HTML、每个 .js/.css 的全文');
  line('    · 所有接口返回的 JSON');
  line(`    · 网址路径 —— 也就是访问密钥：  /k/${KEY}`);
  line('    · 请求头、Cookie、什么时间连的、连了多久、流量多大');
  line('');
  line('  ★ 关键在最后一条：**访问密钥在路径里，它看得见。**');
  line('    端到端加密保护的是"内容"，不是"钥匙孔"。');
  line('    而拿到钥匙孔的人，可以自己走进来。');

  // ──────────────────────────────────────────────────────────────────────
  hr('攻击 1：拿看到的密钥，直接冒充手机登录（不用改一行代码）');

  const login = await asTunnel(`/k/${KEY}`);
  const cookie = login.setCookie.map((c) => String(c).split(';')[0]).join('; ');
  line(`  用 /k/<密钥> 登录 → HTTP ${login.status}`);
  line(`  拿到的凭证: ${cookie.split('; ').map((c) => c.split('=')[0]).join(' + ') || '（无）'}`);
  line(`  设备表里多了一台: ${sessions.list().filter((d) => d.lastIp === '127.0.0.1' && /iPhone/.test(d.label)).length ? '是（待会收尾删掉）' : '否'}`);

  // 1a. 会话列表（含预览文字）
  const threads = await asTunnel('/codex/threads', { headers: { cookie } });
  let previews = [];
  try {
    const j = JSON.parse(threads.body.toString('utf8'));
    previews = (j.list || []).slice(0, 3).map((t) => String(t.preview || '').slice(0, 46));
  } catch (err) { }
  line(`\n  1a) 拉会话列表 → HTTP ${threads.status}`);
  line(`      ${previews.length} 条预览，例如：`);
  for (const p of previews) line(`        「${p}」`);

  // 1b. 文件：**不带 e2ee=1**，看是不是明文
  const codexHome = path.join(os.homedir(), '.codex');
  let probeFile = null;
  try {
    const walk = (dir, depth) => {
      if (depth > 2 || probeFile) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (probeFile) return;
        const p = path.join(dir, e.name);
        if (e.isFile() && /\.(json|toml|md|txt)$/.test(e.name)) { probeFile = p; return; }
        if (e.isDirectory()) walk(p, depth + 1);
      }
    };
    walk(codexHome, 0);
  } catch (err) { }

  if (probeFile) {
    const plain = await asTunnel(`/codex/file?path=${encodeURIComponent(probeFile)}`, { headers: { cookie } });
    const enc = await asTunnel(`/codex/file?path=${encodeURIComponent(probeFile)}&e2ee=1`, { headers: { cookie } });
    const isPlaintext = plain.status === 200 && /[\x20-\x7e]{12}/.test(plain.body.toString('latin1'));
    line(`\n  1b) 读文件（${path.basename(probeFile)}）：`);
    line(`      不带 e2ee=1 → HTTP ${plain.status}，${plain.body.length} 字节，` +
      (isPlaintext ? '★ **明文可读**' : '看不出明文'));
    line(`      带   e2ee=1 → HTTP ${enc.status}，${enc.body.length} 字节，` +
      (enc.body.length && enc.body[0] !== 0x7b ? '看起来是密文' : '仍是明文？'));
    if (isPlaintext) {
      const head = plain.body.toString('utf8').slice(0, 70).replace(/\s+/g, ' ');
      line(`      开头: ${head}…`);
    }
    line('');
    line('      ★ 端到端加密是**客户端主动要求的**（网址上带 e2ee=1 才加密）。');
    line('        冒充者当然不会主动要求 —— 他要的就是明文。');
  }

  // 1c. 余额这类普通接口
  const bal = await asTunnel('/__deepseek/balance', { headers: { cookie } });
  let balTxt = '';
  try { balTxt = JSON.parse(bal.body.toString('utf8')).total; } catch (err) { }
  line(`\n  1c) 余额接口 → HTTP ${bal.status}  ${balTxt !== '' ? '¥' + balTxt + '（明文 JSON）' : ''}`);

  // ──────────────────────────────────────────────────────────────────────
  hr('攻击 2：改掉发给手机的 JS，把 # 后面的密钥偷走');
  line('  这一条我已经在 explain-mitm.js 里演示过（CDP 注入，一行 location.hash）。');
  line('  这里只说它在本版本里的**现状**：');
  line('    · 仍然是可行的 —— 隧道转发网页时可以插入自己的脚本');
  line('    · 已经有一层拦截：Service Worker 核对代码指纹，对不上就拒绝执行');
  line('      实测有效（test-code-integrity.js：篡改后页面拿不到被改的代码）');
  line('    · 但那层**只在第一次之后**有效 —— 第一次连接时它 pin 什么就是什么');
  line('    · 而且它挡不住「每次一致地改写全部代码（连校验一起改）」');
  line('    · 另外：告警目前只在 console 里，使用者看不到（这是还没做完的部分）');

  // ──────────────────────────────────────────────────────────────────────
  hr('攻击 3：不改代码，只做「被动记录」，事后慢慢算');
  line('  这条路现在**基本被堵住了**：');
  line('    · WebSocket 内容：端到端加密，记下来是密文');
  line('    · 文件传输：手机带 e2ee=1 时也是密文');
  line('    · 长期密钥在 # 里，浏览器不发出去（实测过）');
  line('  所以它抄走的密文，离开这台电脑和那部手机就解不开。');

  // ──────────────────────────────────────────────────────────────────────
  hr('已经被堵掉的（前面几轮修的）');
  const fixed = [
    ['/codex/file?root= 读整块磁盘', '已修：允许范围改由服务端决定'],
    ['WebSocket 只查 cookie 名字', '已修：比完整的值 + 加设备令牌这道门'],
    ['/__notify 不看 Host（任意网页可触发）', '已修：改用更严的判定 + 限速'],
    ['配对码限速被隧道来源合并', '已修：用真实来源 + 时间无关比较'],
    ['明文对话写进 proxy.log', '已修：只记帧大小，不记内容']
  ];
  for (const [what, how] of fixed) line(`  · ${what.padEnd(38)} ${how}`);

  // ──────────────────────────────────────────────────────────────────────
  hr('结论：隧道现在能拿到什么');
  line('  不需要动手就能拿到：');
  line('    ① 全部网页代码            ← 这是它能改代码的前提');
  line('    ② 访问密钥（在路径里）    ← ★ 最要紧的一条');
  line('    ③ 元数据：时间、频率、流量大小');
  line('');
  line('  拿着 ② 冒充手机之后，还能拿到：');
  line('    ④ 会话列表和预览文字（明文 JSON）');
  line('    ⑤ **允许范围内的文件**（只要不主动要求加密，就是明文）');
  line('    ⑥ 余额、设备列表等所有普通接口');
  line('');
  line('  要动代码才拿得到（代价最高，但一旦成功就全盘沦陷）：');
  line('    ⑦ # 后面的长期密钥 → 之后所有流量都能解，永久有效');
  line('');
  line('  拿不到的：');
  line('    · WebSocket 里的实时对话内容（端到端加密，且手机每次都带 e2ee=1）');
  line('    · 带 e2ee=1 请求的文件内容');
  line('');
  line('  ── 所以最该补的两个洞 ─────────────────────────────────────');
  line('   A. 把长期密钥从地址栏挪走、存成非导出密钥');
  line('      → 攻击 2 从「拿到就永久有效」降级成「只能偷当下这一份」');
  line('   B. 把访问密钥从**路径**里挪走（改放请求头，或者干脆只用 # 里的密钥认证）');
  line('      → 直接掐掉攻击 1。现在这条路上它连"改代码"都不用做。');
  line('');
  line('   B 比 A 简单得多，而且堵掉的是**成本最低**的那条路。');
  line('');

  // 收尾：删掉这次冒充产生的设备记录
  const added = sessions.list().filter((d) => d.lastIp === '127.0.0.1' && /iPhone/.test(d.label));
  for (const d of added) sessions.remove(d.id);
  line(`  （收尾：删掉本次冒充登记的 ${added.length} 条设备记录，现在 ${sessions.list().length} 条）`);
  line('');
})();
