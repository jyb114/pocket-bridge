// 更换加密密钥 —— 这个动作会**让手机书签失效**，所以必须验得仔细。
//
// 要验的：
//   1. 换出来的是新密钥，且长度够
//   2. 换完旧密钥确实作废（用旧密钥解不开新密文）
//   3. 拼出来的地址格式对（密钥在 # 后面）
//   4. **测完要能还原** —— 测试不能把使用者的书签弄坏
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const SECRET_FILE = path.join(BASE, 'logs', 'e2ee-secret.txt');
const e2ee = require('./e2ee.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 更换加密密钥 ===\n');

  // 先备份 —— 测完必须还原，否则使用者的书签就废了
  const backup = fs.existsSync(SECRET_FILE)
    ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : null;
  console.log(`  测试前密钥: ${backup ? backup.slice(0, 6) + '…' : '（没有）'}`);

  // 兜底：下面的 finally 只管**异常**，管不了被 Ctrl+C / 被强杀。
  // 这个测试真的会改写使用者的 logs/e2ee-secret.txt —— 换掉就等于废掉手机上
  // 已经存好的链接。所以信号也要接住，否则中途按一下 Ctrl+C 就把书签弄坏了，
  // 而使用者完全不知道发生了什么。
  const restoreSecret = () => {
    try { if (backup) fs.writeFileSync(SECRET_FILE, backup, 'utf8'); } catch (err) { /* 尽力而为 */ }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      restoreSecret();
      console.log(`\n  收到 ${sig}：已把密钥还原成原来的，再退出。`);
      process.exit(130);
    });
  }

  try {
    // ── 1. 跑一次轮换 ────────────────────────────────────────────
    //
    // ★ 必须带上 DSH_GW_NO_NOTIFY=1。
    //
    // 这个测试会真的调用 rotate-e2ee.js，而那个脚本以前默认就发推送 ——
    // 于是**每跑一次测试套件，使用者手机就收到一条「加密密钥已更换」**。
    // 从使用者视角看就是「密钥莫名其妙自己在变」，明明没人按过按钮；
    // 这些推送还把 ntfy 刷到限流（429），正常通知反而收不到了。
    //
    // 用环境变量而不是命令行参数，是刻意的：测试是「只读」性质的东西，
    // 不该对外界产生副作用。这样即使以后有人给这行加了 --notify，
    // 环境变量也会把它封死。
    const out = execFileSync(process.execPath,
      [path.join(BASE, 'scripts', 'rotate-e2ee.js')],
      { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' }) });

    console.log('  ── 脚本输出 ──');
    out.trim().split('\n').forEach((l) => console.log('    ' + l));

    const after = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    ok('生成了新密钥', !!after && after.length >= 16, `${after.length} 字符`);
    ok('新密钥和旧的不同', after !== backup);

    // ── 2. 旧密钥必须作废 ────────────────────────────────────────
    if (backup) {
      const msg = '这段内容是用新密钥加密的';
      const keys = e2ee.deriveKeys(after, e2ee.slotAt());
      const ct = e2ee.encrypt(keys.b, msg);

      const oldKeys = e2ee.deriveKeys(backup, e2ee.slotAt());
      ok('用旧密钥解不开（说明确实作废了）', e2ee.decrypt(oldKeys.b, ct) === null);
      ok('用新密钥解得开', (() => {
        const back = e2ee.decrypt(keys.b, ct);
        return back && back.toString('utf8') === msg;
      })());
    }

    // ── 3. 输出里的地址格式 ──────────────────────────────────────
    ok('输出里给出了带 #k= 的手机地址', /#k=[A-Za-z0-9_-]{16,}/.test(out),
      out.split('\n').find((l) => l.includes('#k=')) || '（没找到）');
    ok('明确说了旧密钥作废', /作废/.test(out));
    ok('地址里的密钥和文件里的一致',
      out.includes('#' + 'k=' + after) || out.includes('#k=' + after));

    // ── 4. 默认**不能**发推送 ────────────────────────────────────
    //
    // 这里原来验的是「配了推送就要报推送结果」—— 那等于把「测试会发推送」
    // 当成正确行为固化下来。现在反过来验：默认就该什么都不发。
    ok('默认不发推送（测试不能给使用者手机发消息）',
      !/已通知手机|推送没成功/.test(out), out.split('\n').slice(-2).join(' / '));
    ok('默认情况下明确说了「没有推送」', /没有推送/.test(out) || /没配推送通道/.test(out));
    ok('输出里仍然给出了手机能用的完整地址', /#k=[A-Za-z0-9_-]{16,}/.test(out));

    // 再验一次「封死开关」真的封得死：显式要推送也必须发不出去
    const blocked = execFileSync(process.execPath,
      [path.join(BASE, 'scripts', 'rotate-e2ee.js'), '--notify'],
      { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' }) });
    ok('即使显式 --notify，DSH_GW_NO_NOTIFY=1 也能封死推送',
      /封死/.test(blocked) && !/已通知手机/.test(blocked),
      blocked.split('\n').slice(-2).join(' / '));
  } catch (err) {
    fail++;
    console.log(`  ✗ 执行出错: ${err.message}`);
  } finally {
    // ── 还原 ────────────────────────────────────────────────────
    if (backup) {
      fs.writeFileSync(SECRET_FILE, backup, 'utf8');
      const restored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      ok('测完已还原成原来的密钥（不能弄坏使用者的书签）', restored === backup);
    }
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
