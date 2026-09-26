// 服务端拼的文案要按语言来 —— 计划 H「各语言不混排」的验收测试。
//
// 起因：`enumerate()` 的接口名与说明、`arrivalOf()` 的识别结果、`recommend()`
// 那段建议，都是**服务端拼好**发给手机的。页面的 `t()` 管不到它们 ——
// 英文手机上会出现整段中文。
//
// 这个测试打的是真接口（`/__routes`），三种语言各要一次，然后：
//   · 中英西三种语言下，文案不能出现**别的语言**的字
//   · 结构化结论 `adviceKind` 必须在 —— 前端靠它选样式，
//     不然又要回去对散文做子串匹配（那正是原来 `go.html` 干的事）
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

function request(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port: PORT, path: pathname,
      headers: Object.assign({ host: `127.0.0.1:${PORT}` }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (err) { }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('超时')));
  });
}

const HAS_CJK = /[\u4e00-\u9fff]/;
// 只查「明显的英文/西班牙文」—— 专有名词（WiFi、Cloudflare、IPv6）两边都有，不算
const HAS_LATIN_WORD = /\b(the|your|you|this|and|is|are|with|from|for|que|tu|está|el|la|los|las|una|con)\b/i;

(async () => {
  console.log('\n=== 服务端文案的语言 ===\n');

  // 先拿一个会话（/__routes 在认证门之后）。
  // 注意 `http.get` 不跟随重定向，所以要自己去读 set-cookie。
  const cookie = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: `/k/${KEY}`, headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
      res.resume();
      resolve((res.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
  });
  if (!cookie) { console.log('  拿不到会话，中止\n'); process.exitCode = 1; return; }

  const results = {};
  for (const lang of ['zh', 'en', 'es']) {
    const r = await request(`/__routes?lang=${lang}`, { cookie });
    if (r.status !== 200 || !r.json) {
      console.log(`  ✗ ${lang}：接口没返回（${r.status}）`);
      failed++;
      continue;
    }
    results[lang] = r.json;
  }

  // ── 1. 三种语言都拿到了结论 ─────────────────────────────────────────────
  console.log('[1] 三种语言都有建议文案与结构化结论');
  for (const lang of ['zh', 'en', 'es']) {
    const d = results[lang];
    if (!d) { ok(`  ${lang}`, false, '没数据'); continue; }
    ok(`  ${lang}：有 advice`, typeof d.advice === 'string' && d.advice.length > 0,
      (d.advice || '').slice(0, 40) + '…');
    ok(`  ${lang}：有 adviceKind（前端靠它选样式）`, typeof d.adviceKind === 'string' && !!d.adviceKind,
      String(d.adviceKind));
    ok(`  ${lang}：回显了用的是哪种语言`, d.lang === lang, String(d.lang));
  }

  // ── 2. 不该混排 ─────────────────────────────────────────────────────────
  //
  // 这是这条测试的重点：英文/西班牙文的返回里**不能有汉字**。
  console.log('\n[2] 不混排');
  for (const lang of ['en', 'es']) {
    const d = results[lang];
    if (!d) continue;
    const all = JSON.stringify({
      advice: d.advice, arrival: d.arrival, candidates: d.candidates
    });
    ok(`  ${lang}：返回里没有汉字`, !HAS_CJK.test(all),
      (all.match(/[\u4e00-\u9fff]+/g) || []).slice(0, 3).join(' / ') || '干净');
  }
  {
    const d = results.zh;
    if (d) {
      const all = JSON.stringify({ advice: d.advice, arrival: d.arrival });
      ok('  zh：确实是中文（不是被顺手换成英文）', HAS_CJK.test(all));
    }
  }

  // ── 3. 三种语言的内容确实不一样（不是同一份复制三遍）──────────────────
  console.log('\n[3] 确实是三份不同的文案');
  const advices = ['zh', 'en', 'es'].map((l) => (results[l] && results[l].advice) || '');
  ok('  三条建议互不相同', new Set(advices.filter(Boolean)).size === advices.filter(Boolean).length,
    `${new Set(advices.filter(Boolean)).size} 种`);
  const labels = ['zh', 'en', 'es'].map((l) => {
    const c = (results[l] && results[l].candidates) || [];
    return c.map((x) => x.label).join('|');
  });
  ok('  接口名也各自翻译了', new Set(labels.filter(Boolean)).size === labels.filter(Boolean).length,
    `${new Set(labels.filter(Boolean)).size} 种`);

  // ── 4. 英文返回里不该出现中文标点（比汉字更容易漏）────────────────────
  console.log('\n[4] 细节');
  for (const lang of ['en', 'es']) {
    const d = results[lang];
    if (!d) continue;
    const s = String(d.advice || '');
    ok(`  ${lang}：建议里没有中文标点`, !/[，。、（）「」：]/.test(s),
      (s.match(/[，。、（）「」：]/g) || []).join('') || '干净');
  }

  // ── 5. 静态全覆盖：zh 表之外不许再有中文字面量 ──────────────────────────
  //
  // 上面几条打的是真接口，但只走得到其中一条分支（这台机器上请求来自回环，
  // 走的是 loopback）。隧道那条分支最长、条件最多，恰恰是使用者最常看到的。
  // 与其给每条分支都造一次网络请求，不如直接扫源码 —— **覆盖的是全部分支**，
  // 而且不依赖运行环境。
  //
  // 做法：把 TEXT 里的 zh 块整段抠掉（按大括号配对），剩下还有汉字就是漏的。
  console.log('\n[5] 静态检查：zh 表之外没有中文字面量');
  {
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'routes.js'), 'utf8');
    // 只保留「代码部分」：先把注释去掉（注释里可以随便写中文）
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // 抠掉 zh 块
    const start = code.indexOf('zh: {');
    let stripped = code;
    if (start >= 0) {
      let i = code.indexOf('{', start);
      let depth = 0, end = -1;
      for (; i < code.length; i++) {
        const c = code[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) stripped = code.slice(0, start) + code.slice(end + 1);
    }
    const left = stripped.match(/[\u4e00-\u9fff]+/g) || [];
    ok('  没有漏翻的中文字面量', left.length === 0,
      left.slice(0, 5).join(' / ') || '干净');
  }

  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
