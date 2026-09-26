// 语音输入 —— DSH 和 Codex 两个界面共用。
//
// 用的是浏览器原生的 SpeechRecognition（Web Speech API），**不引任何依赖**，
// 也不会把录音发到我们自己这边 —— 识别是浏览器/系统做的。
//
// 平台现实（这点必须如实告诉使用者，做个点了没反应的按钮更糟）：
//
//   安卓 Chrome     ✅ 支持
//   iPhone Safari   ❌ 不支持（苹果的限制）
//   桌面 Chrome/Edge ✅ 支持
//
// 所以：
//   · 能用的地方给一个麦克风按钮
//   · 不能用的地方**明确提示**「请用键盘上的麦克风」——
//     手机键盘自带的听写其实就能干这事，而且比我们做的更稳。
(function (global) {
  'use strict';

  var Rec = global.SpeechRecognition || global.webkitSpeechRecognition;

  // Resolve at the moment a user opens help or starts recognition. The language
  // can change without reloading the Codex page.
  var WORDS = {
    zh: {
      iosUnavailable: 'iPhone 上的 Safari 不开放语音识别接口 —— 请用键盘右下角那个麦克风，效果一样，而且更稳。',
      browserUnavailable: '这个浏览器不支持语音识别 —— 请用键盘上的麦克风按钮。',
      permission: '没有麦克风权限 —— 在浏览器设置里允许一下就能用',
      noSpeech: '没听到声音，再试一次', error: '识别出错：', startFailed: '启动失败：',
      availableHelp: '<b>语音输入怎么用</b><br>1. 先点一下输入框，把光标放进去<br>' +
        '2. 点这个 🎤 按钮<br>3. 直接说话，停下来它自己会结束<br>' +
        '<div style="color:#81858c;font-size:12.5px;margin-top:6px">再点一次按钮可以提前结束。</div>',
      unavailableTitle: '这里没有内置语音按钮 —— 但键盘上有',
      iosExplanation: 'iPhone 的 Safari <b>不开放</b>网页语音接口，所以网页里做不了。',
      browserExplanation: '这个浏览器没开放网页语音接口。',
      keyboardIntro: '不过手机键盘自带的听写就能干这件事，而且更稳。',
      keyboardSteps: '<b>怎么用：</b><br>1. 点一下输入框，让键盘弹出来<br>' +
        '2. 看键盘<b>右下角</b>那个 🎤（在空格键右边）<br>' +
        '3. 点它，然后说话 —— 字会自己出现在输入框里',
      keyboardSettings: '<b>键盘上找不到 🎤？</b>要先把它打开：<br>' +
        '<b>设置 → 通用 → 键盘 → 启用「听写」</b>，打开后键盘右下角就有了。',
      gotIt: '知道了'
    },
    en: {
      iosUnavailable: 'iPhone Safari does not offer speech recognition to web pages. Use the microphone on your keyboard instead.',
      browserUnavailable: 'This browser does not support speech recognition. Use the microphone on your keyboard instead.',
      permission: 'Microphone access is blocked. Allow it in your browser settings and try again.',
      noSpeech: 'No speech detected. Please try again.', error: 'Speech recognition error: ', startFailed: 'Could not start recognition: ',
      availableHelp: '<b>How to use voice input</b><br>1. Tap the text box to place the cursor<br>' +
        '2. Tap the 🎤 button<br>3. Speak; recognition stops when you pause<br>' +
        '<div style="color:#81858c;font-size:12.5px;margin-top:6px">Tap the button again to stop early.</div>',
      unavailableTitle: 'No built-in voice button here — use your keyboard',
      iosExplanation: 'iPhone Safari does <b>not</b> offer speech recognition to web pages.',
      browserExplanation: 'This browser does not offer speech recognition to web pages.',
      keyboardIntro: 'Your phone keyboard can dictate instead, and it is usually more reliable.',
      keyboardSteps: '<b>How to use it:</b><br>1. Tap the text box to open the keyboard<br>' +
        '2. Find the 🎤 button on your keyboard<br>3. Tap it and speak; your words appear in the text box',
      keyboardSettings: '<b>Cannot find 🎤 on the keyboard?</b> Turn on dictation in ' +
        '<b>Settings → General → Keyboard → Enable Dictation</b>.',
      gotIt: 'Got it'
    },
    es: {
      iosUnavailable: 'Safari en iPhone no ofrece reconocimiento de voz a las páginas web. Usa el micrófono del teclado.',
      browserUnavailable: 'Este navegador no admite el reconocimiento de voz. Usa el micrófono del teclado.',
      permission: 'El acceso al micrófono está bloqueado. Permítelo en los ajustes del navegador e inténtalo de nuevo.',
      noSpeech: 'No se detectó voz. Inténtalo de nuevo.', error: 'Error de reconocimiento de voz: ',
      startFailed: 'No se pudo iniciar el reconocimiento: ',
      availableHelp: '<b>Cómo usar la entrada de voz</b><br>1. Toca el campo de texto para situar el cursor<br>' +
        '2. Toca el botón 🎤<br>3. Habla; el reconocimiento se detiene cuando haces una pausa<br>' +
        '<div style="color:#81858c;font-size:12.5px;margin-top:6px">Vuelve a tocar el botón para detenerlo antes.</div>',
      unavailableTitle: 'Aquí no hay micrófono integrado: usa el del teclado',
      iosExplanation: 'Safari en iPhone <b>no</b> ofrece reconocimiento de voz a las páginas web.',
      browserExplanation: 'Este navegador no ofrece reconocimiento de voz a las páginas web.',
      keyboardIntro: 'Puedes usar el dictado del teclado del teléfono; suele ser más fiable.',
      keyboardSteps: '<b>Cómo usarlo:</b><br>1. Toca el campo de texto para abrir el teclado<br>' +
        '2. Busca el botón 🎤 del teclado<br>3. Tócalo y habla; las palabras aparecerán en el campo de texto',
      keyboardSettings: '<b>¿No encuentras 🎤 en el teclado?</b> Activa Dictado en ' +
        '<b>Ajustes → General → Teclado → Activar Dictado</b>.',
      gotIt: 'Entendido'
    }
  };

  function words() {
    var lang = '';
    try { if (global.DshI18n && global.DshI18n.lang) lang = global.DshI18n.lang(); } catch (e) { }
    if (!lang) {
      try { lang = global.localStorage && global.localStorage.getItem('dsh-lang'); } catch (e) { }
    }
    if (!lang) {
      var list = global.navigator && (global.navigator.languages || [global.navigator.language]) || [];
      for (var i = 0; i < list.length; i++) {
        var candidate = String(list[i] || '').toLowerCase().split('-')[0];
        if (WORDS[candidate]) { lang = candidate; break; }
      }
    }
    return WORDS[String(lang || '').toLowerCase().split('-')[0]] || WORDS.en;
  }

  /** 这个浏览器能不能做语音识别 */
  function available() {
    return !!Rec;
  }

  /** 为什么不能用 —— 给使用者一句人话 */
  function whyNot() {
    if (Rec) return null;
    var copy = words();
    var ua = String(global.navigator && global.navigator.userAgent || '');
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && 'ontouchend' in document);
    if (isIOS) {
      return copy.iosUnavailable;
    }
    return copy.browserUnavailable;
  }

  /**
   * 开一次识别。
   *
   * @param {object} o
   *   o.lang      语言，默认中文
   *   o.onPartial 识别过程中的临时结果（可以用来实时显示）
   *   o.onFinal   最终结果
   *   o.onError   出错
   *   o.onEnd     不管成功失败，结束都会调
   * @returns {object|null} 控制器；不可用返回 null
   */
  function start(o) {
    if (!Rec) return null;
    o = o || {};

    var r = new Rec();
    r.lang = o.lang || 'zh-CN';
    r.continuous = false;         // 说一句就停 —— 手机上连续模式很容易误触
    r.interimResults = true;      // 边说边显示，使用者能看出它在听
    r.maxAlternatives = 1;

    var finalText = '';
    var stopped = false;

    r.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t;
        else interim += t;
      }
      if (o.onPartial) o.onPartial(finalText + interim, !!finalText);
    };

    r.onerror = function (ev) {
      // not-allowed = 使用者拒绝了麦克风权限；no-speech = 没听到
      var copy = words();
      var msg = ev.error === 'not-allowed'
        ? copy.permission
        : (ev.error === 'no-speech' ? copy.noSpeech
          : (copy.error + ev.error));
      if (o.onError) o.onError(msg);
    };

    r.onend = function () {
      stopped = true;
      if (o.onFinal && finalText) o.onFinal(finalText);
      if (o.onEnd) o.onEnd(finalText);
    };

    try {
      r.start();
    } catch (err) {
      // 重复 start() 会抛 —— 直接告诉调用方，别静默失败
      if (o.onError) o.onError(words().startFailed + err.message);
      return null;
    }

    return {
      stop: function () { if (!stopped) { try { r.stop(); } catch (e) { } } },
      abort: function () { if (!stopped) { try { r.abort(); } catch (e) { } } }
    };
  }

  /**
   * 往一个输入框里写字，并且**让页面框架知道值变了**。
   *
   * 这一步是关键：DSH 的界面是 React 那类框架渲染的，直接改 input.value
   * 框架察觉不到（它有自己的一份状态），于是文字看着在里面，
   * 一发出去却是空的 —— 这种问题极难查。
   *
   * 正确做法是用原生的 value setter 赋值，再手动派发 input 事件，
   * 框架的 onChange 就会收到。
   */
  function setInputValue(input, text) {
    if (!input) return false;
    try {
      var proto = input.tagName === 'TEXTAREA'
        ? global.HTMLTextAreaElement.prototype
        : global.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(input, text);
      else input.value = text;

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (err) {
      try { input.value = text; return true; } catch (e) { return false; }
    }
  }

  global.DshVoice = {
    available: available,
    whyNot: whyNot,
    start: start,
    setInputValue: setInputValue,
    explain: explain
  };

  /**
   * 把「语音到底怎么用」讲清楚 —— 一个能读、能照着做、随时能再打开的面板。
   *
   * 为什么必须有这个：原来的做法是一闪而过的 toast（Codex 页）和
   * **一辈子只弹一次**的卡片（DSH 页，而且 localStorage 标记是在渲染**之前**
   * 就写下的 —— 万一没看见，就再也见不到了）。
   *
   * 结果就是图标可见，操作方法却不明确。
   * 一个点不出所以然的按钮，比没有这个按钮更让人恼火。
   *
   * 面板里最要紧的是**具体到点哪里**，尤其是 iOS 那条：
   * 键盘上的麦克风要先在系统设置里打开听写才会出现 ——
   * 不说这句，使用者会以为「我键盘上根本没有麦克风」然后就放弃了。
   */
  function explain() {
    if (document.getElementById('dsh-voice-help')) return;

    var ua = String(global.navigator && global.navigator.userAgent || '');
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && 'ontouchend' in document);
    var ok = available();
    var copy = words();

    var box = document.createElement('div');
    box.id = 'dsh-voice-help';
    box.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px',
      'bottom:calc(76px + env(safe-area-inset-bottom,0px))',
      'z-index:2147483647', 'background:#1b1b1c', 'color:#eee',
      'border:1px solid #2c2c2e', 'border-radius:14px', 'padding:15px 16px',
      'font:13.5px/1.75 -apple-system,system-ui,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.55)', 'text-align:left'
    ].join(';');

    var html;
    if (ok) {
      html = copy.availableHelp;
    } else {
      html =
        '<b>' + copy.unavailableTitle + '</b>' +
        '<div style="color:#c9ccd1;margin-top:7px">' +
        (isIOS ? copy.iosExplanation : copy.browserExplanation) +
        copy.keyboardIntro + '<br><br>' +
        copy.keyboardSteps +
        '</div>' +
        (isIOS ?
          '<div style="margin-top:9px;padding:9px 11px;background:#232326;border-radius:9px;' +
          'color:#c9ccd1;font-size:12.5px">' +
          copy.keyboardSettings + '</div>' : '');
    }

    box.innerHTML = html +
      '<div style="text-align:right;margin-top:11px">' +
      '<button id="dsh-voice-help-x" style="background:#2c2c2e;color:#eee;' +
      'border:0;border-radius:9px;padding:9px 16px;font-size:13.5px">' + copy.gotIt + '</button></div>';

    document.body.appendChild(box);
    var x = document.getElementById('dsh-voice-help-x');
    if (x) x.addEventListener('click', function () { box.remove(); });
  }
})(window);
