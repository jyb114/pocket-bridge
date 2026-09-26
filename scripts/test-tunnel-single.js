#!/usr/bin/env node
/**
 * 回归测试：永远不该同时存在两条隧道
 *
 * 为什么要有这个文件
 * ------------------
 * 守护进程有三条分支会走到「建隧道」：全新启动 / 端口过期重建 / 判死重建。
 * 其中**只有两支**会先 `stopTunnels()`，全新启动那一支漏了。
 *
 * 平时看不出来，因为「判定隧道没在跑」通常意味着真的没在跑。但守护进程是靠
 * 枚举进程来判断的，而枚举在机器忙的时候会失败 —— 实测踩过一次：
 * `browser-check` 压着中间层时枚举超时，守护进程判定「隧道没在跑」，
 * 于是**又建了一条**，旧的那条还活着。结果：
 *
 *   · 电脑上同时有两个 trycloudflare 域名，两个都返回 200；
 *   · 只有新的那个被守护进程追踪、被写进 status.json；
 *   · 旧的那个**没人管、也不会被清理** —— 一个谁都不知道的公网入口；
 *   · 日志里只有一句「✓ 隧道就绪」，看不出任何异常。
 *
 * 所以这里钉两件事：① 每条分支建之前都要先清；② 失败时要倾向于说「在跑」，
 * 因为「以为在跑」最坏是这轮不动，「以为没跑」的代价是多开一个公网入口。
 */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const tunnel = require('./tunnel.js');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failed++;
  return ok;
}

console.log('\n【隧道唯一性】');

// ── 1. 每条 startTunnel 之前都要先 stopTunnels ─────────────────────────
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'gateway-daemon.js'), 'utf8');
  const lines = src.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/tunnel\.startTunnel\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) starts.push(i); });

  check('找得到 startTunnel 的调用点（不然下面的断言是空的）', starts.length > 0, `找到 ${starts.length} 处`);

  for (const at of starts) {
    // 往上 20 行内必须出现过 stopTunnels()
    const window = lines.slice(Math.max(0, at - 20), at).join('\n');
    check(`第 ${at + 1} 行的 startTunnel 之前先 stopTunnels()`,
      /tunnel\.stopTunnels\s*\(/.test(window),
      '往上 20 行里没有 stopTunnels() —— 这一支会留下孤儿隧道');
  }
}

// ── 2. tunnelRunning 不能用太宽的判据，出错要倾向「在跑」───────────────
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'gateway-daemon.js'), 'utf8');
  const at = src.indexOf('function tunnelRunning(');
  const raw = at < 0 ? '' : src.slice(at, at + 2200);
  // 注释里会**引用**旧写法讲历史（"这里原来跑 tasklist …"），那是文档不是代码。
  // 不剥掉就会把注释判成违规 —— 一条永远红的断言等于没有断言。
  const body = raw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  check('tunnelRunning 不再用 tasklist 这种「是 cloudflared 就算」的宽判据',
    body.length > 0 && !/tasklist/.test(body), '还在用 tasklist');
  check('tunnelRunning 按本项目路径过滤（ownTunnelPids）',
    /ownTunnelPids/.test(body));
  check('tunnelRunning 出错时返回 true（拿不准就当成在跑）',
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}?return true;/.test(body),
    'catch 里没有 return true —— 枚举一失败就会去建新隧道');
}

// ── 3. 现场：至多一条自己的隧道 ────────────────────────────────────────
{
  let ids = null;
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | ' +
        'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
      let list = [];
      if (out) list = JSON.parse(out);
      ids = tunnel.ownTunnelPids(list, BASE);
    }
  } catch (err) { /* 枚举失败 */ }

  if (ids === null) {
    console.log('  · 这台机器上没法枚举进程 —— 跳过现场检查（不算通过）');
  } else {
    check('现场至多只有一条属于本项目的隧道在跑',
      ids.length <= 1, `发现 ${ids.length} 条: ${ids.join(', ')}`);
    if (ids.length === 0) console.log('    （现在没有隧道在跑，这也算通过）');
  }
}

console.log(failed === 0
  ? '\n结论: 隧道生命周期是收敛的 —— 不会留下没人追踪的公网入口。\n'
  : `\n结论: ${failed} 项不通过 —— 可能会多开公网入口或留下孤儿隧道。\n`);

process.exitCode = failed === 0 ? 0 : 1;
