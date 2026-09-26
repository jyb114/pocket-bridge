// 验证浏览器端和电脑端的加密**互相能解开对方的东西**。
//
// 这一步是整个加密方案的命门：两边算法一致才有意义。
// 只测「自己加密自己解密」是不够的 —— 那种测试两边都错了也能通过。
//
// 所以：Node 加密 → 浏览器解密；浏览器加密 → Node 解密。双向都要过。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const e2ee = require('./e2ee.js');
const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

// 内网地址现探测 —— 写死的话 DHCP 一换地址这个测试就红，
// 报的还是「Failed to fetch」，看不出是地址过期了。
const LAN_IP = (() => {
  try {
    const v4 = require('./config.js').detectNetwork().lanV4;
    return v4.length ? v4[0].address : '127.0.0.1';
  } catch (e) { return '127.0.0.1'; }
})();
const HTTPS_PORT = (() => {
  try { return Number(fs.readFileSync(path.join(__dirname, '..', 'logs', 'https-port.txt'), 'utf8').trim()) || 8081; }
  catch (e) { return 8081; }
})();
const ORIGIN = `https://${LAN_IP}:${HTTPS_PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 端到端加密：两端互通验证 ===\n');

  // 固定的长期密钥，避免随机性影响判断
  const SECRET = 'test-longterm-secret-abcdefghijklmn';
  const SLOT = e2ee.slotAt();
  const keys = e2ee.deriveKeys(SECRET, SLOT);

  const SAMPLES = [
    'hello',
    '中文内容测试',
    '包含 emoji 🎉🔒 和符号 !@#$%^&*()',
    'a'.repeat(5000),                       // 大一点的
    JSON.stringify({ type: 'turn/start', text: '多行\n文本\n第三行' })
  ];

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  try {
    // 走内网加密那条路 —— crypto.subtle 只在安全上下文可用。
    // 注意要停在**工作台页面**（走注入的那条），不要停在 /go ——
    // /go 是我们自己的静态页，不会被注入脚本标签。
    await p.send('Security.setIgnoreCertificateErrors', { ignore: true });
    await p.goto(`${ORIGIN}/k/${key}`, 200);
    await p.goto(`${ORIGIN}/?target=dsh`, 3000);

    // 先确认文件本身取得到
    const served = await p.eval(`fetch('/e2ee.js').then(r => r.status + ':' + r.text().then(t => t.indexOf('DshE2EE') >= 0))`);
    console.log(`      /e2ee.js → ${served}`);

    const loaded = await p.eval(`typeof window.DshE2EE !== 'undefined' && window.DshE2EE.available()`);
    ok('浏览器端加载了加密模块', loaded === true, String(loaded));

    if (loaded !== true) {
      console.log('\n  （模块没加载 —— 检查 /e2ee.js 有没有被伺服）');
    } else {
      // ── 1. 两边派生出的密钥必须一样 ────────────────────────────────
      const derived = await p.eval(`(async () => {
        const k = await window.DshE2EE.deriveKeys(${JSON.stringify(SECRET)}, ${SLOT});
        return { a: window.DshE2EE.bytesToB64url(k.a), b: window.DshE2EE.bytesToB64url(k.b) };
      })()`);
      ok('浏览器派生出的密钥A 与 Node 一致',
        derived.a === keys.a.toString('base64url'),
        `浏览器 ${derived.a.slice(0, 16)}… / Node ${keys.a.toString('base64url').slice(0, 16)}…`);
      ok('浏览器派生出的密钥B 与 Node 一致',
        derived.b === keys.b.toString('base64url'));

      // ── 2. Node 加密 → 浏览器解密 ────────────────────────────────
      let nodeToBrowserOk = 0;
      for (const s of SAMPLES) {
        const ct = e2ee.encrypt(keys.b, s).toString('base64url');
        const back = await p.eval(`window.DshE2EE.decryptFromB64(
          window.DshE2EE.b64urlToBytes(${JSON.stringify(derived.b)}), ${JSON.stringify(ct)})`);
        if (back === s) nodeToBrowserOk++;
        else console.log(`      失败样本: ${s.slice(0, 30)}… → ${String(back).slice(0, 30)}`);
      }
      ok('Node 加密 → 浏览器解密（全部样本）',
        nodeToBrowserOk === SAMPLES.length, `${nodeToBrowserOk}/${SAMPLES.length}`);

      // ── 3. 浏览器加密 → Node 解密 ────────────────────────────────
      let browserToNodeOk = 0;
      for (const s of SAMPLES) {
        const ct = await p.eval(`window.DshE2EE.encryptToB64(
          window.DshE2EE.b64urlToBytes(${JSON.stringify(derived.a)}), ${JSON.stringify(s)})`);
        const back = e2ee.decrypt(keys.a, Buffer.from(ct, 'base64url'));
        if (back && back.toString('utf8') === s) browserToNodeOk++;
        else console.log(`      失败样本: ${s.slice(0, 30)}…`);
      }
      ok('浏览器加密 → Node 解密（全部样本）',
        browserToNodeOk === SAMPLES.length, `${browserToNodeOk}/${SAMPLES.length}`);

      // ── 4. 密文里不能出现明文 ────────────────────────────────────
      const visible = e2ee.encrypt(keys.a, '这是一段绝不该出现在密文里的中文');
      ok('密文里看不到明文', visible.toString('utf8').indexOf('绝不该出现') < 0);

      // ── 5. 错的密钥解不开 ────────────────────────────────────────
      const wrong = e2ee.deriveKeys(SECRET, SLOT + 999);
      ok('用错的时间段密钥解不开', e2ee.decrypt(wrong.a, visible) === null);

      // ── 6. 候选密钥能覆盖时钟偏差 ────────────────────────────────
      const cands = e2ee.candidateKeys(SECRET);
      ok('候选密钥含当前时间段（容忍时钟偏差）',
        cands.some((c) => e2ee.decrypt(c.a, visible) !== null));

      const errs = p.exceptions.filter(Boolean);
      ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
    }
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
