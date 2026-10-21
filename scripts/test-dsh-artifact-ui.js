'use strict';

// Actual production renderer/parser in an owned Chromium. File and image
// actions record metadata only; no DSH, model, remote URL or user file is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const { extractFunction } = require('./page-source.js');
const productionSource = fs.readFileSync(path.join(root, 'pwa/dsh-lite-ui.js'), 'utf8');
const parser = fs.readFileSync(path.join(root, 'pwa/dsh-artifact-links.js'));
const functions = ['escapeHtml', 'markdownToHtml', 'el', 'safeId', 'buildImagePreview', 'renderMessageBody',
  'invalidateImageRows', 'syncImageViews', 'snapshotForRecord', 'sameRecordSnapshot', 'reconcileRecord',
  'renderRecords', 'clearDownloadUrls', 'checkLocalUploadPreviewKey']
  .map(name => extractFunction(productionSource, name)).join('\n');
const browserFile = path.join(root, 'scripts/browser-check.js');
const isolated = new Module(browserFile, module); isolated.filename = browserFile; isolated.paths = module.paths;
const browserSource = fs.readFileSync(browserFile, 'utf8');
assert.equal(browserSource.split('    sweepOrphanBrowsers();').length, 2);
isolated._compile(browserSource.replace('    sweepOrphanBrowsers();', '    // Isolated renderer regression never sweeps other tasks.'), browserFile);
const { Browser } = isolated.exports;
const fixture = `
window.__opened=[];window.__built=[];window.__xss=0;
function t(value){return value;}
window.__imageContext='fixture-key-A';var trackedFigures=new Set(),controlledContext=__imageContext;
var imageViews={reset:function(){trackedFigures.forEach(figure=>{figure.querySelector('button').disabled=true;figure.dataset.retired='true';});trackedFigures.clear();},syncContext:function(){if(controlledContext!==__imageContext){this.reset();controlledContext=__imageContext;}return controlledContext;},build:function(source){
 if(typeof source.path!=='string'||!source.path||source.path.length>4096)throw Error('Synthetic invalid legacy source');
 __built.push({...source});const figure=document.createElement('figure');figure.className='dsh-image-figure';
 const preview=document.createElement('button');preview.className='dsh-image-preview';preview.type='button';preview.textContent=source.name;
 preview.addEventListener('click',()=>__opened.push({kind:'image',path:source.path}));figure.append(preview);trackedFigures.add(figure);return{figure};
}};
var imageViewContext=imageViews.syncContext(),recordSnapshots=new Map();
var state={recordElements:new Map(),downloadUrls:new Map(),records:[],runningKnown:false,running:false,disposed:false};
var refs={records:document.getElementById('records'),stop:null};
var officialImageEpoch=0,officialImagePending=new Map(),localUploadPreviews=new Map();
function cancelRecordFrame(){}function visibleRecords(){return state.records;}function renderEmpty(){}function syncHistoryScroll(){}function renderFilePreview(){}
function officialImageAttachment(){return false;}function localUploadPreview(){return false;}function clearLocalUploadPreviews(){}
${functions}
function buildRecord(record){const item=el('li','record');const body=el('div','record-markdown');renderMessageBody(body,record.text);item.append(body);return item;}
function openMessageFile(link,button){__opened.push({kind:'file',path:link.path,button:button.textContent,connected:button.isConnected});}
window.__render=text=>{__opened=[];__built=[];const body=document.getElementById('body');body.replaceChildren();renderMessageBody(body,text);};
window.__invalid=()=>{document.getElementById('body').append(buildImagePreview({kind:'path',path:'x'.repeat(4097),name:'long.png'}));};
window.__spine=()=>{imageViews.reset();__imageContext='fixture-key-A';imageViewContext=imageViews.syncContext();refs.records.replaceChildren();state.recordElements.clear();recordSnapshots.clear();state.records=[{id:'image-row',role:'assistant',text:'[image](same.png)'},{id:'plain-row',role:'assistant',text:'Ordinary unchanged text'}];renderRecords();};
`;
const html = '<!doctype html><meta charset="utf-8"><title>Artifact renderer fixture</title><style>body{margin:8px;font:16px system-ui}.record-file,.dsh-image-preview{min-height:44px;min-width:70px}figure{display:inline-block;margin:2px}.record-markdown{overflow-wrap:anywhere}</style><div id="body" class="record-markdown"></div><ul id="records"></ul><script src="/parser.js"></script><script src="/fixture.js"></script>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  process.env.TEMP = 'D:/bridge-dsh-artifact-ui-test-temp'; process.env.TMP = process.env.TEMP; process.env.TMPDIR = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const requested = [];
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname; requested.push(route);
    res.setHeader('cache-control', 'no-store');
    if (route === '/parser.js') { res.setHeader('content-type', 'text/javascript'); res.end(parser); }
    else if (route === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixture); }
    else if (route === '/app') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser; let checks = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  try {
    browser = await Browser.launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 650, deviceScaleFactor: 1, mobile: true });
    await page.goto('http://127.0.0.1:' + server.address().port + '/app', 100);
    async function pointer(label) {
      const point = await page.eval(`(()=>{const node=[...document.querySelectorAll('.record-file')].find(node=>node.textContent===${JSON.stringify(label)});if(!node||node.disabled)throw Error('missing fixture action');node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!node.contains(document.elementFromPoint(x,y)))throw Error('fixture action is obscured');return{x,y};})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await page.eval(`__render('[A](a.png) [A again](a.png) [B](b.png) [B again](b.png) [one](one.md) [two](two.md)')`);
    check(await page.eval('__built.map(source=>source.path)'), ['a.png', 'b.png'], 'the same paragraph creates one figure per distinct image');
    check(await page.eval(`document.querySelectorAll('.dsh-image-figure').length`), 2, 'duplicates have lightweight actions instead of duplicate figures');
    await pointer('A again');
    check(await page.eval('__opened'), [{ kind: 'image', path: 'a.png' }], 'A duplicate opens A, not the last duplicate image');
    await pointer('B again');
    check(await page.eval('__opened[1]'), { kind: 'image', path: 'b.png' }, 'B duplicate opens B');
    await pointer('one');
    check(await page.eval('__opened[2]'), { kind: 'file', path: 'one.md', button: 'one', connected: true }, 'first file action retains its own link and button');
    await pointer('two');
    check(await page.eval('__opened[3]'), { kind: 'file', path: 'two.md', button: 'two', connected: true }, 'second file action retains its own link and button');

    const screenshot = '😀 [最终主图](<D:/fixture project/FINAL/hero (final).PNG>)';
    await page.eval('__render(' + JSON.stringify(screenshot) + ')');
    check(await page.eval('__built'), [{ kind: 'path', path: 'D:/fixture project/FINAL/hero (final).PNG', name: 'hero (final).PNG' }], 'the screenshot angle syntax preserves path spaces, Unicode offset and exact casing');
    check(await page.eval(`document.querySelector('.dsh-image-figure').getAttribute('aria-label')`), '最终主图', 'image metadata retains the human label');
    check(await page.eval(`document.getElementById('body').textContent.includes('PBART')`), false, 'no internal renderer placeholder leaks to the reader');

    const hostile = '[<img src=x onerror="window.__xss++">](notes.md) [<svg onload="window.__xss++">](preview.png) [repeat <img src=x onerror="window.__xss++">](preview.png)';
    await page.eval('__render(' + JSON.stringify(hostile) + ')');
    check(await page.eval(`document.querySelectorAll('#body img,#body svg,#body script').length`), 0, 'HTML-shaped labels create no executable elements');
    check(await page.eval('__xss'), 0, 'HTML labels do not execute');
    check(await page.eval(`document.querySelector('.record-file').textContent`), '<img src=x onerror="window.__xss++">', 'file labels remain plain text');
    await pointer('<img src=x onerror="window.__xss++">');
    check(await page.eval('__opened[0].path'), 'notes.md', 'HTML-like file label does not change the target');
    await pointer('repeat <img src=x onerror="window.__xss++">');
    check(await page.eval('__opened[1].path'), 'preview.png', 'HTML-like duplicate label remains a safe image action');

    const code = '`[inline](inline.png)`\n\n```md\n![fenced](fenced.png)\n```\n\n~~~md\n[tilde](tilde.png)\n~~~\n\n    [indented](indented.png)';
    await page.eval('__render(' + JSON.stringify(code) + ')');
    check(await page.eval('__built.length'), 0, 'code samples never create image reads');
    check(await page.eval(`document.querySelectorAll('.record-file').length`), 0, 'code samples never create local file actions');

    const unsafe = '[external](https://example.invalid/a.png) ![external image](https://example.invalid/b.png) [http](http://example.invalid/c.png) [scheme](javascript:alert(1)) [traversal](../a.png) [encoded](images/%2e%2e/a.png) [network](<//host/share/a.png>)';
    await page.eval('__render(' + JSON.stringify(unsafe) + ')');
    check(await page.eval('__built.length'), 0, 'external, scheme, traversal and network links never auto-load locally');
    check(await page.eval(`document.querySelectorAll('.record-file').length`), 0, 'unsafe targets are not actionable local files');
    check(await page.eval(`[...document.querySelectorAll('#body a')].map(node=>node.getAttribute('href'))`),
      ['https://example.invalid/a.png', 'https://example.invalid/b.png', 'http://example.invalid/c.png'], 'existing normal HTTP and HTTPS anchors remain intact');

    await page.eval(`__render('[too long](<'+'D:/'+('x'.repeat(2050))+'.png>)');__invalid()`);
    check(await page.eval('__built.length'), 0, 'overlong local paths do not start previews');
    check(await page.eval(`document.querySelector('.record-status').textContent`), '图片路径无效，无法预览。', 'an invalid legacy image path falls back without breaking message rendering');
    check(await page.eval(`document.getElementById('body').textContent.includes('too long')`), true, 'unsupported long Markdown remains readable');
    await page.eval('__render(null)');
    check(await page.eval(`document.getElementById('body').textContent`), '', 'empty message text renders without a parser exception');

    // A reset retires existing images. Reconciliation must rebuild those rows
    // even when their text and attachment metadata did not change, while plain
    // rows retain focus/state through their original DOM identity.
    await page.eval(`__spine();window.__imageRow=state.recordElements.get('image-row');window.__plainRow=state.recordElements.get('plain-row');renderRecords()`);
    check(await page.eval(`state.recordElements.get('image-row')===__imageRow&&state.recordElements.get('plain-row')===__plainRow`), true, 'unchanged records retain their DOM before an image reset');
    await page.eval('clearDownloadUrls();renderRecords()');
    check(await page.eval(`state.recordElements.get('image-row')!==__imageRow`), true, 'hash/cache reset rebuilds the retired image row');
    check(await page.eval(`state.recordElements.get('plain-row')===__plainRow`), true, 'hash/cache reset preserves an unrelated plain row');
    check(await page.eval(`__imageRow.querySelector('.dsh-image-preview').disabled`), true, 'the old image remains retired after a reset');
    check(await page.eval(`state.recordElements.get('image-row').querySelector('.dsh-image-preview').disabled`), false, 'the replacement image is usable without changing the message');

    await page.eval(`__imageRow=state.recordElements.get('image-row');__imageContext='fixture-key-B';renderRecords()`);
    check(await page.eval(`state.recordElements.get('image-row')!==__imageRow`), true, 'a key-only context change rebuilds the image on reconciliation');
    check(await page.eval(`state.recordElements.get('plain-row')===__plainRow`), true, 'key-only reconciliation preserves an unrelated plain row');
    check(await page.eval(`__imageRow.querySelector('.dsh-image-preview').disabled`), true, 'a key-only change cannot revive the retired image');

    await page.eval(`__imageRow=state.recordElements.get('image-row');__imageContext='fixture-key-C';checkLocalUploadPreviewKey()`);
    check(await page.eval(`state.recordElements.get('image-row')!==__imageRow`), true, 'the key-readiness watcher also rebuilds retired image rows');
    check(await page.eval(`state.recordElements.get('plain-row')===__plainRow`), true, 'the key watcher does not rebuild plain rows');
    check(await page.eval(`state.recordElements.get('image-row').querySelector('.dsh-image-preview').disabled`), false, 'the key watcher restores a usable preview');
    await sleep(30);
    check(page.exceptions, [], 'the actual browser reports no uncaught exception');
    check(requested.every(route => ['/app', '/parser.js', '/fixture.js', '/favicon.ico'].includes(route)), true, 'renderer tests initiate no external or content requests');
    console.log('Artifact UI: ' + checks + ' actual-Chromium renderer checks passed; metadata-only actions, no user files or live DSH.');
  } finally {
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} try { browser.ws.close(); } catch (_) {} }
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
