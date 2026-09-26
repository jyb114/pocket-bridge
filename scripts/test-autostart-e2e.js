// DSH 移动端网关 — 「DSH 未启动时自动拉起」端到端测试
//
// 这是那条链路的真正验证，而不是只看代码里写没写：
//   请求进来 → 目标端口没人监听 → 触发拉起 → 等待就绪 → 转发成功
//
// 为了不关掉正在运行的 DSH，测试用环境变量把目标指向一个「假 DSH」：
//   DSH_GW_TARGET_PORT  指向一个初始没人监听的端口
//   DSH_EXE / DSH_ARGS  指向能启动假 DSH 的解释器与脚本
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, accessKey, logFile] = process.argv;
const out = { ranAt: new Date().toISOString(), baseUrl };

function setCookiesOf(res) {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
}

(async () => {
  try {
    // ① 先用访问密钥换 cookie
    const r1 = await fetch(`${baseUrl}/k/${accessKey}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });
    const sc = setCookiesOf(r1);
    await r1.text();
    const cookie = sc.map((s) => s.split(';')[0]).join('; ');
    out.step1_gotCookie = cookie.length > 0;
    out.step1_status = r1.status;

    if (!cookie) {
      out.status = 'error';
      out.error = '拿不到会话 cookie，后续无法进行';
      fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
      return;
    }

    // ② 第一次访问首页 —— 目标端口没人，应当触发拉起并返回等待页
    const r2 = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    });
    const b2 = await r2.text();
    out.step2_status = r2.status;
    out.step2_isStartingPage = b2.includes('正在启动 DSH');
    out.step2_hasAutoRefresh = /http-equiv="refresh"/i.test(b2);

    // ③ 轮询等待被拉起的「DSH」就绪
    const deadline = Date.now() + 60000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await fetch(`${baseUrl}/`, {
          headers: { cookie },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000)
        });
        const b = await r.text();
        if (b.includes('FAKE-DSH-OK')) {
          out.step3_recovered = true;
          out.step3_waitedMs = attempt * 2000;
          out.step3_body = b.slice(0, 120);
          break;
        }
      } catch (err) {
        // 还在启动中，继续等
      }
    }
    if (out.step3_recovered !== true) {
      out.step3_recovered = false;
      out.step3_note = '60 秒内没等到被拉起的服务就绪';
    }

    out.status = 'ok';
    out.passed =
      out.step1_gotCookie &&
      out.step2_isStartingPage &&
      out.step2_hasAutoRefresh &&
      out.step3_recovered === true;
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
    out.stack = String(err.stack).slice(0, 400);
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
