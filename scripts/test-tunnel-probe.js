// 隧道可达性探测 —— 计划 E「区分进程存活 / 公网可达」的验收测试。
//
// 背景：判断隧道好不好，原来的做法是查「cloudflared 进程在不在」。
// 那远远不够 —— 免费快速隧道的域名会被 Cloudflare **回收**：进程还活着、
// 日志里地址还在，域名却已经指向空气，手机怎么都打不开。
// 实测栽过两次：守护进程连着二十多分钟报「隧道已在运行」，地址是死的，
// 只有人工重建才恢复，手机上的旧外网入口也会失效。
//
// 这个测试**不碰使用者的隧道**：只做探测，不重建、不停、不改配置。
// 「探测一个死地址会判不通」用一个确定不存在的域名来验，不牺牲真的那条。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const tunnel = require('./tunnel.js');

const PORT = Number(process.env.DSH_GW_PORT || 8080);

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

function getJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (err) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'status.json'), 'utf8')); }
  catch (err) { return null; }
}

(async () => {
  console.log('\n=== 隧道可达性探测 ===\n');

  const status = readStatus();
  const liveUrl = status && status.tunnel && status.tunnel.url;

  // ── 1. 死地址必须判成「不通」 ─────────────────────────────────────────────
  //
  // 这是整件事的核心：原来的判据只会说「进程在跑」。如果探测器连死地址
  // 都判成通，那它一点用都没有，还会让人以为一切正常。
  console.log('[1] 死地址');
  const dead = await tunnel.probeUrl('https://definitely-not-a-real-tunnel-xyz9.trycloudflare.com', 15000);
  ok('不存在的域名 → 判不通', dead.ok === false, `${dead.error || dead.status}`);
  ok('给出了原因（不是空错误）', !!dead.error || dead.status >= 500, JSON.stringify(dead));

  const bad = await tunnel.probeUrl('not-a-url', 5000);
  ok('非法地址 → 判不通且不抛异常', bad.ok === false && !!bad.error, JSON.stringify(bad));

  // ── 2. 活地址必须判成「通」 ───────────────────────────────────────────────
  //
  // 反方向同样重要：**误判成不通的后果不是少报一次，是两轮之后真的去重建、
  // 把使用者的地址换掉**。（写这个探测时就踩过一次：用 http 去连 https，
  // 结果每条健康隧道都被判成不可达。跑了一次才暴露。）
  console.log('\n[2] 活地址');
  if (!liveUrl) {
    console.log('  · status.json 里没有隧道地址，跳过（可能没配隧道）');
  } else {
    const live = await tunnel.probeUrl(liveUrl, 20000);
    ok('当前隧道地址 → 判得通', live.ok === true, `${live.status} ${live.ms}ms ${live.error || ''}`);
    ok('耗时是真实数字', typeof live.ms === 'number' && live.ms > 0, String(live.ms));
  }

  // ── 3. 三个状态在数据里是分开的 ───────────────────────────────────────────
  //
  // 「进程在不在」和「公网通不通」必须是两个字段。合并成一个布尔值的话，
  // 界面就只能写「已配置 · 可达性未验证」—— 那句话等于什么都没说。
  console.log('\n[3] 状态字段');
  if (!status || !status.tunnel) {
    console.log('  · 读不到 status.json，跳过');
  } else {
    ok('tunnel.running 存在（进程存活）', typeof status.tunnel.running === 'boolean', String(status.tunnel.running));
    ok('tunnel.reachable 是独立字段（公网可达）',
      status.tunnel.reachable === null || typeof status.tunnel.reachable === 'boolean',
      String(status.tunnel.reachable));
    ok('两者不是同一个值硬凑的', 'reachable' in status.tunnel);
  }

  // ── 4. 界面真的拿得到这两个状态 ───────────────────────────────────────────
  //
  // 网关原来只把 url 和 provider 透给界面，把 running / reachable 丢掉了 ——
  // 数据在 status.json 里、界面却看不见，等于没做。
  console.log('\n[4] 控制台接口');
  const con = await getJson(PORT, '/__console/status');
  if (con.status !== 200 || !con.json) {
    console.log(`  · 控制台接口不可用（${con.status}），跳过`);
  } else {
    const tt = con.json.tunnel || {};
    ok('接口给出了 tunnel.running', typeof tt.running === 'boolean', String(tt.running));
    ok('接口给出了 tunnel.reachable', tt.reachable === null || typeof tt.reachable === 'boolean', String(tt.reachable));
  }

  // ── 5. 「不因为一次抖动就换地址」的闸门还在 ───────────────────────────────
  //
  // 这条是**策略回归检查**：读源码确认门槛还在。之所以只能这么做 ——
  // 真去验它得让隧道真的不通，而那会把使用者的隧道弄坏。
  //
  // 为什么这道闸门要紧：免费隧道一重建就换地址，手机书签当场失效。
  // 网络抖一下（地铁、切 Wi-Fi）就重建的话，使用者会莫名其妙地连不上。
  console.log('\n[5] 抗抖动闸门');
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'gateway-daemon.js'), 'utf8');
  // 断言守的是**意图**（不能一抖就换地址），不是某个具体数字。
  //
  //  这里原来钉死 /fails < 2/。后来发现 2 太小：一晚上因此换了 8 次地址，
  //  使用者的书签一直在失效（短暂不通会自己恢复，换地址却是永久代价）。
  //  阈值调到 5 之后这条断言就红了 —— 而它红得没道理：被破坏的不是
  //  「抗抖动」这个性质，只是数字变了。改成把数字抠出来要求「至少 3」，
  //  以后调参不再误报；但真把闸门去掉（或调回 1）照样会红。
  const gate = src.match(/fails\s*<\s*(\d+)/);
  ok('连续失败才重建，且门槛足够高（>=3）',
    !!gate && Number(gate[1]) >= 3,
    gate ? `门槛是 ${gate[1]}` : '源码里找不到这个门槛');
  // 抖动静默应该在**计数之前**就被吸收掉，否则门槛再高也只是拖延
  ok('计数之前会先就地重试（抖动不该算一次失败）',
    /probeTunnelUrl/.test(src) && /隧道探测第/.test(src));
  ok('重建前会先把失败计数读出来（跨进程记）', /PROBE_STATE_FILE/.test(src) && /readProbeState/.test(src));
  ok('重建成功后会清零计数', /writeProbeState\(\{\s*fails:\s*0/.test(src));

  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
