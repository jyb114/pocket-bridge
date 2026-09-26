// DSH 移动端网关 — 配置与发现
//
// 把所有「跟环境相关」的判断集中到这里，让上层代码不关心：
//   · DSH 装在哪        —— 不同电脑、不同盘符、不同操作系统
//   · 该用哪个端口      —— 8080 被占用就自动换
//   · 本机身份与密钥    —— 文件夹被复制到另一台机器时必须换新钥匙
//   · 网络环境          —— 有没有局域网地址、有没有公网 IPv6
//
// 只用 Node 内置模块，Windows / macOS / Linux 都能跑。
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const CONFIG_FILE = path.join(BASE, 'config.json');
const INSTANCE_FILE = path.join(LOG_DIR, 'instance.json');

// 这些文件属于「本机身份」，换机器时必须作废重建
const IDENTITY_FILES = [
  path.join(LOG_DIR, 'access-key.txt'),
  path.join(LOG_DIR, 'e2ee-secret.txt'),
  path.join(LOG_DIR, 'mint-cookie.json'),
  path.join(LOG_DIR, 'vapid.json'),
  path.join(LOG_DIR, 'push-subscriptions.json'),
  path.join(LOG_DIR, 'pair-code.txt')
];

const DEFAULTS = {
  gatewayPort: 8080,        // 中间层监听端口；被占用时从它开始往后找
  dshExecutable: '',        // 留空 = 自动发现
  tunnelProvider: 'auto',   // auto | cloudflare | none
  enableLanAccess: true,    // 是否提供内网直连入口
  dshPort: 0,               // 0 = 自动发现；显式指定则优先

  // ── 域名策略 ────────────────────────────────────────────────────────────────
  // dynamic —— 每次重启换一个新地址。
  //            更安全：即使被谁扫到，那个地址过一阵就失效了，无法被长期盯上。
  //            代价是书签/旧链接会失效（手机端不受影响，登录态是 cookie）。
  // fixed   —— 用自有域名的命名隧道，地址固定。
  //            更方便，但地址长期不变，一旦泄露就是长期暴露。
  // 默认取更安全的那个 —— 安全性不该为了省事而让步，要方便请自己显式打开。
  tunnelDomainMode: 'dynamic',
  fixedTunnel: {
    name: '',              // cloudflared tunnel create 时起的名字
    credentialsFile: '',   // 凭据 json 路径（cloudflared tunnel login 生成）
    hostname: ''           // 你希望用的域名，例如 dsh.example.com
  },

  // ── 内网 HTTPS ──────────────────────────────────────────────────────────────
  // 默认关闭。打开之后会多一个 HTTPS 监听，内网那条路不再是明文。
  //
  // 为什么默认关：它用的是自签证书，手机上第一次打开会看到证书警告。
  // 这个代价是真实存在的，不该替使用者默默接受 —— 所以给开关，让他自己决定。
  //
  // 它挡得住什么：同一个 WiFi 下别人的被动嗅探。
  // 它挡不住什么：能主动劫持网络的人（因为使用者已经习惯「看到警告就点继续」）。
  // 想连这个也挡掉，得把 tls/ca.crt 装到手机上信任一次，或者用自己的域名。
  lanHttps: {
    enabled: false,
    port: 0                // 0 = 自动（中间层端口 +1，被占用就往后找）
  },

  // ── Codex（可选的第二个目标）────────────────────────────────────────────────
  // Codex 的 CLI 能开一个带 WebSocket 的 app-server，手机上就能用它自己的界面。
  // 留空则自动发现（LocalAppData 下那个带版本哈希的目录）。
  codex: {
    executable: '',        // 留空 = 自动发现
    port: 18790            // app-server 监听的端口
  }
};

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ── 配置文件 ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, raw);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

function saveConfig(cfg) {
  ensureLogDir();
  const merged = Object.assign({}, DEFAULTS, cfg);
  // 原子替换。
  //
  // 原来是直接 writeFileSync 覆盖 —— 磁盘满、断电、或者两个进程同时写，
  // 都会留下半个 JSON。而 loadConfig 的 catch 会**静默**退回默认值，
  // 使用者看到的现象是「内网 HTTPS 自己关了」「地址策略自己变回动态了」，
  // 完全联想不到是配置文件坏了。
  // 同一个项目里 sessions.js、codex-queue.js 早就用了 tmp+rename，偏偏配置没有。
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return merged;
}

// ── DSH 可执行文件发现 ────────────────────────────────────────────────────────
/** 各平台常见的安装位置。找不到时这些是最可能的落点。 */
function commonDshPaths() {
  const home = os.homedir();
  const win = [
    'D:\\deepseek\\DeepSeek Harness\\DeepSeek Harness.exe',
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    'C:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  ];
  const mac = [
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness')
  ];
  const linux = [
    '/usr/bin/dsh',
    '/usr/local/bin/dsh',
    '/opt/deepseek-harness/dsh',
    path.join(home, '.local', 'bin', 'dsh')
  ];
  if (process.platform === 'win32') return win;
  if (process.platform === 'darwin') return mac;
  return linux;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/** 从正在运行的进程里拿真实路径 —— 这是最可靠的一种，因为程序就在跑。 */
function findDshFromProcesses() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | " +
        "Select-Object -First 1 -ExpandProperty Path"
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const p = String(out).trim();
      if (p && isExecutableFile(p)) return p;
      return null;
    }
    // macOS / Linux：用 ps 找进程名里带 dsh 或 DeepSeek 的
    const out = execFileSync('ps', ['-eo', 'comm='], { encoding: 'utf8', timeout: 8000 });
    for (const line of String(out).split('\n')) {
      const name = line.trim();
      if (!name) continue;
      if (/dsh|deepseek harness/i.test(name) && isExecutableFile(name)) return name;
    }
  } catch (err) {
    // 拿不到就算了，还有别的途径
  }
  return null;
}

/** Windows 注册表里的卸载信息，能挖出安装目录。 */
function findDshFromRegistry() {
  if (process.platform !== 'win32') return null;
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const root of roots) {
    try {
      const out = execFileSync('reg', ['query', root, '/s', '/f', 'DeepSeek', '/d'],
        { encoding: 'utf8', timeout: 12000, windowsHide: true });
      // 从输出里找形如 C:\...\DeepSeek Harness.exe 的路径
      const matches = String(out).match(/[A-Za-z]:\\[^"\r\n]*DeepSeek Harness\.exe/gi) || [];
      for (const m of matches) {
        const p = m.trim();
        if (isExecutableFile(p)) return p;
      }
    } catch (err) {
      // 某个根不存在很正常
    }
  }
  return null;
}

/**
 * 找 DSH 可执行文件。按可靠性从高到低依次尝试。
 * @returns {{path: string|null, source: string}}
 */
function findDshExecutable(explicitPath) {
  const attempts = [
    { source: 'config.json', value: explicitPath },
    { source: '环境变量 DSH_EXE', value: process.env.DSH_EXE }
  ];
  for (const a of attempts) {
    if (a.value && isExecutableFile(a.value)) return { path: a.value, source: a.source };
  }

  const fromProc = findDshFromProcesses();
  if (fromProc) return { path: fromProc, source: '运行中的进程' };

  for (const p of commonDshPaths()) {
    if (isExecutableFile(p)) return { path: p, source: '常见安装路径' };
  }

  const fromReg = findDshFromRegistry();
  if (fromReg) return { path: fromReg, source: '注册表' };

  return { path: null, source: '未找到' };
}

// ── 端口 ──────────────────────────────────────────────────────────────────────
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch (err) {
      resolve(false);
    }
  });
}

/**
 * 从 preferred 开始往后找一个没人占用的端口。
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(preferred, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    if (await isPortFree(port)) return port;
  }
  return null;
}

// ── 本机身份与密钥 ────────────────────────────────────────────────────────────
/** 用于识别「这是不是同一台机器」的指纹。 */
function machineFingerprint() {
  let user = '';
  try { user = os.userInfo().username; } catch (err) { user = ''; }
  return [os.hostname(), process.platform, process.arch, user].join('|');
}

/**
 * 确认本机身份。如果目录被复制到了另一台机器，作废旧密钥并重新生成 ——
 * 否则两台电脑会共用同一把访问钥匙，其中一台泄露就等于两台都泄露。
 *
 * @returns {{isNewMachine: boolean, isFirstRun: boolean, instanceId: string}}
 */
function ensureInstanceIdentity() {
  ensureLogDir();

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'));
  } catch (err) {
    previous = null;
  }

  const fp = machineFingerprint();

  if (previous && previous.fingerprint === fp && previous.instanceId) {
    return { isNewMachine: false, isFirstRun: false, instanceId: previous.instanceId };
  }

  const isFirstRun = !previous;
  const record = {
    instanceId: crypto.randomUUID(),
    fingerprint: fp,
    hostname: os.hostname(),
    platform: process.platform,
    createdAt: new Date().toISOString(),
    supersededInstanceId: previous ? previous.instanceId || null : null,
    supersededFingerprint: previous ? previous.fingerprint || null : null
  };

  // 换了机器：把属于旧机器身份的凭据全部作废
  if (!isFirstRun) {
    for (const f of IDENTITY_FILES) {
      try { fs.unlinkSync(f); } catch (err) { /* 不存在也没关系 */ }
    }
  }

  fs.writeFileSync(INSTANCE_FILE, JSON.stringify(record, null, 2), 'utf8');

  return { isNewMachine: !isFirstRun, isFirstRun, instanceId: record.instanceId };
}

// ── 网络环境 ──────────────────────────────────────────────────────────────────
/**
 * 枚举本机网络地址并分类。用 os.networkInterfaces()，所以在三个平台上一致。
 * @returns {{lanV4: Array, lanV6: Array, publicV6: Array, hostname: string}}
 */
function detectNetwork() {
  const out = { lanV4: [], lanV6: [], publicV6: [], hostname: os.hostname() };

  let ifaces = {};
  try { ifaces = os.networkInterfaces(); } catch (err) { return out; }

  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (!a || a.internal) continue;

      if (a.family === 'IPv4' || a.family === 4) {
        if (/^169\.254\./.test(a.address)) continue; // 链路本地，没用
        out.lanV4.push({ iface: name, address: a.address });
        continue;
      }

      const addr = String(a.address);
      const lower = addr.toLowerCase();
      if (lower.startsWith('fe80')) continue;                 // 链路本地
      if (lower.startsWith('fc') || lower.startsWith('fd')) {  // 唯一本地地址
        out.lanV6.push({ iface: name, address: addr });
        continue;
      }
      // 2000::/3 是当前的全球单播地址段
      if (/^[23][0-9a-f]{0,3}:/i.test(addr) && !lower.startsWith('fe')) {
        out.publicV6.push({ iface: name, address: addr });
      } else {
        out.lanV6.push({ iface: name, address: addr });
      }
    }
  }

  return out;
}

/**
 * 对端地址是不是这台机器自己的地址？
 *
 * 用来判断「这个请求是不是本机发起的」。不能只看回环：从本机访问自己的内网 IP 时，
 * socket 来源会是那个内网地址；隧道流量则是本机 cloudflared 转进来的，来源又是回环。
 * 两种情况都算「本机」。
 *
 * 注意它的边界：局域网里另一台设备连过来时，来源是**它的**地址，不在本机接口列表里，
 * 所以会被正确判为「不是本机」。这一点从本机没法端到端验证（没法伪造源地址），
 * 所以审计里单独拿一个假的来源地址验这个函数本身。
 *
 * @param {string} address 对端地址（可带 ::ffff: 前缀）
 * @param {object} [req] 也可以直接传一个请求对象，自动取它的来源地址
 */
function isOwnAddress(address, req) {
  let a = String(address || '');
  if (!a && req) {
    a = (req.socket && req.socket.remoteAddress) || '';
  }
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (!a) return false;

  if (a === '127.0.0.1' || a === '::1') return true;

  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const x of ifaces[name] || []) {
        if (x && String(x.address) === a) return true;
      }
    }
  } catch (err) { /* 读不到就当不是 */ }
  return false;
}

/**
 * 探测外部可达性：出口 IP 是多少、走的是 v4 还是 v6。
 *
 * 为什么要试好几个地址：原来只用 api.ipify.org（纯 IPv4）和 api64.ipify.org，
 * 实测在只有 IPv6 出网的机器上，前者直接失败、留下一个 null。而下游拿这个 null
 * 去比对「手机和本机是不是同一个网络」，就会把「判断不出来」当成「不在同一个网络」——
 * 于是手机明明在家、却被告知「你在外网」。多试几个、两家都问，能把这种情况压下去。
 */
async function probeEgress(timeoutMs = 6000) {
  const out = { ipv4: null, ipv6: null, errors: [] };

  const fetchText = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.text()).trim();
  };

  // IPv4：只要含冒号就说明拿到的是 v6，不要
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://api4.ipify.org']) {
    if (out.ipv4) break;
    try {
      const v = await fetchText(url);
      if (v && !v.includes(':')) out.ipv4 = v;
    } catch (err) {
      out.errors.push(`v4 ${new URL(url).host}: ${err.message}`);
    }
  }

  // IPv6：反过来，只有含冒号才要
  for (const url of ['https://api64.ipify.org', 'https://ipv6.icanhazip.com', 'https://api6.ipify.org']) {
    if (out.ipv6) break;
    try {
      const v = await fetchText(url);
      if (v && v.includes(':')) out.ipv6 = v;
    } catch (err) {
      out.errors.push(`v6 ${new URL(url).host}: ${err.message}`);
    }
  }

  return out;
}

/** 检测几个可选的隧道/组网工具是否装在机器上。 */
function detectTunnelProviders() {
  const found = { cloudflared: null, tailscale: null, ngrok: null };

  const candidates = {
    cloudflared: [
      path.join(BASE, 'cloudflared', 'cloudflared.exe'),
      path.join(BASE, 'cloudflared', 'cloudflared'),
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared'
    ],
    tailscale: [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/usr/bin/tailscale',
      '/usr/local/bin/tailscale'
    ],
    ngrok: [
      path.join(BASE, 'ngrok', 'ngrok.exe'),
      path.join(BASE, 'ngrok', 'ngrok'),
      '/usr/local/bin/ngrok',
      '/usr/bin/ngrok'
    ]
  };

  for (const name of Object.keys(candidates)) {
    for (const p of candidates[name]) {
      if (isExecutableFile(p)) { found[name] = p; break; }
    }
  }

  // 再试试 PATH
  const probe = process.platform === 'win32' ? 'where' : 'which';
  for (const name of Object.keys(found)) {
    if (found[name]) continue;
    try {
      // where / which 找不到时会往 stderr 写噪音，这里一并吞掉 ——
      // 否则会污染调用方的输出（自检脚本就被它弄脏过）
      const out = execFileSync(probe, [name], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const first = String(out).split('\n')[0].trim();
      if (first && isExecutableFile(first)) found[name] = first;
    } catch (err) {
      // 不在 PATH 里
    }
  }

  return found;
}

module.exports = {
  BASE,
  LOG_DIR,
  CONFIG_FILE,
  INSTANCE_FILE,
  DEFAULTS,
  loadConfig,
  saveConfig,
  isOwnAddress,
  findDshExecutable,
  commonDshPaths,
  findAvailablePort,
  isPortFree,
  ensureInstanceIdentity,
  machineFingerprint,
  detectNetwork,
  probeEgress,
  detectTunnelProviders
};
