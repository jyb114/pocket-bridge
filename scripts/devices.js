// DSH 移动端网关 — 看看有哪些设备连着，以及把某一台关在门外
//
// 为什么需要它：访问密钥是所有设备共用的一把锁。手机丢了的时候，
// 「换钥匙」会把所有设备一起踢掉，而你可能只是想踢掉那一台。
//
// 用法:
//   node scripts/devices.js                列出所有设备
//   node scripts/devices.js --active       只看还在用的
//   node scripts/devices.js --revoke <id>  注销某一台（id 可以只写前几位）
//   node scripts/devices.js --revoke-all   全部注销
//   node scripts/devices.js --prune        清掉 30 天前注销的记录
'use strict';

const path = require('path');
const sessions = require(path.join(__dirname, 'sessions.js'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.round(h / 24);
  if (day < 30) return `${day} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function daysLeft(expiresAt) {
  if (typeof expiresAt !== 'number') return '—';
  const d = Math.ceil((expiresAt - Date.now()) / 86400000);
  if (d <= 0) return '已过期';
  return `${d} 天`;
}

if (has('--prune')) {
  const n = sessions.prune();
  console.log(n ? `清掉了 ${n} 条已注销的记录。` : '没有需要清理的记录。');
  process.exit(0);
}

if (has('--revoke-all')) {
  const n = sessions.revokeAll();
  console.log(`已注销 ${n} 台设备。它们下次访问都需要重新配对。`);
  console.log('注意：这只影响已配对的设备，访问密钥本身没变。');
  process.exit(0);
}

const target = valueOf('--revoke');
if (target) {
  const all = sessions.list();
  // 允许只写 id 前几位 —— 那串随机 id 没人愿意完整敲一遍
  const hits = all.filter((d) => d.id === target || d.id.startsWith(target));
  if (hits.length === 0) {
    console.log(`没有找到匹配「${target}」的设备。用 node scripts/devices.js 看 id。`);
    process.exitCode = 1;
  } else if (hits.length > 1) {
    console.log(`「${target}」匹配到 ${hits.length} 台，请多写几位：`);
    for (const h of hits) console.log(`  ${h.id}  ${h.label}`);
    process.exitCode = 1;
  } else {
    const r = sessions.revoke(hits[0].id);
    console.log(r.ok
      ? `已注销「${r.label}」。那台设备下次访问时会要求重新配对。`
      : `没能注销：${r.reason}`);
    process.exitCode = r.ok ? 0 : 1;
  }
  process.exit(process.exitCode || 0);
}

// ── 默认：列出设备 ────────────────────────────────────────────────────────────
const list = sessions.list({ activeOnly: has('--active') });

console.log('\nDSH 移动端网关 — 已配对的设备');
console.log('='.repeat(72));

if (list.length === 0) {
  console.log('  还没有设备配对过。');
  console.log('  在手机上打开配对页、输入配对码之后，这里就会出现那台设备。\n');
  process.exit(0);
}

const active = list.filter((d) => d.active);
console.log(`  共 ${list.length} 台，其中 ${active.length} 台有效\n`);

for (const d of list) {
  const state = d.revoked ? '已注销' : (d.active ? '有效' : '已过期');
  const mark = d.revoked ? '✗' : (d.active ? '●' : '○');
  console.log(`  ${mark} ${d.label}`);
  console.log(`      id       ${d.id}`);
  console.log(`      状态     ${state}${d.revoked ? `（${fmtTime(d.revokedAt)}注销）` : `　有效期还剩 ${daysLeft(d.expiresAt)}`}`);
  console.log(`      首次配对 ${fmtTime(d.createdAt)}`);
  console.log(`      最后出现 ${fmtTime(d.lastSeenAt)}${d.lastIp ? `　来自 ${d.lastIp}` : ''}`);
  console.log('');
}

console.log('='.repeat(72));
console.log('  注销某一台:  node scripts/devices.js --revoke <id 前几位>');
console.log('  全部注销:    node scripts/devices.js --revoke-all');
console.log('  换掉访问密钥: node scripts/rotate-key.js --revoke-sessions');
console.log('    （最后这条才是「彻底锁门」—— 它会换钥匙并让所有设备重新配对）\n');
