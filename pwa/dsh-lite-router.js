(function (global) {
  'use strict';

  // Both adapters are small. Select by the gateway's observed runtime profile
  // before either can open a connection or send a command to DSH.
  global.__dshLiteDeferAutoMount = true;

  function t(message, vars) {
    var translated = message;
    try {
      if (global.DshI18n && typeof global.DshI18n.t === 'function')
        translated = global.DshI18n.t(message, vars);
    } catch (_) { /* Startup guidance remains available without localization. */ }
    if (typeof translated !== 'string' || !translated) translated = message;
    return translated.replace(/\{(\w+)\}/g, function (match, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }

  function routerProblem(message, vars) {
    var error = new Error(t(message, vars));
    error.routerMessage = error.message;
    return error;
  }

  function showProblem(message) {
    var status = global.document.getElementById('connection-status');
    var banner = global.document.getElementById('error-banner');
    var text = global.document.getElementById('error-text');
    if (status) { status.textContent = t('连接不可用'); status.dataset.state = 'disconnected'; }
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
    if (absent.length) throw routerProblem('DSH 手机组件未加载：{components}。已重试 2 次，请检查连接后刷新桥页面。', {
      components: absent.map(function (item) {
        return t('{name}（{path}）', { name: t(item.name), path: item.path });
      }).join(t('、'))
    });
  }

  async function selectAdapter() {
    ['classic-view', 'settings-classic'].forEach(function (id) {
      var link = global.document.getElementById(id);
      if (link) { link.hidden = true; link.removeAttribute('href'); }
    });
    try {
      var e2ee = global.DshE2EE;
      if (!e2ee || !e2ee.available() || !global.__dshE2eeSecret ||
          !await e2ee.prove(true)) {
        throw routerProblem('加密连接或设备授权尚未准备好，请用电脑控制台复制完整地址重新打开。');
      }
      var response = await global.fetch('/__targets', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw routerProblem('无法识别电脑上的 DSH 版本（HTTP {status}）。', { status: response.status });
      var body = await response.json();
      var target = body && Array.isArray(body.targets) ? body.targets.find(function (item) {
        return item && item.id === 'dsh';
      }) : null;
      var profile = target && (target.profile || target.runtime && target.runtime.profile);
      if (!components[profile]) throw routerProblem('这台电脑的 DSH 协议尚未得到验证。请在电脑上检查 DSH 版本后重新连接；手机不会改用未加密的原版界面。');
      await ensureComponents(profile);
      var adapter = global[components[profile].adapter];
      global.DshLiteUI.mount(adapter, { profile: profile, runtime: target.runtime || {},
        version: target.version || null, kind: target.kind || null });
    } catch (error) {
      showProblem(error && error.routerMessage || t('连接 DSH 失败，请重试。'));
    }
  }

  if (global.document.readyState === 'loading')
    global.document.addEventListener('DOMContentLoaded', selectAdapter, { once: true });
  else selectAdapter();
})(window);
