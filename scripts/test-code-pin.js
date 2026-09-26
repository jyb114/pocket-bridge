// 代码指纹 pin + 校验 —— 端到端加密的第二层。
//
// 第一层（内容加密）挡住隧道「偷看」；这一层挡住隧道「把发给手机的 JS 换掉」——
// 换掉的代码可以在明文还没加密时抄一份，或者直接把密钥传出去。
// 做加密的那段代码，本身也是从隧道送来的。
//
// 必须走隧道：Service Worker 要求受信任的证书，自签证书会让注册直接失败
// （'An SSL certificate error occurred'），--ignore-certificate-errors 对 SW 不管用。
// 好在代码 pin 要防的本来就是隧道 —— 内网那条路没有第三方，不需要它。
//
// 怎么模拟「代码被掉包」：直接改磁盘上的文件（网关就会发新内容）。
// 效果和中间人改包一样，而且不用去摆弄 CDP 事件订阅。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const BASE = path.resolve(__dirname, '..');
const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const secret = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();
const TUN = fs.readFileSync(path.join(BASE, 'logs', 'last-tunnel-url.txt'), 'utf8').trim();
const TARGET = path.join(BASE, 'pwa', 'compat.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  + ' + n); }
  else { fail++; console.log('  x ' + n + (e ? '  -> ' + e : '')); }
};

(async () => {
  console.log('\n=== 代码指纹 pin 与校验（走隧道）===\n');
  console.log('  隧道: ' + TUN);

  const original = fs.readFileSync(TARGET);          // 备份，测完必须还原
  const b = await Browser.launch();
  const p = await b.newPage();

  try {
    await p.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await p.goto(TUN + '/k/' + key, 1000);
    await p.goto(TUN + '/?target=dsh#k=' + secret, 5000);

    const swState = await p.eval(`(async () => {
      if (!('serviceWorker' in navigator)) return { ok: false, why: '浏览器不支持' };
      const timeout = new Promise(r => setTimeout(() => r({ ok: false, why: '等超时' }), 12000));
      const ready = navigator.serviceWorker.ready.then(reg => ({ ok: !!reg.active, scope: reg.scope }));
      return Promise.race([ready, timeout]);
    })()`);
    console.log('      Service Worker: ' + JSON.stringify(swState));
    ok('Service Worker 已就绪', swState.ok === true, JSON.stringify(swState));
    if (!swState.ok) { b.kill(); process.exitCode = 1; return; }

    await new Promise((r) => setTimeout(r, 3000));

    const status = await p.eval(`(async () => {
      const reg = await navigator.serviceWorker.ready;
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), 6000);
        navigator.serviceWorker.addEventListener('message', function h(ev) {
          if (ev.data && ev.data.type === 'dsh-pin-status-result') {
            clearTimeout(t);
            navigator.serviceWorker.removeEventListener('message', h);
            resolve(ev.data);
          }
        });
        reg.active.postMessage({ type: 'dsh-pin-status' });
      });
    })()`);
    console.log('      pin 状态: ' + JSON.stringify(status));
    ok('代码指纹已 pin 住', status.pinned === true, JSON.stringify(status));
    ok('pin 了足够多的文件（>=5）', (status.files || 0) >= 5, String(status.files));

    // 先正常取一次，让 SW 把好的那份缓存下来
    const before = await p.eval(`fetch('/compat.js').then(r => r.text())`);
    console.log('      /compat.js 原版: ' + before.length + ' 字节');
    ok('原版能取到', before.length > 100 && before.indexOf('__TAMPERED__') < 0);

    // ── 模拟「代码被掉包」：改磁盘上的文件 ──────────────────────
    fs.writeFileSync(TARGET, 'window.__TAMPERED__=true;/* 被掉包的代码 */\n' + original.toString('utf8'), 'utf8');
    console.log('      已把磁盘上的 compat.js 改掉（模拟中间人掉包）');

    const after = await p.eval(`fetch('/compat.js', {cache:'no-store'}).then(r => r.text()).catch(e => 'ERR:' + e.message)`);
    console.log('      浏览器实际拿到: ' + String(after).length + ' 字节');

    ok('网关那边确实换成新内容了（说明这个模拟有效）',
      fs.readFileSync(TARGET, 'utf8').indexOf('__TAMPERED__') >= 0);
    ok('浏览器拿到的**不是**被掉包的那份', String(after).indexOf('__TAMPERED__') < 0,
      String(after).slice(0, 60));
    ok('浏览器拿到的是缓存里的原版',
      String(after).length === before.length,
      '拿到 ' + String(after).length + ' / 原版 ' + before.length);

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log('\n  出错了: ' + err.message);
  } finally {
    // 还原文件 —— 测试绝不能把项目改坏
    fs.writeFileSync(TARGET, original);
    const back = fs.readFileSync(TARGET, 'utf8');
    // 注意比的是**字节数**不是字符数 —— 这个文件里有中文，
    // 字符串长度（9321）和字节数（11097）不一样。上一版就是拿字符串长度
    // 去比 Buffer 长度，把一个正常的还原误报成了失败。
    ok('测完已还原 compat.js',
      back.indexOf('__TAMPERED__') < 0 && Buffer.byteLength(back) === original.length,
      '字节 ' + Buffer.byteLength(back) + ' / 原始 ' + original.length);
    b.kill();
  }

  console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
  process.exitCode = fail ? 1 : 0;
})();