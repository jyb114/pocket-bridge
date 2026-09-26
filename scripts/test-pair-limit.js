// DSH 移动端网关 — 配对码限速测试
//
// 配对码只有 6 位数字，必须确认连续猜错会被锁住，
// 否则它在公网上就是一个可以被慢慢枚举的入口。
'use strict';

const fs = require('fs');

const [, , baseUrl, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['baseUrl', 'logFile'],
  'node scripts/test-pair-limit.js <baseUrl> <logFile>');

(async () => {
  const out = { ranAt: new Date().toISOString(), baseUrl, attempts: [] };

  try {
    for (let i = 1; i <= 8; i++) {
      // 用明显不是真实配对码的数字
      const guess = String(900000 + i);
      const res = await fetch(`${baseUrl}/pair?code=${guess}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000)
      });
      await res.text();
      out.attempts.push({ n: i, guess, status: res.status });

      if (res.status === 429) {
        out.lockedAtAttempt = i;
        out.retryAfter = res.headers.get('retry-after');
        break;
      }
    }

    out.locked = out.lockedAtAttempt !== undefined;
    out.passed = out.locked && out.lockedAtAttempt <= 6;
    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
  }

  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
