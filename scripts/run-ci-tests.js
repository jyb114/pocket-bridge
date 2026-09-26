// CI 上跑的那一部分测试。
//
// 说清楚边界，免得把 CI 的绿灯当成「全都验过了」：
//
//   完整的 `npm test` 需要**一台真机器** —— 网关在跑、浏览器装着、
//   Codex / DSH 装着、隧道通着。GitHub 的 runner 上这些都没有。
//   所以这里只跑**不依赖本机环境**的那些：纯算法、纯解析、静态检查，
//   以及自带 HTTP 服务的界面测试。
//
//   剩下那些（状态恢复、加密通道、隧道探测、余额、语音……）在 CI 上是
//   **没被覆盖**的。这一点在 README 里也写了，不靠这份文件自我声明。
//
// 用法：
//   node scripts/run-ci-tests.js            跑
//   node scripts/run-ci-tests.js --list     只列清单
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const NODE = process.execPath;

/**
 * 每一条都要能回答「为什么它在没有网关的机器上也能跑」。
 * 回答不了的就别放进来 —— 一个在 CI 上时红时绿的清单比没有清单更糟。
 */
const SUITE = [
  ['test-runtime-requirements.js', [], '源码运行的 Node.js 版本门槛与 CI、安装说明一致'],
  ['check-frontend.js', [], '静态检查：脚本注入、id 引用、备选优先级表'],
  ['test-contrast.js', [], '静态检查：文字对比度是否过 AA、键盘焦点是否可见'],
  ['test-i18n.js', [], '静态检查：字典覆盖（真跑字典，不碰网络）'],
  ['secret-scan.js', [], '静态检查：发布前秘密扫描（需要 git）'],
  ['test-compat.js', [], '兼容层的纯函数'],
  ['test-first-run.js', [], '隔离目录验证首次安装生成密钥、DSH 可选与升级保留'],
  ...(process.platform === 'win32'
    ? [['test-source-install.js', [], '隔离目录验证 Windows 源码安装与错误处理']]
    : []),
  ['test-polyfill.js', [], '补丁层的纯函数'],
  ['test-ws-frame.js', [], 'WebSocket 帧编解码（自己实现的那套）'],
  ['test-ws-crypt.js', [], '加密变换层：分片、粘包、控制帧'],
  ['test-webpush-address-recovery.js', [], '隧道换址：系统网页推送直达订阅并清理失效订阅'],
  ['test-e2ee-key-continuity.js', [], '端到端加密：同一浏览会话刷新后继续使用本地密钥'],
  ['test-ws-e2ee-bridge.js', [], '加密桥：握手响应不是帧那件事'],
  ['test-replay.js', [], '重放防护：IV 唯一性判定'],
  ['test-challenge-response.js', [], '挑战应答的密码学'],
  ['test-bootstrap-gate.js', [], '白名单门槛：新用户进得来、冒名者一条内容都拿不到'],
  ['test-proof-enforcement.js', ['--static-only'], '第三道门的源码检查；真网关实测在 CI 中显式跳过'],
  ['test-upload-handler.js', [], '上传处理器：路径穿越、来源、大小（自带服务）'],
  ['test-codex-queue.js', [], '队列状态机（自带 mock rpc，不碰真会话）'],
  ['test-release-lock.js', [], '释放写锁：什么情况下**不许**动手（自带服务与假目标）'],
  ['test-first-load.js', [], '首次加载横幅：该显示的显示、该消失的消失（假 DOM）'],
  ['test-notify-onboarding.js', [], '手机端「开启提醒」引导：一张卡片、点一下就好、不装 App'],
  ['test-lang-follows.js', [], '语言选择要真的生效：cookie + navigator 改写 + 该重载才重载'],
  ['test-dict-trim.js', ['--static-only'], '语言包裁剪的静态与纯函数测试；真网关段显式跳过'],
  ['test-prove-injection.js', ['--static-only'], '进门证明的假环境测试；真网关段显式跳过'],
  ['test-device-renewal.js', ['--isolated'], '设备令牌续期：临时目录中的真实模块测试；真网关段显式跳过'],
  ['test-codex-deliverables.js', [], 'Codex 交付文件：:codex-file-citation 变成可点的下载按钮'],
  ['test-codex-image.js', [], '手机上看对话里的图片：不留明文 src、走加密取回、失败给重试'],
  ['test-codex-render.js', [], '消息渲染健壮性：[object Object] 不再出现、本地文件链接变成可点按钮'],
  ['test-console-help.js', [], '控制台「复制地址能干什么」：真跑 renderEntries（假 DOM）'],
  ['test-pair-code-persist.js', [], '配对码什么时候换：重启沿用、90 天过期、手动换（隔离目录）'],
  ['test-proof-persistence.js', [], '切出去再切回来不用刷新：证明落盘 + 回前台强制补证；真网关段显式跳过'],
  ['test-pair-key-carry.js', ['--static-only'], '配对之后钥匙要跟着走：静态接线检查；真网关段显式跳过'],
  ['test-codex-projects.js', [], '手机端会话列表按项目折叠（假 DOM 跑真函数）'],
  ['test-codex-echo-dup.js', [], '发一句显示两句：本地占位与服务端回推必须对上'],
  ['test-dsh-api-e2ee.js', [], 'DSH 那套 API 的正文加密：客户端加、网关解、上游一字不差'],
  ['test-review-boundaries.js', [], '历史状态与加密失败边界（隔离，不碰真会话）'],
  ['test-narrow-kill.js', ['--static-only'], '窄杀进程：源码检查；本机 cloudflared 查询显式跳过'],
  ['similarity-audit.js', [], '重复代码审计（只看文件）'],
  // 这条需要浏览器 —— runner 上有就用，没有就跳过（见下面的处理）。
  ['test-codex-observer.js', ['--expanded', '--attachments', '--queue'],
    '界面行为（自带假执行端与本地 HTTP 服务；需要浏览器）']
];

const onlyList = process.argv.includes('--list');
if (onlyList) {
  console.log('\nCI 会跑这些：\n');
  for (const [f, args, why] of SUITE) console.log(`  ${f} ${args.join(' ')}\n      ${why}`);
  console.log(`\n共 ${SUITE.length} 条。其余测试需要真机环境，CI 不覆盖。\n`);
  process.exit(0);
}

console.log('\n=== CI 子集 ===');
console.log(`（共 ${SUITE.length} 条；需要真机环境的不在此列，README 里已说明）\n`);

let failed = 0;
let skipped = 0;
let skippedLiveSegments = 0;

for (const [file, args, why] of SUITE) {
  const started = Date.now();
  const r = spawnSync(NODE, [path.join(BASE, 'scripts', file), ...args], {
    cwd: BASE, encoding: 'utf8', timeout: 10 * 60 * 1000
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ms = Date.now() - started;

  // 「环境里没有这个东西」和「测试失败」是两回事，不能混。
  // 混了的话，CI 要么永远红，要么逼着人把真失败也当成环境问题忽略掉。
  const envMissing = file === 'test-codex-observer.js' && /找不到 Edge 或 Chrome/.test(out);
  if (['test-proof-enforcement.js', 'test-dict-trim.js', 'test-prove-injection.js',
    'test-device-renewal.js', 'test-narrow-kill.js', 'test-pair-key-carry.js'].includes(file)) {
    skippedLiveSegments++;
    console.log(`  ~ ${file} 的真机段显式跳过，不计入通过数`);
  }
  if (r.status !== 0 && envMissing) {
    skipped++;
    console.log(`  ~ 跳过 ${file}（环境里没有它需要的东西）  ${why}`);
    continue;
  }

  if (r.status !== 0) {
    failed++;
    console.log(`  ✗ ${file}（退出码 ${r.status}，${ms}ms）`);
    const failedChecks = out.split('\n').filter((line) => /^\s*✗/.test(line));
    if (failedChecks.length) console.log(failedChecks.map((line) => '      ' + line).join('\n'));
    console.log(out.split('\n').slice(-14).map((l) => '      ' + l).join('\n'));
  } else {
    console.log(`  ✓ ${file}  ${ms}ms`);
  }
}

console.log(`\n通过 ${SUITE.length - failed - skipped}　跳过 ${skipped}　失败 ${failed}\n`);
if (skippedLiveSegments) console.log(`另有 ${skippedLiveSegments} 段真机或真网关实测显式跳过，不计入通过数；发布前需单独运行。\n`);
if (skipped) console.log('（跳过的是环境里没有对应东西的，不是失败）\n');
console.log('提醒：CI 绿 ≠ 全都验过。完整验证要在真机上跑 npm test。\n');

process.exitCode = failed ? 1 : 0;
