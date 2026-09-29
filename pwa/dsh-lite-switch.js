(function () {
  'use strict';
  var current = new URL(location.href);
  var agent = String(navigator.userAgent || '');
  var mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(agent) ||
    (/Macintosh/i.test(agent) && Number(navigator.maxTouchPoints || 0) > 1);
  // The bridge-owned phone page does not fetch DSH's plugin graph. This runs
  // at the start of <head>, before the official module links are parsed.
  var runtime = window.__POCKET_BRIDGE_DSH__;
  var supportedPhoneShell = runtime &&
    (runtime.profile === 'remote-mux' || runtime.profile === 'legacy-events');
  var encryptedPhoneShell = window.DshE2EE && window.DshE2EE.available &&
    window.DshE2EE.available() && window.__dshE2eeSecret;
  if (mobile && supportedPhoneShell && encryptedPhoneShell &&
      current.searchParams.get('view') !== 'classic') {
    current.searchParams.set('target', 'lite');
    if (typeof location.replace === 'function') location.replace(current.toString());
    else location.assign(current.toString());
    return;
  }
  if (document.getElementById('pb-dsh-lite-switch')) return;
  function show() {
    if (document.getElementById('pb-dsh-lite-switch')) return;
    var button = document.createElement('button');
    button.id = 'pb-dsh-lite-switch';
    button.type = 'button';
    button.textContent = '手机界面';
    button.setAttribute('aria-label', '打开桥的 DSH 手机界面');
    button.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483645;' +
      'padding:7px 11px;border-radius:999px;border:1px solid #cbd5e1;' +
      'background:#fff;color:#174c86;box-shadow:0 2px 10px #0002;' +
      'font:600 13px system-ui,-apple-system,sans-serif;cursor:pointer';
    button.addEventListener('click', function () {
      var url = new URL(location.href);
      url.searchParams.set('target', 'lite');
      url.searchParams.delete('view');
      // URL keeps /k/<access-key> and #k=<E2EE-secret> on this device.
      location.assign(url.toString());
    });
    document.body.appendChild(button);
  }
  // DOMContentLoaded waits for the official ES-module graph. Show the escape
  // button as soon as <body> exists even when a plugin import is stalled.
  var tries = 0;
  (function whenBody() {
    if (document.body) show();
    else if (tries++ < 200) setTimeout(whenBody, 50);
  })();
})();
