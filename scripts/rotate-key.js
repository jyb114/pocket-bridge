// DSH 移动端网关 — 轮换访问密钥
//
// 什么时候用：怀疑密钥泄露、或者想定期更换。
//
// ★ 重要：轮换之后**所有已配对设备都要重新配对**。
//
// 这个文件原来写的是「已配对设备不受影响」—— 那是错的。
// sessions.js 的签名密钥是 `sha256('dsh-gw-device|' + 访问密钥)` 派生的，
// 密钥一换，所有设备手里的会话 cookie 立刻验不过。
// 写错的代价很实际：使用者以为换密钥只是「不让新设备进」，
// 就在外面随手换了，结果自己手机被踢出来 —— 而那时他正需要连上。
//
// 生效时机：中间层**重启之后**（ACCESS_KEY 是启动时读进内存的）。
//
// 用法：
//   node rotate-key.js                   换密钥（重启后所有设备需重新配对）
//   node rotate-key.js --revoke-sessions 额外作废本机控制台的登录态
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const cfg = require('./config.js');

const LOG_DIR = cfg.LOG_DIR;
const KEY_FILE = path.join(LOG_DIR, 'access-key.txt');
const PAIR_FILE = path.join(LOG_DIR, 'pair-code.txt');

const revokeSessions = process.argv.includes('--revoke-sessions');

function newAccessKey() {
  // 16 字符 base64url ≈ 96 位熵，枚举不可行
  const bytes = crypto.randomBytes(12);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (err) { return null; }
}

function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const oldKey = readKey();
  const key = newAccessKey();
  fs.writeFileSync(KEY_FILE, key, 'ascii');

  process.stdout.write('\n访问密钥已轮换\n');
  process.stdout.write(`  旧: ${oldKey ? oldKey.slice(0, 6) + '…' : '(无)'}\n`);
  process.stdout.write(`  新: ${key}\n\n`);

  // ★ 这里原来删的是 logs/mint-cookie.json —— 那是**删错文件**，而且会把网关弄坏。
  //
  // mint-cookie.json 存的不是「我们发的设备会话」，而是**我们替 DSH 签的登录 cookie**
  // （手机要访问 DSH，必须带上它）。它由 mint-cookie.js 从 DSH 的密钥派生出来，
  // 中间层启动时是**必需**的 —— 文件不在，中间层直接 FATAL 退出。
  //
  // 实测后果：跑一次 rotate-key.js --revoke-sessions，网关就再也起不来了，
  // 报 `FATAL 读不到会话 cookie: ENOENT`。而报错信息里完全没提这是谁干的。
  //
  // 而且这个删除本身就是多余的：设备会话的签名密钥是从访问密钥派生的
  // （见 sessions.js 的 secret()），换了密钥，所有旧 cookie 自动失效。
  // 想明确作废，正确做法是调 sessions.revokeAll()，不是删上游 cookie。
  if (revokeSessions) {
    let n = 0;
    try {
      const sessions = require('./sessions.js');
      n = sessions.revokeAll();
    } catch (err) {
      process.stdout.write(`作废设备会话失败: ${err.message}\n`);
    }
    process.stdout.write(n
      ? `已作废 ${n} 台设备的登记（它们需要重新配对）\n`
      : '没有在册设备需要作废\n');
  }

  // 设备会话无论如何都会失效（签名密钥就是从访问密钥派生的），
  // 所以这句话要照实说，不能给使用者「换了也没事」的错觉。
  process.stdout.write('\n注意：重启中间层后，所有已配对设备都需要重新配对 ——\n');
  process.stdout.write('      会话签名密钥由访问密钥派生，密钥一换，旧 cookie 全部失效。\n');

  process.stdout.write('\n接下来需要重启中间层让新密钥生效：\n');
  process.stdout.write('  Windows     : 结束 node 进程后重新运行 start-gateway.bat\n');
  process.stdout.write('  macOS/Linux : 结束 node 进程后重新运行 ./scripts/start-gateway.sh\n');
  process.stdout.write('  或者直接跑   : node scripts/gateway-daemon.js\n\n');
}

main();
