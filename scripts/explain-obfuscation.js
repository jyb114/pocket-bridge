// 「把 # 后面的内容伪装起来，让攻击者得费功夫」—— 这条路可行吗？
//
// 使用者的想法（很有代表性）：
//   把密钥伪装一下，让他第一时间拿到也不知道这是干嘛的；
//   解题思路藏在网页代码里，他得花功夫去思考；
//   而且隐藏方式还在变、每条消息都在变 ——
//   也就是说：他能破解，但要花代价，而不是交给机器就完事。
//
// 这个思路有正式名字，工业界真的在用：
//   · 代码混淆（obfuscation）
//   · 移动目标防御（moving target defense）
//   · 白盒密码（white-box cryptography）
//   · 多态/变形引擎（polymorphic engine）
//
// 但它们全都建立在一个前提上：**攻击者只能"读"你的代码**。
// 而你这个场景里的攻击者能"运行"你的代码。
// 这个区别是决定性的，这个脚本把它演出来。
//
// 用法: node scripts/explain-obfuscation.js
'use strict';

const crypto = require('crypto');

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(74)); if (t) line(t); line('─'.repeat(74)); };

const SECRET = 'hbKkZXOu3sotAskETkfIezG8_DJBhU3z';   // 形状和真实密钥一样

// ────────────────────────────────────────────────────────────────────────────
// 第 1 步：把密钥「伪装」起来。
// 这里刻意做得比现实更绕：翻转 → XOR → 变进制 → 按位置打散 → base64。
// 现实里没人会写这么夸张 —— 目的就是说明「再绕也没用」。
// ────────────────────────────────────────────────────────────────────────────
function obfuscate(secret) {
  // 注意都用纯数组，别用 Buffer.map —— 它返回的还是 Buffer，
  // JSON 序列化出来是 {type:'Buffer',data:[...]}，往返就错位了。
  const bytes = Array.from(Buffer.from(secret, 'utf8'));
  const rev = bytes.slice().reverse();
  const xored = rev.map((b, i) => b ^ ((0x5a + i * 7) & 0xff));
  const shifted = xored.map((b, i) => (b + i * 13 + 41) & 0xff);
  // 按位置打散：把偶数位和奇数位分开存
  const even = shifted.filter((_, i) => i % 2 === 0);
  const odd = shifted.filter((_, i) => i % 2 === 1);
  return Buffer.from(JSON.stringify({ a: even, b: odd }), 'utf8').toString('base64');
}

// ────────────────────────────────────────────────────────────────────────────
// 第 2 步：网页里**必须**带着「解回来」的那段代码。
//
// ★ 这是整个讨论的关键：密钥要能用，就必须能被解开；
//   要能被网页解开，网页里就必须有解它的办法。
//   你可以把它写得很难懂，但你没法把它删掉。
// ────────────────────────────────────────────────────────────────────────────
function solve(blob) {
  const { a, b } = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
  const shifted = [];
  for (let i = 0; i < a.length + b.length; i++) {
    shifted.push(i % 2 === 0 ? a[i / 2] : b[(i - 1) / 2]);
  }
  const xored = shifted.map((v, i) => (v - i * 13 - 41) & 0xff);
  const rev = Buffer.from(xored.map((b2, i) => b2 ^ ((0x5a + i * 7) & 0xff))).toString('utf8');
  return rev.split('').reverse().join('');
}

const blob = obfuscate(SECRET);

(async () => {
  hr('一、伪装之后，密钥长这样');
  line(`  真实密钥      : ${SECRET}`);
  line(`  「伪装」之后  : ${blob}`);
  line('');
  line('  这串是：翻转 → XOR → 变进制 → 奇偶位打散 → base64，五道工序。');
  line('  光看这串，确实看不出它是什么 —— 你的直觉在这里是对的。');

  // ──────────────────────────────────────────────────────────────────────
  hr('二、但攻击者不需要"看懂"它 —— 他只需要"调用"它');

  line('  网页里必须带着解回来的那段代码（上面那个 solve 函数）。');
  line('  攻击者要做的事：');
  line('');
  line('      const s = solve(blob);      // 就这一行');
  line('');
  const got = solve(blob);
  line(`  结果: ${got}`);
  line(`  对不对: ${got === SECRET ? '★ 一字不差' : '没拿到'}`);
  line('');
  line('  注意他做了什么：');
  line('    · 没有逆向 XOR 的轮转规律');
  line('    · 没有分析奇偶位是怎么打散的');
  line('    · 没有推断那五道工序的顺序');
  line('    · **他压根没读懂那段代码** —— 他只是把它跑了一遍');
  line('');
  line('  ★ 混淆挡得住「读懂」，挡不住「运行」。');
  line('    而在这个场景里，「运行」就够了。');

  // ──────────────────────────────────────────────────────────────────────
  hr('三、再加十倍难度试试？');

  // 再套十层：每层都是「用上一层的结果当输入，再做一次变换」
  const layers = [];
  let cur = SECRET;
  for (let i = 0; i < 10; i++) {
    const enc = obfuscate(cur);
    layers.push(enc);
    cur = enc;          // 下一层的输入是这一层的输出
  }
  const rebuilt = layers.reduceRight((acc, _enc, i) => (i === layers.length - 1 ? solve(layers[i]) : acc), null);
  // 正确地剥十层：
  let peeled = layers[layers.length - 1];
  for (let i = layers.length - 1; i >= 0; i--) peeled = solve(peeled);
  line(`  十层之后的数据长度: ${layers[layers.length - 1].length} 字符`);
  line(`  攻击者的代码          : 一个 for 循环，十次 solve`);
  line(`  攻击者拿到的          : ${peeled}`);
  line(`  对不对                : ${peeled === SECRET ? '★ 一字不差' : '没拿到'}`);
  line('');
  line('  ★ 层数只让**你的解密**变长，不让**他的调用**变难。');
  line('    他写的还是「跑一遍你写的那段代码」。');

  // ──────────────────────────────────────────────────────────────────────
  hr('四、那「每条消息换一种隐藏方式」呢？');

  const SCHEMES = ['reverse+xor', 'rotate+base', 'split+shift'];
  function makeScheme(name, secret) {
    if (name === 'reverse+xor') return obfuscate(secret);
    if (name === 'rotate+base') {
      const r = secret.split('').map((c) => String.fromCharCode(c.charCodeAt(0) + 3)).join('');
      return Buffer.from(r, 'utf8').toString('base64');
    }
    return Buffer.from(secret.split('').reverse().join(''), 'utf8').toString('hex');
  }
  function solveScheme(name, blob2) {
    if (name === 'reverse+xor') return solve(blob2);
    if (name === 'rotate+base') {
      return Buffer.from(blob2, 'base64').toString('utf8')
        .split('').map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join('');
    }
    return Buffer.from(blob2, 'hex').toString('utf8').split('').reverse().join('');
  }
  // 网页里必须有这个「按当前方案解」的分发器 —— 没有它自己也解不开
  function solveAny(schemeName, blob2) { return solveScheme(schemeName, blob2); }

  line('  假设网页每条消息随机挑一种方案。攻击者怎么办？');
  line('');
  for (let i = 0; i < 3; i++) {
    const name = SCHEMES[i % SCHEMES.length];
    const b2 = makeScheme(name, SECRET);
    const t0 = process.hrtime.bigint();
    const out = solveAny(name, b2);            // ← 攻击者做的全部事情
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    line(`    第 ${i + 1} 条: 方案=${name.padEnd(14)} 攻击者耗时 ${us.toFixed(0)} 微秒 → ${out === SECRET ? '拿到了' : '没拿到'}`);
  }
  line('');
  line('  ★ 「每条都换」换掉的是**你的编码方式**，不是**他的入口**。');
  line('    他的入口永远是同一个：网页里那个「把消息变成人能看的东西」的函数。');
  line('    不管你换多少种编码，最后都得走到那一个函数上 ——');
  line('    他在那儿等着就行了，一次都不用改。');

  // ──────────────────────────────────────────────────────────────────────
  hr('五、为什么混淆在这里注定失效（一句话版本）');

  line('  混淆能起作用的前提：**攻击者只能读你的代码，不能跑它。**');
  line('  比如：你发一个编译好的 App，他只能反汇编 —— 那混淆真的有用，');
  line('  工业界的加固服务就是干这个的，能把破解成本抬高几个量级。');
  line('');
  line('  但你这里是浏览器：');
  line('    · 代码是明文 JS，本来就没编译过');
  line('    · **而且是攻击者转发给你的** —— 他有一份原件');
  line('    · 最要命的是：他不需要逆向。把页面在无头浏览器里跑一遍，');
  line('      在最后一步接住结果就行（上一节的实验三演示过）');
  line('');
  line('  换句话说：你花在混淆上的功夫，抬高的是「读懂」的成本；');
  line('  而他的最优路径是「运行」，成本约等于零，**且与你的混淆强度无关**。');
  line('  你越绕，只能证明「运行」这一步越是绕不开。');

  hr('六、那有没有办法让他真的付出代价');

  line('  有，但不在「加密/混淆」这条路上，而在**别让他发代码**这条路上：');
  line('');
  line('  ① 内网直连（同 WiFi 的 HTTPS / IPv6 直连）');
  line('     链路上没有第三方，就没有「转发你代码的人」这个角色。');
  line('     这是干净利落、当下就能用的答案。');
  line('');
  line('  ② 如果必须走隧道：让「改动」变得能被发现，而不是让它变得难懂');
  line('     · 手机第一次连上时，把网页代码的指纹记下来（存本地）');
  line('     · 以后每次加载，用**已经缓存的那份旧代码**去核对新代码的指纹');
  line('     · 对不上就明确报警，而不是照常运行');
  line('     这挡不住第一次被改（先入为主），但能把「每次都被看光」');
  line('     压缩成「只有第一次有风险」—— 这是真正降低攻击面的做法。');
  line('');
  line('  ③ 敏感操作别走这条链路');
  line('     转账、改密码这类事情，用别的通道。');
  line('');
  line('  一句话：**提高「读懂」的成本收益很低，降低「他能碰到的机会」才有用。**');
  line('');
})();
