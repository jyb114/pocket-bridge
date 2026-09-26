// DSH 移动端网关 — 「电脑自己开的窗口」判定测试
//
// 要防的是一个真实发生过、而且从界面上完全看不出来的 bug：
// 每在电脑上打开一次控制台，设备列表里就多一台「Windows · Edge」。
// 使用者看到的是「已经连上的手机：共 23 台，其中 22 台现在能用」——
// 22 台全是他自己的浏览器窗口，唯一那台真手机埋在中间。
//
// 这里要验两件事，第二件比第一件重要得多：
//   1. 本机留下的记录能被认出来；
//   2. **真手机不会被误判成本机** —— 误判会把手机从列表里藏起来，
//      那比留着几条垃圾严重得多。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const DEVICES_FILE = path.join(LOG_DIR, 'devices.json');
const sessions = require('./sessions.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

// ── 先从这台机器的真实环境里取判据，测试才有意义 ────────────────────────────
const own = [];
for (const name of Object.keys(os.networkInterfaces())) {
  for (const x of os.networkInterfaces()[name] || []) {
    if (x && x.address && x.family !== 'IPv6' && !x.internal) own.push(x.address);
  }
}
const ownV4 = own[0];
if (!ownV4) {
  console.log('这台机器没有内网 IPv4 地址，跳过（判定依赖它）。');
  process.exit(0);
}

let egress = null;
try {
  const j = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'egress.json'), 'utf8'));
  egress = ((j && j.value) || {}).ipv6 || ((j && j.value) || {}).ipv4 || null;
} catch (err) { /* 没探测过就少验一条 */ }

// 「别的机器的内网地址」—— 把最后一段换掉，保证不等于本机地址
const otherLan = ownV4.replace(/\.\d+$/, '.99');
const TUNNEL = 'example-tunnel.trycloudflare.com';

console.log(`\n=== 本机记录判定 · 单元测试 ===`);
console.log(`本机内网地址 ${ownV4}，模拟手机地址 ${otherLan}`);
console.log(`本机公网出口 ${egress || '（没探测过，跳过相关断言）'}\n`);

// ── 备份真实设备表，测完原样还原 ────────────────────────────────────────────
// 这个测试只写合成数据，但用的是**同一个文件**。万一中途抛异常，
// 使用者真实的设备登记就没了 —— 那意味着手机被踢下线。
let backup = null, had = false;
try { backup = fs.readFileSync(DEVICES_FILE, 'utf8'); had = true; } catch (err) { }

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  try {
    if (had) fs.writeFileSync(DEVICES_FILE, backup, 'utf8');
    else fs.unlinkSync(DEVICES_FILE);
  } catch (err) { /* 退出路径上没法再报错 */ }
};
process.on('exit', restore);
process.on('uncaughtException', (err) => {
  console.log(`\n  未捕获异常: ${err.message}`);
  restore();
  process.exitCode = 1;
});

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const rec = (label, ip, authority, minAgo) => ({
  id: 'x' + Math.random().toString(36).slice(2, 10),
  label, ua: '', createdAt: iso(minAgo), lastSeenAt: iso(minAgo),
  lastIp: ip, authority,
  expiresAt: Date.now() + 86400000, revokedAt: null, fp: 'fp'
});

const samples = [
  // ── 应当判为「本机自己」的 ──────────────────────────────────────────────
  ['本机 · 内网地址自己连自己',      rec('Windows · Edge', ownV4, `${ownV4}:8080`, 5), true],
  ['本机 · 旧 IP 的老记录',          rec('Windows · Edge', '10.9.9.9', '10.9.9.9:8080', 60), true],
  ['本机 · 回环 + 合成主机名',       rec('未知设备（127.0.0.1）', '127.0.0.1', 'test.invalid:8080', 90), true],
  ['本机 · 回环 + 内网 authority',   rec('未知设备（127.0.0.1）', '127.0.0.1', `${ownV4}:8081`, 90), true],

  // ── 绝不能判成本机的（判错的代价是把真手机藏起来） ────────────────────────
  ['手机 · 局域网另一台设备',        rec('iPhone · Safari', otherLan, `${ownV4}:8080`, 3), false],
  ['手机 · 安卓在局域网',            rec('Android · Chrome', otherLan, `${ownV4}:8081`, 4), false],
  ['手机 · 认不出来的设备',          rec('未知设备（' + otherLan + '）', otherLan, `${ownV4}:8080`, 4), false],
  ['手机 · 来源地址为空',            rec('iPhone · Safari', null, `${ownV4}:8080`, 4), false],
];

if (egress) {
  // 手机在家连隧道时，出口地址和电脑一模一样 —— 这一条是「只比 IP」那种写法
  // 会漏掉的反例，必须靠「像不像手机」这个附加条件挡住。
  samples.push(['手机 · 走隧道，出口地址和电脑相同',
    rec('iPhone · Safari', egress, TUNNEL, 2), false]);
  samples.push(['本机 · 走隧道（桌面浏览器）',
    rec('Windows · Edge', egress, TUNNEL, 6), true]);
  // ★ 这一条是实测漏过的那一类：本机用 node 的 fetch 请求自己的隧道地址，
  //   UA 是 `node`，labelFromUa 认不出来 → 设备名是「未知设备（IP）」。
  //   原来按「像不像桌面浏览器」判，它就被当成外面的设备登记了，
  //   列表里于是冒出一台「未知设备（2409:…）」——那串正是本机的公网 IPv6。
  //   现在改判「像不像手机」：认不出来的一律当本机。
  samples.push(['本机 · 走隧道但认不出客户端（node fetch）',
    rec('未知设备（' + egress + '）', egress, TUNNEL, 7), true]);
  // 反过来的边界：手机在**同一个出口**下必须仍然算真设备。
  samples.push(['手机 · 走隧道且设备名认得出是手机',
    rec('Android · Chrome', egress, TUNNEL, 8), false]);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(DEVICES_FILE, JSON.stringify({
  version: 1,
  devices: samples.map((s) => s[1])
}, null, 2), 'utf8');

// ── 1. 判定 ────────────────────────────────────────────────────────────────
console.log('[1] 逐条判定');
const listed = sessions.list();
const byId = new Map(listed.map((d) => [d.id, d]));

for (const [name, r, wantLocal] of samples) {
  const got = byId.get(r.id);
  ok(`${name} → ${wantLocal ? '本机' : '真设备'}`,
    !!got && got.local === wantLocal,
    got ? `实际 local=${got.local}` : '记录没出现在 list() 里');
}

// ── 2. 真设备一条都不能被删 ────────────────────────────────────────────────
console.log('\n[2] 清理时不能碰真设备');
const wantKeep = samples.filter((s) => !s[2]).map((s) => s[1].id);
const wantDrop = samples.filter((s) => s[2]).map((s) => s[1].id);

const res = sessions.forgetSelf();
ok(`删掉的条数正好是本机那些（期望 ${wantDrop.length}）`,
  res.removed === wantDrop.length, `实际 ${res.removed}`);

const left = sessions.list().map((d) => d.id);
ok(`真设备全部保留（期望 ${wantKeep.length} 条）`,
  wantKeep.every((id) => left.indexOf(id) >= 0),
  `剩下 ${left.length} 条`);
ok('本机记录全部清掉', wantDrop.every((id) => left.indexOf(id) < 0),
  `还留着 ${wantDrop.filter((id) => left.indexOf(id) >= 0).length} 条`);

// ── 3. 幂等 ────────────────────────────────────────────────────────────────
console.log('\n[3] 再清一次');
const res2 = sessions.forgetSelf();
ok('第二次没有可删的', res2.removed === 0, `实际删了 ${res2.removed}`);
ok('真设备数量不变', res2.kept === wantKeep.length, `实际 ${res2.kept}`);

// ── 4. list() 加字段不能影响老字段 ─────────────────────────────────────────
console.log('\n[4] 老字段还在');
const one = sessions.list()[0];
ok('id/label/active 都还在',
  !!one && typeof one.id === 'string' && typeof one.label === 'string' &&
  typeof one.active === 'boolean');

restore();
console.log(`\n  ✓ 已还原真实设备表${had ? `（${JSON.parse(backup).devices.length} 条）` : '（本来就没有）'}`);
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
