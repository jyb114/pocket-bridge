// 手机端切换语言后，各目标页面与网关注入文案都应同步更新。
//
// 为什么原来像假的：那个选择只写进 localStorage，而有两处看不见它 ——
//   1. 服务端直出的页面（配对页 / 选择页 / 启动页）读的是 `dsh-lang` **cookie**；
//   2. **DSH 自己的界面**读的是 `navigator.languages`（手机系统的语言），
//      而且它还有自己的设置项会盖过一切。
//
// 所以 i18n.js 现在多做两件事：把选择写成 cookie、并且在 DSH 的脚本跑起来之前
// 把 navigator 的语言列表换掉。这个测试守的就是这两件 + 一个「不许乱动」：
//   · 使用者**没手选过**的时候，一个字都不许碰（浏览器语言就是他的偏好）
//   · 手选过 → cookie 写对、navigator 换对、`<html lang>` 对
//   · 在 DSH 页面上切换 → 重载一次（DSH 的语言是启动时定的）
//   · 在我们自己那几页切换 → **不**重载（没必要，还会丢当前视图）
//
// 跑法：真的 pwa/i18n.js 丢进假 DOM 的 vm 里跑。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'i18n.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

/** 假 window：只做 i18n.js 用到的那几件事 */
function fakeEnv(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const out = { cookies: [], reloads: 0, defined: [] };
  const doc = {
    documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    cookie: '',
    createElement: () => ({ style: {}, setAttribute() { }, appendChild() { }, addEventListener() { } }),
    querySelectorAll: () => [],
    addEventListener() { }
  };
  Object.defineProperty(doc, 'cookie', {
    get() { return out.cookies.join('; '); },
    set(v) { out.cookies.push(String(v)); }
  });

  const win = {
    document: doc,
    location: { reload() { out.reloads++; }, href: 'https://example.test/' },
    navigator: { languages: o.languages || ['zh-CN', 'zh'], language: (o.languages || ['zh-CN'])[0] },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    __dshGwEmbedded: o.embedded === true,
    setTimeout: (fn) => { fn(); return 0; },     // 重载是延后 60ms 调的，这里立刻执行
    console: { warn() { }, log() { } },
    Object, String, Array, JSON, Error
  };
  win.window = win;
  win.globalThis = win;
  win.__store = store;
  win.__out = out;
  return win;
}

function run(env) {
  const sandbox = Object.assign(Object.create(null), env);
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'i18n.js' });
  // i18n.js 是 `(function (global) {…})(window)` 的形状：它把 API 挂在**传进去的
  // 那个 window** 上（也就是 env），不是挂在 vm 的全局对象上。
  return env.DshI18n || sandbox.DshI18n;
}

(async function main() {
  console.log('\n=== 语言选择要真的生效 · 回归 ===\n');

  // ① 没手选过：一个字都不许碰
  {
    const env = fakeEnv({ languages: ['zh-CN', 'zh'] });
    const api = run(env);
    ok('没手选过 → 不动 navigator（浏览器语言就是他的偏好）',
      env.navigator.language === 'zh-CN' && Array.isArray(env.navigator.languages),
      `${env.navigator.language} / ${JSON.stringify(env.navigator.languages)}`);
    ok('没手选过 → 不写 cookie', env.__out.cookies.length === 0, env.__out.cookies.join('|'));
    ok('界面语言按浏览器来（zh）', api.lang() === 'zh', api.lang());
  }

  // ② 手选过 en：cookie + navigator + html lang 三样都要对上
  {
    const env = fakeEnv({ store: { 'dsh-lang': 'en' }, languages: ['zh-CN', 'zh'] });
    const api = run(env);
    ok('手选过 → cookie 写给服务端（配对页/启动页那些直出页面靠它）',
      env.__out.cookies.some((c) => /^dsh-lang=en;/.test(c)), env.__out.cookies.join('|'));
    ok('手选过 → navigator.language 换成 en（DSH 启动时读的就是它）',
      env.navigator.language === 'en', env.navigator.language);
    ok('手选过 → languages 列表里 en 在前',
      env.navigator.languages[0] === 'en', JSON.stringify(env.navigator.languages));
    ok('<html lang> 也设成 en', env.document.documentElement.attrs.lang === 'en',
      String(env.document.documentElement.attrs.lang));
    ok('界面语言是 en', api.lang() === 'en', api.lang());
  }

  // ③ 手选过 zh：DSH 那边用 zh-CN（它的写法就是 zh → zh-CN）
  {
    const env = fakeEnv({ store: { 'dsh-lang': 'zh' }, languages: ['en-US', 'en'] });
    run(env);
    ok('手选中文 → navigator.language = zh-CN（DSH 认这个写法）',
      env.navigator.language === 'zh-CN', env.navigator.language);
    ok('手选中文 → 列表里中文优先、英语兜底',
      env.navigator.languages[0] === 'zh-CN' && env.navigator.languages.indexOf('en') > 0,
      JSON.stringify(env.navigator.languages));
    ok('手选中文 → <html lang> = zh-CN', env.document.documentElement.attrs.lang === 'zh-CN');
  }

  // ④ 手选西语：DSH 不认 es，所以要给它一个 en 兜底（不然会掉回它自己的默认）
  {
    const env = fakeEnv({ store: { 'dsh-lang': 'es' }, languages: ['zh-CN'] });
    run(env);
    ok('手选西语 → 列表是 [es, en]（DSH 只有 zh/en，会挑到 en 而不是乱掉）',
      env.navigator.languages[0] === 'es' && env.navigator.languages[1] === 'en',
      JSON.stringify(env.navigator.languages));
    ok('手选西语 → cookie 也是 es（我们自己那几页要显示西语）',
      env.__out.cookies.some((c) => /^dsh-lang=es;/.test(c)), env.__out.cookies.join('|'));
  }

  // ⑤ 在 DSH 页面上切换：要重载一次（DSH 的语言是启动时定下的）
  {
    const env = fakeEnv({ embedded: true });
    const api = run(env);
    ok('DSH 页面：标记认得出来', api.isEmbedded() === true);
    api.setLang('en');
    ok('DSH 页面切换语言 → 触发一次重载（否则 DSH 界面不会变，看着就像假的）',
      env.__out.reloads === 1, `reloads=${env.__out.reloads}`);
    ok('切换之后 cookie 和 navigator 都跟着更新了',
      env.__out.cookies.some((c) => /^dsh-lang=en;/.test(c)) && env.navigator.language === 'en');
  }

  // ⑥ 在我们自己那几页切换：不许重载
  {
    const env = fakeEnv({ embedded: false });
    const api = run(env);
    ok('codex/go/console 那几页：标记是假', api.isEmbedded() === false);
    api.setLang('en');
    ok('自己那几页切换 → 不重载（页面自己会重画，重载只会丢当前视图）',
      env.__out.reloads === 0, `reloads=${env.__out.reloads}`);
    ok('但 cookie 照样写（服务端直出的页面也要跟着）',
      env.__out.cookies.some((c) => /^dsh-lang=en;/.test(c)), env.__out.cookies.join('|'));
  }

  // ⑦ 传进来一个不认识的语言：什么都不做
  {
    const env = fakeEnv({ embedded: true });
    const api = run(env);
    const okSet = api.setLang('fr');
    ok('不认识的语言被拒（不写、不重载）',
      okSet === false && env.__out.reloads === 0 && env.__out.cookies.length === 0);
  }

  console.log(`\n${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('跑挂了：' + (e && e.stack)); process.exit(1); });
