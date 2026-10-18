// 脱敏诊断包 —— 计划 H「配对引导与脱敏诊断导出」。
//
// 用途：手机连不上的时候，人需要把「现场」发给别人看。而现场里到处是
// **不该外传的东西**：访问密钥、端到端加密密钥、推送凭据、设备指纹、
// 你的公网 IP、还有会话正文。
//
// 所以这个脚本的重点不是「收集信息」，是**把不该出去的东西挡住**。
// 做法上有两条是刻意的：
//
//   1. **先脱敏，再自检，最后才写文件。**
//      不是「相信脱敏规则写得对」，而是拿**真实凭据**回过头去搜一遍产物；
//      搜到就**拒绝写出**，并明确说搜到了哪一项。这多一道已知值检查，
//      不能证明没有其他私人内容，分享前仍需人工检查。
//
//   2. **白名单式收集**，不是「把 logs 打包再删敏感项」。
//      后者只要漏删一个文件就全泄了。这里只挑明确要的那几样。
//
// 不收集会话或上传文件；设备只输出固定的类型/浏览器分类。
// 日志与状态仍可能含有规则不认识的私人内容，分享前必须人工检查。
//
// 用法：
//   node scripts/diagnostic-bundle.js              写到 logs/diagnostic-<时间>.json
//   node scripts/diagnostic-bundle.js --stdout     打到标准输出（不给别人看时用）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { labelFromUa } = require('./sessions.js');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const TO_STDOUT = process.argv.includes('--stdout');

// ── 收集本机真实凭据，用来做最后那道自检 ─────────────────────────────────────
function readMaybe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (err) { return null; } }

const SECRETS = [];

// Both notification setters accept custom HTTP(S) servers. Treat the complete
// configured destination as a credential, including short topics/keys, rather
// than recognizing only the public providers' hostnames. The sender also uses
// a queryless ntfy URL and strips trailing slashes from Bark URLs.
function collectNotificationSecrets(name, value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
  const destinations = new Set([value, value.replace(/\/+$/, '')]);
  let parsed;
  try {
    parsed = new URL(value);
    destinations.add(parsed.href);
  } catch (err) { /* An accepted but malformed setting is still private. */ }
  for (const destination of [...destinations]) {
    destinations.add(destination.split(/[?#]/)[0].replace(/\/+$/, ''));
  }
  const values = new Set();
  const variants = input => {
    values.add(input);
    let decoded = input;
    try { decoded = decodeURIComponent(input); values.add(decoded); } catch (err) { }
    // The setters accept arbitrary strings after the scheme. URI encoding can
    // reject an unpaired surrogate; retain the raw/canonical destination then.
    try { values.add(encodeURIComponent(input)); } catch (err) { }
    try { values.add(encodeURIComponent(decoded)); } catch (err) { }
  };
  for (const destination of destinations) variants(destination);
  // Long path/query components can also appear separately in diagnostics.
  // Do not replace a one-character topic globally: the full URL variants above
  // protect it without destroying ordinary words, timestamps or status values.
  if (parsed) {
    for (const part of [parsed.username, parsed.password, ...parsed.pathname.split('/'),
      ...parsed.searchParams.values()]) {
      if (part.length >= 8) variants(part);
    }
    const lastPathPart = parsed.pathname.split('/').filter(Boolean).pop() || '';
    for (const part of [parsed.username, parsed.password, lastPathPart]) {
      if (part.length >= 4) variants(part);
    }
    for (const [key, part] of parsed.searchParams) {
      if (/^(?:key|token|secret|password|auth|authorization)$/i.test(key) && part.length >= 4) variants(part);
    }
  }
  // Preserve the previous standalone default-provider credential coverage,
  // including 4–7-character values and a saved path/query representation.
  const legacy = value.match(/(?:ntfy\.sh|api\.day\.app)\/(.+)$/);
  if (legacy && legacy[1].length >= 4) variants(legacy[1]);
  for (const item of [...values]) {
    values.add(item.replace(/%[0-9a-f]{2}/gi, escape => escape.toLowerCase()));
    values.add(item.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase()));
  }
  // A log line can itself be JSON. Its quoted/backslash credentials are already
  // escaped before scrub sees them; the final bundle adds another escape layer.
  // Collect the same representation for both replacement and final refusal.
  for (const item of [...values]) values.add(JSON.stringify(item).slice(1, -1));
  for (const item of values) if (item) SECRETS.push({ name, value: item });
}

{
  const k = readMaybe(path.join(LOG_DIR, 'access-key.txt'));
  if (k) SECRETS.push({ name: '访问密钥', value: k });
  const e = readMaybe(path.join(LOG_DIR, 'e2ee-secret.txt'));
  if (e) SECRETS.push({ name: '端到端加密密钥', value: e });
  // ★ 配对码也是凭据（6 位数字就能登记一台设备）。它会被写进日志
  //   （启动那行「配对码 XXXXXX」）和 status.json，所以产物里原本带着一个
  //   当前有效的码 —— 而这个包是**专门发给别人看**的。
  const pc = readMaybe(path.join(LOG_DIR, 'pair-code.txt'));
  if (pc) SECRETS.push({ name: '配对码', value: pc });
  for (const [file, label] of [['notify-targets.json', null], ['vapid.json', null]]) {
    const raw = readMaybe(path.join(LOG_DIR, file));
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      collectNotificationSecrets('通知凭据', j.ntfy);
      collectNotificationSecrets('通知凭据', j.bark);
      if (j.privateKey) SECRETS.push({ name: 'Web Push 私钥', value: j.privateKey });
    } catch (err) { }
  }
  const dev = readMaybe(path.join(LOG_DIR, 'devices.json'));
  if (dev) {
    try {
      for (const d of (JSON.parse(dev).devices || [])) {
        if (d.fp) SECRETS.push({ name: '设备指纹', value: d.fp });
      }
    } catch (err) { }
  }
}
// Redact a complete destination before any shorter component, otherwise a
// replacement in its path could prevent matching its remaining private query.
SECRETS.sort((a, b) => b.value.length - a.value.length);

// ── 脱敏 ────────────────────────────────────────────────────────────────────
const HOME = os.homedir();

/** 把一段文本里所有已知凭据换成占位符，再抹掉路径/地址里的可识别部分。 */
function scrub(value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (typeof s !== 'string') return value;

  for (const sec of SECRETS) {
    if (!sec.value) continue;
    if (sec.value.length >= 8) {
      s = s.split(sec.value).join(`<${sec.name}>`);
    } else if (sec.value.length >= 4) {
      // 短凭据（6 位配对码）**不能**全文替换：4 位数字在日志里到处都是
      // （端口、耗时、字节数、行号），全文换会把产物改得没法看。
      // 用数字边界锚住：只有**完整等于**这个码的那一段才替换。
      // 误伤的可能性是「恰好等于当前配对码的那个无关数字」，代价只是多个占位符。
      const esc = sec.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp('(?<![0-9])' + esc + '(?![0-9])', 'g'), `<${sec.name}>`);
    }
  }
  // URL 片段里的钥匙（#k=…）：片段本来就不发给服务端，但会被打印进日志
  s = s.replace(/#k=[^\s"'&]+/g, '#k=<加密密钥>');
  // 访问地址里的密钥段
  s = s.replace(/(\/k\/)[A-Za-z0-9_\-]{8,}/g, '$1<访问密钥>');
  // 一次性票据
  s = s.replace(/(\/t\/)[A-Za-z0-9_\-.]{8,}/g, '$1<票据>');

  // ★ URL 先藏起来，免得下面的「抹绝对路径」把 https:// 也一起吃掉
  const urls = [];
  s = s.replace(/https?:\/\/[^\s"'<>|)]+/g, (m) => { urls.push(m); return '\u0000U' + (urls.length - 1) + '\u0000'; });

  // ★ 绝对路径**整段**抹掉，只留扩展名。
  //
  //   这一步是拿一次真实泄露换来的：网关原来在拒绝越界读文件时把完整路径
  //   写进日志，于是
  //     C:\Users\<你的名字>\Documents\ChatGPT\<你正在做的项目>\tmp\x.png
  //   一路进了 proxy.log —— 用户名、你在做什么、文件叫什么，全在里面。
  //   而日志正是这个诊断包要取的东西。
  //   所以别只抹 home 和项目目录（那只能挡住自己想到的两种），
  //   直接认「绝对路径」这个形状，只保留扩展名（排查时够用：知道是张图）。
  //   `\b` 不能省：不加的话 `https://x` 里的 `s:/` 会被当成盘符路径。
  // Windows 路径可以有空格、单引号和括号，不能在这些字符处截断，
  // 否则会留下用户名/项目名的后半段。未加引号的路径一直取到明确的
  // 字段边界；同一字段里含糊的后续文字宁可一并隐藏。保留日志末尾标点。
  // 控制字符也包括上面藏 URL 用的占位符，不能把后面的地址一起吞掉。
  s = s.replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\x00-\x1f"<>|]*/g, (m) => {
    const suffix = (m.match(/[\s'’”)\]}）,;，；]*$/u) || [''])[0];
    const filename = m.slice(0, m.length - suffix.length);
    const ext = (filename.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
    return '<路径' + (ext ? ' ' + ext : '') + '>' + suffix;
  });

  // 还原 URL
  s = s.replace(/\u0000U(\d+)\u0000/g, (m, i) => urls[Number(i)] || '');

  // 兜底：万一路径写法没被上面认出来，至少把 home / 项目目录抹掉
  if (HOME) s = s.split(HOME).join('<用户目录>');
  s = s.split(BASE).join('<项目目录>');

  // 公网 IP 与 IPv6
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (m) =>
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(m) ? m : '<公网IP>');
  s = s.replace(/\b(?:[0-9a-f]{0,4}:){3,}[0-9a-f]{0,4}\b/gi, '<IPv6>');
  return s;
}

/** 读一个 JSON 文件并脱敏；读不到就返回 null（诊断包缺一项不影响生成） */
function scrubJson(file) {
  const raw = readMaybe(file);
  if (!raw) return null;
  // 先解析，再处理字段：JSON 的 \\ 转义不是 UNC 路径，修改原始 JSON
  // 还可能破坏转义或数字字段。键名也可能包含路径或凭据，一并处理。
  const visit = (value) => {
    if (typeof value === 'string') return scrub(value);
    if (typeof value === 'number') {
      const redacted = scrub(String(value));
      return redacted === String(value) ? value : redacted;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), visit(item)]));
    }
    return value;
  };
  try { return visit(JSON.parse(raw)); }
  // Node 的解析错误可能引用原始内容，不把异常消息带进分享包。
  catch (err) { return { _解析失败: '无效 JSON' }; }
}

/** 取日志尾部若干行并脱敏。行数刻意取得少 —— 日志越多，漏一条的概率越大。 */
function tailLines(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return scrub(lines.slice(-n).join('\n')).split('\n');
  } catch (err) { return null; }
}

// ── 组装（白名单）────────────────────────────────────────────────────────────
const bundle = {
  _说明: '这是经过脱敏规则处理的诊断信息。生成时已回搜已收集的本机凭据。' +
    '自检不能识别所有私人内容；日志只取尾部少量行，分享前仍须人工检查。',
  generatedAt: new Date().toISOString(),
  note: '如发现遗漏，请勿公开原始内容。请用虚构示例说明问题，敏感报告走约定的私密渠道。',

  runtime: {
    platform: process.platform,
    osRelease: os.release(),
    node: process.version,
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576)
  },
  project: {
    // 只报版本与文件数，不报路径
    version: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).version; }
      catch (err) { return null; }
    })(),
    trackedFiles: (() => {
      try {
        return require('child_process').execFileSync('git', ['ls-files'], { cwd: BASE, encoding: 'utf8' })
          .split('\n').filter(Boolean).length;
      } catch (err) { return null; }
    })()
  },

  status: scrubJson(path.join(LOG_DIR, 'status.json')),
  tunnelProbe: scrubJson(path.join(LOG_DIR, 'tunnel-probe.json')),
  selfCheck: scrubJson(path.join(LOG_DIR, 'self-check.json')),
  devices: (() => {
    // label 可由用户自定义，未知设备的默认 label 还会包含 IP。
    // 不对自由文本猜测脱敏：只从 UA 生成固定的类型/浏览器分类，不输出原始 UA。
    const raw = readMaybe(path.join(LOG_DIR, 'devices.json'));
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      return (d.devices || []).map((x) => ({
        label: labelFromUa(typeof x.ua === 'string' ? x.ua : ''),
        createdAt: x.createdAt,
        lastSeenAt: x.lastSeenAt,
        revoked: !!x.revokedAt,
        hasAuthority: !!x.authority
      }));
    } catch (err) { return null; }
  })(),

  logs: {
    _说明: '只取尾部，且已脱敏。帧内容本来就不写日志（要 DSH_GW_LOG_FRAMES=1 才写）。',
    daemon: tailLines(path.join(LOG_DIR, 'daemon.log'), 40),
    tunnel: tailLines(path.join(LOG_DIR, 'tunnel.log'), 20),
    proxy: tailLines(path.join(LOG_DIR, 'proxy.log'), 40)
  }
};

const text = JSON.stringify(bundle, null, 2);

// ── 自检：拿真实凭据回搜产物。搜到就**不写文件** ─────────────────────────────
const leaks = [];
for (const sec of SECRETS) {
  if (!sec.value) continue;
  if (sec.value.length >= 8) {
    // The assembled JSON can escape quotes/backslashes in a residual value.
    const escaped = JSON.stringify(sec.value).slice(1, -1);
    if (text.includes(sec.value) || text.includes(escaped)) leaks.push(sec.name);
  } else if (sec.value.length >= 4) {
    // 和 scrub() 用**同一套判据**：短凭据按数字边界找。
    // 两边判据必须一致 —— 否则要么漏检（自检说没有、其实有），
    // 要么自检永远红（脱敏换了、自检还在找原样）。
    for (const value of new Set([sec.value, JSON.stringify(sec.value).slice(1, -1)])) {
      const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(?<![0-9])' + esc + '(?![0-9])').test(text)) leaks.push(sec.name);
    }
  }
}
// 顺带查几类不该出现的东西
if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) leaks.push('私钥块');
// 项目目录名与用户名不该原样出现
if (HOME && text.includes(HOME)) leaks.push('用户目录路径');

if (leaks.length) {
  console.error('\n✗ 诊断包里搜到了不该有的东西，**拒绝写出**：' + [...new Set(leaks)].join('、'));
  console.error('  这是脱敏规则的漏洞，不是使用者的错。请修 scrub() 里的规则后重跑。\n');
  process.exitCode = 1;
  return;
}

console.log('\n=== 脱敏诊断包 ===\n');
console.log(`  已收集 ${SECRETS.length} 项本机凭据用于自检`);
console.log('  ✓ 用已收集的本机凭据回搜产物：没有命中');
console.log('  ✓ 未命中私钥块特征或当前用户目录的完整路径');
console.log('  产物里保留的：运行环境、隧道三态、自检结果、设备数量与类型（无指纹）、日志尾部少量行\n');

if (TO_STDOUT) {
  console.log(text);
} else {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = path.join(LOG_DIR, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, text, 'utf8');
  console.log(`  已写入 ${path.relative(BASE, out)}（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）`);
  console.log('  发给别人之前，建议自己再扫一眼 —— 自检覆盖的是「已知凭据」，不是「一切敏感信息」。\n');
}
process.exitCode = 0;
