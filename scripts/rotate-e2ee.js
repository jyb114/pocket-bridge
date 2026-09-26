// 更换端到端加密用的长期密钥。
//
// 跟 rotate-key.js（换访问密钥）**完全是两回事**，别搞混：
//
//   访问密钥  决定「谁能连进来」。换它 = 换门锁，旧手机要重新配对。
//   加密密钥  决定「隧道能不能看懂内容」。换它 = 换一把只有你手机和电脑知道的钥匙。
//             不影响谁能连进来，但**手机书签里的地址会失效** ——
//             因为密钥在地址的 # 后面。
//
// ★ 这个动作**只在人手动跑它、或在控制台按下按钮时**才发生。
//   代码里没有任何定时器、启动钩子会自动调用它。
//
// 用法：
//   node rotate-e2ee.js            只换密钥 + 打印新地址（默认不发推送）
//   node rotate-e2ee.js --notify   额外推一条通知告诉手机「回电脑前换链接」
//
// ── 为什么推送默认关掉了 ──────────────────────────────────────────────
//
// 原来默认就推。结果是：**每跑一次测试套件，使用者手机就收到一条
// 「加密密钥已更换」**（test-rotate-e2ee.js 会真的调用这个脚本）。
// 从使用者视角看，就是「密钥莫名其妙自己在变」—— 明明没人按过任何按钮。
// 而且这些推送还把 ntfy 刷到限流（429），连正常通知都收不到了。
//
// 推送是**对外界的副作用**，不该是默认行为。要发就显式说 --notify。
// 另外 DSH_GW_NO_NOTIFY=1 可以无条件封死推送 —— 测试和自动化用它兜底，
// 这样即使以后谁给测试加了 --notify，也发不出去。
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const e2ee = require('./e2ee.js');
const bridge = require('./ws-e2ee-bridge.js');

const WANT_NOTIFY = process.argv.includes('--notify');
const NOTIFY_BLOCKED = process.env.DSH_GW_NO_NOTIFY === '1';

(async () => {
  const had = fs.existsSync(bridge.SECRET_FILE);
  const old = had ? fs.readFileSync(bridge.SECRET_FILE, 'utf8').trim() : '';
  const secret = e2ee.newLongTermSecret();
  bridge.writeSecret(secret);

  console.log(had ? '已更换加密密钥。' : '已生成加密密钥（之前没有，走隧道时是明文）。');
  console.log('');

  // 拼出手机要用的地址
  const key = (() => {
    try { return fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim(); }
    catch (e) { return ''; }
  })();

  let urls = [];
  try {
    const cfg = require('./config.js');
    const status = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'status.json'), 'utf8')); }
      catch (e) { return null; }
    })();
    const lan = (status && status.entries && status.entries.lan) || [];
    for (const u of lan.slice(0, 1)) urls.push({ label: '在家（同一 WiFi）', url: u });
    const wan = status && status.entries && status.entries.wan;
    if (wan) urls.push({ label: '在外面', url: wan });
  } catch (err) { /* 读不到状态就只给密钥 */ }

  console.log('手机要用的新地址（注意最后那段 #k=）：');
  // status.json 里的地址**本身可能已经带了 #k=**（控制台写的那份就带）。
  // 直接往后拼会得到 `#k=旧#k=新` —— 浏览器把 `#` 之后整段都当 fragment，
  // e2ee.js 解出来的密钥就是错的，手机会**连不上**而不是降级成明文。
  // 所以先把已有的 fragment 切掉再拼。
  const withKey = (u) => String(u).replace(/#.*$/, '') + `#k=${secret}`;
  if (urls.length) {
    for (const u of urls) console.log(`  ${u.label.padEnd(16)} ${withKey(u.url)}`);
  } else {
    console.log('  （读不到当前地址 —— 到控制台首页复制，然后在末尾加上 #k=' + secret + '）');
  }
  console.log('');
  console.log('原来的密钥：' + (had ? old.slice(0, 6) + '…（已作废）' : '（本来就没有）'));

  // 推送是显式选择，理由见文件开头。
  //
  // ★ 推的内容里**故意不带 `#k=` 那段**。
  //
  // 以前是推的，而且是「点开即用」的完整链接 —— 那等于把端到端加密的钥匙
  // 交给 ntfy.sh（公共、无需认证、消息留存在服务器上）。E2EE 的全部意义就是
  // 「隧道那头看不到内容」，结果我们自己把钥匙从另一条路递了出去。
  // 加密密钥一旦被第三方拿到，加密就只是个形式。
  //
  // 那手机怎么拿新密钥？只能回到电脑前。这是**有意的取舍**：
  // 换密钥是低频操作，而把长期密钥递给第三方是永久性的削弱。
  //
  // ★ 换密钥后手机**会失联** —— 这一点必须说清楚。
  //
  // 这里原来写的是「没有 #k= 就是明文模式，照样能用，只是界面会亮出未加密」。
  // 那句在加上「经中继 + 没要求加密 → 拒绝升级，不降级发明文」那道门之后
  // **就不成立了**：旧密钥解不开新密文，WebSocket 直接断开，手机上是
  // 「页面能开、对话列表永远空的」。所以下面必须明确让人回电脑换链接。
  if (!WANT_NOTIFY) {
    console.log('');
    console.log('· 没有推送（默认不发）。要顺便通知手机就加 --notify，');
    console.log('  或者直接把上面那条带 #k= 的地址复制给手机。');
    return;
  }

  if (NOTIFY_BLOCKED) {
    console.log('');
    console.log('· 推送被 DSH_GW_NO_NOTIFY=1 封死（测试/自动化环境），跳过。');
    return;
  }

  let push = null;
  try { push = require('./notify.js'); } catch (e) { }
  if (!push || !push.configured()) {
    console.log('');
    console.log('· 没配推送通道 —— 请手动把上面那条（带 #k=）发给手机。');
    return;
  }

  const r = await push.send('加密密钥已更换',
    '手机上的加密链接需要更新 —— 回电脑前复制新链接（带 #k= 的那条）。\n' +
    '在那之前手机连不上（旧密钥解不开新密文，对话打不开），请尽快回电脑换一次。');
  const okAny = r.some((x) => x.ok);
  console.log('');
  console.log(okAny ? '✓ 已通知手机「回电脑前换链接」（密钥本身没走推送）' : '✗ 推送没成功: ' + JSON.stringify(r));
})();
