// DSH 移动端网关 — 域名策略测试（动态 / 固定）
//
// 要验的核心命题：**固定模式绝不悄悄退回临时网址。**
//
// 固定书签的价值就是地址稳定；若命名隧道失败后后台换成快速隧道，
// 使用者只会看到旧书签失效，却不知道地址已经变了。正确行为是如实报告
// 固定隧道不可用，让使用者明确切回临时模式，而不是隐式降级。
//
// ⚠️ 这里曾经用**真的 cloudflared** 起一条隧道来验「降级」那一步，注释里写着
//    「原来那条隧道不受影响（这个测试只收自己起的进程）」。**那句话是错的。**
//
//    tunnel.startTunnel() 会先把现有隧道停掉再起新的 —— 那是守护进程该有的行为
//    （它管理的就是「当前这一条」），但一个测试绝不该这么做：
//      · 使用者的隧道被顶掉，快速隧道地址**当场作废**（Cloudflare 快速隧道的
//        地址和进程同生共死，进程没了就永远找不回来）；
//      · 测试用的目标端口是 19000，守护进程下一轮发现「隧道指向 19000、
//        中间层在 8080」又重启一次 —— 于是又换一个地址。
//    实测后果：跑一次测试套件，手机书签里的地址就失效一次。
//    自动测试不能让现有手机入口失效。
//
//    所以：默认只验**不产生副作用**的部分（策略候选、配置往返、yml 生成），
//    真正要起隧道的那一步用 DSH_GW_TUNNEL_TESTS=1 显式开启，而且要人自己承担
//    「地址会变」的后果。想验真隧道请用 test-tunnel.js。
//
// 用法:
//   node scripts/test-domain-mode.js                      只验决策逻辑（安全）
//   DSH_GW_TUNNEL_TESTS=1 node scripts/test-domain-mode.js  连真隧道一起验（会换地址！）
'use strict';

const fs = require('fs');
const path = require('path');

const cfg = require('./config.js');
const tunnel = require('./tunnel.js');

// 允许起真隧道吗？默认不允许 —— 判断收在 test-guard.js 里，
// 和「不许碰使用者 Codex 账号」是同一套规矩。
const ALLOW_SPAWN = require('./test-guard.js').TUNNEL_LIVE;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logsSince(marker) {
  try {
    const text = fs.readFileSync(path.join(cfg.LOG_DIR, 'tunnel.log'), 'utf8');
    const i = text.lastIndexOf(marker);
    return i >= 0 ? text.slice(i) : text.slice(-4000);
  } catch (err) { return ''; }
}

/** 只收掉这个测试自己起的进程，别碰使用者正在用的那条隧道 */
function killPids(pids) {
  for (const pid of pids) {
    if (!pid) continue;
    try { process.kill(pid); } catch (err) { /* 已经退了 */ }
    try {
      if (process.platform === 'win32') {
        require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
          { stdio: 'ignore', timeout: 5000 });
      }
    } catch (err) { /* 同上 */ }
  }
}

(async () => {
  console.log('\n=== 域名策略 · 端到端测试 ===\n');

  const original = cfg.loadConfig();
  const originalMode = original.tunnelDomainMode;
  const spawnedPids = [];

  console.log(`  当前策略: ${originalMode}`);
  console.log(`  cloudflared: ${cfg.detectTunnelProviders().cloudflared || '（没找到）'}\n`);

  if (!cfg.detectTunnelProviders().cloudflared) {
    console.log('  没装 cloudflared，这个测试跑不了。\n');
    process.exitCode = 1;
    return;
  }

  // 注意 await：findAvailablePort 是异步的。忘了 await 就会拿到一个 Promise，
  // 后面传给 cloudflared 时变成字面量 "[object Promise]" ——
  // 隧道照样能起（它不校验目标），但指向的是一个不存在的地址，测出来的东西就是假的。
  // 这个坑在这个项目里踩过两次了（另一次在 mobile-proxy 里，那次直接把进程搞死了）。
  const testPort = await cfg.findAvailablePort(19000);
  console.log(`  测试用的目标端口: ${testPort}\n`);

  try {
    // ── 1. 默认应当是动态 ────────────────────────────────────────────────────
    console.log('[1] 默认策略');
    const defaults = require('./config.js').DEFAULTS || {};
    ok('默认是动态（更安全的那个）', defaults.tunnelDomainMode === 'dynamic',
      String(defaults.tunnelDomainMode));

    const providers = tunnel.listProviders();
    const named = providers.find((p) => p.id === 'cloudflare-named');
    const quick = providers.find((p) => p.id === 'cloudflare-quick');
    ok('提供方列表里有命名隧道这一项', !!named);
    ok('快速隧道就绪', !!(quick && quick.ready), JSON.stringify(quick));

    // 没配域名时，命名隧道必须如实报「未就绪」，而不是假装能用
    if (named) {
      ok('没配域名时命名隧道报未就绪', named.ready === false,
        `ready=${named.ready} configHint=${named.configHint}`);
      if (named.configHint) console.log(`      提示: ${named.configHint}`);
    }

    // ── 2. 动态模式下不该去碰命名隧道 ────────────────────────────────────────
    console.log('\n[2] 动态模式下的候选');
    const dynamicCands = tunnel.candidatesForMode('dynamic').map((p) => p.id);
    ok('动态模式不包含命名隧道', !dynamicCands.includes('cloudflare-named'),
      dynamicCands.join(', '));
    ok('动态模式仍包含快速隧道', dynamicCands.includes('cloudflare-quick'),
      dynamicCands.join(', '));

    const fixedCands = tunnel.candidatesForMode('fixed').map((p) => p.id);
    ok('固定模式优先命名隧道（排在最前）', fixedCands[0] === 'cloudflare-named',
      fixedCands.join(', '));
    ok('固定模式不混入快速隧道（地址稳定性不可悄悄降级）', !fixedCands.includes('cloudflare-quick'),
      fixedCands.join(', '));

    // ── 3. 固定模式 + 没配好 ⇒ 明确没有外网入口 ─────────────────────────────
    console.log('\n[3] 选了固定但没配好（关键：不能静默换临时地址）');

    if (!ALLOW_SPAWN) {
      const fixedOrder = tunnel.candidatesForMode('fixed').map((p) => p.id);
      ok('固定模式先试命名隧道', fixedOrder[0] === 'cloudflare-named', fixedOrder.join(' → '));
      ok('固定模式只尝试命名隧道', fixedOrder.length === 1 && fixedOrder[0] === 'cloudflare-named', fixedOrder.join(' → '));
      console.log('      · 跳过真隧道；策略本身已保证不会改动使用者当前地址。');
    } else {
      console.log('      ! DSH_GW_TUNNEL_TESTS=1：会实际尝试命名隧道。');

      const conf = cfg.loadConfig();
      conf.tunnelDomainMode = 'fixed';
      conf.fixedTunnel = { name: '', credentialsFile: '', hostname: '' };
      cfg.saveConfig(conf);
      ok('配置写入成功（模拟「选了固定但没填域名」）',
        cfg.loadConfig().tunnelDomainMode === 'fixed');

      const marker = `=== 测试标记 ${Date.now()} ===`;
      fs.appendFileSync(path.join(cfg.LOG_DIR, 'tunnel.log'), `\n${marker}\n`);

      const res = await tunnel.startTunnel(testPort, 'auto');
      // 收集这次测试自己起的进程，收尾时只收它们
      for (const a of res.attempts || []) if (a.pid) spawnedPids.push(a.pid);
      if (res.pid) spawnedPids.push(res.pid);

      const attempted = res.attempts.map((a) => `${a.provider}${a.ok ? '✓' : '✗'}`);
      console.log(`      尝试过程: ${attempted.join(' → ')}`);

      const namedAttempt = res.attempts.find((a) => a.provider === 'cloudflare-named');
      ok('确实先试了命名隧道', !!namedAttempt, attempted.join(' → '));
      if (namedAttempt) {
        ok('命名隧道失败了（因为没配域名）', namedAttempt.ok === false);
        ok('失败原因说清楚了', /未配置|域名|hostname/i.test(String(namedAttempt.reason)),
          String(namedAttempt.reason));
        console.log(`      失败原因: ${namedAttempt.reason}`);
      }

      ok('不配置固定隧道时不伪造外网地址', !res.url && res.provider === null,
        JSON.stringify({ url: res.url, provider: res.provider }));

      const logText = logsSince(marker);
      ok('日志里记录了固定隧道失败过程',
        /域名策略: 固定地址/.test(logText) && /cloudflare-named|命名隧道/.test(logText),
        logText.slice(0, 200).replace(/\n/g, ' | '));
    }

    // ── 4. 命名隧道的配置文件生成得对不对 ────────────────────────────────────
    console.log('\n[4] 命名隧道的配置生成');
    // 这一段原来也无条件调 startTunnel(testPort, 'cloudflare-named') ——
    // 同样会顶掉使用者的隧道，而且它验的东西（生成出来的 yml）根本不需要真起进程：
    // yml 是**写文件**那一步的产物，读文件就能验。所以真起隧道只在显式开启时做。
    if (ALLOW_SPAWN) {
      await tunnel.startTunnel(testPort, 'cloudflare-named');
    } else {
      console.log('      · 跳过真起进程；只验已经存在的配置（yml 是写文件的产物，读它即可）');
    }

    // 直接检查生成出来的 yml —— 这是使用者换成自己的域名时真正生效的东西
    const ymlPath = path.join(cfg.LOG_DIR, 'cloudflared-named.yml');
    if (fs.existsSync(ymlPath)) {
      const yml = fs.readFileSync(ymlPath, 'utf8');
      console.log('      配置内容:');
      yml.trim().split('\n').forEach((l) => console.log(`        ${l}`));
      ok('配置里有 ingress 段', /^ingress:/m.test(yml));
      ok('兜底规则是 404（不然 Cloudflare 会拒收整份配置）', /http_status:404/.test(yml));
      ok('服务指向本地回环', /service: http:\/\/127\.0\.0\.1:\d+/.test(yml));
    } else {
      console.log('      （没配域名，所以没生成 yml —— 符合预期）');
      ok('未配置时不生成半成品配置', true);
    }

    // 收掉测试起的进程
    // （res 只在 ALLOW_SPAWN 那段里存在，进程号在那边就收集过了 ——
    //   原来这里又引用了一次 res，作用域改小之后会直接 ReferenceError。）
  } catch (err) {
    fail++;
    console.log(`  ✗ 测试过程出错: ${err.message}\n${err.stack}`);
  } finally {
    // ── 收尾：恢复原配置，收掉测试起的进程 ────────────────────────────────────
    console.log('\n[5] 收尾');
    const conf = cfg.loadConfig();
    conf.tunnelDomainMode = originalMode || 'dynamic';
    conf.fixedTunnel = original.fixedTunnel || { name: '', credentialsFile: '', hostname: '' };
    cfg.saveConfig(conf);
    ok('配置已恢复成原来的策略', cfg.loadConfig().tunnelDomainMode === originalMode,
      String(cfg.loadConfig().tunnelDomainMode));

    // 等一下再收 —— 进程可能还在初始化
    await sleep(500);
    killPids(spawnedPids.filter(Boolean));
    console.log(`      收掉了测试起的 ${spawnedPids.filter(Boolean).length} 个隧道进程`);
    // 这句话原来写的是「原来那条隧道不受影响」——**那是错的**。
    // startTunnel 会先把现有隧道停掉，使用者那条从被顶掉那一刻起就没了，
    // 快速隧道的地址随进程一起作废、换不回来。不再说这种好听但不对的话。
    if (spawnedPids.length) {
      console.log('      ⚠ 这次真的起过隧道，使用者原来的隧道地址已经作废。');
    } else {
      console.log('      · 这次没起任何隧道，使用者的隧道和地址都没被动过。');
    }
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
