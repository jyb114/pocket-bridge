'use strict';

// Real isolated Chromium and actual UI/translation source. Adapter responses are
// deliberately controlled to exercise admission/late replies; no live DSH,
// desktop application, gateway, credentials or external network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module);
isolated.filename = browserFile;
isolated.paths = module.paths;
isolated._compile(fs.readFileSync(browserFile, 'utf8').replace('    sweepOrphanBrowsers();', '    // Do not sweep other tasks\' browsers.'), browserFile);
const { Browser } = isolated.exports;
const adapter = `
window.__actions={calls:[],preset:'read-only',goal:null,queued:[],resolvers:[]};
window.DshLiteAdapter={
 capabilities:{interactiveReplies:true},
 async connect(fn){__actions.event=fn;fn({type:'status',state:'connected'});},async disconnect(){},
 async listProjects(){return[{id:'p1',name:'Action fixture',path:'D:/action-fixture'}];},
 async listSessions(){return[{id:'s1',title:'First fixture'},{id:'s2',title:'Second fixture'}];},
 async loadSession(id){return{records:[{id:'row-'+id,role:'assistant',text:'Fixture history '+id}],hasMore:false};},
 async cancelSession(id){__actions.calls.push(['stop',id]);},
 async sendMessage(v){__actions.calls.push(['send',v.sessionId,v.text]);},
 async uploadFile(v){__actions.calls.push(['upload',v.sessionId,v.file.name,v.file.size,v.file instanceof File]);(__actions.fileRefs||(__actions.fileRefs=[])).push({name:v.file.name,ref:new WeakRef(v.file)});if(__actions.holdUpload)await new Promise(resolve=>{__actions.uploadResolve=resolve});if(__actions.failUpload)throw Error('Fixture upload refused');const sequence=(__actions.uploadSequence=(__actions.uploadSequence||0)+1),file={attachmentId:__actions.nextUploadId||'native-file-'+sequence,name:__actions.badUploadName?'different.png':v.file.name,bytes:__actions.badUploadBytes?v.file.size+1:v.file.size};const result={receiptId:__actions.missingReceipt?'':'receipt-'+sequence,file};__actions.lastUpload={sessionId:v.sessionId,result};return result;},
 async downloadImageAttachment(v){__actions.calls.push(['attachmentRead',v.sessionId,v.attachmentId]);if(__actions.holdImageRead)await new Promise(resolve=>{(__actions.imageResolvers||(__actions.imageResolvers=[])).push(resolve);v.signal.addEventListener('abort',()=>{__actions.imageAborts=(__actions.imageAborts||0)+1},{once:true});});if(__actions.failImageRead)throw{userMessage:'这个 DSH 版本尚不支持按附件标识读取图片。'};const raw=atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=');return{sessionId:v.sessionId,attachmentId:__actions.wrongImageId?'sha256:'+('f'.repeat(64)):v.attachmentId,blob:new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:'image/png'})};},
 async downloadFile(v){__actions.calls.push(['download',v.sessionId,v.path]);if(v.path==='report.txt')return{blob:new Blob(['download fixture ✓'+String.fromCharCode(10)],{type:'text/plain'}),name:'report.txt'};const raw=atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=');return{blob:new Blob([__actions.badImage?'not an image':Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:'image/png'}),name:'fixture.png'};},
 async listWorkspaceFiles(){return{path:'',entries:[{name:'report.txt',path:'report.txt',type:'file',bytes:21}],nextOffset:null};},
 async listCommands(id){__actions.calls.push(['list',id]);if(__actions.holdList)return new Promise(resolve=>__actions.resolvers.push(resolve));return[{name:'compact'},{name:'plan'},{name:'permission'}];},
 async runCommand(id,line){__actions.calls.push(['command',id,line]);if(__actions.holdCommand)return new Promise(resolve=>{__actions.commandResolve=resolve});return __actions.result;},
 async readPermission(id){__actions.calls.push(['permissionRead',id]);if(__actions.failPermission)throw Error('Fixture read refused');return __actions.preset;},
 async readGoal(id){__actions.calls.push(['goalRead',id]);if(__actions.failGoal)throw Error('Fixture goal read refused');return __actions.goal;},
 async goalAction(id,kind,payload){__actions.calls.push(['goal',id,kind]);if(__actions.failGoalWrite)throw Error('Fixture goal write refused');__actions.goal={id:'g1',revision:1,objective:payload.objective,phase:'active'};},
 async listQueued(id){if(__actions.failQueueRead)throw Error('Fixture queue read refused');return __actions.queued;},
 async updateQueueItem(id,itemId,action){__actions.calls.push(['queue',id,itemId,action]);if(__actions.failQueueWrite)throw Error('Fixture queue update refused');if(action.kind==='edit')__actions.queued=__actions.queued.map(x=>x.id===itemId?{...x,text:action.content[0].text}:x);return{accepted:true};},
 async screenShot(){__actions.calls.push(['screen']);if(__actions.holdScreen)return new Promise(resolve=>{__actions.screenResolve=resolve});if(__actions.failScreen)throw Error('Fixture capture refused');return{mime:'image/png',image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=',width:1,height:1,bytes:67};}
};`;

async function run() {
  process.env.TEMP = 'D:/bridge-dsh-action-test-temp';
  process.env.TMP = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const assets = {
    '/dsh-lite.html': ['text/html', 'dsh-lite.html'],
    '/dsh-lite-ui.js': ['text/javascript', 'dsh-lite-ui.js'],
    '/dsh-lite-lang.js': ['text/javascript', 'dsh-lite-lang.js'],
    '/dsh-lite.css': ['text/css', 'dsh-lite.css'],
    '/i18n.js': ['text/javascript', 'i18n.js']
  };
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname;
    if (name === '/dsh-lite-adapter.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(adapter); return;
    }
    const asset = assets[name];
    if (asset) {
      res.writeHead(200, { 'content-type': asset[0] + '; charset=utf-8' });
      res.end(fs.readFileSync(path.join(root, 'pwa', asset[1]))); return;
    }
    if (name.endsWith('.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(''); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, uploadDir, checks = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  const match = (actual, expression, message) => { assert.match(actual, expression, message); checks++; };
  try {
    browser = await Browser.launch();
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    async function wait(expression) {
      const until = Date.now() + 8000;
      do {
        if (await page.eval(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (Date.now() < until);
      throw Error('Timed out waiting for action fixture state: ' + expression);
    }
    async function pointer(selector, text) {
      const inClosedMenu = await page.eval(`(()=>{const node=${text === undefined ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent===${JSON.stringify(text)})`};return !!node?.closest('#settings-menu[hidden]');})()`);
      if (inClosedMenu) await pointer('#rail-settings');
      const point = await page.eval(`(()=>{let node=${text === undefined ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent===${JSON.stringify(text)})`};if(!node||node.disabled)throw Error('Fixture control unavailable');node.scrollIntoView({block:'center',inline:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||x<0||x>innerWidth||y<0||y>innerHeight||!node.contains(document.elementFromPoint(x,y)))throw Error('Fixture control not reachable: '+${JSON.stringify(selector)}+': '+JSON.stringify({x,y,w:r.width,h:r.height,hit:document.elementFromPoint(x,y)?.className}));return{x,y};})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    const panelText = () => page.eval(`document.querySelector('.screen-overlay .panel-body')?.textContent||''`);
    const commands = () => page.eval(`__actions.calls.filter(x=>x[0]==='command')`);
    const close = () => pointer('.screen-overlay .screen-bar .screen-action:last-child');
    async function select(title) {
      if (!await page.eval(`!document.body.classList.contains('sidebar-hidden')`)) await pointer('#projects-toggle');
      await pointer('#session-list button', title);
      await wait(`document.getElementById('session-title').textContent===${JSON.stringify(title)}&&!document.getElementById('message-input').disabled`);
    }
    await wait(`typeof window.__dshLiteState==='function'&&document.querySelectorAll('#session-list button').length===2`);

    // Screenshot is a deliberate computer read and needs no chosen conversation.
    await page.eval(`__actions.holdScreen=true`);
    await pointer('#rail-screen');
    await wait(`!!__actions.screenResolve`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='screen').length`), 1, 'one explicit screen click issues one read');
    check(await page.eval(`document.querySelector('.screen-bar .screen-action:not(.screen-save)').disabled`), true, 'refresh is disabled while capture is pending');
    await page.eval(`document.querySelector('.screen-bar .screen-action:not(.screen-save)').click()`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='screen').length`), 1, 'a second refresh cannot overlap the first');
    await close();
    await page.eval(`__actions.screenResolve({mime:'image/png',image:'late'});__actions.holdScreen=false`);
    check(await page.eval(`document.querySelectorAll('.screen-overlay img').length`), 0, 'a closed capture cannot restore a removed view');
    await pointer('#rail-screen');
    await wait(`document.querySelector('.screen-save')?.disabled===false`);
    check(await page.eval(`document.querySelectorAll('.screen-image').length`), 1, 'a fresh explicit capture has one image');
    await page.eval(`__actions.failScreen=true`);
    await pointer('.screen-bar .screen-action:not(.screen-save)');
    await wait(`document.querySelector('.screen-holder').textContent.includes('抓屏失败')`);
    check(await page.eval(`document.querySelector('.screen-save').disabled`), true, 'a failed refresh cannot save the prior screenshot');
    await close();

    await select('First fixture');
    await page.eval(`document.getElementById('message-input').value='Preserved action draft';document.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    await pointer('[data-kind="goal"]');
    await wait(`!!document.querySelector('.plan-controls button')`);
    await page.eval(`__actions.holdList=true`);
    await pointer('.screen-overlay button', '压缩上下文');
    await wait(`__actions.resolvers.length===1`);
    await close();
    await select('Second fixture');
    await page.eval(`__actions.resolvers[0]([{name:'compact'}]);__actions.holdList=false`);
    check(await commands(), [], 'closing a compact sheet and changing session must not dispatch to either session');
    await select('First fixture');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'canceled command admission preserves its conversation draft');

    await pointer('[data-kind="goal"]');
    await wait(`!!document.querySelector('.plan-controls button')`);
    await page.eval(`__actions.result={result:{kind:'failure',text:''}}`);
    await pointer('.screen-overlay button', '压缩上下文');
    await wait(`document.querySelector('.goal-compact-result')?.textContent.includes('失败')`);
    check((await commands()).at(-1), ['command', 's1', '/compact'], 'compact uses the exact captured conversation');
    check(await page.eval(`document.querySelector('.goal-compact-result').textContent.includes('完成')`), false, 'empty failure text must never become a completed compact');
    await page.eval(`__actions.result={}`);
    await pointer('.screen-overlay button', '压缩上下文');
    await wait(`document.querySelectorAll('.goal-compact-result').length===2&&document.querySelectorAll('.goal-compact-result')[1].textContent.includes('未确认')`);
    match(await page.eval(`document.querySelectorAll('.goal-compact-result')[1].textContent`), /未确认/, 'an unrecognized command response is explicitly unconfirmed');
    await close();

    await pointer('[data-kind="perm"]');
    await wait(`document.querySelector('.panel-body').textContent.includes('电脑当前授权范围')`);
    check(await page.eval(`document.querySelector('[data-preset="read-only"]').getAttribute('aria-pressed')`), 'true', 'an authoritative scope read selects the current preset');
    await page.eval(`__actions.holdCommand=true`);
    await pointer('[data-preset="workspace-write"]');
    await wait(`!!__actions.commandResolve`);
    check(await page.eval(`[...document.querySelectorAll('[data-preset]')].every(x=>x.disabled)`), true, 'scope mutations are serialized across all preset buttons');
    await page.eval(`__actions.preset='workspace-write';__actions.commandResolve({result:{kind:'success'}});__actions.holdCommand=false`);
    await wait(`document.querySelector('.panel-body').textContent.includes('已确认当前授权范围')`);
    check((await commands()).at(-1), ['command', 's1', '/permission workspace-write'], 'permission request preserves the exact target');
    check(await page.eval(`document.querySelector('[data-preset="workspace-write"]').getAttribute('aria-pressed')`), 'true', 'confirmed selection comes from readback');
    await page.eval(`__actions.failPermission=true;__actions.result={result:{kind:'success'}}`);
    await pointer('[data-preset="read-only"]');
    await wait(`document.querySelector('.panel-body').textContent.includes('是否生效未确认')`);
    match(await panelText(), /当前授权范围未确认/, 'readback failure removes a stale current-scope claim');
    await page.eval(`__actions.result={result:{kind:'failure',text:''}}`);
    await pointer('[data-preset="read-only"]');
    await wait(`document.querySelector('.panel-body').textContent.includes('授权范围切换失败')`);
    match(await panelText(), /切换失败/, 'scope failure cannot become successful selection');
    const beforeDanger = (await commands()).length;
    await page.eval(`window.confirm=()=>false`);
    await pointer('[data-preset="danger-full-access"]');
    check((await commands()).length, beforeDanger, 'declining full-access risk confirmation issues no command');
    await close();
    await page.eval(`delete DshLiteAdapter.readPermission;__actions.result={result:{kind:'success'}}`);
    await pointer('[data-kind="perm"]');
    await pointer('[data-preset="workspace-write"]');
    await wait(`document.querySelector('.panel-body').textContent.includes('是否生效未确认')`);
    check(await page.eval(`document.querySelectorAll('[data-preset][aria-pressed="true"]').length`), 0, 'an older adapter without readback must not fabricate current permission');
    await close();

    await page.eval(`__actions.goal={id:'g1',revision:1,objective:'Last known fixture goal',phase:'active'};__actions.event({type:'session-status',sessionId:'s1',running:true})`);
    await pointer('[data-kind="goal"]');
    // A fresh session read requests the authoritative goal.
    await close(); await select('Second fixture'); await select('First fixture');
    await wait(`document.getElementById('goal-bar').textContent.includes('Last known fixture goal')`);
    await page.eval(`__actions.failGoal=true`);
    await pointer('[data-kind="goal"]');
    await wait(`!!document.querySelector('.goal-form textarea')`);
    await page.eval(`document.querySelector('.goal-form textarea').value='Changed fixture goal'`);
    await pointer('.goal-form button');
    await wait(`document.querySelector('.goal-form .files-status').textContent.includes('结果未确认')`);
    match(await page.eval(`document.getElementById('goal-bar').textContent`), /Last known fixture goal/, 'failed goal read retains the last known goal');
    check(await page.eval(`document.querySelector('.goal-form .files-status').textContent.includes('目标已保存')`), false, 'failed goal readback cannot show saved');
    await close();
    await page.eval(`__actions.failGoal=false;__actions.failGoalWrite=true`);
    await pointer('#goal-bar [data-kind="edit"]');
    await pointer('#goal-bar .goal-input');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.send('Input.insertText', { text: 'Retained inline goal' });
    await pointer('#goal-bar [data-kind="save"]');
    await wait(`!!document.querySelector('#goal-bar [data-kind="read"]')`);
    check(await page.eval(`document.querySelector('#goal-bar .goal-input').value`), 'Retained inline goal', 'failed inline goal edit retains the exact text');
    check(await page.eval(`document.querySelector('#goal-bar [data-kind="save"]')===null`), true, 'an uncertain goal edit must be read before another Save');
    check(await page.eval(`document.querySelector('#goal-bar [data-kind="read"] svg path').getAttribute('d').includes('a7.5')`), true, 'read-only recovery uses a refresh glyph rather than a run triangle');
    const goalWrites = await page.eval(`__actions.calls.filter(x=>x[0]==='goal').length`);
    await pointer('#goal-bar [data-kind="read"]');
    await wait(`!!document.querySelector('#goal-bar [data-kind="save"]')`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='goal').length`), goalWrites, 'checking an uncertain goal edit issues no write');
    check(await page.eval(`document.querySelector('#goal-bar .goal-input').value`), 'Retained inline goal', 'readback of a different goal keeps the user edit');
    await page.eval(`__actions.failGoalWrite=false;__actions.failGoal=true`);
    await pointer('#goal-bar [data-kind="save"]');
    await wait(`!!document.querySelector('#goal-bar [data-kind="read"]')`);
    check(await page.eval(`document.querySelector('#goal-bar .goal-input').value`), 'Retained inline goal', 'accepted write with failed goal readback retains input');
    await page.eval(`__actions.failGoal=false`);
    await pointer('#goal-bar [data-kind="read"]');
    await wait(`document.querySelector('#goal-bar .goal-input')===null`);
    match(await page.eval(`document.getElementById('goal-bar').textContent`), /Retained inline goal/, 'confirmed readback alone retires the inline editor');
    // The phone Return key edits text instead of silently admitting a prompt.
    await pointer('#message-input');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='send').length`), 0, 'phone Return must not send');
    check(await page.eval(`document.getElementById('message-input').value.includes(String.fromCharCode(10))`), true, 'phone Return inserts a newline');
    await page.eval(`document.getElementById('message-input').value='Preserved action draft';document.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}))`);

    await page.eval(`__actions.event({type:'session-status',sessionId:'s1',running:true});__actions.event({type:'records',sessionId:'s1',running:false,records:[{id:'historical-tool',role:'tool',text:'Old interrupted tool',status:'running'}]})`);
    check(await page.eval(`document.getElementById('stop-session').hidden`), true, 'an authoritative completed snapshot overrides historical running rows');
    await page.eval(`__actions.event({type:'session-status',sessionId:'s1',running:false});__actions.event({type:'records',sessionId:'s1',records:[{id:'historical-tool',role:'tool',text:'Old interrupted tool',status:'running'}]})`);
    check(await page.eval(`document.getElementById('stop-session').hidden`), true, 're-rendering cannot undo a confirmed turn-end');
    await page.eval(`__actions.event({type:'session-status',sessionId:'s1',running:true})`);
    check(await page.eval(`document.getElementById('stop-session').hidden`), false, 'a fresh turn-start restores the current Stop action');

    await page.eval(`__actions.queued=[{id:'q1',text:'Original queue text'}];__actions.event({type:'session-status',sessionId:'s1',running:false})`);
    await wait(`document.querySelector('#queue-list [data-kind="edit"]')!==null`);
    await pointer('#queue-list [data-kind="edit"]');
    await pointer('.queue-edit');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.send('Input.insertText', { text: 'Retained queue edit' });
    await page.eval(`__actions.failQueueWrite=true`);
    await pointer('.queue-edit-box button', '保存');
    await wait(`document.querySelector('.queue-edit-box')?.textContent.includes('重新读取队列')`);
    check(await page.eval(`document.querySelector('.queue-edit').value`), 'Retained queue edit', 'failed queued edit retains exact text');
    check(await page.eval(`[...document.querySelectorAll('.queue-edit-box button')].find(x=>x.textContent==='保存').disabled`), true, 'unconfirmed queued edit cannot silently repeat Save');
    const writeCount = await page.eval(`__actions.calls.filter(x=>x[0]==='queue').length`);
    await pointer('.queue-edit-box button', '重新读取队列');
    await wait(`[...document.querySelectorAll('.queue-edit-box button')].find(x=>x.textContent==='保存')?.disabled===false`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='queue').length`), writeCount, 'checking an uncertain edit is read-only');
    check(await page.eval(`document.querySelector('.queue-edit').value`), 'Retained queue edit', 'readback does not replace the edited draft with old queue text');
    await page.eval(`__actions.failQueueWrite=false;__actions.failQueueRead=true`);
    await pointer('.queue-edit-box button', '保存');
    await wait(`document.querySelector('.queue-edit-box')?.textContent.includes('重新读取队列')`);
    check(await page.eval(`document.querySelector('.queue-edit').value`), 'Retained queue edit', 'accepted edit with failed readback still retains local text');
    await page.eval(`__actions.failQueueRead=false`);
    await pointer('.queue-edit-box button', '重新读取队列');
    await wait(`document.querySelector('.queue-edit')===null`);
    match(await page.eval(`document.getElementById('queue-list').textContent`), /Retained queue edit/, 'confirmed updated queue text replaces the editor');

    await page.eval(`location.hash='junk=k=not-a-key';window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    check(await page.eval(`document.getElementById('crypto-chip').dataset.state`), 'off', 'a fragment substring is not encryption proof');
    await page.eval(`location.hash='k=long-enough-fixture-key';window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    match(await page.eval(`document.getElementById('crypto-chip').textContent`), /未就绪/, 'a key without actual crypto components is unready');
    await page.eval(`window.__dshE2eeSecret='long-enough-fixture-key';window.WebSocket.__dshE2ee=true;window.DshE2EE={available:()=>true,encryptedFetch:()=>{},proofState:()=>({ok:false})};window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    check(await page.eval(`document.getElementById('crypto-chip').dataset.state`), 'pending', 'crypto installed without device proof remains pending');
    await page.eval(`DshE2EE.proofState=()=>({ok:true});window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    check(await page.eval(`document.getElementById('crypto-chip').dataset.state`), 'on', 'only an installed connected proven content channel is marked ready');
    await pointer('#crypto-chip');
    match(await panelText(), /被篡改的页面/, 'security explanation distinguishes passive forwarding from serving tampered bootstrap');
    await close();
    // Keyed DOM reconciliation retains actual reading state and media across a
    // repeated full snapshot. Streaming bursts must render one changed row.
    await page.eval(`__actions.rows=Array.from({length:80},(_,i)=>({id:'long-'+i,role:'assistant',text:'History '+i+' '+('readable fixture text '.repeat(12))}));__actions.rows.push({id:'thought',role:'thought',text:'Preserved open thought',status:'settled'},{id:'image',role:'assistant',text:'Fixture image',attachments:[{name:'fixture.png',path:'D:/action-fixture/fixture.png'}]},{id:'stream',role:'assistant',text:'Before burst'});__actions.event({type:'records',sessionId:'s1',running:false,records:__actions.rows})`);
    const downloadsBefore = await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`);
    check(downloadsBefore, 0, 'rendering history image cards never preloads image bytes');
    await pointer('[data-record-id="image"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="image"] img')?.naturalWidth===1`);
    await page.eval(`__actions.event({type:'records',sessionId:'s1',running:false,records:__actions.rows.map(x=>({...x}))})`);
    await wait(`document.querySelector('[data-record-id="image"] img')?.naturalWidth===1`);
    await pointer('[data-record-id="thought"] summary');
    await page.eval(`(()=>{const list=document.getElementById('record-list');__actions.savedRow=document.querySelector('[data-record-id="long-10"]');__actions.savedThought=document.querySelector('[data-record-id="thought"]');__actions.savedImage=document.querySelector('[data-record-id="image"] img');const range=document.createRange();range.selectNodeContents(__actions.savedRow.querySelector('.record-text'));getSelection().removeAllRanges();getSelection().addRange(range);__actions.selected=getSelection().toString();list.scrollTop=800;__actions.top=list.scrollTop;__actions.mutations=[];__actions.observer=new MutationObserver(rows=>__actions.mutations.push(...rows.map(r=>({added:[...r.addedNodes].filter(n=>n.nodeType===1&&n.classList.contains('record')).length,removed:[...r.removedNodes].filter(n=>n.nodeType===1&&n.classList.contains('record')).length}))));__actions.observer.observe(list,{childList:true,subtree:true});__actions.event({type:'records',sessionId:'s1',running:false,records:__actions.rows.map(x=>({...x}))});})()`);
    await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    check(await page.eval(`__actions.savedRow===document.querySelector('[data-record-id="long-10"]')`), true, 'unchanged full snapshots keep existing message DOM');
    check(await page.eval(`document.querySelector('[data-record-id="thought"] details').open`), true, 'repeated history preserves opened thought details');
    check(await page.eval(`getSelection().toString()===__actions.selected&&__actions.selected.length>0`), true, 'reading selection survives unchanged history');
    check(await page.eval(`__actions.savedImage===document.querySelector('[data-record-id="image"] img')`), true, 'a loaded image node survives repeated history');
    check(await page.eval(`document.getElementById('record-list').scrollTop===__actions.top`), true, 'an unchanged full snapshot never jumps reading position');
    check(await page.eval(`__actions.mutations.reduce((n,x)=>n+x.added+x.removed,0)`), 0, 'unchanged history performs no row insertions or removals');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), 1, 'loaded image preservation does not fetch again');
    await page.eval(`(()=>{__actions.mutations=[];const list=document.getElementById('record-list'),getter=Object.getOwnPropertyDescriptor(Element.prototype,'scrollHeight').get;__actions.heightReads=0;Object.defineProperty(list,'scrollHeight',{configurable:true,get(){__actions.heightReads++;return getter.call(this)}});for(let i=0;i<20;i++)__actions.event({type:'record',sessionId:'s1',record:{id:'stream',role:'assistant',text:'Burst '+i}});})()`);
    await wait(`document.querySelector('[data-record-id="stream"]').textContent.includes('Burst 19')`);
    check(await page.eval(`__actions.mutations.reduce((n,x)=>n+x.added,0)`), 1, 'twenty synchronous stream updates replace only the latest changed row once');
    check(await page.eval(`__actions.savedRow===document.querySelector('[data-record-id="long-10"]')`), true, 'streaming never rebuilds unrelated history');
    check(await page.eval(`__actions.heightReads<=5`), true, 'streaming layout reads are bounded per frame, not per chunk');
    check(await page.eval(`document.getElementById('record-list').scrollTop===__actions.top`), true, 'streaming leaves a reader above the bottom in place');
    await page.eval(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{__actions.copied=text}}})`);
    await wait(`!document.querySelector('.jump-bottom').hidden&&document.querySelector('.jump-bottom').classList.contains('is-docked')`);
    check(await page.eval(`document.getElementById('record-list').clientHeight<176`), true, 'goal/queue/error state reproduces a cramped real history viewport');
    check(await page.eval(`document.querySelector('.jump-bottom').parentNode===document.querySelector('.chat-tabs')`), true, 'Latest occupies the existing tab bar instead of covering a short transcript');
    check(await page.eval(`(()=>{const a=document.querySelector('.jump-bottom').getBoundingClientRect(),b=document.getElementById('record-list').getBoundingClientRect();return a.bottom<=b.top+.5&&a.height>=44;})()`), true, 'docked Latest is a reachable 44px action outside the transcript');
    await pointer('[data-record-id="long-10"] .record-copy');
    match(await page.eval(`__actions.copied`), /Burst 19/, 'a retained Copy whole turn button uses current records rather than its old snapshot object');
    match(await page.eval(`__actions.copied`), /History 10/, 'whole-turn copy includes the selected unchanged message');
    await pointer('.jump-bottom');
    await wait(`document.querySelector('.jump-bottom').hidden`);
    check(await page.eval(`(()=>{const l=document.getElementById('record-list');return l.scrollHeight-l.scrollTop-l.clientHeight<2;})()`), true, 'one actual docked Latest click reaches the newest content');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'Latest navigation never changes the unsent composer');
    await page.eval(`delete document.getElementById('record-list').scrollHeight;__actions.event({type:'record',sessionId:'s1',record:{id:'broken-image',role:'assistant',text:'Explicit retry fixture',attachments:[{name:'broken.png',path:'D:/action-fixture/broken.png'}]}});__actions.badImage=true`);
    await wait(`!!document.querySelector('[data-record-id="broken-image"] .record-image-holder')`);
    await pointer('[data-record-id="broken-image"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="broken-image"] .record-image-holder').textContent.includes('再试')`);
    check(await page.eval(`document.querySelector('[data-record-id="broken-image"] img').getAttribute('src')`), null, 'decode failure clears the bad image source so Retry is functional');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), 2, 'decode failure does not trigger automatic downloads');
    await page.eval(`__actions.badImage=false`);
    await pointer('[data-record-id="broken-image"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="broken-image"] img')?.naturalWidth===1`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), 3, 'one explicit image Retry downloads once and actually decodes');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'reconciliation and media actions preserve the composer draft');
    await page.eval(`__actions.observer.disconnect();__actions.event({type:'record',sessionId:'s1',record:{id:'late-frame',role:'assistant',text:'Old context frame'}});[...document.querySelectorAll('#session-list button')].find(x=>x.textContent==='Second fixture').click()`);
    await wait(`document.getElementById('session-title').textContent==='Second fixture'`);
    await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    check(await page.eval(`document.querySelector('[data-record-id="late-frame"]')===null`), true, 'a stale scheduled history frame cannot enter another conversation');
    await select('First fixture');
    await page.eval(`__actions.failGoal=true`);
    await select('Second fixture'); await select('First fixture');
    await pointer('[data-kind="goal"]');
    match(await panelText(), /暂时无法读取/, 'reopened goal sheet distinguishes unavailable from no saved goal');
    // Actual Chromium download completion, not only a blob href or a synthetic
    // click. This proves this owned browser's Files Save path, not iOS Safari.
    await close();
    const downloadDir = fs.mkdtempSync(path.join(process.env.TEMP, 'dsh-file-download-'));
    const downloads = [];
    browser.ws.on('message', value => {
      const message = JSON.parse(value);
      if (message.method === 'Browser.downloadWillBegin' || message.method === 'Browser.downloadProgress') downloads.push(message);
    });
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
    await pointer('#files-open');
    await wait(`document.querySelector('#files-list button')?.textContent.includes('report.txt')`);
    await pointer('#files-list button');
    await wait(`!!document.querySelector('#files-list a[download="report.txt"]')`);
    const fileReads = await page.eval(`__actions.calls.filter(x=>x[0]==='download'&&x[2]==='report.txt').length`);
    check(await page.eval(`document.getElementById('files-preview').textContent.includes('download fixture ✓')`), true, 'the requested text file is previewed before saving');
    await pointer('#files-list a');
    const downloadDeadline = Date.now() + 8000;
    while (!downloads.some(x => x.method === 'Browser.downloadProgress' && x.params.state === 'completed') && Date.now() < downloadDeadline) await new Promise(resolve => setTimeout(resolve, 30));
    const completed = downloads.find(x => x.method === 'Browser.downloadProgress' && x.params.state === 'completed');
    check(!!completed, true, 'actual Chromium reports completed Files Save');
    const start = downloads.find(x => x.method === 'Browser.downloadWillBegin' && x.params.guid === completed.params.guid);
    check(start?.params.suggestedFilename, 'report.txt', 'the actual saved filename matches the computer file');
    check(fs.readFileSync(path.join(downloadDir, completed.params.guid)), Buffer.from('download fixture ✓\n'), 'actual downloaded bytes equal the full file');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download'&&x[2]==='report.txt').length`), fileReads, 'Save uses the exact loaded file without another adapter download');
    await pointer('#files-close');
    assert.ok(path.resolve(downloadDir).startsWith(path.resolve(process.env.TEMP) + path.sep) && path.basename(downloadDir).startsWith('dsh-file-download-'), 'only the owned D: download directory can be removed');
    fs.rmSync(downloadDir, { recursive: true, force: true });
    check(await page.eval(`[...document.querySelectorAll('#classic-view,#settings-classic')].every(x=>x.hidden&&!x.hasAttribute('href'))`), true, 'cached classic entry IDs never advertise an unencrypted upstream route');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'all side actions retain unsent text');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='send').length`), 0, 'commands and side reads never dispatch a chat prompt');
    // Real Chromium file chooser -> actual File -> verified, deliberately
    // pathless native receipt -> history attachment ID. The local preview must
    // never turn into an inferred computer path or an automatic remote read.
    await page.eval(`__actions.failGoal=false;__actions.goal=null;__actions.queued=[]`);
    await select('Second fixture'); await select('First fixture');
    uploadDir = fs.mkdtempSync(path.join(process.env.TEMP, 'dsh-local-upload-'));
    const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=', 'base64');
    await page.eval(`(()=>{const make=URL.createObjectURL.bind(URL),drop=URL.revokeObjectURL.bind(URL);__actions.madeUrls=[];__actions.revokedUrls=[];URL.createObjectURL=blob=>{const url=make(blob);__actions.madeUrls.push(url);return url};URL.revokeObjectURL=url=>{__actions.revokedUrls.push(url);drop(url)}})()`);
    async function chooseOriginal(name, size, payload) {
      const filePath = path.join(uploadDir, name);
      const raw = payload || originalPng;
      const bytes = size ? Buffer.concat([raw, Buffer.alloc(size - raw.length)]) : raw;
      fs.writeFileSync(filePath, bytes);
      const doc = await page.send('DOM.getDocument');
      const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#upload-input' });
      await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
      return bytes;
    }
    async function publishUpload(name, size, payload) {
      const before = await page.eval(`__actions.calls.filter(x=>x[0]==='upload').length`);
      await chooseOriginal(name, size, payload);
      await wait(`__actions.calls.filter(x=>x[0]==='upload').length===${before + 1}&&!document.getElementById('upload-button').disabled`);
      const dto = await page.eval(`__actions.lastUpload.result.file`);
      await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:${JSON.stringify('upload-' + dto.attachmentId)},role:'user',text:'Uploaded fixture',attachments:[{id:${JSON.stringify(dto.attachmentId)},name:${JSON.stringify(name)},size:${dto.bytes},mimeType:'image/png',kind:'file',path:''}]}})`);
      await wait(`!!document.querySelector(${JSON.stringify('[data-record-id="upload-' + dto.attachmentId + '"] .record-local-image')})`);
      while (await page.eval(`!!document.querySelector('#attachment-list button')`)) await pointer('#attachment-list button');
      return dto;
    }
    const remoteReads = await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`);
    const native = await publishUpload('device-first.png');
    const nativeRow = '[data-record-id="upload-' + native.attachmentId + '"]';
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='upload').at(-1).slice(1)`), ['s1', 'device-first.png', originalPng.length, true], 'native upload receives Chromium\'s original File with exact session/name/bytes');
    check(await page.eval(`document.querySelector(${JSON.stringify(nativeRow)}+' img').getAttribute('src')`), null, 'verified local upload remains lazy until an explicit Load');
    check(await page.eval(`__actions.madeUrls.length`), 0, 'history admission creates no blob URL or decoded image');
    match(await page.eval(`document.querySelector(${JSON.stringify(nativeRow)}).textContent`), /仅此手机临时预览/, 'temporary device-local availability is explicit');
    await pointer(nativeRow + ' .record-image-holder');
    await wait(`document.querySelector(${JSON.stringify(nativeRow)}+' img').naturalWidth===1`);
    const nativeUrl = await page.eval(`document.querySelector(${JSON.stringify(nativeRow)}+' img').getAttribute('src')`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), remoteReads, 'local image Load performs zero remote file reads');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'local image Load retains exact draft text');
    check(await page.eval(`document.querySelector(${JSON.stringify(nativeRow)}+' a').download`), 'device-first.png', 'local Save uses the original filename');
    const localSaveStart = downloads.length;
    const localDownloadDir = fs.mkdtempSync(path.join(uploadDir, 'save-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: localDownloadDir, eventsEnabled: true });
    await pointer(nativeRow + ' a');
    const localSaveDeadline = Date.now() + 8000;
    while (!downloads.slice(localSaveStart).some(x => x.method === 'Browser.downloadProgress' && x.params.state === 'completed') && Date.now() < localSaveDeadline) await new Promise(resolve => setTimeout(resolve, 30));
    const localCompleted = downloads.slice(localSaveStart).find(x => x.method === 'Browser.downloadProgress' && x.params.state === 'completed');
    check(!!localCompleted, true, 'actual Chromium completes the local original-image download');
    check(fs.readFileSync(path.join(localDownloadDir, localCompleted.params.guid)), originalPng, 'local Save preserves byte-exact original image');
    await select('Second fixture');
    check(await page.eval(`__actions.revokedUrls.includes(${JSON.stringify(nativeUrl)})`), true, 'switching conversation revokes the old image object URL');
    await page.eval(`__actions.event({type:'record',sessionId:'s2',record:{id:'foreign-local-id',role:'user',attachments:[{id:${JSON.stringify(native.attachmentId)},name:'device-first.png',size:${originalPng.length},mimeType:'image/png',kind:'file'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="foreign-local-id"] .record-local-image')`);
    check(await page.eval(`document.querySelector('[data-record-id="foreign-local-id"] .record-local-image').dataset.localPreview`), 'unavailable', 'the same attachment ID in another conversation cannot claim the local File');
    check(await page.eval(`document.querySelector('[data-record-id="foreign-local-id"] button')===null`), true, 'unavailable pathless images offer no fake download/Load action');
    await select('First fixture');
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'expired-local-id',role:'user',attachments:[{id:${JSON.stringify(native.attachmentId)},name:'device-first.png',size:${originalPng.length},mimeType:'image/png',kind:'file'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="expired-local-id"] .record-local-image')`);
    match(await page.eval(`document.querySelector('[data-record-id="expired-local-id"]').textContent`), /没有临时副本/, 'returning to old pathless history explains the lost temporary preview');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'context cleanup retains the original conversation draft');

    const malformedCases = [
      ['failUpload', 'failed.png'], ['missingReceipt', 'unconfirmed.png'],
      ['badUploadBytes', 'wrong-size.png'], ['badUploadName', 'wrong-name.png']
    ];
    for (const [flag, name] of malformedCases) {
      await page.eval(`__actions[${JSON.stringify(flag)}]=true;__actions.nextUploadId=${JSON.stringify('invalid-' + flag)}`);
      const before = await page.eval(`__actions.calls.filter(x=>x[0]==='upload').length`);
      await chooseOriginal(name);
      await wait(`__actions.calls.filter(x=>x[0]==='upload').length===${before + 1}&&!document.getElementById('upload-button').disabled`);
      await page.eval(`__actions[${JSON.stringify(flag)}]=false;__actions.nextUploadId='';__actions.event({type:'record',sessionId:'s1',record:{id:${JSON.stringify('invalid-row-' + flag)},role:'user',attachments:[{id:${JSON.stringify('invalid-' + flag)},name:${JSON.stringify(name)},size:${originalPng.length},mimeType:'image/png',kind:'file'}]}})`);
      await wait(`!!document.querySelector(${JSON.stringify('[data-record-id="invalid-row-' + flag + '"] .record-local-image')})`);
      check(await page.eval(`document.querySelector(${JSON.stringify('[data-record-id="invalid-row-' + flag + '"] .record-local-image')}).dataset.localPreview`), 'unavailable', 'failed or mismatched ' + flag + ' receipt cannot retain a preview');
      while (await page.eval(`!!document.querySelector('#attachment-list button')`)) await pointer('#attachment-list button');
    }
    const disguised = await publishUpload('not-raster.png', undefined, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw Error("active")</script></svg>'));
    check(await page.eval(`document.querySelector('[data-record-id="upload-${disguised.attachmentId}"] .record-local-image').dataset.localPreview`), 'unavailable', 'a PNG filename/type without actual raster magic never gets a local object URL');
    // Count bound and true LRU: explicitly using the oldest entry protects it;
    // the next upload evicts the second-oldest rather than the visible image.
    await select('Second fixture'); await select('First fixture');
    const countDtos = [];
    for (let i = 0; i < 4; i++) countDtos.push(await publishUpload('count-' + i + '.png'));
    await pointer('[data-record-id="upload-' + countDtos[0].attachmentId + '"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="upload-${countDtos[0].attachmentId}"] img').naturalWidth===1`);
    await page.eval(`__actions.retainedEvictedRow=document.querySelector('[data-record-id="upload-${countDtos[1].attachmentId}"]')`);
    countDtos.push(await publishUpload('count-4.png'));
    check(await page.eval(`document.querySelectorAll('.record-local-image[data-local-preview="available"]').length`), 4, 'retained original Files are bounded to four entries');
    check(await page.eval(`document.querySelector('[data-record-id="upload-${countDtos[1].attachmentId}"] .record-local-image').dataset.localPreview`), 'unavailable', 'LRU evicts the least-recently-used original File');
    check(await page.eval(`document.querySelector('[data-record-id="upload-${countDtos[0].attachmentId}"] img').naturalWidth`), 1, 'LRU preserves the explicitly used original image');
    await page.send('HeapProfiler.collectGarbage');
    check(await page.eval(`__actions.fileRefs.find(x=>x.name==='count-1.png').ref.deref()===undefined`), true, 'an evicted original File is collectible even while the old DOM row is retained');
    const lruUrl = await page.eval(`document.querySelector('[data-record-id="upload-${countDtos[0].attachmentId}"] img').getAttribute('src')`);
    await page.eval(`window.__dshE2eeSecret='a-different-long-fixture-key';document.dispatchEvent(new Event('visibilitychange'))`);
    await wait(`document.querySelectorAll('.record-local-image[data-local-preview="available"]').length===0`);
    check(await page.eval(`__actions.revokedUrls.includes(${JSON.stringify(lruUrl)})`), true, 'authoritative key identity change revokes loaded local originals');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'key-change cleanup does not discard drafts');
    // A byte bound remains effective below the four-file count limit.
    await select('Second fixture'); await select('First fixture');
    const byteDtos = [];
    for (let i = 0; i < 4; i++) byteDtos.push(await publishUpload('bytes-' + i + '.png', 6 * 1024 * 1024));
    check(await page.eval(`document.querySelectorAll('.record-local-image[data-local-preview="available"]').length`), 3, 'a 20 MiB total bound evicts a File before four 6 MiB originals accumulate');
    check(await page.eval(`document.querySelector('[data-record-id="upload-${byteDtos[0].attachmentId}"] .record-local-image').dataset.localPreview`), 'unavailable', 'byte-bound eviction is explicit in the original history row');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), remoteReads, 'local preview and eviction never fall back to arbitrary computer reads');
    // A successful upload returning after leaving the captured context retains
    // its receipt for that draft, but never makes an old File available here.
    await select('Second fixture'); await select('First fixture');
    await page.eval(`__actions.holdUpload=true;__actions.nextUploadId='late-native-file'`);
    await chooseOriginal('late.png');
    await wait(`!!__actions.uploadResolve`);
    await select('Second fixture'); await select('First fixture');
    await page.eval(`__actions.uploadResolve();__actions.holdUpload=false;__actions.nextUploadId=''`);
    await wait(`!document.getElementById('upload-button').disabled`);
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'late-local-row',role:'user',attachments:[{id:'late-native-file',name:'late.png',size:${originalPng.length},mimeType:'image/png',kind:'file'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="late-local-row"] .record-local-image')`);
    check(await page.eval(`document.querySelector('[data-record-id="late-local-row"] .record-local-image').dataset.localPreview`), 'unavailable', 'leaving and returning during upload cannot reuse the old context\'s File');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'late upload cleanup retains the exact current draft');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='send').length`), 0, 'preview tests never auto-send a prompt or attachment');
    // An official image block with a durable ID uses the new authorized image
    // read, while a generic file block never gains that authority from its name.
    await select('Second fixture'); await select('First fixture');
    const officialId = 'sha256:' + 'a'.repeat(64);
    const genericId = 'sha256:' + 'b'.repeat(64);
    await page.eval(`__actions.event({type:'records',sessionId:'s1',running:false,records:[{id:'official-image',role:'user',attachments:[{id:${JSON.stringify(officialId)},name:'official.png',size:${originalPng.length},mimeType:'image/png',kind:'image'}]},{id:'generic-image-file',role:'user',attachments:[{id:${JSON.stringify(genericId)},name:'generic.png',size:${originalPng.length},mimeType:'image/png',kind:'file'}]}]})`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`), 0, 'rendering official image metadata never reads image bytes');
    check(await page.eval(`document.querySelector('[data-record-id="generic-image-file"] .record-local-image').dataset.localPreview`), 'unavailable', 'a generic PNG file with a digest-shaped ID cannot gain official image authority');
    await pointer('[data-record-id="official-image"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="official-image"] img').naturalWidth===1`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead')`), [['attachmentRead', 's1', officialId]], 'one explicit official Load uses the exact current session and image ID');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), remoteReads, 'official ID retrieval never invents a workspace path');
    const officialUrl = await page.eval(`document.querySelector('[data-record-id="official-image"] img').getAttribute('src')`);
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'official-image',role:'user',text:'Updated image caption',attachments:[{id:${JSON.stringify(officialId)},name:'official.png',size:${originalPng.length},mimeType:'image/png',kind:'image'}]}})`);
    await wait(`document.querySelector('[data-record-id="official-image"] img')?.naturalWidth===1`);
    check(await page.eval(`document.querySelector('[data-record-id="official-image"] img').getAttribute('src')`), officialUrl, 'changed image caption restores the already requested scoped image');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`), 1, 'reconciliation does not re-read already loaded official images');
    // The same ID is not a cache key across sessions. A refused read remains a
    // deliberate Retry and never tries the file downloader or a plaintext URL.
    await select('Second fixture');
    check(await page.eval(`__actions.revokedUrls.includes(${JSON.stringify(officialUrl)})`), true, 'session change revokes the official image object URL');
    await page.eval(`__actions.failImageRead=true;__actions.event({type:'record',sessionId:'s2',record:{id:'official-second',role:'user',attachments:[{id:${JSON.stringify(officialId)},name:'official.png',size:${originalPng.length},mimeType:'image/png',kind:'image'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="official-second"] .record-image-holder')`);
    await pointer('[data-record-id="official-second"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="official-second"] .record-image-holder').textContent.includes('尚不支持')`);
    check(await page.eval(`document.querySelector('[data-record-id="official-second"] img').getAttribute('src')`), null, 'unsupported official retrieval leaves the image visibly unloaded');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').at(-1)`), ['attachmentRead', 's2', officialId], 'same ID in another session requires that session\'s authorization');
    await page.eval(`__actions.failImageRead=false`);
    await pointer('[data-record-id="official-second"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="official-second"] img').naturalWidth===1`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`), 3, 'one explicit official image Retry issues only one fresh read');
    await select('First fixture');
    await page.eval(`__actions.holdImageRead=true;__actions.imageResolvers=[];__actions.event({type:'records',sessionId:'s1',running:false,records:[{id:'pending-official-a',role:'user',attachments:[{id:${JSON.stringify(officialId)},name:'official.png',mimeType:'image/png',kind:'image'}]},{id:'pending-official-b',role:'assistant',attachments:[{id:${JSON.stringify(officialId)},name:'official.png',mimeType:'image/png',kind:'image'}]}]})`);
    await pointer('[data-record-id="pending-official-a"] .record-image-holder');
    await wait(`__actions.imageResolvers.length===1`);
    await pointer('[data-record-id="pending-official-b"] .record-image-holder');
    check(await page.eval(`__actions.imageResolvers.length`), 1, 'simultaneous cards for the same scoped image coalesce one read');
    await select('Second fixture');
    check(await page.eval(`__actions.imageAborts`), 1, 'leaving an image read aborts its exact owned request signal');
    await page.eval(`__actions.imageResolvers[0]();__actions.holdImageRead=false`);
    await page.eval(`new Promise(resolve=>setTimeout(resolve,50))`);
    check(await page.eval(`document.querySelector('[data-record-id="pending-official-a"]')===null&&document.querySelectorAll('#record-list img[src]').length===0`), true, 'a late image result cannot restore another conversation\'s DOM');
    await select('First fixture');
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'official reads and stale cancellation retain the original draft');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download').length`), remoteReads, 'all image-ID errors/cancellation preserve file-path ACL isolation');
    await page.eval(`__actions.holdImageRead=true;__actions.imageResolvers=[];__actions.event({type:'records',sessionId:'s1',running:false,records:Array.from({length:4},(_,i)=>({id:'parallel-image-'+i,role:'user',attachments:[{id:'sha256:'+String(i+1).repeat(64),name:'parallel.png',mimeType:'image/png',kind:'image'}]}))})`);
    const parallelReads = await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`);
    for (let i = 0; i < 3; i++) {
      await pointer('[data-record-id="parallel-image-' + i + '"] .record-image-holder');
      await wait(`__actions.imageResolvers.length===${i + 1}`);
    }
    await pointer('[data-record-id="parallel-image-3"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="parallel-image-3"] .record-image-holder').textContent.includes('三张')`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`), parallelReads + 3, 'three pending official reads are an enforced admission limit');
    check(await page.eval(`document.querySelector('[data-record-id="parallel-image-3"] img').getAttribute('src')`), null, 'a busy fourth image is explicitly unrequested');
    await page.eval(`__actions.imageResolvers[0]();__actions.holdImageRead=false`);
    await wait(`document.querySelector('[data-record-id="parallel-image-0"] img').naturalWidth===1`);
    await pointer('[data-record-id="parallel-image-3"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="parallel-image-3"] img').naturalWidth===1`);
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='attachmentRead').length`), parallelReads + 4, 'only an explicit Retry reads the fourth image once capacity is free');
    await select('Second fixture');
    await page.eval(`__actions.imageResolvers[1]();__actions.imageResolvers[2]()`);
    await select('First fixture');
    const changingId = 'sha256:' + 'c'.repeat(64);
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'changing-attachment-kind',role:'user',attachments:[{id:${JSON.stringify(changingId)},name:'changing.png',mimeType:'image/png',kind:'file'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="changing-attachment-kind"] .record-local-image')`);
    check(await page.eval(`document.querySelector('[data-record-id="changing-attachment-kind"] .record-image-holder')===null`), true, 'a generic file starts without official image-read authority');
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'changing-attachment-kind',role:'user',attachments:[{id:${JSON.stringify(changingId)},name:'changing.png',mimeType:'image/png',kind:'image'}]}});__actions.wrongImageId=true`);
    await wait(`!!document.querySelector('[data-record-id="changing-attachment-kind"] .record-image-holder')`);
    check(await page.eval(`document.querySelector('[data-record-id="changing-attachment-kind"] .record-local-image')===null`), true, 'a changed authoritative block kind reconciles the row even when ID/name are unchanged');
    await pointer('[data-record-id="changing-attachment-kind"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="changing-attachment-kind"] .record-image-holder').textContent.includes('格式不受支持')`);
    check(await page.eval(`document.querySelector('[data-record-id="changing-attachment-kind"] img').getAttribute('src')`), null, 'a read result for another image ID can never become a blob URL');
    await page.eval(`__actions.wrongImageId=false`);
    await pointer('[data-record-id="changing-attachment-kind"] .record-image-holder');
    await wait(`document.querySelector('[data-record-id="changing-attachment-kind"] img').naturalWidth===1`);
    check(await page.eval(`document.getElementById('message-input').value`), 'Preserved action draft', 'explicit retry of a refused scoped result preserves the draft');
    check(await page.eval(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(x=>/device-first\.png|native-file-|localUploadPreviews|image-attachment/.test(x))`), false, 'temporary Files, image cache IDs, and URLs are not serialized to browser storage');
    // An actual document reload destroys phone-only originals. History remains
    // readable and its limitation is explicit rather than a dead Load button.
    await page.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await wait(`typeof window.__dshLiteState==='function'&&document.querySelectorAll('#session-list button').length===2`);
    await select('First fixture');
    await page.eval(`__actions.event({type:'record',sessionId:'s1',record:{id:'reloaded-local-image',role:'user',attachments:[{id:${JSON.stringify(native.attachmentId)},name:'device-first.png',size:${originalPng.length},mimeType:'image/png',kind:'file'}]}})`);
    await wait(`!!document.querySelector('[data-record-id="reloaded-local-image"] .record-local-image')`);
    match(await page.eval(`document.querySelector('[data-record-id="reloaded-local-image"]').textContent`), /没有临时副本/, 'reloaded pathless native history explains that no phone copy persists');
    check(await page.eval(`__actions.calls.filter(x=>x[0]==='download'||x[0]==='attachmentRead').length`), 0, 'reloaded generic attachments never fetch or infer an image source');
    // Persist a preference through the actual selector listener, then load the
    // real default-Chinese HTML afresh. Calling setLang after load would hide
    // missing initial static translation while dynamic renderers already use t.
    const initialLocaleFields = [
      ['#projects-toggle', 'aria-label', '项目与对话'], ['#rail-settings', 'title', '设置'],
      ['#files-open', 'text', '文件'], ['#tab-conversation', 'text', '对话'],
      ['#tab-activity', 'text', '轨迹'], ['#message-input', 'placeholder', '给 DSH 发送消息…'],
      ['#upload-button', 'aria-label', '上传文件'], ['#send-button', 'aria-label', '发送'],
      ['#rail-new-project', 'text', '添加项目'], ['#rail-screen', 'text', '看电脑屏幕'],
      ['#project-modal-title', 'text', '选择电脑上的文件夹'], ['#files-modal-title', 'text', '电脑工作区文件']
    ];
    for (const locale of ['en', 'es']) {
      await pointer('#rail-settings');
      await page.eval(`(()=>{const select=document.querySelector('#settings-menu select[aria-label="Language"]');select.value=${JSON.stringify(locale)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      check(await page.eval(`localStorage.getItem('dsh-lang')`), locale, 'the actual language selector stores ' + locale);
      await page.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
      await wait(`typeof window.__dshLiteState==='function'&&document.querySelectorAll('#session-list button').length===2`);
      check(await page.eval(`DshI18n.lang()`), locale, 'stored ' + locale + ' is selected on a fresh document without calling setLang');
      for (const [selector, attr, key] of initialLocaleFields) {
        const values = await page.eval(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return{actual:${attr === 'text' ? 'node.textContent' : `node.getAttribute(${JSON.stringify(attr)})`},expected:DshI18n.t(${JSON.stringify(key)})}})()`);
        check(values.actual, values.expected, 'fresh stored-' + locale + ' markup translates ' + selector + ' ' + attr);
        check(values.expected !== key, true, 'stored-' + locale + ' dictionary has a real translation for ' + key);
      }
      check(await page.eval(`document.getElementById('connection-status').textContent`), await page.eval(`DshI18n.t('已连接')`), 'static and dynamic status agree on fresh ' + locale + ' load');
      await page.eval(`DshLiteUI.mount(DshLiteAdapter)`);
      await wait(`document.querySelectorAll('#session-list button').length===2&&__dshLiteState().connection==='connected'`);
      check(await page.eval(`document.getElementById('files-open').textContent`), await page.eval(`DshI18n.t('文件')`), 'router-style remount retains stored ' + locale + ' for static controls');
      check(await page.eval(`__actions.calls.filter(x=>x[0]==='send'||x[0]==='upload'||x[0]==='download'||x[0]==='attachmentRead').length`), 0, 'persisted language load/remount never writes or requests content images');
    }
    // Safe optional artifact for the parent: synthetic English conversation and
    // the repository's own icon, never a private phone URL/history/key.
    if (process.env.DSH_ACTION_SCREENSHOT_DIR) {
      const artifactDir = path.resolve(process.env.DSH_ACTION_SCREENSHOT_DIR);
      assert.ok(artifactDir.startsWith(path.resolve('D:/桥/release-prep-20261001') + path.sep), 'visual evidence stays inside the named private D: preparation root');
      fs.mkdirSync(artifactDir, { recursive: true });
      await page.eval(`DshI18n.setLang('en');__actions.event({type:'records',sessionId:'s1',running:false,records:[]})`);
      const visualFile = path.join(uploadDir, 'bridge-preview.png');
      fs.copyFileSync(path.join(root, 'pwa', 'icon-192.png'), visualFile);
      const doc = await page.send('DOM.getDocument');
      const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#upload-input' });
      await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [visualFile] });
      await wait(`__actions.lastUpload?.result.file.name==='bridge-preview.png'&&!document.getElementById('upload-button').disabled`);
      const visualDto = await page.eval(`__actions.lastUpload.result.file`);
      await page.eval(`__actions.event({type:'records',sessionId:'s1',running:false,records:[{id:'visual-upload',role:'user',text:'Preview a newly uploaded image',attachments:[{id:${JSON.stringify(visualDto.attachmentId)},name:'bridge-preview.png',size:${visualDto.bytes},mimeType:'image/png',kind:'file'}]}]})`);
      await pointer('[data-record-id="visual-upload"] .record-image-holder');
      await wait(`document.querySelector('[data-record-id="visual-upload"] img').naturalWidth===192`);
      while (await page.eval(`!!document.querySelector('#attachment-list button')`)) await pointer('#attachment-list button');
      await page.eval(`document.getElementById('record-list').scrollTop=document.getElementById('record-list').scrollHeight;new Promise(resolve=>requestAnimationFrame(resolve))`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(artifactDir, 'dsh-390-en-fresh-image-preview.png'), Buffer.from(shot.data, 'base64'));
      fs.writeFileSync(path.join(artifactDir, 'scope.json'), JSON.stringify({ isolatedBrowser: true, physicalPhone: false, controlledAdapter: true, image: 'repository-owned icon', width: 390, height: 844 }, null, 2));
    }
    check(page.exceptions.length, 0, 'actual UI must have no uncaught browser exceptions');
    console.log('DSH mobile action browser checks passed (' + checks + ')');
  } finally {
    if (browser) {
      try { await browser.send('Browser.close'); } catch (_) {}
      try { browser.ws.close(); } catch (_) {}
      // Wait only for this test's owned child; never sweep a user's browser.
      if (browser.proc && browser.proc.exitCode === null) {
        await Promise.race([new Promise(resolve => browser.proc.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
      }
      if (browser.proc && browser.proc.exitCode === null) { try { browser.proc.kill(); } catch (_) {} }
      await new Promise(resolve => setTimeout(resolve, 400));
      const profile = path.resolve(browser.profile || '');
      if (profile.startsWith(path.resolve(process.env.TEMP) + path.sep) && path.basename(profile).startsWith('dsh-gw-browser-')) {
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
        catch (_) { /* A delayed owned Chromium shutdown must not mask a test failure. */ }
      }
    }
    if (uploadDir && path.resolve(uploadDir).startsWith(path.resolve(process.env.TEMP) + path.sep) && path.basename(uploadDir).startsWith('dsh-local-upload-')) fs.rmSync(uploadDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
