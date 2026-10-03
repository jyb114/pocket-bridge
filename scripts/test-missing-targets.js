'use strict';

// Execute the real entry/response functions with fake targets and sockets.
// No installed app, live gateway, local account, or running process is touched.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const src = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const dictStart = src.indexOf('{', src.indexOf('const PAGE_TEXT ='));
const dictEnd = sliceBalanced(src, dictStart, '{', '}');
const flush = () => new Promise((resolve) => setImmediate(resolve));
let passed = 0;
function check(label, fn) { fn(); passed++; console.log('  OK ' + label); }
function response() {
  return {
    headersSent: false, status: null, headers: {}, body: '', languageReady: false,
    writeHead(status, headers) {
      this.status = status; this.headers = headers; this.headersSent = true;
    },
    end(body = '') { this.body = Buffer.isBuffer(body) ? body : String(body); }
  };
}
function environment(options = {}) {
  const upstream = new EventEmitter();
  let starts = 0, codexReads = 0, refreshes = 0;
  const box = {
    Buffer, path, zlib, URL, Date,
    require(name) {
      assert.equal(name, './targets.js');
      return { codex: {
        detect: () => ({ installed: !!options.codexInstalled }),
        status: async () => {
          if (options.statusError) throw new Error('isolated discovery failure');
          return { running: !!options.codexRunning };
        }
      } };
    },
    PWA_DIR: '/isolated', ACCESS_KEY: 'test-access', TARGET_COOKIE: 'pb-target',
    targetCache: { at: Date.now(), list: options.list || [] },
    EXPLICIT_TARGET_PORT: options.explicitPort || null,
    TARGET_PORT: 58347, TARGET_HOST: '127.0.0.1',
    refreshTargets: () => { refreshes++; },
    isSelfCheck: (req) => !!req.selfCheck,
    pickLang: (req) => req.lang || 'en',
    pageLanguage(req, res) {
      assert.equal(res.headersSent, false, 'language cookie must precede headers');
      res.languageReady = true; return req.lang || 'en';
    },
    langSwitcher: () => '',
    injectProofAssets: (html) => html + '<script src="/prove.js"></script>',
    trimHtmlToLanguage: () => { codexReads++; return Buffer.from('<html>codex-session-ui</html>'); },
    findDshExe: () => options.dshInstalled ? '/isolated/dsh.exe' : null,
    refreshDshPort: () => {
      if (options.movedPort) box.TARGET_PORT = options.movedPort;
      return options.movedPort || box.TARGET_PORT;
    },
    ensureDshRunning: async () => { starts++; return true; },
    buildUpstreamHeaders: (req) => req.headers,
    dshLazyImageStore: { originalModuleUrl: () => null },
    markActivity() {}, log() {},
    http: { request: () => upstream }
  };
  vm.createContext(box);
  vm.runInContext('const PAGE_TEXT = ' + src.slice(dictStart, dictEnd + 1) + ';', box);
  for (const name of ['normLang', 'pageText', 'readTargetCookie', 'shouldShowLauncher',
    'launcherPage', 'serveLauncherPage', 'handleMissingDsh', 'serveCodexPage',
    'dshStartingPage', 'proxyRequest']) {
    const code = extractFunction(src, name);
    assert.ok(code, 'extract real ' + name);
    vm.runInContext(code, box);
  }
  const req = { method: 'GET', url: '/', lang: options.lang || 'en',
    headers: { cookie: options.choice ? 'pb-target=' + options.choice : '' },
    pipe() {} };
  return { box, req, upstream,
    counts: () => ({ starts, codexReads, refreshes }) };
}
function target(id, installed = true, running = false) {
  return { id, installed, running, short: id === 'dsh' ? 'DSH' : 'Codex', blurb: 'test', note: 'test' };
}
function browserRender(html, list) {
  const elements = {};
  function element() {
    return { innerHTML: '', style: {}, children: [], appendChild(c) { this.children.push(c); } };
  }
  const page = { location: { hash: '#k=test-fragment' },
    document: { getElementById(id) { return elements[id] || (elements[id] = element()); },
      createElement: element } };
  const start = html.indexOf('{', html.indexOf('var L='));
  page.L = JSON.parse(html.slice(start, sliceBalanced(html, start, '{', '}') + 1));
  vm.createContext(page);
  vm.runInContext(extractFunction(html, 'esc'), page);
  vm.runInContext(extractFunction(html, 'render'), page);
  page.render({ targets: list });
  return elements.list;
}
(async () => {
  const routingCases = [
    ['neither installed', {}, true],
    ['DSH only keeps direct entry', { list: [target('dsh')] }, false],
    ['Codex only offers Codex instead of trying DSH', { list: [target('codex')] }, true],
    ['both installed', { list: [target('dsh'), target('codex')] }, true],
    ['remembered available Codex', { list: [target('codex')], choice: 'codex' }, false],
    ['uninstalled remembered Codex', { list: [target('dsh')], choice: 'codex' }, true],
    ['uninstalled remembered DSH', { list: [target('codex')], choice: 'dsh' }, true],
    ['running DSH outside install search', { list: [target('dsh', false, true)] }, false],
    ['explicit upstream without install', { explicitPort: 19876 }, false],
    ['explicit upstream with only Codex detected', { explicitPort: 19876, list: [target('codex')] }, false],
    ['remembered explicit DSH upstream', { explicitPort: 19876, choice: 'dsh' }, false],
    ['missing Codex cookie does not route to explicit DSH', { explicitPort: 19876, choice: 'codex' }, true]
  ];
  for (const [label, opts, expected] of routingCases) check(label, () => {
    const h = environment(opts);
    assert.equal(h.box.shouldShowLauncher(h.req), expected);
  });
  check('self-check bypasses app selection', () => {
    const h = environment(); h.req.selfCheck = true;
    assert.equal(h.box.shouldShowLauncher(h.req), false);
  });
  check('stale app list requests a refresh', () => {
    const h = environment(); h.box.targetCache.at = 0;
    assert.equal(h.box.shouldShowLauncher(h.req), true);
    assert.equal(h.counts().refreshes, 1);
  });
  for (const lang of ['zh', 'en', 'es']) {
    const h = environment({ lang }); const res = response();
    h.box.proxyRequest(h.req, res, true);
    h.upstream.emit('error', Object.assign(new Error('missing'), { code: 'ECONNREFUSED' }));
    check('missing DSH gives a stable localized page: ' + lang, () => {
      assert.equal(res.status, 503);
      assert.equal(h.counts().starts, 0);
      assert.equal(res.languageReady, true);
      assert.ok(res.body.includes('<html lang="' + lang + '">'));
      assert.ok(res.body.includes('DSH'));
      assert.ok(res.body.includes('/prove.js'));
      assert.ok(res.body.includes('onclick="location.reload()"'));
      assert.doesNotMatch(res.body, /http-equiv=["']refresh|setInterval\(/i);
      const empty = browserRender(res.body, []);
      assert.ok(empty.innerHTML.includes(lang === 'zh' ? '没有找到' : lang === 'en' ? 'Nothing to connect' : 'No se encontró'));
    });
  }
  check('installed DSH still auto-starts with the existing refresh page', () => {
    const h = environment({ dshInstalled: true }); const res = response();
    h.box.proxyRequest(h.req, res, true);
    h.upstream.emit('error', Object.assign(new Error('stopped'), { code: 'ECONNREFUSED' }));
    assert.equal(h.counts().starts, 1);
    assert.equal(res.status, 503);
    assert.match(res.body, /http-equiv="refresh"/i);
  });
  check('DSH port changes still retry the same URL before missing-install handling', () => {
    const h = environment({ movedPort: 58348 }); const res = response();
    h.box.proxyRequest(h.req, res, true);
    h.upstream.emit('error', Object.assign(new Error('moved'), { code: 'ECONNREFUSED' }));
    assert.equal(res.status, 307); assert.equal(res.headers.location, '/');
    assert.equal(h.counts().starts, 0);
  });
  for (const opts of [{}, { statusError: true }]) {
    const h = environment(opts); const res = response();
    h.box.serveCodexPage(h.req, res); await flush();
    check('missing Codex never serves the reconnecting chat UI' + (opts.statusError ? ' on discovery error' : ''), () => {
      assert.equal(res.status, 503); assert.equal(h.counts().codexReads, 0);
      assert.ok(res.body.includes('Codex was not found'));
      assert.ok(res.body.includes('/prove.js'));
      assert.doesNotMatch(res.body, /codex-session-ui|http-equiv=["']refresh/i);
    });
  }
  for (const opts of [{ codexInstalled: true }, { codexRunning: true }]) {
    const h = environment(opts); const res = response(); h.req.headers['accept-encoding'] = 'gzip';
    h.box.serveCodexPage(h.req, res); await flush();
    check('installed or independently running Codex retains its compressed UI: ' + JSON.stringify(opts), () => {
      assert.equal(res.status, 200); assert.equal(h.counts().codexReads, 1);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.match(zlib.gunzipSync(res.body).toString(), /codex-session-ui/);
    });
  }
  check('missing-app selector offers a running alternative and carries both keys', () => {
    const h = environment(); const res = response(); h.box.serveLauncherPage(h.req, res, 503, 'dsh');
    const box = browserRender(res.body, [target('dsh', false, false), target('codex', false, true)]);
    assert.equal(box.children.length, 1);
    const open = box.children[0].children[0].children[0];
    assert.equal(open.href, '/k/test-access?target=codex#k=test-fragment');
  });
  {
    const h = environment(); const res = response();
    h.box.serveCodexPage(h.req, res); await flush();
    check('missing Codex leaves the page usable and offers installed DSH', () => {
      assert.equal(h.counts().codexReads, 0);
      assert.ok(res.body.includes('Codex was not found'));
      const box = browserRender(res.body, [target('codex', false, false), target('dsh', true, true)]);
      assert.equal(box.children.length, 1);
      assert.equal(box.children[0].children[0].children[0].href, '/k/test-access?target=dsh#k=test-fragment');
    });
  }
  // Check the public entry points use the functions tested above, not a dead helper.
  check('actual routes are wired to the availability checks', () => {
    assert.match(src, /if \(u\.pathname === '\/codex' \|\| u\.pathname === '\/codex\/'\) \{\s*serveCodexPage\(req, res\)/);
    assert.ok(src.includes('res.end(injectProofAssets(launcherPage(req, lang)));'));
  });
  {
    let publicSource = Buffer.from('Public static asset content. '.repeat(40));
    const assetBox = { Buffer, path, zlib, crypto, PWA_DIR:'/isolated-public', fs:{readFileSync:()=>Buffer.from(publicSource)} };
    vm.createContext(assetBox); vm.runInContext(extractFunction(src, 'servePwa'), assetBox);
    const route = {file:'public.js',type:'text/javascript',noCache:true,swAllowed:true};
    const get = (encoding='',validator='',method='GET') => {
      const res = response(); assetBox.servePwa({method,headers:{'accept-encoding':encoding,'if-none-match':validator}},res,route); return res;
    };
    const identity = get(), compressed = get('gzip');
    check('public source validators distinguish identity and compressed bytes and retain cache policy',()=>{
      assert.notEqual(identity.headers.etag,compressed.headers.etag);
      assert.equal(identity.headers.vary,'Accept-Encoding');
      assert.equal(compressed.headers.vary,'Accept-Encoding');
      assert.equal(identity.headers['cache-control'],'no-cache');
      assert.equal(zlib.gunzipSync(compressed.body).toString(),publicSource.toString());
    });
    const unchanged = get('', '"another-validator", W/' + identity.headers.etag);
    check('matching weak/list validators return a bodyless 304 with encoding variance and SW scope',()=>{
      assert.equal(unchanged.status,304); assert.equal(unchanged.body,'');
      assert.equal(unchanged.headers.etag,identity.headers.etag); assert.equal(unchanged.headers.vary,'Accept-Encoding');
      assert.equal(unchanged.headers['service-worker-allowed'],'/'); assert.equal(unchanged.headers['content-length'],undefined);
    });
    check('a validator for another representation does not suppress compressed bytes',()=>assert.equal(get('gzip',identity.headers.etag).status,200));
    publicSource = Buffer.from('Changed public source. '.repeat(45));
    check('editing the source immediately invalidates the old validator',()=>{
      const updated=get('',identity.headers.etag); assert.equal(updated.status,200); assert.notEqual(updated.headers.etag,identity.headers.etag);
      assert.equal(updated.body.toString(),publicSource.toString());
    });
    check('HEAD and matching wildcard return no body, while non-GET validation cannot hide an operation',()=>{
      const head=get('','','HEAD'); assert.equal(head.status,200); assert.equal(head.body,''); assert.equal(head.headers['content-length'],publicSource.length);
      assert.equal(get('','*').status,304); assert.equal(get('','*','POST').status,200);
    });
  }
  console.log('\nMissing-target regressions: ' + passed + ' passed. No live apps were touched.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
