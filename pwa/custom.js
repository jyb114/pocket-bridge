/* ============================================================================
 * 手机端自定义脚本 —— 想加功能就改这里
 * ============================================================================
 *
 * 和 custom.css 配套：那个改外观，这个加行为。
 *   /mobile 给手机端加一个赛博朋克风格的电脑监控面板
 *   agent 就会来改这两个文件，手机端几秒后自动生效。
 *
 * ---------------------------------------------------------------------------
 * 什么时候跑
 * ---------------------------------------------------------------------------
 * 每次页面加载完、以及每次这个文件被改动之后，都会调用一次下面的函数。
 * 所以**要写成可以重复执行的**（别往页面上无限追加元素，先清掉旧的）。
 *
 * ---------------------------------------------------------------------------
 * 能用的东西
 * ---------------------------------------------------------------------------
 *   window.DshE2EE    加密模块（能用它安全地请求电脑）
 *   window.DshVoice   语音输入模块
 *   fetch()           普通请求（会自动解密加密的响应）
 *
 * 想读电脑上的状态（CPU、内存、磁盘），有两种做法：
 *   1. 让 agent 在电脑上加一个接口，手机这边 fetch 它
 *   2. 直接用 DSH 已有的接口
 */

(function () {
  'use strict';

  // The file can be evaluated again after a customization update. Retire the
  // previous observers and listeners before installing this copy.
  var previous = window.__pocketBridgeCustomOverlay;
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  var cleanup = [];
  var measuring = false;
  var frame = 0;
  var dockResize = null;
  var domChanges = null;
  var observedDock = null;
  var observedComposer = null;
  var fallbackTimer = null;
  var mutationTimer = null;

  function listen(target, name, handler, options) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(name, handler, options);
    cleanup.push(function () { target.removeEventListener(name, handler, options); });
  }

  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return null;
    var r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 16 ? r : null;
  }

  function composerAround(editor, viewportHeight) {
    var editorRect = rectOf(editor);
    if (!editorRect || editorRect.bottom < viewportHeight * 0.45 || editorRect.top > viewportHeight) return null;
    var chosen = editor;
    var maxHeight = Math.max(220, Math.min(480, viewportHeight * 0.65));
    var parent = editor.parentElement;
    for (var depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      if (/^(BODY|HTML|MAIN)$/.test(parent.tagName || '')) break;
      var r = rectOf(parent);
      if (!r || r.height > maxHeight || r.bottom > viewportHeight + 30) break;
      if (r.top <= editorRect.top && r.bottom >= editorRect.bottom) chosen = parent;
    }
    return chosen;
  }

  function observeSize(dock, composer) {
    if (!dockResize) return;
    if (observedDock !== dock) {
      if (observedDock) dockResize.unobserve(observedDock);
      observedDock = dock;
      if (dock) dockResize.observe(dock);
    }
    if (observedComposer !== composer) {
      if (observedComposer) dockResize.unobserve(observedComposer);
      observedComposer = composer;
      if (composer && composer !== dock) dockResize.observe(composer);
    }
  }

  function measureDockOverlap() {
    frame = 0;
    var dock = document.getElementById('dsh-gw-dock');
    if (!dock) { observeSize(null, null); return; }
    var dockRect = dock.getBoundingClientRect();
    var viewportHeight = window.visualViewport
      ? window.visualViewport.height + window.visualViewport.offsetTop
      : window.innerHeight;
    var editors = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], input[type="text"]');
    var overlap = false;
    var composer = null;
    for (var i = 0; i < editors.length; i++) {
      if (dock.contains(editors[i])) continue;
      var candidate = composerAround(editors[i], viewportHeight);
      if (!candidate) continue;
      var r = candidate.getBoundingClientRect();
      if (!composer || r.bottom > composer.getBoundingClientRect().bottom) composer = candidate;
      if (dockRect.left < r.right + 8 && dockRect.right + 8 > r.left &&
          dockRect.top < r.bottom + 8 && dockRect.bottom + 8 > r.top) {
        overlap = true;
        composer = candidate;
        break;
      }
    }
    dock.classList.toggle('dsh-custom-composer-overlap', overlap);
    observeSize(dock, composer);
  }

  function scheduleDockMeasure() {
    if (!measuring || frame) return;
    frame = window.requestAnimationFrame
      ? window.requestAnimationFrame(measureDockOverlap)
      : window.setTimeout(measureDockOverlap, 16);
  }

  function onDomChanges() {
    // Streamed replies can add many nodes. Check at most once per 100 ms;
    // ResizeObserver and input events still react to composer growth promptly.
    if (mutationTimer) return;
    mutationTimer = window.setTimeout(function () {
      mutationTimer = null;
      scheduleDockMeasure();
    }, 100);
  }

  function startDockMeasure() {
    if (measuring) { scheduleDockMeasure(); return; }
    measuring = true;
    if (window.ResizeObserver) dockResize = new ResizeObserver(scheduleDockMeasure);
    else fallbackTimer = window.setInterval(scheduleDockMeasure, 700);
    if (window.MutationObserver) {
      domChanges = new MutationObserver(onDomChanges);
      domChanges.observe(document.documentElement, { childList: true, subtree: true });
    }
    listen(window, 'resize', scheduleDockMeasure);
    listen(document, 'input', scheduleDockMeasure, true);
    listen(document, 'focusin', scheduleDockMeasure, true);
    listen(document, 'focusout', scheduleDockMeasure, true);
    listen(document, 'scroll', scheduleDockMeasure, true);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', scheduleDockMeasure);
      listen(window.visualViewport, 'scroll', scheduleDockMeasure);
    }
    scheduleDockMeasure();
  }

  /**
   * 每次加载/更新时调用。写成幂等的 —— 重复执行不该出现重复元素。
   */
  function apply() {
    startDockMeasure();
    // 先清掉上一次加的东西（如果有）
    var old = document.getElementById('dsh-custom-panel');
    if (old) old.remove();

    // ── 系统通知：网页本身就能收，不把人引到另一个通知 App ─────────────
    // boot.js 会先创建这个按钮；少数页面异步慢一点时再等一小会儿。
    var renameNotify = function () {
      var button = document.getElementById('dsh-gw-notify');
      if (!button) return false;
      if (/怎么开启通知/.test(button.textContent)) button.textContent = '设置系统通知';
      else if (/开启通知/.test(button.textContent)) button.textContent = '开启系统通知';
      return true;
    };
    if (!renameNotify()) {
      var tries = 0;
      var timer = setInterval(function () { if (renameNotify() || ++tries >= 20) clearInterval(timer); }, 250);
    }

    // ── iPhone 首次使用说明 ─────────────────────────────────────────────
    // iOS 只有从 Safari「添加到主屏幕」打开的网页应用才能稳定地接收系统通知。
    // 这张卡不依赖核心页面代码；即使上游界面更新，也不会丢掉这条关键说明。
    var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    var isAndroid = /Android/i.test(navigator.userAgent || '');
    var lang = String(navigator.language || '').toLowerCase();
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if ((isIOS || isAndroid) && !standalone && !document.getElementById('dsh-home-screen-tip')) {
      var tip = document.createElement('section');
      tip.id = 'dsh-home-screen-tip';
      tip.setAttribute('role', 'status');
      tip.style.cssText = 'position:fixed;left:12px;right:12px;bottom:84px;z-index:2147483000;' +
        'padding:14px 16px;border:1px solid rgba(104,185,255,.34);border-radius:16px;' +
        'background:rgba(18,27,39,.96);box-shadow:0 14px 44px rgba(0,0,0,.35);' +
        'color:#eef6ff;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
      var words;
      if (lang.indexOf('es') === 0) {
        words = isIOS
          ? ['Añade Pocket Bridge a la pantalla de inicio', 'Abre esta página en <b>Safari</b> y toca <b>Compartir ↑</b> → <b>Añadir a pantalla de inicio</b> → Añadir. Después abre el icono Pocket Bridge y activa las notificaciones. No necesitas instalar otra app.', 'Entendido']
          : ['Añade Pocket Bridge a la pantalla de inicio', 'Abre el menú del navegador → <b>Añadir a pantalla de inicio</b> o <b>Instalar app</b>. Después abre el icono Pocket Bridge y activa las notificaciones.', 'Entendido'];
      } else if (lang.indexOf('zh') === 0) {
        words = isIOS
          ? ['先把 Pocket Bridge 添加到主屏幕', '请用 <b>Safari</b> 打开本页，点底部 <b>分享 ↑</b> → <b>添加到主屏幕</b> → 添加。以后从主屏的 Pocket Bridge 图标进入，再点“设置系统通知”。无需下载任何 App。', '我知道了']
          : ['先把 Pocket Bridge 添加到主屏幕', '务必从电脑控制台复制的<b>完整加密链接</b>打开本页，再从浏览器菜单选 <b>添加到主屏幕</b> 或 <b>安装应用</b>。不要在配对页或根页面添加；完整链接末尾的密钥会随主屏入口保存。', '我知道了'];
      } else {
        words = isIOS
          ? ['Add Pocket Bridge to Home Screen first', 'Open this page in <b>Safari</b>, then tap <b>Share ↑</b> → <b>Add to Home Screen</b> → Add. Open the Pocket Bridge icon afterwards and enable notifications. No extra app is needed.', 'Got it']
          : ['Add Pocket Bridge to Home Screen first', 'Open your browser menu → <b>Add to Home screen</b> or <b>Install app</b>. Open the Pocket Bridge icon afterwards and enable notifications.', 'Got it'];
      }
      tip.innerHTML = '<strong style="display:block;font-size:15px;margin-bottom:5px">' + words[0] + '</strong>' +
        '<span style="display:block;color:#b9cbe0">' + words[1] + '</span>' +
        '<button type="button" style="margin-top:10px;border:0;border-radius:9px;padding:7px 11px;background:#3d8cff;color:white;font:inherit">' + words[2] + '</button>';
      tip.querySelector('button').addEventListener('click', function () { tip.remove(); });
      document.body.appendChild(tip);
    }
    //
    // 例子：在页面底部加一个小条
    //
    // var bar = document.createElement('div');
    // bar.id = 'dsh-custom-panel';
    // bar.style.cssText = 'position:fixed;left:12px;bottom:70px;z-index:2147483000;' +
    //   'background:#1b1b1c;border:1px solid #2c2c2e;border-radius:10px;' +
    //   'padding:8px 12px;font-size:12.5px;color:#81858c';
    // bar.textContent = '自定义面板';
    // document.body.appendChild(bar);
  }

  // 首次 + 每次文件更新后都会调
  if (document.readyState === 'loading') {
    listen(document, 'DOMContentLoaded', apply);
  } else {
    apply();
  }

  // 网关检测到文件变了会发这个消息，收到就重跑一次
  if ('serviceWorker' in navigator) {
    listen(navigator.serviceWorker, 'message', function (ev) {
      if (ev.data && ev.data.type === 'dsh-custom-changed') apply();
    });
  }
  listen(window, 'dsh-custom-changed', apply);
  window.__pocketBridgeCustomOverlay = { dispose: function () {
    measuring = false;
    if (dockResize) dockResize.disconnect();
    if (domChanges) domChanges.disconnect();
    if (fallbackTimer) window.clearInterval(fallbackTimer);
    if (mutationTimer) window.clearTimeout(mutationTimer);
    if (frame) {
      if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    }
    cleanup.forEach(function (stop) { stop(); });
  } };
})();
