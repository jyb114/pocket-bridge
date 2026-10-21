'use strict';

// Real isolated Chromium, controlled image transport and real Blob decoding.
// No live DSH, gateway, credentials, user files or downloaded files are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module); isolated.filename = browserFile; isolated.paths = module.paths;
const browserSource = fs.readFileSync(browserFile, 'utf8');
assert.equal(browserSource.split('    sweepOrphanBrowsers();').length, 2);
isolated._compile(browserSource.replace('    sweepOrphanBrowsers();', '    // Own-browser fixture never sweeps other tasks.'), browserFile);
const { Browser } = isolated.exports;
const moduleSource = fs.readFileSync(path.join(root, 'pwa/dsh-image-view.js'), 'utf8');
const marker = 'var figures = new Set();';
assert.equal(moduleSource.split(marker).length, 2);
const observedSource = moduleSource.replace(marker, marker + `
 global.__imageState=function(){return{figures:figures.size,jobs:jobs.size,active:active,bindings:urlImages.size,thumbs:caches.thumbnail.entries.size,thumbBytes:caches.thumbnail.bytes,originals:caches.original.entries.size,originalBytes:caches.original.bytes};};`);
const fixture = `
if(location.search.includes('fallback'))window.IntersectionObserver=undefined;
window.__ctx='fixture-session-A:key-1';window.__calls=[];window.__configs={};window.__downloads=[];window.__opens=[];window.__urls=new Map();window.__urlHistory=[];window.__maxActive=0;window.__active=0;
const originalCreate=URL.createObjectURL.bind(URL),originalRevoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const value=originalCreate(blob);__urls.set(value,blob.size);__urlHistory.push({url:value,bytes:blob.size});return value;};
URL.revokeObjectURL=value=>{__urls.delete(value);originalRevoke(value);};
window.open=(...args)=>{__opens.push(args);throw Error('Unexpected window.open');};
const anchorClick=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){if(this.download){__downloads.push({name:this.download,url:this.href});return;}anchorClick.call(this);};
const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3;canvas.getContext('2d').fillRect(0,0,4,3);
const png=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),ch=>ch.charCodeAt(0));
window.__png=png;
window.__load=(source,variant,{signal})=>{
 const id=source.path||source.attachmentId,config=__configs[id]||{},call={id,source:{...source},variant,ctx:__ctx,signal,aborted:false,done:false};
 __calls.push(call);__active++;__maxActive=Math.max(__maxActive,__active);
 const settled=()=>{if(!call.done){call.done=true;__active--;}};
 return new Promise((resolve,reject)=>{
  call.release=()=>{settled();if(config.failures){if(Number.isFinite(config.failures))config.failures--;const error=Error('private internal transport detail');if(config.userMessage)error.userMessage=config.userMessage;reject(error);return;}
   const bytes=config.corrupt||config.corruptOriginal&&variant==='original'?new Uint8Array([1,2,3]):png;
   const extra=Math.max(0,(config.bytes||0)-bytes.length);
   resolve({blob:new Blob([bytes,new Uint8Array(extra)],{type:config.type||'image/png'}),name:source.name});};
  signal.addEventListener('abort',()=>{call.aborted=true;settled();if(!config.ignoreAbort){const error=Error('abort');error.name='AbortError';reject(error);}}, {once:true});
  if(!(config.hold||config.holdOriginal&&variant==='original'))queueMicrotask(call.release);
 });
};
window.__overlay=(title,build)=>{
 const overlay=document.createElement('section');overlay.className='fixture-overlay';overlay.setAttribute('role','dialog');
 const heading=document.createElement('h2');heading.textContent=title;const close=document.createElement('button');close.className='fixture-close';close.textContent='Close';
 const body=document.createElement('div');body.className='fixture-body';overlay.append(heading,close,body);document.body.append(overlay);
 let closed=false;const hooks=[];const onClose=fn=>hooks.push(fn);const finish=()=>{if(closed)return;closed=true;hooks.forEach(fn=>fn());overlay.remove();};
 close.addEventListener('click',finish);build({body,close:finish,onClose});close.focus();return{close:finish};
};
window.__setup=()=>{if(window.__view)__view.dispose();document.getElementById('transcript').replaceChildren();document.getElementById('transcript').className='';document.getElementById('transcript').scrollTop=0;document.querySelectorAll('.fixture-overlay').forEach(node=>node.remove());
 __calls=[];__configs={};__downloads=[];__active=0;__maxActive=0;__ctx='fixture-session-A:key-1';
 __view=DshImageView.create({root:document.getElementById('transcript'),getContext:()=>__ctx,load:__load,translate:value=>value,openOverlay:__overlay});};
window.__append=(id,source)=>{const output=__view.build(source||{kind:'path',path:id+'.png',name:id+'.png'});output.figure.dataset.item=id;document.getElementById('transcript').append(output.figure);return output;};
window.__spacer=height=>{const node=document.createElement('div');node.style.height=height+'px';document.getElementById('transcript').append(node);};
window.__start=()=>__setup();
`;
const html = `<!doctype html><meta charset="utf-8"><title>Image view fixture</title>
<style>body{margin:0;font:16px system-ui}#transcript{height:320px;overflow:auto;border:1px solid;margin:10px}.dsh-image-figure{margin:8px;min-height:170px}.dsh-image-preview{display:block;width:100%;height:104px}.dsh-image-thumbnail{max-height:100px;max-width:100%}.dsh-image-status{margin:2px}.dsh-image-caption{overflow-wrap:anywhere}.compact .dsh-image-figure{height:86px;min-height:86px;margin:0}.compact .dsh-image-preview{height:44px}.compact figcaption,.compact p,.compact .dsh-image-save{display:none}.fixture-overlay{position:fixed;inset:0;background:white;padding:12px;overflow:auto;z-index:10}.fixture-close{height:44px}.dsh-image-original{display:block;max-width:100%;max-height:240px}.fixture-overlay h2{margin:0;font-size:16px}button{font:inherit}</style>
<div id="transcript" tabindex="0"></div><script src="/fixture.js"></script><script src="/dsh-image-view.js"></script><script>__start()</script>`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  process.env.TEMP = 'D:/bridge-dsh-image-view-test-temp'; process.env.TMP = process.env.TEMP; process.env.TMPDIR = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const requested = [];
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname; requested.push(route);
    res.setHeader('cache-control', 'no-store');
    if (route === '/app') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); }
    else if (route === '/fixture.js') { res.setHeader('content-type', 'application/javascript'); res.end(fixture); }
    else if (route === '/dsh-image-view.js') { res.setHeader('content-type', 'application/javascript'); res.end(observedSource); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser; let checks = 0;
  const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  try {
    browser = await Browser.launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 650, deviceScaleFactor: 1, mobile: true });
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base + '/app', 150);
    async function until(expression) {
      const deadline = Date.now() + 7000;
      do { if (await page.eval(expression)) return; await sleep(25); } while (Date.now() < deadline);
      throw Error('Image view fixture timed out: ' + expression);
    }
    async function pointer(selector) {
      const point = await page.eval(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('missing or disabled: '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!node.contains(document.elementFromPoint(x,y)))throw Error('control is obscured');return{x,y};})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    const loaded = id => `document.querySelector('[data-item="${id}"] img').naturalWidth>0`;
    await until('window.__view');
    await page.eval(`__spacer(1600);__append('far')`);
    await sleep(150);
    check(await page.eval('__calls.length'), 0, 'offscreen image does not eagerly transfer bytes');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 1800 });
    await until(loaded('far'));
    check(await page.eval('__calls.map(call=>call.variant)'), ['thumbnail'], 'real scrolling automatically loads only the thumbnail');
    check(await page.eval(`document.querySelector('[data-item="far"] .dsh-image-preview').getBoundingClientRect().height>=44&&document.querySelector('[data-item="far"] .dsh-image-save').getBoundingClientRect().height>=44`), true, 'preview and download have at least 44-pixel touch targets');

    await page.eval(`__setup();document.getElementById('transcript').className='compact';__configs['same.png']={hold:true};__configs['other.png']={hold:true};__configs['third.png']={hold:true};for(const id of ['duplicate1','duplicate2','duplicate3'])__append(id,{kind:'path',path:'same.png',name:'same.png'});__append('other');__append('third');document.getElementById('transcript').scrollTop=0`);
    await until('__calls.length===2');
    check(await page.eval('__calls.map(call=>call.id)'), ['same.png', 'other.png'], 'duplicates share one in-flight transfer and the third source queues');
    check(await page.eval('__maxActive'), 2, 'at most two thumbnail loads run concurrently');
    await page.eval('__calls[0].release();__calls[1].release()');
    await until('__calls.length===3');
    await page.eval('__calls[2].release()');
    await until(loaded('duplicate1') + '&&' + loaded('duplicate2') + '&&' + loaded('duplicate3'));
    check(await page.eval(`new Set([...document.querySelectorAll('[data-item^="duplicate"] img')].map(image=>image.src)).size`), 1, 'duplicates share the verified cached URL');

    await page.eval(`__setup();__configs['old.png']={hold:true,ignoreAbort:true};__append('old')`);
    await until('__calls.length===1');
    const urlsBeforeLate = await page.eval('__urlHistory.length');
    await page.eval(`window.__oldCall=__calls[0];__ctx='fixture-session-B:key-2';__view.syncContext();__append('new')`);
    await until(loaded('new'));
    check(await page.eval('__oldCall.aborted'), true, 'session/key change aborts the old transfer');
    await page.eval('__oldCall.release()'); await sleep(80);
    check(await page.eval('__urlHistory.length'), urlsBeforeLate + 1, 'a loader ignoring abort cannot create a URL for stale bytes');
    check(await page.eval(`document.querySelector('[data-item="old"] img').hasAttribute('src')`), false, 'old-session results never paint');
    check(await page.eval('__imageState().figures'), 1, 'old-context figures leave the owning collection');

    await page.eval(`__setup();__configs['fail.png']={failures:Infinity,userMessage:'Visible transport failure'};__append('fail')`);
    await until(`__calls.length===2&&!document.querySelector('[data-item="fail"] .dsh-image-retry').hidden`);
    await page.eval(`document.getElementById('transcript').dispatchEvent(new Event('scroll'));dispatchEvent(new Event('resize'))`); await sleep(350);
    check(await page.eval('__calls.length'), 2, 'automatic failure retries once and then stops');
    check(await page.eval(`document.querySelector('[data-item="fail"] .dsh-image-status').textContent`), 'Visible transport failure', 'safe transport feedback is visible');
    await pointer('[data-item="fail"] .dsh-image-retry');
    await until('__calls.length===4');
    check(await page.eval('__calls.length'), 4, 'explicit Retry starts a fresh bounded attempt pair');
    await page.eval(`__configs['fail.png'].failures=0`);
    await until(`!document.querySelector('[data-item="fail"] .dsh-image-retry').hidden`);
    await pointer('[data-item="fail"] .dsh-image-retry'); await until(loaded('fail'));

    for (const [id, config] of [['mime', { type: 'image/svg+xml' }], ['oversize', { bytes: 8 * 1024 * 1024 + 1 }], ['corrupt', { corrupt: true }]]) {
      await page.eval(`__setup();__configs[${JSON.stringify(id + '.png')}]=${JSON.stringify(config)};__append(${JSON.stringify(id)})`);
      await until(`__calls.length===2&&!document.querySelector('[data-item="${id}"] .dsh-image-retry').hidden`);
      check(await page.eval('__urls.size'), 0, id + ' invalid bytes leave no live object URL');
      check(await page.eval(`document.querySelector('[data-item="${id}"] .dsh-image-status').textContent.includes('private internal')`), false, id + ' private error details are not displayed');
    }
    await page.eval(`__setup();__append('invalid',{kind:'path',path:'x'.repeat(4097),name:'unsafe.png'})`);
    check(await page.eval('__calls.length'), 0, 'invalid untrusted legacy source never reaches the loader');
    check(await page.eval(`document.querySelector('[data-item="invalid"] .dsh-image-save').disabled`), true, 'invalid input is an honest disabled figure, not a render exception');

    await page.eval(`__setup();__configs['viewer.png']={holdOriginal:true,ignoreAbort:true};__append('viewer')`); await until(loaded('viewer'));
    await pointer('[data-item="viewer"] .dsh-image-preview'); await until('__calls.length===2');
    check(await page.eval(`document.querySelector('.fixture-overlay img').src===document.querySelector('[data-item="viewer"] img').src`), true, 'viewer first displays the available thumbnail');
    check(await page.eval(`document.querySelector('.fixture-overlay .dsh-image-save').disabled`), true, 'viewer download waits for the original');
    check(await page.eval('__downloads.length'), 0, 'opening a viewer does not automatically download');
    await pointer('.fixture-close');
    check(await page.eval('__calls[1].aborted'), true, 'closing the viewer aborts its original request');
    await page.eval('__calls[1].release()'); await sleep(60);
    check(await page.eval('__urls.size'), 1, 'late closed-viewer bytes cannot enter the cache');
    await pointer('[data-item="viewer"] .dsh-image-preview'); await until('__calls.length===3');
    await page.eval('__calls[2].release()');
    await until(`!document.querySelector('.fixture-overlay .dsh-image-save').disabled`);
    check(await page.eval('document.activeElement.className'), 'fixture-close', 'original loading preserves the focused dialog control');
    check(await page.eval(`document.querySelector('.fixture-overlay img').src!==document.querySelector('[data-item="viewer"] img').src`), true, 'original replaces only the image source');
    await pointer('.fixture-overlay .dsh-image-save'); await until('__downloads.length===1');
    check(await page.eval('__downloads[0].name'), 'viewer.png', 'explicit download retains the safe filename');
    check(await page.eval('__opens.length'), 0, 'preview and download never open an external window');
    await pointer('.fixture-close');
    await pointer('[data-item="viewer"] .dsh-image-save'); await until('__downloads.length===2');
    check(await page.eval('__calls.length'), 3, 'direct download reuses the verified original cache');

    await page.eval(`__setup();__configs['shared.png']={holdOriginal:true};__append('shared')`); await until(loaded('shared'));
    await pointer('[data-item="shared"] .dsh-image-save'); await until('__calls.length===2');
    await pointer('[data-item="shared"] .dsh-image-preview'); await sleep(40);
    check(await page.eval('__calls.length'), 2, 'viewer and explicit download share one original transfer');
    await pointer('.fixture-close');
    check(await page.eval('__calls[1].aborted'), false, 'closing one subscriber does not abort another explicit download');
    await page.eval('__calls[1].release()'); await until('__downloads.length===1');
    check(await page.eval(`document.querySelector('.fixture-overlay')===null`), true, 'a shared original cannot revive the closed viewer');

    await page.eval(`__setup();__configs['bad-original.png']={corruptOriginal:true};__append('bad-original')`); await until(loaded('bad-original'));
    await pointer('[data-item="bad-original"] .dsh-image-preview');
    await until(`!document.querySelector('.fixture-overlay .dsh-image-retry').hidden`);
    check(await page.eval(`document.querySelector('.fixture-overlay img').hasAttribute('src')`), false, 'a corrupt original has no broken revoked URL in the viewer');
    check(await page.eval(`document.querySelector('.fixture-overlay .dsh-image-save').disabled`), true, 'a corrupt original cannot enable download');
    check(await page.eval('__downloads.length'), 0, 'an original decoding failure never starts a download');
    await pointer('.fixture-close');

    await page.eval('__setup()');
    for (let i = 0; i < 25; i++) {
      await page.eval(`__append('cache${i}');document.getElementById('transcript').scrollTop=999999`);
      await until(loaded('cache' + i));
    }
    check(await page.eval('__imageState().thumbs'), 24, 'thumbnail LRU retains at most 24 entries');
    check(await page.eval('__urls.size'), 24, 'evicted thumbnails revoke their URLs');
    check(await page.eval(`document.querySelector('[data-item="cache0"] img').hasAttribute('src')`), false, 'a mounted evicted image has no broken revoked source');
    check(await page.eval(`document.querySelector('[data-item="cache0"] .dsh-image-retry').hidden`), false, 'evicted image has an explicit reload control');
    for (const id of ['cache22', 'cache23', 'cache24']) {
      await pointer('[data-item="' + id + '"] .dsh-image-preview');
      await until(`!document.querySelector('.fixture-overlay .dsh-image-save').disabled`); await pointer('.fixture-close');
    }
    check(await page.eval('__imageState().originals'), 2, 'original LRU retains at most two entries');
    check(await page.eval('__urls.size'), 26, 'combined cache URL count stays at 24 plus two');

    await page.eval('__setup()');
    for (let i = 0; i < 5; i++) {
      await page.eval(`__configs['large${i}.png']={bytes:2*1024*1024};__append('large${i}');document.getElementById('transcript').scrollTop=999999`);
      await until(loaded('large' + i));
    }
    check(await page.eval('__imageState().thumbBytes'), 8 * 1024 * 1024, 'thumbnail bytes are independently capped at 8 MiB');
    check(await page.eval('__imageState().thumbs'), 4, 'byte pressure evicts before the entry-count ceiling');

    await page.eval('__setup()');
    for (let i = 0; i < 3; i++) {
      await page.eval(`__configs['original${i}.png']={bytes:8*1024*1024};__append('original${i}');document.getElementById('transcript').scrollTop=999999`);
      await until(loaded('original' + i));
      await pointer('[data-item="original' + i + '"] .dsh-image-save'); await until('__downloads.length===' + (i + 1));
    }
    check(await page.eval('__imageState().originalBytes'), 16 * 1024 * 1024, 'original byte ownership is capped at 16 MiB');
    check(await page.eval('__imageState().originals'), 2, 'the third full-size original evicts the oldest');

    await page.eval(`__setup();for(let i=0;i<100;i++){const previous=document.querySelector('[data-item="stream"]');const fresh=__append('stream',{kind:'attachment',attachmentId:'stream-id',name:'stream.png'});if(previous)previous.replaceWith(fresh.figure);}`);
    await until('__imageState().figures===1');
    await until(loaded('stream'));
    check(await page.eval('__imageState().figures'), 1, 'streaming row replacement releases disconnected figure ownership');
    check(await page.eval('__calls.length'), 1, 'streaming duplicates do not each transfer another image');
    await page.eval('__view.dispose()');
    check(await page.eval('__urls.size'), 0, 'dispose revokes every cached URL');
    check(await page.eval('__imageState().figures+__imageState().jobs+__imageState().bindings'), 0, 'dispose releases DOM, requests and URL bindings');

    await page.goto(base + '/app?fallback', 100);
    await page.eval(`__spacer(1600);__append('fallback')`); await sleep(100);
    check(await page.eval('__calls.length'), 0, 'fallback also avoids offscreen eager transfers');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 1800 }); await until(loaded('fallback'));
    check(await page.eval('__calls.map(call=>call.variant)'), ['thumbnail'], 'real scrolling works without IntersectionObserver');
    await page.eval(`__setup();document.getElementById('transcript').className='compact'`);
    // Drain the real scroll event caused by clearing the previous scrolled
    // conversation. It must not incidentally repair a lost initial scan batch.
    await page.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await page.eval(`window.__mountScrolls=0;window.__mountScrollListener=()=>__mountScrolls++;document.getElementById('transcript').addEventListener('scroll',__mountScrollListener);__append('fallback1');__append('fallback2');__append('fallback3')`);
    await until(loaded('fallback1'));
    await page.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    check(await page.eval('__mountScrolls'), 0, 'fixed-layout fallback mount has no incidental recovery scroll');
    check(await page.eval('__calls.length'), 3, 'fallback observes every figure appended during the same frame');
    await until(loaded('fallback1') + '&&' + loaded('fallback2') + '&&' + loaded('fallback3'));
    check(await page.eval('__maxActive<=2'), true, 'fallback retains the same global concurrency cap');
    await page.eval(`document.getElementById('transcript').removeEventListener('scroll',__mountScrollListener)`);
    await page.eval('__ctx=null;__view.syncContext()');
    check(await page.eval('__urls.size'), 0, 'missing authentication/key context clears prior content');
    await page.eval('__append("notready")');
    check(await page.eval('__calls.length'), 3, 'missing context cannot issue new image reads');
    check(page.exceptions, [], 'the browser reports no uncaught exception');
    check(requested.every(route => ['/app', '/fixture.js', '/dsh-image-view.js', '/favicon.ico'].includes(route)), true, 'the module makes no independent HTTP content requests');
    console.log('Image view: ' + checks + ' actual-Chromium checks passed; controlled loader only, no live model traffic or files saved.');
  } finally {
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} try { browser.ws.close(); } catch (_) {} }
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
