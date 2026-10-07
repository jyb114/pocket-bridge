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
const requestOrigin = require('./request-origin.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
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
  let starts = 0, codexReads = 0, refreshes = 0, upstreamRequests = 0;
  const box = {
    Buffer, path, zlib, URL, Date, requestOrigin, dshPhoneSurface,
    privateHttpsAdmission: require('./private-https-admission.js'),
    cfg: { loadConfig: () => ({ privateHttps: { enabled: false, origin: '' } }),
      isOwnAddress: (_address, req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket && req.socket.remoteAddress) },
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
    http: { request: () => { upstreamRequests++; return upstream; } }
  };
  vm.createContext(box);
  vm.runInContext('const PAGE_TEXT = ' + src.slice(dictStart, dictEnd + 1) + ';', box);
  for (const name of ['isOwnAddress', 'isLocalRequest', 'normLang', 'pageText', 'readTargetCookie', 'shouldShowLauncher',
    'launcherPage', 'serveLauncherPage', 'handleMissingDsh',
    'dshStartingPage', 'proxyRequest']) {
    const code = extractFunction(src, name);
    assert.ok(code, 'extract real ' + name);
    vm.runInContext(code, box);
  }
  const req = { method: 'GET', url: '/', lang: options.lang || 'en',
    headers: { host: 'localhost:8080', cookie: options.choice ? 'pb-target=' + options.choice : '' },
    socket: { remoteAddress: '127.0.0.1' },
    pipe() {} };
  return { box, req, upstream,
    counts: () => ({ starts, codexReads, refreshes, upstreamRequests }) };
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
    ['DSH missing', {}, true],
    ['DSH direct entry', {list:[target('dsh')]}, false],
    ['retired cached target is not an alternative', {list:[target('codex')]}, true],
    ['retired cached target cannot force a selector for DSH', {list:[target('dsh'),target('codex')]}, false],
    ['legacy Codex cookie ignored for available DSH', {list:[target('dsh')],choice:'codex'}, false],
    ['legacy Codex cookie ignored for explicit upstream', {explicitPort:19876,choice:'codex'}, false],
    ['running DSH outside install search', {list:[target('dsh',false,true)]}, false],
    ['explicit upstream without local install', {explicitPort:19876}, false],
    ['remembered missing DSH shows setup', {choice:'dsh'}, true]
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
  for (const [label, host, remote, forwarded] of [
    ['public authority', 'fixture.trycloudflare.com', '127.0.0.1', {}],
    ['forwarded local authority', 'localhost:8080', '127.0.0.1', { 'x-forwarded-for': '192.0.2.4' }],
    ['LAN phone with local authority', 'localhost:8080', '192.0.2.4', {}]
  ]) check('remote raw request cannot discover, start or forward DSH: ' + label, () => {
    const h = environment({ dshInstalled: true, movedPort: 58348 });
    h.req.headers = { host, ...forwarded }; h.req.socket.remoteAddress = remote;
    h.req.url = '/api/session/projections'; const res = response();
    h.box.proxyRequest(h.req, res);
    assert.equal(res.status, 410); assert.equal(JSON.parse(res.body).code, 'dsh-classic-retired');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(h.counts(), { starts: 0, codexReads: 0, refreshes: 0, upstreamRequests: 0 });
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
  check('DSH setup carries both keys and filters stale retired entries', () => {
    const h=environment(); const res=response();h.box.serveLauncherPage(h.req,res,503,'dsh');
    const box=browserRender(res.body,[target('codex',true,true),target('dsh',true,true)]);
    assert.equal(box.children.length,1);
    assert.equal(box.children[0].children[0].children[0].href,'/k/test-access?target=dsh#k=test-fragment');
    const noDsh=browserRender(res.body,[target('codex',true,true)]); assert.equal(noDsh.children.length,0);
  });
  check('actual routes retain localized DSH setup without a retired page handler',()=>{
    assert.ok(src.includes('res.end(injectProofAssets(launcherPage(req, lang)));'));
    assert.doesNotMatch(src,/function serveCodexPage\(/);
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
