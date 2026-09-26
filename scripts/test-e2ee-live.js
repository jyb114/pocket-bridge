// 端到端：启用加密后，隧道里到底能不能看到内容？
//
// 这是整个方案的核心验证。做法：
//   1. 带 #k=<密钥> 打开工作台 —— 浏览器会自动启用加密
//   2. 从网关日志里抓「WS 手机→DSH」那几行
//   3. **在那些字节里找明文关键词** —— 找到就说明加密没生效
//
// 不能只看「有没有报错」：加密没生效时功能照样正常，
// 只是内容在隧道里明晃晃地流过去。所以要**直接检查字节**。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const LOG = path.join(__dirname, '..', 'logs', 'proxy.log');
const SECRET_FILE = path.join(__dirname, '..', 'logs', 'e2ee-secret.txt');
const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 启用加密后：隧道里看到的是什么 ===\n');

  let secret = null;
  try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { }
  if (!secret) { console.log('  没有长期密钥，跳过（先跑一次生成）\n'); process.exitCode = 1; return; }
  console.log(`  长期密钥: ${secret.slice(0, 6)}…（长度 ${secret.length}）`);

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  // 记下日志位置：后面只分析**这一轮自己产生**的流量。
  // 不划窗口的话，别人（比如使用者手机）同时在跑的明文连接会被算进来。
  const logOffset = (() => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } })();

  try {
    // 关键：走内网加密那条路（crypto.subtle 要安全上下文），并且**带上 #密钥**
    //
    // ★ 内网 IP 必须**现探测**，不能写死。
    //   原来这里写的是 192.168.1.3 —— 后来这台机器的 DHCP 把地址换成了 .4，
    //   于是整个测试连的是一个不存在的地址，报出来却是
    //   「浏览器端检测到密钥并启用了加密 ✗ {hasModule:false...}」：
    //   看着像加密坏了，其实连页面都没打开。
    //   测网络的脚本去写死网络地址，本身就不该。
    const lanIp = (() => {
      try {
        const v4 = require('./config.js').detectNetwork().lanV4;
        return v4.length ? v4[0].address : '127.0.0.1';
      } catch (err) { return '127.0.0.1'; }
    })();
    let httpsPort = 0;
    try {
      httpsPort = Number(fs.readFileSync(path.join(__dirname, '..', 'logs', 'https-port.txt'), 'utf8').trim());
    } catch (e) { }
    if (!httpsPort) {
      console.log('  内网 HTTPS 没开（读不到 https-port.txt），这条验不了\n');
      process.exitCode = 1;
      return;
    }
    const origin = `https://${lanIp}:${httpsPort}`;
    console.log(`  入口: ${origin}`);

    await p.send('Security.setIgnoreCertificateErrors', { ignore: true });
    await p.goto(`${origin}/k/${key}`, 200);
    await p.goto(`${origin}/?target=dsh#k=${secret}`, 4000);

    // 浏览器有没有真的启用加密
    const state = await p.eval(`({
      hasModule: typeof window.DshE2EE !== 'undefined',
      available: window.DshE2EE ? window.DshE2EE.available() : false,
      enabled: window.__dshE2eeOn === true,
      wsPatched: !!(window.WebSocket && window.WebSocket.__dshE2ee),
      hashCleared: !/[#&]k=/.test(location.hash)
    })`);
    console.log(`      模块=${state.hasModule} 可用=${state.available} 已启用=${state.enabled} WS已接管=${state.wsPatched}`);
    ok('浏览器端检测到密钥并启用了加密', state.enabled === true && state.wsPatched === true,
      JSON.stringify(state));
    // ★ 这条断言 2026-09-23 就反过来了，这里是**补上**（当时只改了另一个测试）。
    //
    //   原来要求「把 #k= 从地址栏抹掉，防别人瞄屏幕」。那个行为被**故意取消**：
    //   「添加到主屏幕」和书签保存的都是**当时的地址**，抹掉之后存下来的没有钥匙，
    //   点开永远是未加密 / 打不开。
    //   现在要求的是：钥匙**留在地址里**，而且**这台设备要记住它** ——
    //   因为 iOS 存主屏图标时会把 # 片段丢掉（2026-09-24 实测：
    //   图标打开后 `WS 被拒：经中继但没要求加密`，什么任务都看不到）。
    const state2 = await p.eval(`({
      hashKept: /[#&]k=/.test(location.hash),
      persisted: !!localStorage.getItem('dsh-e2ee-secret-persist-v1'),
      source: window.DshE2EE && window.DshE2EE.secretSource ? window.DshE2EE.secretSource() : null
    })`);
    ok('密钥留在地址栏里（抹掉会让书签和主屏图标永久失效）', state2.hashKept === true, JSON.stringify(state2));
    ok('这台设备也记住了钥匙（主屏图标会丢掉 #片段，靠它才还能加密）',
      state2.persisted === true && state2.source === 'url', JSON.stringify(state2));

    // 页面还得能正常工作 —— 加密不能把功能搞坏
    await new Promise((r) => setTimeout(r, 6000));
    const alive = await p.eval(`({
      loaded: document.body.innerText.length > 200,
      badge: !!document.getElementById('dsh-gw-badge')
    })`);
    ok('加密开着的时候工作台仍然可用', alive.loaded === true, JSON.stringify(alive));

    // ── 核心：直接检查隧道里流过的字节 ──────────────────────────
    console.log('\n  ── 检查网关日志里的实际字节 ──');

    // 只读本轮窗口内的日志
    let recentText = '';
    try {
      const fd = fs.openSync(LOG, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.max(0, size - logOffset);
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, logOffset);
      fs.closeSync(fd);
      recentText = buf.toString('utf8');
    } catch (e) { recentText = ''; }

    const wsLines = recentText.split('\n')
      .filter((l) => /WS (手机→DSH|DSH→手机|手机→Codex|Codex→手机)/.test(l));
    console.log(`      本轮窗口内的双向帧日志: ${wsLines.length} 行`);

    // 明文关键词：这些词如果在**载荷**里出现，说明没加密。
    //
    // 注意只检查载荷部分 —— 日志行前面那段是网关自己写的标签
    // （"WS 手机→DSH 152B op=0x2"），里面有 "DSH" 这类词，属于误报来源。
    // 握手那一行也要跳过：那是 HTTP 响应头，本来就不是内容，也没什么可保密的。
    const probes = ['thread', 'jsonrpc', 'result', 'method', 'params', 'agentMessage', '"type"', '"value"'];
    const leaked = [];
    const payloadLines = wsLines.filter((l) => {
      if (/Switching Protocols/.test(l)) return false;          // 握手响应，跳过
      const m = l.match(/op=0x([0-9a-f])/i);
      return m && m[1] === '2';                                  // 只看二进制帧（= 密文）
    });

    for (const l of payloadLines) {
      const body = l.replace(/^.*?op=0x[0-9a-f]\s*/i, '');
      for (const w of probes) {
        if (body.includes(w)) leaked.push(`${w} ← ${body.slice(0, 60)}`);
      }
    }

    console.log(`      加密后的二进制帧: ${payloadLines.length} 行（这些就是隧道会看到的样子）`);
    if (payloadLines.length === 0) {
      ok('隧道里看到的是二进制密文', false, '没有二进制帧样本');
    } else {
      ok('隧道里看到的是二进制密文（op=0x2）', true);
      ok('密文里找不到任何明文关键词', leaked.length === 0, leaked.slice(0, 3).join(' ｜ '));
    }

    // ★ 真正的核心不变量：加密开着的时候，**一个可读的明文帧都不该有**。
    //
    // 上面那两条只检查「二进制帧里没有明文关键词」—— 那是**结构上抓不到**
    // 明文帧的：明文帧是 op=0x1，早被 payloadLines 的过滤器排除了。
    // 也就是说加密漏了一半也照样全绿。这个洞是被一次真实的误判暴露的：
    // 网关日志当时记的是**加密之前**的明文，看着像「下行完全没加密」，
    // 而测试全绿、毫无提示。补上这条才算真的验了。
    const readable = wsLines.filter((l) => {
      if (/Switching Protocols/.test(l)) return false;
      const m = l.match(/op=0x([0-9a-f])/i);
      if (!m || m[1] !== '1') return false;
      return /"type"\s*:|"jsonrpc"\s*:|"value"\s*:/.test(l);
    });
    ok('加密模式下没有任何可读的明文帧（双向）', readable.length === 0,
      readable.length ? readable.slice(0, 2).map((l) => l.trim().slice(0, 100)).join(' ｜ ')
        : `${wsLines.length} 行里一条可读的都没有`);

    // 两个方向都得真的有密文 —— 只加一个方向等于没加
    const down = payloadLines.filter((l) => /DSH→手机|Codex→手机/.test(l)).length;
    const up = payloadLines.filter((l) => /手机→DSH|手机→Codex/.test(l)).length;
    console.log(`      方向分布: 电脑→手机 ${down} 帧   手机→电脑 ${up} 帧`);
    ok('电脑→手机方向有密文', down > 0, String(down));
    ok('手机→电脑方向有密文', up > 0, String(up));

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
