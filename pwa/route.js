// DSH 移动端网关 — 连接路径守夜
//
// 注入到 DSH 页面里，做两件小事：
//
//   1. 角标：告诉你现在走的是哪条路（内网直连 / 外网隧道 / IPv6），点一下能换
//
//   2. 断线自救：手机换网（WiFi→4G）、隧道重建、电脑换 IP 都会让当前路径失效，
//      表现就是「页面突然刷不出来了」。这时候如果手上没有别的路可走，就只能干瞪眼。
//
//      难点在于：路一旦断了，就没法再从这台服务器申请切换凭证了 —— 请求根本到不了。
//      所以这里提前把切换票据要到手、放在兜里（60 秒有效），并且趁路还通的时候
//      不断续期。真断了就直接用兜里那张跳过去。
//
// 尽量不打扰：只在右下角放一个小角标，不出问题时不说话。
'use strict';

(function () {
  if (window.__dshGwRouteLoaded) return;
  window.__dshGwRouteLoaded = true;

  // ── 多语言 ─────────────────────────────────────────────────────────────────
  // 中文原文就是 key（见 pwa/i18n.js）：翻不到就原样返回中文，页面永远不留空洞。
  // i18n.js 由网关注入在 route.js **之前**，所以这里能直接用；万一它没加载，
  // t() 就退化成「原样返回」，角标照常显示中文。
  var t = (window.DshI18n && window.DshI18n.t) ? window.DshI18n.t : function (s) { return s; };

  if (window.DshI18n) window.DshI18n.register({
    "内网直连": { en: "Local network", es: "Red local" },
    "IPv6 直连": { en: "IPv6 direct", es: "IPv6 directa" },
    "外网隧道": { en: "Tunnel", es: "Túnel" },
    "本机": { en: "This device", es: "Este equipo" },
    "连接已断": { en: "Disconnected", es: "Sin conexión" },
    " · 可切": { en: " · switch", es: " · cambiar" },
    "未加密": { en: "Unencrypted", es: "Sin cifrar" },
    "这条连接方式（明文 HTTP）没法加密 —— 点一下换一条能加密的路": { en: "This connection (plain HTTP) cannot be encrypted — tap to switch to one that can", es: "Esta conexión (HTTP sin cifrar) no se puede cifrar; toca para cambiar a una que sí" },
    "这条链接没带加密密钥 —— 实时通道会被拒绝，打不开对话": { en: "This link has no encryption key — the live channel is refused, so conversations will not open", es: "Este enlace no lleva clave de cifrado: el canal en vivo se rechaza y las conversaciones no se abrirán" },
    "换一个目标（DSH / Codex）": { en: "Switch target (DSH / Codex)", es: "Cambiar de destino (DSH / Codex)" },
    "· 内网 HTTPS：<code>https://{host}:8081/…</code>（第一次要信任一下自签证书）<br>": { en: "· Local HTTPS: <code>https://{host}:8081/…</code> (you must trust the self-signed certificate the first time)<br>", es: "· HTTPS en red local: <code>https://{host}:8081/…</code> (la primera vez hay que confiar en el certificado autofirmado)<br>" },
    "<b>这条路是明文</b><br>同一 WiFi 下别人可以抓包看到内容。<br><br><b>要加密，换下面任一条：</b><br>{lanTip}· 在外面用隧道地址：<code>https://…trycloudflare.com/…</code>": { en: "<b>This route is unencrypted</b><br>Someone on the same WiFi could read the content.<br><br><b>For encryption, use either route below:</b><br>{lanTip}· Use the tunnel address when away: <code>https://…trycloudflare.com/…</code>", es: "<b>Esta vía no va cifrada</b><br>Alguien en la misma WiFi podría leer el contenido.<br><br><b>Para tener cifrado, usa una de estas vías:</b><br>{lanTip}· Usa la dirección del túnel cuando estés fuera: <code>https://…trycloudflare.com/…</code>" },
    "<b>这条地址不完整</b><br>会这样：页面能开，但<b>对话列表是空的</b>。<br><br><b>怎么办：</b>到电脑上打开控制台 → 复制末尾带 <code>#k=</code> 的完整地址 → 在手机上打开一次。原来的书签还能用就继续用。": { en: "<b>This address is incomplete</b><br>What you get: the page opens, but <b>the conversation list stays empty</b>.<br><br><b>What to do:</b> open the console on your computer → copy the full address ending in <code>#k=</code> → open it once on your phone. If your old bookmark still works, keep using it.", es: "<b>Esta dirección está incompleta</b><br>Qué pasa: la página se abre, pero <b>la lista de conversaciones queda vacía</b>.<br><br><b>Qué hacer:</b> abre la consola en el ordenador → copia la dirección completa que termina en <code>#k=</code> → ábrela una vez en el teléfono. Si tu marcador antiguo aún funciona, sigue usándolo." },
    "换一条路": { en: "Switch route", es: "Cambiar de vía" },
    "知道了": { en: "Got it", es: "Entendido" }
  });

  var POLL_MS = 20000;      // 自查当前路径的频率
  var REFRESH_MS = 45000;   // 备用票据的续期频率（票据 60 秒有效）
  var state = {
    info: null,
    standby: null,        // { id, label, url, at }
    fails: 0,
    dead: false,
    el: null,
    balance: null         // DeepSeek 余额，并进右下角那个角标显示
  };

  function fetchT(url, opts, ms) {
    opts = opts || {};
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = null;
    if (ctl) {
      opts.signal = ctl.signal;
      timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms);
    }
    return fetch(url, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  // text 一律是中文原文，取用时再翻（paint 每次都取，所以切语言后下一次重画就变）
  var KIND_STYLE = {
    lan: { text: '内网直连', color: '#3ddc84' },
    ipv6: { text: 'IPv6 直连', color: '#7cc4ff' },
    tunnel: { text: '外网隧道', color: '#f0cf85' },
    loopback: { text: '本机', color: '#8a8a92' }
  };

  function badge() {
    if (state.el) return state.el;
    var el = document.createElement('div');
    el.id = 'dsh-gw-badge';
    el.setAttribute('role', 'button');
    el.style.cssText = [
      // 不再自己 fixed —— 它是停靠栏里的一个成员，跟着那一行走。
      // 原来四个元素各飘各的，在右下角堆了 128px 高，键盘一弹就压住输入区。
      'position:relative',
      'font:500 12px/1 -apple-system,system-ui,sans-serif',
      // 用 min-height 做到 44（触控下限），而不是堆 padding ——
      // 这样它不会看起来像个臃肿的大药丸
      'min-height:44px', 'padding:0 13px', 'box-sizing:border-box',
      'border-radius:999px', 'background:rgba(20,20,24,.88)',
      'color:#ddd', 'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
      'border:1px solid rgba(255,255,255,.12)', 'cursor:pointer',
      'display:flex', 'align-items:center', 'gap:6px', 'user-select:none',
      'opacity:.94', 'transition:opacity .2s',
      'pointer-events:auto'
    ].join(';');
    el.addEventListener('click', function () {
      // 未加密时点它是「解释一下 + 指出该换哪条路」，而不是跳去换路线 ——
      // 这时候使用者最需要知道的是「为什么没加密、该怎么办」。
      if (plaintextReason()) { explainPlaintext(); return; }
      // 带上 location.hash —— 那里面是加密密钥（#k=…）。
      // 不带的话，从角标点进选路页就**静默变明文**了：
      // 页面照常、不报错，只是隧道从此能看懂一切。
      // fragment 不会发给服务器，只能靠前端一站一站自己传下去。
      location.href = '/go' + location.hash;
    });
    dock().appendChild(el);
    state.el = el;
    return el;
  }

  /**
   * 换一个目标的小按钮。
   *
   * 只在真的装了不止一个目标时才出现 —— 只有一个的时候显示它纯属添乱。
   * 点了会清掉「记住的选择」并回到选择页。
   */
  /**
   * 右下角的「停靠栏」—— 我注入的浮动元素都收在这一行里。
   *
   * 为什么要有它：之前语音、切换、余额、通知四个东西各飘各的，
   * 在右下角堆了 128px 高。手机键盘一弹起来就压住输入区，发送都点不到。
   * 现在合并成一行，总共 46px 高。
   */
  function dock() {
    if (state.dock) return state.dock;
    // **先看 DOM 里有没有已经建好的** —— boot.js 那边也可能先建了一个。
    // 不查就会建出第二个停靠栏，页面上出现两条，而且互相不知道对方存在。
    // （实测就是这么冒出来的：一个装语音按钮，一个装角标。）
    var existing = document.getElementById('dsh-gw-dock');
    if (existing) { state.dock = existing; return existing; }

    var el = document.createElement('div');
    el.id = 'dsh-gw-dock';
    el.style.cssText = [
      'position:fixed', 'right:10px',
      // ★ 抬到输入框那一行**之上**（原来只有 10px，正好压在发送/麦克风/附件
      //   那一排上），容易误触角标或 ⇄（换目标），尤其在窄屏设备上。
      //   仍然贴右下，但不再和那一排按钮抢手指。
      'bottom:calc(96px + env(safe-area-inset-bottom,0px))',
      'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:8px',
      'pointer-events:none'          // 容器本身不吃点击，里面每个按钮自己吃
    ].join(';');
    document.body.appendChild(el);
    state.dock = el;
    return el;
  }

  function targetSwitch() {
    // 切换按钮不再单独飘着 —— 它现在是角标里的一个小方块。
    // 留着这个函数是因为 paint() 还要用它来设置显隐。
    if (state.sw) return state.sw;
    var el = document.createElement('span');
    el.id = 'dsh-gw-switch';
    el.setAttribute('role', 'button');
    el.title = t('换一个目标（DSH / Codex）');
    el.textContent = '⇄';
    el.style.cssText = [
      'display:none', 'align-items:center', 'justify-content:center',
      'width:28px', 'height:28px', 'border-radius:8px', 'flex:none',
      'background:rgba(255,255,255,.10)', 'color:#ddd',
      'font:600 14px/1 -apple-system,system-ui,sans-serif',
      'cursor:pointer', 'user-select:none', 'margin-left:3px'
    ].join(';');
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();          // 别触发角标自己的充值跳转
      location.href = '/?target=pick' + location.hash;   // 带上密钥，否则切目标就变明文
    });
    state.sw = el;
    return el;
  }

  function paint() {
    var el = badge();
    var info = state.info;
    var k = info && info.arrival ? info.arrival.kind : 'tunnel';
    var s = KIND_STYLE[k] || KIND_STYLE.tunnel;
    var dotColor = state.dead ? '#f56c6c' : s.color;
    var text = state.dead ? t('连接已断') : t(s.text);
    if (state.standby && !state.dead) text += t(' · 可切');

    // 「未加密」优先于连接方式显示 —— 它是更该被看见的那件事。
    //
    // 为什么不额外加一段文字：实测这个角标本来就顶到 260px 的宽度上限了
    // （test-balance-placement.js 卡的就是这条，因为右下角一旦变宽就会挡住内容）。
    // 再加几个字直接顶到 315px、离角 65px，把之前返工修好的问题又做回来了。
    //
    // 所以这里**替换**而不是追加：「内网 HTTPS · 可切」本来 8 个字符，
    // 换成「未加密 · 可切」反而更短 —— 零像素代价，还更醒目（琥珀色 + 琥珀点）。
    var why = plaintextReason();
    if (why) {
      text = t('未加密');
      if (state.standby && !state.dead) text += t(' · 可切');
      dotColor = '#ffb454';
    }

    el.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:' +
      dotColor + ';display:inline-block"></span><span>' + text + '</span>' +
      balanceSpan();
    el.title = why
      ? (why === 'insecure'
        ? t('这条连接方式（明文 HTTP）没法加密 —— 点一下换一条能加密的路')
        : t('这条链接没带加密密钥 —— 实时通道会被拒绝，打不开对话'))
      : (info && info.advice ? info.advice : '');
    el.style.cursor = why ? 'pointer' : '';

    // innerHTML 会把这个角标的子元素全清掉 —— 切换按钮就在里面，
    // 所以每次重画之后要把它放回去。忘了这一步的表现是
    // 「切换按钮时有时无」，很难查。
    if (state.sw && state.sw.parentNode !== el) {
      el.appendChild(state.sw);
    }
  }

  /**
   * 「未加密」到底是哪一种 —— 两种原因，修法完全不同。
   *
   *   'insecure' 连的是明文 HTTP（内网 8080），浏览器在非安全上下文里
   *              **不给** crypto.subtle，所以这条路**永远**加不了密。
   *              修法：换 https 那条路（内网 8081 或隧道）。
   *
   *   'nokey'    连接方式本身能加密（HTTPS），但这条链接没有 #k= 那段。
   *              修法：用带 #k= 的完整地址重新进一次。
   *
   * 为什么必须分开：这两种情况的建议是**相反**的。
   * 对着一个「明文 HTTP 进不来」的人说「你的链接少了密钥」，
   * 他会去反复检查网址、换书签 —— 而问题根本不在那儿，怎么试都没用。
   */
  function plaintextReason() {
    if (typeof window === 'undefined') return null;
    if (window.__dshE2eeConfigured !== true) return null;   // 电脑上就没配，正常
    if (window.__dshE2eeOn === true) return null;           // 加密中

    // available() 判的就是 crypto.subtle 在不在
    var canEncrypt = true;
    try {
      canEncrypt = !!(window.DshE2EE && window.DshE2EE.available && window.DshE2EE.available());
    } catch (e) { /* 拿不准就按「能加密」算，走 nokey 那条建议 */ }
    return canEncrypt ? 'nokey' : 'insecure';
  }

  /** 点角标时解释清楚：为什么会这样、怎么修。 */
  function explainPlaintext() {
    if (document.getElementById('dsh-gw-plain-box')) return;
    var reason = plaintextReason();

    var box = document.createElement('div');
    box.id = 'dsh-gw-plain-box';
    box.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:64px', 'z-index:2147483647',
      'background:#3a2f0b', 'color:#ffe9a8', 'border:1px solid #6b5a1f',
      'border-radius:12px', 'padding:14px 16px', 'font-size:13px', 'line-height:1.75',
      'font-family:-apple-system,system-ui,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)'
    ].join(';');

    if (reason === 'insecure') {
      // 内网地址**从当前地址推**，不要写死。
      //
      // 原来这里硬编码了 `https://192.168.1.3:8081/…` —— 那台机器的 DHCP
      // 后来把地址换成了 .4，于是这段「教你怎么加密」的提示，
      // 教的是一条**连不上**的地址。使用者照着做只会更困惑。
      // 他现在就在内网上，location.hostname 就是那个 IP，直接拿来用。
      var lanHost = (typeof location !== 'undefined' && location.hostname) ? location.hostname : '';
      var lanTip = lanHost
        ? t('· 内网 HTTPS：<code>https://{host}:8081/…</code>（第一次要信任一下自签证书）<br>', { host: lanHost })
        : '';
      box.innerHTML = t('<b>这条连接方式没法加密</b><br>' +
        '你现在走的是<b>明文 HTTP</b>（内网 8080）。浏览器在非安全上下文里' +
        '不提供加密接口，所以这条路<b>永远</b>加不了密 —— 不是链接写错了。<br><br>' +
        '同一个 WiFi 下，别人抓包就能看到内容。<br><br>' +
        '<b>要加密，换这两条路之一：</b><br>{lanTip}' +
        '· 在外面走隧道：<code>https://…trycloudflare.com/…</code>', { lanTip: lanTip });
    } else {
      box.innerHTML = t('<b>这条链接没有带加密密钥</b><br>' +
        '连接方式本身是能加密的，但你现在这条地址里没有 <code>#k=…</code> 那一段，' +
        '所以内容是<b>明文</b>经过隧道的 —— Cloudflare 那头理论上能看到。<br><br>' +
        '<b>经过隧道时还会直接看不到任何任务</b>：实时通道要求加密，明文会被拒。' +
        '也就是说「页面能开、里面空的」多半就是这一条。<br><br>' +
        '常见原因有两个：换了新的隧道地址（从推送或旧书签点进来），' +
        '或者<b>从主屏图标进来</b> —— iOS 存图标时会把 <code>#k=</code> 那一段丢掉。<br>' +
        '修法都一样：用带 <code>#k=</code> 的完整地址打开一次。' +
        '这台设备会记住钥匙，之后从图标进来也是加密的。');
    }

    // ★ 这个面板不只是「解释」，还得给出**下一步怎么走**。
    //
    // 原因：角标本来是进「选择连接方式」页的入口，我给未加密状态加了
    // 「点它先弹说明」之后，等于把那个入口堵上了 —— 使用者反馈
    // 「切换通道点不进去」。说明和入口不是二选一，两个都要有。
    //
    // 而且「换一条路」正是这两种未加密状态的解法：
    // 明文 HTTP 要换到 HTTPS 那条，缺密钥的要回带 #k= 的地址。
    var go = document.createElement('button');
    go.textContent = t('换一条路');
    go.style.cssText = [
      'margin-top:10px', 'margin-right:8px', 'padding:8px 16px', 'border-radius:8px',
      'cursor:pointer', 'background:#ffe9a8', 'color:#3a2f0b', 'border:0',
      'font-weight:600', 'font-size:13px', 'font-family:inherit'
    ].join(';');
    go.addEventListener('click', function () {
      // 带上 location.hash（可能就有密钥，别在这一跳里丢了）
      location.href = '/go' + location.hash;
    });

    var btn = document.createElement('button');
    btn.textContent = t('知道了');
    btn.style.cssText = [
      'margin-top:10px', 'padding:8px 16px', 'border-radius:8px', 'cursor:pointer',
      'background:#2c2c2e', 'color:#eee', 'border:0', 'font-weight:600',
      'font-size:13px', 'font-family:inherit'
    ].join(';');
    btn.addEventListener('click', function () { box.remove(); });

    box.appendChild(go);
    box.appendChild(btn);
    document.body.appendChild(box);
  }
  /**
   * 余额并进右下角这个角标里，而不是自己钉在屏幕上。
   *
   * 为什么：单独占一块位置就会挡内容 —— 左下角正好压着输入区附近，
   * 使用者切到别的页面、滚动到底部时都会撞上。这个角标本来就在那儿，
   * **并进去等于零额外占位**。
   *
   * 只在拿到数字后才出现；查不到就什么都不加，角标保持原样。
   */
  function balanceSpan() {
    if (!state.balance) return '';
    var sym = state.balance.currency === 'CNY' ? '¥' : state.balance.currency + ' ';
    var color = state.balance.empty ? '#ff6b6b'
      : (state.balance.low ? '#ffcc66' : 'rgba(255,255,255,.45)');
    return '<span style="width:1px;height:11px;background:rgba(255,255,255,.16);' +
      'display:inline-block;margin:0 2px"></span>' +
      '<span style="color:' + color + '">' + sym + state.balance.total.toFixed(2) + '</span>';
  }

  /** 查一次 DeepSeek 余额。失败就算了 —— 角标上少一段，不影响任何功能。 */
  function loadBalance(force) {
    fetch('/__deepseek/balance' + (force ? '?force=1' : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.balance = (j && j.ok) ? j : null;
        paint();
      })
      .catch(function () { /* 查不到就不显示 */ });
  }

  /** 拿一份备用票据，放在兜里，路断了就用它。 */
  function refreshStandby() {
    if (document.visibilityState !== 'visible') return;
    fetchT('/__routes', { cache: 'no-store' }, 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.info = d;
        state.fails = 0;
        if (state.dead) { state.dead = false; }
        paint();

        // 装了不止一个目标才显示切换按钮 —— 只有一个的时候它纯属添乱
        if (Number(d.installedTargets) > 1) {
          var sw = targetSwitch();
          // 塞进角标里，而不是自己 fixed 飘着 —— 右下角只留一行
          var bg = badge();
          if (sw.parentNode !== bg) bg.appendChild(sw);
          sw.style.display = 'flex';
        }

        // 找一个比现在更好的备选：**先看加不加密，再看是哪条路**。
        //
        // 这里原来只有 { lan: 1, ipv6: 2, tunnel: 3 } —— 压根没列 `lan-https`，
        // 于是它落到兜底的 9，排到了「明文内网」和「隧道」**后面**。
        // 后果很实际：家里内网 HTTPS 明明开着（又快又加密），自动备选却挑了
        // 明文 8080 —— 手机一切过去就变成明文，而且**不声不响**。
        // 使用者只会看到角标突然写「未加密」，完全不知道为什么。
        //
        // 排序原则：能加密的一律优先。同是加密再看路（内网 > IPv6 > 隧道）。
        // 明文内网排在隧道后面，因为隧道至少是 HTTPS（传输层是加密的），
        // 而明文内网是整条路裸奔。
        // ★ 自动切换只准落在「**一定打得开**」的那条路上。
        //
        //   原来 order 把 lan-https 排第一，而下面除了 sameNetwork 之外不做
        //   任何检查 —— 于是手机在外面（或没信任过本机 CA）时会被自动送到
        //   https://192.168.1.3:8081：自签证书没被信任，浏览器只给一页证书
        //   错误，**比不切还糟**。2026-09-22 15:00 就是这么把使用者弄断线的
        //   （日志：登记设备 → 挑战应答通过 → 发出换路径票据 → 192.168.1.3:8081，
        //    之后手机就再没回来）。
        //
        //   lan-https 要能用，前提是这台手机信任过我们的 CA —— 而这件事
        //   route.js 无法确知（探测要用 fetch，证书不对只会 reject，拿不到
        //   「是证书的问题」还是「网络不通」）。所以自动切换**一律不选它**，
        //   只留给人手动点。内网明文那条没有证书问题，是安全的落点。
        var order = { 'lan-https': 1, tunnel: 2, ipv6: 3, lan: 4 };
        var cur = d.arrival.authority;
        var alts = (d.candidates || []).filter(function (c) {
          return c.authority !== cur && !c.selfTestOnly;
        });
        // 内网那两条只有在**确认同一个网络**时才允许自动切过去 ——
        // 人在外面时 192.168.x.x 根本到不了，切过去就是白屏。
        alts = alts.filter(function (c) {
          if (c.kind !== 'lan' && c.kind !== 'lan-https') return true;
          return d.sameNetwork === true;
        });
        alts.sort(function (a, b) {
          return (order[a.kind] || 9) - (order[b.kind] || 9);
        });
        // 同一个网络里却绕隧道 —— 那内网那条就是该留的备用
        //
        // ★ 但自动导航**不选 lan-https**。
        //
        //   排序表保持「加密优先」是对的 —— 那是给人看的、给人手动选的。
        //   可自动导航是另一回事：lan-https 能不能用，取决于**这台手机有没有
        //   信任过我们的自签 CA**，而这件事客户端无法确知（探测要用 fetch，
        //   证书不对只会 reject，分不清是证书问题还是网络不通）。
        //   猜错的代价是一整页证书错误 —— **比不切还糟**。
        //   2026-09-22 15:00 就是这么把使用者弄断线的：登记设备 → 挑战应答通过
        //   → 发出换路径票据 → 192.168.1.3:8081，之后手机再没回来。
        //
        //   内网明文那条没有证书问题，是安全的落点。
        var safe = alts.filter(function (c) { return c.kind !== 'lan-https'; });
        var want = safe[0];
        if (!want) { state.standby = null; return; }
        if (!(d.sameNetwork && cur.indexOf(':') < 0) && want.kind !== 'lan') {
          // 不在同一网络时，备用意义不大（内网地址在外面根本到不了），
          // 但留着也没坏处 —— 万一手机正好切回家里 WiFi 呢
        }

        // target=dsh：换路径会换 origin，cookie 不跟着走，带上这个才不会
        // 切过去之后又被问一遍「你要用哪个」
        return fetchT('/__switch?target=dsh&to=' + encodeURIComponent(want.id),
          { cache: 'no-store' }, 10000)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) {
              state.standby = { id: want.id, label: want.label, url: j.url, at: Date.now() };
            }
          });
      })
      .catch(function () {
        state.fails++;
        if (state.fails >= 2) {
          state.dead = true;
          paint();
          useStandby();
        }
      });
  }

  /** 当前路径断了：用兜里的票据跳到另一条路上。 */
  function useStandby() {
    var s = state.standby;
    if (!s) return false;
    // 票据只有 60 秒有效，太旧的就别用了 —— 跳过去也是「票据已过期」页面
    if (Date.now() - s.at > 55000) return false;
    // 切路径同样要带上密钥。票据 URL 是服务器签的，天生不含 fragment，
    // 不带的话每次网络切换都会把加密悄悄换掉。
    location.replace(s.url + location.hash);
    return true;
  }

  /** 自查：这条路上还能不能到服务器。 */
  function selfCheck() {
    if (document.visibilityState !== 'visible') return;
    if (navigator.onLine === false) return; // 手机自己没网，不是路径的问题
    fetchT('/__probe?_=' + Date.now(), { cache: 'no-store' }, 6000)
      .then(function () {
        if (state.fails > 0 || state.dead) {
          state.fails = 0;
          state.dead = false;
          paint();
        }
      })
      .catch(function () {
        state.fails++;
        if (state.fails >= 2) {
          state.dead = true;
          paint();
          useStandby();
          // 兜里没有票据，就过一会儿再试一次
          setTimeout(refreshStandby, 3000);
        }
      });
  }

  // 手机切换网络时立刻查一次，不用等轮询
  window.addEventListener('online', function () {
    state.fails = 0;
    state.dead = false;
    paint();
    selfCheck();
    refreshStandby();
  });
  window.addEventListener('offline', function () {
    state.dead = true;
    paint();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      selfCheck();
      refreshStandby();
      loadBalance(true);
    }
  });

  /**
   * 挑战应答 —— 向电脑证明「我知道 # 里那串」，但不把它发出去。
   *
   * 目的：现在让你登进来的凭证是**路径里的访问密钥**（/k/<密钥>），
   * 而路径是 HTTP 请求行的一部分，隧道（TLS 终点）看得见 ——
   * 它把那条请求自己发一遍就能冒充你。
   * # 后面那串它从来没见过，所以拿它当进门凭证，隧道就进不来。
   *
   * ★ 2026-09-27：网关那边已经把它开成**真拦**（没通过就只给页面和脚本，
   *   内容一律 403）。所以这里从「发出去就不管」升级成两条保障：
   *     · 首选 `DshE2EE.prove()` —— 它是这次新加的、带自动续证和失败重试的那份实现
   *       （e2ee.js 里），而且会在开页面时就先证一次；
   *     · 下面这段内联实现**保留**成兜底 —— 手机要是还跑着旧版 e2ee.js
   *       （Service Worker 会拦下指纹对不上的新代码，要人点一次「信任新版本」），
   *       旧版没有 prove()，这条兜底就是那段时间里唯一能证明的路。
   */
  function proveIdentity() {
    // 首选：e2ee.js 里那份（去重、自动续证、被拦重试都在它那儿）
    try {
      if (window.DshE2EE && window.DshE2EE.prove) { window.DshE2EE.prove(true); return; }
    } catch (e) { /* 落到下面的兜底 */ }
    // ★ 用 window，不是 global。
    //   第一版这里写的是 global.crypto / global.__dshE2eeSecret ——
    //   那是 Node 的写法，**浏览器里根本没有 global 这个标识符**，
    //   第一行就抛 ReferenceError，然后被我外面那个 try/catch 悄悄吞掉。
    //   表现是"功能完全不工作，但什么错都不报" —— 最难查的那种。
    //   （e2ee.js 里能用 global，是因为它自己包了一层、把 global 当参数传进去；
    //     route.js 没有那层包装。）
    if (!window.crypto || !window.crypto.subtle) return;   // 非安全上下文，没有加密接口

    var tries = 0;
    (function wait() {
      var secret = window.__dshE2eeSecret;
      var api = window.DshE2EE;
      if (!secret || !api || !api.authResponse) {
        if (++tries > 40) return;          // 最多等 10 秒，等不到就算了
        return setTimeout(wait, 250);
      }
      send(secret, api);
    })();

    function send(secret, api) {
      fetch('/__auth/challenge', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok || !j.nonce) return;
          return api.authResponse(secret, j.nonce).then(function (response) {
            return fetch('/__auth/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ nonce: j.nonce, response: response })
            });
          });
        })
        .catch(function () { /* 证不了就证不了，不挡任何事 */ });
    }
  }

  function boot() {
    paint();
    refreshStandby();
    loadBalance(false);
    // 缺密钥这种情况**主动弹一次**说明，不等人去点角标。
    //
    // 为什么：这时候界面的表现是「页面能开、里面空的」—— 使用者完全无从下手，
    // 只会以为页面故障或内容未加载。
    // 一次会话只弹一次，免得每次刷新都糊一脸。
    try {
      var SHOWN = 'dsh-gw-nokey-explained-v1';
      if (plaintextReason() === 'nokey' && !sessionStorage.getItem(SHOWN)) {
        sessionStorage.setItem(SHOWN, '1');
        explainPlaintext();
      }
    } catch (e) { /* 存储不可用就算了，角标那条路还在 */ }
    // 身份证明放在最后，而且是"发出去就不管"的 ——
    // 它绝不能拖慢角标、也不能因为它失败影响任何别的东西
    try { proveIdentity(); } catch (e) { }
    setInterval(selfCheck, POLL_MS);
    setInterval(refreshStandby, REFRESH_MS);
    // 余额五分钟刷一次就够了 —— 它不会秒变，没必要频繁打接口
    setInterval(function () { loadBalance(true); }, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
