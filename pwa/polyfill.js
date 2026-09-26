// DSH 移动端网关 — Iterator Helpers 兼容层（polyfill）
//
// 为什么需要：
//   DSH 前端用到了 `Iterator` 这个全局对象（JavaScript 的 Iterator Helpers 提案）。
//   Safari 直到 18.4 / iOS 18.4 才支持它，老设备打开会直接抛
//   "Can't find variable: Iterator"，导致 __ModuleLoader__ 里所有插件
//   加载失败，页面只剩 "Failed to load plugins"。
//
//   这个文件由中间层在 DSH 页面 <head> 之后、module script 之前同步注入，
//   所以它一定先于 DSH 的代码执行。
//
// 实现范围：Iterator.from 和 Iterator.prototype 上的
//   map / filter / take / drop / flatMap / reduce / toArray /
//   forEach / some / every / find
// 足以覆盖常见的迭代器辅助用法。

(function () {
  'use strict';

  // 已经有原生实现就别动它
  if (typeof Iterator !== 'undefined' && typeof Iterator.from === 'function') return;

  // 所有内置迭代器共享的原型（规范里的 %IteratorPrototype%）
  var IteratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf([][Symbol.iterator]())
  );

  function assertReceiver(x) {
    if (x === null || (typeof x !== 'object' && typeof x !== 'function')) {
      throw new TypeError('Iterator.prototype method called on non-object');
    }
  }

  function toIterator(value) {
    if (value === null || value === undefined) {
      throw new TypeError('Iterator.from called on null or undefined');
    }
    if (typeof value.next === 'function') return value;
    var m = value[Symbol.iterator];
    if (typeof m !== 'function') throw new TypeError('value is not iterable');
    return m.call(value);
  }

  // 传入一个 { next, return } 形态的迭代器对象，返回一个同样带 next、
  // 但原型换成 %IteratorPrototype% 的对象，从而获得全部 helper 方法。
  //
  // 注意：不能只把它挂在内部字段上就算完 —— 那样返回的对象自己没有 next，
  // 后续任何 toIterator() 都会直接失败（这个坑在 Node 里被原生实现掩盖了，
  // 一到真没有原生实现的老 Safari 上就会暴露）。
  function helper(iteratorLike) {
    return Object.assign(Object.create(IteratorPrototype), iteratorLike);
  }

  function closeInner(inner) {
    if (inner && typeof inner.return === 'function') {
      try { inner.return(); } catch (e) { /* 关闭失败不影响主流程 */ }
    }
  }

  function done() { return { done: true, value: undefined }; }

  function define(name, fn) {
    if (!Object.prototype.hasOwnProperty.call(IteratorPrototype, name)) {
      Object.defineProperty(IteratorPrototype, name, {
        value: fn, writable: true, configurable: true
      });
    }
  }

  define('map', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    return helper({
      next: function () {
        var r = inner.next();
        if (r.done) return done();
        return { done: false, value: fn(r.value) };
      },
      'return': function () { closeInner(inner); return done(); }
    });
  });

  define('filter', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    return helper({
      next: function () {
        for (;;) {
          var r = inner.next();
          if (r.done) return done();
          if (fn(r.value)) return { done: false, value: r.value };
        }
      },
      'return': function () { closeInner(inner); return done(); }
    });
  });

  define('take', function (limit) {
    assertReceiver(this);
    var n = Number(limit);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    var inner = toIterator(this);
    var taken = 0;
    return helper({
      next: function () {
        if (taken >= n) { closeInner(inner); return done(); }
        var r = inner.next();
        if (r.done) return done();
        taken++;
        return { done: false, value: r.value };
      },
      'return': function () { closeInner(inner); return done(); }
    });
  });

  define('drop', function (limit) {
    assertReceiver(this);
    var n = Number(limit);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    var inner = toIterator(this);
    var dropped = false;
    return helper({
      next: function () {
        if (!dropped) {
          dropped = true;
          for (var i = 0; i < n; i++) {
            if (inner.next().done) return done();
          }
        }
        var r = inner.next();
        if (r.done) return done();
        return { done: false, value: r.value };
      },
      'return': function () { closeInner(inner); return done(); }
    });
  });

  define('flatMap', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    var current = null;
    return helper({
      next: function () {
        for (;;) {
          if (current) {
            var c = current.next();
            if (!c.done) return { done: false, value: c.value };
            current = null;
          }
          var r = inner.next();
          if (r.done) return done();
          current = toIterator(fn(r.value));
        }
      },
      'return': function () { closeInner(current); closeInner(inner); return done(); }
    });
  });

  define('reduce', function (fn, initial) {
    assertReceiver(this);
    var inner = toIterator(this);
    // acc 必须先用 initial 初始化：否则显式传了初值时 hasAcc 为真、acc 却仍是
    // undefined，第一次归并会算成 undefined + 1 = NaN。
    var acc = initial;
    var hasAcc = arguments.length > 1;
    for (;;) {
      var r = inner.next();
      if (r.done) break;
      if (!hasAcc) { acc = r.value; hasAcc = true; continue; }
      acc = fn(acc, r.value);
    }
    if (!hasAcc) throw new TypeError('Reduce of empty iterator with no initial value');
    return acc;
  });

  define('toArray', function () {
    assertReceiver(this);
    var inner = toIterator(this);
    var out = [];
    for (;;) {
      var r = inner.next();
      if (r.done) return out;
      out.push(r.value);
    }
  });

  define('forEach', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    for (;;) {
      var r = inner.next();
      if (r.done) return undefined;
      fn(r.value);
    }
  });

  define('some', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    for (;;) {
      var r = inner.next();
      if (r.done) return false;
      if (fn(r.value)) { closeInner(inner); return true; }
    }
  });

  define('every', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    for (;;) {
      var r = inner.next();
      if (r.done) return true;
      if (!fn(r.value)) { closeInner(inner); return false; }
    }
  });

  define('find', function (fn) {
    assertReceiver(this);
    var inner = toIterator(this);
    for (;;) {
      var r = inner.next();
      if (r.done) return undefined;
      if (fn(r.value)) { closeInner(inner); return r.value; }
    }
  });

  // 让 helper 自己可被 for...of 复用（内置迭代器本来就有，这里兜底）
  if (!IteratorPrototype[Symbol.iterator]) {
    Object.defineProperty(IteratorPrototype, Symbol.iterator, {
      value: function () { return this; }, writable: true, configurable: true
    });
  }

  var IteratorCtor = function Iterator() {
    throw new TypeError('Iterator is not a constructor');
  };
  IteratorCtor.prototype = IteratorPrototype;

  Object.defineProperty(IteratorCtor, 'from', {
    value: function from(value) {
      var it = toIterator(value);
      // 已经是合格迭代器、且原型链上带着 helper 方法，就直接复用
      if (typeof it.next === 'function' && IteratorPrototype.isPrototypeOf(it)) {
        return it;
      }
      // 否则包一层，保证返回对象既有 next 又有 helper 方法
      return helper({
        next: function () { return it.next(); },
        'return': function () { closeInner(it); return done(); }
      });
    },
    writable: true, configurable: true
  });

  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  Object.defineProperty(g, 'Iterator', {
    value: IteratorCtor, writable: true, configurable: true
  });
})();
