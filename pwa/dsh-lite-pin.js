(function () {
  'use strict';

  // Lite can be opened directly, without ever visiting the official DSH page
  // that loads boot.js. Pin the same bridge scripts here without delaying chat.
  if (!('serviceWorker' in navigator)) return;
  var required = ['/e2ee.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
    '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-ui.js',
    // 界面文案（中/英/西）也钉住：它是**决定界面说什么话**的那个文件，
    // 而且每个页面都会加载 —— 不在名单里就等于"有人换掉它，谁都不会发现"。
    '/i18n.js', '/dsh-lite-lang.js'];
  var fetching = false;
  var repinning = false;

  function activeWorker() {
    return navigator.serviceWorker.ready.then(function (registration) {
      if (!registration.active) throw new Error('Service Worker 尚未就绪');
      return registration.active;
    });
  }

  function requestStatus() {
    activeWorker().then(function (worker) {
      worker.postMessage({ type: 'dsh-pin-status' });
    }).catch(function () { /* 指纹检查不能挡住对话连接 */ });
  }

  function readManifest() {
    function request() { return fetch('/code-manifest.json', { cache: 'no-store' }); }
    return request().then(function (response) {
      if (response.status !== 403) return response;
      var e2ee = window.DshE2EE;
      if (!e2ee || typeof e2ee.prove !== 'function') return response;
      return e2ee.prove(true).then(function (ok) { return ok ? request() : response; });
    }).then(function (response) {
      if (!response.ok) throw new Error('无法读取代码指纹清单');
      return response.json();
    }).then(function (manifest) {
      if (!manifest || !manifest.files || required.some(function (name) {
        return !/^[a-f0-9]{64}$/i.test(manifest.files[name] || '');
      })) throw new Error('代码指纹清单缺少轻量模式脚本');
      return manifest;
    });
  }

  var pendingNotice = '';

  function showNotice(detail) {
    // ★ 不能因为 <body> 还没出现就把提示丢掉 —— 这是"改了代码手机没反应"的根因。
    //
    //   指纹不匹配**正是发生在浏览器加载这些脚本的时候**，而那一刻 <body> 还不存在。
    //   原来这里直接 return，于是：Service Worker 拒绝加载新代码、继续发旧版，
    //   而"信任新版本"那个按钮**永远没被画出来** —— 使用者只看到界面莫名其妙
    //   停在旧版上，唯一的出路是自己去清站点数据。
    //   现在改成先记下来，等 <body> 出现再补弹。
    if (!document.body) { pendingNotice = String(detail || ''); return; }
    if (document.getElementById('dsh-lite-update-notice')) return;
    var bar = document.getElementById('dsh-lite-pin-notice');
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'dsh-lite-pin-notice';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;inset:0 0 auto;z-index:2147483647;' +
      'padding:12px 16px;background:#4a1614;color:#fff;font:14px/1.5 system-ui,sans-serif';
    var message = document.createElement('span');
    message.textContent = detail;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '我刚更新过，信任新版本';
    button.style.cssText = 'margin-left:12px;padding:7px 10px;cursor:pointer';
    button.addEventListener('click', function () {
      // 只要一次点击就够：按钮文字本身已经写明了条件（「我刚更新过，信任新版本」），
      // 那已经是明确 informed consent。原来还叠一层 confirm() 系统弹窗，
      // 手机上要点两次、弹窗文字还看不全，实际效果是使用者干脆放弃更新、
      // 继续跑旧代码 —— 安全上并没有更好。
      if (repinning) return;
      repinning = true;
      button.disabled = true;
      button.textContent = '正在检查…';
      readManifest().then(function (manifest) {
        return activeWorker().then(function (worker) {
          worker.postMessage({ type: 'dsh-repin-code', manifest: manifest });
        });
      }).catch(function () {
        repinning = false;
        button.disabled = false;
        button.textContent = '重试更新指纹';
      });
    });
    bar.appendChild(message);
    bar.appendChild(button);
    document.body.appendChild(bar);
  }

  /** <body> 一出现，就把加载期间欠下的那条提示补上。 */
  function flushNotice() {
    if (!pendingNotice) return;
    var detail = pendingNotice;
    pendingNotice = '';
    showNotice(detail);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', flushNotice);
  } else {
    flushNotice();
  }

  navigator.serviceWorker.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === 'dsh-pin-status-result') {
      if (data.pinned) {
        // Older pins contain no Lite entries. Never silently replace one:
        // the owner must explicitly approve a normal code update.
        if (!Array.isArray(data.paths) || required.some(function (name) {
          return data.paths.indexOf(name) < 0;
        })) showNotice('手机保存的是旧版代码指纹。轻量模式脚本尚未纳入校验；如果刚在电脑上更新过桥，请确认新版。');
        return;
      }
      if (fetching) return;
      fetching = true;
      readManifest().then(function (manifest) {
        return activeWorker().then(function (worker) {
          worker.postMessage({ type: 'dsh-pin-code', manifest: manifest });
        });
      }).catch(function () { /* 初次认证未完成时，下次打开还会重试 */ })
        .finally(function () { fetching = false; });
    } else if (data.type === 'dsh-code-mismatch') {
      showNotice('桥的代码指纹与手机保存的不一致，已拒绝新版脚本：' +
        String(data.path || '').slice(0, 100));
    } else if (data.type === 'dsh-pin-result' && data.already) {
      requestStatus();
    } else if (data.type === 'dsh-repin-result') {
      if (!repinning) return;
      if (data.ok) { repinning = false; location.reload(); }
      else {
        repinning = false;
        var button = document.querySelector('#dsh-lite-pin-notice button');
        if (button) { button.disabled = false; button.textContent = '重试更新指纹'; }
      }
    }
  });

  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(requestStatus)
    .catch(function () { /* 不影响 Lite 主连接 */ });
})();
