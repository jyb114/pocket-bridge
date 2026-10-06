// 白名单的门槛划得对不对 —— 决定性测试。
//
// 要守住的核心命题（两边都不能错）：
//   · 新用户第一次必须能走通：加载页面和脚本 → 跑挑战应答 → 转正
//   · 冒名者（只有访问密钥）**一条内容都拿不到**
//
// 判定函数在 scripts/mobile-proxy.js 里，而那个文件一 require 就会起服务器，
// 所以只能把函数源码抠出来在沙箱里跑。抠的是**真实源码**，不是抄一份 ——
// 抄一份就测不到"改了源码忘了改测试"这类问题了。
//
// 用法: node scripts/test-bootstrap-gate.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./page-source.js');
const retiredTargets = require('./retired-targets.js');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

// ── 从真实源码里抠出判定函数 ────────────────────────────────────────────────
function extract(name) {
  const i = SRC.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`源码里找不到 ${name}`);
  // 从函数头开始，数大括号配平
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error(`${name} 的大括号不配平`);
}

const setSrc = SRC.match(/const BOOTSTRAP_PATHS = new Set\(\[[\s\S]*?\]\);/);
if (!setSrc) { console.log('  ✗ 源码里找不到 BOOTSTRAP_PATHS'); process.exit(1); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${setSrc[0]}\n${extract('isBootstrapRequest')}`, sandbox);
const isBootstrap = sandbox.isBootstrapRequest;

console.log('\n=== 白名单门槛 · 决定性测试 ===\n');

// ── ① 新用户第一次必须能走通 ────────────────────────────────────────────────
console.log('[1] 新用户第一次要加载的东西（**必须放行**，否则他连页面都打不开）');
const mustAllow = [
  ['/', '工作台页面'],
  ['/', '根路径'],
  ['/index.html', 'DSH-only entry shell'],
  ['/dsh-lite', 'Owned DSH phone shell'],
  ['/dsh-lite.css', 'Owned phone styles'],
  ['/dsh-lite-pin.js', 'Same-origin code pin checks'],
  ['/dsh-lite-lang.js', 'Phone translations'],
  ['/dsh-lite-adapter.js', 'Current DSH encrypted adapter'],
  ['/dsh-lite-legacy.js', 'Legacy DSH encrypted adapter'],
  ['/dsh-lite-router.js', 'Verified protocol selection'],
  ['/dsh-lite-ui.js', 'Owned phone UI'],
  ['/dsh-lite-switch.js', 'Direct-computer compatibility switch'],
  ['/dsh-lite-update.js', 'Owned phone update handling'],
  ['/dsh-directory-picker.js', 'Owned folder selection'],
  ['/prove.js', 'Device proof helper'],
  ['/voice.js', 'Owned voice controls'],
  ['/e2ee.js', '加密实现'],
  ['/i18n.js', '多语言模块'],
  ['/route.js', '路径角标 + 挑战应答'],
  ['/boot.js', '启动引导'],
  ['/polyfill.js', '兼容层'],
  ['/compat.js', '兼容层'],
  ['/first-load.js', '首次加载提示横幅'],
  ['/custom.css', '界面样式'],
  ['/sw.js', 'Service Worker'],
  ['/manifest.json', 'PWA 清单'],
  ['/icon-192.png', '图标'],
  ['/__auth/challenge', '取挑战'],
  ['/__auth/verify', '交应答'],
  // 挑战应答开成真拦之后（2026-09-27）新加的放行项：
  //   这三条的使用者**正是还没有钥匙的那台设备**（只有配对码 / 拿恢复票据进来的），
  //   不放行的话他连门都进不去，"配对"这个功能等于废掉。
  ['/pair', '配对页（还没有钥匙的设备要从这里进来）'],
  ['/__recover', '恢复票据（换隧道地址后重新拿到凭证）'],
  ['/go', 'DSH connection entry'],
  ['/__probe', '存活探测（手机端自检用，不含内容）'],
  ['/__push/vapid', '推送公钥'],
  ['/__push/subscribe', '推送订阅（隧道换地址时那条通知要靠它）'],
  // DSH 打包出来的静态资源：是代码不是内容，挡了界面会一直转圈
  ['/assets/index.js', 'DSH 前端主包'],
  ['/assets/vendor-CCJJTK99.js', 'DSH 第三方包'],
  ['/assets/favicon-aOK6_042.ico', 'DSH 图标']
];
for (const [p, why] of mustAllow) {
  ok(`放行 ${p.padEnd(20)} ${why}`, isBootstrap(p) === true);
}
// 带查询串也要认（真实请求经常带）
ok('放行 /?target=dsh（带查询串）', isBootstrap('/?target=dsh') === true);
ok('放行 /route.js?v=2（带查询串）', isBootstrap('/route.js?v=2') === true);

// ── ② 冒名者一条内容都不能拿到 ──────────────────────────────────────────────
console.log('\n[2] 冒名者（只有访问密钥）想拿的内容（**必须挡住**）');
const mustBlock = [
  ['/dot', 'Retired Dot shell'],
  ['/dot/', 'Retired Dot shell trailing slash'],
  ['/codex', 'Retired Codex shell'],
  ['/codex/threads', '会话列表 —— 含真实对话预览'],
  ['/codex/file?path=C:\\x', '读文件'],
  ['/codex/queue', '发消息队列'],
  ['/dot/desktop', 'Native Dot identity and private conversation text'],
  ['/__deepseek/balance', '余额'],
  ['/__codex/quota', 'Codex 额度'],
  ['/api/remote.mux', '实时对话通道'],
  ['/api/anything', 'DSH 的任何接口'],
  ['/plugins/events', '事件流'],
  ['/console', '控制台'],
  ['/__console/status', '控制台状态'],
  ['/__routes', '路径信息'],
  ['/t/someticket', '一次性票据'],
  ['/code-manifest.json', '代码清单'],
  ...['lite-rpc','lite-files','lite-upload','lite-download','directories','screen-shot',
    'lite-addresses','legacy-rpc','legacy-interactions','legacy-response','legacy-upload'].map(name =>
    ['/__dsh/' + name, 'Authenticated DSH content channel'])
];
for (const [p, why] of mustBlock) {
  ok(`挡住 ${p.padEnd(24)} ${why}`, isBootstrap(p) === false);
}

// ── ③ 别把"挡住"写成了"前缀匹配" ────────────────────────────────────────────
console.log('\n[3] 边界：不能让绕过写法混进来');
ok('挡住 /route.js/../codex/threads', isBootstrap('/route.js/../codex/threads') === false);
ok('挡住 /e2ee.jsx（不是白名单里的文件）', isBootstrap('/e2ee.jsx') === false);
ok('挡住 /boot.js.bak', isBootstrap('/boot.js.bak') === false);
ok('挡住 /icon-secret.json（只放行图片后缀）', isBootstrap('/icon-secret.json') === false);
ok('挡住空路径', isBootstrap('') === false);
ok('挡住 undefined', isBootstrap(undefined) === false);
ok('挡住大写变体 /ROUTE.JS（Windows 上要留意）', isBootstrap('/ROUTE.JS') === false,
  '如果这里返回 true，说明大小写不一致会有绕过空间 —— 需人工确认服务端是否大小写敏感');

// ── ④ 源码里开关的状态 ──────────────────────────────────────────────────────
console.log('\n[4] 开关状态');
const flag = SRC.match(/const REQUIRE_PROOF = (true|false)/);
ok('找到 REQUIRE_PROOF 开关', !!flag, '没找到');
if (flag) {
  console.log(`      当前值: ${flag[1]}`);
  // 2026-09-27 打开：观察期日志里手机每次都通过，且补齐了三件事
  // （手机端自动续证与失败重试、被拦时能自救的说明页、还没有钥匙的设备有话可说）。
  ok('现在是打开状态（真的拦人 —— 这正是这一整套存在的意义）', flag[1] === 'true',
    '★ 关着的话，隧道只要看到 /k/<密钥> 这条路径就能冒充你');
  // 打开的前提是手机端真的发得出应答、被拦了还能自愈 —— 那是另一个测试盯的
  // （test-proof-enforcement.js），这里只确认开关没被人悄悄关回去。
}

// Retired shells fail before the normal auth/bootstrap dispatcher is reached.
// Their old URLs cannot read data or construct a retired backend accidentally.
const entry = vm.createContext({ retiredTargets, handleRequestInner() { throw Error('retired request reached content dispatcher'); } });
vm.runInContext(extractFunction(SRC, 'handleRequest'), entry);
for (const url of ['/dot', '/dot/', '/dot/desktop', '/codex', '/codex/threads', '/__codex/quota',
  '/?target=codex', '/k/SYNTHETIC?target=dot']) {
  const res = { headers: {}, writeHead(n,h) { this.status=n; this.headers=h; }, end(v) { this.body=v; } };
  entry.handleRequest({ method:'GET', url },res);
  ok('Retired entry returns content-free 410: ' + url, res.status===410 &&
    JSON.parse(res.body).code==='target-retired' && res.headers['cache-control']==='no-store');
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
