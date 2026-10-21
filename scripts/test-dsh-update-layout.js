'use strict';

// Real Chromium, production notice scripts and the exact worker-injected
// warning. Only the worker transport is controlled; no gateway or live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const helper = path.join(__dirname, 'browser-check.js');
const isolated = new Module(helper, module);
isolated.filename = helper; isolated.paths = module.paths;
const helperSource = fs.readFileSync(helper, 'utf8');
assert.equal(helperSource.split('    sweepOrphanBrowsers();').length, 2);
isolated._compile(helperSource.replace('    sweepOrphanBrowsers();',
  '    // This isolated regression never sweeps other tasks\' browsers.'), helper);
const { Browser } = isolated.exports;
const workerSource = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const warningStart = workerSource.indexOf("      '(function(){try{' +");
const warningEnd = workerSource.indexOf("\n      { headers: { 'content-type': 'application/javascript; charset=utf-8' } });", warningStart);
assert(warningStart >= 0 && warningEnd > warningStart, 'Find the real injected mismatch warning, or fail closed');
const warning = vm.runInNewContext(workerSource.slice(warningStart, warningEnd).trim().replace(/,$/, ''),
  { P: JSON.stringify('/dsh-lite-ui.js') });
assert.match(warning, /dsh-tamper-bar/);
const scripts = Object.fromEntries(['dsh-lite-update', 'dsh-lite-pin'].map(name =>
  [name, fs.readFileSync(path.join(root, 'pwa', name + '.js'), 'utf8')]));
const manifest = { files: Object.fromEntries(['/e2ee.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
  '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-ui.js', '/dsh-backup-prepare.js',
  '/dsh-lite-switch.js', '/i18n.js', '/dsh-lite-lang.js', '/dsh-artifact-links.js', '/dsh-image-view.js']
  .map(file => [file, 'a'.repeat(64)])) };
const scaffold = `
window.__fixture={messages:[],listeners:[]};window.__dshE2eeSecret='isolated-layout-key';
localStorage.clear();
const active={state:'activated',postMessage(message){
  __fixture.messages.push(message);
  if(message.type==='dsh-verified-update-capability')queueMicrotask(()=>__fixture.listeners.forEach(fn=>fn({data:{type:'dsh-verified-update-ready',requestId:message.requestId}})));
}};
const registration={active,update(){return Promise.resolve(this);}};
Object.defineProperty(navigator,'serviceWorker',{value:{ready:Promise.resolve(registration),
  register(){return Promise.resolve(registration);},addEventListener(type,fn){if(type==='message')__fixture.listeners.push(fn);},removeEventListener(){}}});
window.__mismatch=()=>__fixture.listeners.forEach(fn=>fn({data:{type:'dsh-code-mismatch',path:'/dsh-lite-ui.js'}}));
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  process.env.TEMP = 'D:/bridge-dsh-update-layout-test-temp';
  process.env.TMP = process.env.TEMP; process.env.TMPDIR = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/code-manifest.json') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return;
    }
    const name = url.pathname.slice(1).replace(/\.js$/, '');
    if (scripts[name]) {
      // A fixture-only replay of the previous top placement proves that the
      // actual pointer regression fails for the original obstruction.
      const bytes = url.searchParams.has('oldtop') ? scripts[name].replace(
        'position:fixed;left:0;right:0;bottom:0;', 'position:fixed;left:0;right:0;top:0;') : scripts[name];
      res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(bytes); return;
    }
    const variant = url.searchParams.get('variant');
    if (!scripts[variant]) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<style>body{margin:0;font-family:system-ui}main{padding:24px}</style></head><body><main>Isolated update layout fixture</main>' +
      '<script>' + scaffold + '__fixture.case=' + JSON.stringify(url.searchParams.get('case')) + ';</script><script src="/' + variant + '.js' +
      (url.searchParams.has('oldtop') ? '?oldtop=1' : '') + '"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, checks = 0;
  try {
    browser = await Browser.launch();
    const page = await browser.newPage();
    async function wait(expression) {
      const end = Date.now() + 5000;
      do { if (await page.eval(expression)) return; await sleep(20); } while (Date.now() < end);
      throw Error('Timed out: ' + expression);
    }
    for (const variant of ['dsh-lite-update', 'dsh-lite-pin']) {
      const id = variant === 'dsh-lite-update' ? 'dsh-lite-update-notice' : 'dsh-lite-pin-notice';
      const expected = variant === 'dsh-lite-update' ? 'dsh-repin-code-verified' : 'dsh-repin-code';
      for (const height of [650, 400]) for (const order of ['warning-first', 'notice-first']) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height, deviceScaleFactor: 1, mobile: true });
        const caseId = variant + '-' + height + '-' + order;
        await page.goto('http://127.0.0.1:' + server.address().port + '/?variant=' + variant + '&case=' + caseId + '#k=isolated', 50);
        await wait('!!window.__mismatch&&__fixture.case===' + JSON.stringify(caseId));
        if (order === 'warning-first') await page.eval(warning);
        await page.eval('__mismatch()');
        await wait('!!document.getElementById(' + JSON.stringify(id) + ')');
        if (order === 'notice-first') await page.eval(warning);
        const shape = await page.eval(`(()=>{
          const notice=document.getElementById(${JSON.stringify(id)}),warning=document.getElementById('dsh-tamper-bar'),button=notice.querySelector('button');
          const n=notice.getBoundingClientRect(),w=warning.getBoundingClientRect(),b=button.getBoundingClientRect();
          const x=b.x+b.width/2,y=b.y+b.height/2;
          return {top:w.top,warningBottom:w.bottom,noticeTop:n.top,bottom:n.bottom,width:n.width,buttonHeight:b.height,
            visibleWarning:!!warning.textContent&&getComputedStyle(warning).visibility==='visible',
            hit:button.contains(document.elementFromPoint(x,y)),x,y,autoMutations:__fixture.messages.filter(m=>/repin/.test(m.type)).length};
        })()`);
        assert.equal(shape.visibleWarning, true); assert.equal(shape.top, 0);
        assert(shape.warningBottom <= shape.noticeTop, JSON.stringify({ variant, height, order, shape }));
        assert(Math.abs(shape.bottom - height) < 1); assert(shape.width <= 390);
        assert(shape.buttonHeight >= 44); assert.equal(shape.hit, true);
        assert.equal(shape.autoMutations, 0, 'A mismatch notice must not grant an update');
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: shape.x, y: shape.y });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: shape.x, y: shape.y });
        await wait('__fixture.messages.some(message=>message.type===' + JSON.stringify(expected) + ')');
        const result = await page.eval(`({messages:__fixture.messages.filter(message=>/repin/.test(message.type)),warning:!!document.getElementById('dsh-tamper-bar'),disabled:document.querySelector('#${id} button').disabled})`);
        assert.equal(result.messages.length, 1); assert.equal(result.messages[0].type, expected);
        assert.deepEqual(result.messages[0].manifest, manifest);
        assert.equal(result.warning, true); assert.equal(result.disabled, true);
        assert.equal(page.exceptions.length, 0, page.exceptions.join('\n'));
        checks++;
        console.log('PASS ' + variant + ' ' + height + 'px ' + order + ': warning remains visible, real pointer click sends one admitted update');
      }
    }
    for (const variant of ['dsh-lite-update', 'dsh-lite-pin']) {
      const id = variant === 'dsh-lite-update' ? 'dsh-lite-update-notice' : 'dsh-lite-pin-notice';
      const caseId = variant + '-old-top';
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 400, deviceScaleFactor: 1, mobile: true });
      await page.goto('http://127.0.0.1:' + server.address().port + '/?variant=' + variant + '&case=' + caseId + '&oldtop=1#k=isolated', 50);
      await wait('!!window.__mismatch&&__fixture.case===' + JSON.stringify(caseId));
      await page.eval('__mismatch()'); await wait('!!document.getElementById(' + JSON.stringify(id) + ')');
      await page.eval(warning);
      const point = await page.eval(`(()=>{const button=document.querySelector('#${id} button'),r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:button.contains(document.elementFromPoint(x,y))};})()`);
      assert.equal(point.hit, false, 'The previous top notice must reproduce the real warning interception');
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y });
      await sleep(50);
      assert.equal(await page.eval('__fixture.messages.filter(message=>/repin/.test(message.type)).length'), 0,
        'A real click at the old occluded control cannot start an update');
      assert.equal(await page.eval('!!document.getElementById("dsh-tamper-bar")'), true);
      console.log('PASS ' + variant + ' old-top counterexample: real warning blocks the real pointer click');
    }
    console.log(checks + ' actual Chromium update/warning layout cases passed; no force-click, live gateway, user profile or update publication.');
  } finally {
    if (browser) browser.kill();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
