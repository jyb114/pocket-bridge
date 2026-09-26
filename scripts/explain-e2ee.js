// 「假如我是隧道」—— 把端到端加密到底保护了什么、没保护什么，用真实字节演示一遍。
//
// 这个脚本演示：中继能看到哪些信息，缺少解密密钥时能否还原正文。
//
// 这些问题不该用嘴回答。这个脚本会：
//   1. 拿一句真实的私密内容，按系统实际的算法加密（就是线上跑的那套）
//   2. 把**线路上真正流过去的字节**打出来 —— 这就是隧道能看到的全部
//   3. 扮演隧道：在没有密钥的情况下尝试还原（直接解 / 换把钥匙 / 暴力试）
//   4. 把「隧道仍然能看到什么」一条条列清楚，包括那几个不那么好看的事实
//
// 用法: node scripts/explain-e2ee.js
'use strict';

const crypto = require('crypto');
const e2ee = require('./e2ee.js');

const line = (s) => console.log(s);
const hr = (t) => { line(''); line('─'.repeat(72)); if (t) line(t); line('─'.repeat(72)); };

// 一个演示用的长期密钥（真实的那个在 logs/e2ee-secret.txt，不在这里打印）
const SECRET = 'DEMO-' + crypto.randomBytes(12).toString('base64url');

const PRIVATE = '帮我把这份病历整理成表格，病人叫张三，身份证 110101199001011234';

(async () => {
  hr('一、算法：这套东西到底用了什么');
  line('  长期密钥（在 # 后面，永远不发给服务器）  : 一串随机字符');
  line('  派生            : HKDF-SHA256（RFC 5869）');
  line('  派生输入        : 长期密钥 + 当前时间槽（每 30 分钟换一槽）');
  line('  会话密钥        : 32 字节，两个方向各一把（a=上行 b=下行）');
  line('  加密            : AES-256-GCM（NIST SP 800-38D）');
  line('  每条消息        : 12 字节随机 IV + 16 字节认证标签 + 密文');
  line('');
  line(`  当前时间槽: ${e2ee.slotAt()}（${new Date().toISOString()}）`);

  const keys = await e2ee.deriveKeys(SECRET, e2ee.slotAt());
  line(`  派生出的上行密钥(hex，前16字节): ${keys.a.toString('hex').slice(0, 32)}…`);
  line(`  派生出的下行密钥(hex，前16字节): ${keys.b.toString('hex').slice(0, 32)}…`);

  // ────────────────────────────────────────────────────────────────────────
  hr('二、加密一句话，然后看线路上流过去的是什么');
  line(`  明文（手机里打的字）: 「${PRIVATE}」`);
  line('');

  const wire = e2ee.encrypt(keys.a, Buffer.from(PRIVATE, 'utf8'));

  line('  ↓ 这就是隧道（Cloudflare）实际看到的字节 —— 全部，没有省略：');
  line('');
  line(`    base64 : ${wire.toString('base64')}`);
  line(`    十六进制: ${wire.toString('hex')}`);
  line('');
  line(`    长度   : ${wire.length} 字节（明文 ${Buffer.byteLength(PRIVATE)} 字节）`);
  line(`    IV     : ${wire.subarray(0, 12).toString('hex')}`);
  line(`    标签   : ${wire.subarray(12, 28).toString('hex')}`);
  line(`    密文   : ${wire.subarray(28).toString('hex').slice(0, 64)}…`);

  // ────────────────────────────────────────────────────────────────────────
  hr('三、现在我是隧道。我来试着还原它');

  // 1) 直接当成文本读
  const asText = wire.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
  line('  [尝试 1] 当成 UTF-8 文本直接读：');
  line(`    "${asText.slice(0, 60)}…"`);
  line('    → 全是乱码。这是密文该有的样子。');
  line('');

  // 2) 换一把钥匙（哪怕只差一个字符）
  const wrongSecret = SECRET.slice(0, -1) + (SECRET.endsWith('A') ? 'B' : 'A');
  const wrongKeys = await e2ee.deriveKeys(wrongSecret, e2ee.slotAt());
  let r2 = null;
  try { r2 = e2ee.decrypt(wrongKeys.a, wire); } catch (err) { r2 = null; }
  line('  [尝试 2] 长期密钥只错一个字符：');
  line(`    → ${r2 ? '解出来了（不该发生！）' : '解不开。GCM 的认证标签直接判定失败。'}`);
  line('');

  // 3) 换时间槽（比如猜到密钥但不知道是哪个半小时）
  const otherSlot = await e2ee.deriveKeys(SECRET, e2ee.slotAt() - 7);
  let r3 = null;
  try { r3 = e2ee.decrypt(otherSlot.a, wire); } catch (err) { r3 = null; }
  line('  [尝试 3] 密钥对、但时间槽猜错（每 30 分钟换一槽）：');
  line(`    → ${r3 ? '解出来了（不该发生！）' : '解不开。旧槽的钥匙开不了新槽的锁。'}`);
  line('');

  // 4) 暴力穷举一个「短密钥」要多久
  const SHORT = 'abcd';          // 4 个字符合计 62^4 ≈ 1477 万种
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const space = Math.pow(alphabet.length, SHORT.length);
  const perSec = 200000;         // 一台机器每秒试 20 万次（乐观估计）
  line('  [尝试 4] 暴力穷举（假设使用者的 # 后面只有 4 个字符）：');
  line(`    可能的密钥数: ${space.toLocaleString()}（62^4）`);
  line(`    单机每秒试 20 万次 → 约 ${(space / perSec / 60).toFixed(0)} 分钟就能试完`);
  line('    → 所以密钥长度**就是**安全性的全部。');
  line('');

  const REAL_LEN = 32;           // 实际的 logs/e2ee-secret.txt 是 32 个 base64url 字符
  const realSpace = Math.pow(64, REAL_LEN);
  const years = realSpace / perSec / 3600 / 24 / 365;
  line(`  [对比] 实际的 # 后面是 ${REAL_LEN} 个随机字符（约 192 位）：`);
  line(`    可能数 10^${Math.round(Math.log10(realSpace))}，单机试完要 10^${Math.round(Math.log10(years))} 年。`);
  line('    → 宇宙年龄（约 1.4×10^10 年）在它面前可以忽略。');
  line('');

  // 5) 密文看起来随机吗
  const bits = Array.from(wire).map((b) => b.toString(2).padStart(8, '0')).join('');
  const ones = bits.split('').filter((c) => c === '1').length;
  line('  [尝试 5] 统计特征（密文该和随机数不可区分）：');
  line(`    1 的比例: ${(ones / bits.length * 100).toFixed(1)}%（随机数期望 50%）`);
  line('    → 看不出结构。没有可利用的规律。');

  // 6) 反向：如果我真的有密钥
  const back = e2ee.decrypt(keys.a, wire).toString('utf8');
  line('');
  line('  [对照] 拿着正确密钥（也就是你手机里 # 的那串）：');
  line(`    → 「${back}」`);
  line('    一字不差。所以「必须用解密密钥」这句话是成立的。');

  // ────────────────────────────────────────────────────────────────────────
  hr('四、但是 —— 隧道仍然能看到这些（这部分才是我该讲清楚的）');

  line('  ① **访问密钥在网址路径里**：/k/<你的访问密钥>');
  line('     路径是 HTTP 请求行的一部分，TLS 在 Cloudflare 那里就终止了，');
  line('     所以它**看得见这串**（内容加密保护不了它 —— 它是加密的钥匙孔，不是内容）。');
  line('     拿到它的人可以冒充你的手机登录进来。');
  line('     → 但进来之后看到的还是密文，因为 # 后面的钥匙它没有。');
  line('');
  line('  ② **谁在什么时候连、流量多大、多频繁**：元数据藏不住。');
  line('     我加密的是内容，不是「你俩在聊天」这件事本身。');
  line('');
  line('  ③ **明文 HTTP 的那些接口调用**（控制台状态、余额查询等）：');
  line('     端到端加密只覆盖 WebSocket 实时通道和文件传输，');
  line('     普通 HTTPS 请求是 Cloudflare 直接转发的，它能看。');
  line('');
  line('  ④ ★ **最要紧的一条：如果隧道是「主动的」，上面全部作废。**');
  line('     Cloudflare 是 TLS 终点，它可以在转发网页时**改掉页面里的 JS**，');
  line('     塞一段读 location.hash 的代码，把 # 后面的钥匙偷走。');
  line('     浏览器里的端到端加密**防不住这种事** —— 密码学再强，');
  line('     代码是别人发的，钥匙就在那段代码手里。');
  line('     这不是这套设计的缺陷，是「浏览器 + 第三方 CDN」这个前提的固有上限。');
  line('');
  line('  所以准确的说法是：');
  line('    · 防「被动偷看」—— 成立。它记下的日志、存下的流量，都只是乱码。');
  line('    · 防「主动篡改」—— 不成立。要防它得用你手机上信任的客户端，');
  line('      而不是每次现从网上取一份 JS。');

  hr('五、那这套加密到底有没有意义');
  line('  有，而且是针对最现实的那种风险：');
  line('    · Cloudflare 的访问日志、中间设备的抓包、你电脑上别人的窥屏');
  line('    · 手机连公共 WiFi 时旁边的人抓到的内容');
  line('    · 隧道服务商事后翻记录 —— 翻到的是一堆乱码');
  line('');
  line('  它防不住的：');
  line('    · 隧道服务商**当下就动手**改你的页面（见上面第 ④ 条）');
  line('    · 你自己电脑被入侵（钥匙就在这台电脑上）');
  line('    · 手机丢了、密码被看到');
  line('');
  line('  想连第 ④ 条也躲开：走内网直连（IPv6 或同一个 WiFi 下的 HTTPS），');
  line('  中间没有任何第三方，那才是真正端到端的。');
  line('');
})();
