// DSH 移动端网关 — 设备会话
//
// 为什么需要这一层：
//
// 现在的门只有一把锁 —— 访问密钥。密钥换一次，所有设备一起失效；而如果只是
// 某一台手机丢了，你没法只把那一台关在门外。这就是「单一共享密钥、无法按设备吊销」
// 这条安全审计结论的来源。
//
// 做法：给每台设备发一个独立的会话令牌，作为**第二道门**。
//
// 为什么是第二道而不是唯一一道：DSH 自己会校验它那个 cookie 的值（伪造的值会
// 返回 401，这是实测出来的，见 scripts/probe-cookie-authority.js），所以浏览器
// 仍然必须持有 DSH 的 cookie。设备令牌加在它前面，作用是把「谁进来了」变成
// 可看见、可单独撤销的东西。
//
// 令牌格式:  <会话序号>.<base64url(载荷)>.<base64url(HMAC)>
// 载荷:      { i: 会话 id, a: 绑定的 authority, e: 过期时间, n: 随机数 }
// 存储:      logs/devices.json（明文列表，里面不含令牌本身，只含它的哈希）
//
// 签名密钥由当前访问密钥派生 —— 轮换访问密钥时，所有设备会话一并作废，这是对的。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const FILE = path.join(LOG_DIR, 'devices.json');

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天，够长到不用天天配对，短到不会永久有效
// 令牌失效之后还能自愈多久（见 refresh 里的说明）：90 天。
// 合起来一张令牌最多活 180 天 —— 有界，而且正常使用者碰不到。
const REFRESH_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

function readAccessKey() {
  try { return fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim(); }
  catch (err) { return 'no-key'; }
}

function secret() {
  return crypto.createHash('sha256').update(`dsh-gw-device|${readAccessKey()}`).digest();
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

/** 时间无关的比较，避免通过响应时间猜签名 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 令牌只存哈希 —— 存储文件被看到也不等于拿到了令牌 */
function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 24);
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && Array.isArray(j.devices)) return j;
  } catch (err) { /* 首次运行或文件坏了 */ }
  return { version: 1, devices: [] };
}

function save(db) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE); // 原子替换，避免写一半断电留下坏文件
}

/** 给这台设备起个一眼能认出来的名字，比一串 id 有用得多 */
function labelFromUa(ua) {
  const s = String(ua || '');
  const osName =
    /iPhone/i.test(s) ? 'iPhone' :
    /iPad/i.test(s) ? 'iPad' :
    /Android/i.test(s) ? 'Android' :
    /Macintosh|Mac OS X/i.test(s) ? 'Mac' :
    /Windows/i.test(s) ? 'Windows' :
    /Linux/i.test(s) ? 'Linux' : '未知设备';
  const browser =
    /Edg\//i.test(s) ? 'Edge' :
    /CriOS/i.test(s) ? 'Chrome' :
    /Chrome\//i.test(s) ? 'Chrome' :
    /Firefox\//i.test(s) ? 'Firefox' :
    /Safari\//i.test(s) ? 'Safari' : '';
  return browser ? `${osName} · ${browser}` : osName;
}

/**
 * 新建一个设备会话。
 *
 * 同一台设备**不会**重复登记 —— 见下面 findSame 的说明。
 *
 * @returns {{token: string, device: object, merged?: boolean}}
 */
function create(opts = {}) {
  const db = load();
  const now = Date.now();
  const ua = String(opts.ua || '').slice(0, 300);
  const ip = opts.ip || null;

  // ── 先看这台设备是不是已经登记过了 ──────────────────────────────────────
  //
  // 同一设备打开多个网页时应共用一条记录。这里先找，找到就复用并补发令牌，
  // 而不是又插一条新的。
  //
  // 判据是 **UA + 来源地址**：同一台手机上同一个浏览器，这两样必然一样；
  // 而换一台设备几乎不可能两样都撞上（局域网里每台设备有自己的地址，
  // 隧道进来的公网地址也通常不同）。
  //
  // 已知的边界，写出来而不是装作没有：两台**完全相同**的手机（同型号、
  // 同系统版本、同浏览器）从**同一个公网出口**连过来时会被并成一条 ——
  // 典型场景是两部同款 iPhone 都在家里连隧道。代价是「吊销一台会连带另一台」。
  // 不合并的代价是列表永远在变长、真设备淹没在重复项里，使用者已经明确选了前者。
  //
  // ── 后来又补了一条（使用者第二次提这件事）─────────────────────────────
  //
  // 他说：「有哪些设备链接还是要有，不要完全删掉，但是同一个设备、
  //        不同网址合为一个。」
  //
  // 上面那版只按「UA + 当前来源地址」匹配，于是同一台手机会按**走哪条路**
  // 分裂成好几行：在家走内网是一条、在外面走隧道是另一条、换过一次地址
  // 重新配对又是一条。他的设备表里就同时躺着同一个 iPhone 的两条记录。
  //
  // 现在改成按**设备本身**认：
  //   · 优先复用同一台设备上还活着的记录（UA + 来源地址都对得上）
  //   · 退一步，复用**同一 UA 的最近一条记录**（哪怕它已被注销或过期）——
  //     「这台 iPhone 重新配对了一次」不该在列表里变成第二台 iPhone。
  //     重新配对本来就是合法的重新授权（它手里有访问密钥），
  //     所以复活那条记录、刷新有效期，而不是另起一行。
  //   · 拿不到 UA 的请求（命令行工具、探针）永远不合并 —— 没有可区分身份，
  //     猜就是错。
  const sameUa = () => (ua ? db.devices.filter((d) => d.ua === ua) : []);
  const findSame = () =>
    sameUa().find((d) => (d.lastIp || null) === ip &&
      !d.revokedAt && !(typeof d.expiresAt === 'number' && now > d.expiresAt)) ||
    // 同一台设备换了一条路 / 重新配对过：认最近的那一条
    sameUa().sort((a, b) =>
      String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))[0];

  const existing = findSame();
  if (existing) {
    existing.lastSeenAt = new Date(now).toISOString();
    existing.lastIp = ip;
    if (opts.authority) existing.authority = opts.authority;
    // 复活：重新配对意味着一次完整的认证，把注销状态和有效期一并刷新
    const revived = !!existing.revokedAt ||
      (typeof existing.expiresAt === 'number' && now > existing.expiresAt);
    existing.revokedAt = null;
    existing.expiresAt = now + (opts.ttlMs || DEFAULT_TTL_MS);

    const token = mintToken(existing.id, opts.authority, existing.expiresAt);
    const prev = Array.isArray(existing.fps) ? existing.fps.slice() : (existing.fp ? [existing.fp] : []);
    existing.fps = [fingerprint(token), ...prev].slice(0, KEEP_FINGERPRINTS);
    existing.fp = existing.fps[0];   // 兼容老记录
    save(db);

    return { token, device: existing, merged: true, revived };
  }

  const id = crypto.randomBytes(9).toString('base64url');

  // 拿不到 User-Agent、或认不出来时，退回用来源地址命名 ——
  // 「未知设备」三个字对排查毫无帮助，而 IP 至少能告诉你它是从哪儿来的
  let label = opts.label || labelFromUa(opts.ua);
  if (label === '未知设备' && opts.ip) label = `未知设备（${opts.ip}）`;

  const device = {
    id,
    label,
    ua,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    lastIp: ip,
    authority: opts.authority || null,
    expiresAt: now + (opts.ttlMs || DEFAULT_TTL_MS),
    revokedAt: null,
    fp: null
  };

  const token = mintToken(id, opts.authority, device.expiresAt);
  device.fp = fingerprint(token);

  db.devices.push(device);
  // 只留最近 50 台，避免文件无限长
  if (db.devices.length > 50) db.devices = db.devices.slice(-50);
  save(db);

  return { token, device };
}

function mintToken(id, authority, expiresAt) {
  const payload = {
    i: id,
    a: authority || null,
    e: expiresAt,
    n: crypto.randomBytes(8).toString('base64url')
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${id}.${body}.${sign(body)}`;
}

/**
 * 校验一个令牌。
 *
 * 三种失败要分清楚，因为处理方式不同：签名不对 = 伪造；库里没有 = 已吊销；
 * 过期 = 需要重新配对。
 *
 * @returns {{ok: boolean, reason?: string, device?: object}}
 */
function verify(token, opts = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'bad-format' };

  const [id, body, sig] = parts;
  if (!safeEqual(sig, sign(body))) return { ok: false, reason: 'bad-signature' };

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (err) { return { ok: false, reason: 'bad-payload' }; }

  if (payload.i !== id) return { ok: false, reason: 'id-mismatch' };
  if (typeof payload.e !== 'number' || Date.now() > payload.e) {
    return { ok: false, reason: 'expired' };
  }

  const db = load();
  const device = db.devices.find((d) => d.id === id);
  if (!device) return { ok: false, reason: 'unknown' };
  if (device.revokedAt) return { ok: false, reason: 'revoked' };

  // 认最近几张令牌，不是只认最新那张 —— 换路径时旧页面可能还开着（见 reissue 的说明）
  const mine = fingerprint(token);
  const known = Array.isArray(device.fps) ? device.fps : (device.fp ? [device.fp] : []);
  if (known.length && !known.some((f) => safeEqual(f, mine))) {
    return { ok: false, reason: 'superseded' };
  }

  // 换了一条路连过来时，把绑定的 authority 更新掉 —— 否则每次切路径都要重新配对
  if (opts.authority && device.authority && device.authority !== opts.authority) {
    device.authority = opts.authority;
  }
  device.lastSeenAt = new Date().toISOString();
  if (opts.ip) device.lastIp = opts.ip;

  // ★ 滑动续期：避免长期使用的设备在外出时突然需要重新配对。
  //
  //   原来有效期是**从配对那天算起的硬期限**（90 天）—— 天天用的手机也会在第 90 天
  //   突然被赶去重新配对，而人在外面根本拿不到电脑上的配对码。
  //   现在改成：每次成功使用都往后推 90 天。也就是「90 天没用过」才真的过期，
  //   而那种情况下手机自己也早就不用了。
  //
  //   ★ 注销（revokedAt）**不受影响**：那是明确的不许进，怎么用都不会复活。
  if (!device.revokedAt) {
    device.expiresAt = Date.now() + (opts.ttlMs || DEFAULT_TTL_MS);
  }
  save(db);

  return { ok: true, device };
}

/**
 * 令牌签名有效、但设备表里没有这条记录 —— 把它重新登记回来。
 *
 * 什么时候会走到这里：设备表被删了、被清了、换机器了。
 * 这不是「这台设备有问题」，是**我们这边的记录丢了**。
 *
 * 为什么可以放心放行：令牌是用**当前访问密钥**派生的密钥签的，
 * 能验过签名就说明它当初确实拿着正确的密钥进来过。而「让某台设备进不来」
 * 这件事由另外两条保证 —— 表里的 `revokedAt`（明确注销）和轮换访问密钥
 * （一换全部失效）。把「记录丢了」和「被注销了」混为一谈，
 * 结果是使用者每次都得重新配对，而安全性一点没多。
 *
 * @returns {object|null} 恢复出来的设备记录；签名不对或过期则返回 null
 */
/**
 * 给「令牌过期了 / 被新令牌挤掉了」但**签名仍然有效**的设备换一张新令牌。
 *
 * 为什么需要它：外出时无法访问电脑上的配对码，短期失效的合法设备需要自愈。
 *   `recover()` 只在「设备表里没有这条记录」时管用，而且它还会因为**令牌自己过期**
 *   而拒绝（它拿 payload.e 判断）。可是设备令牌的有效期和记录的有效期是同一个值 ——
 *   于是「过期」这一类永远走不到自愈，只能去要配对码，而人在外面拿不到。
 *
 * 判据只有一条，和 recover 完全一样：**签名能用当前访问密钥验过**。
 * 那说明这张令牌当初确实是拿着正确密钥签发的（伪造的、或者换过密钥的都验不过）。
 *
 * ★ 明确注销过的设备（revokedAt）**绝不自动复活** —— 这是它和「重新登记」唯一的分界：
 *   判据不是「能不能验过」，而是「你是不是被明确赶出去过」。
 *
 * @returns {{device: object, token: string}|null}
 */
function refresh(token, opts = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const [id, body, sig] = parts;
  if (!safeEqual(sig, sign(body))) return null;          // 伪造 / 换过密钥 → 必须重新配对

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (err) { return null; }
  if (payload.i !== id) return null;

  const now = Date.now();

  // ★ 自愈窗口上限（安全账，别省这一步）。
  //
  //   不加这一道的话：一张**被录下来的旧 cookie**（比如隧道在 TLS 终点看到的）
  //   就永久有效了 —— 因为每次用它都会自动换新，等于永不过期。
  //   有了它：令牌失效之后最多再自愈 REFRESH_GRACE_MS（90 天），之后老老实实
  //   去重新配对。合起来「一张令牌最多活 90 天有效 + 90 天宽限 = 180 天」，
  //   是个有界、说得清的数，而不是「永久」。
  //
  //   （正常使用者碰不到这道线：手机上那张令牌一直在用，根本不会走到过期。）
  if (typeof payload.e === 'number' && payload.e < now - REFRESH_GRACE_MS) return null;

  const db = load();
  const device = db.devices.find((d) => d.id === id);
  if (!device) return null;                              // 表里没这条 → 交给 recover
  if (device.revokedAt) return null;                     // 明确注销 = 不许进，不复活

  const expiresAt = now + (opts.ttlMs || DEFAULT_TTL_MS);
  device.expiresAt = expiresAt;
  device.lastSeenAt = new Date(now).toISOString();
  if (opts.ip) device.lastIp = opts.ip;
  if (opts.authority) device.authority = opts.authority;
  device.renewedCount = (device.renewedCount || 0) + 1;  // 控制台里能看出它续过几次
  device.renewedAt = new Date(now).toISOString();

  const tok = mintToken(id, opts.authority, expiresAt);
  const prev = Array.isArray(device.fps) ? device.fps.slice() : (device.fp ? [device.fp] : []);
  device.fps = [fingerprint(tok), ...prev].slice(0, KEEP_FINGERPRINTS);
  device.fp = device.fps[0];
  save(db);

  return { device, token: tok };
}

function recover(token, opts = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const [id, body, sig] = parts;
  if (!safeEqual(sig, sign(body))) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (err) { return null; }

  if (payload.i !== id) return null;
  if (typeof payload.e === 'number' && Date.now() > payload.e) return null;

  const db = load();
  if (db.devices.some((d) => d.id === id)) return null;   // 已经有了，不该走这里

  const now = Date.now();
  const label = opts.label || labelFromUa(opts.ua);
  const device = {
    id,
    label: label === '未知设备' && opts.ip ? `未知设备（${opts.ip}）` : label,
    ua: String(opts.ua || '').slice(0, 300),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    lastIp: opts.ip || null,
    authority: opts.authority || null,
    expiresAt: typeof payload.e === 'number' ? payload.e : now + DEFAULT_TTL_MS,
    revokedAt: null,
    fps: [fingerprint(token)],
    fp: fingerprint(token),
    recovered: true
  };

  db.devices.push(device);
  if (db.devices.length > 50) db.devices = db.devices.slice(-50);
  save(db);
  return device;
}

/** 某个会话 id 现在还有效吗（换路径票据用它来继承原设备的身份） */
function isActive(id) {
  const db = load();
  const d = db.devices.find((x) => x.id === id);
  if (!d || d.revokedAt) return false;
  if (typeof d.expiresAt === 'number' && Date.now() > d.expiresAt) return false;
  return true;
}

/**
 * 给已有设备重发一张令牌（换了一条路连过来时用）。
 *
 * 为什么要重发而不是沿用旧的那张：令牌里绑了 authority，换路径后地址变了，
 * 旧令牌在新地址上会被判为「不是发给这里的」。重发一张绑新地址的，
 * 但设备身份不变 —— 设备列表里还是一台，不会因为切了次网络就冒出第二台。
 *
 * 保留最近几张而不是只留最新那张：手机切路径时，旧路径上的页面可能还开着
 * （另一个标签页、或者用户按了后退）。只认最新一张的话，那些页面会突然
 * 被判成「登录已被取代」，表现就是莫名其妙要求重新配对。
 * 留几张的代价极小，换来的是切换和后退都不会误伤。
 *
 * ★ 4 太小，实测会死循环 —— 现在的常见用法是**同一台手机上开两个上下文**：
 *   Safari 里的标签页 + 加到主屏幕的那个网页 App。两者的浏览器标识一模一样，
 *   服务器认为它们是同一台设备，于是每次打开都往这 4 个格子里塞一张新令牌、
 *   把对方的挤出去，两边互相顶：
 *
 *     15:09:27  设备令牌被拒(superseded)
 *     15:09:28  403 设备校验失败(superseded)
 *     15:10:12  设备令牌被拒(superseded)
 *     15:10:27  403 设备校验失败(superseded): GET /
 *
 *   表现就是使用者反复说的「保存到屏幕后打不开」—— 主屏图标和 Safari 谁也
 *   用不了。放宽之后两个上下文能长期共存；安全性几乎不变（令牌仍然会过期、
 *   仍然可以被单独撤销，只是「旧令牌」的尾巴留长一点）。
 */
const KEEP_FINGERPRINTS = 24;

function reissue(id, authority) {
  const db = load();
  const d = db.devices.find((x) => x.id === id);
  if (!d || d.revokedAt) return null;

  if (authority) d.authority = authority;
  d.lastSeenAt = new Date().toISOString();
  const token = mintToken(id, authority, d.expiresAt);

  const prev = Array.isArray(d.fps) ? d.fps.slice() : (d.fp ? [d.fp] : []);
  d.fps = [fingerprint(token), ...prev].slice(0, KEEP_FINGERPRINTS);
  d.fp = d.fps[0];   // 兼容老记录
  save(db);
  return token;
}

function list(opts = {}) {
  const db = load();
  const now = Date.now();
  const ctx = selfVisitContext();
  const devices = db.devices.map((d) => ({
    id: d.id,
    label: d.label,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    lastIp: d.lastIp,
    expiresAt: d.expiresAt,
    // 「有效」要把过期算进去，否则列表上看着还在、实际早就进不来了
    active: !d.revokedAt && !(typeof d.expiresAt === 'number' && now > d.expiresAt),
    revoked: !!d.revokedAt,
    revokedAt: d.revokedAt,
    // 「这台电脑自己打开的控制台窗口」—— 显示时要单独收起来，见 isSelfVisit 的说明
    local: isSelfVisit(d, ctx)
  }));
  devices.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  if (opts.activeOnly) return devices.filter((d) => d.active);
  return devices;
}

// ── 把「电脑自己开的窗口」从设备列表里认出来 ────────────────────────────────────
//
// 起因是一个真实的、很难看出来的 bug：控制台页面自己也会走一遍认证，
// 于是**每在电脑上打开一次控制台，设备列表里就多一台「Windows · Edge」**。
// 使用者看到的是「已经连上的手机：23 台」，而其中 22 台是他自己的浏览器窗口，
// 唯一那台真手机被埋在中间 —— 列表既吓人又没用。
//
// 现在三道守卫（ensureDevice / 配对码 / 密钥入口）都会跳过本机，不再新增这种记录；
// 这个函数负责把**守卫加上之前留下的历史记录**认出来，好在界面上收起来。
//
// 判据分三种来源，前两种是铁证，第三种要靠「像不像手机」来分辨：
//
//   1. 来源地址是这台机器自己的**内网/回环**地址。只有本机才能拿自己的
//      内网地址当来源，外面任何设备都不会。
//   2. 来源地址正好等于它访问的那个地址 —— 自己连自己。
//      （这一条认的是 IP 变过之后留下的老记录：那时两边都还是旧地址。）
//   3. 来源是这台机器的**公网出口**地址。这一条**单独看不能作数** ——
//      手机在家连隧道时，出口地址和电脑一模一样（同一个 NAT / 同一条宽带）。
//      所以要看客户端像不像手机：
//        · 像手机（iPhone / iPad / Android）→ 是外面的设备，照常登记、可单独吊销
//        · 不像手机（桌面浏览器、命令行工具、认不出来的）→ 是本机自己
//      判「像不像手机」而不是「像不像桌面」，是因为反例出现在**认不出来的**
//      那一类上：本机用 node 的 fetch 请求自己的隧道地址时 UA 是 `node`，
//      按「桌面浏览器」判会漏掉它，于是列表里冒出一台「未知设备（2409:…）」。
const MOBILE_LABEL = /iPhone|iPad|Android|Mobile/i;

/**
 * 这次请求是不是**这台机器自己**发起的？
 *
 * 三个调用点（ensureDevice / 配对码 / 密钥入口）共用它 —— 判据只写一份，
 * 否则改了这里漏了那里，又是一类「某条路上还是会冒出本机记录」的 bug。
 *
 * @param {string} ip    真实来源地址（隧道流量要用 CF-Connecting-IP，不是 socket）
 * @param {string} label 设备名（labelFromUa 的结果）
 * @param {object} [ctx] selfVisitContext() 的结果，批量判断时传进来省重复读网卡
 */
function isSelfClient(ip, label, ctx) {
  const a = String(ip || '').toLowerCase();
  if (!a) return false;
  const c = ctx || selfVisitContext();

  if (c.egress.indexOf(a) >= 0) return !MOBILE_LABEL.test(String(label || ''));
  return c.own.has(a);
}

function selfVisitContext() {
  const own = new Set(['127.0.0.1', '::1']);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const x of ifaces[name] || []) {
        if (x && x.address) own.add(String(x.address).toLowerCase());
      }
    }
  } catch (err) { /* 读不到就少一条判据，不影响其余 */ }

  const egress = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'egress.json'), 'utf8'));
    const v = (j && j.value) || {};
    for (const ip of [v.ipv4, v.ipv6]) if (ip) egress.push(String(ip).toLowerCase());
  } catch (err) { /* 没探测过出口地址就少一条判据 */ }

  return { own, egress };
}

function authorityHost(authority) {
  const s = String(authority || '').toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'));
  return s.split(':')[0];
}

function isSelfVisit(d, ctx) {
  if (isSelfClient(d.lastIp, d.label, ctx)) return true;
  const ip = String(d.lastIp || '').toLowerCase();
  return !!ip && authorityHost(d.authority) === ip;
}

/**
 * 把「电脑自己开的窗口」留下的记录删掉。
 *
 * 只删能证明是本机的（见 isSelfVisit），不碰任何可能是真手机的记录。
 * 这些记录本来就不该存在 —— 留着只会让人以为有 23 台设备连过。
 *
 * @returns {{removed: number, kept: number}}
 */
function forgetSelf() {
  const db = load();
  const ctx = selfVisitContext();
  const before = db.devices.length;
  db.devices = db.devices.filter((d) => !isSelfVisit(d, ctx));
  if (db.devices.length !== before) save(db);
  return { removed: before - db.devices.length, kept: db.devices.length };
}


/** 吊销一台设备。真正生效的是 revokedAt —— 令牌本身没法「收回」，只能让它失效。 */
function revoke(id) {
  const db = load();
  const d = db.devices.find((x) => x.id === id);
  if (!d) return { ok: false, reason: '没有这台设备' };
  if (d.revokedAt) return { ok: false, reason: '已经吊销过了' };
  d.revokedAt = new Date().toISOString();
  save(db);
  return { ok: true, label: d.label };
}

function revokeAll() {
  const db = load();
  const now = new Date().toISOString();
  let n = 0;
  for (const d of db.devices) {
    if (!d.revokedAt) { d.revokedAt = now; n++; }
  }
  save(db);
  return n;
}

/**
 * 把记录彻底删掉（不是吊销）。
 *
 * 只给测试和自检收尾用 —— 它们造出来的设备不该留在使用者的列表里。
 * 正常情况下「让人进不来」应该用 revoke：留一条记录才能看出「这台曾经来过、后来被我关了」。
 */
function remove(id) {
  const db = load();
  const before = db.devices.length;
  db.devices = db.devices.filter((d) => d.id !== id);
  save(db);
  return before - db.devices.length;
}

/** 清掉已吊销且超过 30 天的记录，让列表不至于变成垃圾场 */
function prune(days = 30) {
  const db = load();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = db.devices.length;
  db.devices = db.devices.filter((d) => {
    if (!d.revokedAt) return true;
    return new Date(d.revokedAt).getTime() > cutoff;
  });
  save(db);
  return before - db.devices.length;
}

/**
 * 把「同一台设备的重复记录」并成一条。
 *
 * 同一设备经不同网址访问时应合并记录。
 * create() 现在不会再制造新的重复了，但历史记录里已经躺着 ——
 * 他的设备表里就同时有同一个 iPhone 的两条（一条走内网、一条走 IPv6）。
 *
 * 规则：同一个 UA 只留一条。留哪条？
 *   1. 还活着的优先（已注销的是历史，活的才是他现在在用的）
 *   2. 同样状态下留最后出现时间最新的
 * 丢掉的那几条里如果有还没过期的令牌，一并作废 —— 不能让被并掉的记录
 * 继续当一张有效的门票用。
 *
 * @returns {{merged: number}} 并掉了几条
 */
function dedupe() {
  const db = load();
  const now = Date.now();
  const alive = (d) => !d.revokedAt && !(typeof d.expiresAt === 'number' && now > d.expiresAt);

  const best = new Map();     // ua -> 保留的那条
  const drop = [];
  for (const d of db.devices) {
    if (!d.ua) continue;      // 没有 UA 的不参与（无法区分身份）
    const cur = best.get(d.ua);
    if (!cur) { best.set(d.ua, d); continue; }
    const better = (alive(d) && !alive(cur)) ||
      (alive(d) === alive(cur) &&
        String(d.lastSeenAt || '').localeCompare(String(cur.lastSeenAt || '')) > 0);
    if (better) { drop.push(cur); best.set(d.ua, d); }
    else drop.push(d);
  }
  if (!drop.length) return { merged: 0 };

  const dropIds = new Set(drop.map((d) => d.id));
  db.devices = db.devices.filter((d) => !dropIds.has(d.id));
  save(db);
  return { merged: dropIds.size };
}

function hostname() {
  try { return os.hostname(); } catch (err) { return null; }
}

module.exports = {
  create, verify, isActive, reissue, recover, refresh, list, revoke, revokeAll, remove, prune,
  forgetSelf, dedupe, isSelfVisit, isSelfClient, labelFromUa, fingerprint,
  FILE, DEFAULT_TTL_MS, hostname
};
