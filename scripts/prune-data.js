// 运行数据保留期 —— 计划 G「日志脱敏与保留期」。
//
// 起因很具体：这台机器的 logs/ 长到了 **456MB**，其中 441MB 是一个叫
// `app-window-profile` 的僵尸目录 —— 早期版本的浏览器测试拿它当
// Chromium 的 user-data-dir，后来改成系统临时目录并会自清理了，
// 但这个旧目录没人管，一直躺在那儿。
//
// 设计上只做**白名单**：下面 PRUNE_RULES 里列到的才会被碰，
// 没列到的一律不动。反过来的做法（黑名单：删掉除了这些之外的所有东西）
// 看着更彻底，但只要有一条规则写错，删掉的就是使用者的密钥或队列 ——
// 而这些东西**没有备份**（logs/ 不进仓库、也没人给它做备份）。
//
// 所以每一条规则都要回答两个问题：
//   1. 删了会怎样？（必须是「会重新生成」或者「已经没有代码再用它」）
//   2. 多久算过期？（默认 14 天 —— 够把一次故障的现场留到人来查）
//
// 用法：
//   node scripts/prune-data.js            真的删
//   node scripts/prune-data.js --dry-run  只报告要删什么（推荐先跑这个）
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const DRY = process.argv.includes('--dry-run');
const DEFAULT_DAYS = Number(process.env.DSH_GW_PRUNE_DAYS || 14);
const MAX_AGE_MS = DEFAULT_DAYS * 24 * 60 * 60 * 1000;

/**
 * 明确不该碰的东西 —— 列出来是为了让「谁在保护范围里」一目了然，
 * 也为了让下面 sizeOf 的统计口径有个对照。
 * 这些**一个都不能删**：删了手机就连不上了（密钥），或者使用者的任务就丢了（队列）。
 */
const NEVER_DELETE = [
  'access-key.txt',       // 访问密钥：删了所有书签失效
  'e2ee-secret.txt',      // 端到端加密密钥：删了内容再也解不开
  'devices.json',         // 已配对设备
  'notify-targets.json',  // 推送凭据
  'vapid.json',           // Web Push 密钥对
  'status.json',          // 界面读的状态
  'codex-message-queue.json', // 排队中的消息 —— 使用者还没发出去的内容
  'tunnel-probe.json',    // 探测失败计数（删了会重新数，但没必要）
  'instance.json',
  'gateway-port.txt',
  'tunnel-target.txt',
  'pair-code.txt'
];

/** 白名单规则：只有这里列到的路径会被清理 */
const RULES = [
  {
    // 早期版本的浏览器测试拿这个目录当 Chromium 的 user-data-dir。
    // 现在的 browser-check.js 改用系统临时目录、并且会在退出时自清理，
    // 所以 logs/ 下不该再有它 —— 有就是历史遗留。
    //
    // ⚠️ 写这条规则时我差点搞错：第一次删不掉（EPERM），我以为是权限问题，
    //    其实是有 **9 个 msedge.exe 进程还占着它** —— 那是两天前某次测试
    //    泄漏下来的无头浏览器，父进程早没了，它自己活了两天多。
    //    所以「该删」和「删得掉」是两件事：真删之前要先确认没有进程占用，
    //    看到 EPERM 要先查占用（Get-CimInstance 匹配命令行），别急着改权限。
    match: (name) => name === 'app-window-profile',
    kind: 'dir',
    always: true,
    why: '历史遗留的浏览器测试 profile（当前代码用系统临时目录并自清理）'
  },
  {
    // 缩略图缓存：本来就是为了省一次解码，删了下次重新生成。
    match: (name) => name === 'thumbs',
    kind: 'dir',
    age: true,
    why: '图片缩略图缓存，可重新生成'
  },
  {
    // 早期几轮改动留下的回滚备份，已经过了那么久，留着只是占地方。
    match: (name) => /-(backup|bak)-?\d{8}/.test(name) || /^(ui|upload|queue|deferred-queue|safe-observer)-backup-/.test(name),
    kind: 'dir',
    age: true,
    why: '历史回滚备份（那一轮改动的现场）'
  },
  {
    // 测试与量测脚本截的图。它们可能带着真实会话画面，本就不该长期留。
    match: (name) => /\.(png|jpg|jpeg|webp)$/i.test(name),
    kind: 'file',
    age: true,
    why: '测试/量测截图，可能带真实会话画面'
  },
  {
    // 各脚本自己写的日志（proxy.log 有自己的大小轮转，不在这里管）。
    match: (name) => /\.log(\.\d+)?$/.test(name) && name !== 'proxy.log' && !name.startsWith('proxy.log.'),
    kind: 'file',
    age: true,
    why: '脚本日志（proxy.log 有自己的大小轮转，不在此列）'
  }
];

let removedBytes = 0;
let removedCount = 0;
const report = [];

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch (err) { } }
    }
  };
  walk(p);
  return total;
}

function olderThan(p, ms) {
  try { return Date.now() - fs.statSync(p).mtimeMs > ms; } catch (err) { return false; }
}

function remove(p, rule) {
  const size = fs.statSync(p).isDirectory() ? dirSize(p) : fs.statSync(p).size;
  removedBytes += size;
  removedCount++;
  report.push(`  ${DRY ? '会删' : '已删'} ${path.relative(BASE, p)}  ${(size / 1048576).toFixed(1)} MB  — ${rule.why}`);
  if (!DRY) {
    try { fs.rmSync(p, { recursive: true, force: true }); }
    catch (err) { report.push(`       ✗ 删不掉：${err.message}`); removedCount--; removedBytes -= size; }
  }
}

console.log(`\n=== 运行数据保留期清理${DRY ? '（试跑，不真删）' : ''} ===\n`);
console.log(`  目录 ${LOG_DIR}`);
console.log(`  规则：白名单；默认清理 ${DEFAULT_DAYS} 天前的东西\n`);

if (!fs.existsSync(LOG_DIR)) {
  console.log('  logs/ 不存在，没什么可清的\n');
  process.exit(0);
}

// 先算总体积，好知道清完之后省了多少
const beforeBytes = dirSize(LOG_DIR);

let entries = [];
try { entries = fs.readdirSync(LOG_DIR, { withFileTypes: true }); } catch (err) {
  console.error(`读不了 logs/：${err.message}`);
  process.exitCode = 1;
  return;
}

for (const ent of entries) {
  const full = path.join(LOG_DIR, ent.name);
  if (NEVER_DELETE.includes(ent.name)) continue;
  for (const rule of RULES) {
    const isDir = ent.isDirectory();
    if (rule.kind === 'dir' && !isDir) continue;
    if (rule.kind === 'file' && isDir) continue;
    if (!rule.match(ent.name)) continue;
    if (!rule.always && rule.age && !olderThan(full, MAX_AGE_MS)) continue;
    remove(full, rule);
    break;                       // 一条路径只按第一条命中的规则处理
  }
}

if (!report.length) console.log('  没有需要清理的东西\n');
else {
  report.forEach((l) => console.log(l));
  const after = beforeBytes - removedBytes;
  console.log(`\n  ${DRY ? '预计释放' : '已释放'} ${(removedBytes / 1048576).toFixed(1)} MB` +
    `（${(beforeBytes / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB），共 ${removedCount} 项\n`);
}

console.log('  没有动的东西：' + NEVER_DELETE.slice(0, 4).join('、') + ' 等 —— 删了手机就连不上，或使用者的任务会丢\n');
process.exitCode = 0;
