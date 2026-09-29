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
  ['test-dsh-directories.js', [], '电脑目录只读列表及保护接线（临时目录和本地 HTTP）'],
  ['test-dsh-directory-picker.js', [], '手机电脑目录选择、取消、并发及新版官方挂钩（假 DOM）'],
  ['test-dsh-upstream-gate.js', [], 'HTTP 与 WS 不向已被拒绝的上游转发（假 runtime 与连接）'],
  ['test-dsh-upstream-auth.js', [], 'DSH Web 首次启动及凭据轮换（假凭据和 HTTP）'],
  ['test-dsh-adapter.js', [], 'DSH 桌面及 CLI 版本、协议和严格 HTTP 指纹（隔离夹具）'],
  ['test-dsh-runtime.js', [], 'DSH Web/桌面自动发现、端口归属与缓存（假进程及 HTTP）'],
  ['test-dsh-targets.js', [], 'DSH Web 安全启动、停止及 IPC 提示（假进程）'],
  ['test-promise-with-resolvers.js', [], '旧手机浏览器的 DSH 授权与提问 Promise 能力（隔离夹具）'],
  ['test-e2ee-request-base.js', [], '手机入口的 fetch/XHR 遵循文档 base URI 且维持加密作用域'],
  ['test-dsh-auth-recovery.js', [], '隧道登录 cookie 丢失时原样保留 403 并显示重新配对入口（假 DOM）'],
  ['test-sw-static-cache.js', [], 'DSH 静态模块的版本边界、缓存命中与失败重试（假 Service Worker）'],
  ['test-e2ee-order.js', [], '加密消息维持授权与已解决事件的收发顺序（延迟 WebCrypto 夹具）'],
  ['test-missing-targets.js', [], '缺少 DSH / Codex 时显示可操作提示，旧选择与独立运行服务仍可用（假目标与假连接）'],
  ['test-first-run.js', [], '隔离目录验证首次安装生成密钥、DSH 可选与升级保留'],
  ...(process.platform === 'win32'
    ? [['test-source-install.js', [], '隔离目录验证 Windows 源码安装与错误处理']]
    : []),
  ['test-polyfill.js', [], '补丁层的纯函数'],
  ['test-ws-frame.js', [], 'WebSocket 帧编解码（自己实现的那套）'],
  ['test-ws-crypt.js', [], '加密变换层：分片、粘包、控制帧'],
  ['test-webpush-address-recovery.js', [], '隧道换址：系统网页推送直达订阅并清理失效订阅'],
  ['test-e2ee-key-continuity.js', [], '端到端加密：同一浏览会话刷新后继续使用本地密钥'],
  ['test-e2ee-decrypt-marker.js', [], '仅经认证解密后的响应带验证标记，明文与坏密文不能冒充文件'],
  ['test-ws-e2ee-bridge.js', [], '加密桥：握手响应不是帧那件事'],
  ['test-replay.js', [], '重放防护：IV 唯一性判定'],
  ['test-challenge-response.js', [], '挑战应答的密码学'],
  ['test-bootstrap-gate.js', [], '白名单门槛：新用户进得来、冒名者一条内容都拿不到'],
  ['test-proof-enforcement.js', ['--static-only'], '第三道门的源码检查；真网关实测在 CI 中显式跳过'],
  ['test-upload-handler.js', [], '上传处理器：路径穿越、来源、大小（自带服务）'],
  ['test-codex-queue.js', [], '队列状态机（自带 mock rpc，不碰真会话）'],
  ['test-codex-lock-ux.js', [], '手机查看、回前台、交还写锁与桌面占用时队列不误送（隔离夹具）'],
  ['test-release-lock.js', [], '释放写锁：什么情况下**不许**动手（自带服务与假目标）'],
  ['test-codex-handback-race.js', [], '手机在自动交还期间重连时，旧清理不得取消新会话订阅'],
  ['test-codex-proxy-scope.js', [], '代理配置只作用于托管执行端；启动时不修改用户级 Windows 环境'],
  ['test-first-load.js', [], '首次加载横幅：该显示的显示、该消失的消失（假 DOM）'],
  ['test-notify-onboarding.js', [], '手机端「开启提醒」引导：一张卡片、点一下就好、不装 App'],
  ['test-lang-follows.js', [], '语言选择要真的生效：cookie + navigator 改写 + 该重载才重载'],
  ['test-voice-localization.js', [], '语音提示、帮助和错误在中文、英文、西班牙文下使用当前界面语言'],
  ['test-dict-trim.js', ['--static-only'], '语言包裁剪的静态与纯函数测试；真网关段显式跳过'],
  ['test-prove-injection.js', ['--static-only'], '进门证明的假环境测试；真网关段显式跳过'],
  ['test-device-renewal.js', ['--isolated'], '设备令牌续期：临时目录中的真实模块测试；真网关段显式跳过'],
  ['test-codex-deliverables.js', [], 'Codex 交付文件：:codex-file-citation 变成可点的下载按钮'],
  ['test-codex-image.js', [], '手机上看对话里的图片：不留明文 src、走加密取回、失败给重试'],
  ['test-codex-render.js', [], '消息渲染健壮性：[object Object] 不再出现、本地文件链接变成可点按钮'],
  ['test-codex-send-mode.js', [], '任务进行中插队还是排队：由使用者选；状态没确认时先确认再决定'],
  ['test-codex-send-mode-behavior.js', [], '发送按钮真实行为：不误投会话、不重复发送、队列成功才提示'],
  ['test-pagehide-lock-safety.js', [], '关闭手机页不得把明文会话编号伪标成端到端加密'],
  ['test-hidden-windows.js', [], '运行期子进程隐藏黑窗口，包含 Codex app-server'],
  ['test-console-help.js', [], '控制台「复制地址能干什么」：真跑 renderEntries（假 DOM）'],
  ['test-pair-code-persist.js', [], '配对码什么时候换：重启沿用、90 天过期、手动换（隔离目录）'],
  ['test-proof-persistence.js', [], '切出去再切回来不用刷新：证明落盘 + 回前台强制补证；真网关段显式跳过'],
  ['test-pair-key-carry.js', ['--static-only'], '配对之后钥匙要跟着走：静态接线检查；真网关段显式跳过'],
  ['test-codex-projects.js', [], '手机端会话列表按项目折叠（假 DOM 跑真函数）'],
  ['test-codex-echo-dup.js', [], '发一句显示两句：本地占位与服务端回推必须对上'],
  ['test-dsh-api-e2ee.js', [], 'DSH 那套 API 的正文加密：客户端加、网关解、上游一字不差'],
  ['test-codex-private-file.js', [], 'Codex 文件路径经加密 POST 传送，明文及查询参数不能到文件读取器'],
  ['test-dsh-lazy-images.js', [], '已验证 DSH 模块的内嵌图片改为按需取，版本不匹配则原样放行'],
  ['test-dsh-lazy-image-store.js', [], '图片内容哈希、磁盘边界与官方入口改写'],
  ['test-dsh-lite-rpc.js', [], '轻量 DSH RPC 只接受已知方法、加密请求与正确协议参数'],
  ['test-dsh-lite-addresses.js', [], '手机地址面板经过设备证明和加密包装，明文请求不能读出访问地址'],
  ['test-dsh-lite-upload.js', [], '轻量 DSH 上传回执：固定路径、会话绑定、加密、大小与上游响应校验'],
  ['test-dsh-lite-download.js', [], '轻量 DSH 下载仅限已知对话的真实工作区文件，阻止越界与链接逃逸'],
  ['test-dsh-lite-files.js', [], '手机 DSH 工作区文件单层分页浏览：仅已知会话、加密与路径边界'],
  ['test-dsh-lite-adapter.js', [], '轻量 DSH 项目、对话、发送、审批与提问协议（假连接）'],
  ['test-dsh-lite-legacy-rpc.js', [], '旧版 DSH 点号 RPC 的加密、固定方法与版本门控'],
  ['test-dsh-lite-legacy.js', [], '旧版 DSH 项目、会话、历史分页与文本操作（隔离协议）'],
  ['test-dsh-lite-router.js', [], '手机版按已验证协议选新版/旧版适配，授权失败时不误连'],
  ['test-dsh-lite-code-pin.js', [], '轻量 DSH 脚本指纹、直接打开的初次钉住与旧指纹的手动更新（假 Service Worker）'],
  ['test-dsh-lite-update.js', [], '手机切回前台只提示新版本，点击后才更新指纹且失败可重试'],
  ['test-dsh-lite-ui.js', [], '轻量 DSH 手机界面和多题交互（隔离浏览器）'],
  ['test-dsh-lite-switch.js', [], '官方 DSH 页面上的轻量模式按钮保留完整认证和加密地址'],
  ['test-review-boundaries.js', [], '历史状态与加密失败边界（隔离，不碰真会话）'],
  ['test-narrow-kill.js', ['--static-only'], '窄杀进程：源码检查；本机 cloudflared 查询显式跳过'],
  ['test-tunnel-security.js', [], '公网来源边界：禁用 ngrok，非本机 Host 必须经过管理端点与加密闸门（隔离）'],
  ['similarity-audit.js', [], '重复代码审计（只看文件）'],
  // 这条需要浏览器 —— runner 上有就用，没有就跳过（见下面的处理）。
  ['test-codex-interactions.js', [], '授权、问题、自填与 MCP 确认（隔离执行端；需要浏览器）'],
  ['test-codex-menus-interactions.js', [], '手机菜单、项目路径、附件、改名归档操作（隔离浏览器）'],
  ['test-codex-thread-list-interactions.js', [], '旧会话分页和搜索的实际浏览器交互（隔离执行端）'],
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
  const envMissing = ['test-codex-observer.js','test-codex-interactions.js'].includes(file) && /找不到 Edge 或 Chrome/.test(out);
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
