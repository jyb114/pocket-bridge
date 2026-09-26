// 代码指纹校验（防隧道掉包 JS）—— 端到端验证。
//
// 这个机制在代码里已经存在（sw.js 里 pin 指纹 + 对不上用缓存旧版），
// 但「代码里有」不等于「真的管用」。这个测试真的去改一个文件，看它抓不抓得住。
//
// 步骤：
//   1. 打开页面 → Service Worker 装上 → 指纹 pin 住
//   2. **偷偷改掉 route.js**（加一行标记）
//   3. 重新加载 → 看手机拿到的是改过的还是原来那份
//
// 用完会把文件还原。
'use strict';

const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const BASE = path.resolve(__dirname, '..');
const TARGET = path.join(BASE, 'pwa', 'route.js');
const MARKER = '/*TAMPER-' + Date.now() + '*/';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

const original = fs.readFileSync(TARGET, 'utf8');

(async () => {
  console.log('\n=== 代码指纹校验 · 端到端 ===\n');
  console.log(`  篡改标记: ${MARKER}`);

  const b = await Browser.launch();
  const p = await b.newPage();

  try {
    // ── 1. 正常加载，让 SW 装上并把指纹 pin 住 ────────────────────────────
    //
    // ★ 必须走 /?target=dsh。装了不止一个目标时，根路径先给一个「选择要连的
    //   东西」页 —— 那一页**不注入**我们的脚本（polyfill/route/boot 都在
    //   被代理的工作台页面里）。第一版测试就是停在选择页上，
    //   于是 SW 压根没注册，白测一轮。
    console.log('\n[1] 首次加载（SW 安装 + pin 指纹）');
    await p.goto('http://127.0.0.1:8080/k/' + fs.readFileSync(
      path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim(), 3000);
    await p.goto('http://127.0.0.1:8080/?target=dsh', 6000);
    await new Promise((r) => setTimeout(r, 6000));

    const pageInfo = await p.eval(`({
      title: document.title,
      hasBoot: !!document.querySelector('script[src="/boot.js"]')
    })`);
    console.log(`      页面: ${JSON.stringify(pageInfo)}`);
    ok('确实进了工作台页（我们的脚本注入了）', pageInfo.hasBoot === true,
      JSON.stringify(pageInfo));

    const swState = await p.eval(`(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        supported: true,
        hasReg: !!reg,
        active: !!(reg && reg.active),
        controlled: !!navigator.serviceWorker.controller
      };
    })()`);
    console.log(`      Service Worker: ${JSON.stringify(swState)}`);

    if (!swState.supported || !swState.active) {
      console.log('\n  · 这个环境里 Service Worker 没起来，测不了（不算失败）');
      console.log('    注意：内网明文 HTTP 那条路上本来就没有 SW，也不需要这层。\n');
      b.kill();
      return;
    }
    ok('Service Worker 已激活', swState.active === true);

    // 让 pin 真的写进去
    const pinned = await p.eval(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return null;
      return await new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        reg.active.postMessage({ type: 'dsh-pin-status' }, [ch.port2]);
        setTimeout(() => resolve(null), 3000);
      });
    })()`);
    console.log(`      pin 状态: ${JSON.stringify(pinned)}`);

    // ── 2. 篡改 ──────────────────────────────────────────────────────────
    console.log('\n[2] 偷偷改掉 route.js（模拟隧道掉包）');
    fs.writeFileSync(TARGET, original + '\n' + MARKER + '\n', 'utf8');
    const newHash = require('crypto').createHash('sha256')
      .update(fs.readFileSync(TARGET)).digest('hex').slice(0, 12);
    console.log(`      改后文件的哈希前缀: ${newHash}`);

    // ── 3. 重新加载，看拿到的是哪一份 ────────────────────────────────────
    console.log('\n[3] 重新加载，看手机拿到的是改过的还是原来那份');
    const seen = await p.eval(`fetch('/route.js', { cache: 'no-store' })
      .then(r => r.text())
      .then(t => ({ hasMarker: t.includes(${JSON.stringify(MARKER)}), len: t.length }))
      .catch(e => ({ error: e.message }))`);
    console.log(`      页面取到的 route.js: ${JSON.stringify(seen)}`);

    ok('★ 抓到了篡改：改过的代码没有送到页面',
      seen && seen.hasMarker === false,
      seen && seen.hasMarker ? '改过的代码被执行了 —— 这层没起作用' : JSON.stringify(seen));

    // ── 4. 页面有没有把这件事告诉使用者 ──────────────────────────────────
    //
    // 等一下：Service Worker 是用 postMessage 通知页面的，不是同步的。
    // 第一版检查得太快，横幅还没来得及插进去就判定失败了。
    console.log('\n[4] 使用者能不能看到这件事');
    await new Promise((r) => setTimeout(r, 2500));
    const visible = await p.eval(`(() => {
      const t = document.body ? document.body.innerText : '';
      const bar = document.getElementById('dsh-tamper-bar');
      return {
        mentionsCheck: /校验|对不上|被改过|拦下/.test(t),
        hasBar: !!bar,
        barText: bar ? bar.innerText.slice(0, 80).replace(/\\n/g, ' ') : '',
        badge: (document.querySelector('[class*=badge],[id*=badge]') || {}).innerText || ''
      };
    })()`);
    console.log(`      页面上的提示: ${JSON.stringify(visible)}`);
    ok('★ 页面上出现了醒目提示（不是只打在控制台里）',
      visible.hasBar === true || visible.mentionsCheck === true,
      '只打在 console 里 —— 使用者永远看不到');
    ok('提示里说明了发生了什么', /被改过|拦下|对不上/.test(visible.barText || visible.badge || ''),
      String(visible.barText));

    // ── 5. 「我刚更新过，信任新版本」能不能解开死锁 ────────────────────────
    //
    // 这一段是这次修复的核心。原来 pin 是一次写入、永不允许更新 ——
    // 防住了攻击，也把**电脑那边正常发版**一起挡了：一更新，手机就永远
    // 卡在旧代码上还弹红字。现在多了一个必须由人点的按钮。
    console.log('\n[5] 「信任新版本」能不能解开死锁');

    const hasFix = await p.eval(`(() => {
      const bar = document.getElementById('dsh-tamper-bar');
      if (!bar) return { found: false };
      const btns = Array.from(bar.querySelectorAll('button')).map(function (b) { return b.textContent; });
      return { found: true, buttons: btns };
    })()`);
    console.log(`      横幅上的按钮: ${JSON.stringify(hasFix.buttons || [])}`);
    ok('横幅上有「信任新版本」按钮',
      !!hasFix.found && (hasFix.buttons || []).some((t) => /信任新版本/.test(t)),
      JSON.stringify(hasFix.buttons));

    if (hasFix.found && (hasFix.buttons || []).some((t) => /信任新版本/.test(t))) {
      // 把 confirm 自动点"是"，然后按那个按钮
      await p.eval(`(() => {
        window.confirm = function () { return true; };
        const bar = document.getElementById('dsh-tamper-bar');
        const b = Array.from(bar.querySelectorAll('button'))
          .filter(function (x) { return /信任新版本/.test(x.textContent); })[0];
        if (b) b.click();
      })()`);
      await new Promise((r) => setTimeout(r, 3000));

      // 重新 pin 之后，**当前这一版**（也就是带标记的那份）应该被接受了
      const after = await p.eval(`fetch('/route.js', { cache: 'no-store' })
        .then(function (r) { return r.text(); })
        .then(function (t) { return { hasMarker: t.includes(${JSON.stringify(MARKER)}), len: t.length }; })
        .catch(function (e) { return { error: e.message }; })`);
      console.log(`      点完之后再取 route.js: ${JSON.stringify(after)}`);
      ok('★ 点过之后，新版本被接受了（死锁解开）',
        after && after.hasMarker === true,
        '还是被挡着 —— 那就等于"能发现被改，但没法恢复"');
    }
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    fs.writeFileSync(TARGET, original, 'utf8');
    const back = fs.readFileSync(TARGET, 'utf8') === original;
    console.log(`\n  已还原 route.js: ${back ? '✓' : '✗ 没还原成功！'}`);
    if (!back) fail++;
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
