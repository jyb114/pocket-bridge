// 多语言 —— 中 / 英 / 西
//
// 为什么是这三种：按**母语人数**排，前三是中文、西班牙语、英语。
// （按总使用人数排是英语、中文、西班牙语 —— 无论哪种口径，这三个都在里面。）
//
// ── 怎么选语言 ──────────────────────────────────────────────────────────────
//
// 优先看设备的语言列表（navigator.languages 是**按偏好排序的**，
// 不能只看 navigator.language 那一个 —— 很多人的首选是没有翻译的小语种，
// 但列表里第二位就是英语，那时候应该给英语而不是硬塞中文）。
//
// 手动选过就以手动为准（存 localStorage）—— 自动选总有选错的时候，
// 而"猜错了还改不回来"比"猜错"更让人恼火。
//
// ── 为什么把中文原文当 key ──────────────────────────────────────────────────
//
// 不用 t('connect.title') 这种 id：那样每加一句话都要先在三个语言文件里
// 各加一条，漏一条就是空白。直接用中文原文当 key，好处是：
//   · 没翻译时**自动退回中文**，页面永远不会有空洞
//   · 代码里一眼能看出这句是什么，不用来回翻对照表
// 代价是改中文文案会让旧翻译失配 —— 但那种时候本来就该重新翻一遍。
'use strict';

(function (global) {
  var SUPPORTED = ['zh', 'en', 'es'];
  var NAMES = { zh: '中文', en: 'English', es: 'Español' };
  var STORE_KEY = 'dsh-lang';

  // ── 词典 ──────────────────────────────────────────────────────────────────
  // 结构: { '中文原文': { en: '...', es: '...' } }
  // 中文不需要列在这里 —— 它是原样。
  var DICT = {};

  function register(entries) {
    for (var k in entries) if (Object.prototype.hasOwnProperty.call(entries, k)) {
      DICT[k] = entries[k];
    }
  }

  // ── 选语言 ────────────────────────────────────────────────────────────────

  /** 'zh-CN' / 'en-US' / 'es-419' → 'zh' / 'en' / 'es' */
  function base(tag) {
    return String(tag || '').toLowerCase().split('-')[0];
  }

  /**
   * 从设备的语言列表里挑一个我们支持的。
   * 挑不到就用英语 —— 它是这三种里最可能被当第二语言看懂的。
   */
  function detect() {
    var lists = [];
    try {
      if (global.navigator && global.navigator.languages && global.navigator.languages.length) {
        lists = Array.prototype.slice.call(global.navigator.languages);
      } else if (global.navigator && global.navigator.language) {
        lists = [global.navigator.language];
      }
    } catch (err) { /* 读不到就用兜底 */ }

    for (var i = 0; i < lists.length; i++) {
      var b = base(lists[i]);
      if (SUPPORTED.indexOf(b) >= 0) return b;
    }
    return 'en';
  }

  var current = null;

  function stored() {
    try {
      var v = global.localStorage.getItem(STORE_KEY);
      return SUPPORTED.indexOf(v) >= 0 ? v : null;
    } catch (err) { return null; }
  }

  // ── 让这个选择「传出去」（2026-09-27）────────────────────────────────────
  //
  // 语言选择必须传给 DSH 和 Codex 页面，避免切换后仍显示中文。
  // 此前选择只写进 localStorage，
  // 而有两处看不见它：
  //
  //   1. **服务端直出的页面**（配对页 / 选择页 / 启动页 / 退出页）读的是
  //      `dsh-lang` cookie，不是 localStorage；
  //   2. **DSH 自己的界面**用的是它自己那套：它读 `navigator.languages`
  //      挑语言（实测 `dsh-client-locale` 的 detectBrowserLocale），
  //      而那是**手机系统的语言** —— 我们在设置里选的这个它压根看不见。
  //      它还有自己的设置项（Settings → General → Language），那一项会盖过浏览器语言。
  //
  // 所以这里做两件事：
  //   · 把选择写成 cookie（服务端那半边跟着走）；
  //   · 在 DSH 的模块脚本跑起来**之前**把 navigator 的语言列表换掉
  //     （这份脚本是同步注入在 <head> 最前面的，DSH 的 bundle 是 module，
  //      要等解析完才跑 —— 顺序上我们一定在前面）。
  //
  // ★ 只在「使用者手选过」的时候动它。没选过就一个字都不碰 ——
  //   那种情况下浏览器自己的语言就是他的偏好，替他改反而是错的。
  function toServerTag(code) {
    return code === 'zh' ? 'zh-CN' : code;
  }

  function mirrorToServer(code) {
    try {
      global.document.cookie = STORE_KEY + '=' + code + '; path=/; max-age=' +
        (365 * 24 * 60 * 60) + '; SameSite=Lax';
    } catch (err) { /* 写不了 cookie 不影响本站内的切换 */ }
  }

  /**
   * 把我们的选择「伪装」成浏览器的语言偏好，让 DSH 自己那套挑语言时挑中它。
   *
   * 为什么带一个 en 兜底：DSH 只注册了 zh / en 两种（实测 BUILT_IN_LOCALES），
   * 选西语的人不该掉回它那边的默认值 —— 列表里跟上 en，它就会挑到英语。
   */
  function overrideNavigatorLang(code) {
    try {
      var nav = global.navigator;
      if (!nav) return;
      var tag = toServerTag(code);
      var list = code === 'zh' ? ['zh-CN', 'zh', 'en'] : [tag, 'en'];
      try {
        Object.defineProperty(nav, 'language', { get: function () { return tag; }, configurable: true });
      } catch (e) { try { nav.language = tag; } catch (e2) { } }
      try {
        Object.defineProperty(nav, 'languages', { get: function () { return list.slice(); }, configurable: true });
      } catch (e) { try { nav.languages = list.slice(); } catch (e2) { } }
    } catch (err) { /* 改不了就算了：DSH 会回到它自己的判断，不影响其它功能 */ }
  }

  /** 这一页是 DSH 应用页吗（网关在注入时标了 __dshGwEmbedded） */
  function embedded() {
    try { return global.__dshGwEmbedded === true; } catch (err) { return false; }
  }

  function lang() {
    if (!current) current = stored() || detect();
    return current;
  }

  function setLang(code) {
    if (SUPPORTED.indexOf(code) < 0) return false;
    current = code;
    try { global.localStorage.setItem(STORE_KEY, code); } catch (err) { /* 存不了也不影响本次 */ }
    try { global.document.documentElement.setAttribute('lang', toServerTag(code)); } catch (err) { }
    mirrorToServer(code);
    overrideNavigatorLang(code);
    applyAll();
    // DSH 那一页：它的语言是**启动时**定下的（读一次 navigator，或者读它自己的
    // 设置项）。已经跑起来的界面不会因为我们改了 navigator 就换语言，所以这里
    // 重载一次 —— 重载之后 DSH 会用新语言启动，使用者看到的才是真的换了。
    if (embedded()) {
      try { global.setTimeout(function () { global.location.reload(); }, 60); } catch (err) { }
    }
    return true;
  }

  function resetLang() {
    current = null;
    try { global.localStorage.removeItem(STORE_KEY); } catch (err) { }
    try { global.document.documentElement.setAttribute('lang', lang() === 'zh' ? 'zh-CN' : lang()); } catch (err) { }
    applyAll();
  }

  // 页面一加载就把「手选过的语言」兑现出去（cookie + navigator）。
  // 必须在文件求值时做，不能等 DOMContentLoaded —— DSH 的 module 脚本在这之后
  // 立刻就会去读 navigator 定语言。
  (function applyStoredChoice() {
    var s = stored();
    if (!s) return;
    mirrorToServer(s);
    overrideNavigatorLang(s);
    try { global.document.documentElement.setAttribute('lang', toServerTag(s)); } catch (err) { }
  })();

  // ── 取词 ──────────────────────────────────────────────────────────────────

  /**
   * 翻译一句话。
   *
   * @param {string} zh   中文原文（同时是 key）
   * @param {object} [vars] 替换 {name} 这样的占位符
   */
  function t(zh, vars) {
    var L = lang();
    var out = zh;
    if (L !== 'zh') {
      var e = DICT[zh];
      // 没翻到就退回中文 —— **页面永远不留空洞**，这比"显示 key"好得多
      if (e && e[L]) out = e[L];
    }
    if (vars) {
      out = String(out).replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return out;
  }

  // ── 套到页面上 ────────────────────────────────────────────────────────────

  var ATTRS = [
    // [属性名, 目标]
    ['data-i18n', 'text'],
    ['data-i18n-html', 'html'],
    ['data-i18n-ph', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-aria', 'aria-label']
  ];

  function applyOne(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var attr = ATTRS[i][0], kind = ATTRS[i][1];
      var key = el.getAttribute && el.getAttribute(attr);
      if (!key) continue;
      var val = t(key);
      if (kind === 'text') el.textContent = val;
      else if (kind === 'html') el.innerHTML = val;
      else el.setAttribute(kind, val);
    }
  }

  /** 给整棵子树套上翻译。新增的 DOM（比如动态渲染出来的）要再调一次。 */
  function apply(root) {
    var r = root || global.document;
    if (!r || !r.querySelectorAll) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var list = r.querySelectorAll('[' + ATTRS[i][0] + ']');
      for (var j = 0; j < list.length; j++) applyOne(list[j]);
    }
  }

  function applyAll() {
    apply(global.document);
    // 页面可能自己还想再刷一遍（比如动态渲染的区域）
    if (typeof global.onLangChange === 'function') {
      try { global.onLangChange(lang()); } catch (err) { }
    }
  }

  // ── 语言切换器 ────────────────────────────────────────────────────────────
  //
  // 自动选总有选错的时候（比如设备语言是小语种、或者使用者就是想要英文）。
  // 给一个能改回来的入口，比把自动选做得更聪明更有用。
  function makeSwitcher() {
    var sel = global.document.createElement('select');
    sel.setAttribute('aria-label', 'Language');
    sel.style.cssText = 'background:#1c1f26;color:#f4f5f7;border:1px solid #2e323b;' +
      'border-radius:8px;padding:6px 10px;font:inherit;font-size:12.5px;cursor:pointer';
    SUPPORTED.forEach(function (code) {
      var o = global.document.createElement('option');
      o.value = code; o.textContent = NAMES[code];
      sel.appendChild(o);
    });
    sel.value = lang();
    sel.addEventListener('change', function () { setLang(sel.value); });
    return sel;
  }

  global.DshI18n = {
    SUPPORTED: SUPPORTED,
    NAMES: NAMES,
    register: register,
    dict: DICT,
    lang: lang,
    setLang: setLang,
    resetLang: resetLang,
    detect: detect,
    base: base,
    t: t,
    apply: apply,
    applyAll: applyAll,
    makeSwitcher: makeSwitcher,
    STORE_KEY: STORE_KEY,
    // 排查用：这一页是不是 DSH 应用页、我们有没有把语言改写给 DSH 看
    isEmbedded: embedded,
    toServerTag: toServerTag
  };
})(typeof window !== 'undefined' ? window : globalThis);
