// Codex 界面的通信也要加密 —— 这一项之前是漏的。
//
// 发现经过：写语音功能时才发现 codex.html **一个外部脚本都没加载**，
// 所以 e2ee.js 从来没在这一页跑过，它的 WebSocket 一直是明文。
// 这种"某一页漏了"的问题，只有真的去检查那一页才会暴露。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const BASE = path.resolve(__dirname, '..');
const LOG = path.join(BASE, 'logs', 'proxy.log');
const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const secret = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();

// 内网地址**现探测**，不要写死。
//
// 原来这里写的是 192.168.1.3。后来 DHCP 把那台机器的地址换成了 .4，
// 这个测试就红了，报的却是「Codex 页面启用了端到端加密 ✗ {e2ee:false}」——
// 看着像加密坏了，其实连页面都没打开（那个地址已经不存在）。
// 测网络的脚本写死网络地址，本来就不该。
const LAN_IP = (() => {
  try {
    const v4 = require('./config.js').detectNetwork().lanV4;
    return v4.length ? v4[0].address : '127.0.0.1';
  } catch (e) { return '127.0.0.1'; }
})();
const HTTPS_PORT = (() => {
  try { return Number(fs.readFileSync(path.join(BASE, 'logs', 'https-port.txt'), 'utf8').trim()) || 8081; }
  catch (e) { return 8081; }
})();
const ORIGIN = `https://${LAN_IP}:${HTTPS_PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== Codex 界面的加密 ===\n');

  // 记下当前日志长度，之后只看新增的部分
  let markLen = 0;
  try { markLen = fs.statSync(LOG).size; } catch (e) { }

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });

  try {
    await p.send('Security.setIgnoreCertificateErrors', { ignore: true });
    await p.goto(`${ORIGIN}/k/${key}`, 200);
    // 带上密钥 —— 这一页现在会加载 e2ee.js 并接管 WebSocket
    await p.goto(`${ORIGIN}/codex#k=${secret}`, 3000);

    const st = await p.eval(`({
      e2ee: typeof window.DshE2EE !== 'undefined',
      on: window.__dshE2eeOn === true,
      wsPatched: !!(window.WebSocket && window.WebSocket.__dshE2ee),
      hashCleared: !/[#&]k=/.test(location.hash)
    })`);
    console.log(`      模块=${st.e2ee} 已启用=${st.on} WS已接管=${st.wsPatched} 地址已清理=${st.hashCleared}`);
    ok('Codex 页面启用了端到端加密', st.on === true && st.wsPatched === true, JSON.stringify(st));
    // ★ 断言**反过来**了：密钥必须**留在**地址栏里，不能抹掉。
    //
    //  这里原来钉的是「密钥已从地址栏抹掉」—— 那是当初刻意的取舍（怕被旁边
    //  的人瞄到）。但它有个没被想到的代价：「添加到主屏幕」和「加书签」保存
    //  的都是**当时的地址**，地址里没有密钥，存下来的就没有密钥，点开永远是
    //  空的 —— 图标删了重加多少次都没用。
    //  书签与主屏图标会丢失 # 后面的密钥。取舍反过来了：被瞄一眼是小概率；
    //  书签永久失效是必然发生的。谁把抹除逻辑加回去，这条会红。
    ok('密钥**留在**地址栏里（抹掉会让书签和主屏图标永久失效）',
      st.hashCleared === false, `hashCleared=${st.hashCleared}`);

    // 打开一个会话，让 WebSocket 真的跑起来
    await p.eval(`(async () => {
      for (let i = 0; i < 80; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(x => setTimeout(x, 400));
      }
      const it = document.querySelectorAll('.item')[0];
      if (it) it.click();
      await new Promise(x => setTimeout(x, 5000));
    })()`);

    await new Promise((r) => setTimeout(r, 3000));

    // ── 看网关日志：Codex 这条通道标注加密了吗 ──────────────────
    const fd = fs.openSync(LOG, 'r');
    const size = fs.statSync(LOG).size;
    const len = Math.max(0, size - markLen);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, markLen);
    fs.closeSync(fd);
    const fresh = buf.toString('utf8');

    const saidEncrypted = /WS Codex 通道(已启用|强制)端到端加密/.test(fresh);
    console.log(`      网关日志里确认 Codex 通道加密: ${saidEncrypted ? '有 ✓' : '没有 ✗'}`);
    ok('网关确认 Codex 通道启用了加密', saidEncrypted);

    // ── 实际字节：上行应该是二进制密文 ──────────────────────────
    const lines = fresh.split('\n').filter((l) => /WS 手机→Codex/.test(l));
    const binLines = lines.filter((l) => /op=0x2/.test(l));
    const textLines = lines.filter((l) => /op=0x1/.test(l));
    console.log(`      手机→Codex 的帧: ${lines.length} 行（二进制 ${binLines.length}，文本 ${textLines.length}）`);
    if (lines.length) {
      ok('上行是二进制密文（没有明文文本帧）', binLines.length > 0 && textLines.length === 0,
        `bin=${binLines.length} text=${textLines.length}`);
    } else {
      console.log('      （这次没抓到帧日志，可能数据太少）');
    }

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
