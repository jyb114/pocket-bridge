// 挖出「电脑版 Codex 有、而手机界面还没用上」的协议部分。
//
// 重点三件事：
//   1. 审批请求长什么样、要怎么应答（不应答的话，需要授权的操作会一直卡住）
//   2. 一条会话里会出现哪些 item 类型（决定渲染要覆盖哪些）
//   3. 流式输出有哪些 delta 通知（决定「边跑边看」能做到多细）
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

function paramsOf(oneOf, method) {
  for (const x of oneOf || []) {
    const m = x.properties && x.properties.method && x.properties.method.enum &&
      x.properties.method.enum[0];
    if (m === method) return x.properties.params;
  }
  return null;
}

function showDef(name, indent = '    ') {
  let d = null;
  for (const f of ['codex_app_server_protocol.v2.schemas.json',
    'codex_app_server_protocol.schemas.json']) {
    try {
      const j = read(f);
      const defs = j.definitions || j.$defs || {};
      if (defs[name]) { d = defs[name]; break; }
    } catch (e) { /* 没有这个文件 */ }
  }
  if (!d) { console.log(`${indent}（找不到定义 ${name}）`); return; }
  console.log(`${indent}必填: ${(d.required || []).join(', ') || '（无）'}`);
  for (const [k, v] of Object.entries(d.properties || {})) {
    let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
    if (!t && v.anyOf) {
      t = v.anyOf.map((y) => y.type || (y.$ref || '').split('/').pop())
        .filter(Boolean).join('|');
    }
    if (v.enum) t = 'enum(' + v.enum.join(',') + ')';
    if (v.items && v.items.$ref) t = 'array<' + v.items.$ref.split('/').pop() + '>';
    const desc = v.description ? '  // ' + String(v.description).slice(0, 70) : '';
    console.log(`${indent}${String(k).padEnd(20)} ${t}${desc}`);
  }
}

console.log('\n═══ 一、服务端要客户端应答的请求 ═══\n');
const sreq = read('ServerRequest.json');
const approvals = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/tool/requestUserInput', 'execCommandApproval', 'applyPatchApproval',
  'item/permissions/requestApproval'];

for (const m of approvals) {
  const p = paramsOf(sreq.oneOf, m);
  if (!p) { console.log(`— ${m}: 找不到`); continue; }
  const ref = p.$ref ? p.$ref.split('/').pop() : null;
  console.log(`— ${m}`);
  console.log(`    params → ${ref || JSON.stringify(p).slice(0, 80)}`);
  if (ref) showDef(ref);
  console.log('');
}

console.log('\n═══ 二、item 类型（一条会话里会出现什么）═══\n');
try {
  const big = read('codex_app_server_protocol.v2.schemas.json');
  const defs = big.definitions || big.$defs || {};
  const ti = defs.ThreadItem;
  if (ti && ti.oneOf) {
    for (const v of ti.oneOf) {
      const title = v.title || (v.properties && v.properties.type &&
        v.properties.type.enum && v.properties.type.enum[0]) || '?';
      const keys = Object.keys(v.properties || {}).filter((k) => k !== 'type');
      console.log(`  ${String(title).padEnd(24)} 字段: ${keys.slice(0, 10).join(', ')}`);
    }
  } else {
    console.log('  找不到 ThreadItem 定义，把所有名字里带 Item 的定义列出来：');
    console.log('  ' + Object.keys(defs).filter((k) => /Item$/.test(k)).join('\n  '));
  }
} catch (e) { console.log('  读 schema 失败: ' + e.message); }

console.log('\n═══ 三、流式通知（边跑边看）═══\n');
const notify = read('ServerNotification.json');
const names = (notify.oneOf || []).map((x) =>
  x.properties && x.properties.method && x.properties.method.enum &&
  x.properties.method.enum[0]).filter(Boolean);
const interesting = names.filter((n) => /delta|output|progress|updated|started|completed/i.test(n));
console.log(interesting.map((n) => '  ' + n).join('\n'));
