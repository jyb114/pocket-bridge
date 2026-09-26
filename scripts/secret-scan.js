// 发布前秘密扫描 —— 计划 G「包内无本机钥匙/上传/私钥/会话」的验收工具。
//
// 为什么必须有它：这个项目在**使用者自己的电脑上**跑，运行数据里装着能直接
// 连进那台电脑的东西（访问密钥、端到端加密密钥、推送凭据、设备指纹，还有
// 使用者上传的私人文件）。这些东西一旦进了公开仓库，拿到的人不需要任何
// 其它信息就能进去 —— 而 **git 历史删不掉**，只能事后轮换密钥。
//
// 所以扫描分四层，缺一层就有一种漏法：
//
//   1. **已知的本机秘密**不能出现在任何被跟踪的文件里
//      （拿真实值去比，不靠猜格式 —— 这是最硬的一层）
//   2. **已知的本机秘密**不能出现在 git 历史里
//      （工作区干净 ≠ 历史干净；先提交后删是最常见的漏法）
//   3. **通用特征**：私钥块、API key 形态、推送凭据形态
//      （防的是「这台机器上还没有、但将来会有的」那类）
//   4. **该被忽略的路径真的被忽略了**，而且没有被跟踪
//      （.gitignore 少一条，下一轮 git add . 就带出去了）
//
// 用法：
//   node scripts/secret-scan.js          扫一遍，发现即非零退出
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');

// 扫「通用特征」时要跳过自己：下面那些正则的字面量就写在本文里，
// 不跳过的话每次都会自我命中。（这是唯一一个合理的跳过。）
const SELF = path.join('scripts', 'secret-scan.js');

// --strict：把「历史里有」也算失败。默认不算，理由见下面历史那一节。
const STRICT = process.argv.includes('--strict');

let bad = 0;
let warned = 0;
const fail = (msg) => { console.log(`  ✗ ${msg}`); bad++; };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const note = (msg) => console.log(`  · ${msg}`);

function git(args, opts) {
  try {
    return execFileSync('git', args, Object.assign({ cwd: BASE, encoding: 'utf8', timeout: 60000 }, opts || {})).trim();
  } catch (err) {
    return null;
  }
}

function readMaybe(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) { return null; }
}

// ── 1. 收集这台机器上真实存在的秘密 ─────────────────────────────────────────
//
// 只收**够长、够独特**的值。太短的值（比如 4 位配对码）满仓库都是巧合命中，
// 只会把报告淹掉，让人开始忽略它 —— 那比不扫还糟。
function collectSecrets() {
  const out = [];
  const add = (name, value, why) => {
    const v = String(value || '').trim();
    if (v.length >= 12) out.push({ name, value: v, why });
  };

  add('访问密钥', readMaybe(path.join(LOG_DIR, 'access-key.txt')), '拿到就能连进这台电脑');

  add('端到端加密密钥', readMaybe(path.join(LOG_DIR, 'e2ee-secret.txt')), '拿到就能解开所有内容');

  // 推送凭据：ntfy 的 topic / Bark 的 key —— 知道就能读走你的通知
  const notifyRaw = readMaybe(path.join(LOG_DIR, 'notify-targets.json'));
  if (notifyRaw) {
    try {
      const n = JSON.parse(notifyRaw);
      const m1 = String(n.ntfy || '').match(/ntfy\.sh\/([A-Za-z0-9_-]{8,})/);
      if (m1) add('ntfy 主题', m1[1], '知道主题就能订阅走你的通知');
      const m2 = String(n.bark || '').match(/api\.day\.app\/([A-Za-z0-9_-]{8,})/);
      if (m2) add('Bark key', m2[1], '知道 key 就能读走你的通知');
    } catch (err) { /* 文件坏了就不收，别把扫描器弄崩 */ }
  }

  // Web Push 私钥
  const vapidRaw = readMaybe(path.join(LOG_DIR, 'vapid.json'));
  if (vapidRaw) {
    try {
      const v = JSON.parse(vapidRaw);
      add('Web Push 私钥', v.privateKey, '拿到就能冒充服务端给这台机器推通知');
    } catch (err) { }
  }

  // 设备指纹：不是钥匙，但能对上「哪台设备是你」
  const devRaw = readMaybe(path.join(LOG_DIR, 'devices.json'));
  if (devRaw) {
    try {
      const d = JSON.parse(devRaw);
      for (const dev of (d.devices || [])) {
        if (dev.fp) add('设备指纹', dev.fp, '能对上这是哪台设备');
      }
    } catch (err) { }
  }

  return out;
}

const SECRETS = collectSecrets();

console.log('\n=== 发布前秘密扫描 ===\n');
if (!SECRETS.length) {
  note('这台机器上还没有任何运行数据（没有 logs/ 下的凭据），只跑通用特征与忽略规则');
} else {
  console.log(`  本机现有凭据 ${SECRETS.length} 项：` +
    [...new Set(SECRETS.map((s) => s.name))].join('、') + '\n');
}

// ── 2. 被跟踪的文件里不能有本机秘密 ─────────────────────────────────────────
const tracked = (git(['ls-files']) || '').split('\n').filter(Boolean);
// 发布者最容易用 `git add .`，所以未跟踪、但**没有被忽略**的文件也必须
// 一起扫。否则扫描虽然全绿，下一步一 add 才把本机配置或私密文档带进去，
// 这份工具就没有完成它承诺的发布前保护。
const untracked = (git(['ls-files', '-o', '--exclude-standard']) || '').split('\n').filter(Boolean);
const publishCandidates = [...new Set(tracked.concat(untracked))];

{
  console.log('[1] 被跟踪的文件（也就是会随仓库发出去的东西）');
  const hits = [];
  for (const s of SECRETS) {
    for (const f of publishCandidates) {
      let text;
      try {
        const st = fs.statSync(path.join(BASE, f));
        if (st.size > 4 * 1024 * 1024) continue;         // 大文件跳过（本项目没有）
        text = fs.readFileSync(path.join(BASE, f), 'utf8');
      } catch (err) { continue; }
      if (text.indexOf(s.value) >= 0) hits.push(`${s.name}（${s.why}）出现在 ${f}`);
    }
  }
  if (hits.length) hits.forEach(fail);
  else pass(`${publishCandidates.length} 个发布候选文件（已跟踪 ${tracked.length}，未跟踪 ${untracked.length}）里没有本机凭据`);
}

// ── 3. git 历史里也不能有 ───────────────────────────────────────────────────
//
// 这一层最容易漏：文件删了、工作区干净了，历史里那份还在。
// 用 pickaxe（git log -S）找「增删过这个字符串」的提交。
//
// ⚠️ 历史命中默认是**警告，不是失败**。理由要说清楚，不然这条设计看着像放水：
//    历史泄露**不改写仓库就修不掉**。把它设成红灯的话，除非使用者愿意
//    重做整个仓库，这条检查会永远红 —— 而一个永远红的检查，下场就是
//    所有人都不再看它，连带把「工作区泄露」这种真能修的也一起忽略。
//    所以默认只响亮地报出来 + 给准确的做法；要严格把关就加 --strict。
{
  console.log('\n[2] git 历史');
  const commits = (git(['rev-list', '--all', '--count']) || '0').trim();
  if (commits === '0') {
    note('还没有任何提交，历史层无可扫');
  } else {
    const hits = [];
    for (const s of SECRETS) {
      const r = git(['log', '--all', '--oneline', '-S' + s.value]);
      if (r) hits.push(`${s.name}（${s.why}）出现在历史提交里：${r.split('\n').slice(0, 3).join(' / ')}`);
    }
    if (!hits.length) {
      pass(`${commits} 个提交的历史里没有本机凭据`);
    } else if (STRICT) {
      hits.forEach(fail);
      console.log('      → 历史删不掉：轮换这些凭据（控制台「更换密钥」）之后重做仓库');
    } else {
      hits.forEach((h) => console.log(`  ! 历史里有：${h}`));
      console.log('      → 这个**修不掉**（git 历史删不掉），所以只报警不判失败。');
      console.log('        真要发布的话，正确做法是**轮换这些凭据**（换了旧的就没用了），');
      console.log('        而不是去改写历史 —— 改写历史既容易出错，也拦不住已经拉走的人。');
      console.log('        要让这一层也拦发布，加 --strict。');
      warned += hits.length;
    }
  }
}

// ── 4. 通用特征 ─────────────────────────────────────────────────────────────
{
  console.log('\n[3] 通用特征（防的是「将来才会有的」那类）');
  const RULES = [
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥块' },
    { re: /\bsk-[A-Za-z0-9_-]{20,}/, why: 'API key 形态（OpenAI 那类）' },
    { re: /ntfy\.sh\/[A-Za-z0-9_-]{8,}/, why: '写死的 ntfy 主题' },
    { re: /api\.day\.app\/[A-Za-z0-9_-]{8,}/, why: '写死的 Bark key' },
    { re: /"privateKey"\s*:\s*"[A-Za-z0-9_\-]{20,}"/, why: '写死的推送私钥' }
  ];

  // 明显是**占位符**的要放过：帮助文案里到处是
  // `https://api.day.app/xxxxxxxxxxxx`、`ntfy.sh/你的topic` 这种例子。
  // 不放过的话，每次扫描都会报一堆假问题，然后人就开始不看这份报告了 ——
  // 一个总在喊狼来了的扫描器比没有扫描器更糟。
  const isPlaceholder = (s) => {
    const body = s.replace(/^.*\//, '');
    if (/^(x+|0+|y+|z+|-+|_+)$/i.test(body)) return true;          // 全是一样的字符
    if (new Set(body).size <= 2) return true;                       // 只有一两种字符
    return /你的|我的|your|topic|key|xxx|placeholder|example|例/i.test(s);
  };

  const hits = [];
  for (const f of publishCandidates) {
    if (f === SELF) continue;
    let text;
    try {
      const st = fs.statSync(path.join(BASE, f));
      if (st.size > 4 * 1024 * 1024) continue;
      text = fs.readFileSync(path.join(BASE, f), 'utf8');
    } catch (err) { continue; }
    for (const r of RULES) {
      const re = new RegExp(r.re.source, 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        if (isPlaceholder(m[0])) continue;
        hits.push(`${f}：${r.why} → ${String(m[0]).slice(0, 40)}…`);
      }
    }
  }
  if (hits.length) hits.forEach(fail);
  else pass('没有私钥块 / 写死的 API key / 写死的推送凭据（占位符已排除）');
}

// ── 5. 该被忽略的路径真的被忽略了 ───────────────────────────────────────────
//
// 这是**回归检查**：.gitignore 少一条，下一轮 `git add .` 就把它带出去了。
// 尤其 uploads/ —— 那装的是使用者自己传上来的私人文件，不属于这个项目。
{
  console.log('\n[4] 忽略规则与「不该被跟踪」');
  const mustIgnore = [
    ['logs/', '运行数据（密钥、设备、队列、日志）'],
    ['tls/', '本机 CA 与证书私钥'],
    ['uploads/', '使用者上传的私人文件'],
    ['runtime/', '内置运行时（体积大、另有许可）'],
    ['cloudflared/', '第三方二进制（Apache 2.0）'],
    ['current-url.txt', '当前地址（含密钥）'],
    ['config/hooks.json', '本机 DSH hook 配置（含绝对路径）'],
    ['before.png', '测试截图（可能带真实会话内容）'],
    ['after.png', '测试截图（可能带真实会话画面）']
  ];
  const missing = [];
  for (const [p, why] of mustIgnore) {
    let ignored = false;
    try { execFileSync('git', ['check-ignore', '-q', p], { cwd: BASE, stdio: 'ignore' }); ignored = true; }
    catch (err) { ignored = false; }
    if (!ignored) missing.push(`${p}（${why}）没被 .gitignore 挡住`);
  }
  if (missing.length) missing.forEach(fail);
  else pass(`${mustIgnore.length} 个敏感路径都被忽略了`);

  const leaked = tracked.filter((f) => /^(logs|tls|uploads|runtime|cloudflared)\//.test(f));
  if (leaked.length) fail(`这些敏感目录下的文件**已经被跟踪**了：${leaked.slice(0, 5).join(', ')}`);
  else pass('敏感目录里没有任何文件被跟踪');
}

// ── 6. 顺带报一下会发出去多少东西（供人工过目）──────────────────────────────
{
  console.log('\n[5] 这次会发出去的内容概览');
  const byTop = {};
  for (const f of tracked) {
    const top = f.includes('/') ? f.split('/')[0] + '/' : f;
    byTop[top] = (byTop[top] || 0) + 1;
  }
  Object.keys(byTop).sort((a, b) => byTop[b] - byTop[a])
    .forEach((k) => console.log(`      ${k.padEnd(22)} ${byTop[k]} 个`));
}

console.log(`\n${bad ? `${bad} 处问题` : (warned ? '工作区干净（历史里有 ' + warned + ' 处，见上）' : '干净：可以发布')}\n`);
process.exitCode = bad ? 1 : 0;
