'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sliceBalanced } = require('./page-source.js');
const requestOrigin = require('./request-origin.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-switch.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
assert.match(gateway, /'<script src=\\?"\/dsh-lite-switch\.js/);
assert.match(gateway, /'\/dsh-lite-switch\.js': \{ file: 'dsh-lite-switch\.js'/);
assert.match(gateway, /'\/dsh-lite-switch\.js',/);
const rootAt = gateway.indexOf("if (u.pathname === '/' || u.pathname === '/index.html')");
const rootOpen = gateway.indexOf('{', rootAt), rootEnd = sliceBalanced(gateway, rootOpen, '{', '}');
assert(rootAt >= 0 && rootEnd > rootOpen);
const route = vm.createContext({ Buffer, URL, dshPhoneSurface, TARGET_COOKIE:'fixture-target',
  isLocalRequest: requestOrigin.isLoopback,
  targetCookie: () => 'fixture-target=dsh', shouldShowLauncher: () => false,
  servePwa(_req,res,asset) { assert.equal(asset.file,'dsh-lite.html'); res.writeHead(200); res.end('OWNED_LITE'); } });
vm.runInContext('function root(req,res,u){' + gateway.slice(rootAt,rootEnd+1) + ';return false;}',route);
for (const query of ['', '?target=dsh', '?target=lite', '?target=pick', '?view=classic']) {
  const req={method:'GET',url:'/k/SYNTHETIC'+query,headers:{host:'fixture.trycloudflare.com','user-agent':'unknown'},socket:{remoteAddress:'127.0.0.1'}};
  const res={headers:{},getHeader(k){return this.headers[k];},setHeader(k,v){this.headers[k]=v;},writeHead(n){this.status=n;},end(v){this.body=v;}};
  route.root(req,res,new URL('http://localhost/'+query));
  if(query==='?view=classic') { assert.equal(res.status,410);assert.equal(JSON.parse(res.body).code,'dsh-classic-retired'); }
  else { assert.equal(res.status,200);assert.equal(res.body,'OWNED_LITE'); }
  assert.equal(req.url,'/k/SYNTHETIC'+query,'owned remote shell does not rewrite the key path');
}
// This injected switch is now only a compatibility aid for the original UI
// opened directly on the computer. Remote requests never load that UI.
function page(href, agent, touchPoints = 0, profile = 'remote-mux', encrypted = true) {
  let button = null, assigned = null, replaced = null;
  const document = {
    getElementById: () => button,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener(_name, fn) { this.click = fn; } }),
    body: { appendChild(value) { button = value; } }
  };
  const location = { href, assign(value) { assigned = value; }, replace(value) { replaced = value; } };
  vm.runInNewContext(source, { document, location,
    navigator: { userAgent: agent, maxTouchPoints: touchPoints },
    window: { __POCKET_BRIDGE_DSH__: { profile },
      DshE2EE: { available: () => encrypted }, __dshE2eeSecret: encrypted ? 'secret' : '' }, URL });
  return { button, get assigned() { return assigned; }, get replaced() { return replaced; } };
}

const original = 'https://example.test/k/ACCESS?target=dsh#k=SECRET';
for (const agent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari',
  'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit Mobile Chrome']) {
  const result = page(original, agent);
  assert.equal(result.button, null, 'mobile redirects before official UI loads');
  const target = new URL(result.replaced);
  assert.equal(target.pathname, '/k/ACCESS');
  assert.equal(target.searchParams.get('target'), 'lite');
  assert.equal(target.hash, '#k=SECRET');
}
assert.equal(page(original, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 5).replaced !== null,
  true, 'iPadOS desktop user agent also enters phone shell');
assert.equal(new URL(page(original, 'Mozilla/5.0 (iPhone) Mobile Safari', 0, 'legacy-events').replaced)
  .searchParams.get('target'), 'lite', 'verified legacy DSH uses the encrypted phone adapter');
assert.equal(page(original, 'Mozilla/5.0 (iPhone) Mobile Safari', 0, 'remote-mux', false).replaced,
  null, 'a direct-computer classic page does not redirect without WebCrypto');

const classic = page('https://example.test/k/ACCESS?target=dsh&view=classic#k=SECRET',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari');
assert.equal(classic.replaced, null, 'direct-computer explicit original view is not automatically redirected');
assert.equal(classic.button.textContent, '手机界面');
classic.button.click();
const back = new URL(classic.assigned);
assert.equal(back.searchParams.get('target'), 'lite');
assert.equal(back.searchParams.has('view'), false);
assert.equal(back.hash, '#k=SECRET');

const desktop = page(original, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome');
assert.equal(desktop.replaced, null, 'desktop DSH keeps original view');
assert.equal(desktop.button.textContent, '手机界面');
console.log('DSH phone root always uses owned Lite; direct-computer compatibility switch preserves full keys and explicit local classic view.');
