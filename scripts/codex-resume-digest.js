// resume 到底能不能只加载元数据、不读整个历史？
//
// 检查消息发送是否必须等待完整历史加载。schema 里有一句
// 「Full-history hydration is deprecated for paginated threads;
//   prefer a metadata-only read」—— 说明存在这种模式，值得查清楚。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const big = JSON.parse(fs.readFileSync(
  path.join(DIR, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'));
const defs = big.definitions || big.$defs || {};

for (const n of ['ThreadResumeParams', 'ThreadReadParams', 'ThreadStartParams',
  'ThreadTurnsListParams']) {
  const d = defs[n];
  console.log(`=== ${n} ===`);
  if (!d) { console.log('  （没有）\n'); continue; }
  console.log(`  必填: ${(d.required || []).join(', ') || '（无）'}`);
  for (const [k, v] of Object.entries(d.properties || {})) {
    let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
    if (!t && v.anyOf) t = v.anyOf.map((y) => y.type || (y.$ref || '').split('/').pop()).filter(Boolean).join('|');
    if (v.enum) t = 'enum(' + v.enum.join(',') + ')';
    const dsc = v.description ? '  // ' + String(v.description).slice(0, 100) : '';
    console.log(`    ${k.padEnd(24)} ${t}${dsc}`);
  }
  console.log('');
}

// 找出所有和「少加载一点」有关的字段名
console.log('=== 和「加载量」有关的字段（全库搜）===');
const hits = new Set();
const walk = (o, pathStr) => {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (/hydrat|pageSize|initialTurns|includeTurns|limitHistory|metadata.?only|paginated/i.test(k)) {
      hits.add(`${k}  @  ${pathStr}`);
    }
    if (typeof v === 'object') walk(v, pathStr ? pathStr + '.' + k : k);
  }
};
walk(defs, '');
[...hits].sort().slice(0, 25).forEach((h) => console.log('  ' + h));
