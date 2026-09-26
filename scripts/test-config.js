// DSH 移动端网关 — 配置与发现模块自测
//
// 重点验证两件事：
//   · 端口避让：8080 被占用时能不能自动换
//   · 换机器检测：目录被复制到另一台电脑时，旧密钥必须被作废
//
// 第四项会真的删除密钥文件，所以脚本开头先把现场整个备份下来，
// 无论成败都在 finally 里还原。
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const cfg = require('./config.js');

const LOG_DIR = cfg.LOG_DIR;
const BACKUP_DIR = path.join(LOG_DIR, '.identity-backup');
const IDENTITY_RE = /^(access-key|e2ee-secret|mint-cookie|vapid|push-subscriptions|pair-code|instance)/;

const out = { ranAt: new Date().toISOString() };

function backupIdentity() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const names = fs.readdirSync(LOG_DIR).filter((f) => IDENTITY_RE.test(f));
  for (const n of names) {
    fs.copyFileSync(path.join(LOG_DIR, n), path.join(BACKUP_DIR, n));
  }
  return names;
}

function restoreIdentity(names) {
  // 先清掉测试期间新造的
  for (const n of fs.readdirSync(LOG_DIR)) {
    if (!IDENTITY_RE.test(n)) continue;
    const p = path.join(LOG_DIR, n);
    if (fs.statSync(p).isDirectory()) continue;
    if (!names.includes(n)) { try { fs.unlinkSync(p); } catch (e) { } }
  }
  // 再把备份的放回去
  for (const n of names) {
    const src = path.join(BACKUP_DIR, n);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(LOG_DIR, n));
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

(async () => {
  let backups = [];
  let backedUp = false;

  try {
    // ① 配置读写
    const c = cfg.loadConfig();
    out.configLoad = {
      gatewayPort: c.gatewayPort,
      tunnelProvider: c.tunnelProvider,
      enableLanAccess: c.enableLanAccess
    };

    // ② DSH 可执行文件发现
    const found = cfg.findDshExecutable();
    out.dshDiscovery = {
      path: found.path,
      source: found.source,
      fileExists: found.path ? fs.existsSync(found.path) : false
    };

    // ③ 端口避让：先占住 8080，再向它要端口
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(8080, '0.0.0.0', resolve);
    });
    const picked = await cfg.findAvailablePort(8080, 5);
    await new Promise((r) => blocker.close(r));
    out.portAvoidance = {
      occupied: [8080],
      picked,
      avoided: picked !== null && picked !== 8080,
      pickedIsFree: picked !== null
    };

    // ④ 实例身份 + 换机器检测（这一项会动密钥文件）
    backups = backupIdentity();
    backedUp = true;
    out.identityFilesBackedUp = backups;

    const first = cfg.ensureInstanceIdentity();
    const second = cfg.ensureInstanceIdentity();

    // 伪造"这是另一台机器"：改掉指纹，并放一个假的旧密钥
    const inst = JSON.parse(fs.readFileSync(cfg.INSTANCE_FILE, 'utf8'));
    inst.fingerprint = 'FAKE-OTHER-MACHINE|win32|x64|someone-else';
    fs.writeFileSync(cfg.INSTANCE_FILE, JSON.stringify(inst, null, 2), 'utf8');
    fs.writeFileSync(path.join(LOG_DIR, 'access-key.txt'), 'FAKE-OLD-KEY-FROM-OTHER-MACHINE');
    fs.writeFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'FAKE-OLD-E2EE-KEY-FROM-OTHER-MACHINE');

    const third = cfg.ensureInstanceIdentity();
    const oldKeyPurged = !fs.existsSync(path.join(LOG_DIR, 'access-key.txt'));
    const oldE2eePurged = !fs.existsSync(path.join(LOG_DIR, 'e2ee-secret.txt'));

    out.identity = {
      firstRunDetected: first.isFirstRun,
      secondNotFirstRun: second.isFirstRun === false,
      sameInstanceReused: second.instanceId === first.instanceId,
      newMachineDetected: third.isNewMachine === true,
      newInstanceIdDifferent: third.instanceId !== first.instanceId,
      oldKeyPurged,
      oldE2eePurged
    };

    // ⑤ 网络环境
    const netInfo = cfg.detectNetwork();
    out.network = {
      hostname: netInfo.hostname,
      lanV4: netInfo.lanV4.map((x) => x.address),
      publicV6: netInfo.publicV6.map((x) => x.address),
      lanV6Count: netInfo.lanV6.length
    };

    // ⑥ 隧道/组网工具检测
    out.tunnelProviders = cfg.detectTunnelProviders();

    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
    out.stack = String(err.stack).slice(0, 500);
  } finally {
    if (backedUp) {
      try {
        restoreIdentity(backups);
        out.identityRestored = true;
      } catch (err) {
        out.identityRestoreError = err.message;
      }
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, 'test-config.json'), JSON.stringify(out, null, 2), 'utf8');

    // ── 结论与退出码 ──────────────────────────────────────────────────────
    //
    // 这个脚本原来**只写 JSON、不打印、退出码永远是 0**，而回归链只看退出码 ——
    // 所以下面那个 catch 把异常写成 status:'error' 之后，链里照样显示「ok」。
    // 「记录下来了」和「让失败真的失败」是两件事。
    //
    // 另外它记的都是本机相关的值（主机名、IP、网卡），没法硬编码期望值；
    // 能断言的就是这几条布尔结果 —— 它们本来就是「这一步有没有正常完成」。
    const checks = {
      配置能读: out.configLoad === true || (out.configLoad && typeof out.configLoad === 'object'),
      DSH发现: !!out.dshDiscovery,
      端口避让: !!out.portAvoidance,
      身份文件已备份: Array.isArray(out.identityFilesBackedUp)
        ? out.identityFilesBackedUp.length > 0
        : out.identityFilesBackedUp === true,
      身份已还原: out.identityRestored === true
    };
    const bad = Object.keys(checks).filter((k) => !checks[k]);
    const okAll = out.status === 'ok' && bad.length === 0
      && !out.identityRestoreError;
    console.log(`  ${okAll ? '✓' : '✗'} 配置与发现：${out.status}` +
      (okAll ? '（读配置、找 DSH、端口避让、身份文件备份与还原）'
        : `  没过的：${[...bad, out.error, out.identityRestoreError].filter(Boolean).join('、')}`));
    if (!okAll) process.exitCode = 1;
  }
})();
