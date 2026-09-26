// 推送通知文案的语言 —— 计划 H「各语言不混排」的最后一块。
//
// 难点在于：发完成通知的是**空闲检测那条定时器**，没有请求上下文，
// 拿不到 Accept-Language / cookie。所以语言必须在「配置推送通道」那一步
// 存进配置里（那一步有请求上下文），之后每次推送读出来用。
//
// 这个测试验三件事：
//   1. targetLang() 读得到存下来的语言
//   2. 没存过时退回中文（不能返回 undefined 让上层拿到空文案）
//   3. 静态：通知的标题正文没有硬编码的漏翻（覆盖所有分支）
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const TARGETS = path.join(BASE, 'logs', 'notify-targets.json');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

console.log('\n=== 推送通知的语言 ===\n');

// 备份真实配置（这是使用者的东西，借完必须原样还回去）
const had = fs.existsSync(TARGETS);
const backup = had ? fs.readFileSync(TARGETS, 'utf8') : null;

try {
  const notify = require('./notify.js');

  // ── 1. 没配过 / 没存语言 → 退回中文 ─────────────────────────────────────
  console.log('[1] 兜底');
  if (had) fs.unlinkSync(TARGETS);
  ok('配置不存在时退回中文', notify.targetLang() === 'zh', notify.targetLang());

  fs.writeFileSync(TARGETS, JSON.stringify({ ntfy: 'https://ntfy.sh/example' }, null, 2), 'utf8');
  ok('配置里没有 lang 时退回中文', notify.targetLang() === 'zh', notify.targetLang());

  fs.writeFileSync(TARGETS, JSON.stringify({ ntfy: 'https://ntfy.sh/example', lang: 'kl' }, null, 2), 'utf8');
  ok('语言不认识时也退回中文（不能返回 undefined）', notify.targetLang() === 'zh', notify.targetLang());

  // ── 2. 存过的语言读得回来 ───────────────────────────────────────────────
  console.log('\n[2] 读回存下的语言');
  for (const lang of ['zh', 'en', 'es']) {
    fs.writeFileSync(TARGETS, JSON.stringify({ ntfy: 'https://ntfy.sh/example', lang }, null, 2), 'utf8');
    ok(`  ${lang}`, notify.targetLang() === lang, notify.targetLang());
  }

  // ── 3. 静态：通知文案没有漏翻 ───────────────────────────────────────────
  //
  // 打真通知会把消息推到使用者手机上，所以文案本身只能静态查。
  // 查的是「服务端拼的那些通知文案」有没有硬编码中文 —— 覆盖全部分支。
  console.log('\n[3] 静态：通知文案都在语言表里');
  {
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // 抠掉 NOTIFY_TEXT 表
    const start = code.indexOf('const NOTIFY_TEXT = {');
    let stripped = code;
    if (start >= 0) {
      let depth = 0, end = -1;
      for (let i = code.indexOf('{', start); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) stripped = code.slice(0, start) + code.slice(end + 1);
    }

    // 只看推送相关的那几行，别把整个文件的中文都算进来（那些不属于这条）
    const lines = stripped.split('\n').filter((l) => /pushNotification|searchParams\.get\('(title|body)'\)/.test(l));
    const left = lines.join('\n').match(/[\u4e00-\u9fff]+/g) || [];
    ok('推送的标题正文没有硬编码中文', left.length === 0,
      left.slice(0, 4).join(' / ') || `查了 ${lines.length} 行，干净`);
  }
} finally {
  // 原样还回去，并校验真的还对了
  if (had) {
    fs.writeFileSync(TARGETS, backup, 'utf8');
    ok('测试后配置已原样还原', fs.readFileSync(TARGETS, 'utf8') === backup);
  } else if (fs.existsSync(TARGETS)) {
    fs.unlinkSync(TARGETS);
    ok('测试后清理了临时配置', true);
  }
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
