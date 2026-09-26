// DSH 移动端网关 —  Web API 兼容补丁
//
// 为什么需要：DSH 前端用了一批较新的标准 API，而老版本 Safari 没有。
// 缺一个就会让某个功能直接抛异常 —— 而且往往是一个不起眼的地方崩掉，
// 连带整块界面空白，很难从现象定位。
//
// 已经踩到的两个坑：
//   Iterator        —— Safari 18.4 才有，缺了会让插件全部加载失败（见 polyfill.js）
//   AbortSignal.any —— Safari 17.4 才有，缺了会让「选择工作区目录」直接崩，
//                      于是工作区和会话列表全是空的
//
// 这里把常见缺口一次补齐。每个补丁都先检测再安装，有原生实现就完全不碰。
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : window;

  // ── AbortSignal.any ───────────────────────────────────────────────────────
  // 把多个 signal 合并成一个：任意一个中止，合并后的也中止。
  if (typeof g.AbortSignal !== 'undefined' && typeof g.AbortSignal.any !== 'function') {
    g.AbortSignal.any = function any(signals) {
      var controller = new g.AbortController();
      var list = [];
      try {
        for (var i = 0; i < signals.length; i++) list.push(signals[i]);
      } catch (err) {
        throw new TypeError('AbortSignal.any: argument is not iterable');
      }

      function abortWith(reason) {
        if (!controller.signal.aborted) controller.abort(reason);
      }

      for (var j = 0; j < list.length; j++) {
        var s = list[j];
        if (!s) continue;
        if (s.aborted) { abortWith(s.reason); break; }
        s.addEventListener('abort', function () { }, { once: true });
      }

      // 逐个挂监听（闭包写法，避免上面那个空监听误导）
      for (var k = 0; k < list.length; k++) {
        (function (sig) {
          if (!sig || sig.aborted) return;
          sig.addEventListener('abort', function () { abortWith(sig.reason); }, { once: true });
        })(list[k]);
      }

      return controller.signal;
    };
  }

  // ── AbortSignal.timeout ───────────────────────────────────────────────────
  if (typeof g.AbortSignal !== 'undefined' && typeof g.AbortSignal.timeout !== 'function') {
    g.AbortSignal.timeout = function timeout(ms) {
      var controller = new g.AbortController();
      setTimeout(function () {
        if (!controller.signal.aborted) {
          var reason;
          try {
            reason = new g.DOMException('signal timed out', 'TimeoutError');
          } catch (err) {
            reason = new Error('signal timed out');
            reason.name = 'TimeoutError';
          }
          controller.abort(reason);
        }
      }, ms);
      return controller.signal;
    };
  }

  // ── AbortSignal.abort ─────────────────────────────────────────────────────
  if (typeof g.AbortSignal !== 'undefined' && typeof g.AbortSignal.abort !== 'function') {
    g.AbortSignal.abort = function abort(reason) {
      var controller = new g.AbortController();
      controller.abort(reason);
      return controller.signal;
    };
  }

  // ── Object.hasOwn ─────────────────────────────────────────────────────────
  if (typeof Object.hasOwn !== 'function') {
    Object.hasOwn = function hasOwn(obj, prop) {
      return Object.prototype.hasOwnProperty.call(Object(obj), prop);
    };
  }

  // ── Array.prototype.at ────────────────────────────────────────────────────
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', {
      value: function at(n) {
        n = Math.trunc(n) || 0;
        if (n < 0) n += this.length;
        return (n < 0 || n >= this.length) ? undefined : this[n];
      },
      writable: true, configurable: true
    });
  }

  // ── String.prototype.at ───────────────────────────────────────────────────
  if (!String.prototype.at) {
    Object.defineProperty(String.prototype, 'at', {
      value: function at(n) {
        n = Math.trunc(n) || 0;
        if (n < 0) n += this.length;
        return (n < 0 || n >= this.length) ? undefined : this[n];
      },
      writable: true, configurable: true
    });
  }

  // ── Array.prototype.findLast / findLastIndex ──────────────────────────────
  if (!Array.prototype.findLast) {
    Object.defineProperty(Array.prototype, 'findLast', {
      value: function findLast(fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true, configurable: true
    });
  }
  if (!Array.prototype.findLastIndex) {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      value: function findLastIndex(fn, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (fn.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true, configurable: true
    });
  }

  // ── Array.prototype.toSorted / toReversed / with ──────────────────────────
  if (!Array.prototype.toSorted) {
    Object.defineProperty(Array.prototype, 'toSorted', {
      value: function toSorted(compareFn) {
        return Array.prototype.slice.call(this).sort(compareFn);
      },
      writable: true, configurable: true
    });
  }
  if (!Array.prototype.toReversed) {
    Object.defineProperty(Array.prototype, 'toReversed', {
      value: function toReversed() {
        return Array.prototype.slice.call(this).reverse();
      },
      writable: true, configurable: true
    });
  }
  if (!Array.prototype.with) {
    Object.defineProperty(Array.prototype, 'with', {
      value: function with_(index, value) {
        var copy = Array.prototype.slice.call(this);
        var i = Math.trunc(index) || 0;
        if (i < 0) i += copy.length;
        if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
        copy[i] = value;
        return copy;
      },
      writable: true, configurable: true
    });
  }

  // ── String.prototype.replaceAll ───────────────────────────────────────────
  if (!String.prototype.replaceAll) {
    Object.defineProperty(String.prototype, 'replaceAll', {
      value: function replaceAll(search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
          return this.replace(search, replacement);
        }
        return this.split(search).join(replacement);
      },
      writable: true, configurable: true
    });
  }

  // ── structuredClone ───────────────────────────────────────────────────────
  if (typeof g.structuredClone !== 'function') {
    g.structuredClone = function structuredClone(value) {
      if (value === null || typeof value !== 'object') return value;
      if (typeof g.MessageChannel === 'function') {
        // 用消息通道做真正的深拷贝（能处理循环引用）
        return (function () {
          var channel = new g.MessageChannel();
          var result;
          channel.port1.onmessage = function (e) { result = e.data; };
          channel.port2.postMessage(value);
          return result;
        })();
      }
      return JSON.parse(JSON.stringify(value));
    };
  }

  // ── Promise.any / Promise.allSettled ──────────────────────────────────────
  if (!Promise.any) {
    Promise.any = function any(iterable) {
      return new Promise(function (resolve, reject) {
        var errors = [];
        var remaining = 0;
        var index = 0;
        var done = false;
        Promise.resolve(iterable).then(function (list) {
          var arr = Array.prototype.slice.call(list);
          if (arr.length === 0) {
            var e = new Error('All promises were rejected');
            e.name = 'AggregateError';
            reject(e);
            return;
          }
          remaining = arr.length;
          arr.forEach(function (p, i) {
            Promise.resolve(p).then(function (v) {
              if (!done) { done = true; resolve(v); }
            }, function (err) {
              errors[i] = err;
              remaining--;
              if (remaining === 0 && !done) {
                var agg = new Error('All promises were rejected');
                agg.name = 'AggregateError';
                agg.errors = errors;
                reject(agg);
              }
            });
          });
        }, reject);
      });
    };
  }
  if (!Promise.allSettled) {
    Promise.allSettled = function allSettled(iterable) {
      return Promise.all(Array.prototype.map.call(iterable, function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      }));
    };
  }

  // ── Object.groupBy / Map.groupBy ──────────────────────────────────────────
  if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function groupBy(items, fn) {
      var out = Object.create(null);
      var i = 0;
      for (var item of items) {
        var key = fn(item, i++);
        if (!out[key]) out[key] = [];
        out[key].push(item);
      }
      return out;
    };
  }
  if (typeof Map.groupBy !== 'function') {
    Map.groupBy = function groupBy(items, fn) {
      var out = new Map();
      var i = 0;
      for (var item of items) {
        var key = fn(item, i++);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(item);
      }
      return out;
    };
  }

  // ── WeakRef（个别库会用到）────────────────────────────────────────────────
  if (typeof g.WeakRef !== 'function') {
    g.WeakRef = function WeakRef(target) {
      this._target = target;
    };
    g.WeakRef.prototype.deref = function deref() { return this._target; };
  }
})();
