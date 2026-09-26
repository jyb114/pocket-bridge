// 脱敏诊断包的回归测试 —— 计划 H「诊断包不包含凭据或正文」。
//
// 关键点：这里**不信任脚本自己的自检**。脚本会在写出前拿真实凭据回搜一遍产物
// （搜到就拒绝写出），但那个自检和脱敏规则是同一份代码写的 —— 规则漏了，
// 自检很可能一起漏。所以这个测试**独立地**再搜一遍：
// 自己读真实凭据，自己去产物里找，判据不共用。
//
// 另外还要验它**有用**：一个什么都不含的诊断包当然是安全的，但也没意义。
// 所以既查「不该有的没有」，也查「该有的在」。
//
// ⚠️ **这条不进 CI 子集**：CI 上没有 logs/、没有本机凭据，于是
//    「产物里没有凭据」那几条会变成**空转**（没有秘密可搜，当然搜不到）。
//    空转的绿灯比红灯更危险 —— 所以宁可在 CI 上不跑它，也不让它假装验过。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

function readMaybe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (err) { return null; } }

// ── 独立收集真实凭据（和 diagnostic-bundle.js 各写一份，刻意不共用）──────────
const secrets = [];
{
  const k = readMaybe(path.join(LOG_DIR, 'access-key.txt'));
  if (k) secrets.push(['访问密钥', k]);
  const e = readMaybe(path.join(LOG_DIR, 'e2ee-secret.txt'));
  if (e) secrets.push(['端到端加密密钥', e]);
  // 配对码也是凭据：它会出现在日志与 status.json 里，而诊断包是要发给别人的。
  // 6 位数字不能像长密钥那样直接 includes() 搜（那是全文匹配，判据不同），
  // 所以它单列一条断言，见下面「没有当前配对码」。
  const pc = readMaybe(path.join(LOG_DIR, 'pair-code.txt'));
  if (pc) secrets.push(['配对码', pc]);

  const nf = readMaybe(path.join(LOG_DIR, 'notify-targets.json'));
  if (nf) {
    try {
      const j = JSON.parse(nf);
      const m1 = String(j.ntfy || '').match(/ntfy\.sh\/(.+)$/);
      if (m1) secrets.push(['ntfy 主题', m1[1]]);
      const m2 = String(j.bark || '').match(/api\.day\.app\/(.+)$/);
      if (m2) secrets.push(['Bark key', m2[1]]);
    } catch (err) { }
  }
  const v = readMaybe(path.join(LOG_DIR, 'vapid.json'));
  if (v) {
    try { const j = JSON.parse(v); if (j.privateKey) secrets.push(['Web Push 私钥', j.privateKey]); }
    catch (err) { }
  }
}

const fingerprints = (() => {
  const raw = readMaybe(path.join(LOG_DIR, 'devices.json'));
  if (!raw) return [];
  try { return (JSON.parse(raw).devices || []).map((d) => d.fp).filter(Boolean); }
  catch (err) { return []; }
})();

console.log('\n=== 脱敏诊断包 ===\n');
console.log(`  独立收集到凭据 ${secrets.length} 项、设备指纹 ${fingerprints.length} 个，用来搜产物\n`);

// ── 生成（走 stdout，不落盘、不污染 logs）────────────────────────────────────
let out = '';
let genOk = true;
try {
  out = execFileSync(process.execPath, [path.join(BASE, 'scripts', 'diagnostic-bundle.js'), '--stdout'],
    { cwd: BASE, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
} catch (err) {
  genOk = false;
  out = String((err && err.stdout) || '');
  console.log(`  ✗ 生成失败：${(err && err.message) || err}`);
  failed++;
}

if (genOk) {
  // 输出前面是给人看的一行行说明，JSON 从第一个 { 开始
  const at = out.indexOf('{');
  const jsonText = at >= 0 ? out.slice(at) : '';
  let bundle = null;
  try { bundle = JSON.parse(jsonText); } catch (err) { }

  // ── 1. 不该有的：真实凭据 ────────────────────────────────────────────────
  console.log('[1] 不该出现的');
  const leaked = secrets.filter(([, v]) => v && v.length >= 8 && jsonText.includes(v)).map(([n]) => n);
  ok('产物里没有本机凭据', leaked.filter((n) => n !== '配对码').length === 0,
    leaked.filter((n) => n !== '配对码').join('、') || '密钥/推送凭据都不在');

  // 短凭据单独一条：按数字边界搜，和 diagnostic-bundle.js 的判据一致。
  // 这条是实测出来的 —— 产物里原本能搜到当前有效的 6 位配对码
  // （来自「配对码 XXXXXX」那行日志和 status.json），而包上写着「不含密钥、令牌」。
  {
    const pc = (secrets.find(([n]) => n === '配对码') || [])[1] || '';
    const hit = pc ? new RegExp('(?<![0-9])' + pc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])').test(jsonText) : false;
    ok('产物里没有当前配对码', !hit, hit ? '配对码原样出现在产物里' : (pc ? '没有（按数字边界搜过）' : '这台机器没有配对码文件，跳过'));
  }

  const fpLeaked = fingerprints.filter((f) => jsonText.includes(f));
  ok('产物里没有设备指纹', fpLeaked.length === 0, `${fpLeaked.length} 个命中`);

  ok('没有私钥块', !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(jsonText));

  const home = os.homedir();
  ok('没有可识别的用户目录路径', !home || !jsonText.includes(home));

  // ★ 这条是**真的**在查正文，不是空转。
  //
  //   原来这里写的是「产物里没有 __DIAG_CONTENT_PROBE__」—— 可我从来没塞过
  //   那个标记词，所以它永远通过。空转的检查比没有更糟：它会让人以为查过了。
  //
  //   真正要防的是：日志里落进了使用者的路径与目录名（实测发生过一次 ——
  //   网关把「拒绝越界读文件」的完整路径写进日志，里面有用户名和项目名），
  //   而诊断包会取日志尾部。所以直接查产物里有没有绝对路径。
  // 注意 `\b`：不加的话 `https://x` 里的 `s:/` 会被当成盘符路径，
  // 于是每条隧道地址都误报一次（这个误报我自己踩过）。
  const logText = JSON.stringify((bundle && bundle.logs) || {});
  const absPathHit = logText.match(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g) || [];
  ok('日志段里没有绝对路径（用户名/项目名不会跟着走）',
    absPathHit.length === 0, absPathHit.slice(0, 2).join(' | '));
  ok('日志段里没有用户名', !home || !logText.includes(path.basename(home)));

  // ── 2. 该有的：有用信息 ──────────────────────────────────────────────────
  //
  // 一个什么都不含的诊断包当然安全，但也没意义。所以这些必须在。
  console.log('\n[2] 该有的');
  ok('产物是合法 JSON', !!bundle);
  if (bundle) {
    ok('有运行环境（系统 / Node / 内存）', !!bundle.runtime && !!bundle.runtime.node,
      bundle.runtime && bundle.runtime.node);
    ok('有网关与隧道状态', !!bundle.status, bundle.status ? '有' : '缺');
    ok('有隧道可达性（三态里的「公网可达」那项）',
      !!(bundle.status && bundle.status.tunnel && 'reachable' in bundle.status.tunnel),
      bundle.status && bundle.status.tunnel ? JSON.stringify({
        running: bundle.status.tunnel.running, reachable: bundle.status.tunnel.reachable
      }) : '缺');
    ok('有日志尾部（排查要用）', !!(bundle.logs && (bundle.logs.proxy || bundle.logs.daemon)));

    // 设备列表要**留下有用的、去掉能对上号的**
    const dev = bundle.devices;
    if (Array.isArray(dev) && dev.length) {
      ok('设备列表保留了类型与时间', dev.every((d) => 'label' in d && 'createdAt' in d));
      ok('设备列表里没有指纹与 IP',
        dev.every((d) => !('fp' in d) && !('fps' in d) && !('lastIp' in d)),
        Object.keys(dev[0]).join(','));
    } else {
      console.log('  · 没有已配对设备，跳过设备列表那两条');
    }
  }
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
