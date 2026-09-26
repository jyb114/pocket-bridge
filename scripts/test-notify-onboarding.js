// 手机端「开启提醒」这段引导的测试（2026-09-27 重写之后补的）。
//
// 为什么这件小事值得单独一个测试：
//   提醒入口需要清晰、一步可达。上一版把「不装 App」这条主路埋成了角落里一个
//   小按钮，还在旁边摆着「装 ntfy、抄主题名」的教程，等于劝退。
//   所以这里守的是四条：
//     ① 手机上出现的是**一张看得见的卡片**，一个按钮点完就够
//     ② 卡片文案里**不能出现** ntfy / 主题名 / 订阅 这些词（那是可选路径，不是主路）
//     ③ 已经开过的设备**不再打扰**（但会悄悄确认订阅还在）
//     ④ iPhone 在 Safari 标签页里点「开启」是无效的（iOS 硬限制），
//        所以给的是「两步加主屏幕」的版本，而不是让他点了没反应
//
// 跑法：把真的 pwa/boot.js 丢进假 DOM 的 vm 里跑（真文件，不是复制品）。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'boot.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

/** 假的 window / document / navigator，只做 boot.js 用到的那几件事 */
function fakeEnv(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const calls = { fetch: [], subscribe: 0, getSubscription: 0, permission: 0, tokens: [] };
  let idSeq = 0;

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '', type: '', textContent: '', innerHTML: '', disabled: false,
      children: [], parentNode: null, style: { cssText: '' }, handlers: {},
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
      // 测试用：模拟一次点击
      click() { (this.handlers.click || []).forEach((fn) => fn({})); return this; }
    };
    return el;
  }

  const all = [];
  const body = makeEl('body');
  const head = makeEl('head');
  const doc = {
    readyState: 'complete',
    body, head, documentElement: makeEl('html'),
    createElement(tag) { const el = makeEl(tag); el.__n = ++idSeq; all.push(el); return el; },
    getElementById(id) { return all.find((el) => el.id === id) || null; },
    addEventListener() { }
  };
  if (o.docLang) doc.documentElement.lang = o.docLang;   // 模拟 DSH 写上去的语言
  doc.head.appendChild = body.appendChild.bind(body);   // 简化：样式也挂到 body

  const win = {
    document: doc,
    location: { href: 'https://example.test/', reload() { } },
    __dshGwEmbedded: o.embedded === true,
    addEventListener() { },               // 键盘/尺寸那几个监听，这里不需要它们工作
    removeEventListener() { },
    matchMedia: () => ({ matches: o.standalone === true, addEventListener() { } }),
    visualViewport: null,
    navigator: {
      userAgent: o.ua || 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile',
      languages: o.languages || ['zh-CN'],
      language: (o.languages || ['zh-CN'])[0],
      standalone: o.standalone === true,
      serviceWorker: o.noSW ? undefined : {
        register() { return Promise.resolve({}); },
        addEventListener() { },          // pinCodeFingerprint 会挂一条 message 监听
        ready: Promise.resolve({
          pushManager: {
            subscribe() { calls.subscribe++; return Promise.resolve({ endpoint: 'https://push.test/1', keys: {} }); },
            getSubscription() { calls.getSubscription++; return Promise.resolve(o.existingSub || null); }
          }
        })
      }
    },
    Notification: o.noNotification ? undefined : {
      permission: o.permission || 'default',
      requestPermission() {
        calls.permission++;
        calls.tokens.push('requestPermission');
        return Promise.resolve(o.grantResult || 'granted');
      }
    },
    PushManager: o.noSW ? undefined : function () { },
    matchMedia: () => ({ matches: o.standalone === true }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    fetch: (url, init) => {
      calls.fetch.push(String(url));
      if (String(url).indexOf('/__push/vapid') >= 0) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('BFakeVapidKeyForTest') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => 0,
    console: { log() { }, warn() { }, error() { } },
    Uint8Array, Promise, Date, Number, String, Array, Object, JSON, Error
  };
  win.window = win;
  win.globalThis = win;
  win.__store = store;
  win.__calls = calls;
  win.__els = all;
  return win;
}

function run(env) {
  const sandbox = Object.assign(Object.create(null), env);
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'boot.js' });
}

// 「卡片还在不在」的判据：**还挂在页面上**才算在。
// 只查 getElementById 不够 —— 被 remove() 掉的元素仍留在测试的记录里，
// 那会让「卡片消失了吗」永远为真（第一版就是这么误报的）。
const cardOf = (env) => {
  const el = env.document.getElementById('dsh-gw-notifycard');
  return el && el.parentNode ? el : null;
};
const byId = (env, id) => {
  const el = env.document.getElementById(id);
  return el && el.parentNode ? el : null;
};
const flush = () => new Promise((r) => setTimeout(r, 20));

(async function main() {
  console.log('\n=== 手机端「开启提醒」引导 · 回归 ===\n');

  // ① 安卓 + 还没决定：一张卡片、一个按钮
  {
    const env = fakeEnv({ permission: 'default' });
    run(env);
    await flush();
    const card = cardOf(env);
    ok('安卓上出现一张看得见的卡片（不是角落里的小按钮）', !!card);
    const main = byId(env, 'dsh-gw-notify');
    const later = byId(env, 'dsh-gw-notify-later');
    ok('卡片上有「开启提醒」和「以后再说」两个按钮', !!main && !!later);
    const text = card ? (card.children.map((c) => c.textContent || c.innerHTML).join(' ') +
      (card.children[1] ? card.children[1].children.map((c) => c.textContent || c.innerHTML).join(' ') : '')) : '';
    ok('卡片里不出现 ntfy / 主题名 / 订阅 这些词（那条是可选路径，不是主路）',
      !/ntfy|Bark|主题名|订阅/i.test(text), text.slice(0, 120));
    ok('卡片说清了「不用装任何 App」', /不用装|不装/.test(text), text.slice(0, 120));

    main.click();
    await flush();
    ok('点一下就会去申请通知权限（用户手势里）', env.__calls.permission === 1, `permission=${env.__calls.permission}`);
    ok('点了就真的订阅了', env.__calls.subscribe === 1, `subscribe=${env.__calls.subscribe}`);
    ok('订阅结果回传给了电脑（POST /__push/subscribe）',
      env.__calls.fetch.some((u) => u.indexOf('/__push/subscribe') >= 0), env.__calls.fetch.join(','));
    ok('成功之后卡片消失（不再挡着界面）', !cardOf(env));
  }

  // ② 已经开过：不再打扰，但悄悄确认订阅还在
  {
    const env = fakeEnv({ permission: 'granted' });
    run(env);
    await flush();
    ok('已授权 → 不再弹卡片（不打扰）', !cardOf(env));
    ok('但仍然会确认一次订阅（浏览器升级/订阅过期都会丢）',
      env.__calls.getSubscription === 1, `getSubscription=${env.__calls.getSubscription}`);
    ok('并且把订阅重新交给了电脑', env.__calls.fetch.some((u) => u.indexOf('/__push/subscribe') >= 0));
  }

  // ③ 已经有订阅在：照样上报一次，且不重复订阅
  {
    const env = fakeEnv({ permission: 'granted', existingSub: { endpoint: 'https://push.test/have', keys: {} } });
    run(env);
    await flush();
    ok('已有订阅时不重复订阅（不打扰，也不刷服务端）', env.__calls.subscribe === 0);
    ok('但会把现有订阅上报一次（服务端可能重启过、名单丢了）',
      env.__calls.fetch.some((u) => u.indexOf('/__push/subscribe') >= 0));
  }

  // ④ iPhone 在 Safari 标签页里：给「两步加主屏幕」，点了不能是白点
  {
    const env = fakeEnv({ permission: 'default', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', standalone: false });
    run(env);
    await flush();
    const card = cardOf(env);
    ok('iPhone（Safari 标签页）照样出现卡片', !!card);
    const text = card ? card.children.map((c) => c.textContent || c.innerHTML).join(' ') : '';
    ok('卡片给的是「两步」版本（分享 → 添加到主屏幕）', /分享/.test(text) && /主屏幕/.test(text), text.slice(0, 140));
    ok('并且说明这不是装 App', /不是装|不是安装/.test(text), text.slice(0, 160));
    const main = byId(env, 'dsh-gw-notify');
    if (main) main.click();
    await flush();
    ok('这一颗按钮**不会**去申请权限（iOS 在标签页里申请是无效的，点了等于白点）',
      env.__calls.permission === 0, `permission=${env.__calls.permission}`);
  }

  // ⑤ 从主屏幕图标打开（standalone）：这时候申请权限才是有效的
  {
    const env = fakeEnv({ permission: 'default', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', standalone: true });
    run(env);
    await flush();
    const main = byId(env, 'dsh-gw-notify');
    ok('从主屏幕图标打开时，卡片是真的能点的那个版本', !!main);
    if (main) main.click();
    await flush();
    ok('这一颗点下去会真的申请权限并订阅',
      env.__calls.permission === 1 && env.__calls.subscribe === 1,
      `permission=${env.__calls.permission} subscribe=${env.__calls.subscribe}`);
  }

  // ⑥ 「以后再说」：7 天内不再出现
  {
    const env = fakeEnv({ permission: 'default' });
    run(env);
    await flush();
    const later = byId(env, 'dsh-gw-notify-later');
    if (later) later.click();
    ok('「以后再说」把卡片收起来', !cardOf(env));
    ok('并且记下了这件事（避免每次打开都来烦）',
      !!env.__store['dsh-gw-notify-dismissed-v1'], Object.keys(env.__store).join(','));

    const env2 = fakeEnv({ permission: 'default', store: env.__store });
    run(env2);
    await flush();
    ok('下次打开不再出现（记着「以后再说」）', !cardOf(env2));
  }

  // ⑦ 不支持通知的浏览器：什么都别做
  {
    const env = fakeEnv({ noNotification: true });
    run(env);
    await flush();
    ok('浏览器不支持通知 → 完全不出卡片、不发请求',
      !cardOf(env) && env.__calls.fetch.length === 0);
  }

  // ⑧ 权限被拒：卡片仍然在（告诉他去设置里开），点一下会给一句人话
  {
    const env = fakeEnv({ permission: 'denied', grantResult: 'denied' });
    run(env);
    await flush();
    ok('权限被拒时卡片还在（否则他永远不知道去哪开）', !!cardOf(env));
    const main = byId(env, 'dsh-gw-notify');
    if (main) main.click();
    await flush();
    const toast = byId(env, 'dsh-gw-toast');
    ok('点一下会给出「去设置里允许」这样一句人话',
      !!toast && /设置/.test(String(toast.textContent)), toast ? toast.textContent : '(没有提示)');
  }

  // ⑨ 我们**自己写**的文案也要跟着语言走
  //
  //    多语言检查发现：DSH 那套界面会跟着切
  //    （见 i18n.js 的 navigator 改写），但**我们自己注入的两条横幅**是硬编码中文。
  //    这一条就是守它们的。
  {
    const env = fakeEnv({ permission: 'denied', store: { 'dsh-lang': 'en' }, languages: ['zh-CN'] });
    run(env);
    await flush();
    const bar = byId(env, 'dsh-gw-security');
    ok('选了英文 → 我们那条安全提示也是英文（不是「私人入口」那串中文）',
      !!bar && /private entrance/i.test(String(bar.children[0] ? bar.children[0].innerHTML : '')),
      bar && bar.children[0] ? String(bar.children[0].innerHTML).slice(0, 80) : '(没有横幅)');
    ok('按钮文字也是英文', !!bar && /Got it/i.test(String(bar.children[1] ? bar.children[1].textContent : '')),
      bar && bar.children[1] ? String(bar.children[1].textContent) : '(没有按钮)');
  }

  // ⑩ DSH 那边的语言没跟上时，给一次指路（它自己的设置项会盖过我们）
  {
    const env = fakeEnv({
      permission: 'denied', store: { 'dsh-lang': 'en' }, languages: ['zh-CN'],
      embedded: true, docLang: 'zh-CN'
    });
    run(env);
    // 这一条要等 DSH 起来之后才检查（boot.js 里延后 3 秒，好让 DSH 先把它自己的
    // 语言写到 <html lang> 上）。假 DOM 里就真的等这么久 —— 别为了快把它改成 0，
    // 那样测的就不是同一件事了。
    await new Promise((r) => setTimeout(r, 3300));
    const toast = byId(env, 'dsh-gw-toast');
    ok('DSH 界面没跟着变 → 提示去 DSH 自己的设置里再选一次',
      !!toast && /Settings/i.test(String(toast.textContent)), toast ? String(toast.textContent).slice(0, 90) : '(没有提示)');
  }

  // ⑪ DSH 跟上了：不要再提示（不然每次都弹，等于噪音）
  {
    const env = fakeEnv({
      permission: 'denied', store: { 'dsh-lang': 'en' }, languages: ['zh-CN'],
      embedded: true, docLang: 'en'
    });
    run(env);
    await flush();
    ok('DSH 已经跟着变了 → 不提示', !byId(env, 'dsh-gw-toast'));
  }

  console.log(`\n${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('跑挂了：' + (e && e.stack)); process.exit(1); });
