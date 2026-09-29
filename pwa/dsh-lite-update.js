(function () {
  'use strict';

  // ── 为什么需要这个文件（而不是把逻辑放进 dsh-lite-pin.js）──────────────────
  //
  // 指纹机制（sw.js）会拒绝加载**哈希对不上**的、名字在名单里的脚本，
  // 并且改用缓存里的旧版。这本身是对的 —— 它防的是中继偷改代码。
  //
  // 但 dsh-lite-pin.js **自己也在那份名单里**。于是电脑上正常更新一次代码之后：
  //
  //   新代码被拒 → 手机继续跑旧版 → 而"信任新版本"的提示就在那个被拒的文件里
  //   → 提示永远加载不出来 → 使用者只能自己去清站点数据，否则永远锁在旧版
  //
  // 这是个死锁：**修复更新流程的代码，本身需要更新流程才能生效。**
  //
  // 破解办法就是"换个名字"：指纹名单按**路径**匹配，所以一个**新文件名**
  // 不在旧指纹里 → sw.js 的"没 pin 过的文件原样走网络"那一支会正常放行它。
  // 这个文件因此一定加载得出来，也就一定能把提示画出来。
  //
  // 它**不做任何自动更新**：只画一个按钮，点不点由使用者决定 ——
  // 和原来那条规矩一致（脚本不能自己改指纹，只有人能）。
  if (!('serviceWorker' in navigator)) return;

  var bar = null;
  var busy = false;
  var checking = false;
  var pendingBuild = '';
  var pendingRequestId = '';
  var capability = null;
  var resultTimer = null;
  var buildFiles = ['/dsh-lite-ui.js', '/dsh-lite-adapter.js', '/dsh-lite-pin.js', '/e2ee.js'];
  var requiredFiles = buildFiles.concat(['/dsh-lite-legacy.js', '/dsh-lite-router.js',
    '/dsh-lite-switch.js', '/i18n.js', '/dsh-lite-lang.js']);

  function waitForActivation(registration) {
    var incoming = registration.installing || registration.waiting ||
      (registration.active && registration.active.state !== 'activated' ? registration.active : null);
    if (!incoming) return Promise.resolve();
    if (incoming.state === 'activated' && registration.active === incoming)
      return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        finish(new Error('新版更新器尚未启用。请刷新页面后重试，旧版仍可用。'));
      }, 10000);
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (typeof incoming.removeEventListener === 'function')
          incoming.removeEventListener('statechange', check);
        if (typeof navigator.serviceWorker.removeEventListener === 'function')
          navigator.serviceWorker.removeEventListener('controllerchange', check);
        if (error) reject(error);
        else resolve();
      }
      function check() {
        if (incoming.state === 'activated' && registration.active === incoming) finish();
        else if (incoming.state === 'redundant')
          finish(new Error('新版更新器未能启用。请刷新页面后重试，旧版仍可用。'));
      }
      incoming.addEventListener('statechange', check);
      navigator.serviceWorker.addEventListener('controllerchange', check);
      check();
    });
  }

  function activeWorker() {
    return navigator.serviceWorker.ready.then(function (registration) {
      // update() can resolve while the new worker is still installing. Wait
      // for its activation before probing the current active worker; an old
      // worker must never receive the old, unverified repin as a fallback.
      var refreshed = typeof registration.update === 'function' ?
        registration.update() : Promise.resolve();
      return refreshed.then(function (updated) {
        var current = updated && 'active' in updated ? updated : registration;
        return waitForActivation(current).then(function () { return current; });
      })
        .then(function (current) {
          if (!current.active) throw new Error('Service Worker 尚未就绪');
          return current.active;
        });
    });
  }

  function verifiedWorker(worker) {
    return new Promise(function (resolve, reject) {
      var requestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      var pending = { requestId: requestId, resolve: resolve };
      capability = pending;
      pending.timer = setTimeout(function () {
        if (capability !== pending) return;
        capability = null;
        reject(new Error('手机还在使用旧版更新器。请刷新页面后重试，旧版仍可用。'));
      }, 10000);
      try {
        worker.postMessage({ type: 'dsh-verified-update-capability', requestId: requestId });
      } catch (err) {
        clearTimeout(pending.timer);
        capability = null;
        reject(err);
      }
    }).then(function () { return worker; });
  }

  function readManifest() {
    function request() { return fetch('/code-manifest.json', { cache: 'no-store' }); }
    return request().then(function (response) {
      if (response.status !== 403) return response;
      var e2ee = window.DshE2EE;
      if (!e2ee || typeof e2ee.prove !== 'function') return response;
      return e2ee.prove(true).then(function (ok) { return ok ? request() : response; });
    }).then(function (response) {
      if (!response.ok) throw new Error('读不到代码指纹清单');
      return response.json();
    }).then(function (manifest) {
      if (!manifest || !manifest.files || requiredFiles.some(function (name) {
        return !/^[a-f0-9]{64}$/i.test(manifest.files[name] || '');
      })) throw new Error('代码指纹清单无效');
      return manifest;
    });
  }

  function show(detail) {
    // ★ 这一条是本文件存在的全部理由：**<body> 还没出现时不能把提示丢掉。**
    //   指纹不匹配正是发生在浏览器加载脚本的时候，那一刻 <body> 还不存在。
    //   原来的实现直接 return，于是提示被静默吞掉、使用者永远看不到按钮。
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { show(detail); }, { once: true });
      return;
    }
    if (document.getElementById('dsh-lite-pin-notice')) return;
    if (bar) {
      bar.querySelector('span').textContent = '手机上的界面不是最新的。' + detail;
      return;
    }

    bar = document.createElement('div');
    bar.id = 'dsh-lite-update-notice';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;inset:0 0 auto;z-index:2147483647;display:flex;' +
      'flex-wrap:wrap;align-items:center;gap:10px;padding:12px 14px;' +
      'background:#4a1614;color:#fff;font:14px/1.5 system-ui,-apple-system,sans-serif';

    var text = document.createElement('span');
    text.style.cssText = 'flex:1 1 220px;min-width:0';
    // 使用者说过「红条里的内容与实际更新不符」——那条文字是通用提示。
    // 现在把**能核对的东西**摆出来：手机上跑的是哪一版、电脑上是哪一版。
    text.textContent = '手机上的界面不是最新的。' + detail;

    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = '更新到最新版';
    go.style.cssText = 'min-height:38px;padding:7px 14px;border:0;border-radius:9px;' +
      'background:#fff;color:#4a1614;font:inherit;font-weight:650;cursor:pointer';

    go.addEventListener('click', function () {
      // 只点一次就够：按钮文字已经写明了"更新到最新版"，那就是明确同意。
      // （原来还叠一层 confirm() 系统弹窗，手机上要点两次，实际效果是使用者放弃更新。）
      if (busy) return;
      busy = true;
      go.disabled = true;
      go.textContent = '正在更新…';
      function failed(error) {
        if (resultTimer !== null) { clearTimeout(resultTimer); resultTimer = null; }
        busy = false;
        pendingBuild = '';
        pendingRequestId = '';
        go.disabled = false;
        go.textContent = '重试更新';
        text.textContent = error && error.message ||
          '新版本文件未能完整下载并验证，手机仍在使用旧版。请重试更新。';
      }
      readManifest().then(function (manifest) {
        pendingBuild = buildId(manifest.files || {});
        return activeWorker().then(function (worker) {
          return verifiedWorker(worker);
        }).then(function (worker) {
          pendingRequestId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
          worker.postMessage({ type: 'dsh-repin-code-verified',
            requestId: pendingRequestId, manifest: manifest });
          // A large release can take longer than 15 seconds over a tunnel.
          // This timer only explains the delay; clearing the request here
          // would let the worker switch pins later without reloading the page.
          resultTimer = setTimeout(function () {
            resultTimer = null;
            if (!busy || !pendingRequestId) return;
            go.textContent = '正在核验…';
            text.textContent = '正在下载并核验新版文件，隧道上可能较慢，请保持页面打开。';
          }, 15000);
        });
      }).catch(failed);
    });

    bar.appendChild(text);
    bar.appendChild(go);
    document.body.appendChild(bar);
  }

  navigator.serviceWorker.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === 'dsh-verified-update-ready') {
      if (!capability || data.requestId !== capability.requestId) return;
      var pending = capability;
      capability = null;
      clearTimeout(pending.timer);
      pending.resolve();
      return;
    }
    // sw.js 检测到"送来的代码和手机上存的对不上"时会发这条。
    // 旧版 dsh-lite-pin.js 也监听它，但它的 showNotice 会在 <body> 缺失时直接丢弃 ——
    // 所以那条提示从来没有出现过。这里补上。
    if (data.type === 'dsh-code-mismatch') {
      // 顺手把"手机上 / 电脑上"两边的版本标记取出来一起显示 —— 只报一个文件名，
      // 使用者没法核对到底是不是自己刚改的那次（这正是他抱怨"内容与更新不符"的点）。
      var detail = '（' + String(data.path || '').slice(0, 60) + '）';
      show(detail);
      readManifest().then(function (manifest) {
        var want = buildId(manifest.files || {});
        var seen = '';
        try { seen = localStorage.getItem(BUILD_KEY) || ''; } catch (err) { seen = ''; }
        if (want && want !== seen) {
          show(' 手机上：' + (seen || '未知') + ' → 电脑上：' + want);
          return;
        }
        show(detail);
      }).catch(function () { show(detail); });
    } else if (data.type === 'dsh-repin-verified-result') {
      // pin.js also hears this message; only the initiator should reload.
      if (!busy || !pendingRequestId || data.requestId !== pendingRequestId) return;
      if (resultTimer !== null) { clearTimeout(resultTimer); resultTimer = null; }
      if (data.ok) {
        if (pendingBuild) {
          try { localStorage.setItem(BUILD_KEY, pendingBuild); } catch (err) {}
        }
        busy = false;
        pendingBuild = '';
        pendingRequestId = '';
        location.reload();
        return;
      }
      busy = false;
      pendingBuild = '';
      pendingRequestId = '';
      if (bar) {
        var b = bar.querySelector('button');
        if (b) { b.disabled = false; b.textContent = '重试更新'; }
        var message = bar.querySelector('span');
        if (message) message.textContent = data.reason ||
          '新版本文件未能完整下载并验证，手机仍在使用旧版。请重试更新。';
      }
    }
  });

  // ── 地址里没有加密密钥时，必须**当场说清楚** ──────────────────────────────
  //
  // 为什么放在这个文件里：它不在代码指纹名单里，所以**一定加载得出来** ——
  // 而缺密钥的时候，其它依赖密钥的脚本可能连初始化都过不去，提示就永远画不出来。
  //
  // 为什么必须有这条提示：没有 `#k=` 时，内容通道是「拒绝明文、不降级」的，
  // 表现为「发送键变灰、对话加载不出来」，看起来就像"登不上、坏了"。
  // 但真正的原因只有一个 —— **地址不完整**。不说清楚，使用者只会以为工具坏了
  // （实测就是如此：查了好几轮网络和代码，最后发现是地址少了 `#`）。
  function warnMissingKey() {
    if (window.__dshE2eeSecret) return;              // 有密钥，正常
    if (location.hash && location.hash.indexOf('k=') >= 0) return;  // 有 #k= 只是还没解析出来
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', warnMissingKey, { once: true });
      return;
    }
    if (document.getElementById('dsh-lite-key-warning')) return;
    var box = document.createElement('div');
    box.id = 'dsh-lite-key-warning';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0 0 auto;z-index:2147483647;padding:12px 14px;' +
      'background:#7a3b12;color:#fff;font:14px/1.55 system-ui,-apple-system,sans-serif';
    box.textContent = '这个地址缺少加密密钥（结尾的 #k=… 那段），所以内容通道用不了 —— ' +
      '发送键会变灰、对话也加载不出来。请从电脑控制台复制带 #k= 的完整地址并重新打开。';
    document.body.appendChild(box);
  }
  warnMissingKey();
  // 有的版本是先由别的脚本把 #k= 解析出来，所以晚一点再确认一次
  setTimeout(warnMissingKey, 2500);

  // ── 只读版本检查 ──────────────────────────────────────────────────────────
  // 切回页面时只提示更新，不能擅自改写已经保存的代码指纹并刷新对话。
  // 清单经普通 HTTP 响应传递，本身不是端到端加密的更新授权。
  var BUILD_KEY = 'dsh-lite:build';
  function buildId(files) {
    // 取几个关键脚本的哈希前缀拼成短 id。不引 crypto —— 目的只是"变了没有"。
    return buildFiles
      .map(function (n) { return String(files[n] || '').slice(0, 8); }).join('-');
  }

  /**
   * 读清单并决定要不要提示更新。**失败时必须能重试**。
   *
   * 以前的检查只在脚本执行时跑一次，
   *   而那**早于**这台设备完成"进门证明"。于是 `/code-manifest.json` 回 403、
   *   提示又没画出来 —— 结果就是"手机上什么都没发生"，电脑上改了十遍也没用。
   *   使用者只看到手机停在旧版。
   *
   * 现在的做法：失败就退避重试（5s → 15s → 30s → 60s → 120s，最多 5 次），
   * 页面回到前台时再试一次 —— 那时候证明多半已经做完了。
   */
  var updateState = { attempts: 0 };
  function readManifestWithRetry() {
    return readManifest().catch(function (err) {
      updateState.attempts++;
      var waits = [5000, 15000, 30000, 60000, 120000];
      var wait = waits[Math.min(updateState.attempts - 1, waits.length - 1)];
      if (updateState.attempts <= waits.length) {
        setTimeout(function () { checkForUpdate(); }, wait);
      }
      throw err;
    });
  }

  function checkForUpdate() {
    if (busy || checking) return;
    checking = true;
    readManifestWithRetry().then(function (manifest) {
      updateState.attempts = 0;
      var id = buildId(manifest.files || {});
      if (!id.replace(/-/g, '')) return;               // 清单不全，别乱来
      var seen = '';
      try { seen = localStorage.getItem(BUILD_KEY) || ''; } catch (err) { seen = ''; }
      if (!seen) { try { localStorage.setItem(BUILD_KEY, id); } catch (err) {} return; }
      if (seen !== id) show(' 手机上：' + seen + ' → 电脑上：' + id);
    }).catch(function () { /* 拿不到清单 —— readManifestWithRetry 已经排了下一次 */ })
      .finally(function () { checking = false; });
  }

  // 首屏先试一次；失败会自动退避重试（见上）。
  checkForUpdate();
  // 从后台切回来只检查并提示，不动指纹，也不打断对话草稿。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    updateState.attempts = 0;
    checkForUpdate();
  });
})();
