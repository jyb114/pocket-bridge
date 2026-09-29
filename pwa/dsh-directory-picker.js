// The bridge lists COMPUTER folders; this never opens the phone's file chooser.
// Install before DSH plugins, after the gateway's encrypted fetch wrappers.
(function (g) {
  'use strict';
  if (!g.fetch || !g.document || g.__pbDshDirectoryPickerInstalled) return;
  g.__pbDshDirectoryPickerInstalled = true;
  var baseFetch = g.fetch, doc = g.document, tail = Promise.resolve(), activeClose = null, pageGone = false;
  var COPY = {
    zh: { title: '选择电脑上的文件夹', help: '这里显示电脑的目录，不是手机文件。选择后将作为 DSH 项目目录。', path: '电脑目录路径', go: '打开路径', up: '上一级', choose: '选择此文件夹', cancel: '取消', loading: '正在读取电脑目录…', empty: '此目录没有子文件夹', roots: '磁盘与起始目录', retry: '重试', failed: '无法读取此目录，请检查路径或权限后重试。', auth: '连接授权已过期，请刷新桥页面后重试。', invalid: '电脑返回的目录信息无效，请重试。', close: '关闭目录选择' },
    en: { title: 'Choose a folder on your computer', help: 'These are computer folders, not phone files. The selected folder becomes the DSH project directory.', path: 'Computer folder path', go: 'Open path', up: 'Parent folder', choose: 'Select this folder', cancel: 'Cancel', loading: 'Reading computer folders…', empty: 'This folder has no subfolders', roots: 'Drives and starting folders', retry: 'Retry', failed: 'Could not read this folder. Check the path or permissions and retry.', auth: 'Connection authorization expired. Refresh the bridge page and retry.', invalid: 'The computer returned invalid folder information. Retry.', close: 'Close folder selection' },
    es: { title: 'Elige una carpeta del ordenador', help: 'Son carpetas del ordenador, no archivos del móvil. La carpeta elegida será el directorio del proyecto DSH.', path: 'Ruta de carpeta del ordenador', go: 'Abrir ruta', up: 'Carpeta superior', choose: 'Seleccionar esta carpeta', cancel: 'Cancelar', loading: 'Leyendo carpetas del ordenador…', empty: 'Esta carpeta no tiene subcarpetas', roots: 'Discos y carpetas iniciales', retry: 'Reintentar', failed: 'No se pudo leer la carpeta. Comprueba la ruta o los permisos y reintenta.', auth: 'La autorización caducó. Actualiza la página del puente y reintenta.', invalid: 'El ordenador devolvió información de carpetas no válida. Reintenta.', close: 'Cerrar selección de carpeta' }
  };
  COPY.zh.encryption = '缺少加密密钥或加密功能不可用。请从电脑桥控制台复制完整地址重新打开。';
  COPY.en.encryption = 'The encryption key or browser encryption is unavailable. Reopen the full address copied from the computer bridge.';
  COPY.es.encryption = 'Falta la clave de cifrado o el navegador no puede cifrar. Abre de nuevo la dirección completa copiada del puente del ordenador.';
  function words() {
    var language = (doc.documentElement.lang || (g.navigator && g.navigator.language) || 'en').toLowerCase();
    try { var saved = g.localStorage && (g.localStorage.getItem('dsh-lang') || g.localStorage.getItem('pb-lang') || g.localStorage.getItem('dsh-gw-lang')); if (saved) language = saved.toLowerCase(); } catch (_) {}
    return COPY[language.indexOf('zh') === 0 ? 'zh' : language.indexOf('es') === 0 ? 'es' : 'en'];
  }
  function aborted(signal) { return signal && signal.reason || new g.DOMException('The operation was aborted', 'AbortError'); }
  function failure(message) { var error = new Error(message); error.__pbDirectory = true; return error; }
  function relayAddress() {
    // The browser cannot see Cloudflare's request headers. Recognize its quick
    // tunnel host and other external HTTPS origins; direct LAN HTTP remains
    // usable even when WebCrypto is unavailable there.
    var url;
    try { url = new g.URL(g.location.href); } catch (_) { return false; }
    var host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (/\.trycloudflare\.com$/.test(host)) return true;
    if (url.protocol !== 'https:') return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.lan') || host.endsWith('.home.arpa') || host === '::1' ||
        /^f[cd][0-9a-f:]+$/.test(host) || /^fe[89ab][0-9a-f:]+$/.test(host)) return false;
    var parts = host.split('.');
    if (parts.length === 4 && parts.every(function (part) { return /^\d{1,3}$/.test(part) && Number(part) <= 255; })) {
      var first = Number(parts[0]), second = Number(parts[1]);
      if (first === 10 || first === 127 || first === 192 && second === 168 ||
          first === 172 && second >= 16 && second <= 31 || first === 169 && second === 254) return false;
    }
    return true;
  }
  function fetchDirectories(body, signal, w) {
    var init = { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal };
    var secret = g.__dshE2eeSecret;
    var e2ee = g.DshE2EE;
    if (secret && e2ee && typeof e2ee.encryptedFetch === 'function' &&
        (typeof e2ee.available !== 'function' || e2ee.available())) {
      // The encrypted request carries a marker, so the implicit fetch wrapper
      // skips it instead of encrypting the ciphertext a second time.
      return e2ee.encryptedFetch(secret, '/__dsh/directories', init);
    }
    // The gateway supplies this flag in its HTML. Its relay rule also depends
    // on the connection path, so a direct LAN page may still use plaintext.
    if (g.__dshE2eeConfigured === true && relayAddress()) throw failure(w.encryption);
    return baseFetch.call(g, '/__dsh/directories', init);
  }
  function el(tag, id, text) {
    var node = doc.createElement(tag); if (id) node.id = id; if (text !== undefined) node.textContent = text; return node;
  }
  function button(id, text, action) { var node = el('button', id, text); node.type = 'button'; node.addEventListener('click', action); return node; }
  function style() {
    if (doc.getElementById('pb-dir-style')) return;
    var sheet = el('style', 'pb-dir-style');
    sheet.textContent = '#pb-dir-overlay{position:fixed;inset:0;z-index:2147483646;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}#pb-dir-dialog{background:#fff;color:#17212b;width:min(600px,100%);max-height:90vh;display:flex;flex-direction:column;border-radius:14px;padding:16px;box-sizing:border-box;font:15px/1.45 system-ui,sans-serif;box-shadow:0 16px 60px #0006}#pb-dir-dialog *{box-sizing:border-box}#pb-dir-dialog h2{font-size:19px;margin:0 0 8px}#pb-dir-help{margin:0 0 12px;color:#4b5563}#pb-dir-form,#pb-dir-footer,#pb-dir-roots{display:flex;gap:8px;flex-wrap:wrap}#pb-dir-path{flex:1;min-width:140px;padding:10px;border:1px solid #8b95a5;border-radius:6px;font:inherit}#pb-dir-dialog button{font:inherit;padding:9px 12px;background:#edf2f7;color:inherit;border:1px solid #8b95a5;border-radius:7px;cursor:pointer;min-height:42px}#pb-dir-dialog button:focus-visible,#pb-dir-path:focus-visible{outline:3px solid #1769d2;outline-offset:2px}#pb-dir-dialog button:disabled{opacity:.5;cursor:default}#pb-dir-dialog button[data-path]{text-align:left;overflow-wrap:anywhere}#pb-dir-roots{margin:8px 0}#pb-dir-list{overflow:auto;min-height:100px;max-height:45vh;flex:1;display:flex;flex-direction:column;gap:6px;padding:6px 0}#pb-dir-status{margin:8px 0;overflow-wrap:anywhere}#pb-dir-status[role=alert]{color:#a21d27}#pb-dir-current{overflow-wrap:anywhere;margin:8px 0;font-size:13px}#pb-dir-footer{justify-content:flex-end;margin-top:10px}#pb-dir-choose{background:#1769d2!important;color:#fff!important;border-color:#1769d2!important}@media(max-width:480px){#pb-dir-overlay{padding:8px}#pb-dir-dialog{max-height:94vh;padding:12px}#pb-dir-footer button{flex:1}}@media(prefers-color-scheme:dark){#pb-dir-dialog{background:#19212b;color:#f3f4f6}#pb-dir-help{color:#cbd5e1}#pb-dir-dialog button{background:#293645}#pb-dir-path{background:#111827;color:#f3f4f6}#pb-dir-status[role=alert]{color:#ffb2b8}}';
    (doc.head || doc.body).appendChild(sheet);
  }
  function openPicker(signal) {
    if (pageGone) return Promise.resolve(null);
    if (signal && signal.aborted) return Promise.reject(aborted(signal));
    style();
    return new Promise(function (resolve, reject) {
      var w = words(), closed = false, generation = 0, request = null, requestTimer = null, selected = null, lastPath, focusBefore = doc.activeElement;
      var overlay = el('div', 'pb-dir-overlay'), panel = el('section', 'pb-dir-dialog');
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'pb-dir-title');
      panel.appendChild(el('h2', 'pb-dir-title', w.title)); panel.appendChild(el('p', 'pb-dir-help', w.help));
      var form = el('form', 'pb-dir-form'), input = el('input', 'pb-dir-path');
      input.type = 'text'; input.setAttribute('aria-label', w.path); input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
      var go = button('pb-dir-go', w.go, function () { load(input.value.trim()); });
      form.appendChild(input); form.appendChild(go); form.addEventListener('submit', function (event) { event.preventDefault(); load(input.value.trim()); }); panel.appendChild(form);
      var roots = el('div', 'pb-dir-roots'); roots.setAttribute('aria-label', w.roots); panel.appendChild(roots);
      var up = button('pb-dir-up', w.up, function () { if (selected && selected.parent) load(selected.parent); }); up.disabled = true; panel.appendChild(up);
      var current = el('p', 'pb-dir-current'), status = el('p', 'pb-dir-status'), list = el('div', 'pb-dir-list');
      status.setAttribute('aria-live', 'polite'); panel.appendChild(current); panel.appendChild(status); panel.appendChild(list);
      var retry = button('pb-dir-retry', w.retry, function () { load(lastPath); }); retry.hidden = true; panel.appendChild(retry);
      var footer = el('div', 'pb-dir-footer');
      var cancel = button('pb-dir-cancel', w.cancel, function () { finish(null); });
      var choose = button('pb-dir-choose', w.choose, function () { if (selected && selected.path) finish(selected.path); }); choose.disabled = true;
      footer.appendChild(cancel); footer.appendChild(choose); panel.appendChild(footer); overlay.appendChild(panel); doc.body.appendChild(overlay);
      var dynamicButtons = [];
      function finish(value, error) {
        if (closed) return; closed = true; generation++;
        if (request) request.abort();
        if (requestTimer) g.clearTimeout(requestTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        doc.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        activeClose = null;
        try { if (focusBefore && focusBefore.isConnected !== false && focusBefore.focus) focusBefore.focus(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      }
      function onAbort() { finish(null, aborted(signal)); }
      function onKey(event) {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
        if (event.key !== 'Tab') return;
        var nodes = [input, go].concat(dynamicButtons, [up, retry, cancel, choose]).filter(function (node) { return node.isConnected !== false && !node.disabled && !node.hidden; });
        var at = nodes.indexOf(doc.activeElement), next = event.shiftKey ? (at <= 0 ? nodes.length - 1 : at - 1) : (at < 0 || at === nodes.length - 1 ? 0 : at + 1);
        if (nodes.length) { event.preventDefault(); nodes[next].focus(); }
      }
      function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
      function directoryButton(parent, item) {
        if (!item || typeof item.path !== 'string' || !item.path || typeof item.name !== 'string') return;
        var node = button(null, item.name, function () { load(item.path); }); node.setAttribute('data-path', item.path); parent.appendChild(node); dynamicButtons.push(node);
      }
      async function load(folder) {
        if (closed) return;
        lastPath = folder; var ticket = ++generation;
        if (request) request.abort(); if (requestTimer) g.clearTimeout(requestTimer); request = new g.AbortController(); var activeRequest = request;
        selected = null; choose.disabled = true; up.disabled = true; retry.hidden = true;
        clear(list); status.textContent = w.loading; status.setAttribute('role', 'status'); current.textContent = '';
        var timeout = requestTimer = g.setTimeout(function () {
          if (closed || ticket !== generation || activeRequest.signal.aborted) return;
          activeRequest.abort(); status.setAttribute('role', 'alert'); status.textContent = w.failed; retry.hidden = false;
        }, 12000);
        try {
          var body = typeof folder === 'string' && folder ? { path: folder } : {};
          var response = await fetchDirectories(body, activeRequest.signal, w);
          // A directory permission denial is also HTTP 403. Only the bridge's
          // explicit proof header (or a 401) means the phone authorization has
          // expired; calling every 403 that misled users into refreshing forever.
          if (!response.ok) {
            var needProof = response.headers && response.headers.get &&
              response.headers.get('x-dsh-need-proof') === '1';
            throw failure(response.status === 401 || needProof ? w.auth :
              w.failed + ' (HTTP ' + response.status + ')');
          }
          var data = await response.json();
          if (!data || (data.path !== null && typeof data.path !== 'string') || !Array.isArray(data.roots) || !Array.isArray(data.directories)) throw failure(w.invalid);
          if (closed || ticket !== generation || activeRequest.signal.aborted) return;
          selected = { path: data.path || '', parent: typeof data.parent === 'string' ? data.parent : null };
          input.value = selected.path; current.textContent = selected.path; choose.disabled = !selected.path; up.disabled = !selected.parent;
          clear(roots); dynamicButtons = [];
          data.roots.forEach(function (item) { directoryButton(roots, item); }); data.directories.forEach(function (item) { directoryButton(list, item); });
          status.textContent = list.firstChild ? '' : w.empty;
        } catch (error) {
          if (closed || ticket !== generation || activeRequest.signal.aborted) return;
          status.setAttribute('role', 'alert'); status.textContent = error.__pbDirectory ? error.message : w.failed; retry.hidden = false;
        } finally {
          g.clearTimeout(timeout); if (requestTimer === timeout) requestTimer = null;
        }
      }
      activeClose = function () { finish(null); }; doc.addEventListener('keydown', onKey);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      input.focus(); load();
    });
  }
  function pick(signal) {
    var queued = tail.then(function () { return openPicker(signal); });
    tail = queued.then(function () {}, function () {});
    if (!signal) return queued;
    return new Promise(function (resolve, reject) {
      function abort() { reject(aborted(signal)); }
      if (signal.aborted) { reject(aborted(signal)); return; }
      signal.addEventListener('abort', abort, { once: true });
      queued.then(function (value) { signal.removeEventListener('abort', abort); resolve(value); }, function (error) { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  // Official DSH desktop-directory interface: its native UI calls pick() directly.
  g.__DSH_DIRECTORY_PICKER__ = { pick: function () { return pick(); }, __pocketBridge: true };
  var wrapped = function (input, init) {
    var url, method;
    try {
      url = new g.URL(typeof input === 'string' || input instanceof g.URL ? String(input) : input.url, doc.baseURI || g.location.href);
      method = String(init && init.method || input && input.method || 'GET').toUpperCase();
    } catch (_) { return baseFetch.call(g, input, init); }
    if (url.origin !== g.location.origin || url.pathname !== '/api/directoryPicker/pick' || method !== 'POST') return baseFetch.call(g, input, init);
    var signal = init && init.signal || input && input.signal;
    return (async function () {
      var text, envelope;
      try {
        if (init && typeof init.body === 'string') text = init.body;
        else if (g.Request) text = await new g.Request(input && typeof input.clone === 'function' ? input.clone() : input, init).text();
        else return baseFetch.call(g, input, init);
        if (typeof text !== 'string' || text.length > 65536) return baseFetch.call(g, input, init);
        envelope = JSON.parse(text);
      } catch (_) { return baseFetch.call(g, input, init); }
      if (!envelope || envelope.type !== 'client-request' || envelope.method !== 'directoryPicker/pick' || typeof envelope.rpcId !== 'string' || !envelope.rpcId || envelope.rpcId.length > 1024 || !envelope.payload || !envelope.payload.args || typeof envelope.payload.args !== 'object' || Array.isArray(envelope.payload.args)) return baseFetch.call(g, input, init);
      var value = await pick(signal);
      return new g.Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: value } }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    })();
  };
  ['__dshE2ee', '__dshE2eeReq', '__dshProofRetry'].forEach(function (flag) { if (baseFetch[flag]) wrapped[flag] = baseFetch[flag]; });
  wrapped.__dshDirectoryPicker = true; g.fetch = wrapped;
  if (g.addEventListener) {
    g.addEventListener('pagehide', function () { pageGone = true; if (activeClose) activeClose(); });
    g.addEventListener('pageshow', function () { pageGone = false; });
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
