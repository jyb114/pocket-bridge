// DSH 移动端网关 — 浏览器侧引导脚本
//
// 由中间层注入到 DSH 页面。它负责三件事：
//   1. 注册 service worker（Web Push 的前提）
//   2. 取回 VAPID 公钥
//   3. 在右下角放一个「开启通知」按钮 —— 通知权限只能在用户手势里请求，
//      所以必须有这么一个可点的东西，不能自动弹
//
// 刻意做得尽量低调：只在这一台设备还没授权时出现，授权后就消失。
(function () {
  'use strict';

  var TAG = '[dsh-gw]';

  // ── 0. 首次进入时的风险提示 ────────────────────────────────────────────────
  // 这个页面的访问权 == 你电脑的完全控制权。很多人不会意识到这一点，
  // 所以第一次进来时明确说一次，之后就不要再打扰。
  function maybeShowSecurityNotice() {
    var KEY = 'dsh-gw-security-notice-v1';
    try {
      if (localStorage.getItem(KEY) === 'seen') return;
    } catch (err) {
      return; // 存不了就别弹了，免得每次都烦人
    }

    var bar = document.createElement('div');
    bar.id = 'dsh-gw-security';      // 给测试用：这条文案也得跟着语言走，要能查到
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'background:#3a2f0b', 'color:#ffe9a8', 'border-bottom:1px solid #6b5a1f',
      'padding:12px 16px', 'font-size:13px', 'line-height:1.7',
      'font-family:-apple-system,system-ui,sans-serif',
      'display:flex', 'gap:12px', 'align-items:flex-start'
    ].join(';');

    var textPart = document.createElement('div');
    textPart.style.flex = '1';
    // ★ 这条提示是我们自己写的，必须跟着使用者选的语言走（2026-09-27）。
    //   多语言检查发现的就是这一条：
    //   DSH 的界面已经切成英文了，这条还是中文 —— 因为它的文案硬编码在这里。
    textPart.innerHTML = '<b>' + T().secTitle + '</b><br>' + T().secBody;

    var btn = document.createElement('button');
    btn.textContent = T().secOk;    btn.style.cssText = [
      'flex:none', 'padding:8px 14px', 'border-radius:8px', 'cursor:pointer',
      'background:#ffe9a8', 'color:#3a2f0b', 'border:0', 'font-weight:600',
      'font-size:13px', 'font-family:inherit'
    ].join(';');
    btn.addEventListener('click', function () {
      try { localStorage.setItem(KEY, 'seen'); } catch (err) { }
      bar.remove();
    });

    bar.appendChild(textPart);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  /**
   * 代码被改动时的红色横幅。
   *
   * 为什么必须显眼：这一层（Service Worker 核对代码指纹）是**唯一**能发现
   * 「隧道把发给手机的 JS 换掉了」的东西。它要是只打在控制台里，
   * 使用者看到的是一个完全正常的页面 —— 被掉包的代码悄悄读走密钥，
   * 而他什么都不知道。防线不接警报器等于没有防线。
   *
   * 和其它提示条的区别：这条**不记忆**。别的提示点一次「我知道了」就永远
   * 不再出现（那是通知该有的样子）；这一条每次加载都弹 —— 因为它的含义是
   * 「有人正在改发给你的程序」，那是个持续存在的状态，不是一次性通知。
   */
  function showTamperAlert(which) {
    if (document.getElementById('dsh-tamper-bar')) return;
    if (!document.body) return;

    var bar = document.createElement('div');
    bar.id = 'dsh-tamper-bar';
    // z-index 拉满：这条不能被任何页面元素盖住
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'background:#4a1614', 'color:#ffd9d5', 'border-bottom:2px solid #a33',
      'padding:14px 16px', 'font-size:13.5px', 'line-height:1.75',
      'font-family:-apple-system,system-ui,sans-serif',
      'box-shadow:0 6px 24px #000a'
    ].join(';');

    var text = document.createElement('div');
    text.innerHTML = fmt(T().tamperBody, {
      which: '<code style="background:#00000040;padding:1px 5px;border-radius:4px">' +
        String(which || '').replace(/[<>&]/g, '') + '</code>'
    });

    var btn = document.createElement('button');
    btn.textContent = T().tamperOk;
    btn.style.cssText = [
      'margin-top:10px', 'padding:8px 16px', 'border-radius:8px', 'cursor:pointer',
      'background:#ffd9d5', 'color:#4a1614', 'border:0', 'font-weight:600',
      'font-size:13px', 'font-family:inherit'
    ].join(';');
    btn.addEventListener('click', function () { bar.remove(); });

    // 「我刚更新过」—— 把 pin 换成当前这一版。
    //
    // 为什么必须有这个按钮：pin 原本是一次写入、永不允许更新，本意是防
    // 「掉包代码顺便改掉 pin」。但它把**电脑那边正常发版**也一起挡了 ——
    // 一更新，手机就永远卡在旧代码上，还弹红字说"程序被改过"。
    // 防住了攻击，也防住了自己。
    //
    // 所以改成**人来做这个决定**：只有你点了这个按钮，才会重新 pin。
    // 页脚本自己不会调它。代价是攻击者要是能改页面代码，也能伪造这次点击 ——
    // 但那种情况下这一层本来就不是防线了（它防的是**局部**改动，
    // 不是整个页面被重写）。
    var fix = document.createElement('button');
    fix.textContent = T().tamperFix;
    fix.style.cssText = [
      'margin:10px 0 0 8px', 'padding:8px 16px', 'border-radius:8px', 'cursor:pointer',
      'background:transparent', 'color:#ffd9d5', 'border:1px solid #a33',
      'font-weight:600', 'font-size:13px', 'font-family:inherit'
    ].join(';');
    fix.addEventListener('click', function () {
      if (!confirm(T().tamperConfirm)) return;
      fix.disabled = true;
      fix.textContent = T().updating;
      fetch('/code-manifest.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (m) {
          return navigator.serviceWorker.ready.then(function (reg) {
            if (!reg.active) throw new Error(T().noSW);
            reg.active.postMessage({ type: 'dsh-repin-code', manifest: m });
          });
        })
        .then(function () {
          fix.textContent = T().reloading;
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (e) {
          fix.disabled = false;
          fix.textContent = fmt(T().retryFail, { msg: e.message });
        });
    });

    text.appendChild(document.createElement('br'));
    text.appendChild(btn);
    text.appendChild(fix);
    bar.appendChild(text);
    document.body.appendChild(bar);
  }

  // ── 1. 注册 service worker ─────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function () { console.log(TAG, 'service worker 已注册'); })
      .catch(function (err) { console.warn(TAG, 'service worker 注册失败', err); });
  } else {
    return; // 不支持就不必往下走了
  }

  // ── 2. 订阅 ────────────────────────────────────────────────────────────────
  function b64urlToUint8(b64) {
    var pad = new Array((4 - (b64.length % 4)) % 4 + 1).join('=');
    var s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }

  function enable(btn) {
    setBusy(btn, T().onDoing);
    subscribe()
      .then(function (r) {
        if (r === 'denied') { toast(T().denied, 4000); return; }
        if (r === 'unsupported') { toast(T().fail, 4000); return; }
        toast(T().done, 2500);
        var card = document.getElementById('dsh-gw-notifycard');
        if (card) card.remove();
        var b = document.getElementById('dsh-gw-notify');
        if (b) b.remove();
      })
      .catch(function (err) {
        console.error(TAG, err);
        toast(T().fail, 4000);
        if (btn) btn.disabled = false;
      });
  }

  /**
   * 这台浏览器到底有没有通知能力。
   *
   * ★ 不能写 `if (!('Notification' in window))` —— 属性存在但值是 undefined
   *   的浏览器是有的（测试里一造就现形：读到 `.permission` 直接抛）。
   *   这种地方抛异常的后果很不划算：整段引导都没了，而使用者只会觉得
   *   「这功能不存在」。
   */
  function hasNotify() {
    return typeof window.Notification !== 'undefined' && !!window.Notification;
  }

  /**
   * 真的去订阅一次（不碰界面）。
   *
   * ★ 三条路径都收在这里，确保**不用装任何 App**的网页推送入口清晰可见。
   *   网页推送本来就写好了，问题在于曾把「装 ntfy、抄主题名」
   *   当成了主路，而把这条埋成右下角一个小按钮。
   *   现在：只要手机上开通一次，任务完成和地址变更都会直接弹到锁屏，
   *   不装 App、不抄主题名、不编辑任何配置。
   */
  function subscribe() {
    if (!hasNotify() || !navigator.serviceWorker || !window.PushManager) {
      return Promise.resolve('unsupported');
    }
    return window.Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') return 'denied';
      return fetch('/__push/vapid').then(function (r) { return r.text(); })
        .then(function (vapid) {
          if (!vapid) return 'unsupported';
          return navigator.serviceWorker.ready.then(function (reg) {
            // 已经有订阅就直接用它 —— 重复 subscribe 在某些浏览器上会抛
            return reg.pushManager.getSubscription().then(function (had) {
              if (had) return had;
              return reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: b64urlToUint8(vapid.trim())
              });
            });
          });
        })
        .then(function (sub) {
          if (!sub) return 'unsupported';
          return fetch('/__push/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sub)
          }).then(function (res) { return res && res.ok ? 'ok' : 'unsupported'; });
        });
    });
  }

  // ── 3. 引导卡片（一次点击，不装 App）────────────────────────────────────────
  //
  // 为什么是一张卡片而不是角落里一个小按钮：提醒入口必须容易发现和点击，
  // 藏在角上的按钮等于没有。
  //
  // 文案里**刻意不出现 ntfy / 主题名 / 订阅**这些词：那条路（装第三方 App）
  // 仍然保留给愿意折腾的人，但默认这条路是「点一下就好」。
  // 三种语言的文案自己带一份（和 first-load.js 同样的理由：这个文件可能在
  // i18n.js 之前执行，而且手机上第一屏就要用）。
  var NOTE_TEXT = {
    zh: {
      title: '要在这台手机上收提醒吗？',
      sub: '电脑上的活干完了、或者连接地址变了，都会直接弹到锁屏。不用装任何 App。',
      on: '开启提醒', later: '以后再说', onDoing: '正在开启…',
      denied: '通知被拒绝了 —— 去手机「设置」里允许这个网页的通知即可',
      done: '提醒已开启', fail: '这次没开成，稍后再试一次',
      iosTitle: 'iPhone 上要两步（不装 App）',
      iosSteps: '① 点 Safari 底部中间的「分享」→「添加到主屏幕」<br>' +
        '② 从主屏幕上那个图标打开这个页面，再点一次「开启提醒」就完成了',
      iosWhy: '这不是装 App：不下载、不占空间、不用 App Store。iOS 只允许这样打开的网页发提醒。',
      dshLangHint: 'DSH 自己还有一项语言设置（设置 → 通用 → 语言），那一项会盖过这里。' +
        '界面没跟着变的话，去那里再选一次。',
      dshNoSpanish: 'DSH 本身只有中文和英文两种界面，所以它的界面显示英文。',
      // ★ 下面这些是**我们自己写**的两条横幅和换版本按钮。原来全是硬编码中文 ——
      //   切换英文后目标界面已变化，但这两条仍是中文；多语言检查定位到这里。
      secTitle: '这是你的私人入口，不要分享',
      secBody: '这个地址等同于你电脑的完全控制权 —— 别人拿到它就能看到你的全部会话、' +
        '文件和操作，也能替你下指令。<br>如果已经分享过，请到电脑上打开控制台换一把访问密钥。',
      secOk: '我知道了',
      tamperBody: '<b style="font-size:15px">⚠️ 程序被改过，已拦下</b><br>' +
        '这次送来的 {which} 和你手机上存的那份对不上，<b>已经拒绝执行</b>。<br>' +
        '正常情况下它永远不该变。如果你没在电脑上更新过程序，' +
        '说明链路上有人正在改发给你的代码 —— <b>这时候别输入任何敏感内容</b>，' +
        '并考虑改用内网直连（同一个 WiFi 下的加密地址）。',
      tamperOk: '知道了',
      tamperFix: '我刚更新过，信任新版本',
      tamperConfirm: '你确认刚刚在电脑上更新过这套程序？\n\n' +
        '确认之后，手机将把**现在这一版**记为可信版本。\n' +
        '如果你没有更新过，请点「取消」，并改用同一个 WiFi 下的加密地址。',
      updating: '正在更新记录…',
      noSW: 'Service Worker 没在跑',
      reloading: '好了，正在重新加载…',
      retryFail: '重试（刚才失败：{msg}）'
    },
    en: {
      title: 'Get reminders on this phone?',
      sub: 'When a job finishes on your computer, or the address changes, it pops up on your lock screen. No app to install.',
      on: 'Turn on reminders', later: 'Not now', onDoing: 'Turning on…',
      denied: 'Notifications were blocked — allow them for this site in your phone settings',
      done: 'Reminders are on', fail: 'Could not turn it on — try again in a moment',
      iosTitle: 'Two steps on iPhone (no app)',
      iosSteps: '① Tap the Share button at the bottom of Safari → “Add to Home Screen”<br>' +
        '② Open this page from that new icon and tap “Turn on reminders”',
      iosWhy: 'This is not installing an app: nothing is downloaded, no App Store. iOS only lets web pages opened this way send notifications.',
      dshLangHint: 'DSH has its own language setting (Settings → General → Language) and it overrides this one. ' +
        'If the interface did not change, set it there too.',
      dshNoSpanish: 'DSH itself only ships Chinese and English, so its interface is in English.',
      secTitle: 'This is your private entrance — do not share it',
      secBody: 'This address is equivalent to full control of your computer: whoever has it can see all your ' +
        'sessions, files and actions, and can give instructions on your behalf.<br>' +
        'If you have already shared it, open the console on your computer and rotate the access key.',
      secOk: 'Got it',
      tamperBody: '<b style="font-size:15px">⚠️ The code was changed — blocked</b><br>' +
        'The {which} sent this time does not match what your phone stored, so it was <b>refused</b>.<br>' +
        'It should never change on its own. If you did not update anything on your computer, ' +
        'something on the path is rewriting the code sent to you — <b>do not type anything sensitive</b> ' +
        'and consider switching to the local network address (the encrypted one on the same Wi-Fi).',
      tamperOk: 'Got it',
      tamperFix: 'I just updated — trust this version',
      tamperConfirm: 'Did you just update this program on your computer?\n\n' +
        'If you confirm, the phone will mark the **current version** as trusted.\n' +
        'If you did not update anything, press Cancel and switch to the encrypted address on the same Wi-Fi.',
      updating: 'Updating the record…',
      noSW: 'The service worker is not running',
      reloading: 'Done — reloading…',
      retryFail: 'Retry (failed: {msg})'
    },
    es: {
      title: '¿Quieres recibir avisos en este teléfono?',
      sub: 'Cuando el trabajo en el ordenador termine, o cambie la dirección, aparecerá en la pantalla bloqueada. Sin instalar ninguna app.',
      on: 'Activar avisos', later: 'Ahora no', onDoing: 'Activando…',
      denied: 'Se bloquearon las notificaciones: permite las de este sitio en los ajustes del teléfono',
      done: 'Avisos activados', fail: 'No se pudo activar; inténtalo otra vez',
      iosTitle: 'Dos pasos en iPhone (sin app)',
      iosSteps: '① Pulsa Compartir en Safari → «Añadir a pantalla de inicio»<br>' +
        '② Abre esta página desde ese icono y pulsa «Activar avisos»',
      iosWhy: 'No es instalar una app: no se descarga nada ni hace falta la App Store. iOS solo deja avisar a las páginas abiertas así.',
      dshLangHint: 'DSH tiene su propio ajuste de idioma (Ajustes → General → Idioma) y ese manda sobre este. ' +
        'Si la interfaz no cambió, cámbialo también ahí.',
      dshNoSpanish: 'DSH solo tiene chino e inglés, así que su interfaz aparece en inglés.',
      secTitle: 'Esta es tu entrada privada: no la compartas',
      secBody: 'Esta dirección equivale al control total de tu ordenador: quien la tenga puede ver todas tus ' +
        'sesiones, archivos y acciones, y dar instrucciones en tu nombre.<br>' +
        'Si ya la compartiste, abre la consola en el ordenador y cambia la clave de acceso.',
      secOk: 'Entendido',
      tamperBody: '<b style="font-size:15px">⚠️ El código fue modificado — bloqueado</b><br>' +
        'El {which} que llegó esta vez no coincide con lo que guarda tu teléfono, así que se <b>rechazó</b>.<br>' +
        'No debería cambiar nunca por sí solo. Si no actualizaste nada en el ordenador, ' +
        'algo en el camino está reescribiendo el código que te llega — <b>no escribas nada sensible</b> ' +
        'y considera usar la dirección de la red local (la cifrada, en la misma Wi-Fi).',
      tamperOk: 'Entendido',
      tamperFix: 'Acabo de actualizar: confiar en esta versión',
      tamperConfirm: '¿Acabas de actualizar este programa en el ordenador?\n\n' +
        'Si confirmas, el teléfono marcará la **versión actual** como de confianza.\n' +
        'Si no actualizaste nada, pulsa Cancelar y usa la dirección cifrada de la misma Wi-Fi.',
      updating: 'Actualizando el registro…',
      noSW: 'El service worker no está en marcha',
      reloading: 'Listo, recargando…',
      retryFail: 'Reintentar (falló: {msg})'
    }
  };
  var NOTE_LANGS = ['zh', 'en', 'es'];

  // 「以后再说」按多久不再提。7 天是个折中：不骚扰，但也没忘掉这件事。
  var DISMISS_KEY = 'dsh-gw-notify-dismissed-v1';
  var DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

  function dismissedRecently() {
    try {
      var t = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
      return t > 0 && (Date.now() - t) < DISMISS_MS;
    } catch (e) { return false; }
  }

  /** 语言：手动选过的优先，其次设备语言，都没有就用英语 */
  function noteLang() {
    try {
      var saved = window.localStorage.getItem('dsh-lang');
      if (NOTE_LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { }
    var list = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < list.length; i++) {
      var b = String(list[i] || '').toLowerCase().split('-')[0];
      if (NOTE_LANGS.indexOf(b) >= 0) return b;
    }
    return 'en';
  }
  function T() { return NOTE_TEXT[noteLang()] || NOTE_TEXT.en; }

  function toast(msg, ms) {
    var old = document.getElementById('dsh-gw-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'dsh-gw-toast';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(24px + env(safe-area-inset-bottom,0px))', 'z-index:2147483647',
      'background:#17171a', 'color:#eee', 'border:1px solid #2c2c2e',
      'border-radius:999px', 'padding:11px 18px', 'font-size:13.5px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)',
      'font-family:-apple-system,system-ui,sans-serif'
    ].join(';');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 2500);
  }

  /** 文案里的 {name} 占位符替换（只需要它，不值得引一整套模板库） */
  function fmt(str, vars) {
    return String(str == null ? '' : str).replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : m;
    });
  }

  function setBusy(btn, text) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = text;
  }

  function noteCard(iosGuide) {
    if (document.getElementById('dsh-gw-notifycard')) return;
    var t = T();
    var card = document.createElement('div');
    card.id = 'dsh-gw-notifycard';
    card.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px',
      'bottom:calc(12px + env(safe-area-inset-bottom,0px))', 'z-index:2147483647',
      'background:#17171a', 'color:#eee', 'border:1px solid #2c2c2e',
      'border-radius:16px', 'padding:16px 18px',
      'font:14px/1.7 -apple-system,system-ui,sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,.6)'
    ].join(';');

    var head = document.createElement('div');
    head.style.cssText = 'font-weight:650;font-size:15.5px;margin-bottom:6px';
    head.textContent = iosGuide ? t.iosTitle : t.title;

    var sub = document.createElement('div');
    sub.style.cssText = 'color:#b9b9c0';
    if (iosGuide) sub.innerHTML = t.iosSteps; else sub.textContent = t.sub;

    card.appendChild(head);
    card.appendChild(sub);

    if (iosGuide) {
      var why = document.createElement('div');
      why.style.cssText = 'margin-top:10px;color:#9a9aa4;font-size:12.5px';
      why.textContent = t.iosWhy;
      card.appendChild(why);
    }

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:14px';

    var main = document.createElement('button');
    main.type = 'button';
    main.id = 'dsh-gw-notify';
    main.textContent = t.on;
    main.style.cssText = 'flex:1;padding:12px;border:0;border-radius:11px;background:#4d6bfe;' +
      'color:#fff;font-size:14.5px;font-weight:600';

    var later = document.createElement('button');
    later.type = 'button';
    later.id = 'dsh-gw-notify-later';
    later.textContent = t.later;
    later.style.cssText = 'padding:12px 16px;border:1px solid #333;border-radius:11px;' +
      'background:#0f0f11;color:#b9b9c0;font-size:14.5px';

    // ★ iPhone 在 Safari 标签页里点「开启」是**无效**的（iOS 的硬限制：
    //   只有从主屏幕图标打开的网页才能发通知）。所以那种情况下这一颗按钮
    //   只负责把「加主屏幕」那两步再讲一遍，不要把使用者带进死路。
    a11yClick(main, function () {
      if (iosGuide && !isStandalone()) { toast(t.iosTitle, 3200); return; }
      enable(main);
    });
    a11yClick(later, function () {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { }
      card.remove();
    });

    row.appendChild(main);
    row.appendChild(later);
    card.appendChild(row);
    document.body.appendChild(card);
  }

  /** 手机上真的能点（有些浏览器不认 click 合成事件，键盘/触摸也算一次手势） */
  function a11yClick(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }

  /**
   * 语音输入按钮 —— DSH 这边。
   *
   * 麻烦点：DSH 的输入框是它自己框架渲染的，没有稳定的选择器。
   * 所以不做「找到输入框再挂按钮」，而是放一个**浮动的麦克风按钮**，
   * 点了之后去找"当前页面上最像聊天输入框"的那个，把识别结果写进去。
   *
   * 找的规则（按可靠性排）：
   *   1. 当前聚焦的可编辑元素
   *   2. 屏幕上最大的、位置靠下的 textarea / 文本框 / contenteditable
   *
   * 写值必须走原生 setter + 派发 input 事件 —— 直接改 .value 框架察觉不到，
   * 会出现「字看着在里面、发出去是空的」这种极难查的问题。
   */
  /**
   * 不可用平台上那个常驻的半透明 🎤。
   *
   * 它是「这里本来会有语音」的可见提示，也是**唯一能重新打开使用说明的入口** ——
   * 原来那张卡片 25 秒后消失，之后再也没有办法叫回来，
   * 于是使用者只能对着一个点不出所以然的按钮发呆。
   *
   * 尺寸和右下角那条停靠栏一致（46px），塞进同一行，
   * 不再自己 fixed —— 这个位置历史上因为「浮层堆叠挡住输入框」返工过一次。
   */
  function mountVoiceHelpButton() {
    if (document.getElementById('dsh-gw-voice-help')) return;

    var b = document.createElement('button');
    b.id = 'dsh-gw-voice-help';
    b.type = 'button';
    b.textContent = '🎤';
    b.title = '语音怎么用（点一下看说明）';
    b.setAttribute('aria-label', '语音输入使用说明');
    b.style.cssText = [
      'position:relative', 'flex:none',
      'width:46px', 'height:46px', 'border-radius:999px',
      'border:1px solid rgba(255,255,255,.12)',
      'background:rgba(23,23,26,.92)', 'color:#eee', 'font-size:17px',
      'opacity:.5',                       // 半透明 = 一眼看出「这个不是正常可用的按钮」
      'display:grid', 'place-items:center', 'cursor:pointer', 'padding:0',
      'box-sizing:border-box', 'pointer-events:auto',
      '-webkit-backdrop-filter:blur(8px)', 'backdrop-filter:blur(8px)'
    ].join(';');
    b.addEventListener('click', function () {
      if (window.DshVoice && window.DshVoice.explain) window.DshVoice.explain();
    });

    // 塞进右下角那条已有的停靠栏。
    //
    // 但停靠栏是 route.js 建的，而它是**等 /__routes 返回后**才建的（异步）；
    // boot.js 跑的时候它多半还不存在。所以不能「找不到就自己 fixed」——
    // 那正是历史上返工过的「浮层各飘各的、堆起来挡住输入框」。
    // 这里轮询等它出现，等到再搬进去；实在等不到（route.js 挂了）才退回 fixed。
    var placed = false;
    var tryDock = function (attempt) {
      var dock = document.getElementById('dsh-gw-dock');
      if (dock) {
        dock.appendChild(b);
        placed = true;
        return;
      }
      if (attempt < 40) { setTimeout(function () { tryDock(attempt + 1); }, 250); return; }
      // 等了 10 秒还没有停靠栏 —— 只能自己站着，至少让功能可达
      b.style.position = 'fixed';
      b.style.right = '12px';
      b.style.bottom = 'calc(124px + env(safe-area-inset-bottom,0px))';
      b.style.zIndex = '2147483645';
      document.body.appendChild(b);
    };
    tryDock(0);
  }

  function showVoiceButton() {
    if (!window.DshVoice) return;
    // 拿不到识别接口时（iPhone 就是），**给一次说明，并且留一个随时能再打开的入口**。
    //
    // 之前有两个易用性问题：图标可见，但操作方法不明确。
    //   1. localStorage 的标记在**渲染之前**就写下了 —— 万一那 25 秒里人没看屏幕
    //      （比如正在切网络、页面还在加载），就**再也见不到**这张说明了。
    //      现在改成「关掉的时候才记账」。
    //   2. 卡片 25 秒后自己消失，之后没有任何办法把它叫回来。
    //      所以右下角保留一个半透明的 🎤，点一下就能重新打开说明 ——
    //      它同时也是「这里有语音相关功能」的可见提示。
    if (!window.DshVoice.available()) {
      var seen = false;
      try { seen = localStorage.getItem('dsh-voice-hint') === '1'; } catch (e) { }

      if (!seen) {
        setTimeout(function () {
          var tip = document.createElement('div');
          tip.id = 'dsh-voice-hint';
          tip.style.cssText = [
            'position:fixed', 'left:12px', 'right:12px',
            'bottom:calc(76px + env(safe-area-inset-bottom,0px))',
            'z-index:2147483646', 'background:#1b1b1c', 'color:#eee',
            'border:1px solid #2c2c2e', 'border-radius:14px', 'padding:13px 15px',
            'font:13.5px/1.7 -apple-system,system-ui,sans-serif',
            'box-shadow:0 6px 24px rgba(0,0,0,.5)'
          ].join(';');
          tip.innerHTML =
            '<b>想用语音输入？</b><br>' +
            '点键盘上那个 <b>🎤</b> 就能说话转文字 —— 手机系统自带的，比网页里做更稳。' +
            '<div style="color:#81858c;font-size:12.5px;margin-top:4px">' +
            'iPhone 的 Safari 不开放网页语音接口，所以这里没有内置按钮；安卓 Chrome 上会有。' +
            '</div>' +
            '<div style="text-align:right;margin-top:9px">' +
            '<button id="dsh-voice-hint-x" style="background:#2c2c2e;color:#eee;' +
            'border:0;border-radius:9px;padding:8px 14px;font-size:13.5px">知道了</button>' +
            '<button id="dsh-voice-hint-more" style="background:#2c2c2e;color:#eee;' +
            'border:0;border-radius:9px;padding:8px 14px;font-size:13.5px;margin-left:8px">' +
            '详细步骤</button></div>';
          document.body.appendChild(tip);

          var dismiss = function () {
            // 关掉的时候才记账 —— 这样「没看到」就不会被当成「已经看过了」
            try { localStorage.setItem('dsh-voice-hint', '1'); } catch (e) { }
            tip.remove();
          };
          var x = document.getElementById('dsh-voice-hint-x');
          if (x) x.addEventListener('click', dismiss);
          var more = document.getElementById('dsh-voice-hint-more');
          if (more) more.addEventListener('click', function () {
            try { localStorage.setItem('dsh-voice-hint', '1'); } catch (e) { }
            tip.remove();
            if (window.DshVoice.explain) window.DshVoice.explain();
          });
        }, 2500);
      }

      // 常驻的半透明 🎤 —— 既是提示，也是重新打开说明的入口
      mountVoiceHelpButton();
      return;
    }

    if (document.getElementById('dsh-gw-voice')) return;

    var b = document.createElement('button');
    b.id = 'dsh-gw-voice';
    b.type = 'button';
    b.textContent = '🎤';
    b.title = '语音输入（说完自动停下）';
    b.style.cssText = [
      // 不再自己 fixed —— 塞进右下角那条停靠栏里，和角标并排。
      // 之前语音、切换、余额、通知四个各飘各的，堆了 128px 高，
      // 键盘一弹就压住输入区，连发送都点不到。
      'position:relative', 'flex:none',
      'width:46px', 'height:46px', 'border-radius:999px', 'border:1px solid #2c2c2e',
      'background:rgba(23,23,26,.92)', 'color:#eee', 'font-size:17px',
      'display:grid', 'place-items:center', 'cursor:pointer', 'padding:0',
      'box-sizing:border-box',
      '-webkit-backdrop-filter:blur(8px)', 'backdrop-filter:blur(8px)',
      'pointer-events:auto'
    ].join(';');

    var rec = null;
    var box = null;
    var base = '';

    b.addEventListener('click', function () {
      if (rec) { rec.stop(); return; }

      box = findInput();
      if (!box) { alert('先点一下你要输入的地方，再按麦克风。'); return; }

      base = box.value ? String(box.value) + ' ' : '';
      b.textContent = '⏺';
      b.style.color = '#ff6b6b';

      rec = window.DshVoice.start({
        lang: 'zh-CN',
        onPartial: function (t) { window.DshVoice.setInputValue(box, base + t); },
        onFinal: function (t) { window.DshVoice.setInputValue(box, (base + t).trim()); },
        onError: function (m) { alert(m); },
        onEnd: function () { rec = null; b.textContent = '🎤'; b.style.color = ''; }
      });
      if (!rec) { b.textContent = '🎤'; b.style.color = ''; }
    });

    // 挂进右下角那条停靠栏 —— 没有就自己建一个（route.js 负责建，
    // 但万一它没跑到，这里也要能用）。
    var dk = document.getElementById('dsh-gw-dock');
    if (!dk) {
      dk = document.createElement('div');
      dk.id = 'dsh-gw-dock';
      dk.style.cssText = ['position:fixed', 'right:10px',
        'bottom:calc(10px + env(safe-area-inset-bottom,0px))', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'gap:8px', 'pointer-events:none'].join(';');
      document.body.appendChild(dk);
    }
    dk.insertBefore(b, dk.firstChild);   // 语音放在角标左边

    // 就地补上热区扩展，不依赖别处有没有跑过（之前就是因为依赖了
    // 一个单独的初始化函数，结果没生效，量出来还是 40×40）。
    // 视觉上 40px，外面再撑 6px 到 52px —— iOS 人机指南要求至少 44。
    if (!document.getElementById('dsh-gw-voice-hit')) {
      var st = document.createElement('style');
      st.id = 'dsh-gw-voice-hit';
      st.textContent =
        '#dsh-gw-voice{position:relative}' +
        "#dsh-gw-voice::after{content:'';position:absolute;inset:-6px;border-radius:inherit}";
      document.head.appendChild(st);
    }
  }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return /^(text|search|url|email|)$/i.test(el.type || 'text');
    return el.isContentEditable === true;
  }

  /** 找当前最像「聊天输入框」的那个元素 */
  function findInput() {
    var active = document.activeElement;
    if (active && isEditable(active)) return active;

    var vh = window.innerHeight;
    var cands = Array.prototype.slice.call(
      document.querySelectorAll('textarea, input[type=text], [contenteditable=true]'));
    var best = null, bestScore = 0;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) continue;               // 太小，不是聊天框
      if (r.bottom < vh * 0.35) continue;                        // 在上半屏，多半不是
      var score = r.width * r.height + (r.bottom / vh) * 10000;  // 越大、越靠下，越好
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /**
   * 把代码指纹 pin 到 Service Worker 里。
   *
   * 这是端到端加密的第二层：第一层（内容加密）挡住隧道"偷看"，
   * 这一层挡住隧道"把发给手机的 JS 换掉"——换掉的代码可以在明文
   * 还没加密时抄一份，或者直接把密钥传出去。
   *
   * pin 住之后，Service Worker 每次取这些 JS 都核对指纹，对不上就用缓存里的旧版
   * （那份是亲眼验过的）。**一旦 pin 住就不许改** —— 否则
   * 「掉包代码 + 顺便改掉 pin」就绕过去了，等于没做。
   *
   * 只在安全上下文（HTTPS）里有 Service Worker。内网明文那条路没有，
   * 而那条路上本来也没有第三方，不需要这层。
   */
  function pinCodeFingerprint() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data || {};

      if (d.type === 'dsh-pin-status-result') {
        if (d.pinned) return;                     // 已经 pin 了，什么都不做
        fetch('/code-manifest.json', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (m) {
            if (m && m.files && Object.keys(m.files).length) {
              navigator.serviceWorker.ready.then(function (reg) {
                if (reg.active) reg.active.postMessage({ type: 'dsh-pin-code', manifest: m });
              });
            }
          })
          .catch(function () { /* 拿不到清单就算了，不挡使用 */ });
      }

      // 指纹对不上 —— Service Worker 已经拒绝/替换了那份代码。
      //
      // ★ 这里原来是 console.warn + 语音播报。实测（test-code-integrity.js）
      //   确认：**使用者完全看不到**。页面照常显示「未加密 ¥18.03 ⇄」，
      //   一切正常的样子。防线装好了却没接警报器 —— 那等于没有。
      //   现在改成页面顶端一条红色横幅，必须点掉才消失，而且**每次都弹**
      //   （不写 localStorage）：这件事的性质是「有人正在改发给你的程序」，
      //   不该让人点一次「我知道了」就永远静音。
      if (d.type === 'dsh-code-mismatch') {
        console.error('[DSH] 代码指纹对不上: ' + d.path);
        try { showTamperAlert(d.path); } catch (e) { }
        try {
          if (window.DshVoice && window.DshVoice.notify) {
            window.DshVoice.notify('代码校验不通过',
              '这次送来的程序和你手机上存的对不上，已经拒绝执行。' +
              '如果你没在电脑上更新过，说明链路上有人在改发给你的代码。');
          }
        } catch (e) { }
      }
    });

    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) reg.active.postMessage({ type: 'dsh-pin-status' });
    }).catch(function () { /* 没有 SW（比如内网明文）就算了 */ });
  }

  /**
   * 给我注入的浮动按钮扩大触控热区。
   *
   * 视觉上只有 34-40px，但 iOS 人机指南要求可点区域至少 44×44 ——
   * 手机上点不准是很实际的体验问题。用伪元素把**可点范围**撑开 6px，
   * 视觉大小和排版都不变（比把按钮做大更好，不会挤到别的东西）。
   */
  function widenTouchTargets() {
    if (document.getElementById('dsh-touch-targets')) return;
    var st = document.createElement('style');
    st.id = 'dsh-touch-targets';
    st.textContent =
      '#dsh-gw-voice,#dsh-gw-switch,#dsh-gw-notify,#dsh-gw-badge{position:relative}' +
      '#dsh-gw-voice::after,#dsh-gw-switch::after,#dsh-gw-notify::after{' +
      "content:'';position:absolute;inset:-6px;border-radius:inherit}";
    document.head.appendChild(st);
  }

  /**
   * 键盘弹起时把右下角那条停靠栏藏起来。
   *
   * 为什么必须做：那条栏是 `position:fixed; bottom:10px`，键盘一弹，
   * 可视高度从 844 缩到 400 左右，它就正好落在输入区上面 —— 挡住发送键。
   * 使用者反馈的就是这个。
   *
   * 判断"键盘开了没"用 visualViewport 的高度：明显变矮就是开了。
   * 比监听 focus 准 —— 外接键盘、或者点了输入框但没弹键盘的情况都能区分。
   */
  function hideDockWhenTyping() {
    var apply = function () {
      var dk = document.getElementById('dsh-gw-dock');
      if (!dk) return;
      var vv = window.visualViewport;
      var shrunk = !!(vv && vv.height < window.innerHeight * 0.78);
      var el = document.activeElement;
      var typing = !!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ||
        el.isContentEditable));
      var hide = shrunk || typing;
      dk.style.transition = 'opacity .15s';
      dk.style.opacity = hide ? '0' : '';
      dk.style.pointerEvents = hide ? 'none' : '';
    };
    apply();
    window.addEventListener('resize', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', function () { setTimeout(apply, 120); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply);
      window.visualViewport.addEventListener('scroll', apply);
    }
  }

  /**
   * 什么时候露出那张卡片（2026-09-27 重写）。
   *
   * 这一段的目标只有一个：
   * **让他点一次就够了，且不需要装任何东西**。三条规则：
   *
   *   1. 已经授权 → **悄悄**确认订阅还在（浏览器升级、订阅过期都会丢），
   *      不打扰他。只有悄悄补订阅失败时才露卡片。
   *   2. 「以后再说」过的 → 7 天内不再出现（记在本地），免得变成骚扰。
   *   3. 还没决定 → 露卡片。iPhone 在 Safari 标签页里点「开启」是无效的
   *      （iOS 的硬限制），所以那种情况给的是「两步」版本。
   */
  function maybeShowButton() {
    maybeShowSecurityNotice();

    if (!hasNotify()) return;         // 不支持通知：什么都不做，不打扰
    if (document.getElementById('dsh-gw-notifycard')) return;
    if (dismissedRecently()) return;

    if (window.Notification.permission === 'granted') {
      // 已经开过：静默确认一次，别让他再点
      subscribe().then(function (r) {
        if (r !== 'ok') noteCard(false);
      }).catch(function () { noteCard(false); });
      return;
    }

    noteCard(isIOS() && !isStandalone());
  }

  /**
   * DSH 的界面有没有跟着我们把语言换掉？（2026-09-27）
   *
   * 背景：手机端切换语言后，目标界面仍可能显示中文。
   * 我们自己那套（i18n.js 的 localStorage 选择）和 DSH 自己那套是两套：
   *   · 我们已经在 i18n.js 里把选择「翻译」成 DSH 看得懂的东西
   *     （改 navigator.languages —— 它启动时读的就是这个）；
   *   · 但 DSH **还有自己的设置项**（Settings → General → Language），
   *     那一项一旦有值就会盖过浏览器语言 —— 我们改不了它，也不该偷偷改。
   *
   * 所以这里只做一件事：等 DSH 起来之后看一眼它自己的语言（它会写到
   * `<html lang>`：zh → zh-CN，en → en）。跟我们选的不一样，就**一次**提示
   * 「去 DSH 的设置里也选一次」，而不是让使用者以为切换坏了。
   */
  function checkDshLanguage() {
    if (!window.__dshGwEmbedded) return;         // 只在我们注入的 DSH 页面上做
    var want = null;
    try { want = window.localStorage.getItem('dsh-lang'); } catch (e) { }
    if (!want) return;                           // 没手选过：浏览器语言就是他的偏好

    // DSH 只注册了中文和英文两种界面（实测它的 locale 包），所以选西语时
    // 它的界面会是英文 —— 这是**预期**，不是说一句「去设置里改」就完事，
    // 而要告诉使用者「为什么」。
    var expect = want === 'zh' ? 'zh' : 'en';
    var hintKey = 'dsh-gw-dshlang-hint-v1';
    var noteKey = 'dsh-gw-dshlang-es-note-v1';

    setTimeout(function () {
      var got = String((document.documentElement && document.documentElement.lang) || '')
        .toLowerCase().split('-')[0];
      if (got === expect) {
        // 跟上了。唯一还要说一句的情况：选了西语但 DSH 只有中/英。
        if (want === 'es') {
          try {
            if (window.localStorage.getItem(noteKey) === '1') return;
            window.localStorage.setItem(noteKey, '1');
          } catch (e) { }
          toast(T().dshNoSpanish, 7000);
        }
        return;
      }
      try { if (window.localStorage.getItem(hintKey) === want) return; } catch (e) { }
      try { window.localStorage.setItem(hintKey, want); } catch (e) { }
      toast(T().dshLangHint, 9000);
    }, 3000);                                    // 给 DSH 一点时间把它自己的语言写上去
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      maybeShowButton();
      showVoiceButton();
      pinCodeFingerprint();
      widenTouchTargets();
      hideDockWhenTyping();
      checkDshLanguage();
    });
  } else {
    maybeShowButton();
    showVoiceButton();
    pinCodeFingerprint();
    widenTouchTargets();
    hideDockWhenTyping();
    checkDshLanguage();
  }
})();
