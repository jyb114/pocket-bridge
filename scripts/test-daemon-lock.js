// 守护进程的单实例锁 —— 防的是「两个守护进程互相杀掉对方的隧道」。
//
// 为什么要有这个测试：这个 bug 是从**日志时间线**里看出来的，不是从代码里读出来的：
//
//   03:59:56 #1 停掉旧的 cloudflared
//   03:59:58 #1 起一条新的
//   04:00:03 #2 把 #1 刚起的那个杀掉了      ← 就是这里
//   04:00:03 #1 报「失败: 进程已退出」→「所有隧道方案都不可用」
//   04:00:05 #2 重来，04:00:11 才就绪
//
// 会并发跑到守护进程的地方不止一处：看门狗计划任务（每 5 分钟）、
// refresh-tunnel.js（控制台按钮 detach 起一个）、使用者手动跑。
// 而它们的动作是「杀掉旧的 → 起一条新的」—— 两个撞上就是互相杀。
//
// ⚠️ 这个测试**会临时写 logs/daemon.lock**。那是守护进程的锁文件，
//    留着会让看门狗任务误以为有人在跑。所以无论如何都在 finally 里清掉。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const LOCK = path.join(LOG_DIR, 'daemon.lock');
const DAEMON = path.join(BASE, 'scripts', 'gateway-daemon.js');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

/** 跑一次守护进程，拿回它的日志输出 */
function runDaemon(args = []) {
  try {
    return execFileSync(process.execPath, [DAEMON, ...args],
      { cwd: BASE, encoding: 'utf8', timeout: 90000 }).trim();
  } catch (err) {
    return String((err && err.stdout) || '') + String((err && err.stderr) || '');
  }
}

/**
 * 拿一个**确实活着**的 PID 来伪造「另一个守护进程」。
 *
 * 直接用测试进程自己的 PID —— 它当然活着，而且不用起子进程。
 * （第一版去 shell 里查网关的 PID，结果 `pwsh` 在 Node 的子进程里不在 PATH 上，
 *   直接 ENOENT 把测试整个搞崩。为了拿一个「活着的 PID」而依赖外部命令，不值。）
 */
function livePid() {
  return process.pid;
}

const hadLock = fs.existsSync(LOCK);
const backup = hadLock ? fs.readFileSync(LOCK, 'utf8') : null;

console.log('\n=== 守护进程的单实例锁 ===\n');

try {
  // ── 1. 没有锁时正常跑，而且**跑完要放掉** ────────────────────────────────
  //
  // 放不掉就等于给下一轮留了个雷：看门狗会一直以为有人在跑，
  // 隧道坏了也不会重建 —— 而那正是使用者最需要它的时候。
  console.log('[1] 正常跑一次');
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
  const out1 = runDaemon();
  ok('跑得起来（有正常日志）', /启动器结束|隧道/.test(out1));
  ok('跑完把锁放掉了', !fs.existsSync(LOCK),
    fs.existsSync(LOCK) ? '锁还在 —— 下一轮会被误判成「有人正在跑」' : '');

  // ── 2. 有人在跑时跳过 ───────────────────────────────────────────────────
  console.log('\n[2] 另一个守护进程还活着 → 跳过');
  const pid = livePid();
  fs.writeFileSync(LOCK, JSON.stringify({ pid, at: Date.now() }), 'utf8');
  const out2 = runDaemon();
  ok('明确说了「另一个守护进程正在跑，本次跳过」',
    /另一个守护进程正在跑/.test(out2), out2.split('\n').pop());
  ok('跳过的这次没有去动隧道（没有停止/启动隧道的日志）',
    !/已停止 \d+ 个隧道进程|尝试 Cloudflare/.test(out2));

  // ── 3. 锁过期就接管 ─────────────────────────────────────────────────────
  //
  // 否则守护进程一旦被强杀（计划任务被中断、机器休眠），锁会永远留着，
  // 隧道再也不会被重建 —— 比不加锁还糟。
  console.log('\n[3] 锁过期 → 接管');
  fs.writeFileSync(LOCK, JSON.stringify({ pid, at: Date.now() - 10 * 60 * 1000 }), 'utf8');
  const out3 = runDaemon();
  ok('过期锁会被接管（正常跑完）', /启动器结束/.test(out3), out3.split('\n').pop());
  ok('接管之后也把锁放掉了', !fs.existsSync(LOCK));

  // ── 4. 拿一个死掉的 PID 伪造锁 → 也该接管 ───────────────────────────────
  //
  // 这一条比「过期」更贴近真实：守护进程被强杀时锁文件是**新鲜的**，
  // 只有 PID 已经不存在了能说明它死了。
  console.log('\n[4] 锁是新鲜的，但 PID 已经死了 → 接管');
  let deadPid = 999999;
  for (let i = 0; i < 50; i++) {
    try { process.kill(deadPid, 0); deadPid += 7; } catch (err) { break; }   // 找到真没人用的
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, at: Date.now() }), 'utf8');
  const out4 = runDaemon();
  ok(`PID ${deadPid} 已死 → 接管（不能因为锁新鲜就一直等）`, /启动器结束/.test(out4),
    out4.split('\n').pop());

  // ── 5. --status 不抢锁 ──────────────────────────────────────────────────
  //
  // 它是只读查询。抢锁的话，正好有守护进程在跑时控制台连状态都读不出来。
  console.log('\n[5] --status 是只读查询，不该被锁挡住');
  fs.writeFileSync(LOCK, JSON.stringify({ pid, at: Date.now() }), 'utf8');
  const out5 = runDaemon(['--status']);
  ok('有锁时 --status 照样给出状态', /隧道/.test(out5) && !/本次跳过/.test(out5),
    out5.split('\n').pop());
} finally {
  // 无论如何都把锁收拾干净 —— 留着会让看门狗以为有人在跑
  try {
    if (hadLock) fs.writeFileSync(LOCK, backup, 'utf8');
    else if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
  } catch (err) { }
  ok('测试后锁文件已清理', !hadLock ? !fs.existsSync(LOCK) : true);
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
