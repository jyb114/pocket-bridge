// 从 Codex 生成的 JSON Schema 里抽出核心几个方法的参数结构。
// 只想知道「手机端要实现最小聊天循环，需要发什么」。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const s = JSON.parse(fs.readFileSync(path.join(DIR, 'ClientRequest.json'), 'utf8'));

const want = ['initialize', 'thread/list', 'thread/read', 'thread/items/list',
  'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'thread/archive'];

function defOf(ref) {
  const name = ref.split('/').pop();
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); }
  catch (err) { return null; }
}

for (const m of want) {
  const v = (s.oneOf || []).find((x) =>
    x.properties && x.properties.method && x.properties.method.enum &&
    x.properties.method.enum[0] === m);
  if (!v) { console.log(`— ${m}: 没找到`); continue; }

  const props = v.properties || {};
  const ps = props.params || {};
  const ref = ps.$ref ? ps.$ref.split('/').pop() : null;
  console.log(`— ${m}`);
  console.log(`    顶层必填: ${JSON.stringify(v.required || [])}`);
  console.log(`    params: ${ref || ps.type || JSON.stringify(ps).slice(0, 80)}`);
  if (ref) {
    const d = defOf(ps.$ref);
    if (d) {
      console.log(`    必填字段: ${(d.required || []).join(', ') || '（无）'}`);
      const keys = Object.keys(d.properties || {});
      console.log(`    字段: ${keys.slice(0, 16).join(', ')}${keys.length > 16 ? ` …共 ${keys.length} 个` : ''}`);
    }
  }
}

// 服务端会推哪些通知
console.log('\n=== 服务端通知（挑和聊天有关的）===');
const n = JSON.parse(fs.readFileSync(path.join(DIR, 'ServerNotification.json'), 'utf8'));
const names = (n.oneOf || [])
  .map((x) => x.properties && x.properties.method && x.properties.method.enum && x.properties.method.enum[0])
  .filter(Boolean);
console.log(names.filter((x) => /thread|turn|item|delta|error/i.test(x)).join('\n'));
