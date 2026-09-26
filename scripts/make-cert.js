// DSH 移动端网关 — 内网 HTTPS 证书
//
// 为什么需要这个：
//
// 内网那条路一直是明文 HTTP。同一个 WiFi 下的任何设备都能嗅探到你在做什么 ——
// 这在实际使用里是个真问题（咖啡厅、合租、公司网络都算「同一个 WiFi」）。
// 安全审计里这一条一直是中危。
//
// 为什么是自己签：
//
// 受信任的证书要么得有自己的域名（内网 IP 签不了），要么得让手机装个描述文件。
// 这个项目从头到尾的前提是「手机零安装」，所以默认走自签 —— 代价是手机上会
// 出现一次证书警告，**这个代价必须说清楚，不能藏着**。
//
// 做法是本地建一个 CA，再用它签服务器证书。好处是：
//   - 你什么都不装：手机上点一次「继续访问」，之后就加密了（挡住被动嗅探）
//   - 你愿意装一次：把 tls/ca.crt 装到手机上，警告就彻底消失，
//     而且以后续期不用再装（CA 没变，签出来的新证书自动被信任）
//
// 为什么不用 openssl：Windows 上不一定有，装了也不一定在 PATH 里。
// X.509 的 DER 结构本身不复杂，直接按 RFC 5280 写字节反而更可靠 ——
// 而且生成完能立刻用 Node 自带的 X509Certificate 解析回来验证。
//
// 用法:
//   node scripts/make-cert.js            生成（已存在且没过期就跳过；快过期则续期）
//   node scripts/make-cert.js --force    全部重建（手机上装过的 CA 会失效）
//   node scripts/make-cert.js --show     显示指纹和 CA 文件位置（手机要装就用它）
//   node scripts/make-cert.js --check    校验现有证书是否可用
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const TLS_DIR = path.join(BASE, 'tls');

const CA_CERT = path.join(TLS_DIR, 'ca.crt');
const CA_KEY = path.join(TLS_DIR, 'ca.key');
const SRV_CERT = path.join(TLS_DIR, 'server.crt');
const SRV_KEY = path.join(TLS_DIR, 'server.key');
const META = path.join(TLS_DIR, 'cert-info.json');

// Apple 从 2020 年起要求受信任的服务器证书有效期不超过 398 天，
// 所以这里签 397 天 —— 装过 CA 的手机才不会因为「有效期太长」被拒绝信任。
const LEAF_DAYS = 397;
const CA_DAYS = 3650;
const RENEW_BEFORE_DAYS = 30;

// ── DER 编码 ──────────────────────────────────────────────────────────────────
//
// 只实现证书用得到的那几种类型。每个函数都对应 RFC 5280 里一个具体的产生式，
// 命名也照着来，方便对着规范核对。

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const setOf = (...items) => tlv(0x31, Buffer.concat(items));

/** INTEGER：最高位是 1 时要补一个 0x00，否则会被当成负数 */
function int(value) {
  let buf;
  if (Buffer.isBuffer(value)) buf = value;
  else {
    const hex = BigInt(value).toString(16);
    buf = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  }
  while (buf.length > 1 && buf[0] === 0 && !(buf[1] & 0x80)) buf = buf.slice(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

/** OBJECT IDENTIFIER：第一段和第一段按 40*a+b 合并 */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [];
    let v = p;
    do { stack.unshift(v & 0x7f); v >>>= 7; } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const bitStr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const octetStr = (buf) => tlv(0x04, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const boolean = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const ctxTag = (n, buf) => tlv(0xa0 | n, buf);

/** UTCTime：2050 年以前用两们年份（RFC 5280 的硬性要求） */
function time(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const body = y < 2050
    ? `${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
    : `${p(y, 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(y < 2050 ? 0x17 : 0x18, Buffer.from(body, 'ascii'));
}

/** Name ::= RDNSequence —— 这里只需要 CN，最多再加个 O */
function name(cn, org) {
  const rdns = [];
  if (org) rdns.push(setOf(seq(oid('2.5.4.10'), utf8(org))));   // O
  rdns.push(setOf(seq(oid('2.5.4.3'), utf8(cn))));              // CN
  return seq(...rdns);
}

const ALG_ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));       // 参数必须省略

/** Extension ::= SEQUENCE { extnID, critical DEFAULT FALSE, extnValue OCTET STRING } */
function ext(id, critical, value) {
  return seq(...[oid(id), critical ? boolean(true) : null, octetStr(value)].filter(Boolean));
}

/** subjectAltName：dNSName 是 [2] IA5String，iPAddress 是 [7] OCTET STRING */
function subjectAltName(dnsNames, ips) {
  const items = [];
  for (const d of dnsNames) {
    items.push(tlv(0x82, Buffer.from(d, 'ascii')));             // [2] primitive
  }
  for (const ip of ips) {
    const v6 = ip.includes(':');
    items.push(tlv(0x87, v6 ? ipv6ToBytes(ip) : Buffer.from(ip.split('.').map(Number)))); // [7]
  }
  return seq(...items);
}

/** 把 IPv6 字符串展开成 16 字节 */
function ipv6ToBytes(ip) {
  let s = String(ip).toLowerCase();
  // 去掉 zone id（fe80::1%eth0 这种）
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);

  const [head, tail] = s.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - h.length - t.length;
  const groups = [...h, ...new Array(Math.max(0, missing)).fill('0'), ...t];

  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

/** SPKI 里公钥位的 SHA-1，用作 keyIdentifier（RFC 5280 推荐做法） */
function keyIdentifier(spkiDer) {
  // 取 BIT STRING 里的实际公钥字节（跳过 tag/len/未用位数）
  let off = 0;
  const readLen = () => {
    let l = spkiDer[off++];
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let i = 0; i < n; i++) l = (l << 8) | spkiDer[off++];
    }
    return l;
  };
  off++; readLen();                       // 外层 SEQUENCE
  off++; readLen();                       // AlgorithmIdentifier
  off++; const blen = readLen();          // BIT STRING
  const bits = spkiDer.slice(off + 1, off + blen);   // 跳过「未用位数」那一字节
  return crypto.createHash('sha1').update(bits).digest();
}

/**
 * 生成一张证书。
 *
 * 自签（签自己）和签别人走的是同一套代码 —— 区别只在 issuer 填谁，
 * 所以 CA 与服务器证书共用一个函数，少一份可能写错的地方。
 */
function makeCert(opts) {
  const {
    subjectCn, subjectOrg,
    issuerCn, issuerOrg, issuerKey,
    publicKey, privateKey, days, isCa,
    dnsNames = [], ips = [], ski
  } = opts;

  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000); // 往前一天，容忍手机时钟偏差
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = ski || keyIdentifier(spki);

  const extensions = [];

  // basicConstraints：CA 为真、且带 pathLenConstraint 0（这张 CA 只能签终端证书）
  extensions.push(ext('2.5.29.19', true,
    isCa ? seq(boolean(true), int(0)) : seq()));

  // keyUsage：CA 用 keyCertSign+cRLSign；服务器证书用 digitalSignature+keyEncipherment
  extensions.push(ext('2.5.29.15', true,
    isCa ? bitStr(Buffer.from([0x06]))                        // keyCertSign(5) + cRLSign(6)
         : bitStr(Buffer.from([0xa0]))));                     // digitalSignature(0) + keyEncipherment(2)

  if (!isCa) {
    // extendedKeyUsage: serverAuth —— 明确这张证书只能当服务器证书用
    extensions.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    if (dnsNames.length || ips.length) {
      extensions.push(ext('2.5.29.17', false, subjectAltName(dnsNames, ips)));
    }
  }

  extensions.push(ext('2.5.29.14', false, octetStr(keyId)));       // subjectKeyIdentifier

  if (issuerKey && !isCa) {
    // authorityKeyIdentifier: [0] keyIdentifier
    // 注意这里要从**私钥**推出公钥 —— KeyObject 上没有 .publicKey 这个属性
    const issuerPub = crypto.createPublicKey(issuerKey);
    extensions.push(ext('2.5.29.35', false,
      seq(tlv(0x80, keyIdentifier(issuerPub.export({ type: 'spki', format: 'der' }))))));
  }

  const tbs = seq(
    ctxTag(0, int(2)),                                   // version v3
    int('0x' + crypto.randomBytes(8).toString('hex')),   // serialNumber
    ALG_ECDSA_SHA256,
    issuerCn ? name(issuerCn, issuerOrg) : name(subjectCn, subjectOrg),
    seq(time(notBefore), time(notAfter)),
    name(subjectCn, subjectOrg),
    spki,
    ctxTag(3, seq(...extensions))                        // extensions
  );

  const signer = issuerKey || privateKey;
  const signature = crypto.sign('sha256', tbs, signer);

  const der = seq(tbs, ALG_ECDSA_SHA256, bitStr(signature));
  const certPem = toPem(der, 'CERTIFICATE');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  return { der, certPem, keyPem };
}

function toPem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ── 本机有哪些地址可以写进证书 ────────────────────────────────────────────────
function localNames() {
  const dns = ['localhost', os.hostname(), `${os.hostname()}.local`];
  const ips = ['127.0.0.1', '::1'];

  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const a of ifaces[name] || []) {
        if (!a || a.internal) continue;
        if (!ips.includes(a.address)) ips.push(a.address);
        // mDNS 名字：iOS/Android 上 http://主机名.local 也能用
        const short = String(name).split(/[\s(]/)[0];
        if (short && !dns.includes(`${short}.local`)) dns.push(`${short}.local`);
      }
    }
  } catch (err) { /* 读不到就只用回环 */ }

  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

// ── 生成／校验／展示 ──────────────────────────────────────────────────────────

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (err) { return null; }
}

function certInfo(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return {
    subject: x.subject.replace(/\n/g, ' '),
    issuer: x.issuer.replace(/\n/g, ' '),
    validFrom: x.validFrom,
    validTo: x.validTo,
    fingerprint256: x.fingerprint256,
    subjectAltName: x.subjectAltName || '',
    isCa: /CA:TRUE/i.test(x.toString()) || x.ca === true
  };
}

function daysUntil(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return -9999;
  return Math.round((t - Date.now()) / 86400000);
}

/**
 * 品牌名只在这里写一次。
 *
 * 注意：改这个常量**不会**让已经装在手机上的 CA 失效 ——
 * 手机信任的是 ca.crt 本身（按指纹），不是它的名字。
 * 而且 renewLeaf() 会从磁盘上实际的 CA 读取 issuer（见下），
 * 所以就算名字改过，旧 CA 签出来的新叶子证书照样能通过链校验。
 */
const ORG = 'PocketBridge Gateway';
const CA_CN = 'PocketBridge 本地 CA';

/**
 * 从 X509Certificate.subject 字符串里取某个字段。
 *
 * Node 给出来的格式固定是每行 `KEY=VALUE`，用换行分隔，例如：
 *   "O=DSH Mobile Gateway\nCN=DSH 移动端网关 本地 CA"
 * 值里可能含逗号、斜杠、中文，所以不能按逗号切 —— 只能按行切。
 */
function subjectField(subject, key) {
  if (!subject) return undefined;
  for (const line of String(subject).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1);
  }
  return undefined;
}

function generate(opts = {}) {
  fs.mkdirSync(TLS_DIR, { recursive: true });

  const { dns, ips } = localNames();

  // CA
  const caKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ca = makeCert({
    subjectCn: CA_CN,
    subjectOrg: ORG,
    publicKey: caKeys.publicKey,
    privateKey: caKeys.privateKey,
    days: CA_DAYS,
    isCa: true
  });

  // 服务器证书，由上面这张 CA 签
  const srvKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const srv = makeCert({
    subjectCn: os.hostname(),
    subjectOrg: ORG,
    issuerCn: CA_CN,
    issuerOrg: ORG,
    issuerKey: caKeys.privateKey,
    publicKey: srvKeys.publicKey,
    privateKey: srvKeys.privateKey,
    days: LEAF_DAYS,
    isCa: false,
    dnsNames: dns,
    ips
  });

  fs.writeFileSync(CA_CERT, ca.certPem, 'utf8');
  fs.writeFileSync(CA_KEY, ca.keyPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(SRV_CERT, srv.certPem, 'utf8');
  fs.writeFileSync(SRV_KEY, srv.keyPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(META, JSON.stringify({
    generatedAt: new Date().toISOString(),
    leafDays: LEAF_DAYS,
    caDays: CA_DAYS,
    names: { dns, ips }
  }, null, 2), 'utf8');

  return { ca, srv, dns, ips };
}

/** 现有的服务器证书还能不能用？ */
function inspect() {
  const caPem = readIfExists(CA_CERT);
  const srvPem = readIfExists(SRV_CERT);
  const srvKey = readIfExists(SRV_KEY);
  if (!caPem || !srvPem || !srvKey) return { present: false };

  let ca, srv;
  try {
    ca = certInfo(caPem);
    srv = certInfo(srvPem);
  } catch (err) {
    return { present: true, broken: `证书解析失败: ${err.message}` };
  }

  const left = daysUntil(srv.validTo);
  return {
    present: true,
    ca, srv,
    daysLeft: left,
    needsRenew: left < RENEW_BEFORE_DAYS,
    expired: left <= 0
  };
}

/** 只续服务器证书，CA 不动 —— 这样手机上装过 CA 的话不用重装 */
function renewLeaf() {
  const caKeyPem = readIfExists(CA_KEY);
  const caPem = readIfExists(CA_CERT);
  if (!caKeyPem || !caPem) throw new Error('CA 不在了，得用 --force 全部重建');

  const caKey = crypto.createPrivateKey(caKeyPem);
  const caX = new crypto.X509Certificate(caPem);
  const { dns, ips } = localNames();

  // ★ issuer 必须来自磁盘上这张 CA 的真实 subject，不能写死常量。
  //
  // 写死会有个很隐蔽的 bug：如果 CA 是旧版本签的（比如项目改名前叫别的名字），
  // 新叶子证书的 issuer 就和 CA 的 subject 对不上。
  // 桌面浏览器通常不计较，但 iOS/Android 的链校验会直接拒绝 ——
  // 表现是「昨天还能用，续期之后手机突然连不上了」。
  // 从 CA 里读就永远不会错。
  const issuerCn = subjectField(caX.subject, 'CN') || CA_CN;
  const issuerOrg = subjectField(caX.subject, 'O') || ORG;

  const srvKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const srv = makeCert({
    subjectCn: os.hostname(),
    subjectOrg: ORG,
    issuerCn,
    issuerOrg,
    issuerKey: caKey,
    publicKey: srvKeys.publicKey,
    privateKey: srvKeys.privateKey,
    days: LEAF_DAYS,
    isCa: false,
    dnsNames: dns,
    ips
  });

  fs.writeFileSync(SRV_CERT, srv.certPem, 'utf8');
  fs.writeFileSync(SRV_KEY, srv.keyPem, { encoding: 'utf8', mode: 0o600 });

  const meta = (() => { try { return JSON.parse(readIfExists(META)); } catch (err) { return {}; } })();
  fs.writeFileSync(META, JSON.stringify(Object.assign(meta, {
    renewedAt: new Date().toISOString(),
    names: { dns, ips }
  }), null, 2), 'utf8');

  return { srv, dns, ips, caSubject: caX.subject };
}

/** 确保有可用的证书；需要时自动续期。返回 {ok, cert, key, reason} */
function ensure() {
  const st = inspect();
  if (!st.present) {
    generate();
    return ensure();
  }
  if (st.broken) throw new Error(st.broken);
  if (st.expired || st.needsRenew) {
    renewLeaf();
    return ensure();
  }
  // DHCP 换了内网 IPv4 时，旧叶子证书仍在有效期内，却会因为 SAN
  // 不含新地址而让手机报名称不匹配。只重签服务器证书即可，CA 不变，
  // 已经在手机上信任过的 CA 也无需重装。
  const verified = verify();
  if (verified.problems && verified.problems.some((p) => /^SAN 里缺少这些地址:/.test(p))) {
    renewLeaf();
    return ensure();
  }
  return {
    ok: true,
    cert: readIfExists(SRV_CERT),
    key: readIfExists(SRV_KEY),
    ca: readIfExists(CA_CERT),
    daysLeft: st.daysLeft,
    info: st
  };
}

// ── 对外的用法 ────────────────────────────────────────────────────────────────

function verify() {
  const problems = [];
  const notes = [];   // 提示，不算故障
  const st = inspect();
  if (!st.present) { problems.push('证书文件不齐'); return { ok: false, problems }; }
  if (st.broken) { problems.push(st.broken); return { ok: false, problems }; }

  // 能不能被 Node 当证书加载
  let caX, srvX;
  try {
    caX = new crypto.X509Certificate(readIfExists(CA_CERT));
    srvX = new crypto.X509Certificate(readIfExists(SRV_CERT));
  } catch (err) {
    problems.push(`解析失败: ${err.message}`);
    return { ok: false, problems };
  }

  if (!caX.ca) problems.push('CA 证书上的 basicConstraints 没标成 CA');

  // 服务器证书必须真的是这张 CA 签的 —— 这是整套信任链的根
  try {
    if (!srvX.verify(caX.publicKey)) problems.push('服务器证书不是这张 CA 签的（信任链断了）');
  } catch (err) {
    problems.push(`验签失败: ${err.message}`);
  }

  // 每一台手机可能用的地址都得在 SAN 里，否则浏览器会报「名称不匹配」而不是「自签证书」。
  //
  // 但**公网 IPv6 地址不能算作「缺失」**：运营商给的那一串（2409:… 之类）
  // 每隔几小时就换一次，证书永远追不上 —— 把它当故障报，只会让人以为坏了，
  // 而实际上手机走 IPv4 或 mDNS 名字访问一切正常。
  //
  // 所以分两类：
  //   - 稳定地址（回环、内网 IPv4、主机名、.local）→ 缺了就报故障
  //   - 会变的公网 IPv6 → 缺了只当提示，并顺手触发一次续签去补上
  const { dns, ips } = localNames();
  const isVolatileV6 = (ip) =>
    /:/.test(ip) && ip !== '::1' && !/^fe80:/i.test(ip) && !/^f[cd]/i.test(ip);

  const missing = [];
  const volatileMissing = [];
  for (const ip of ips) {
    if (srvX.checkIP(ip)) continue;
    (isVolatileV6(ip) ? volatileMissing : missing).push(ip);
  }
  for (const d of dns) {
    if (!srvX.checkHost(d)) missing.push(d);
  }
  if (missing.length) problems.push(`SAN 里缺少这些地址: ${missing.join(', ')}`);
  // 公网 IPv6 缺失只是提示，不算故障 —— 那串地址是运营商轮换的，
  // 追不上是正常的。手机走 IPv4 / mDNS 名字访问不受影响。
  if (volatileMissing.length) {
    notes.push(`公网 IPv6 未在证书里（地址会变，正常）: ${volatileMissing.length} 个`);
  }

  if (st.expired) problems.push('服务器证书已过期');
  else if (st.needsRenew) problems.push(`服务器证书 ${st.daysLeft} 天后过期，该续了`);

  return { ok: problems.length === 0, problems, notes, status: st, ca: caX, srv: srvX };
}

module.exports = {
  ensure, generate, renewLeaf, inspect, verify, localNames,
  TLS_DIR, CA_CERT, CA_KEY, SRV_CERT, SRV_KEY, META,
  makeCert, toPem, ipv6ToBytes, keyIdentifier,
  LEAF_DAYS, CA_DAYS, RENEW_BEFORE_DAYS
};

// ── 命令行 ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const has = (f) => process.argv.includes(f);
  console.log('\nDSH 移动端网关 — 内网 HTTPS 证书\n' + '='.repeat(64) + '\n');

  if (has('--show') || has('--check')) {
    const r = verify();
    const st = r.status;
    if (!st || !st.present) {
      console.log('  还没有证书。跑 node scripts/make-cert.js 生成。\n');
      process.exitCode = 1;
    } else {
      console.log(`  服务器证书主体 : ${st.srv.subject}`);
      console.log(`  签发者         : ${st.srv.issuer}`);
      console.log(`  有效期至       : ${st.srv.validTo}（还剩 ${st.daysLeft} 天）`);
      console.log(`  覆盖的地址     : ${st.srv.subjectAltName.replace(/DNS:|IP Address:/g, ' ').trim()}`);
      console.log('');
      console.log(`  CA 指纹(sha256): ${st.ca.fingerprint256}`);
      console.log(`  CA 文件        : ${CA_CERT}`);
      console.log('');
      console.log(r.ok ? '  校验通过：证书可用、信任链完整、地址齐全\n'
        : `  有问题：\n${r.problems.map((p) => '    · ' + p).join('\n')}\n`);
      if (!r.ok) process.exitCode = 1;
    }
    return;
  }

  if (has('--force')) {
    generate();
    console.log('  已全部重建（包括 CA）。');
    console.log('  注意：手机上如果装过旧的 CA，需要重新装一次。\n');
    process.exitCode = 0;
    return;
  }

  const before = inspect();
  if (!before.present) {
    generate();
    console.log('  已生成 CA 与服务器证书。');
  } else if (before.broken) {
    console.log(`  现有证书有问题（${before.broken}），重新生成。`);
    generate();
  } else if (before.expired || before.needsRenew) {
    renewLeaf();
    console.log(`  服务器证书${before.expired ? '已过期' : '快过期'}，已续期（CA 没动，手机上装过的话不用重装）。`);
  } else {
    const checked = verify();
    if (checked.problems && checked.problems.some((p) => /^SAN 里缺少这些地址:/.test(p))) {
      renewLeaf();
      console.log('  内网地址已变化，已重签服务器证书（CA 没动，手机上装过的话不用重装）。');
    } else {
      console.log(`  已有可用证书，还剩 ${before.daysLeft} 天，跳过。`);
    }
  }

  const r = verify();
  if (r.ok) {
    console.log(`  有效期至 ${r.status.srv.validTo}`);
    console.log(`  覆盖地址 ${r.status.srv.subjectAltName.replace(/DNS:|IP Address:/g, ' ').trim()}`);
    console.log('\n  手机上第一次打开内网 HTTPS 会看到证书警告 —— 那是自签证书的正常表现，');
    console.log('  选「继续访问」即可（之后就加密了）。想彻底不看到警告的话，');
    console.log(`  把 ${CA_CERT} 装到手机上信任一次。\n`);
  } else {
    console.log(`\n  校验没通过：\n${r.problems.map((p) => '    · ' + p).join('\n')}\n`);
    process.exitCode = 1;
  }
}
