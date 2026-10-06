// 校验所有前端文件里的内联脚本语法（含 mobile-proxy 里内嵌的那些页面）。
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
let bad = 0;

function check(name, src) {
  try { new Function(src); console.log(`  ✓ ${name}`); }
  catch (e) { bad++; console.log(`  ✗ ${name}  ${e.message}`); }
}

for (const f of ['console.html', 'go.html']) {
  const html = fs.readFileSync(path.join(BASE, 'pwa', f), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { bad++; console.log(`  ✗ ${f} 找不到内联脚本`); continue; }
  check(f, m[1]);
}

for (const f of ['route.js', 'boot.js', 'polyfill.js', 'compat.js', 'first-load.js']) {
  check(f, fs.readFileSync(path.join(BASE, 'pwa', f), 'utf8'));
}

/**
 * 把模板字符串里的 ${...} 插值换成占位符 0。
 *
 * 不能简单地用 /\$\{[\s\S]*?\}/ —— 插值里嵌套大括号很常见
 * （`${JSON.stringify({a:1})}`），非贪婪匹配会在第一个 `}` 收手，
 * 把后面的 `)` 留在原地，于是报「Unexpected token ')'」。
 * 那是检查自己制造出来的假错误。
 * 这里按大括号配平来切。
 */
function stripInterpolations(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      out += '0';
      i = j;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

// mobile-proxy 里内嵌的几个页面
//
// ★ 这几页做多语言时从「常量」变成了「函数」（pairPage(req,lang) 之类），
//   原来的 `const NAME = \`...\`` 正则就再也匹配不到，只会打印一句
//   「不是模板字符串，跳过」—— **检查假装通过了**。这种静默跳过比报错危险：
//   它会让一条真实存在的检查悄悄消失。
//   现在改成找函数，而且**找不到就失败**，不许跳过。
const proxy = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
for (const name of ['launcherPage', 'pairPage', 'enterPage']) {
  const at = proxy.indexOf(`function ${name}(`);
  if (at < 0) {
    console.log(`  ✗ ${name} 在 mobile-proxy.js 里找不到（页面被改名或删了？）`);
    process.exitCode = 1;
    continue;
  }
  // 从函数头往后找第一段 <script>…</script>。给足窗口 —— 模板里还夹着
  // 样式和文案表，但不会超过这个量级。
  const body = proxy.slice(at, at + 40000);
  const sm = body.match(/<script>([\s\S]*?)<\/script>/);
  // 页面**可以没有**内联脚本（配对页就是纯表单），这不算问题。
  // 但「函数找不到」必须算 —— 那是页面被改名/删了，检查失去了对象。
  if (!sm) { console.log(`  · ${name} 没有内联脚本，跳过`); continue; }
  // ★ 模板里有 ${...} 插值（做多语言时把文案表 JSON 注入进去，
  //   比如 `var L=${JSON.stringify(T)}`）。直接拿去当 JS 编译必然报
  //   「Unexpected token '{'」—— 那是**检查方法的错**，不是代码的错。
  //   先把它换成占位符再校验。
  check(`${name} 内联脚本`, stripInterpolations(sm[1]));
}

// ── 备选路径的优先级表必须认全所有 kind ──────────────────────────────────────
//
// 这一条是拿一个真 bug 换来的：route.js 里那张表原来写的是
//     { lan: 1, ipv6: 2, tunnel: 3 }
// 而服务端（routes.js）实际会给出的 kind 有四种：**lan-https**、tunnel、ipv6、lan。
// `lan-https` 不在表里 → 落到兜底的 9 → 排到了明文内网和隧道后面。
//
// 后果不是「排序不好看」，是**安全问题**：家里内网 HTTPS 开着（又快又加密），
// 自动备选却挑了明文 8080，手机一切过去就静默变成明文。
//
// 这类 bug 的特点是：不报错、不崩溃，只是悄悄做了更差的选择。
// 所以让机器每次都对着服务端实际的 kind 列表核一遍。
{
  const routeSrc = fs.readFileSync(path.join(BASE, 'pwa', 'route.js'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(BASE, 'scripts', 'routes.js'), 'utf8');

  // 注意字符类要带 0-9：kind 里有 `ipv6`，用 [a-z-] 会漏掉它。
  // 我第一版就写成了 [a-z-]，结果「服务端 kind」只认出 3 个、漏了 ipv6 ——
  // 一个漏了成员的检查比没有检查更危险，因为它会给人「已经核过了」的错觉。
  const KIND_RE = /kind:\s*'([a-z0-9-]+)'/g;

  const serverKinds = new Set();
  for (const m of routesSrc.matchAll(KIND_RE)) serverKinds.add(m[1]);

  const orderLine = routeSrc.match(/var\s+order\s*=\s*\{([^}]*)\}/);
  const clientKinds = new Set();
  if (orderLine) {
    for (const m of orderLine[1].matchAll(/'?([a-z0-9-]+)'?\s*:/g)) clientKinds.add(m[1]);
  }

  const missing = [...serverKinds].filter((k) => !clientKinds.has(k));
  console.log(`  ${missing.length ? '✗' : '✓'} 备选优先级表覆盖服务端所有 kind` +
    `（服务端 ${[...serverKinds].sort().join('/')}；客户端 ${[...clientKinds].sort().join('/')}）` +
    (missing.length ? `  缺: ${missing.join(', ')}` : ''));
  if (missing.length) bad++;

  if (orderLine) {
    const o = {};
    for (const m of orderLine[1].matchAll(/'?([a-z0-9-]+)'?\s*:\s*(\d+)/g)) o[m[1]] = Number(m[2]);
    const encOk = o['lan-https'] !== undefined && o.lan !== undefined && o['lan-https'] < o.lan;
    console.log(`  ${encOk ? '✓' : '✗'} 加密内网(lan-https) 优先于明文内网(lan)` +
      (encOk ? `（${o['lan-https']} < ${o.lan}）` : `（lan-https=${o['lan-https']} lan=${o.lan}）`));
    if (!encOk) bad++;
  }
}

// ── JS 里用到的 id，HTML 里必须真的存在 ──────────────────────────────────────
//
// 这一条是拿一次真事故换来的：把控制台从「一拉到底」改成标签页时，
// 我顺手把两个卡片标题改成了 <h2>，却漏掉了它们身上的 id ——
// 而 renderAdvanced() 还在往 $('domainTitle').textContent 写。
//
// 表现极具迷惑性：**整个控制台顶部变成「读不到状态」**，
// 因为 load() → render() 中途抛了 "Cannot set properties of null"，
// 被 catch 吞掉之后走了错误分支，报错里完全没提是哪个 id 没了。
//
// 这种「HTML 挪了、JS 还在找旧 id」的错，两边甚至不在同一段代码里，
// 人眼几乎看不出来。让机器每次都核一遍。
//
// 例外：少数元素不是静态 HTML 写死的，是脚本运行时建出来再插进 DOM 的，
// 静态扫 HTML 永远扫不到。直接塞白名单等于把这条检查关掉，所以每条例外
// 都必须交出「哪一行代码创建了它」，检查器去那一行现场核对 —— 那一行被
// 删掉或改写，这条检查立刻重新变红。例外清单因此是会过期的，不是免死金牌。
{
  // 桌面控制台已把相近的设备、网络、安全页面收进总览，只保留静态的
  // connect / notify / settings 三个页面。因此当前没有运行时 page id。
  const RUNTIME_IDS = [];

  const srcPath = path.join(BASE, 'pwa', 'console.html');
  const html = fs.readFileSync(srcPath, 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);

  // 先核对这些例外本身还成立，再拿它们去豁免 id。
  const runtimeOk = new Set();
  for (const ev of RUNTIME_IDS) {
    // ★ 去**搜**那一行，而不是按固定行号去读。
    //
    //   这里原来写的是 lines[ev.line - 1] —— 嘴上说「不认行号、认代码长什么样」，
    //   实现里却仍然钉死行号。结果只要文件上方增删几行，证据行就漂走了，
    //   检查会报「例外清单过期」并让 4 个 id 全部失踪（本轮改控制台时就撞上了）。
    //   行号只用来给人指路，判据必须是那一行的内容。
    const lines = fs.readFileSync(path.join(BASE, ev.file), 'utf8').split(/\r?\n/);
    let foundAt = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!ev.must.test(lines[i])) continue;
      if (ev.ids.every((id) => lines[i].includes("'" + id.replace(/^page-/, '') + "'"))) { foundAt = i + 1; break; }
    }
    if (foundAt < 0) {
      console.log(`  ✗ ${ev.file} 里找不到「创建 ${ev.ids.join(', ')}」的那行代码 —— ${ev.note}（例外清单过期，需重新核对）`);
      bad++;
      continue;
    }
    for (const id of ev.ids) if (used.has(id)) runtimeOk.add(id);
  }

  const missingIds = [...used].filter((id) => !html.includes('id="' + id + '"') && !runtimeOk.has(id));
  console.log(`  ${missingIds.length ? '✗' : '✓'} console.html：JS 用到的 ${used.size} 个 id 都有来源` +
    `（静态 HTML ${used.size - runtimeOk.size} 个 + 运行时创建 ${runtimeOk.size} 个）` +
    (missingIds.length ? `  缺: ${missingIds.join(', ')}` : ''));
  if (missingIds.length) bad++;
}

console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
process.exitCode = bad ? 1 : 0;
