// 安全改动基线 —— 实施任何改动**之前**先冻结当前状态，保证可回滚。
//
// 这是改进计划里 A 批次的产物。为什么必须先做它：
//   后面的 B/C/D 批次要动「状态、审批、投递、加密」这些东西，
//   而它们全都碰真实会话和真实密钥。**一旦改坏，没有基线就回不去**，
//   而使用者当时可能正在外面用手机。
//
// 三件事：
//   1. 冻结清单：所有源文件的 SHA-256 + 大小 + 行数，写成一个快照文件
//   2. 备份 UI 和配置（那些是使用者可能改过的，丢了找不回来）
//   3. 校验模式：拿快照和当前状态比，告诉你哪些文件被动过
//
// 用法:
//   node scripts/baseline-snapshot.js            建立新快照
//   node scripts/baseline-snapshot.js --verify   和最新快照比对
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const SNAP_DIR = path.join(LOG_DIR, 'baselines');

// 冻结哪些文件：**源码和配置**，不包括 logs / runtime / node_modules /
// 隧道二进制 —— 那些要么是运行产物，要么大得没必要，要么本来就不该动。
const SKIP = /(^|[\\/])(logs|runtime|node_modules|\.git|cloudflared|tls|uploads|desktop[\\/]node_modules)([\\/]|$)/;
const EXT = /\.(js|json|html|css|md|ps1|bat|cmd|sh|yml|yaml)$/i;

function walk(dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) { walk(p, out); continue; }
    if (!EXT.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (err) { return null; }
}

function listFiles() {
  return walk(BASE)
    .map((f) => path.relative(BASE, f).replace(/\\/g, '/'))
    .sort();
}

function snapshot() {
  const files = {};
  for (const rel of listFiles()) {
    const abs = path.join(BASE, rel);
    let size = 0, lines = 0;
    try {
      const buf = fs.readFileSync(abs);
      size = buf.length;
      lines = buf.toString('utf8').split('\n').length;
    } catch (err) { /* 读不到就记 0 */ }
    files[rel] = { sha256: sha256(abs), size, lines };
  }

  // git 状态（如果有仓库的话）—— 能对上具体是哪一次提交
  let git = null;
  try {
    git = {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BASE, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: BASE, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: BASE, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
    };
  } catch (err) { git = null; }

  return {
    at: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    totalBytes: Object.values(files).reduce((s, x) => s + x.size, 0),
    git,
    files
  };
}

function latest() {
  try {
    const names = fs.readdirSync(SNAP_DIR).filter((f) => /^baseline-.*\.json$/.test(f)).sort();
    if (!names.length) return null;
    return path.join(SNAP_DIR, names[names.length - 1]);
  } catch (err) { return null; }
}

const VERIFY = process.argv.includes('--verify');

fs.mkdirSync(SNAP_DIR, { recursive: true });

if (VERIFY) {
  const file = latest();
  if (!file) {
    console.log('还没有任何快照。先跑一次不带 --verify 的。');
    process.exitCode = 1;
  } else {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = snapshot();
    const changed = [], added = [], removed = [];
    for (const [rel, info] of Object.entries(now.files)) {
      if (!old.files[rel]) added.push(rel);
      else if (old.files[rel].sha256 !== info.sha256) {
        changed.push(`${rel}  ${old.files[rel].lines} → ${info.lines} 行`);
      }
    }
    for (const rel of Object.keys(old.files)) if (!now.files[rel]) removed.push(rel);

    console.log(`\n与快照比对（基线: ${path.basename(file)}，${old.at}）\n`);
    console.log(`  改动 ${changed.length} 个   新增 ${added.length} 个   删除 ${removed.length} 个`);
    if (changed.length) { console.log('\n  改动过的：'); changed.forEach((x) => console.log('    ' + x)); }
    if (added.length) { console.log('\n  新增的：'); added.forEach((x) => console.log('    ' + x)); }
    if (removed.length) { console.log('\n  删掉的：'); removed.forEach((x) => console.log('    ' + x)); }
    if (!changed.length && !added.length && !removed.length) console.log('\n  ✓ 和基线完全一致');
    process.exitCode = changed.length || added.length || removed.length ? 1 : 0;
    console.log('');
  }
} else {
  const snap = snapshot();
  const name = `baseline-${snap.at.replace(/[:.]/g, '-')}.json`;
  const out = path.join(SNAP_DIR, name);
  // Publish the manifest only after its restorable copies have been verified.

  console.log('\n=== 基线快照 ===\n');
  console.log(`  文件数    ${snap.fileCount}`);
  console.log(`  总字节    ${snap.totalBytes.toLocaleString()}`);
  console.log(`  git       ${snap.git ? `${snap.git.branch}@${snap.git.head.slice(0, 8)}，${snap.git.dirty} 个未提交改动` : '（不是 git 仓库）'}`);
  console.log(`  写成      logs/baselines/${name}`);
  console.log('');
  console.log('  之后用这个命令比对：');
  console.log('    node scripts/baseline-snapshot.js --verify');
  console.log('');

  // 备份使用者的东西 —— 那些丢了找不回来
  const backupDir = path.join(SNAP_DIR, 'backup-' + snap.at.replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  // Hashes alone cannot restore a modified source file. Preserve the same
  // source/config set in a private, ignored directory with its relative paths.
  for (const [rel, info] of Object.entries(snap.files)) {
    const src = path.join(BASE, rel);
    const dst = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    if (sha256(dst) !== info.sha256) throw new Error('快照期间文件变化，请重新建立基线: ' + rel);
  }
  console.log(`  已备份 ${snap.fileCount} 个源文件与配置（保留相对路径）`);
  const userOwned = [
    ['pwa/custom.css', '界面覆盖层（使用者可能改过）'],
    ['pwa/custom.js', '界面脚本（使用者可能改过）'],
    ['config.json', '配置（内网 HTTPS、地址策略等）']
  ];
  console.log('  备份使用者的东西：');
  for (const [rel, why] of userOwned) {
    const src = path.join(BASE, rel);
    try {
      const buf = fs.readFileSync(src);
      fs.writeFileSync(path.join(backupDir, path.basename(rel)), buf);
      console.log(`    ✓ ${rel.padEnd(18)} ${String(buf.length).padStart(6)} 字节   ${why}`);
    } catch (err) {
      console.log(`    · ${rel.padEnd(18)} 不存在，跳过`);
    }
  }
  console.log(`\n  备份目录  logs/baselines/${path.basename(backupDir)}`);
  fs.writeFileSync(out, JSON.stringify(snap, null, 2), 'utf8');
  console.log('  （日志和密钥没备份 —— 计划里明确要求「测试不得轮换真实密钥」，');
  console.log('    备份密钥反而多一份泄露面。）\n');
}
