// 重放防护 —— 计划 D「重复帧被拒绝」的验收测试。
//
// 背景：AES-GCM 保证「改一个字节就解不开」，但**不保证「同一段密文不能重发」**。
// 攻击者（比如中继）抓到一个手机发出的 turn/start 帧原样再发一次，密钥对、
// 标签对，网关照解、照转发，电脑就把那条命令**又执行一遍**。加密在这里
// 一点忙都帮不上 —— 密文是真的，只是旧的。
//
// 判据是 IV：每帧 IV 是 12 字节随机数，重复概率可忽略；而 IV 是 GCM 的输入，
// 改 IV 就验不过标签，所以重放必须原样带着同一个 IV。于是「同一密钥作用域下
// 见过这个 IV」就是重放的铁证。这不是启发式，是 GCM 对 nonce 唯一性的要求。
//
// 这个测试最要紧的一条其实是 [3]：**正常重复的内容不能被误判**。
// 使用者连发两次「继续」是完全正常的，两帧明文一样、IV 不同。
// 如果判据写成「明文一样就算重放」，那是在惩罚正常使用。
'use strict';
require('./replay-isolated-fixture.js').install();

const e2ee = require('./e2ee.js');
const wsf = require('./ws-frame.js');
const { WsCrypto, _noteIv, _scopeOf } = require('./ws-crypt.js');

const SECRET = 'test-secret-0123456789abcdef';
const OTHER_SECRET = 'another-secret-9876543210zyxwvu';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

/** 造一个「手机发出来的」加密帧（和 pwa/e2ee.js 的布局一致：iv|tag|密文） */
function clientFrame(plaintext, { binary = true, secret = SECRET, mangle = false } = {}) {
  const keys = e2ee.deriveKeys(secret, e2ee.slotAt());
  let ct = e2ee.encrypt(keys.a, Buffer.from(plaintext, 'utf8'));
  if (mangle) {
    // 改动密文正文的最后一个字节：标签就验不过了
    const b = Buffer.from(ct);
    b[b.length - 1] ^= 0xff;
    ct = b;
  }
  // 真实客户端：加密结果是 ArrayBuffer，所以发出去是**二进制帧**
  return wsf.buildFrame(binary ? wsf.OP_BIN : wsf.OP_TEXT, ct, false);
}

/** 把一段字节拆成帧，返回每个帧的载荷 */
function payloads(buf) {
  if (!buf || !buf.length) return [];
  return wsf.parseFrames(buf).frames.map((f) => ({ opcode: f.opcode, text: f.payload.toString('utf8') }));
}

console.log('\n=== 重放防护 ===\n');

// ── 1. 正常帧放行 ───────────────────────────────────────────────────────────
{
  const up = new WsCrypto(SECRET, 'decrypt');
  const out = payloads(up.push(clientFrame('{"method":"turn/start"}')));
  ok('[1] 正常加密帧被解开放行', out.length === 1 && out[0].text === '{"method":"turn/start"}',
    JSON.stringify(out));
}

// ── 2. 原样重发 → 必须被丢弃 ────────────────────────────────────────────────
{
  const up = new WsCrypto(SECRET, 'decrypt');
  const frame = clientFrame('{"method":"turn/start","clientUserMessageId":"q1"}');
  const first = payloads(up.push(frame));
  const second = payloads(up.push(frame));
  ok('[2] 第一次正常放行', first.length === 1);
  ok('[2] 原样重发被丢弃（重复帧被拒绝）', second.length === 0, JSON.stringify(second));
  ok('[2] 计数记下了重放次数', up.replayed === 1, String(up.replayed));
}

// ── 3. 明文相同但是新帧 → 必须放行 ──────────────────────────────────────────
//
// 这条是**防止把正常人当攻击者**：使用者连发两次「继续」很常见。
// 两帧明文一模一样，只有 IV 不同 —— 判据必须是 IV，不能是内容。
{
  const up = new WsCrypto(SECRET, 'decrypt');
  const a = payloads(up.push(clientFrame('{"text":"继续"}')));
  const b = payloads(up.push(clientFrame('{"text":"继续"}')));
  ok('[3] 连发两次相同内容都被放行（不能按内容判重放）',
    a.length === 1 && b.length === 1, `${a.length} / ${b.length}`);
  ok('[3] 没有误记成重放', up.replayed === 0, String(up.replayed));
}

// ── 4. 被改过的密文（文本帧）→ 拒收 ─────────────────────────────────────────
//
// 客户端的 pwa/e2ee.js 只对字符串加密，加密结果是 ArrayBuffer ——
// 所以加密连接上**根本不该出现明文文本帧**。解不开的文本帧收下只会
// 把垃圾喂给电脑，拒收。
//
// Every application data frame must authenticate, including the first one.
{
  const up = new WsCrypto(SECRET, 'decrypt');
  // 先来一帧正常的，让连接「确认是加密链路」
  const warm = payloads(up.push(clientFrame('{"method":"initialize"}')));
  ok('[4] 前置：正常帧已解开（连接确认为加密）', warm.length === 1 && up.decryptedOk === 1);

  const out = payloads(up.push(clientFrame('{"method":"turn/start"}', { binary: false, mangle: true })));
  ok('[4] 改过的密文（文本帧）被拒收', out.length === 0, JSON.stringify(out));
  ok('[4] 计数记下了拒收', up.rejected === 1, String(up.rejected));
}

// ── 4b. 首条应用消息也必须通过认证；HTTP 握手在外层处理 ──────────────────
{
  const up = new WsCrypto(SECRET, 'decrypt');
  const out = payloads(up.push(clientFrame('{"handshake":1}', { binary: false, mangle: true })));
  ok('[4b] 未认证首帧拒收', out.length === 0, JSON.stringify(out));
  ok('[4b] 记入拒收', up.rejected === 1 && up.undecryptable === 1,
    `rejected=${up.rejected} undecryptable=${up.undecryptable}`);
}

// ── 5. 二进制 opcode 不能豁免密文认证 ──────────────────────────────────
{
  const up = new WsCrypto(SECRET, 'decrypt');
  const out = payloads(up.push(clientFrame('{"method":"turn/start"}', { binary: true, mangle: true })));
  ok('[5] 篡改的二进制帧拒收', out.length === 0, JSON.stringify(out));
  ok('[5] 记入解密失败和拒收', up.undecryptable === 1 && up.rejected === 1,
    `undecryptable=${up.undecryptable} rejected=${up.rejected}`);
  ok('[5] 放行的内容不是被篡改后的明文',
    out.length === 0, 'no forwarded payload');
}

// ── 6. 断线重连后重放 → 仍然拦住 ────────────────────────────────────────────
//
// 只按「连接」记是不够的：攻击者等你重连一次就能重放。所以按密钥作用域记。
{
  const frame = clientFrame('{"method":"turn/start","clientUserMessageId":"q2"}');
  const conn1 = new WsCrypto(SECRET, 'decrypt');
  const first = payloads(conn1.push(frame));
  const conn2 = new WsCrypto(SECRET, 'decrypt');     // 模拟重连：新对象、同一密钥
  const replayed = payloads(conn2.push(frame));
  ok('[6] 重连前正常放行', first.length === 1);
  ok('[6] 重连后重放同一帧仍被丢弃', replayed.length === 0, JSON.stringify(replayed));
  ok('[6] 新连接上也记到了重放', conn2.replayed === 1, String(conn2.replayed));
}

// ── 7. 换了密钥就不该受影响 ────────────────────────────────────────────────
//
// 作用域必须按密钥分。混在一起的话，换密钥之后所有人都会被误判成重放。
{
  const up = new WsCrypto(OTHER_SECRET, 'decrypt');
  const out = payloads(up.push(clientFrame('{"method":"turn/start"}', { secret: OTHER_SECRET })));
  ok('[7] 另一把密钥的帧不受影响', out.length === 1 && up.replayed === 0,
    `out=${out.length} replayed=${up.replayed}`);
}

// ── 8. 判定函数本身：按作用域隔离 ───────────────────────────────────────────
{
  const now = Date.now();
  const s1 = _scopeOf('secret-A');
  const s2 = _scopeOf('secret-B');
  ok('[8] 第一次见 → 不是重放', _noteIv(s1, 'aabbccddeeff001122334455', now) === true);
  ok('[8] 同一作用域再见 → 是重放', _noteIv(s1, 'aabbccddeeff001122334455', now) === false);
  ok('[8] 另一个作用域不受影响', _noteIv(s2, 'aabbccddeeff001122334455', now) === true);
}

// ── 9. 加密方向不该被重放判定影响 ──────────────────────────────────────────
//
// 重放判定只属于「手机→电脑」这个方向。发给手机的帧是网关自己加的密，
// 在加密方向误判会直接把下行流量掐断。
{
  const down = new WsCrypto(SECRET, 'encrypt');
  const one = down.push(wsf.buildFrame(wsf.OP_TEXT, Buffer.from('{"a":1}'), false));
  const two = down.push(wsf.buildFrame(wsf.OP_TEXT, Buffer.from('{"a":1}'), false));
  const p1 = payloads(one), p2 = payloads(two);
  ok('[9] 下行两帧相同内容都照发', p1.length === 1 && p2.length === 1, `${p1.length} / ${p2.length}`);
  ok('[9] 下行不做重放判定', down.replayed === 0, String(down.replayed));
  ok('[9] 下行密文确实是二进制帧',
    wsf.parseFrames(one).frames[0].opcode === wsf.OP_BIN);
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
