// 清掉测试造出来的会话。
//
// 审批测试每跑一次就新建一个会话（那是最安全的做法 —— 不碰使用者的真实对话），
// 但它们会留在会话列表里，看着像垃圾。测试自己收尾才算完整。
//
// 用法: node scripts/cleanup-test-threads.js [--dry]
'use strict';
const { MiniWS } = require('./browser-check.js');

const PORT = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 18790);
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只删我们自己造的：这些特征串不会出现在正常对话里。
// 每加一个测试脚本，如果它会新建会话，就要把它的标志性话术加到这里 ——
// 否则跑一次就在使用者的会话列表里留一条垃圾（这个坑踩过一次）。
//
// 注意别用 ^ 锚点：下面匹配时是 name + ' ' + preview 拼起来的，
// 开头会多一个空格，锚点会失效（也踩过一次）。
const MARKERS = [
  /approval-probe-ok/i,
  /Run exactly this shell command/i,
  /Reply with just: ok/i,
  /Reply with exactly/i,
  /state-probe/i
];

(async () => {
  const ws = new MiniWS(`ws://127.0.0.1:${PORT}`);
  const pending = new Map();
  let nextId = 1;
  ws.on('message', (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await ws.connect();
  const call = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }); } }, 20000);
  });

  await call('initialize', { clientInfo: { name: 'cleanup', version: '1.0.0' } });
  const list = await call('thread/list', { limit: 100 });
  const rows = (list.result && list.result.data) || [];

  const doomed = rows.filter((t) => {
    const text = (t.name || '') + ' ' + (t.preview || '');
    return MARKERS.some((re) => re.test(text));
  });

  console.log(`\n会话共 ${rows.length} 条，其中测试造的 ${doomed.length} 条\n`);
  if (!doomed.length) { ws.close(); await sleep(200); process.exit(0); }

  for (const t of doomed) {
    const label = String(t.preview || t.name || '').replace(/\s+/g, ' ').slice(0, 50);
    if (DRY) { console.log(`  [试运行] 会删 ${t.id.slice(0, 8)}  ${label}`); continue; }

    // 先试彻底删除；不支持就退回归档（至少从列表里消失）
    let r = await call('thread/delete', { threadId: t.id });
    if (r.timeout || (r.error && !/unknown method/i.test(JSON.stringify(r.error)))) {
      r = await call('thread/archive', { threadId: t.id });
      console.log(`  已归档 ${t.id.slice(0, 8)}  ${label}`);
    } else if (r.error) {
      r = await call('thread/archive', { threadId: t.id });
      console.log(`  已归档 ${t.id.slice(0, 8)}  ${label}`);
    } else {
      console.log(`  已删除 ${t.id.slice(0, 8)}  ${label}`);
    }
    await sleep(400);
  }

  if (!DRY) {
    const after = await call('thread/list', { limit: 100 });
    const n = ((after.result && after.result.data) || []).length;
    console.log(`\n清理后剩 ${n} 条`);
  }
  ws.close();
  await sleep(200);
  process.exit(0);
})().catch((e) => { console.error(e); process.exitCode = 1; });
