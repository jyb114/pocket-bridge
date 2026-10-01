// 发布就绪检查 —— 开源之前必须过的几道关。
//
// 为什么要有这个测试：这些事（有没有密钥混进仓库、许可证全不全、名字中不中性）
// 靠人记得检查是不可靠的。尤其是密钥 —— 一旦提交进 git 历史就删不掉了，
// 只能事后轮换。所以让机器每次替我们看一遍。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  + ' + n); }
  else { fail++; console.log('  x ' + n + (e ? '  -> ' + e : '')); }
};

const read = (f) => { try { return fs.readFileSync(path.join(BASE, f), 'utf8'); } catch (e) { return null; } };

console.log('\n=== 发布就绪检查 ===\n');

// ── 1. 该有的文件都在 ──────────────────────────────────────────
console.log('[1] 必备文件');
for (const f of ['LICENSE', '.gitignore', '.gitattributes', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'package.json', 'CHANGELOG.md']) {
  ok(f + ' 存在', fs.existsSync(path.join(BASE, f)));
}
const publicDocs = ['README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md'];
for (const f of publicDocs) {
  ok(`${f} is English-only`, !/[\u3400-\u9fff\uf900-\ufaff]/u.test(read(f) || ''));
}

// ── 2. 许可证 ──────────────────────────────────────────────────
console.log('\n[2] 许可证');
const lic = read('LICENSE') || '';
ok('LICENSE 是完整的 MIT 文本',
  /MIT License/.test(lic) && /WITHOUT WARRANTY/.test(lic) && /Copyright/.test(lic));
const tpn = read('THIRD-PARTY-NOTICES.md') || '';
ok('声明了 Node.js 的许可', /Node\.js/.test(tpn) && /MIT/.test(tpn));
ok('声明了 cloudflared 的许可（Apache 2.0）', /cloudflared/.test(tpn) && /Apache/.test(tpn));
ok('有商标声明（非官方）', /Names and attribution|trademark/i.test(tpn) && /independent and unofficial/i.test(tpn));

// ── 2b. 「声明里写了」不等于「包里真的带了」───────────────────────
//
// 这一条是被一个真问题教出来的：声明文件原本写着「本项目不随附 cloudflared
// 的许可文本，请分发者自行取得」—— 可懒人版整合包里明明就打包了 cloudflared.exe。
// 那已经是「分发」了，Apache 2.0 第 4(a) 条要求必须随附许可全文，
// 把义务转嫁给使用者并不能免除自己的责任。
//
// 所以这里不看声明怎么写，只问一件事：**随附的二进制，许可文件到底在不在**。
console.log('\n[2b] 随附二进制的许可文件（Apache 2.0 §4(a) 强制要求）');

// cloudflared：二进制在，许可就必须在
const cfBin = fs.existsSync(path.join(BASE, 'cloudflared', 'cloudflared.exe'));
const cfLic = read('cloudflared/LICENSE') || '';
if (cfBin) {
  ok('随附了 cloudflared.exe → 也随附了 cloudflared/LICENSE', cfLic.length > 0);
  ok('cloudflared/LICENSE 是完整的 Apache 2.0 全文',
    /Apache License/i.test(cfLic) && /Version 2\.0/.test(cfLic) &&
    /END OF TERMS AND CONDITIONS/.test(cfLic));
} else {
  ok('没有随附 cloudflared.exe（源码包），无需许可全文', true);
}

// Node：runtime/ 下每个版本目录都该有 LICENSE
const runtimeDir = path.join(BASE, 'runtime');
if (fs.existsSync(runtimeDir)) {
  const versions = fs.readdirSync(runtimeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const missing = versions.filter((v) => {
    const d = path.join(runtimeDir, v);
    return !fs.readdirSync(d).some((n) => /^LICENSE/i.test(n));
  });
  ok('runtime/ 下每个 Node 版本都带 LICENSE', missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : `${versions.length} 个版本都有`);
} else {
  ok('没有随附 runtime/（源码包），无需 Node 许可全文', true);
}

// 声明 ↔ 实际要一致：声明里说的路径，磁盘上必须真有东西。
//
// 这里**故意不做**「文档里不许出现某个坏句子」那种检查。
// 试过了，会假阳性：这份声明为了说清这个坑的来历，正文里就引用了旧的错误措辞，
// 于是「解释了错误」被判成「还错着」。靠正则管散文是管不住的 ——
// 真正有牙齿的是上面那两条：二进制在 ⇒ 许可文件必须在；许可文件必须是全文。
ok('声明写出了 cloudflared 许可的实际路径 cloudflared/LICENSE',
  /cloudflared\/LICENSE/.test(tpn));
ok('声明写出了 Node 许可的实际位置（runtime/ 下）',
  /runtime\/[^\s)）]*LICENSE/i.test(tpn));
ok('声明明确说了「已随附」而不是让使用者自己想办法',
  /Windows installer bundles third-party runtimes/i.test(tpn));

// ── 3. 名字中不中性 ────────────────────────────────────────────
console.log('\n[3] 名字');
const pkg = JSON.parse(read('package.json'));
ok('包名不含他人产品名',
  !/dsh|deepseek|codex|openai|chatgpt/i.test(pkg.name), pkg.name);
ok('README 里有非官方声明', /independent of DeepSeek, OpenAI, and Cloudflare/i.test(read('README.md') || '') && /not endorsed by them/i.test(read('README.md') || ''));

// 新用户拿到仓库能不能跑起来 —— 这一条之前漏了，而它是最容易忘的：
// 我把运行时 gitignore 掉了，却没告诉别人从哪弄到它，第一步就卡住。
const rd0 = read('README.md') || '';
ok('README 写了源码运行需要 Node.js', /Node\.js 24 or newer/i.test(rd0));
ok('说了不需要 npm install（零依赖）', /npm install is not needed/i.test(rd0));
ok('给了环境自检的第一步', /self-check\.js/.test(rd0));
// Release claims must track products actually operated, not adapters that exist
// only in code or fixtures. Requiring npm Web / legacy DSH / Codex CLI here would
// push the public README toward an unsupported compatibility promise.
const rdPlain = rd0.replace(/\*\*/g, '');
const dshScope = rdPlain.split('## Tested DSH desktop scope')[1]?.split('## Codex phone view')[0] || '';
const codexScope = rdPlain.split('## Codex phone view')[1]?.split(/\n## /)[0] || '';
ok('README names the operated, signed-in DSH desktop build',
  /DSH 0\.1\.7-rc\.2 desktop build installed on the test PC/i.test(dshScope) &&
  /DeepSeek Harness[^\n|]*desktop build[^\n|]*installed and signed in/i.test(rdPlain));
ok('README reports partial npm acceptance without claiming full or historical support',
  /Other desktop versions are unverified/i.test(dshScope) &&
  /complete end-to-end acceptance has not been achieved[^\n]*not claimed as fully supported/i.test(dshScope) &&
  ['0.1.0-rc.8', '0.1.1-rc.2', '0.1.7-rc.2', '0.2.0-rc.2'].every(version => dshScope.includes(version)) &&
  /credentials with 401[^\n]*real approval\/question completion remain unverified/i.test(dshScope) &&
  /operating-system download completion remains unverified/i.test(dshScope) &&
  /not a claim that an ordinary old npx install works today[^\n]*every historical desktop release is supported/i.test(dshScope) &&
  /docs\/MANUAL-ACCEPTANCE\.md/.test(dshScope));
ok('README scopes Codex to the operated desktop installation',
  /current OpenAI Codex desktop installation tested for this preview, signed in/i.test(rdPlain) &&
  /Codex phone interface was operated[^\n]*real Codex 0\.159\.0 runtime/i.test(codexScope) &&
  /does not establish compatibility with every Codex release/i.test(codexScope));
ok('明确不是安装两个产品才可使用，也不随安装包提供它们',
  /do not have to install both products/i.test(rd0) &&
  /does not include DeepSeek Harness, Codex/i.test(rd0));
ok('ChatGPT 网页登录不能代替本机 Codex 安装',
  /ChatGPT website session[^\n]*not a local Codex installation/i.test(rd0));
const security = read('SECURITY.md') || '';
ok('安全报告说明要求启用 GitHub 私密漏洞报告',
  /Private vulnerability reporting/.test(security) && /Report a vulnerability/.test(security));
ok('安全报告说明没有遗留未填写的联系方式', !/<(?:your|insert|contact)[^>]*(?:email|contact)|\b(?:TODO|TBD)\b[^\n]*\b(?:email|contact)\b/i.test(security));

// ── 4. 密钥绝不能进仓库（最重要的一项）────────────────────────
console.log('\n[4] 密钥隔离');
const secrets = [
  'logs/access-key.txt', 'logs/e2ee-secret.txt', 'logs/devices.json',
  'logs/vapid.json', 'logs/pair-code.txt', 'logs/notify-targets.json',
  'tls/workstation.key', 'runtime/node.exe', 'cloudflared/cloudflared.exe',
  'config/hooks.json', 'config.json'
];
let blocked = 0;
for (const p of secrets) {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: BASE, timeout: 10000 });
    blocked++;
  } catch (err) { /* 没被忽略 */ }
}
ok('所有密钥/大文件都被 git 忽略', blocked === secrets.length,
  blocked + '/' + secrets.length);

// 真正的清单里不能有密钥。
//
// 这里要看**所有会被提交的文件**，而不只是「还没提交的」——
// 提交之后后者就变成 0 了，检查会假装通过（或者反过来误报）。
// 上一版就只看了 --others，提交完那一项直接报 0 个文件。
let tracked = [];
try {
  const committed = execFileSync('git', ['ls-files'],
    { cwd: BASE, encoding: 'utf8', timeout: 20000 }).trim().split('\n').filter(Boolean);
  const pending = execFileSync('git', ['ls-files', '--others', '--exclude-standard'],
    { cwd: BASE, encoding: 'utf8', timeout: 20000 }).trim().split('\n').filter(Boolean);
  tracked = committed.concat(pending);
} catch (err) { tracked = []; }
// Match runtime secret *paths*, not source filenames such as pair-code.js or
// test-pair-code-persist.js. The content scan below remains a separate guard.
const isLeakyPath = (f) =>
  /^(?:logs|tls)\//i.test(f) ||
  /^(?:config\.json|config\/hooks\.json)$/i.test(f) ||
  /(?:^|\/)(?:access-key|e2ee-secret|pair-code|devices|vapid|notify-targets)\.(?:txt|json|pem|key)$/i.test(f) ||
  /\.(?:pem|key)$/i.test(f);
ok('密钥路径判断区分源码与真实运行文件',
  ['scripts/pair-code.js', 'scripts/test-pair-code-persist.js'].every((f) => !isLeakyPath(f)) &&
  ['logs/pair-code.txt', 'logs/access-key.txt', 'tls/workstation.key', 'config/hooks.json',
    'config.json', 'other/pair-code.txt'].every(isLeakyPath));
const leaky = tracked.filter(isLeakyPath);
ok('待提交清单里没有任何密钥', leaky.length === 0, leaky.slice(0, 3).join(', '));
ok('待提交文件数合理（不含运行时）', tracked.length > 50 && tracked.length < 400,
  String(tracked.length));

// ── 5. 数据流向要如实写出来 ────────────────────────────────────
console.log('\n[5] 数据流向说明');
const rd = read('README.md') || '';
ok('说明了走隧道时 Cloudflare 能看到什么', /Cloudflare terminates TLS/i.test(rd) && /URL path, cookies, metadata/i.test(rd));
ok('说明了端到端加密挡不住所有流量', /not separately encrypted/i.test(rd) && /do not assume all traffic is end-to-end encrypted/i.test(rd));
ok('列了其它第三方（ntfy/Bark/余额等）', /ntfy/.test(rd) && /Bark/.test(rd) && /deepseek/i.test(rd));
// 二维码删掉之后，README 里不该再把它当成现存功能描述。
// 但「曾经有过、已经删掉」这句本身是对的，所以只在**表格行**里查残留。
ok('没有把已删除的二维码写成现存功能',
  !/\|\s*`api\.qrserver\.com`/.test(rd), '数据流表里还留着 qrserver 那一行');
ok('说明了界面本身不外联', /local console page itself does not load third-party assets/i.test(rd));
// 检查有没有「正面宣称」做不到的事。
//
// 不能简单地「出现这个词就算失败」—— README 里恰恰有一句
// 「准确的说法是…，而不是『完全匿名』」，那是在**教人不要这么说**。
// 所以要看每个出现位置前面有没有否定词。上一版写得太粗，
// 把一句正确的提醒误报成了违规。
const overclaims = ['completely anonymous', 'absolutely secure', 'untraceable', '100% secure', 'fully end-to-end encrypted'];
const badClaims = [];
for (const w of overclaims) {
  const lower = rd.toLowerCase();
  let idx = lower.indexOf(w);
  while (idx >= 0) {
    const before = lower.slice(Math.max(0, idx - 80), idx);
    if (!/\b(?:not|never|cannot|can't|isn't|aren't|rather than|do not|don't|avoid|no claim of)\b/.test(before)) badClaims.push(w + ' @' + idx);
    idx = lower.indexOf(w, idx + 1);
  }
}
ok('没有正面宣称做不到的事（「完全匿名」之类）', badClaims.length === 0,
  badClaims.slice(0, 3).join(', '));

// ── 6. 零依赖（供应链风险）─────────────────────────────────────
console.log('\n[6] 依赖');
ok('运行时零第三方依赖',
  Object.keys(pkg.dependencies || {}).length === 0 &&
  Object.keys(pkg.devDependencies || {}).length === 0);


// ── 7. 按内容扫密钥（不管文件叫什么名字）────────────────────────
//
// 为什么必须按内容扫：原来的检查只看**文件名**像不像密钥
// （access-key、vapid.json 之类）。结果漏掉了一个叫 Caddyfile.mobile 的
// 弃用配置文件 —— 名字人畜无害，里面却写着完整的访问密钥，而且已经被提交。
//
// 教训：密钥不一定住在叫「key」的文件里。要扫内容。
console.log('\n[7] 按内容扫密钥');
const keyFile = path.join(BASE, 'logs', 'access-key.txt');
const e2eeFile = path.join(BASE, 'logs', 'e2ee-secret.txt');
const secretValues = [];
for (const f of [keyFile, e2eeFile]) {
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s.length >= 8) secretValues.push(s);
  } catch (e) { /* 没有就算了 */ }
}

if (!secretValues.length) {
  ok('（还没有生成密钥，跳过）', true);
} else {
  // 扫哪些文件？**以 git 会不会发布它为准**，不手工列白名单。
  //
  // 上一版是自己维护一个 skip 正则，结果被 current-url.txt 绊了一下 ——
  // 那个文件确实含密钥，但它被 .gitignore 挡着、永远进不了仓库。
  // 判断标准应该是「会不会被发布出去」，而不是「我觉得它该不该有密钥」。
  let published = [];
  try {
    published = execFileSync('git', ['ls-files'],
      { cwd: BASE, encoding: 'utf8', timeout: 20000 }).trim().split('\n').filter(Boolean);
  } catch (e) { published = []; }

  const dirty = [];
  for (const rel of published) {
    if (/\.(png|jpg|jpeg|gif|ico|exe|dll|woff2?)$/i.test(rel)) continue;
    let c = null;
    try { c = fs.readFileSync(path.join(BASE, rel), 'utf8'); } catch (e) { continue; }
    for (const s of secretValues) {
      if (c.includes(s)) { dirty.push(rel); break; }
    }
  }  ok('源码里没有任何文件包含真实密钥（按内容扫）', dirty.length === 0,
    dirty.slice(0, 5).join(', '));

  // 已经提交的历史里也不能有
  let histFiles = [];
  try {
    histFiles = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'],
      { cwd: BASE, encoding: 'utf8', timeout: 20000 }).trim().split('\n').filter(Boolean);
  } catch (e) { }
  const histLeak = [];
  for (const f of [...new Set(histFiles)]) {
    let c = null;
    try { c = fs.readFileSync(path.join(BASE, f), 'utf8'); } catch (e) { continue; }
    for (const s of secretValues) if (c.includes(s)) { histLeak.push(f); break; }
  }
  ok('已提交的文件里也没有真实密钥', histLeak.length === 0,
    histLeak.slice(0, 5).join(', '));
}
// ── 文档不能指向不存在的东西 ────────────────────────────────────────────────
//
// 文档腐烂是最常见也最不容易被发现的一种坏：README 里写着
// `node scripts/xxx.js`，而那个脚本早就改名或删了 ——
// 照着做的人会撞一脸，而写文档的人永远不会收到反馈。
// 所以这里把 README / SECURITY.md 里出现的 scripts/*.js 全抠出来核对一遍。
{
  // ★ 扫**根目录下所有 .md**，不是写死三个文件名。
  //
  //   原来这里是 `['README.md','SECURITY.md','CHANGELOG.md']` —— 于是
  //   后来新增的那些文档（通道清单、复现记录、实施状态…）**一个都没被扫到**。
  //   这个洞是靠反向测试发现的：往新文档里塞一个不存在的 npm 脚本，
  //   检查照样通过。写死清单的检查，天生只会覆盖「写它的时候想到的那些文件」。
  const docs = fs.readdirSync(BASE)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .filter((f) => fs.statSync(path.join(BASE, f)).isFile());
  const missing = [];
  let checked = 0;
  for (const d of docs) {
    const text = fs.readFileSync(path.join(BASE, d), 'utf8');
    for (const m of text.matchAll(/scripts\/([A-Za-z0-9_.-]+\.js)/g)) {
      checked++;
      if (!fs.existsSync(path.join(BASE, 'scripts', m[1]))) missing.push(`${d} → scripts/${m[1]}`);
    }
  }
  ok('文档里提到的脚本都存在', missing.length === 0,
    missing.length ? [...new Set(missing)].slice(0, 5).join(', ') : `查了 ${checked} 处引用`);

  // 文档里还会用 `npm run xxx` 的形式指路 —— 那种引用**同样会腐烂**，
  // 而且更隐蔽：脚本改名之后 `scripts/*.js` 的检查管不到它。
  // （写「实施状态」那份文档时我到处在用 `npm run`，才意识到这里有个洞。）
  const pkgScripts = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).scripts || {}; }
    catch (err) { return {}; }
  })();
  const npmMissing = [];
  let npmChecked = 0;
  for (const d of docs) {
    const text = fs.readFileSync(path.join(BASE, d), 'utf8');
    for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (m[1] === 'run') continue;
      npmChecked++;
      if (!pkgScripts[m[1]]) npmMissing.push(`${d} → npm run ${m[1]}`);
    }
  }
  ok('文档里提到的 npm 脚本都存在', npmMissing.length === 0,
    npmMissing.length ? [...new Set(npmMissing)].slice(0, 5).join(', ') : `查了 ${npmChecked} 处引用`);
}

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exitCode = fail ? 1 : 0;
