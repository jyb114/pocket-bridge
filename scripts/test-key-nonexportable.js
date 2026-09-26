// 关键前置验证：把手机端改成「非导出密钥」之后，还能不能和电脑端互通？
//
// 背景：现在的方案是
//     secret ──HKDF-SHA256(salt=时间槽)──> 原始 32 字节 ──importKey(AES-GCM)──> 会话密钥
// 手机端（pwa/e2ee.js）用 crypto.subtle.deriveBits 拿到**原始字节**，
// 所以那把密钥是可导出的 —— 注入的脚本一行 exportKey 就能抄走，永久有效。
//
// 想改成：secret 导进 WebCrypto 时就设成 extractable=false，
// 用 deriveKey（而不是 deriveBits）直接产出**非导出**的会话密钥。
// 这样密钥字节从头到尾没进过 JavaScript。
//
// ★ 但必须先证明：deriveKey 产出的密钥 和 现在 deriveBits + importKey 产出的
//   是**同一把**。只要有一个字节不同，手机和电脑就解不开对方的消息 ——
//   那是"改完直接不能用"，比不改还糟。
//
// 用法: node scripts/test-key-nonexportable.js
'use strict';

const path = require('path');
const e2ee = require('./e2ee.js');
const { Browser } = require('./browser-check.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

const SECRET = 'INTEROP-' + require('crypto').randomBytes(12).toString('base64url');
const SLOT = e2ee.slotAt();

(async () => {
  console.log('\n=== 非导出密钥 · 与现有方案互通性 ===\n');
  console.log(`  演示密钥: ${SECRET}`);
  console.log(`  时间槽  : ${SLOT}`);

  // ── 电脑端（现有实现，不动）：deriveBits → 原始字节 ────────────────────
  const serverKeys = await e2ee.deriveKeys(SECRET, SLOT);
  console.log(`\n  电脑端上行密钥(hex 前16): ${serverKeys.a.toString('hex').slice(0, 32)}`);

  // 用电脑端的钥匙加密一条消息，交给手机端（新方案）去解
  const msg = '这条是电脑端加密的：你好，手机。';
  const wire = e2ee.encrypt(serverKeys.a, Buffer.from(msg, 'utf8'));

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8080/__health', 2000);

  const r = await p.eval(`(async () => {
    const secret = ${JSON.stringify(SECRET)};
    const slot = ${SLOT};
    const wire = new Uint8Array(${JSON.stringify(Array.from(wire))});
    const out = {};

    // ① 基石：把 secret 导成**非导出**的 HKDF 基密钥
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
    out.baseExtractable = base.extractable;

    // ② 注入的脚本想抄走它 —— 应该抄不到
    try { await crypto.subtle.exportKey('raw', base); out.stealBase = '★ 抄到了'; }
    catch (e) { out.stealBase = '被拒: ' + e.name; }

    // ③ 用 deriveKey 产出**非导出**的会话密钥（而不是 deriveBits 拿字节）
    //
    // ★ info 必须和电脑端**一个字都不差**。
    //   第一版我传了空 Uint8Array，结果两边算出来的钥匙完全不同 ——
    //   改完的话手机当场解不开任何消息。电脑端用的是方向专属的串：
    //     上行(手机→电脑) 'dsh-gw|phone->pc|v1'
    //     下行(电脑→手机) 'dsh-gw|pc->phone|v1'
    //   salt 也要一致：String(slot) 的 UTF-8 字节。
    const INFO_UP = 'dsh-gw|phone->pc|v1';
    const ses = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(String(slot)),
        info: new TextEncoder().encode(INFO_UP) },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    out.sesExtractable = ses.extractable;
    try { await crypto.subtle.exportKey('raw', ses); out.stealSes = '★ 抄到了'; }
    catch (e) { out.stealSes = '被拒: ' + e.name; }

    // ④ 关键：它解得出电脑端加密的那条消息吗？
    //    注意电脑端是 iv|tag|body，WebCrypto 要 tag 跟在密文后面，得重排
    const iv = wire.slice(0, 12);
    const tag = wire.slice(12, 28);
    const body = wire.slice(28);
    const joined = new Uint8Array(body.length + tag.length);
    joined.set(body, 0); joined.set(tag, body.length);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, ses, joined);
      out.decrypted = new TextDecoder().decode(pt);
    } catch (e) { out.decrypted = 'ERR ' + e.name + ': ' + e.message; }

    // ⑤ 反向：手机端加密，看电脑端能不能解
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv2 }, ses, new TextEncoder().encode('这条是手机端加密的：收到。')));
    // WebCrypto 把 tag 放末尾，转成电脑端的 iv|tag|body
    const b2 = ct.slice(0, ct.length - 16);
    const t2 = ct.slice(ct.length - 16);
    const outBuf = new Uint8Array(12 + 16 + b2.length);
    outBuf.set(iv2, 0); outBuf.set(t2, 12); outBuf.set(b2, 28);
    out.wireBack = Array.from(outBuf);

    // ⑥ 顺带确认 HKDF 的 info 用空串 —— 要和电脑端一致
    out.note = 'info 用空 Uint8Array，salt 用 String(slot) 的 UTF-8 字节';
    return out;
  })()`);

  console.log('\n  手机端（新方案）：');
  console.log(`    基密钥可导出吗        : ${r.baseExtractable}  ${r.stealBase}`);
  console.log(`    会话密钥可导出吗      : ${r.sesExtractable}  ${r.stealSes}`);
  console.log(`    解电脑端发来的消息    : ${JSON.stringify(r.decrypted)}`);

  ok('基密钥不可导出（注入脚本抄不走 secret）', r.baseExtractable === false && /被拒/.test(r.stealBase));
  ok('会话密钥不可导出', r.sesExtractable === false && /被拒/.test(r.stealSes));
  ok('★ 新方案能解开电脑端加密的消息（算法互通）', r.decrypted === msg,
    JSON.stringify(r.decrypted));

  // 反向验证
  if (r.wireBack) {
    let back = null;
    try { back = e2ee.decrypt(serverKeys.a, Buffer.from(r.wireBack)).toString('utf8'); }
    catch (err) { back = 'ERR ' + err.message; }
    console.log(`    电脑端解手机端的消息  : ${JSON.stringify(back)}`);
    ok('★ 电脑端能解开新方案加密的消息（双向互通）', back === '这条是手机端加密的：收到。',
      JSON.stringify(back));
  }

  b.kill();
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  console.log(fail === 0
    ? '  结论：可以安全地改。算法互通，而且改完注入的脚本再也抄不走长期密钥。\n'
    : '  结论：不能直接改，先解决上面的不一致。\n');
  process.exitCode = fail ? 1 : 0;
})();
