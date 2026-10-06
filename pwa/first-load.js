// DSH 移动端网关 — 「第一次打开会比较慢，别刷新」
//
// 为什么要有这一条（使用者 2026-09-23 提的需求）：
// 手机上第一次打开 DSH 页面，要拉几十个 client.js 插件 + polyfill + 兼容层，
// 然后才建 WebSocket。这段十几二十秒里屏幕是白的或者一直转圈，使用者会以为
// 「坏了」，于是**反复刷新** —— 而每刷新一次都要从头再来一遍，只会更慢。
// 所以第一次就明说：慢是正常的，等 20 秒，别刷新。
//
// 三条自我约束：
//   1. **不挡页面**。position:fixed + pointer-events:none —— 它只负责告知，
//      不该拦下任何一次点击，也不该把布局顶下去。
//   2. **不误报**。`dsh-gw-loaded-once-v1` 记在 localStorage 里：真成功加载过
//      一次之后，就不再对「第一次」说那句话；之后只有**这次确实慢**才提示
//      （默认 8 秒还没见到界面）。
//   3. **不等后面的脚本**。这一份是网关注入到 <head> 里的同步脚本，比 DSH 自己的
//      模块脚本先执行；那时候 i18n.js 还没跑，所以三种语言的文案自己带一份。
//      同时**读同一个 localStorage 键**（DshI18n.STORE_KEY = 'dsh-lang'）——
//      使用者手动选过语言的话，这条提示跟着他选的语言走。
//
// 「加载完了」的判据是 `#root` 里出现了元素：DSH 的界面挂在 <div id="root">，
// 它一旦有子节点就说明使用者已经看到东西了，提示该让位。
// 不用 DOMContentLoaded：DSH 的应用脚本是 type="module"，**它会拖住
// DOMContentLoaded 直到整张模块图加载完** —— 等那个事件就等于什么都没提示。
'use strict';

(function (global) {
  var KEY = 'dsh-gw-loaded-once-v1';

  // 测试用：允许外面把三个时间调小（真机上谁都不会去设它）
  var cfg = global.__dshFirstLoadConfig || {};
  var SLOW_MS = cfg.slowMs || 8000;     // 加载成功过：这次超过它还没出来才算「慢」
  var STUCK_MS = cfg.stuckMs || 45000;  // 再超过它，补一句「去电脑上看看服务还在不在」
  var POLL_MS = cfg.pollMs || 400;

  var TEXT = {
    zh: {
      first: '第一次打开会比较慢（手机要下载一些东西），请等 20 秒左右 —— 别刷新，刷新只会更慢。',
      slow: '这次加载比平时慢（网络或电脑端在忙），再等一会儿 —— 别刷新。',
      stuck: '还没出来的话：到电脑上打开控制台，看一眼 DSH 是不是还在跑。'
    },
    en: {
      first: 'The first load takes a while (your phone is downloading things). Give it about 20 seconds — do not refresh; refreshing only makes it slower.',
      slow: 'This load is slower than usual (busy network or computer). Give it a bit more time — do not refresh.',
      stuck: 'Still nothing? Open the console on your computer and check whether DSH is still running.'
    },
    es: {
      first: 'La primera vez tarda un poco (el teléfono está descargando cosas). Espera unos 20 segundos; no recargues, recargar solo lo hace más lento.',
      slow: 'Esta carga va más lenta de lo normal (red u ordenador ocupados). Espera un poco más; no recargues.',
      stuck: '¿Sigue sin aparecer? Abre la consola en el ordenador y comprueba si DSH sigue en marcha.'
    }
  };

  var SUPPORTED = ['zh', 'en', 'es'];

  /**
   * 显示语言。和 i18n.js 同一套优先级，但**不能**调用它 —— 这时候它还没执行。
   * 手动选过的（'dsh-lang'）最优先，其次按设备语言列表，都挑不到就用英语。
   */
  function pickLang() {
    try {
      var saved = global.localStorage.getItem('dsh-lang');
      if (SUPPORTED.indexOf(saved) >= 0) return saved;
    } catch (err) { /* 读不到就按设备语言 */ }
    var list = [];
    try {
      if (global.navigator && global.navigator.languages && global.navigator.languages.length) {
        list = Array.prototype.slice.call(global.navigator.languages);
      } else if (global.navigator && global.navigator.language) {
        list = [global.navigator.language];
      }
    } catch (err) { /* 读不到就用兜底 */ }
    for (var i = 0; i < list.length; i++) {
      var b = String(list[i] || '').toLowerCase().split('-')[0];
      if (SUPPORTED.indexOf(b) >= 0) return b;
    }
    return 'en';
  }

  var T = TEXT[pickLang()] || TEXT.en;

  var startedAt = Date.now();
  var el = null;          // 横幅本体
  var noteEl = null;      // 第二行（「还没出来？」那句）
  var done = false;       // 已经收工（界面出来了 / 已经隐藏）
  var stuckShown = false;
  var slowTimer = null;
  var pollTimer = null;

  function storageOk(v) {
    try { global.localStorage.setItem(KEY, v); return true; } catch (err) { return false; }
  }

  function seenBefore() {
    try { return global.localStorage.getItem(KEY) === '1'; } catch (err) { return false; }
  }

  /** DSH 的界面出来了没有 */
  function appReady() {
    var root = global.document && global.document.getElementById('root');
    return !!(root && root.firstElementChild);
  }

  /**
   * 挂到哪儿。
   *
   * 这一段脚本在 <head> 里执行，那时**还没有 body** —— 所以先挂到
   * documentElement 上（position:fixed，挂哪儿都按视口定位），等 body 出现
   * 之后再挪进 body 里，免得一直留着一个「html 的野孩子」。
   */
  function host() {
    return (global.document.body) || global.document.documentElement;
  }

  function build() {
    var d = global.document.createElement('div');
    d.id = 'dsh-gw-firstload';
    d.setAttribute('role', 'status');
    d.style.cssText = [
      'position:fixed', 'left:0', 'right:0',
      'top:calc(env(safe-area-inset-top,0px))',
      'z-index:2147483600',
      'background:rgba(58,47,11,.96)', 'color:#ffe9a8',
      'border-bottom:1px solid #6b5a1f',
      'padding:11px 14px', 'font-size:13px', 'line-height:1.6',
      'font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif',
      // 只看不动：不拦点击，也不参与布局
      'pointer-events:none',
      'transition:opacity .3s', 'opacity:1',
      'box-shadow:0 2px 12px rgba(0,0,0,.35)'
    ].join(';');
    var line = global.document.createElement('div');
    line.id = 'dsh-gw-firstload-text';
    d.appendChild(line);
    return d;
  }

  function show(which) {
    if (done || el) return;
    if (!global.document || !global.document.createElement) return;
    el = build();
    var text = el.firstChild;
    text.textContent = T[which] || T.first;
    host().appendChild(el);
  }

  /** 第二行小字：等太久了，给一个「去电脑上看看」的方向 */
  function addStuckNote() {
    if (done || !el || noteEl) return;
    noteEl = global.document.createElement('div');
    noteEl.style.cssText = 'margin-top:5px;color:#d8c58a;font-size:12px';
    noteEl.textContent = T.stuck;
    el.appendChild(noteEl);
  }

  function hide() {
    done = true;
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!el) return;
    el.style.opacity = '0';
    var gone = el;
    setTimeout(function () {
      if (gone && gone.parentNode) gone.parentNode.removeChild(gone);
    }, 350);
    el = null;
  }

  /** 界面出来了：记下「成功加载过」并把提示收掉 */
  function finish() {
    storageOk('1');
    hide();
  }

  function tick() {
    if (done) return;
    if (appReady()) { finish(); return; }
    // body 出现了就把横幅挪进去（见 host() 的说明）
    if (el && global.document.body && el.parentNode !== global.document.body) {
      global.document.body.appendChild(el);
    }
    if (!stuckShown && Date.now() - startedAt >= STUCK_MS) {
      stuckShown = true;
      addStuckNote();
    }
  }

  function start() {
    if (seenBefore()) {
      // 以前成功打开过：先不打扰，只有这次明显慢才提示
      slowTimer = setTimeout(function () { show('slow'); }, SLOW_MS);
    } else {
      show('first');
    }
    pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  if (global.document && global.document.readyState !== 'loading') {
    // 脚本被延后执行（比如被缓存策略改过）时，DOM 可能已经就绪 —— 直接开始
    setTimeout(start, 0);
  } else {
    start();
  }

  // 排查与测试用的把手：真机上出问题时，在控制台里能直接问它现在什么状态。
  global.__dshFirstLoad = {
    KEY: KEY,
    state: function () {
      return {
        shown: !!el, done: done, appReady: appReady(),
        seenBefore: seenBefore(), text: noteEl ? T.stuck : (el ? T.first : null),
        waitedMs: Date.now() - startedAt
      };
    },
    hide: hide,
    tick: tick
  };
})(typeof window !== 'undefined' ? window : globalThis);
