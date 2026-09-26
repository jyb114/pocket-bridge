// DSH 移动端网关 — 兼容补丁自测
//
// 手法同 Iterator 那次：先删掉 Node 的原生实现来模拟老 Safari，
// 再加载 compat.js，然后逐项验证行为。不这么做的话，补丁会因为
// 「检测到已有原生实现」而跳过，测了等于没测。
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'logs', 'test-compat.json');
const out = { ranAt: new Date().toISOString() };

// 要模拟缺失的 API 清单
const TARGETS = ['any', 'timeout', 'abort'];

try {
  const removed = [];
  for (const name of TARGETS) {
    if (typeof AbortSignal[name] === 'function') {
      try { delete AbortSignal[name]; removed.push(name); } catch (err) { }
    }
  }
  out.removedNatives = removed;
  out.simulatedLegacy =
    typeof AbortSignal.any !== 'function' && typeof AbortSignal.timeout !== 'function';

  if (!out.simulatedLegacy) {
    out.status = 'skipped';
    out.reason = '删不掉原生实现，无法模拟老环境';
  } else {
    const code = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'compat.js'), 'utf8');
    (0, eval)(code);

    out.afterPolyfill = {
      any: typeof AbortSignal.any,
      timeout: typeof AbortSignal.timeout,
      abort: typeof AbortSignal.abort,
      hasOwn: typeof Object.hasOwn,
      arrayAt: typeof Array.prototype.at,
      findLast: typeof Array.prototype.findLast,
      toSorted: typeof Array.prototype.toSorted,
      replaceAll: typeof String.prototype.replaceAll,
      structuredClone: typeof globalThis.structuredClone,
      promiseAny: typeof Promise.any,
      groupBy: typeof Object.groupBy
    };

    (async () => {
      try {
        // ① 任意一个源 signal 中止，合并后的也应中止
        const a = new AbortController();
        const b = new AbortController();
        const merged = AbortSignal.any([a.signal, b.signal]);
        out.t1_beforeAbort = merged.aborted;
        b.abort('because-b');
        out.t1_afterAbort = merged.aborted;
        out.t1_reason = merged.reason;

        // ② 传入已经中止的 signal，应立即处于中止态
        const c = new AbortController();
        c.abort('already-aborted');
        const merged2 = AbortSignal.any([c.signal]);
        out.t2_immediatelyAborted = merged2.aborted;
        out.t2_reason = merged2.reason;

        // ③ 空数组不应立即中止
        const merged3 = AbortSignal.any([]);
        out.t3_notAbortedWhenEmpty = !merged3.aborted;

        // ④ timeout 到点后应中止，且 reason.name 是 TimeoutError
        const t = AbortSignal.timeout(60);
        out.t4_notAbortedInitially = !t.aborted;
        await new Promise((r) => setTimeout(r, 140));
        out.t4_abortedAfterDelay = t.aborted;
        out.t4_reasonName = t.reason && t.reason.name;

        // ⑤ 非 signal 成员应被忽略而不是抛错
        let threw = false;
        try { AbortSignal.any([a.signal, null, undefined, b.signal]); } catch (err) { threw = true; }
        out.t5_toleratesFalsy = !threw;

        // ⑥ structuredClone 深拷贝
        const src = { x: { y: 1 }, arr: [1, 2, 3] };
        const copy = structuredClone(src);
        copy.x.y = 99;
        out.t6_deepClone = src.x.y === 1 && copy.x.y === 99;

        // ⑦ Object.hasOwn / groupBy
        out.t7_hasOwn = Object.hasOwn({ k: 1 }, 'k') === true && Object.hasOwn({}, 'k') === false;
        out.t8_groupBy = JSON.stringify(Object.groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')));

        out.pass =
          out.t1_beforeAbort === false &&
          out.t1_afterAbort === true &&
          out.t2_immediatelyAborted === true &&
          out.t3_notAbortedWhenEmpty === true &&
          out.t4_abortedAfterDelay === true &&
          out.t5_toleratesFalsy === true &&
          out.t6_deepClone === true &&
          out.t7_hasOwn === true;

        // ★ 这里原来是无条件的 `out.status = 'ok'` —— 上面那串 pass 算完就被扔了。
        //   后果：任何一项检查失败，status 照样是 ok、退出码照样是 0、
        //   回归链照样显示「ok」。**验了，但不作数。**
        out.status = out.pass ? 'ok' : 'failed';
      } catch (err) {
        out.status = 'error';
        out.error = err.message;
        out.stack = String(err.stack).slice(0, 400);
      }
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    })();
  }
} catch (err) {
  out.status = 'error';
  out.error = err.message;
}

// ── 结论与退出码 ────────────────────────────────────────────────────────────
//
// 这个脚本原来**只把结果写进 JSON，什么都不打印、退出码永远是 0** ——
// 回归链只看退出码，所以它失败了也显示「ok」。
// 记录结果和「让失败真的失败」是两件事，缺了后者，前面那些检查等于没做。
function verdict() {
  const okAll = out.status === 'ok';
  console.log(`  ${okAll ? '✓' : '✗'} 兼容补丁：${out.status}` +
    (okAll ? `（${out.removedNatives ? out.removedNatives.length : 0} 个原生实现被移除后逐项验证）`
      : `  ${out.error || '有检查项没通过'}`));
  if (!okAll) process.exitCode = 1;
}

// 非异步路径的兜底写出
setTimeout(() => {
  if (!fs.existsSync(OUT)) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  }
  verdict();
}, 3000);
