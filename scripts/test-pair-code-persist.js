// 配对码什么时候换 —— 签发后 90 天到期，重启期间沿用。
//
// 背景（这条测试就是那件事的回归）：
//   原来配对码是**进程启动时现生成的**，所以每重启一次网关就换一张。
//   规则改成：启动**沿用**文件里那张；签发后 90 天到期；
//   使用者可以在控制台点「换一个配对码」立刻换。
//
// 这里盯死三件事，都是很容易写错的：
//   A. 新鲜的码必须**沿用**（不然「重启就换」又回来了）；
//   B. 超过 90 天必须换（不然是一张永久有效的 6 位码）；
//   C. **内容没变就不许写文件** —— 每次启动都重写会刷新 mtime，
//      于是 90 天永远不到期（B 就白写了）。这条最隐蔽，所以单独验 mtime。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const pc = require('./pair-code.js');

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-paircode-'));
const file = path.join(dir, 'pair-code.txt');
const DAY = 24 * 60 * 60 * 1000;

function write(code, ageDays) {
  fs.writeFileSync(file, code, 'utf8');
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, t, t);
  }
  return fs.statSync(file).mtimeMs;
}

console.log('\n[1] 规则：新鲜的沿用、过期的才换\n');
{
  // 文件不存在（第一次装）
  try { fs.unlinkSync(file); } catch (e) { }
  const a = pc.loadOrCreate(file);
  ok('没有文件时发一张新的', /^[0-9]{6}$/.test(a.code) && a.reused === false, JSON.stringify(a));
  ok('发新的**不写文件**（写要等 listen 成功，见 pair-code.js 顶部）',
    !fs.existsSync(file), '文件被写出来了');

  // 刚发出去的 → 必须沿用
  write('111111', 0);
  const b = pc.loadOrCreate(file);
  ok('刚发过的码：重启后**沿用**同一张', b.code === '111111' && b.reused === true, JSON.stringify(b));

  // 89 天 → 还在有效期内
  write('222222', 89);
  const c = pc.loadOrCreate(file);
  ok('89 天：仍然沿用（没到 90 天）', c.code === '222222' && c.reused === true, JSON.stringify(c));

  // 91 天 → 换
  write('333333', 91);
  const d = pc.loadOrCreate(file);
  ok('91 天：发一张新的（90 天封顶）',
    d.reused === false && /^[0-9]{6}$/.test(d.code) && d.code !== '333333', JSON.stringify(d));

  // 启动时不能先写文件，但抽到旧码也绝不能声称已换码。
  write('333333', 91);
  const originalRandomInt = crypto.randomInt;
  const startupPicks = [333333, 444444];
  crypto.randomInt = () => startupPicks.shift();
  try {
    const changed = pc.loadOrCreate(file);
    ok('启动时随机数撞旧码仍会生成真正的新码，且不提前写文件',
      changed.code === '444444' && changed.reused === false &&
        fs.readFileSync(file, 'utf8').trim() === '333333');
  } finally {
    crypto.randomInt = originalRandomInt;
  }

  // 内容坏了（比如被别的程序写坏）→ 当没有
  write('not-a-code', 0);
  const e = pc.loadOrCreate(file);
  ok('文件内容不是 6 位数字：当成没有，发新的', e.reused === false && /^[0-9]{6}$/.test(e.code));

  ok('TTL 就是 90 天', pc.TTL_MS === 90 * DAY, String(pc.TTL_MS));
  const issuedAt = 1_000_000;
  const boundary = { code: '555555', issuedAt };
  ok('签发满 90 天的精确边界立即失效',
    pc.isFresh(boundary, issuedAt + pc.TTL_MS - 1) &&
      !pc.isFresh(boundary, issuedAt + pc.TTL_MS));
}

console.log('\n[1b] 网关不停机时，旧配对码也必须在签发 90 天后失效\n');
{
  const before = write('888888', 89);
  const startupCode = pc.loadOrCreate(file).code;
  const stillCurrent = pc.current(file);
  ok('未过期的读取不会续期（按签发时间，而不是最后使用时间）',
    stillCurrent.code === startupCode && fs.statSync(file).mtimeMs === before);
  const expired = new Date(Date.now() - 91 * DAY);
  fs.utimesSync(file, expired, expired);
  const current = typeof pc.current === 'function' ? pc.current(file) : null;
  ok('第 91 天再次配对会换码，旧码不再有效，文件与返回码一致',
    !!current && /^[0-9]{6}$/.test(current.code) &&
      current.code !== startupCode && fs.readFileSync(file, 'utf8').trim() === current.code,
    current ? '仍接受旧码或文件未更新' : '缺少供每次配对请求调用的 current 接口');

  write('777777', 91);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('simulated disk failure'); };
  try {
    ok('到期换码若无法落盘就报错，不能继续接受旧码',
      assert.throws(() => pc.current(file), /simulated disk failure/) === undefined &&
        fs.readFileSync(file, 'utf8').trim() === '777777');
  } finally {
    fs.writeFileSync = originalWrite;
  }
}

console.log('\n[2] 写文件：内容没变就不许碰（否则 90 天永远不到期）\n');
{
  const before = write('444444', 30);
  const wrote = pc.writeIfChanged(file, '444444');
  const after = fs.statSync(file).mtimeMs;
  ok('内容一样：不写文件', wrote === false);
  ok('内容一样：mtime 一点没动（「什么时候发的」保住了）', after === before,
    `${before} → ${after}`);

  const wrote2 = pc.writeIfChanged(file, '555555');
  ok('内容变了：写', wrote2 === true && fs.readFileSync(file, 'utf8').trim() === '555555');

  // 文件不存在时也要能写（第一次装完 listen 成功那一刻）
  try { fs.unlinkSync(file); } catch (e) { }
  const wrote3 = pc.writeIfChanged(file, '666666');
  ok('文件不存在：能写出来', wrote3 === true && fs.readFileSync(file, 'utf8').trim() === '666666');
}

console.log('\n[3] 手动换（控制台那个按钮）\n');
{
  write('777777', 0);
  const next = pc.rotate(file);
  ok('换出来的是一张新的 6 位码', /^[0-9]{6}$/.test(next) && next !== '777777', next);
  ok('文件里立刻是新码（不用等重启）', fs.readFileSync(file, 'utf8').trim() === next);
  const reload = pc.loadOrCreate(file);
  ok('换完再「重启」：沿用刚换的这张', reload.code === next && reload.reused === true);

  // 随机生成也可能撞到旧值：先强制碰撞，再给出不同的值，不能把旧码当新码。
  write('123456', 0);
  const originalRandomInt = crypto.randomInt;
  const picks = [123456, 234567];
  crypto.randomInt = () => picks.shift();
  try {
    const changed = pc.rotate(file);
    ok('随机数第一次撞旧码时继续生成，旧码确实作废',
      changed === '234567' && fs.readFileSync(file, 'utf8').trim() === '234567');
  } finally {
    crypto.randomInt = originalRandomInt;
  }
}

console.log('\n[4] 生成质量\n');
{
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const c = pc.generate();
    assert.match(c, /^[0-9]{6}$/);
    if (Number(c) < 100000 || Number(c) > 999999) { fail++; console.log(`  ✗ 越界: ${c}`); }
    seen.add(c);
  }
  ok('400 张全是 6 位、且在 100000–999999 之间', true);
  ok('400 张里绝大多数不重复（不是常量）', seen.size > 390, `${seen.size}/400`);
}

console.log('\n[5] 接线：网关真的按这条规则来了吗\n');
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  ok('启动是「沿用或新建」，不是每次都现生成',
    /let PAIR_CODE = pairCode\.loadOrCreate\(/.test(src));
  ok('原来那句「每次启动都换」的写法已经不在',
    !/const PAIR_CODE = String\(crypto\.randomInt/.test(src));
  ok('写文件走 writeIfChanged（不是无条件 writeFileSync）',
    /pairCode\.writeIfChanged\(PAIR_CODE_FILE/.test(src));
  ok('有「换一个配对码」这个控制台动作', /body\.action === 'rotate-pair-code'/.test(src));
  const pairRoute = src.slice(src.indexOf("if (u.pathname === '/pair')"),
    src.indexOf("if (u.pathname.startsWith('/t/')"));
  ok('/pair 每次请求先检查当前码，而不是一直使用启动时缓存',
    /currentPairCode\(\)/.test(pairRoute) &&
      pairRoute.indexOf('currentPairCode()') < pairRoute.indexOf('safeEqualStr(code, activePairCode)'));
  ok('配对码无法落盘时 /pair 拒绝配对，不回退旧缓存',
    /if \(!activePairCode\)[\s\S]*?writeHead\(503/.test(pairRoute));
  ok('控制台与 /pair 读取同一个当前码', /pairCode:\s*currentPairCode\(\)/.test(src));
  const startup = src.slice(src.indexOf('server.listen(PORT, () => {'),
    src.indexOf('startHttpsIfEnabled();'));
  ok('启动日志在落盘和校验当前码后记录，不显示未生效的旧码',
    startup.indexOf('writePairCodeFile();') >= 0 &&
    startup.indexOf('writePairCodeFile();') < startup.indexOf('currentPairCode()') &&
    startup.indexOf('currentPairCode()') < startup.indexOf('中间层已启动'));
  ok('配对页三种语言都不再误称「未使用 90 天」',
    !/超过 90 天没用过|90 days without use|90 días sin usarlo/.test(src));
  ok('配对码文件不可用时三种语言都有提示',
    (src.match(/pairUnavailable:/g) || []).length === 3);

  const html = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
  ok('控制台三种语言都不再误称「未使用 90 天」',
    !/超过 90 天没用过|90 days without use|90 días sin usarlo/.test(html));
  ok('控制台无可用码时提示检查日志，而不是只建议重启',
    html.includes("t('暂时无法读取配对码。请检查网关日志后重试。')") &&
      !html.includes("t('重启服务后会显示。')"));
  ok('控制台卡片上有这颗按钮', html.includes("t('换一个配对码')"));
  ok('确认框说清了「已经连上的手机不受影响」',
    /已经连上的手机不受影响，不用重新登录/.test(html));
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }

console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项）\n`);
process.exitCode = fail ? 1 : 0;
