// 手机上哪些按钮太小、点不准？
//
// iOS 人机指南要求可点区域至少 44×44 pt。手机上点不准是很实际的体验问题，
// 尤其是右侧那些拇指够得着的常用按钮。
//
// 这个脚本把两个界面上所有可点元素量一遍，列出不达标的。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const BASE = path.resolve(__dirname, '..');
const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

async function audit(p, label) {
  const r = await p.eval(`(() => {
    const sel = 'button, a, [role=button], select, input[type=submit]';
    const all = Array.from(document.querySelectorAll(sel));
    const bad = [];

    // 量的是**实际能点到的范围**，不是元素本身的尺寸。
    //
    // 为什么：热区可以靠伪元素撑开（视觉大小不变但更好点），
    // 那时候 getBoundingClientRect 还是 32×32，但它实际能接住 44×44 的点击。
    // 只看尺寸会把这类改进误判成没做。
    //
    // 真实测法：在元素四周往外戳，用 elementFromPoint 看戳到的是不是它。
    const pad = 6;
    const hitOut = (node, x, y) => {
      const el = document.elementFromPoint(x, y);
      return !!el && (el === node || node.contains(el) || el.contains(node));
    };

    for (const el of all) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;

      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      // 四条边各往外戳一点，看还认不认
      const probes = [
        [b.left - pad + 1, cy], [b.right + pad - 1, cy],
        [cx, b.top - pad + 1], [cx, b.bottom + pad - 1]
      ];
      let hit = 0;
      for (const [x, y] of probes) {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { hit++; continue; }
        if (hitOut(el, x, y)) hit++;
      }
      // 四条边都能戳到 → 有效范围至少有 (宽+12) × (高+12)
      const effW = hit === 4 ? b.width + pad * 2 : b.width;
      const effH = hit === 4 ? b.height + pad * 2 : b.height;
      if (effW >= 44 && effH >= 44) continue;

      bad.push({
        tag: el.tagName,
        id: el.id || '',
        cls: String(el.className || '').slice(0, 22),
        text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16),
        w: Math.round(b.width), h: Math.round(b.height),
        eff: Math.round(effW) + '×' + Math.round(effH),
        right: Math.round(innerWidth - b.right)
      });
    }
    return { total: all.length, bad };
  })()`);

  console.log(`\n── ${label} ──`);
  console.log(`  可点元素 ${r.total} 个，有效热区仍不达 44px 的 ${r.bad.length} 个`);
  r.bad.forEach((b) => {
    console.log(`    视觉 ${String(b.w).padStart(3)}×${String(b.h).padStart(2)}  ` +
      `有效 ${b.eff.padEnd(8)} ${b.tag}${b.id ? '#' + b.id : ''}  「${b.text}」`);
  });
  return r;
}

(async () => {
  console.log('\n=== 触控目标大小审计（iOS 下限 44px）===');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });

  try {
    await p.goto(`${base}/k/${key}`, 100);
    await p.goto(`${base}/?target=dsh`, 5000);
    await new Promise((r) => setTimeout(r, 3000));
    await audit(p, 'DSH 工作台');

    await p.goto(`${base}/codex`, 300);
    await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(x => setTimeout(x, 300));
      }
      const it = document.querySelectorAll('.item')[0];
      if (it) it.click();
      await new Promise(x => setTimeout(x, 4000));
    })()`);
    await audit(p, 'Codex 会话界面');

    // 设置面板里也看看
    await p.eval(`document.getElementById('menu').click()`);
    await new Promise((r) => setTimeout(r, 800));
    await audit(p, 'Codex 设置面板');
  } catch (err) {
    console.error('出错了:', err.message);
  } finally {
    b.kill();
  }
  console.log('');
})();
