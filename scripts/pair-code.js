// 配对码的「什么时候换」规则。
//
// ── 为什么单独抽一个文件 ────────────────────────────────────────────────────
// 这条规则以前根本不存在：配对码是**进程启动时现生成的**（`const PAIR_CODE =
// crypto.randomInt(...)`），所以每重启一次就换一张。
// 配对码的作用只有一个：**给一台还没登记过的新设备登记**。
// 已经连上的手机靠它自己的设备令牌（90 天滑动续期），跟配对码毫无关系 ——
// 所以「重启就换」打击的不是攻击者，是使用者自己：他在外面、手机被要求配对，
// 而电脑上那张码已经换成新的了。
//
// 现在的规则：
//   1. **不随重启更换** —— 启动时文件里那张还能用就接着用；
//   2. **签发满 90 天**后，下一次读取时发一张新的；使用次数不延长有效期；
//   3. 使用者可以在控制台点「换一个配对码」立刻换。
//
// ── 安全账（明说，别含糊） ─────────────────────────────────────────────────
// · 保密性：**零影响**。配对码从头到尾碰不到内容 —— 内容要的是地址 `#`
//   后面那把钥匙，配对码只换到一个「看得见页面、看不见内容」的设备身份。
// · 安全性：这条规则让一张 6 位码最长能活 90 天（以前最多活到下次重启）。
//   6 位数字只有约 20 bit，所以这确实是一处**放宽**，用 90 天封顶 + 既有的
//   失败限速（同来源错 5 次锁 15 分钟）把它压住。真要泄露了，拿它最多能
//   登记一台看不到任何内容的设备；里面还有「配对成功」之外的门（进门证明）
//   和那把钥匙挡着。
//
// ── 写文件的两种时机（别弄反） ──────────────────────────────────────────────
// · **启动时不能写**：看门狗偶尔会拉起第二个进程，那个进程抢不到端口、
//   随即 FATAL 退出 —— 但它退出前已经跑过模块顶层了。它要是顺手把文件写成
//   「自己那把没人认的码」，使用者照着念就是错的码（这个坑实测踩过）。
//   所以启动只**读**，写要等 listen 成功之后（见 mobile-proxy 的 writePairCodeFile）。
// · **内容没变就不写**：每次启动都重写会把文件的修改时间刷新成「现在」，
//   于是「90 天没换过」这个判据永远不成立 —— 一条永远不过期的码。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 一张配对码最长活 90 天（和手机设备令牌的有效期同一个量级）。 */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

const CODE_RE = /^[0-9]{6}$/;

/** 发一张新码。用 crypto.randomInt，不用 Math.random（可预测 = 可枚举）。 */
function generate() {
  return String(crypto.randomInt(100000, 1000000));
}

/** 读文件里那张码 + 它是什么时候发出去的。读不到、格式不对 → null。 */
function read(file) {
  try {
    const code = fs.readFileSync(file, 'utf8').trim();
    if (!CODE_RE.test(code)) return null;
    return { code, issuedAt: fs.statSync(file).mtimeMs };
  } catch (err) {
    return null;
  }
}

/** 这张码还能用吗（没超过 90 天）。 */
function isFresh(entry, now) {
  if (!entry) return false;
  return ((now === undefined ? Date.now() : now) - entry.issuedAt) < TTL_MS;
}

/**
 * 启动时用：文件里那张还新鲜就**接着用**，否则发一张新的。
 * 只返回结果，不动文件 —— 写文件要等 listen 成功（见文件顶部说明）。
 */
function loadOrCreate(file, now) {
  const cur = read(file);
  if (isFresh(cur, now)) return { code: cur.code, reused: true, issuedAt: cur.issuedAt };
  let code;
  do { code = generate(); } while (cur && code === cur.code);
  return { code, reused: false, issuedAt: null };
}

/**
 * 网关运行期间每次读取当前配对码都走这里。到期后立刻换码并落盘，
 * 不依赖网关重启；同一张未过期的码不重写文件，因此使用不会延长签发期。
 */
function current(file) {
  const old = read(file);
  if (isFresh(old)) return { code: old.code, reused: true, issuedAt: old.issuedAt };
  let code;
  do { code = generate(); } while (old && code === old.code);
  writeIfChanged(file, code);
  const saved = read(file);
  if (!saved || saved.code !== code) throw new Error('Could not persist pairing code');
  return { code, reused: false, issuedAt: saved.issuedAt };
}

/** 内容真的变了才写。返回是否写了。 */
function writeIfChanged(file, code) {
  const cur = read(file);
  if (cur && cur.code === code) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return true;
}

/** 立刻换一张（控制台按钮走这里）。写文件是安全的 —— 调用时进程肯定活着。 */
function rotate(file) {
  const old = read(file);
  let code;
  do { code = generate(); } while (old && code === old.code);
  writeIfChanged(file, code);
  return code;
}

module.exports = { TTL_MS, generate, read, isFresh, loadOrCreate, current, writeIfChanged, rotate };
