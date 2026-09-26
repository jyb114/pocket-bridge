// DSH 移动端网关 — Iterator 兼容层自测
//
// 手法：先把 Node 自带的 Iterator 删掉，模拟老版本 Safari 的环境，
// 再加载我们的 polyfill，然后逐个 API 验证行为。不这么做的话，
// polyfill 会因为「检测到已有原生实现」而直接返回，测了等于没测。
'use strict';

const fs = require('fs');
const path = require('path');

const out = { ranAt: new Date().toISOString() };

try {
  const polyfillPath = path.join(__dirname, '..', 'pwa', 'polyfill.js');
  const code = fs.readFileSync(polyfillPath, 'utf8');

  // 模拟老浏览器：移除原生 Iterator
  try {
    delete globalThis.Iterator;
  } catch (e) {
    out.deleteError = e.message;
  }
  out.nativeIteratorAfterDelete = typeof globalThis.Iterator;

  // 更彻底的模拟：新版 V8 即使没有全局 Iterator，%IteratorPrototype% 上也
  // 已经带了 map / filter / ...。老 Safari 两者都没有，所以这里一并删掉，
  // 才能真正走到 polyfill 自己的实现路径上，而不是被原生实现接管。
  try {
    var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    var removed = [];
    ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray',
     'forEach', 'some', 'every', 'find'].forEach(function (m) {
      if (Object.prototype.hasOwnProperty.call(IP, m)) {
        try { delete IP[m]; removed.push(m); } catch (e) { /* 不可配置就跳过 */ }
      }
    });
    out.removedNativeMethods = removed;
  } catch (e) {
    out.removeMethodsError = e.message;
  }

  if (typeof globalThis.Iterator !== 'undefined') {
    out.status = 'skipped';
    out.reason =
      '删不掉原生 Iterator（属性可能不可配置），本次测试无法模拟老环境。' +
      'polyfill 在真实老浏览器里仍会正常生效。';
  } else {
    // 加载 polyfill（用间接 eval 让它跑在全局作用域）
    (0, eval)(code);

    out.afterPolyfill = typeof globalThis.Iterator;
    out.hasFrom = typeof globalThis.Iterator.from === 'function';

    // 逐个 API 验证
    out.mapToArray = Iterator.from([1, 2, 3]).map((x) => x * 2).toArray().join(',');
    out.filterTake = Iterator.from([1, 2, 3, 4, 5]).filter((x) => x % 2 === 1).take(2).toArray().join(',');
    out.drop = Iterator.from([1, 2, 3, 4]).drop(2).toArray().join(',');
    out.fromValues = Iterator.from([1, 2, 3].values()).toArray().join(',');
    out.reduceWithInit = Iterator.from([1, 2, 3, 4]).reduce((a, b) => a + b, 0);
    out.reduceNoInit = Iterator.from([5, 6]).reduce((a, b) => a + b);
    out.some = Iterator.from([1, 2, 3]).some((x) => x === 2);
    out.every = Iterator.from([2, 4]).every((x) => x % 2 === 0);
    out.find = Iterator.from([1, 2, 3]).find((x) => x > 1);
    out.flatMap = Iterator.from([1, 2]).flatMap((x) => [x, x * 10]).toArray().join(',');
    out.forEachSum = (() => { let s = 0; Iterator.from([1, 2, 3]).forEach((x) => { s += x; }); return s; })();
    // 展开运算符单独诊断：它走的是 Symbol.iterator 协议，和直接调 next 不同
    var helperObj = Iterator.from([1, 2, 3]).map((x) => x + 1);
    out.debugSpread = {
      nextType: typeof helperObj.next,
      symbolIteratorType: typeof helperObj[Symbol.iterator],
      symbolIteratorReturns: (function () {
        try {
          var r = helperObj[Symbol.iterator]();
          return typeof r + ' next=' + typeof r.next;
        } catch (e) { return 'ERR ' + e.message; }
      })(),
      manualIterate: (function () {
        var acc = [], r;
        while (!(r = helperObj.next()).done) acc.push(r.value);
        return acc.join(',');
      })()
    };
    out.forOfSpread = [...Iterator.from([1, 2, 3]).map((x) => x + 1)].join(',');
    out.chained = Iterator.from('abc').map((c) => c.toUpperCase()).toArray().join('');

    out.status = 'ok';
  }
} catch (err) {
  out.status = 'error';
  out.error = err.message;
  out.stack = String(err.stack).slice(0, 500);
}

fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '..', 'logs', 'test-polyfill.json'),
  JSON.stringify(out, null, 2),
  'utf8'
);

// ── 期望值与结论 ────────────────────────────────────────────────────────────
//
// 这个脚本原来**只把测出来的值写进 JSON**：不打印、不比对、退出码永远是 0。
// 也就是说它是个「记录器」，不是测试 —— 上面十几项测出来的值从来没被
// 拿去和任何期望比过，改坏了也没人知道。
//
// 下面这些期望就是**当前已验证通过的那一组值**。硬编码它们确实会让
// 「有意改行为」时需要同步改这里 —— 但那正是测试该有的摩擦：
// 值变了就得有人看一眼，而不是静默地过去。
const EXPECT = {
  // 存的是 `typeof Iterator` 的**字符串**结果：整份脚本靠「先删掉原生实现」
  // 来模拟老浏览器，所以这里必须是字符串 'undefined' —— 它表示「类型名是
  // undefined」，也就是那一步真的删掉了。（我第一版写成 undefined，自己绊了一下。）
  nativeIteratorAfterDelete: 'undefined',
  afterPolyfill: 'function',
  hasFrom: true,
  mapToArray: '2,4,6',
  filterTake: '1,3',
  drop: '3,4',
  fromValues: '1,2,3',
  reduceWithInit: 10,
  reduceNoInit: 11,
  some: true,
  every: true,
  find: 2,
  flatMap: '1,10,2,20',
  forEachSum: 6,
  forOfSpread: '2,3,4',
  chained: 'ABC'
};

const wrong = Object.keys(EXPECT).filter((k) => out[k] !== EXPECT[k]);
const okAll = out.status === 'ok' && wrong.length === 0;
console.log(`  ${okAll ? '✓' : '✗'} 兼容层 Iterator 补丁：${out.status}` +
  (okAll ? `（移除了 ${(out.removedNativeMethods || []).length} 个原生方法后逐项验证 ${Object.keys(EXPECT).length} 项）`
    : `  对不上的：${wrong.map((k) => `${k}(期望 ${JSON.stringify(EXPECT[k])}，实际 ${JSON.stringify(out[k])})`).join('、') || out.error}`));
if (!okAll) process.exitCode = 1;
