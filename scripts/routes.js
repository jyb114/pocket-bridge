// DSH 移动端网关 — 连接方式智能选择
//
// 为什么要有这一层：
//
// 这台机器可能同时存在三条到手机的路径 —— 内网 IPv4、公网 IPv6、隧道。
// 该走哪条，取决于「手机现在在哪儿」和「运营商放不放行」，这两件事使用者
// 自己判断不了，他看到的只是「打不开」。所以判断这件事必须由程序来做。
//
// 这里负责两件事：
//   1. 分析本机网络环境，给每条路径打上标签，说清它适合什么场景、有什么代价
//   2. 识别「这一次请求是从哪条路进来的」，据此回答「你现在该用哪条」
//
// 一个必须诚实说明的浏览器限制：
//   从 https 页面里用 JS 去请求 http 地址，会被浏览器当作混合内容拦掉。
//   所以手机从隧道（https）进来时，页面**无法**自己去探测内网（http）那条路。
//   这不是实现偷懒，是浏览器的安全策略。绕过它的办法有两个：
//     - 服务端比对「手机的出口 IP」和「本机的出口 IP」：相同就说明在同一个
//       网络里，于是直接推荐内网那条路（不用探测也能判断）
//     - 让使用者点一下，用顶层跳转过去（顶层跳转不受混合内容限制）
//   两条都实现了，见 recommend() 与 sameNat。
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');

const EGRESS_FILE = path.join(cfg.LOG_DIR, 'egress.json');

// 本机出口 IP 的缓存。
//
// 为什么要缓存、而且要落盘：探测出口 IP 得发外网请求，而这台机器可能根本连不上
// 那几个探测地址（实测纯 IPv6 出网时，IPv4 的探测全都会超时）。
// 如果让 /__routes 每次都现场去探，最坏情况要十几秒 —— 手机上的 /go 页面早就超时了。
// 路径分析是本地就能算的事，不该被外网请求拖住。
let egressCache = { at: 0, value: null, pending: null };
const EGRESS_TTL_MS = 10 * 60 * 1000;

function loadCachedEgress() {
  try {
    const j = JSON.parse(fs.readFileSync(EGRESS_FILE, 'utf8'));
    if (j && typeof j.at === 'number') {
      egressCache = { at: j.at, value: j.value || null, pending: null };
    }
  } catch (err) { /* 还没探过 */ }
}

function saveCachedEgress() {
  try {
    fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
    fs.writeFileSync(EGRESS_FILE, JSON.stringify({
      at: egressCache.at, value: egressCache.value
    }, null, 2), 'utf8');
  } catch (err) { /* 写不了也不影响内存里那份 */ }
}

async function refreshEgress(timeoutMs) {
  let v = null;
  try {
    v = await cfg.probeEgress(timeoutMs);
  } catch (err) {
    v = { ipv4: null, ipv6: null, errors: [err.message] };
  }
  egressCache = { at: Date.now(), value: v, pending: null };
  saveCachedEgress();
  return v;
}

/**
 * 拿到本机出口 IP。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.wait]  true = 等到这次探测真的做完（自检、命令行用）
 * @param {number}  [opts.maxWaitMs] 没有缓存时最多等多久（默认 4 秒）
 *
 * 默认不阻塞：有缓存就先给缓存，同时在后台刷新。从来没有探过的话最多等一会儿，
 * 拿不到就返回 null —— 让下游显示「判断不出来」，而不是瞎猜。
 */
async function ownEgress(opts = {}) {
  if (!egressCache.value && !egressCache.at) loadCachedEgress();

  const fresh = egressCache.value && Date.now() - egressCache.at < EGRESS_TTL_MS;

  if (opts.wait) {
    if (fresh) return egressCache.value;
    return egressCache.pending || (egressCache.pending = refreshEgress(8000));
  }

  // 后台刷新（不阻塞返回）
  if (!fresh && !egressCache.pending) {
    egressCache.pending = refreshEgress(4000);
  }

  if (egressCache.value) return egressCache.value;

  // 一次都没探过：给一小段时间，别让第一次访问就永远是「判断不出来」
  if (egressCache.pending) {
    const bounded = Promise.race([
      egressCache.pending,
      new Promise((r) => setTimeout(() => r(null), opts.maxWaitMs || 4000))
    ]);
    const v = await bounded;
    if (v) return v;
  }
  return egressCache.value;
}

// 启动就预热一次，等手机连上来时通常已经有值了
loadCachedEgress();
if (!egressCache.value || Date.now() - egressCache.at > EGRESS_TTL_MS) {
  egressCache.pending = refreshEgress(4000);
}

/**
 * 取出请求的对端地址，尽量还原成「手机在公网上的样子」。
 *
 * ★ 转发头只在**来源确实是本机**时才采信。
 *
 *   原来是无条件采信的：任何直连的客户端（同一个 WiFi 上的手机、
 *   电脑上跑的任意脚本）只要自己加一个
 *     X-Forwarded-For: 1.2.3.4
 *   就能把自己伪装成另一个地址。后果不只是「设备列表里记错 IP」——
 *   配对码限速、失败计数、锁定全都按这个值分桶，伪造一下就绕过去了，
 *   而配对码只有 6 位数字。
 *
 *   隧道流量才是真的需要这些头：cloudflared 从回环转进来，socket 是
 *   127.0.0.1，真实来源只在 CF-Connecting-IP 里。所以判据是
 *   「socket 是回环 → 采信转发头；否则一律用 socket 地址」。
 *   Cloudflare 会覆盖这个头，外面伪造不了。
 */
function clientIpOf(req) {
  const h = req.headers || {};
  let a = (req.socket && req.socket.remoteAddress) || '';
  if (a.startsWith('::ffff:')) a = a.slice(7);

  const viaLoopback = a === '127.0.0.1' || a === '::1' || a === '';
  if (viaLoopback) {
    // 隧道进来的话，真实来源在这些头里（Cloudflare 用 cf-connecting-ip）
    const fwd = h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-real-ip'];
    if (fwd) {
      const first = String(fwd).split(',')[0].trim();
      if (first) return first;
    }
  }
  return a;
}

// ── 服务端自己拼的文案，也要分语言 ───────────────────────────────────────────
//
// 为什么要在这儿也做一份：`enumerate()` 的 label/note、`arrivalOf()` 的
// 识别结果、`recommend()` 那段建议，都是**服务端拼好**发给手机的。
// 页面的 `t()` 管不到它们 —— 英文手机上会出现整段中文，正是计划 H
// 验收里说的「各语言不混排」要挡的东西。
//
// 用查表而不是拼句子：这些文案里夹着变量（网卡名、IP、前缀），
// 拼接在不同语言里语序不一样，只能整句成表。
const TEXT = {
  zh: {
    arrivalLoopback: ['本机', '就在这台电脑上打开的'],
    arrivalLan: ['内网直连', '同一局域网（网卡 {iface}）'],
    arrivalIpv6: ['公网 IPv6 直连', '运营商直连（网卡 {iface}）'],
    arrivalTunnel: ['外网隧道', '经 Cloudflare 进来'],

    labLanHttps: '内网直连（加密）',
    labLan: '内网直连',
    labIpv6: '公网 IPv6 直连',
    labTunnel: '外网隧道',

    noteLanHttps: '同一个 WiFi 下最快，而且这一段是加密的；代价是手机第一次打开会看到一次证书警告',
    noteLanWithHttps: '同一个 WiFi 时最快，不绕任何服务器；这一条是明文 HTTP',
    noteLan: '手机和电脑在同一个 WiFi 时最快，不绕任何服务器',
    noteIpv6: '不绕 Cloudflare，走运营商直连；但需要光猫/路由器放行入站，多数家宽默认挡着',
    noteTunnel: '任何网络都能用（只要连得上 Cloudflare）；代价是绕一圈，稍慢',

    suitLan: '在家 / 同一 WiFi',
    suitIpv6: '在外，且运营商支持 IPv6 入站',
    suitTunnel: '在外 / 4G 5G',

    reasonNoClient: '拿不到手机的来源地址',
    reasonClientPrivate: '手机是从内网直接连进来的',
    reasonNoEgress6: '拿不到本机的出口 IPv6，没法比',
    reasonSameV6: '出口 IPv6 完全相同（{ip}）',
    reasonSameV6Prefix: '出口 IPv6 属于同一个 /64 前缀（{prefix}::/64）',
    reasonDiffV6: '出口 IPv6 前缀不同（手机 {a}::/64，本机 {b}::/64）',
    reasonNoEgress4: '拿不到本机的出口 IPv4，没法比',
    reasonSameV4: '出口 IPv4 完全相同（{ip}）',
    reasonDiffV4: '出口 IPv4 不同（手机 {client}，本机 {egress}）',

    advLoopback: '你就在这台电脑上。手机要连的话，看下面列出的地址。',
    advLanPlainWithHttps: '你现在走的是内网直连（最快的一条）。同一台机器上还开着一条加密的内网入口，'
      + '想让这一段也不被同 WiFi 的人看到，可以点下面那条切过去 —— 代价是手机第一次打开会提示一次证书。',
    advLanHttps: '你现在走的是内网加密直连 —— 这是最快的一条，保持不动就行。',
    advLan: '你现在走的是内网直连 —— 这是最快的一条，保持不动就行。',
    advIpv6: '你现在走的是公网 IPv6 直连 —— 不绕 Cloudflare，延迟通常比隧道低。',
    pickWithHttps: '点下面的「切到内网直连」即可（想连这一段也加密，选「内网直连（加密）」，'
      + '代价是第一次打开会提示一次证书）',
    pickPlain: '点下面的「切到内网直连」即可',
    advSameNetwork: '你手机和电脑在同一个网络里 —— 也就是说现在从内网直连会明显更快，'
      + '而你现在绕了 Cloudflare 一圈。{pick}。',
    advNotConfident: '你现在经隧道连接。本来想帮你判断「你是不是就在这台电脑旁边」，但{reason}。'
      + '如果你在家、和电脑同一个 WiFi，下面的内网直连会更快。',
    advDiffEgress: '你现在经隧道连接（来源 {client}，与本机出口 {egress} 不同）。'
      + '如果你其实和电脑在同一个 WiFi，下面的内网直连会明显更快 —— 点一下就能切。'
  },
  en: {
    arrivalLoopback: ['This computer', 'you opened it right here on this machine'],
    arrivalLan: ['Direct on your LAN', 'same local network (interface {iface})'],
    arrivalIpv6: ['Public IPv6, direct', 'straight through your ISP (interface {iface})'],
    arrivalTunnel: ['Internet tunnel', 'coming in through Cloudflare'],

    labLanHttps: 'Direct on your LAN (encrypted)',
    labLan: 'Direct on your LAN',
    labIpv6: 'Public IPv6, direct',
    labTunnel: 'Internet tunnel',

    noteLanHttps: 'Fastest option on the same Wi-Fi, and this leg is encrypted; the cost is a one-time certificate warning the first time your phone opens it',
    noteLanWithHttps: 'Fastest on the same Wi-Fi, no server in between; this one is plain HTTP',
    noteLan: 'Fastest when your phone and computer are on the same Wi-Fi, with no server in between',
    noteIpv6: 'Skips Cloudflare and goes straight through your ISP; but your router has to allow inbound connections, which most home setups block by default',
    noteTunnel: 'Works on any network (as long as Cloudflare is reachable); the cost is the extra hop, so it is a little slower',

    suitLan: 'At home / same Wi-Fi',
    suitIpv6: 'Away, and your ISP allows inbound IPv6',
    suitTunnel: 'Away / mobile data',

    reasonNoClient: 'your phone’s source address could not be read',
    reasonClientPrivate: 'your phone came in directly over the local network',
    reasonNoEgress6: 'this computer’s outbound IPv6 could not be read, so there is nothing to compare',
    reasonSameV6: 'the outbound IPv6 is exactly the same ({ip})',
    reasonSameV6Prefix: 'both outbound IPv6 addresses share a /64 prefix ({prefix}::/64)',
    reasonDiffV6: 'the outbound IPv6 prefixes differ (phone {a}::/64, computer {b}::/64)',
    reasonNoEgress4: 'this computer’s outbound IPv4 could not be read, so there is nothing to compare',
    reasonSameV4: 'the outbound IPv4 is exactly the same ({ip})',
    reasonDiffV4: 'the outbound IPv4 differs (phone {client}, computer {egress})',

    advLoopback: 'You are on this computer. To connect from your phone, use one of the addresses listed below.',
    advLanPlainWithHttps: 'You are on the direct LAN route (the fastest one). This machine also has an encrypted '
      + 'LAN entry point — if you do not want others on the same Wi-Fi to see this leg, tap the one below to switch. '
      + 'The cost is a one-time certificate prompt the first time your phone opens it.',
    advLanHttps: 'You are on the encrypted direct LAN route — this is the fastest one, nothing to change.',
    advLan: 'You are on the direct LAN route — this is the fastest one, nothing to change.',
    advIpv6: 'You are on the public IPv6 direct route — no Cloudflare in the middle, usually lower latency than the tunnel.',
    pickWithHttps: 'just tap “Switch to direct LAN” below (if you want this leg encrypted too, pick '
      + '“Direct on your LAN (encrypted)”; the cost is a one-time certificate prompt)',
    pickPlain: 'just tap “Switch to direct LAN” below',
    advSameNetwork: 'Your phone and this computer are on the same network — so going direct over the LAN would be '
      + 'clearly faster, and right now you are looping through Cloudflare. {pick}.',
    advNotConfident: 'You are connected through the tunnel. I tried to work out whether you are sitting next to this '
      + 'computer, but {reason}. If you are at home on the same Wi-Fi, the direct LAN route below will be faster.',
    advDiffEgress: 'You are connected through the tunnel (source {client}, different from this computer’s outbound '
      + '{egress}). If you are actually on the same Wi-Fi as the computer, the direct LAN route below will be clearly '
      + 'faster — one tap switches to it.'
  },
  es: {
    arrivalLoopback: ['Este ordenador', 'lo has abierto aquí mismo'],
    arrivalLan: ['Directo en tu red local', 'misma red local (interfaz {iface})'],
    arrivalIpv6: ['IPv6 pública, directa', 'a través de tu operador (interfaz {iface})'],
    arrivalTunnel: ['Túnel de internet', 'entrando por Cloudflare'],

    labLanHttps: 'Directo en tu red local (cifrado)',
    labLan: 'Directo en tu red local',
    labIpv6: 'IPv6 pública, directa',
    labTunnel: 'Túnel de internet',

    noteLanHttps: 'Lo más rápido en la misma Wi-Fi, y este tramo va cifrado; el precio es un aviso de certificado la primera vez que el teléfono lo abra',
    noteLanWithHttps: 'Lo más rápido en la misma Wi-Fi, sin servidores de por medio; este va por HTTP sin cifrar',
    noteLan: 'Lo más rápido cuando el teléfono y el ordenador están en la misma Wi-Fi, sin servidores de por medio',
    noteIpv6: 'Se salta Cloudflare y va directo por tu operador; pero el router tiene que permitir conexiones entrantes, y la mayoría de las casas lo bloquea',
    noteTunnel: 'Funciona en cualquier red (siempre que se llegue a Cloudflare); el precio es el rodeo, así que es algo más lento',

    suitLan: 'En casa / misma Wi-Fi',
    suitIpv6: 'Fuera, y tu operador permite IPv6 entrante',
    suitTunnel: 'Fuera / datos móviles',

    reasonNoClient: 'no se pudo leer la dirección de origen del teléfono',
    reasonClientPrivate: 'el teléfono entró directamente por la red local',
    reasonNoEgress6: 'no se pudo leer la IPv6 de salida de este ordenador, así que no hay con qué comparar',
    reasonSameV6: 'la IPv6 de salida es exactamente la misma ({ip})',
    reasonSameV6Prefix: 'las dos IPv6 de salida comparten el prefijo /64 ({prefix}::/64)',
    reasonDiffV6: 'los prefijos IPv6 de salida son distintos (teléfono {a}::/64, ordenador {b}::/64)',
    reasonNoEgress4: 'no se pudo leer la IPv4 de salida de este ordenador, así que no hay con qué comparar',
    reasonSameV4: 'la IPv4 de salida es exactamente la misma ({ip})',
    reasonDiffV4: 'la IPv4 de salida es distinta (teléfono {client}, ordenador {egress})',

    advLoopback: 'Estás en este ordenador. Para conectarte desde el teléfono, usa una de las direcciones de abajo.',
    advLanPlainWithHttps: 'Vas por la ruta directa de red local (la más rápida). Este equipo también tiene una '
      + 'entrada cifrada en la red local: si no quieres que los demás de la misma Wi-Fi vean este tramo, toca la de '
      + 'abajo para cambiar. El precio es un aviso de certificado la primera vez.',
    advLanHttps: 'Vas por la ruta directa cifrada de red local: es la más rápida, no hay que cambiar nada.',
    advLan: 'Vas por la ruta directa de red local: es la más rápida, no hay que cambiar nada.',
    advIpv6: 'Vas por la ruta directa IPv6 pública: sin Cloudflare de por medio, normalmente con menos latencia que el túnel.',
    pickWithHttps: 'solo tienes que tocar «Cambiar a red local directa» abajo (si quieres cifrar también este tramo, '
      + 'elige «Directo en tu red local (cifrado)»; el precio es un aviso de certificado)',
    pickPlain: 'solo tienes que tocar «Cambiar a red local directa» abajo',
    advSameNetwork: 'Tu teléfono y este ordenador están en la misma red, así que ir directo por la red local sería '
      + 'claramente más rápido, y ahora mismo estás dando un rodeo por Cloudflare. {pick}.',
    advNotConfident: 'Estás conectado por el túnel. He intentado averiguar si estás al lado de este ordenador, pero '
      + '{reason}. Si estás en casa, en la misma Wi-Fi, la ruta directa de abajo será más rápida.',
    advDiffEgress: 'Estás conectado por el túnel (origen {client}, distinto de la salida de este ordenador, {egress}). '
      + 'Si en realidad estás en la misma Wi-Fi que el ordenador, la ruta directa de abajo será claramente más '
      + 'rápida: se cambia con un toque.'
  }
};

const LANGS = ['zh', 'en', 'es'];

/** 取某个语言的文案表；不认识的语种退回中文（和前端 i18n 的兜底一致） */
function T(lang) { return TEXT[LANGS.indexOf(lang) >= 0 ? lang : 'zh']; }

/** 把 {name} 换成实参。不同语言语序不同，所以只能整句成表、变量后填。 */
function fill(tpl, args) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (args && k in args ? String(args[k]) : m));
}

/**
 * 这次请求是从哪条路进来的？
 *
 * 判据是 Host 头 —— 手机访问时用的就是它，服务端看得一清二楚，
 * 不需要问手机（问了也不准）。
 */
function arrivalOf(req, netInfo, lang) {
  const host = String((req.headers && req.headers.host) || '');
  const authority = host;
  let hostname = host;

  if (host.startsWith('[')) {
    hostname = host.slice(1, host.indexOf(']'));
  } else {
    const i = host.lastIndexOf(':');
    if (i > 0) hostname = host.slice(0, i);
  }
  hostname = hostname.toLowerCase();

  const M = T(lang);
  const iface = { kind: 'tunnel', label: M.arrivalTunnel[0], detail: M.arrivalTunnel[1] };

  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
    iface.kind = 'loopback';
    iface.label = M.arrivalLoopback[0];
    iface.detail = M.arrivalLoopback[1];
  } else {
    const lanHit = (netInfo.lanV4 || []).find((x) => x.address === hostname);
    const v6Hit = (netInfo.publicV6 || []).find((x) => x.address.toLowerCase() === hostname);
    if (lanHit) {
      iface.kind = 'lan';
      iface.label = M.arrivalLan[0];
      iface.detail = fill(M.arrivalLan[1], { iface: lanHit.iface });
    } else if (v6Hit) {
      iface.kind = 'ipv6';
      iface.label = M.arrivalIpv6[0];
      iface.detail = fill(M.arrivalIpv6[1], { iface: v6Hit.iface });
    }
  }

  iface.authority = authority;
  iface.clientIp = clientIpOf(req);
  // 隧道那边 Cloudflare 会把真实协议放在 x-forwarded-proto 里。
  // 这个值决定手机页面能不能去探测 http 候选（混合内容限制）。
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '')
    .split(',')[0].trim().toLowerCase();
  iface.scheme = proto === 'https' ? 'https' : 'http';
  return iface;
}

/**
 * 枚举所有能到这台机器的路径。
 *
 * @param {object} o
 * @param {number} o.port      中间层端口
 * @param {string} o.key       访问密钥（会拼进 url；调用方负责不要泄露给未认证者）
 * @param {string} o.tunnelUrl 隧道地址（没有就传 null）
 * @param {boolean} o.ipv6Listening 中间层是否在 IPv6 上监听
 */
function enumerate(o) {
  const netInfo = o.netInfo || cfg.detectNetwork();
  const M = T(o.lang);
  const out = [];
  const key = o.key || '';
  const suffix = key ? `/k/${key}` : '/';
  // ★ 地址必须带上加密密钥（#k=…），否则复制出去的就是一条**会被自家网关拒绝**的链接。
  //
  //   实时通道有一道门：经中继 + 配了长期密钥 + 请求里没有 e2ee=1 → 拒绝升级，
  //   不降级发明文。而 e2ee.js 只在页面 hash 里有 #k= 的时候才补上那个 e2ee=1。
  //
  //   于是原来控制台复制出去的 `/k/<密钥>`（不带 #k=）到了手机上就是：
  //   页面能打开、登录也成功，但 /api/remote.mux 那条 WebSocket 被自家网关 403 掉 ——
  //   表现出来就是「登录了，可对话列表永远是空的」。日志里会留一串
  //   「WS 被拒：经中继但没要求加密（拒绝明文，不降级）」。
  //
  //   fragment 不会被浏览器发到服务器，所以拼进 url 不会让它出现在任何请求里。
  const frag = o.secret ? `#k=${o.secret}` : '';

  for (const x of netInfo.lanV4 || []) {
    // 内网 HTTPS 开着的话，加密那条排在前面 —— 同一条路，能加密就不走明文
    if (o.httpsPort) {
      out.push({
        id: `lan-https-${x.address}`,
        kind: 'lan-https',
        label: M.labLanHttps,
        note: M.noteLanHttps,
        iface: x.iface,
        scheme: 'https',
        authority: `${x.address}:${o.httpsPort}`,
        origin: `https://${x.address}:${o.httpsPort}`,
        url: `https://${x.address}:${o.httpsPort}${suffix}${frag}`,
        // 和 http 那条不一样：scheme 是 https，所以从 https 页面里探测**不**算混合内容。
        // 探测会失败的唯一原因是证书没被信任 —— 也就是说，如果使用者把本地 CA
        // 装到了手机上，这条路就能被完全自动地测出来、自动选上。
        probeableFromHttps: true,
        selfTestOnly: false,
        needsCertTrust: true
      });
    }

    out.push({
      id: `lan-${x.address}`,
      kind: 'lan',
      label: M.labLan,
      note: o.httpsPort ? M.noteLanWithHttps : M.noteLan,
      iface: x.iface,
      scheme: 'http',
      authority: `${x.address}:${o.port}`,
      origin: `http://${x.address}:${o.port}`,
      url: `http://${x.address}:${o.port}${suffix}${frag}`,
      // 从 https 页面里探测不到它 —— 浏览器拦混合内容
      probeableFromHttps: false,
      suitFor: M.suitLan,
      selfTestOnly: false
    });
  }

  if (o.ipv6Listening) {
    for (const x of netInfo.publicV6 || []) {
      out.push({
        id: `ipv6-${x.address}`,
        kind: 'ipv6',
        label: M.labIpv6,
        note: M.noteIpv6,
        iface: x.iface,
        scheme: 'http',
        authority: `[${x.address}]:${o.port}`,
        origin: `http://[${x.address}]:${o.port}`,
        url: `http://[${x.address}]:${o.port}${suffix}${frag}`,
        probeableFromHttps: false,
        suitFor: M.suitIpv6,
        // 从本机访问自己的公网地址走回环，测出来的「通」不代表外面能连进来
        selfTestOnly: true
      });
    }
  }

  if (o.tunnelUrl) {
    let origin = o.tunnelUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(origin)) origin = `https://${origin}`;
    let authority = origin.replace(/^https?:\/\//, '');
    out.push({
      id: `tunnel-${authority}`,
      kind: 'tunnel',
      label: M.labTunnel,
      note: M.noteTunnel,
      iface: null,
      scheme: origin.startsWith('https') ? 'https' : 'http',
      authority,
      origin,
      url: `${origin}${suffix}${frag}`,
      probeableFromHttps: true,
      suitFor: M.suitTunnel,
      selfTestOnly: false
    });
  }

  return out;
}

// ── 判断「手机和电脑是不是在同一个网络」 ──────────────────────────────────────
//
// 这是自动选路里最关键、也最容易想当然的一环：
// 手机从隧道进来时，光看 Host 分不出它是在外面还是在家里（隧道域名对谁都一样），
// 唯一的线索是「它的出口公网 IP 和本机的出口公网 IP 是不是同一份」。
//
// 这里踩过一个真实的坑：原来只比对 IPv4，而实测这台机器是走 IPv6 出网的 ——
// 来源是 2409:... 的 v6 地址、api.ipify.org 那个纯 v4 探测又直接失败，
// 结果本该成立的判断变成了「你在外网」。修法是两家都探、两族都比。

/** 去掉 IPv4-mapped IPv6 前缀，方便统一比较 */
function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

function isV6(ip) { return normalizeIp(ip).includes(':'); }

/**
 * 取 IPv6 的 /64 前缀。
 *
 * 为什么是 /64 而不是整个地址：同一户人家分到的是一个 /64（或更大）的前缀，
 * 而手机为了隐私会给每个连接换一个临时地址（RFC 4941），后缀一直在变。
 * 比整串地址会永远不相等；比 /64 才对应「同一户」这个事实。
 */
function v6Prefix(ip) {
  const s = normalizeIp(ip);
  // 展开 :: 之后再取前 4 段
  const [head, tail] = s.split('::');
  let groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : [];
    const missing = 8 - groups.length - t.length;
    groups = groups.concat(new Array(Math.max(0, missing)).fill('0')).concat(t);
  }
  return groups.slice(0, 4).map((g) => g.replace(/^0+/, '') || '0').join(':');
}

/**
 * 出口 IP 相同 ⇒ 基本可以断定手机和电脑在同一个网络里。
 *
 * @returns {{same: boolean, reason: string, confident: boolean}}
 *   confident=false 表示「拿不到足够信息，判断不出来」——
 *   这种情况必须和「确定不在同一个网络」区分开，否则会给出错误的建议。
 */
function sameNatDetail(arrival, egress, lang) {
  const M = T(lang);
  const client = normalizeIp(arrival && arrival.clientIp);
  if (!client) return { same: false, reason: M.reasonNoClient, confident: false };

  // 手机直接从内网连进来时，来源就是内网地址 —— 这本来就是另一个判断维度
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(client)) {
    return { same: false, reason: M.reasonClientPrivate, confident: false };
  }

  const e4 = normalizeIp(egress && egress.ipv4);
  const e6 = normalizeIp(egress && egress.ipv6);

  if (isV6(client)) {
    if (!e6) return { same: false, reason: M.reasonNoEgress6, confident: false };
    if (client === e6) return { same: true, reason: fill(M.reasonSameV6, { ip: client }), confident: true };
    const a = v6Prefix(client), b = v6Prefix(e6);
    if (a && a === b) {
      return { same: true, reason: fill(M.reasonSameV6Prefix, { prefix: a }), confident: true };
    }
    return { same: false, reason: fill(M.reasonDiffV6, { a, b }), confident: true };
  }

  if (!e4) return { same: false, reason: M.reasonNoEgress4, confident: false };
  if (client === e4) return { same: true, reason: fill(M.reasonSameV4, { ip: client }), confident: true };
  return { same: false, reason: fill(M.reasonDiffV4, { client, egress: e4 }), confident: true };
}

/** 简版，只要一个布尔值 */
function sameNat(arrival, egress) {
  return sameNatDetail(arrival, egress).same;
}

/**
 * 结合「手机从哪来」给出结论：现在该用哪条路，为什么。
 *
 * @returns {{arrival, candidates, best, sameNetwork, advice, canProbeFromHere}}
 */
async function recommend(req, o) {
  const netInfo = o.netInfo || cfg.detectNetwork();
  const M = T(o.lang);
  const candidates = enumerate(Object.assign({}, o, { netInfo }));
  const arrival = arrivalOf(req, netInfo, o.lang);
  const egress = await ownEgress();

  const nat = sameNatDetail(arrival, egress, o.lang);
  const sameNetwork = nat.same;
  const current = candidates.find((c) => c.authority === arrival.authority) || null;

  // 从这里（手机当前页面）能自己去探测哪些
  const fromHttps = arrival.scheme === 'https';
  const canProbeFromHere = candidates.filter(
    (c) => !fromHttps || c.probeableFromHttps
  );

  const lan = candidates.find((c) => c.kind === 'lan') || null;
  const lanHttps = candidates.find((c) => c.kind === 'lan-https') || null;
  const tunnel = candidates.find((c) => c.kind === 'tunnel') || null;
  const ipv6 = candidates.find((c) => c.kind === 'ipv6') || null;
  // 「能加密的那条内网路」优先于明文那条
  const bestLan = lanHttps || lan;

  let advice;
  let best = current;
  // 给前端一个**结构化的**结论，别让它去猜散文。
  //
  // 原来 `go.html` 是靠 `d.advice.indexOf('最快') >= 0` 决定用哪种样式的 ——
  // 那在一个中文句子成立，换成英文就永远匹配不上（而且句子改一个字就失效）。
  // 所以结论用枚举给出来，样式跟着枚举走。
  let adviceKind;

  if (arrival.kind === 'loopback') {
    advice = M.advLoopback;
    adviceKind = 'loopback';
    best = bestLan || tunnel || current;
  } else if (arrival.kind === 'lan' || arrival.kind === 'lan-https') {
    // 明文进来、但加密那条也开着的话，顺手提一句 —— 同一台机器上换个端口就能加密
    if (arrival.kind === 'lan' && lanHttps) {
      advice = M.advLanPlainWithHttps;
      adviceKind = 'lan-can-encrypt';
    } else if (arrival.kind === 'lan-https') {
      advice = M.advLanHttps;
      adviceKind = 'lan-best';
    } else {
      advice = M.advLan;
      adviceKind = 'lan-best';
    }
    best = current || bestLan;
  } else if (arrival.kind === 'ipv6') {
    advice = M.advIpv6;
    adviceKind = 'ipv6-best';
    best = current || ipv6;
  } else {
    // 隧道进来：最需要判断的场景
    //
    // 措辞上有个细节：不能只推荐加密那条。服务端没法知道这台手机有没有信任
    // 本地 CA —— 没信任的话，切到加密那条会看到一页证书错误。所以把明文那条
    // 说成「一定能用」的，把加密那条说成可选的升级，让使用者自己权衡。
    const pick = lanHttps ? M.pickWithHttps : M.pickPlain;

    if (sameNetwork) {
      advice = fill(M.advSameNetwork, { pick });
      adviceKind = 'switch-faster';
      best = bestLan || current;
    } else if (!nat.confident) {
      // 判断不出来就如实说，不要假装知道 —— 猜错会把人引到一条不通的路上
      advice = fill(M.advNotConfident, { reason: nat.reason });
      adviceKind = 'tunnel-unknown';
      best = current;
    } else {
      // 出口不同 —— 通常确实是在外面。但也有一种情况：手机和电脑都在家里，
      // 只是其中一个走了代理/VPN（实测这台机器上就是这样：浏览器经代理出去、
      // 服务端直连出去，出口 IP 完全不同）。这种时候不该替使用者下结论，
      // 而是把内网那条摆在那里，让他一眼看到「想更快就点这个」。
      advice = fill(M.advDiffEgress, {
        client: arrival.clientIp,
        egress: egress.ipv4 || egress.ipv6
      });
      adviceKind = 'tunnel-maybe-faster';
      best = current;
    }
  }

  return {
    arrival,
    candidates,
    current,
    best,
    sameNetwork,
    // 把判断依据一并给出去，前端才能把「确定」和「猜不出来」分开显示
    sameNetworkReason: nat.reason,
    sameNetworkConfident: nat.confident,
    egress,
    advice,
    // 结构化结论：前端按它选样式，不去猜散文（见上面 adviceKind 的说明）
    adviceKind,
    // 服务端用的哪种语言 —— 排查时能一眼看出前端拿到的是不是自己期望的语言
    lang: LANGS.indexOf(o.lang) >= 0 ? o.lang : 'zh',
    // 从当前页面能探测的候选（受混合内容限制）
    probeable: canProbeFromHere.map((c) => c.id),
    // 从 https 页面探测不了内网 —— 如实告诉前端，别让它假装探测过
    mixedContentBlocked: fromHttps
      ? candidates.filter((c) => !c.probeableFromHttps).map((c) => c.id)
      : []
  };
}

module.exports = {
  enumerate, arrivalOf, recommend, sameNat, sameNatDetail, v6Prefix, ownEgress, clientIpOf
};
