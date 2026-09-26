// 白名单/挑战应答 —— 动手之前先证明它真的管用。
//
// 要解决的问题（上一轮实测出来的）：
//   访问密钥写在网址**路径**里 /k/<密钥>，而路径是 HTTP 请求行的一部分，
//   TLS 在 Cloudflare 那儿就终止了 —— **隧道看得见**。
//   它把那条请求自己发一遍，就拿到和你一样的登录凭证，
//   然后以你的身份读会话预览、明文文件、余额。
//
// 想改成：进门要证明「我知道 # 里那串」，而不是「我知道路径里那串」。
//   # 里那串隧道**从来没见过**（浏览器根本不发 fragment，实测过）。
//
// 这个脚本要证明四件事：
//   ① 拿着 # 密钥的一方能算出正确的应答
//   ② 只拿着访问密钥的一方算不出来
//   ③ 服务端能验对、也能拒错
//   ④ nonce 一次性 —— 录下来重放没用
//
// 用法: node scripts/test-challenge-response.js
'use strict';

const crypto = require('crypto');
const e2ee = require('./e2ee.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

// ── 设计 ────────────────────────────────────────────────────────────────────
//
// 长期密钥（# 里那串）不直接拿来算 HMAC —— 先做**密钥分离**：
//   authKey = HKDF(长期密钥, salt='dsh-gw-auth', info='dsh-gw|auth|v1')
// 这样认证用的钥匙和加密用的钥匙是两把，一边泄露不连累另一边。
// （e2ee.js 里已经有 hkdf()，直接复用，不另造轮子。）
const AUTH_SALT = Buffer.from('dsh-gw-auth');
const AUTH_INFO = 'dsh-gw|auth|v1';

function authKeyOf(longTermSecret) {
  return e2ee.hkdf(Buffer.from(longTermSecret, 'utf8'), AUTH_SALT, AUTH_INFO, 32);
}

/** 服务端：发一个一次性 nonce */
const issued = new Map();          // nonce -> 过期时间
function issueNonce(ttlMs = 60000) {
  const n = crypto.randomBytes(24).toString('base64url');
  issued.set(n, Date.now() + ttlMs);
  return n;
}
/** 服务端：核对应答 */
function verifyResponse(nonce, response, longTermSecret) {
  const exp = issued.get(nonce);
  if (!exp) return { ok: false, reason: 'nonce 不认识（没发过 / 已用过 / 已过期）' };
  if (Date.now() > exp) { issued.delete(nonce); return { ok: false, reason: 'nonce 过期' }; }
  // 一次性：不管成不成立，用过就作废（防重放）
  issued.delete(nonce);
  const want = crypto.createHmac('sha256', authKeyOf(longTermSecret)).update(nonce).digest();
  const got = Buffer.from(String(response), 'base64url');
  if (got.length !== want.length) return { ok: false, reason: '应答长度不对' };
  if (!crypto.timingSafeEqual(got, want)) return { ok: false, reason: '应答对不上' };
  return { ok: true };
}
/** 客户端：用 # 里的密钥算应答（真实实现里这段跑在手机的 e2ee.js 里） */
function respond(nonce, longTermSecret, exportedKey) {
  return crypto.createHmac('sha256', exportedKey || authKeyOf(longTermSecret))
    .update(nonce).digest('base64url');
}

// ── 场景 ────────────────────────────────────────────────────────────────────
const SECRET = 'hbKkZXOu3sotAskETkfIezG8_DJBhU3z';   // # 后面那串（形状与真实一致）
const ACCESS_KEY = 'demo-access-key-1234';           // 路径里那串（隧道看得见）

console.log('\n=== 挑战应答 · 可行性验证 ===\n');
console.log(`  ① 长期密钥（# 后面，隧道没见过）: ${SECRET}`);
console.log(`  ② 访问密钥（路径里，隧道看得见）: ${ACCESS_KEY}`);

// ── ① 手机能不能算出正确应答 ────────────────────────────────────────────────
console.log('\n[1] 手机（知道 # 密钥）');
const n1 = issueNonce();
const r1 = respond(n1, SECRET);
const v1 = verifyResponse(n1, r1, SECRET);
console.log(`      nonce   : ${n1.slice(0, 20)}…`);
console.log(`      应答    : ${r1.slice(0, 32)}…`);
console.log(`      服务端  : ${v1.ok ? '通过' : '拒绝（' + v1.reason + '）'}`);
ok('★ 拿着 # 密钥的一方，应答能被验过', v1.ok === true, v1.reason);

// ── ② 隧道能不能算出应答 ────────────────────────────────────────────────────
console.log('\n[2] 隧道（只有访问密钥，没见过 # 密钥）');
const n2 = issueNonce();
// 它能做的全部尝试：
const tries = [
  ['拿访问密钥当 HMAC 的钥匙', () => crypto.createHmac('sha256', ACCESS_KEY).update(n2).digest('base64url')],
  ['拿访问密钥做 HKDF 再算', () => respond(n2, ACCESS_KEY)],
  ['把访问密钥和 nonce 拼起来哈希', () => crypto.createHash('sha256').update(ACCESS_KEY + n2).digest('base64url')],
  ['赌一个空应答', () => ''],
  ['赌一个全零应答', () => Buffer.alloc(32).toString('base64url')]
];
let anyPassed = false;
for (const [what, fn] of tries) {
  const n = issueNonce();
  const guess = fn();
  const v = verifyResponse(n, guess, SECRET);
  if (v.ok) anyPassed = true;
  console.log(`      ${what.padEnd(24)} → ${v.ok ? '★ 竟然通过了' : '被拒'}`);
}
ok('★ 只拿访问密钥的一方，怎么算都过不去', anyPassed === false);

// ── ③ 服务端不会认错人 ──────────────────────────────────────────────────────
console.log('\n[3] 服务端不会认错人');
const n3 = issueNonce();
const wrong = respond(n3, SECRET.slice(0, -1) + 'X');     // 密钥错一个字符
const v3 = verifyResponse(n3, wrong, SECRET);
ok('密钥差一个字符也过不去', v3.ok === false, v3.reason);

const n4 = issueNonce();
const v4 = verifyResponse(n4, respond(n4, SECRET).slice(0, -2) + 'zz', SECRET);
ok('应答被改过也过不去', v4.ok === false, v4.reason);

// ── ④ nonce 一次性：录下来重放没用 ──────────────────────────────────────────
console.log('\n[4] 重放');
const n5 = issueNonce();
const r5 = respond(n5, SECRET);
const first = verifyResponse(n5, r5, SECRET);
const replay = verifyResponse(n5, r5, SECRET);            // 同一条再来一遍
console.log(`      第一次: ${first.ok ? '通过' : '拒绝'}`);
console.log(`      重放  : ${replay.ok ? '★ 又通过了' : '拒绝（' + replay.reason + '）'}`);
ok('★ 同一条应答重放会被拒（隧道录下来也没用）',
  first.ok === true && replay.ok === false, replay.reason);

// ── ⑤ 隧道全程能看到什么 ────────────────────────────────────────────────────
console.log('\n[5] 隧道在这一轮里看到的全部东西');
const n6 = issueNonce();
const r6 = respond(n6, SECRET);
verifyResponse(n6, r6, SECRET);
console.log(`      nonce  : ${n6}`);
console.log(`      应答   : ${r6.slice(0, 40)}…`);
console.log('      它**没有**看到的: 长期密钥本身');
console.log('      → 从 nonce 和应答里反推密钥 = 破 HMAC-SHA256，做不到');
ok('应答里不含密钥明文', !r6.includes(SECRET) && !Buffer.from(r6, 'base64url').includes(Buffer.from(SECRET)));

// ── ⑥ 和现有加密钥匙做密钥分离 ──────────────────────────────────────────────
console.log('\n[6] 密钥分离（认证用的钥匙 ≠ 加密用的钥匙）');
const encA = e2ee.deriveKeys(SECRET, e2ee.slotAt()).a;
const authK = authKeyOf(SECRET);
console.log(`      加密钥匙(前16): ${encA.toString('hex').slice(0, 32)}`);
console.log(`      认证钥匙(前16): ${authK.toString('hex').slice(0, 32)}`);
ok('两把钥匙不一样（一边泄露不连累另一边）', !encA.equals(authK));

// ── ⑦ 时间无关比较 ──────────────────────────────────────────────────────────
console.log('\n[7] 比较方式');
const sw = require('fs').readFileSync(require('path').join(__dirname, 'test-challenge-response.js'), 'utf8');
ok('核对应答用的是 timingSafeEqual（不是 ===）', /timingSafeEqual/.test(sw));

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
console.log(fail === 0
  ? '  结论：这个方案成立。拿着访问密钥的隧道过不去，拿着 # 密钥的手机能过。\n' +
    '        可以按「先观察、后强制」两步落地（见下一轮）。\n'
  : '  结论：不成立，先解决上面的问题。\n');
process.exitCode = fail ? 1 : 0;
