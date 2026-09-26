// DSH 移动端网关 — 自动选路端到端测试
//
// 验证的是「手机能不能自己挑一条通的路」这件事，所以每一项都发真实 HTTP 请求，
// 不看内部函数返回值。
//
// 用法: node scripts/test-routes.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEY = fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function req(method, p, opts = {}) {
  return new Promise((resolve) => {
    const headers = Object.assign({}, opts.headers);
    // 用真实内网地址当 Host，模拟手机从内网进来
    if (opts.host) headers.host = opts.host;
    const r = http.request({
      host: '127.0.0.1', port: opts.port || PORT, method, path: p, headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end(opts.body);
  });
}

(async () => {
  console.log('\n=== 自动选路 · 端到端测试 ===\n');

  // ── 1. 探针必须免认证，否则手机没法在登录前测路 ────────────────────────────
  console.log('[1] 连通性探针 /__probe');
  const probe = await req('GET', '/__probe');
  ok('免认证返回 204', probe.status === 204, `实际 ${probe.status}`);
  ok('不返回任何内容', (probe.body || '').length === 0, `长度 ${(probe.body || '').length}`);
  ok('带 CORS 头（跨域探测需要）',
    String(probe.headers['access-control-allow-origin'] || '') === '*',
    JSON.stringify(probe.headers['access-control-allow-origin']));

  // ── 2. /__routes 必须认证后可见（候选里含密钥）─────────────────────────────
  console.log('\n[2] 路径分析 /__routes 的访问控制');
  const noAuth = await req('GET', '/__routes');
  ok('未认证被拒绝', noAuth.status === 403, `实际 ${noAuth.status}`);

  const withKey = await req('GET', `/k/${KEY}`);
  const cookie = String(withKey.headers['set-cookie'] || '').split(';')[0];
  ok('密钥入口种下 cookie', cookie.length > 10, cookie);

  const routes = await req('GET', '/__routes', { headers: { cookie } });
  ok('认证后返回 200', routes.status === 200, `实际 ${routes.status}`);

  let data = null;
  try { data = JSON.parse(routes.body); } catch (err) { }
  ok('返回可解析的 JSON', !!data);
  if (!data) { console.log(`\n失败 ${fail} 项\n`); process.exitCode = 1; return; }

  // ── 3. 分析结果的结构与内容 ────────────────────────────────────────────────
  console.log('\n[3] 分析结果');
  ok('识别出这次请求从哪条路进来', !!data.arrival && !!data.arrival.kind,
    JSON.stringify(data.arrival));
  console.log(`      识别为: ${data.arrival.label}（${data.arrival.detail}）`);
  console.log(`      来源地址: ${data.arrival.clientIp}  协议: ${data.arrival.scheme}`);

  ok('列出了候选路径', Array.isArray(data.candidates) && data.candidates.length > 0,
    `${(data.candidates || []).length} 条`);
  for (const c of data.candidates || []) {
    console.log(`      · ${c.label.padEnd(14)} ${c.kind.padEnd(7)} ${c.origin}`);
  }

  ok('给了结论（advice）', typeof data.advice === 'string' && data.advice.length > 5);
  console.log(`      结论: ${data.advice}`);

  ok('标注了从 https 页面探测不到的候选（混合内容）',
    Array.isArray(data.mixedContentBlocked) && Array.isArray(data.probeable));

  // 关键：loopback 进来时 scheme 是 http，所以内网候选应该都在可探测列表里
  const lanCands = (data.candidates || []).filter((c) => c.kind === 'lan');
  if (lanCands.length) {
    ok('内网候选被标为「https 页面探测不到」',
      lanCands.every((c) => c.probeableFromHttps === false));
    ok('内网候选在本页（http）可探测',
      lanCands.every((c) => data.probeable.includes(c.id)));
  }

  // ── 4. 换路径票据 ─────────────────────────────────────────────────────────
  console.log('\n[4] 换路径票据');
  const v6 = (data.candidates || []).find((c) => c.kind === 'ipv6');
  const target = v6 || (data.candidates || []).find((c) => c.kind === 'lan');

  if (!target) {
    console.log('      · 没有可用于切换的候选，跳过');
  } else {
    const sw = await req('GET', `/__switch?to=${encodeURIComponent(target.id)}`,
      { headers: { cookie } });
    ok('认证后能申请到票据', sw.status === 200, `实际 ${sw.status}`);

    let swj = null;
    try { swj = JSON.parse(sw.body); } catch (err) { }
    ok('票据返回了一个可跳转的地址', !!(swj && swj.ok && swj.url), sw.body.slice(0, 200));

    const noAuthSw = await req('GET', `/__switch?to=${encodeURIComponent(target.id)}`);
    ok('未认证申请不到票据', noAuthSw.status === 403, `实际 ${noAuthSw.status}`);

    if (swj && swj.url) {
      const ticketPath = new URL(swj.url).pathname;
      ok('票据地址走的是 /t/ 而不是把密钥写进去',
        ticketPath.startsWith('/t/') && !swj.url.includes(KEY),
        swj.url);

      // 票据必须只在「它指明的那个地址」上能兑换
      const wrongHost = await req('GET', ticketPath, { host: '127.0.0.1:9999' });
      ok('换个 Host 兑换被拒（票据绑定地址）', wrongHost.status === 403,
        `实际 ${wrongHost.status}`);

      // 正确地址兑换
      const rightHost = await req('GET', ticketPath,
        { host: target.authority });
      ok('指定地址兑换成功', rightHost.status === 200, `实际 ${rightHost.status}`);
      ok('兑换后种下会话 cookie',
        String(rightHost.headers['set-cookie'] || '').includes('='),
        JSON.stringify(rightHost.headers['set-cookie']));

      // 一次性：再来一次必须失败
      const again = await req('GET', ticketPath, { host: target.authority });
      ok('同一张票据不能用第二次', again.status === 403, `实际 ${again.status}`);
    }

    // 伪造签名
    const fake = await req('GET', '/t/eyJhIjoieCIsImUiOjk5OTk5OTk5OTk5OTl9.AAAA',
      { host: target.authority });
    ok('伪造签名的票据被拒', fake.status === 403, `实际 ${fake.status}`);
  }

  // ── 5. 选择页 ─────────────────────────────────────────────────────────────
  console.log('\n[5] 选择页 /go');
  const goNoAuth = await req('GET', '/go');
  ok('未认证打不开（页面里会带出候选地址）', goNoAuth.status === 403, `实际 ${goNoAuth.status}`);
  const go = await req('GET', '/go', { headers: { cookie } });
  ok('认证后返回 200', go.status === 200, `实际 ${go.status}`);
  ok('页面里有探测与切换逻辑',
    go.body.includes('/__routes') && go.body.includes('/__switch'));

  // ── 6. 注入脚本 ───────────────────────────────────────────────────────────
  console.log('\n[6] 页面注入');
  const rj = await req('GET', '/route.js');
  ok('route.js 可获取', rj.status === 200, `实际 ${rj.status}`);
  ok('route.js 是脚本且不乱缓存',
    String(rj.headers['content-type'] || '').includes('javascript') &&
    String(rj.headers['cache-control'] || '').includes('no-cache'),
    `${rj.headers['content-type']} / ${rj.headers['cache-control']}`);

  // ── 7. 三种进入方式的识别 ──────────────────────────────────────────────────
  //
  // 这是整套逻辑的核心：同一条服务，手机可能从内网、从隧道、从 IPv6 进来，
  // 服务端必须认得出，才能给出不同的建议。
  console.log('\n[7] 识别手机从哪条路进来');
  const routesMod = require('./routes.js');
  const netInfo = require('./config.js').detectNetwork();

  const cases = [
    {
      name: '内网地址进来',
      headers: { host: `${netInfo.lanV4[0] ? netInfo.lanV4[0].address : '192.168.1.3'}:${PORT}` },
      expect: 'lan'
    },
    {
      name: '隧道域名进来（Cloudflare 会带 x-forwarded-proto）',
      headers: {
        host: 'stewart-epinions-holding-tel.trycloudflare.com',
        'x-forwarded-proto': 'https',
        'cf-connecting-ip': '1.2.3.4'
      },
      expect: 'tunnel'
    },
    {
      name: '回环进来',
      headers: { host: `127.0.0.1:${PORT}` },
      expect: 'loopback'
    }
  ];

  if (netInfo.publicV6[0]) {
    cases.push({
      name: '公网 IPv6 进来',
      headers: { host: `[${netInfo.publicV6[0].address}]:${PORT}` },
      expect: 'ipv6'
    });
  }

  for (const c of cases) {
    const fakeReq = { headers: c.headers, socket: { remoteAddress: '9.9.9.9' } };
    const a = routesMod.arrivalOf(fakeReq, netInfo);
    ok(`${c.name} → ${c.expect}`, a.kind === c.expect, `实际 ${a.kind}`);
  }

  // 隧道进来时，浏览器拦混合内容这件事必须被如实标注出来
  const tunnelReq = {
    headers: {
      host: 'stewart-epinions-holding-tel.trycloudflare.com',
      'x-forwarded-proto': 'https', 'cf-connecting-ip': '1.2.3.4'
    },
    socket: { remoteAddress: '9.9.9.9' }
  };
  const viaTunnel = await routesMod.recommend(tunnelReq, {
    port: PORT, key: KEY, netInfo,
    tunnelUrl: 'https://stewart-epinions-holding-tel.trycloudflare.com',
    ipv6Listening: true
  });
  ok('隧道进来 → scheme 认成 https', viaTunnel.arrival.scheme === 'https',
    viaTunnel.arrival.scheme);
  ok('隧道进来 → 内网候选被列入「探测不到」',
    viaTunnel.mixedContentBlocked.length >= 1,
    JSON.stringify(viaTunnel.mixedContentBlocked));
  ok('隧道进来 → 可探测列表里只剩隧道',
    viaTunnel.probeable.every((id) => id.startsWith('tunnel-')),
    JSON.stringify(viaTunnel.probeable));

  // 同一出口 = 同一个网络。这是「你其实在家」的判断依据。
  console.log('\n[8] 同网络判断（决定要不要提示你切内网）');
  const egress = { ipv4: '203.0.113.7', ipv6: null };
  ok('出口 IP 相同 → 判定同网络',
    routesMod.sameNat({ clientIp: '203.0.113.7' }, egress) === true);
  ok('出口 IP 不同 → 不判定',
    routesMod.sameNat({ clientIp: '198.51.100.9' }, egress) === false);
  ok('手机就是从内网来的（私网地址）→ 不参与该判断',
    routesMod.sameNat({ clientIp: '192.168.1.20' }, egress) === false);
  ok('拿不到自己的出口 IP 时不瞎猜',
    routesMod.sameNat({ clientIp: '203.0.113.7' }, { ipv4: null }) === false);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
