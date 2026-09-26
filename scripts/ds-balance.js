#!/usr/bin/env node
// 查 DeepSeek 还剩多少钱 —— 给「正在干活的 AI」用的。
//
// 为什么单独做一个：使用者要的不是界面上多一行数字，而是**干活的我能知道自己
// 还剩多少钱**。额度快没了的时候，我应该主动说一句，而不是闷头跑到一半失败。
//
// 用法：
//   node scripts/ds-balance.js          一行摘要
//   node scripts/ds-balance.js --json   给程序读的
//   node scripts/ds-balance.js --quiet  只输出数字（脚本里用）
//
// 退出码：0 正常；2 余额偏低（< 10）；3 已用完；1 查询失败。
'use strict';
const path = require('path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

(async () => {
  let r;
  try {
    r = await require(path.join(__dirname, 'deepseek.js')).balance(true);
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }));
    else console.error('查询失败: ' + err.message);
    process.exitCode = 1;
    return;
  }

  if (!r.ok) {
    if (asJson) console.log(JSON.stringify(r));
    else console.error('查询失败: ' + r.error);
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else if (quiet) {
    console.log(r.total.toFixed(2));
  } else {
    const sym = r.currency === 'CNY' ? '¥' : r.currency + ' ';
    console.log(`DeepSeek 余额 ${sym}${r.total.toFixed(2)}` +
      (r.granted > 0 ? `（含赠送 ${sym}${r.granted.toFixed(2)}）` : '') +
      (r.empty ? '  —— 已用完，需要充值'
        : r.low ? '  —— 偏低，建议充值' : ''));
  }

  // 用 exitCode 而不是 process.exit()。
  //
  // 直接 process.exit() 会和 fetch 那条 keep-alive 连接的清理抢时序，
  // 在 Windows 上表现为 libuv 断言崩溃、退出码变成一个乱七八糟的负数
  // （实测 -1073740791）—— 调用方就没法靠退出码判断余额状态了。
  // 设 exitCode 再自然返回，Node 会自己收拾干净。
  process.exitCode = r.empty ? 3 : (r.low ? 2 : 0);
})();
