// 为什么「再加一层加密」挡不住主动的隧道 —— 实验演示。
//
// 使用者的疑问（很合理）：
//   「这个不是有 # 后面的内容嘛？再次加密，那他就无法破解内容了啊。」
//
// 答案是：**再加多少层都没用**，而且原因跟密码学一点关系都没有。
// 这个脚本用真实算法把三件事演一遍：
//
//   实验一：层数是可计算的。钥匙的根在 # 里，知道根的人可以把
//           你加的所有层重新算一遍 —— 加一层和加十层没有区别。
//   实验二：攻击者根本不需要破解密码学。他改掉页面里的 JS，
//           那一行代码就能读到 location.hash —— 钥匙就摆在地址栏里。
//   实验三：就算你把 hash 藏得严严实实，也还有更省事的办法：
//           在解密函数外面包一层，直接接住解密后的明文。
//           **加密保护的永远是「传输途中」，不是「使用的那一刻」。**
//
// 用法: node scripts/explain-mitm.js
'use strict';

const e2ee = require('./e2ee.js');
const { Browser } = require('./browser-check.js');

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(72)); if (t) line(t); line('─'.repeat(72)); };

const SECRET = 'DEMO-' + require('crypto').randomBytes(12).toString('base64url');
const MESSAGE = '转账给李四，金额 8800，收款卡号 6222 0202 0000 0000';

(async () => {
  hr('前提：手机地址栏里那条链接');
  line(`  https://隧道域名/k/访问密钥#k=${SECRET}`);
  line('');
  line('  # 后面那串 = 长期密钥。它确实**从不发给服务器**（这一点是真的，');
  line('  上一节已经实测证明）。所以「被动偷看」的隧道永远拿不到它。');

  // ──────────────────────────────────────────────────────────────────────
  hr('实验一：你加一层、两层、三层 —— 知道根的人全能算回来');

  const k1 = await e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const layer1 = e2ee.encrypt(k1.a, Buffer.from(MESSAGE, 'utf8'));

  // 「再加一层」：把上一次的密钥当输入，再派生一次
  const k2 = await e2ee.deriveKeys(k1.a.toString('base64url'), e2ee.slotAt());
  const layer2 = e2ee.encrypt(k2.a, layer1);
  const k3 = await e2ee.deriveKeys(k2.a.toString('base64url'), e2ee.slotAt());
  const layer3 = e2ee.encrypt(k3.a, layer2);

  line(`  明文长度        ${Buffer.byteLength(MESSAGE)} 字节`);
  line(`  一层密文        ${layer1.length} 字节`);
  line(`  两层密文        ${layer2.length} 字节`);
  line(`  三层密文        ${layer3.length} 字节`);
  line('');
  line('  攻击者（他偷到了 # 里的那串）做的事：');
  line('    把同样的派生照着跑一遍 —— 这段代码是**公开的**，就在页面里');
  const rk1 = await e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const rk2 = await e2ee.deriveKeys(rk1.a.toString('base64url'), e2ee.slotAt());
  const rk3 = await e2ee.deriveKeys(rk2.a.toString('base64url'), e2ee.slotAt());
  // 从外往里剥：最外层是 k3，最里面才是 k1
  const back = e2ee.decrypt(rk1.a, e2ee.decrypt(rk2.a, e2ee.decrypt(rk3.a, layer3)));
  line(`    三层全开 → 「${back ? back.toString('utf8') : '（失败）'}」`);
  line('');
  line('  ★ 关键：**层数不是秘密，算法也不是秘密。**');
  line('    唯一的秘密是根（# 里那串）。根一旦泄露，');
  line('    你加多少层都只是多做几次同样的计算而已。');
  line('    加密的强度取决于「钥匙藏得多好」，不取决于「锁挂了几把」。');

  // ──────────────────────────────────────────────────────────────────────
  hr('实验二：攻击者根本不用破解密码学 —— 一行代码就够了');

  const b = await Browser.launch();
  const p = await b.newPage();

  // 这里用的是 CDP 的「在每个新文档开始前注入一段脚本」——
  // 那不是比喻，**它就是主动中间人的真实手法**：
  // 隧道转发网页时插一段自己的 JS，它比页面自己的脚本先跑，页面毫无察觉。
  await p.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__stolen = location.hash;   /* 攻击者的全部代码 */'
  });

  // 打开一个「看起来完全正常的页面」——而且地址带着密钥，
  // 和真实场景一样（使用者点开书签时 # 就在地址栏里）。
  const page = '<!doctype html><meta charset="utf-8">' +
    '<body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem">' +
    '<h1>你的工作台</h1><p>页面看起来一切正常，没有任何异样。</p>';
  await p.goto('data:text/html,' + encodeURIComponent(page) + '#k=' + SECRET, 2000);
  await new Promise((r) => setTimeout(r, 400));

  const stolen = await p.eval('window.__stolen');
  line(`  地址栏里（你看到的）  : "#k=${SECRET}"`);
  line(`  注入脚本先拿到了      : ${JSON.stringify(stolen)}`);
  line(`  和真实密钥一致吗      : ${stolen === '#k=' + SECRET ? '★ 一模一样' : '没拿到（' + stolen + '）'}`);
  line('');
  line('  ★ 钥匙就印在地址栏里，`location.hash` 是**任何**页面脚本都能读的。');
  line('    这不需要任何密码学能力 —— 一个初学者写一行就够了。');
  line('    你能给它再加一层加密吗？加的那层钥匙……从哪里来？还是从 # 来。');

  // ──────────────────────────────────────────────────────────────────────
  hr('实验三：就算把 # 藏起来，还有更省事的办法');

  // 模拟「页面里真正负责解密的那段代码」，然后把它包一层。
  // 这不是假想的攻击：改页面的人本来就在发这段代码，包一层是最自然的做法。
  const realDecrypt = async (buf) => {
    const keys = await e2ee.deriveKeys(SECRET, e2ee.slotAt());
    return e2ee.decrypt(keys.a, buf).toString('utf8');
  };

  const captured = [];
  const hookedDecrypt = async (buf) => {
    const plain = await realDecrypt(buf);   // 照常解密，用户毫无感觉
    captured.push(plain);                   // 顺手抄一份
    return plain;
  };

  const wire = e2ee.encrypt((await e2ee.deriveKeys(SECRET, e2ee.slotAt())).a,
    Buffer.from(MESSAGE, 'utf8'));
  const shown = await hookedDecrypt(wire);
  line(`  用户看到的（正常显示）: 「${shown}」`);
  line(`  攻击者同时拿到的      : 「${captured[0]}」`);
  line(`  用户有没有察觉        : 没有。页面表现得完全正常`);
  line('');
  line('  ★ 这一条是最根本的：');
  line('    **加密保护的是「传输途中」，不是「使用的那一刻」。**');
  line('    内容到了手机上，必须变成明文才能给你看 ——');
  line('    而做「变明文」这件事的代码，是隧道发给你的。');
  line('    他在那个位置等着就行了，不用破解任何东西。');

  b.kill();

  // ──────────────────────────────────────────────────────────────────────
  hr('所以结论是什么');
  line('  「加一层」这个思路有一个隐含前提：**解密的那段代码是可信的**。');
  line('  在网络传输里这个前提成立（两端都是你控制的程序）。');
  line('  在浏览器里它不成立 —— 代码每次都是现从网上取的，');
  line('  而取代码这件事，恰好要经过你想防的那个人。');
  line('');
  line('  这是「浏览器 + 第三方 CDN」的固有上限，不是我少加了一层。');
  line('');
  line('  ── 那怎么办 ──────────────────────────────────────────────────');
  line('  1. 走内网直连（同一个 WiFi 下的 HTTPS / IPv6 直连）：');
  line('     中间不经过任何第三方，「改代码的人」这个角色不存在。');
  line('     这是唯一能连实验二、实验三一起躲开的办法。');
  line('');
  line('  2. 如果你必须经过隧道：');
  line('     · 端到端加密仍然有意义 —— 它挡住的是**被动**记录');
  line('       （访问日志、抓包、事后翻记录），那是最现实的风险');
  line('     · 但不要把它当成「Cloudflare 想害我也没用」的保证');
  line('     · 真正的敏感操作（改密码、转账这类），别走这条链路');
  line('');
  line('  3. 判断标准很简单：');
  line('     **只要代码是现从网上取的，链路上的任何一方都能改它。**');
  line('     想要真正的端到端，就得让两端跑你自己信得过的程序。');
  line('');
})();
