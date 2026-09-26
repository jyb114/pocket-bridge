// 流式通知的参数长什么样。参数名猜错的话，「边跑边看」就是假的 ——
// 界面看着在转，内容一个字都不会出现。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const j = JSON.parse(fs.readFileSync(path.join(DIR, 'ServerNotification.json'), 'utf8'));

const want = ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta', 'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta', 'item/started', 'item/completed',
  'turn/started', 'turn/completed', 'turn/plan/updated', 'turn/diff/updated',
  'thread/tokenUsage/updated', 'item/plan/delta', 'error'];

function paramsOf(method) {
  for (const x of j.oneOf || []) {
    const m = x.properties && x.properties.method && x.properties.method.enum &&
      x.properties.method.enum[0];
    if (m === method) return x.properties.params;
  }
  return null;
}

function dumpDef(name, indent = '    ') {
  for (const f of ['codex_app_server_protocol.v2.schemas.json',
    'codex_app_server_protocol.schemas.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const defs = s.definitions || s.$defs || {};
      const d = defs[name];
      if (!d) continue;
      console.log(`${indent}${name}  必填: ${(d.required || []).join(', ') || '（无）'}`);
      for (const [k, v] of Object.entries(d.properties || {})) {
        let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
        if (!t && v.anyOf) t = v.anyOf.map((y) => y.type || (y.$ref || '').split('/').pop()).filter(Boolean).join('|');
        if (v.items && v.items.$ref) t = 'array<' + v.items.$ref.split('/').pop() + '>';
        console.log(`${indent}  ${String(k).padEnd(18)} ${t}`);
      }
      return;
    } catch (e) { /* 换下一个文件 */ }
  }
  console.log(`${indent}（找不到定义 ${name}）`);
}

for (const m of want) {
  const p = paramsOf(m);
  console.log(`\n— ${m}`);
  if (!p) { console.log('    （这个通知不在 ServerNotification 里）'); continue; }
  const ref = p.$ref ? p.$ref.split('/').pop() : null;
  console.log(`    params → ${ref || JSON.stringify(p).slice(0, 70)}`);
  if (ref) dumpDef(ref);
}
