// 从合并版 schema 里取参数定义（单文件版只导出了 Response，Params 在合并文件里）
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const big = JSON.parse(fs.readFileSync(path.join(DIR, 'codex_app_server_protocol.schemas.json'), 'utf8'));

const defs = big.definitions || big.$defs || {};
const want = ['ThreadListParams', 'ThreadReadParams', 'ThreadItemsListParams',
  'TurnStartParams', 'TurnInterruptParams', 'InitializeParams', 'ThreadStartParams',
  'ThreadResumeParams'];

console.log(`合并 schema 里有 ${Object.keys(defs).length} 个定义\n`);

for (const n of want) {
  const d = defs[n];
  if (!d) { console.log(`=== ${n} ===（没有）\n`); continue; }
  console.log(`=== ${n} ===`);
  console.log(`  必填: ${(d.required || []).join(', ') || '（无）'}`);
  for (const [k, v] of Object.entries(d.properties || {})) {
    let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
    if (!t && v.anyOf) t = v.anyOf.map((x) => x.type || (x.$ref || '').split('/').pop()).join('|');
    if (!t && v.allOf) t = 'allOf';
    if (v.enum) t = `enum(${v.enum.slice(0, 6).join(',')})`;
    console.log(`    ${k.padEnd(24)} ${t}${v.description ? '  // ' + String(v.description).slice(0, 60) : ''}`);
  }
  console.log('');
}
