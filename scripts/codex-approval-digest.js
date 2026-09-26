// 审批请求要怎么应答？找不到响应定义的话，手机端只能干看着。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');

// 在合并 schema 里按名字找定义
function findDef(name) {
  for (const f of ['codex_app_server_protocol.v2.schemas.json',
    'codex_app_server_protocol.schemas.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const defs = j.definitions || j.$defs || {};
      if (defs[name]) return defs[name];
    } catch (e) { /* 跳过 */ }
  }
  return null;
}

function dump(name, indent = '  ') {
  const d = findDef(name);
  if (!d) { console.log(`${indent}（没有 ${name}）`); return; }
  console.log(`${indent}${name}`);
  if (d.oneOf) {
    for (const v of d.oneOf) {
      const t = v.title || (v.properties && v.properties.type &&
        v.properties.type.enum && v.properties.type.enum[0]) || '?';
      const keys = Object.keys(v.properties || {}).filter((k) => k !== 'type');
      const req = (v.required || []).join(',');
      console.log(`${indent}  · ${String(t).padEnd(28)} 字段[${keys.join(', ')}] 必填[${req}]`);
    }
    return;
  }
  console.log(`${indent}  必填: ${(d.required || []).join(', ') || '（无）'}`);
  for (const [k, v] of Object.entries(d.properties || {})) {
    let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
    if (!t && v.anyOf) {
      t = v.anyOf.map((y) => y.type || (y.$ref || '').split('/').pop())
        .filter(Boolean).join('|');
    }
    if (v.enum) t = 'enum(' + v.enum.join(',') + ')';
    if (v.items && v.items.$ref) t = 'array<' + v.items.$ref.split('/').pop() + '>';
    if (v.items && v.items.enum) t = 'array<' + v.items.enum.join('|') + '>';
    console.log(`${indent}  ${String(k).padEnd(20)} ${t}`);
  }
}

console.log('\n═══ 审批的应答结构 ═══\n');
for (const n of ['CommandExecutionRequestApprovalResponse',
  'FileChangeRequestApprovalResponse',
  'ExecCommandApprovalResponse',
  'ApplyPatchApprovalResponse',
  'PermissionsRequestApprovalResponse',
  'ToolRequestUserInputResponse']) {
  dump(n);
  console.log('');
}

console.log('\n═══ 决策枚举 ═══\n');
for (const n of ['ReviewDecision', 'CommandExecutionApprovalDecision',
  'FileChangeApprovalDecision', 'AskForApproval', 'ApprovalsReviewer']) {
  dump(n);
  console.log('');
}

console.log('\n═══ 名字里带 Approval 或 Decision 的定义 ═══\n');
try {
  const j = JSON.parse(fs.readFileSync(
    path.join(DIR, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'));
  const defs = j.definitions || j.$defs || {};
  console.log(Object.keys(defs).filter((k) => /Approval|Decision|Permission/.test(k))
    .map((k) => '  ' + k).join('\n'));
} catch (e) { console.log('  读不到'); }
