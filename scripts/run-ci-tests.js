// Current DSH/shared isolated regressions. Real phone, upstream and tunnel
// acceptance is separate and must be reported independently of this suite.
// Usage: node scripts/run-ci-tests.js [--list]
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
  ['test-dsh-legacy-selection.js', [], 'Exact legacy model/preset allowlist validates writes and independent current-session readback without automatic write retries (isolated upstream fixtures)'],
  ['test-dsh-compatibility-ui.js', [], 'Phone compatibility panel distinguishes interfaces from live acceptance; stale asynchronous checks cannot mutate a disposed or replaced view (DOM fixtures)'],
  ['test-dsh-feature-capabilities.js', [], 'Observed protocol/interface coverage cannot claim real model, phone or different-tree workflow acceptance'],
  ['test-replay-persistence.js', [], 'Verified inbound command/proof receipts survive actual owned process restart; durable admission refuses duplicates, concurrent writers and storage failures before dispatch'],
  ['test-private-https-admission.js', [], 'Optional private HTTPS remains remote, rejects Funnel/management/host conflicts and still requires existing device, proof and encrypted HTTP/WS gates (owned servers)'],
  ['test-phone-page-policy.js', [], 'Owned phone document restricts executable sources, outbound connections, framing, referrers and browser permissions; actual isolated HTTP headers'],
  ['test-tailscale-private-https.js', [], 'Optional private HTTPS status is disabled by default and never installs, logs in, exposes public Funnel or changes Serve (isolated command/status fixtures)'],
  ['test-dsh-only-retirement.js', [], 'Actual isolated HTTP/upgrade retirement gates refuse every old action without native adapters or private-data mutations'],
  ['test-dsh-phone-surface.js', [], 'Actual HTTP/upgrade entrypoints refuse raw remote upstream content while preserving encrypted Lite and direct computer access'],
  ['test-dsh-ws-failclosed.js', [], 'Actual isolated gateway TCP refuses malformed upstream handshake/transform bytes without plaintext fallback or application actions'],
  ['test-gateway-lifecycle.js', [], 'Gateway-only restart admission awaits its own helper and leaves external DSH/native processes untouched'],
  ['test-dsh-payload.js', [], 'Actual allowlisted DSH payload is closed over runtime dependencies and retains private and legacy data during isolated upgrade'],

  ['test-config.js', [], 'Actual isolated DSH config saves retain legacy and unknown fields; identity changes touch only owned authentication fixtures'],
  ['test-runtime-requirements.js', [], '源码运行的 Node.js 版本门槛与 CI、安装说明一致'],
  ['test-gateway-listener.js', [], 'Actual owned HTTP/TCP listeners reserve the exact IPv4 tunnel origin, avoid occupied ports, share IPv6/upgrade handlers and roll back incomplete startup (no production service)'],
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
  ['test-dsh-runtime-async.js', [], 'Asynchronous OS inventory and isolated cold installation discovery preserve runtime identity while serving unrelated HTTP promptly (isolated HTTP/process fixtures; no live DSH)'],
  ['test-dsh-explicit-target.js', [], '显式 DSH 端口缓存过期后重新核实原目标，不误判版本变化或切换端口'],
  ['test-key-cookie-replacement.js', [], '有效配对入口替换旧认证 cookie；不同网关端口互不干扰（隔离 HTTP）'],
  ['test-dsh-targets.js', [], 'DSH Web 安全启动、停止及 IPC 提示（假进程）'],
  ['test-promise-with-resolvers.js', [], '旧手机浏览器的 DSH 授权与提问 Promise 能力（隔离夹具）'],
  ['test-e2ee-request-base.js', [], '手机入口的 fetch/XHR 遵循文档 base URI 且维持加密作用域'],
  ['test-dsh-auth-recovery.js', [], '隧道登录 cookie 丢失时原样保留 403 并显示重新配对入口（假 DOM）'],
  ['test-sw-static-cache.js', [], 'DSH 静态模块的版本边界、缓存命中与失败重试（假 Service Worker）'],
  ['test-e2ee-order.js', [], '加密消息维持授权与已解决事件的收发顺序（延迟 WebCrypto 夹具）'],
  ['test-missing-targets.js', [], '缺少 DSH 时显示可操作提示，旧选择与独立运行服务仍可用（假目标与假连接）'],
  ['test-first-run.js', [], '隔离目录验证首次安装生成密钥、DSH 可选与升级保留'],
  ['test-windows-installer.js', [], 'English installer, remembered per-user destination, /D smoke override and shared-state isolation (source contracts; no build or install)'],
  ['test-desktop-gateway-scope.js', [], 'Desktop shortcut opens only its own advertised gateway identity and matching fresh boot/PID (synthetic HTTP and child events; no live gateway or native action)'],
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
  ['test-console-restart-wait.js', [], 'Console waits for a distinct gateway boot, reports blocked drains and keeps transport failures separate from completed restart (isolated DOM/GET; no gateway restart)'],
  ['test-reload-gateway.js', [], 'Scoped reload verifies own installation, exact health PID/boot and local Origin before scheduled restart (isolated mock/owned HTTP; no native actions)', { platform: 'win32' }],
  ['test-daemon-operation-stop.js', [], 'Daemon admission leases fence delayed gateway/tunnel starts after stop and preserve uncertain child ownership (actual orchestration with synthetic HTTP/children; no native actions)'],
  ['test-tray-gateway-stop.js', [], 'Tray verifies scoped gateway identity, waits graceful shutdown and owns only pinned tunnel processes (PowerShell synthetic HTTP/CIM/process fixtures; no tray UI or real signals)', { platform: 'win32' }],
  ['test-e2ee-missing-key.js', [], 'Public protected HTTP and WebSocket routes fail closed when encryption keys become unavailable (isolated HTTP and upgrade)'],
  ['test-relay-local-exemption.js', [], 'Relay and forwarded requests cannot claim the direct-loopback proof exemption with a local Host (isolated loopback HTTP)'],
  ['test-first-load.js', [], '首次加载横幅：该显示的显示、该消失的消失（假 DOM）'],
  ['test-notify-onboarding.js', [], '手机端「开启提醒」引导：一张卡片、点一下就好、不装 App'],
  ['test-lang-follows.js', [], '语言选择要真的生效：cookie + navigator 改写 + 该重载才重载'],
  ['test-voice-localization.js', [], '语音提示、帮助和错误在中文、英文、西班牙文下使用当前界面语言'],
  ['test-dict-trim.js', ['--static-only'], '语言包裁剪的静态与纯函数测试；真网关段显式跳过'],
  ['test-prove-injection.js', ['--static-only'], '进门证明的假环境测试；真网关段显式跳过'],
  ['test-device-renewal.js', ['--isolated'], '设备令牌续期：临时目录中的真实模块测试；真网关段显式跳过'],
  ['test-hidden-windows.js', ['--static-only'], '运行期子进程隐藏黑窗口，DSH 与共享网关'],
  ['test-console-help.js', ['--isolated-only'], 'Actual console entry recommendation/copy/open callbacks reject insecure or malformed phone links and provide localized recovery (isolated DOM; live acceptance separate)'],
  ['test-pair-code-persist.js', [], '配对码什么时候换：重启沿用、90 天过期、手动换（隔离目录）'],
  ['test-proof-persistence.js', [], '切出去再切回来不用刷新：证明落盘 + 回前台强制补证；真网关段显式跳过'],
  ['test-pair-key-carry.js', ['--static-only'], '配对之后钥匙要跟着走：静态接线检查；真网关段显式跳过'],
  ['test-dsh-api-e2ee.js', [], 'DSH 那套 API 的正文加密：客户端加、网关解、上游一字不差'],
  ['test-dsh-lazy-images.js', [], '已验证 DSH 模块的内嵌图片改为按需取，版本不匹配则原样放行'],
  ['test-dsh-lazy-image-store.js', [], '图片内容哈希、磁盘边界与官方入口改写'],
  ['test-dsh-lite-rpc.js', [], '轻量 DSH RPC 只接受已知方法、加密请求与正确协议参数'],
  ['test-dsh-lite-addresses.js', [], '手机地址面板经过设备证明和加密包装，明文请求不能读出访问地址'],
  ['test-dsh-lite-attachment.js', [], 'Actual authenticated encrypted attachment entry validates official session references, image bytes and metadata without path or plaintext fallback'],
  ['test-dsh-lite-attachment-gateway.js', [], 'Owned HTTP collector and actual encrypted image handler preserve complete large rasters, exact per-route caps and fail-closed disconnect/overflow/abort behavior'],
  ['test-dsh-lite-upload.js', [], '轻量 DSH 上传回执：固定路径、会话绑定、加密、大小与上游响应校验'],
  ['test-dsh-lite-download.js', [], '轻量 DSH 下载仅限已知对话的真实工作区文件，阻止越界与链接逃逸'],
  ['test-dsh-lite-files.js', [], '手机 DSH 工作区文件单层分页浏览：仅已知会话、加密与路径边界'],
  ['test-dsh-lite-adapter.js', [], '轻量 DSH 项目、对话、发送、审批与提问协议（假连接）'],
  ['test-dsh-lite-legacy-rpc.js', [], '旧版 DSH 点号 RPC 的加密、固定方法与版本门控'],
  ['test-dsh-legacy-interactions.js', [], '旧版授权与询问绑定真实待处理会话和运行时，跨会话及过期回复拒绝（隔离服务）'],
  ['test-dsh-legacy-attachments.js', [], '旧版图片上传限制、会话绑定、过期与一次性发送（隔离服务）'],
  ['test-dsh-lite-legacy.js', [], '旧版 DSH 项目、会话、历史分页与文本操作（隔离协议）'],
  ['test-dsh-lite-router.js', [], '手机版按已验证协议选新版/旧版适配，授权失败时不误连'],
  ['test-dsh-lite-code-pin.js', [], '轻量 DSH 脚本指纹、直接打开的初次钉住与旧指纹的手动更新（假 Service Worker）'],
  ['test-dsh-lite-update.js', [], '手机切回前台只提示新版本，点击后才更新指纹且失败可重试'],
  ['test-dsh-lite-ui.js', [], '轻量 DSH 手机界面和多题交互（隔离浏览器）'],
  ['test-dsh-lite-actions.js', [], 'Actual isolated Chromium project creation, busy admission, encrypted adapter file/image actions and preserved drafts'],
  ['test-dsh-lite-switch.js', [], '官方 DSH 页面上的轻量模式按钮保留完整认证和加密地址'],
  ['test-review-boundaries.js', [], '历史状态与加密失败边界（隔离，不碰真会话）'],
  ['test-narrow-kill.js', ['--static-only'], '窄杀进程：源码检查；本机 cloudflared 查询显式跳过'],
  ['test-tunnel-security.js', [], '公网来源边界：禁用 ngrok，非本机 Host 必须经过管理端点与加密闸门（隔离）'],
  ['test-tunnel-probe.js', ['--isolated-only'], 'Owned HTTP/TCP probes require the exact gateway 204, reject foreign services and enforce absolute deadlines (no production tunnel)'],
  ['similarity-audit.js', [], '重复代码审计（只看文件）'],
  // 这条需要浏览器 —— runner 上有就用，没有就跳过（见下面的处理）。
  ];

const onlyList = process.argv.includes('--list');
if (onlyList) {
  console.log('\nCI 会跑这些：\n');
  for (const [f, args, why, environment] of SUITE) console.log(`  ${f} ${args.join(' ')}\n      ${why}${environment?.platform ? ' [仅 ' + environment.platform + ']' : ''}`);
  console.log(`\n共 ${SUITE.length} 条。其余测试需要真机环境，CI 不覆盖。\n`);
  process.exit(0);
}

console.log('\n=== CI 子集 ===');
console.log(`（共 ${SUITE.length} 条；需要真机环境的不在此列，README 里已说明）\n`);

let failed = 0;
let skipped = 0;
let skippedLiveSegments = 0;

for (const [file, args, why, environment] of SUITE) {
  if (environment?.platform && environment.platform !== process.platform) {
    skipped++;
    console.log(`  ~ 跳过 ${file}（要求 ${environment.platform}，当前 ${process.platform}）  ${why}`);
    continue;
  }
  const started = Date.now();
  const r = spawnSync(NODE, [path.join(BASE, 'scripts', file), ...args], {
    cwd: BASE, encoding: 'utf8', timeout: 10 * 60 * 1000
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ms = Date.now() - started;

  // 「环境里没有这个东西」和「测试失败」是两回事，不能混。
  // 混了的话，CI 要么永远红，要么逼着人把真失败也当成环境问题忽略掉。
  const envMissing = ['test-dsh-lite-ui.js', 'test-dsh-lite-actions.js'].includes(file) && /找不到 Edge 或 Chrome/.test(out);
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
console.log('Reminder: isolated CI does not establish real-device acceptance; test the phone, installed DSH and tunnel separately.\n');

process.exitCode = failed ? 1 : 0;
