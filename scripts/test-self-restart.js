// 「改完设置自动重启」的回归测试。
//
// 要守住两件事：
//   1. 那三个**必须重启才生效**的操作，不能再把「去托盘手动重启」丢给使用者。
//      原来它们只回一句「托盘图标右键 → 停止服务 → 再点一下启动」——
//      那不是操作说明，那是把活推给他，而且很容易只做一半（停了没启，手机直接连不上）。
//   2. 重启助手**不能猜端口**。网关端口是选出来的（8080 被占就往后挪），
//      猜错的话助手会一直轮询一个没人监听的端口，白等 20 秒然后放弃重启 ——
//      使用者看到的是「点了没反应」。
//
// 只做静态检查，**不真的触发重启** —— 那会把使用者手机上正在用的连接断掉。
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const PROXY = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const HELPER = fs.readFileSync(path.join(BASE, 'scripts', 'restart-gateway.js'), 'utf8');
const CONSOLE = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

console.log('\n=== 改完设置自动重启 ===\n');

// ── 1. 三个必须重启的操作都接上了 ──────────────────────────────────────────
console.log('[1] 三个操作都自动重启');

// 从 action 分支里把每个动作的代码块抠出来，单独检查它有没有调 restartSelfSoon。
// 直接全文搜是没用的 —— 只要有一处调了，全文就搜得到。
function actionBlock(name, next) {
  const i = PROXY.indexOf(`body.action === '${name}'`);
  if (i < 0) return '';
  const j = next ? PROXY.indexOf(`body.action === '${next}'`, i) : -1;
  return PROXY.slice(i, j > 0 ? j : i + 4000);
}

const rotateKey = actionBlock('rotate-key', 'rotate-e2ee');
ok('「更改地址」会自己重启', /restartSelfSoon\(/.test(rotateKey),
  rotateKey.slice(0, 120).replace(/\n/g, ' '));
ok('「更改地址」重启时顺带把新地址推到手机（否则人在外面就被锁死了）',
  /notifyAddress:\s*true/.test(rotateKey));

const lanHttps = actionBlock('set-lan-https', 'set-domain-mode');
// 开和关各一处
ok('开内网 HTTPS 会自己重启', (lanHttps.match(/restartSelfSoon\(/g) || []).length >= 2,
  `找到 ${(lanHttps.match(/restartSelfSoon\(/g) || []).length} 处`);

// ── 2. 不再让使用者去托盘手动重启 ──────────────────────────────────────────
console.log('\n[2] 不再把「去托盘手动重启」丢给使用者');

// 只看**会发给使用者的字符串**，不看待解释性注释。
const userStrings = [];
const re = /message:\s*'(?:[^'\\]|\\.)*'/g;
let m;
while ((m = re.exec(PROXY)) !== null) userStrings.push(m[0]);
const joined = userStrings.join('\n');

ok('没有哪条提示还在教使用者点托盘停止/启动',
  !/托盘图标右键|托盘.*停止服务.*再点/.test(joined),
  (joined.match(/[^']*托盘[^']*/) || [''])[0].slice(0, 80));

ok('没有哪条提示还在提「二维码」（那个功能已经删了）',
  !/二维码/.test(joined),
  (joined.match(/[^']*二维码[^']*/) || [''])[0].slice(0, 80));

// ── 3. 换地址策略那条**故意不重启** ────────────────────────────────────────
console.log('\n[3] 换地址策略不能顺手重启（否则当场换掉手机书签）');
const domain = actionBlock('set-domain-mode', null);
ok('切换动态/固定地址时不会自动重启', !/restartSelfSoon\(/.test(domain));
ok('并且明确告诉使用者「现在不用做任何事」',
  /下次启动服务时/.test(domain) && /不用做任何事/.test(domain),
  domain.slice(0, 160).replace(/\n/g, ' '));

// ── 4. 重启助手不猜端口 ────────────────────────────────────────────────────
console.log('\n[4] 重启助手');
ok('助手存在', HELPER.length > 500);
ok('端口由调用方传入（不写死 8080）',
  /--port/.test(HELPER) && /resolvePort/.test(HELPER));
ok('调用方确实把端口传了', /args\.push\('--port',\s*String\(PORT\)\)/.test(PROXY),
  (PROXY.match(/args\.push\('--port'[^\n]*/) || [''])[0]);
ok('助手的健康检查用的是解析出来的端口（不是字面量 8080）',
  /HEALTH\s*=\s*`http:\/\/127\.0\.0\.1:\$\{PORT\}/.test(HELPER));
ok('助手先等中间层退干净再拉起（否则守护进程会说「已在运行」然后什么都不做）',
  /中间层已退出，正在拉起来/.test(HELPER));
ok('助手会确认服务真的回来了', /中间层已恢复/.test(HELPER));

// ── 5. 控制台要能等它回来 ──────────────────────────────────────────────────
console.log('\n[5] 控制台等重启回来，不显示成故障');
ok('控制台有等待逻辑', /function waitForRestart/.test(CONSOLE));
ok('服务端说 restarting 时会走等待分支', /j\.restarting/.test(CONSOLE));
ok('等待期间顶部改成「正在重启服务…」而不是报错',
  /正在重启服务…/.test(CONSOLE));

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
