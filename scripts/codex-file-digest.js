// 手机端要能看到 Codex 产出的文件（图片、pdf、word…），得先知道两件事：
//   1. app-server 有没有现成的读文件接口（有就别自己造）
//   2. 哪些 item 里带着文件路径
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs', 'codex-schema');
const big = JSON.parse(fs.readFileSync(
  path.join(DIR, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'));
const defs = big.definitions || big.$defs || {};

function dump(name, maxKeys = 12) {
  const d = defs[name];
  if (!d) { console.log(`  （没有 ${name}）`); return; }
  console.log(`— ${name}   必填: ${(d.required || []).join(', ') || '（无）'}`);
  let n = 0;
  for (const [k, v] of Object.entries(d.properties || {})) {
    if (n++ >= maxKeys) break;
    let t = v.type || (v.$ref ? v.$ref.split('/').pop() : null);
    if (!t && v.anyOf) t = v.anyOf.map((x) => x.type || (x.$ref || '').split('/').pop()).filter(Boolean).join('|');
    if (v.enum) t = 'enum(' + v.enum.slice(0, 5).join(',') + ')';
    if (v.items && v.items.$ref) t = 'array<' + v.items.$ref.split('/').pop() + '>';
    const dsc = v.description ? '  // ' + String(v.description).slice(0, 56) : '';
    console.log(`    ${String(k).padEnd(18)} ${t}${dsc}`);
  }
}

console.log('\n═══ 一、读文件的接口 ═══\n');
for (const n of ['FsReadFileParams', 'FsReadFileResponse', 'FsReadDirectoryParams',
  'FsGetMetadataParams', 'FsGetMetadataResponse']) dump(n);

console.log('\n═══ 二、带文件路径的 item ═══\n');
for (const n of ['ImageViewThreadItem', 'ImageGenerationThreadItem',
  'FileChangeThreadItem', 'CommandExecutionThreadItem']) {
  console.log(`${n}:`);
  dump(n, 16);
  console.log('');
}

console.log('═══ 三、fs/readFile 在客户端方法表里的样子 ═══\n');
try {
  const cr = JSON.parse(fs.readFileSync(path.join(DIR, 'ClientRequest.json'), 'utf8'));
  const hit = (cr.oneOf || []).find((x) =>
    x.properties && x.properties.method && x.properties.method.enum &&
    x.properties.method.enum[0] === 'fs/readFile');
  if (hit) console.log(JSON.stringify(hit.properties.params, null, 2).slice(0, 500));
  else console.log('  没找到');
} catch (e) { console.log('  读不到: ' + e.message); }
