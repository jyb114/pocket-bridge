// 目标状态文案的语言 —— 计划 H「各语言不混排」的另一半。
//
// `status().note` 显示在控制台的目标列表和启动页上；`blurb` 是「这东西是什么」
// 的说明；操作的 `message` 是点完启动/停止之后弹出来的提示。它们都是
// **服务端拼好**发给手机的，页面的 `t()` 管不到。
//
// 三类检查：
//   1. 真跑 list()，三种语言各要一次 —— 英文/西班牙文里不能有汉字
//   2. localize() 能从 key + 实参重组出来（后台缓存那条路靠它）
//   3. 静态：TEXT 表之外不许再有中文字面量（覆盖**所有**分支，
//      因为 list() 只走得到当前这台机器的那一种状态）
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const targets = require('./targets.js');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

const HAS_CJK = /[\u4e00-\u9fff]/;

(async () => {
  console.log('\n=== 目标状态文案的语言 ===\n');

  const got = {};
  for (const lang of ['zh', 'en', 'es']) {
    try { got[lang] = await targets.list({ lang }); }
    catch (err) { console.log(`  ✗ ${lang}：list() 抛错 ${err.message}`); failed++; }
  }

  // ── 1. 三种语言都不混排 ─────────────────────────────────────────────────
  console.log('[1] 三种语言的 note / blurb');
  for (const lang of ['zh', 'en', 'es']) {
    const list = got[lang];
    if (!list || !list.length) { console.log(`  · ${lang}：没有目标，跳过`); continue; }
    const text = list.map((t) => `${t.blurb || ''}|${t.note || ''}`).join(' ');
    if (lang === 'zh') {
      ok(`  zh：是中文`, HAS_CJK.test(text), text.slice(0, 50));
    } else {
      ok(`  ${lang}：没有汉字`, !HAS_CJK.test(text),
        (text.match(/[\u4e00-\u9fff]+/g) || []).slice(0, 3).join(' / ') || '干净');
    }
    ok(`  ${lang}：每条都有 blurb 和 note`, list.every((t) => t.blurb && t.note),
      list.map((t) => t.id).join(','));
  }

  // ── 2. localize() 能重组（后台缓存那条路）────────────────────────────────
  //
  // refreshTargets() 是后台缓存，没有请求上下文、拿不到语言，
  // 所以它存的是 key + 实参；响应时靠 localize() 按请求者的语言拼出来。
  console.log('\n[2] localize()：从 key + 实参重组');
  const zhList = got.zh || [];
  if (!zhList.length) {
    console.log('  · 没有目标，跳过');
  } else {
    const asEn = targets.localize(zhList, 'en');
    const asZh = targets.localize(zhList, 'zh');
    ok('  中文那份保持中文', HAS_CJK.test(asZh.map((t) => t.blurb || '').join('')));
    ok('  同一份数据转成英文后没有汉字',
      !HAS_CJK.test(asEn.map((t) => `${t.blurb}|${t.note}`).join(' ')),
      asEn.map((t) => t.note).join(' / '));
    // 端口号是实参，重组之后要还在
    const withPort = zhList.find((t) => t.noteArgs && t.noteArgs.port);
    if (withPort) {
      const en = asEn.find((t) => t.id === withPort.id);
      ok('  实参（端口号）在重组后仍然出现',
        String(en.note).includes(String(withPort.noteArgs.port)), en.note);
    } else {
      console.log('  · 当前没有带端口号的目标，跳过实参那条');
    }
  }

  // ── 3. 静态：用户可见的文案里没有漏翻 ───────────────────────────────────
  //
  // list() 只走得到**这台机器当前那一种状态**（装了/在跑/端口多少）。
  // 其余分支的文案改错了它看不出来，所以再扫一遍源码 —— 覆盖所有分支。
  //
  // `source` 是**唯一**被排除的东西，理由要写清楚（不写清楚就等于偷偷放水）：
  // 它是「这个可执行文件是从哪找到的」这种排查用的元数据，
  // 只出现在日志里 —— `console.html` 和 `go.html` 里没有任何一处读它。
  // 排除是**按字段名**做的（只放过 `source:` 赋值），不是「忽略所有中文」；
  // 而且被排除的会**列出来**，不静默吞掉。
  console.log('\n[3] 静态检查：用户可见的文案没有漏翻');
  {
    const raw = fs.readFileSync(path.join(BASE, 'scripts', 'targets.js'), 'utf8');
    let code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // 抠掉整张 TEXT 表（按大括号配对）
    const start = code.indexOf('const TEXT = {');
    let stripped = code;
    if (start >= 0) {
      let depth = 0, end = -1;
      for (let i = code.indexOf('{', start); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) stripped = code.slice(0, start) + code.slice(end + 1);
    }

    // 排除**只发给日志**的东西，判据写在下面：
    //   · `source:` 字段 —— 「可执行文件是从哪找到的」，只出现在日志里
    //   · `log(...)` / `console.*(...)` —— 服务端自己的日志，本来就不发给手机
    // 这两类都**列出来并计数**，不静默吞掉：不写清楚就等于偷偷放水，
    // 而一个「看不出排除了什么」的检查，下次真漏了也没人会注意。
    const NON_USER = /(^|[^.\w])log\(|source:|console\.(log|error|warn)\(/;
    const excluded = [];
    const kept = stripped.split('\n').filter((line) => {
      if (!/[\u4e00-\u9fff]/.test(line)) return false;
      if (NON_USER.test(line)) { excluded.push(line.trim()); return false; }
      return true;
    });
    const left = kept.join('\n').match(/[\u4e00-\u9fff]+/g) || [];
    ok('  用户可见的文案里没有中文字面量', left.length === 0, left.slice(0, 5).join(' / ') || '干净');
    ok('  排除的都是日志类（source / log / console）', excluded.length > 0,
      `排除了 ${excluded.length} 行：${excluded.slice(0, 2).map((l) => l.slice(0, 28)).join(' ; ')}…`);
  }

  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
