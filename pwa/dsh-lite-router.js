(function (global) {
  'use strict';

  // Both adapters are small. Select by the gateway's observed runtime profile
  // before either can open a connection or send a command to DSH.
  global.__dshLiteDeferAutoMount = true;

  function classicUrl() {
    var url = new URL(global.location.href);
    if (/\/dsh-lite(?:\.html)?$/.test(url.pathname)) url.pathname = '/';
    url.searchParams.set('target', 'dsh');
    url.searchParams.set('view', 'classic');
    return url.toString();
  }

  function showProblem(message) {
    var status = global.document.getElementById('connection-status');
    var banner = global.document.getElementById('error-banner');
    var text = global.document.getElementById('error-text');
    if (status) { status.textContent = '连接不可用'; status.dataset.state = 'disconnected'; }
    if (text) text.textContent = message;
    if (banner) banner.hidden = false;
    ['error-retry', 'reconnect', 'rail-reconnect'].forEach(function (id) {
      var button = global.document.getElementById(id);
      if (button) button.onclick = function () { global.location.reload(); };
    });
  }

  // Only these bridge-owned, same-origin scripts can be retried. Keep their
  // exact paths so every request still passes through the Service Worker's
  // code-pin check; never execute a fetched blob or an arbitrary URL.
  var components = {
    'legacy-events': { adapter: 'DshLegacyAdapter', path: '/dsh-lite-legacy.js',
      name: '旧版 DSH 连接组件' },
    'remote-mux': { adapter: 'DshLiteRemoteAdapter', path: '/dsh-lite-adapter.js',
      name: '新版 DSH 连接组件' }
  };

  function missingComponents(profile) {
    var spec = components[profile];
    var result = [];
    if (!spec) return result;
    var adapter = global[spec.adapter];
    if (!adapter || adapter.profile !== profile) result.push({ path: spec.path, name: spec.name });
    if (!global.DshLiteUI || typeof global.DshLiteUI.mount !== 'function')
      result.push({ path: '/dsh-lite-ui.js', name: '手机界面组件' });
    return result;
  }

  function retryScript(path) {
    return new Promise(function (resolve) {
      var script = global.document.createElement('script');
      var settled = false;
      var timer = global.setTimeout(function () { finish(); }, 12000);
      function finish() {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        try { if (script.parentNode) script.parentNode.removeChild(script); } catch (_) {}
        resolve();
      }
      script.src = path;
      script.async = true;
      script.onload = finish;
      script.onerror = finish;
      try { global.document.head.appendChild(script); } catch (_) { finish(); }
    });
  }

  async function ensureComponents(profile) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var missing = missingComponents(profile);
      if (!missing.length) return;
      await Promise.all(missing.map(function (item) { return retryScript(item.path); }));
      if (!missingComponents(profile).length) return;
      if (attempt === 0) await new Promise(function (resolve) { global.setTimeout(resolve, 350); });
    }
    var absent = missingComponents(profile);
    if (absent.length) throw new Error('DSH 手机组件未加载：' + absent.map(function (item) {
      return item.name + '（' + item.path + '）';
    }).join('、') + '。已重试 2 次，请检查连接后刷新桥页面。');
  }

  async function selectAdapter() {
    var classic = classicUrl();
    ['classic-view', 'settings-classic'].forEach(function (id) {
      var link = global.document.getElementById(id);
      if (link) link.href = classic;
    });
    try {
      var e2ee = global.DshE2EE;
      if (!e2ee || !e2ee.available() || !global.__dshE2eeSecret ||
          !await e2ee.prove(true)) {
        throw new Error('加密连接或设备授权尚未准备好，请用电脑控制台复制完整地址重新打开。');
      }
      var response = await global.fetch('/__targets', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('无法识别电脑上的 DSH 版本（HTTP ' + response.status + '）。');
      var body = await response.json();
      var target = body && Array.isArray(body.targets) ? body.targets.find(function (item) {
        return item && item.id === 'dsh';
      }) : null;
      var profile = target && (target.profile || target.runtime && target.runtime.profile);
      if (!components[profile]) throw new Error('这台电脑的 DSH 协议尚未得到验证，请使用原版界面。');
      await ensureComponents(profile);
      var adapter = global[components[profile].adapter];
      global.DshLiteUI.mount(adapter);
    } catch (error) {
      showProblem(error && error.message || '连接 DSH 失败，请重试。');
    }
  }

  if (global.document.readyState === 'loading')
    global.document.addEventListener('DOMContentLoaded', selectAdapter, { once: true });
  else selectAdapter();
})(window);
