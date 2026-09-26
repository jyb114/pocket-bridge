// 设备令牌的「滑动续期 + 自愈」——以及它的三条硬边界。
//
// 起因：设备在外出时令牌失效，无法访问电脑屏幕上的配对码，需要有界自愈。
//
// 原来有效期是**从配对那天算起的硬期限**（90 天），而且令牌一旦过期 / 被新令牌挤掉，
// 唯一出路就是回电脑前抄配对码 —— 人在外面等于失联。现在：
//   · 滑动续期：每次成功使用往后推 90 天（也就是「90 天没用过」才真过期）；
//   · 过期 / 被挤掉的令牌，只要**签名能用当前访问密钥验过**，就自动换一张新的。
//
// 这个测试守的就是「代价有没有被压住」：
//   ① 刚过期 → 自愈（换新令牌、续期、记录续了几次）
//   ② **注销过的设备绝不复活**（这是和「重新登记」唯一的分界线）
//   ③ 失效超过 REFRESH_GRACE_MS（90 天）→ 不再自愈，老实重新配对
//   ④ 滑动续期真的在动（用一次就把到期时间推后）
//   ⑤ 伪造签名 / 换过密钥 → 自愈不成立（必须重新配对）
//
// 跑法: node scripts/test-device-renewal.js（默认在临时目录跑单元测试）
//       node scripts/test-device-renewal.js --live（真机验证，会短暂修改设备表）
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const fixtureChild = process.argv.includes('--fixture-child');
const live = process.argv.includes('--live');
if (fixtureChild && !fs.existsSync(path.join(BASE, '.device-renewal-test-fixture'))) {
  throw new Error('--fixture-child 只能在自动创建的测试目录中运行');
}
if (!fixtureChild && !live) {
  // sessions.js 把设备表路径固定在自身所在目录。复制到新目录后运行原模块，
  // 才能真实验证续期逻辑，同时绝不读写使用者的 logs/ 与正在运行的网关。
  const prefix = path.join(os.tmpdir(), 'pocket-bridge-renewal-');
  const fixture = fs.mkdtempSync(prefix);
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'logs'));
    fs.writeFileSync(path.join(fixture, '.device-renewal-test-fixture'), 'isolated\n');
    fs.writeFileSync(path.join(fixture, 'logs', 'access-key.txt'), crypto.randomBytes(32).toString('hex'));
    for (const name of ['test-device-renewal.js', 'sessions.js', 'mobile-proxy.js']) {
      fs.copyFileSync(path.join(BASE, 'scripts', name), path.join(fixture, 'scripts', name));
    }
    const child = spawnSync(process.execPath,
      [path.join(fixture, 'scripts', 'test-device-renewal.js'), '--fixture-child'],
      { cwd: fixture, encoding: 'utf8', timeout: 2 * 60 * 1000 });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    if (child.error) throw child.error;
    process.exitCode = child.status === null ? 1 : child.status;
  } finally {
    if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('pocket-bridge-renewal-')) {
      throw new Error('拒绝清理非测试临时目录');
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return;
}
const sessions = require('./sessions.js');
const FILE = sessions.FILE;
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const PORT = 8080;

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  · ${n} —— 跳过（${why}）`); };

const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const tokKey = crypto.createHash('sha256').update(`dsh-gw-device|${KEY}`).digest();
const sign = (b) => crypto.createHmac('sha256', tokKey).update(b).digest('base64url');

const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
const wipe = () => fs.writeFileSync(FILE, JSON.stringify({ version: 1, devices: [] }));
const days = (ms) => Math.round(ms / 86400000);

/** 造一张「签名有效、但有效期是 expMs」的令牌 */
function mintWithExpiry(token, expMs) {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.e = expMs;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return parts[0] + '.' + body + '.' + sign(body);
}

console.log('\n=== 设备令牌：滑动续期与自愈的边界 · 回归 ===\n');

(async () => {
  try {
    // ── ① 刚过期 → 自愈 ────────────────────────────────────────────────────
    console.log('[1] 刚过期的令牌：自动换一张新的');
    wipe();
    const c1 = sessions.create({ ua: 'probe/1', ip: '9.9.9.9', authority: 'x.test', label: 'probe' });
    const id1 = c1.device.id;
    const expired1 = mintWithExpiry(c1.token, Date.now() - 1000);
    ok('过期的令牌本身验不过（reason=expired）',
      sessions.verify(expired1, { authority: 'x.test' }).reason === 'expired');
    const r1 = sessions.refresh(expired1, { authority: 'x.test' });
    ok('refresh 给出了一张新令牌', !!(r1 && r1.token));
    ok('新令牌验得过（自愈不是放行，是换新）',
      !!(r1 && sessions.verify(r1.token, { authority: 'x.test' }).ok));
    // ★ 别用 sessions.list() 查 renewedCount —— 那是给控制台看的精简视图
    //   （只有 id/label/时间/active 那几个字段）。要读原始记录。
    const raw1 = JSON.parse(fs.readFileSync(FILE, 'utf8')).devices.find((d) => d.id === id1);
    ok('有效期被推后到 90 天左右', days(raw1.expiresAt - Date.now()) >= 88, String(days(raw1.expiresAt - Date.now())));
    ok('记了一笔「续过几次」（控制台能看出来）', (raw1.renewedCount || 0) === 1, String(raw1.renewedCount));
    ok('还记了「最近一次续期时间」', !!raw1.renewedAt, String(raw1.renewedAt));

    // ── ② 注销过的设备绝不复活 ─────────────────────────────────────────────
    console.log('\n[2] 注销过的设备：绝不复活');
    sessions.revoke(id1);
    ok('注销后 refresh 直接拒绝', sessions.refresh(expired1, { authority: 'x.test' }) === null);

    // ── ③ 失效太久（超过宽限）→ 不再自愈 ──────────────────────────────────
    console.log('\n[3] 失效超过 90 天的旧令牌：不再自愈（要重新配对）');
    wipe();
    const c3 = sessions.create({ ua: 'probe/3', ip: '9.9.9.9', authority: 'x.test', label: 'old' });
    const ancient = mintWithExpiry(c3.token, Date.now() - 200 * 86400000);
    ok('失效 200 天 → refresh 拒绝', sessions.refresh(ancient, { authority: 'x.test' }) === null);
    const exactly = mintWithExpiry(c3.token, Date.now() - 89 * 86400000);
    ok('失效 89 天（还在宽限内）→ 仍然自愈', !!sessions.refresh(exactly, { authority: 'x.test' }));

    // ── ④ 滑动续期 ────────────────────────────────────────────────────────
    console.log('\n[4] 滑动续期：用一次就把到期时间推后');
    wipe();
    const c4 = sessions.create({ ua: 'probe/4', ip: '9.9.9.9', authority: 'x.test', label: 'sliding' });
    const id4 = c4.device.id;
    {
      const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db.devices.find((d) => d.id === id4).expiresAt = Date.now() + 86400000;   // 只剩 1 天
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    }
    sessions.verify(c4.token, { authority: 'x.test', ip: '9.9.9.9' });
    const after = sessions.list().find((d) => d.id === id4).expiresAt;
    ok('用过一次之后，到期时间回到 90 天左右', days(after - Date.now()) >= 88, String(days(after - Date.now())));

    // ── ⑤ 伪造 / 换过密钥 → 自愈不成立 ────────────────────────────────────
    console.log('\n[5] 伪造签名 / 换过访问密钥：必须重新配对');
    wipe();
    const c5 = sessions.create({ ua: 'probe/5', ip: '9.9.9.9', authority: 'x.test', label: 'forge' });
    const parts5 = c5.token.split('.');
    const forged = parts5[0] + '.' + parts5[1] + '.' + 'A'.repeat(parts5[2].length);
    ok('签名改过 → refresh 拒绝', sessions.refresh(forged, { authority: 'x.test' }) === null);
    const otherKey = crypto.createHash('sha256').update('dsh-gw-device|另一个密钥').digest();
    const bodyB = Buffer.from(JSON.stringify({ i: parts5[0], a: 'x.test', e: Date.now() - 1000 })).toString('base64url');
    const otherSig = crypto.createHmac('sha256', otherKey).update(bodyB).digest('base64url');
    ok('用别的密钥签的 → refresh 拒绝',
      sessions.refresh(parts5[0] + '.' + bodyB + '.' + otherSig, { authority: 'x.test' }) === null);

    // ── ⑥ 网关接线（源码级） ──────────────────────────────────────────────
    console.log('\n[6] 网关接线');
    ok('过期/被挤掉的令牌会走自愈（不只是表里没记录那一种）',
      /v\.reason === 'expired' \|\| v\.reason === 'superseded'/.test(SRC));
    ok('自愈之后把新令牌种回 cookie（否则下次还是过期的）',
      /deviceCookieValue\(back\.token\)/.test(SRC));
    ok('「正在验证」那一页有钥匙时给的是「重试」而不是「去配对页」',
      /needProofRetry/.test(SRC) && /var hasKey = false;/.test(SRC));
  } finally {
    if (backup) fs.writeFileSync(FILE, backup); else { try { fs.unlinkSync(FILE); } catch (e) { } }
    console.log('  · 设备表已还原');
  }

  // ── ⑦ 真网关：过期令牌真的能过设备门 ────────────────────────────────────
  console.log('\n[7] 真网关：过期令牌不再被赶去配对');
  if (fixtureChild) {
    skip('真网关那一段', '隔离目录只验证模块；没有连接真实网关');
    console.log(`\n${pass} 通过 / ${fail} 失败 / ${skipped} 跳过\n`);
    process.exit(fail ? 1 : 0);
  }
  // 多试几次再判「没在跑」：看门狗重启的那一两秒里 8080 可能是关着的
  const once = () => new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/__probe', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
  let up = false;
  for (let i = 0; i < 5 && !up; i++) {
    up = await once();
    if (!up) await new Promise((r) => setTimeout(r, 700));
  }
  if (!up) {
    skip('真网关那一段', `网关没在 127.0.0.1:${PORT} 上跑`);
  } else {
    const req = (opts) => new Promise((res) => {
      const r = http.request({
        host: '127.0.0.1', port: PORT, path: opts.path, method: opts.method || 'GET',
        headers: Object.assign({ host: 'renew-test.invalid:8080' }, opts.headers || {})
      }, (x) => {
        const c = [];
        x.on('data', (d) => c.push(d));
        x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString(), headers: x.headers }));
      });
      r.on('error', (e) => res({ status: 0, body: e.message, headers: {} }));
      r.end();
    });
    const deviceRejected = (r) => r.status === 403 &&
      r.headers['x-dsh-need-proof'] !== '1' && !/need-proof/.test(r.body);

    const before = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
    try {
      const login = await req({
        path: '/k/' + KEY,
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }
      });
      const cookie = (login.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
      const token = cookie.split('dsh-gw-session=')[1];
      const id = token.split('.')[0];
      const withTok = (t) => cookie.replace(/dsh-gw-session=[^;]+/, 'dsh-gw-session=' + t);

      const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db.devices.find((d) => d.id === id).expiresAt = Date.now() - 1000;
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2));

      const just = mintWithExpiry(token, Date.now() - 1000);
      const r1 = await req({ path: '/__targets', headers: { cookie: withTok(just), accept: 'application/json' } });
      ok('刚过期的令牌：不被设备门拒（自愈生效）', !deviceRejected(r1), `HTTP ${r1.status}`);
      const d = JSON.parse(fs.readFileSync(FILE, 'utf8')).devices.find((x) => x.id === id);
      ok('记录里的续期次数增加了', (d.renewedCount || 0) >= 1, String(d.renewedCount || 0));

      sessions.revoke(id);
      const r2 = await req({ path: '/__targets', headers: { cookie: withTok(just), accept: 'application/json' } });
      ok('同一张令牌在注销之后：被设备门拒（不复活）', deviceRejected(r2), `HTTP ${r2.status}`);

      const db2 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const d2 = db2.devices.find((x) => x.id === id);
      d2.revokedAt = null;
      fs.writeFileSync(FILE, JSON.stringify(db2, null, 2));
      const old = mintWithExpiry(token, Date.now() - 200 * 86400000);
      const r3 = await req({ path: '/__targets', headers: { cookie: withTok(old), accept: 'application/json' } });
      ok('失效 200 天的令牌：被设备门拒（要求重新配对）', deviceRejected(r3), `HTTP ${r3.status}`);
    } finally {
      if (before) fs.writeFileSync(FILE, before); else { try { fs.unlinkSync(FILE); } catch (e) { } }
      console.log('  · 设备表已还原（真网关那一段）');
    }
  }

  console.log(`\n${pass} 通过 / ${fail} 失败` + (skipped ? ` / ${skipped} 跳过` : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  if (backup) fs.writeFileSync(FILE, backup);
  console.log('跑挂了：' + (e && e.stack));
  process.exit(1);
});
