// 手机上能不能看到 DeepSeek 余额？
//
// ── 这个测试被改过一次，原因值得记下来 ──────────────────────────────────────
//
// 原来它验的是「Codex 的设置面板里有一行『DeepSeek 余额』，点它会打开充值页」。
// 那是我自作主张加的，而使用者明确要求**删掉**：
//   「你是在哪个手机设置面板？是你的还是 codex 的啊？codex 删除，复原，加在你这边」
//
// 也就是说：余额不该塞进 Codex 的界面（那是 Codex 的地盘），
// 该显示在**我们自己那套东西**里（右下角那个角标）。
//
// 代码当时改了，**测试没跟着改** —— 于是它一直红着，还被排除在 npm test 之外，
// 谁也没发现。一个红着的测试如果没人看，它就不是「发现了问题」，
// 而是「掩盖了问题」：它让「测试全绿」这句话变得不可信。
//
// 现在它验的是**商定之后**的设计：
//   1. 数据通路在（/__deepseek/balance 能返回金额）
//   2. Codex 面板里**没有**余额那一行（这是使用者明确要求的）
//   3. 余额显示在我们自己的角标上（手机上真的看得见）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

/**
 * 拿一个会话 cookie 再调接口。
 *
 * 不能直接 GET /__deepseek/balance —— 那个端点要认证，裸调返回 403
 * （「access key required」）。第一版就是这么写的，于是它报「接口没响应」，
 * 而实际上是**测试自己没带钥匙**。用自己的疏忽去指控产品，比漏测更糟。
 */
function getJsonWithSession(url, cookiePath) {
  return new Promise((resolve) => {
    const step1 = (cb) => {
      http.get(cookiePath, { timeout: 10000 }, (res) => {
        const ck = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
        res.resume();
        res.on('end', () => cb(ck));
      }).on('error', () => cb(''));
    };
    step1((ck) => {
      const req = http.get(url, { timeout: 20000, headers: { cookie: ck } }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(s)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  });
}

(async () => {
  console.log('\n=== 手机端看余额 ===\n');

  // ── 1. 数据通路 ──────────────────────────────────────────────────────────
  const j = await getJsonWithSession(`${base}/__deepseek/balance`, `${base}/k/${key}`);
  if (!j) {
    ok('余额接口有响应', false, '本地调 /__deepseek/balance 没拿到 JSON');
  } else if (j.ok && typeof j.total === 'number') {
    ok('余额接口返回了金额', true);
    console.log(`      余额: ${j.currency || 'CNY'} ${j.total}`);
    ok('余额偏低时会标出来（提醒充钱）',
      typeof j.low === 'boolean' && typeof j.empty === 'boolean',
      `low=${j.low} empty=${j.empty}`);
  } else {
    // 接口答了但没数据 —— 这**不算界面缺陷**（可能是密钥没配、网络不通），
    // 如实说出来，而不是判它失败。
    console.log(`  · 余额接口可用但没取到数: ${JSON.stringify(j).slice(0, 120)}`);
    console.log('    （多半是电脑上没配 DeepSeek 密钥或网络不通，不是界面问题）');
  }

  // ── 2/3. 界面上到底长在哪 ────────────────────────────────────────────────
  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });

  try {
    // Codex 面板：**不该**有余额那一行
    await p.goto(`${base}/k/${key}`, 100);
    await p.goto(`${base}/codex`, 200);
    const cx = await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(x => setTimeout(x, 300));
      }
      const m = document.getElementById('menu');
      if (m) m.click();
      await new Promise(x => setTimeout(x, 1200));
      const s = document.getElementById('sheet');
      const txt = s ? s.textContent : '';
      return {
        hasDsBalanceEl: !!document.getElementById('ds-balance'),
        mentionsBalance: /DeepSeek\\s*余额/.test(txt),
        sheetOpen: s ? s.classList.contains('on') : false
      };
    })()`);
    ok('Codex 面板里没有「DeepSeek 余额」那一行（使用者明确要求删掉）',
      cx.hasDsBalanceEl === false && cx.mentionsBalance === false,
      JSON.stringify(cx));

    // 我这边：角标上要真的显示金额。
    // 注意第二跳必须是 `/?target=dsh` —— 这才是真正把 DSH 页面渲染出来的入口
    // （`/k/<key>` 只是发 cookie 然后 302）。直接停在 /k/ 上等，角标不会出现。
    await p.goto(`${base}/k/${key}`, 100);
    await p.goto(`${base}/?target=dsh`, 2500);
    const badge = await p.eval(`(async () => {
      for (let i = 0; i < 40; i++) {
        const el = document.getElementById('dsh-gw-badge');
        if (el && /[¥$]\\s*\\d/.test(el.textContent)) break;
        await new Promise(x => setTimeout(x, 300));
      }
      const el = document.getElementById('dsh-gw-badge');
      return {
        found: !!el,
        text: el ? el.textContent : '',
        hasMoney: el ? /[¥$]\\s*\\d/.test(el.textContent) : false,
        inDock: el ? !!el.closest('#dsh-gw-dock') : false
      };
    })()`);
    console.log(`      角标: 「${badge.text}」`);
    ok('余额显示在我们自己的角标上（手机上看得见）', badge.found && badge.hasMoney,
      JSON.stringify(badge));
    ok('它是并进停靠栏的，不是又飘一块出来', badge.inDock === true);

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const s = await p.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', 'phone-balance.png'), Buffer.from(s.data, 'base64'));
    console.log('      截图: logs/phone-balance.png');
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
