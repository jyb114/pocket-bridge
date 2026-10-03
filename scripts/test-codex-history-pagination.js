'use strict';
// Actual browser pointer navigation with isolated, delayed read RPC fixtures.
// Never connects to a user's gateway, desktop, or app-server.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { Browser } = require('./browser-check.js');
const os = require('node:os'), net = require('node:net'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const bootstrap = `
window.fixture = { calls: [], delayOlder: false, failOlder: false, pending: [] };
function fixtureItems(id, older) {return Array.from({length:30},(_,n)=>({item:{id:id+'-'+(older?'old':'new')+(29-n),type:'agentMessage',text:id+' '+(older?'Older':'Recent')+' reply '+(29-n)+(fixture.replyVersionText||'')}}));}
window.WebSocket = class {
 constructor(){this.readyState=1;setTimeout(()=>this.onopen&&this.onopen(),0);}
 send(raw){const m=JSON.parse(raw);fixture.calls.push(m);if(m.id===undefined)return;
  let result={};const p=m.params||{};
  if(m.method==='thread/list')result={data:[{id:'history-a',name:'History A'},{id:'history-b',name:'History B'}],nextCursor:null};
  if(m.method==='thread/read')result={thread:{id:p.threadId,status:{type:'notLoaded'}}};
  if(m.method==='thread/turns/list')result={data:[{id:p.threadId+'-turn',status:'completed',items:[]}]};
  if(['model/list','thread/loaded/list','collaborationMode/list'].includes(m.method))result={data:[]};
  if(m.method==='thread/items/list'){result={data:fixtureItems(p.threadId,!!p.cursor),nextCursor:p.cursor?null:p.threadId+'-older'};}
  const respond=(failure)=>this.readyState===1&&this.onmessage&&this.onmessage({data:JSON.stringify(failure?{id:m.id,error:{message:'controlled history connection failure'}}:{id:m.id,result})});
  if(m.method==='thread/items/list'&&!p.cursor&&fixture.failInitialOnce){const message=fixture.failInitialOnce;fixture.failInitialOnce=null;setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,error:{message}})}),0);return;}
  if(m.method==='thread/items/list'&&p.cursor){if(fixture.delayOlder){fixture.pending.push(respond);return;}if(fixture.failOlder){fixture.failOlder=false;setTimeout(()=>respond(true),0);return;}}
  setTimeout(()=>respond(false),0);
 }
 close(){this.readyState=3;this.onclose&&this.onclose();}
};`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page, failed = 0, server;
const check = (name, value) => {console.log((value ? 'PASS ' : 'FAIL ') + name);if(!value)failed++;};
async function launchOwnedBrowser() {
  // Never sweep profiles belonging to other concurrent acceptance tests.
  const exe = [path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')].find(fs.existsSync);
  if (!exe) throw Error('找不到 Edge 或 Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-history-pagination-'));
  const debugPort = await new Promise(resolve => {const listener=net.createServer();listener.listen(0,'127.0.0.1',()=>{const port=listener.address().port;listener.close(()=>resolve(port));});});
  const proc = spawn(exe, ['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--disable-background-networking',
    '--no-proxy-server','--lang=zh-CN','--user-data-dir='+profile,'--remote-debugging-port='+debugPort,'about:blank'], {windowsHide:true,stdio:'ignore'});
  try {
    let info;
    for (let n=0;n<100;n++) {try {info=await (await fetch('http://127.0.0.1:'+debugPort+'/json/version')).json();if(info.webSocketDebuggerUrl)break;}catch{}await pause(100);}
    if (!info?.webSocketDebuggerUrl) throw Error('Owned browser CDP did not start.');
    const instance=new Browser(proc,debugPort,info.webSocketDebuggerUrl);instance.profile=profile;
    await instance.ws.connect();instance.ws.on('message',message=>instance.onMessage(message));return instance;
  } catch(error) {try{proc.kill();}catch{}throw error;}
}
async function wait(expression, timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await page.eval(expression))return;}catch{}await pause(40);}throw Error('Timed out: '+expression);}
async function click(selector){const point=await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw Error('Hidden control');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});}
const chronological = (id, kind) => Array.from({length:30},(_,n)=>id+'-'+kind+n);
async function open(index,id){await wait(`state.view==='list'&&state.listReady&&document.querySelectorAll('#thlist .item').length===2`);await click('#thlist .item:nth-child('+index+')');await wait(`state.view==='thread'&&state.thread.id===${JSON.stringify(id)}&&Object.keys(state.items).length===30&&!observerBusy`);}
(async()=>{try{
 server=http.createServer((req,res)=>{const rel=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,''), file=path.resolve(root,'pwa',rel);if(rel&&file.startsWith(path.join(root,'pwa')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'content-type':file.endsWith('.js')?'application/javascript':'text/plain'});res.end(fs.readFileSync(file));return;}res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(fs.readFileSync(path.join(root,'pwa','codex.html')));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await launchOwnedBrowser();page=await browser.newPage();await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await page.send('Page.addScriptToEvaluateOnNewDocument',{source:bootstrap});await page.goto('http://127.0.0.1:'+server.address().port,100);await open(1,'history-a');
 check('initial page has newest-first response rendered chronologically',JSON.stringify(await page.eval(`state.order`))===JSON.stringify(chronological('history-a','new')));
 check('history pagination provides a native 44px touch and keyboard button',await page.eval(`(()=>{const b=document.getElementById('older-hint'),r=b.getBoundingClientRect();return b.tagName==='BUTTON'&&b.type==='button'&&r.height>=44&&!b.disabled;})()`));
 await click('#older-hint');await wait(`Object.keys(state.items).length===60&&!state.loadingOlder`);
 check('older page is reversed exactly once',await page.eval(`(()=>{const nodes=Object.keys(state.items).map(id=>({id,el:state.items[id].el})).sort((a,b)=>(a.el.compareDocumentPosition(b.el)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1).map(r=>r.id);return JSON.stringify(nodes)===${JSON.stringify(JSON.stringify([...chronological('history-a','old'),...chronological('history-a','new')]))};})()`));
 check('older item IDs and chronological order remain indexed',JSON.stringify(await page.eval(`state.order`))===JSON.stringify([...chronological('history-a','old'),...chronological('history-a','new')]));
 check('older snapshots prevent redundant poll rebuilding',await page.eval(`Object.values(state.items).every(r=>r.snapshot===JSON.stringify(r.item))`));
 check('end of history is visibly disabled',await page.eval(`state.noMore&&document.getElementById('older-hint').disabled`));
 await click('#back');await open(1,'history-a');await page.eval(`fixture.failOlder=true`);await click('#older-hint');await wait(`!state.loadingOlder&&document.getElementById('older-hint').textContent.includes('controlled history connection failure')`);
 check('failed pagination keeps records and cursor instead of claiming empty history',await page.eval(`Object.keys(state.items).length===30&&state.olderCursor==='history-a-older'&&!state.noMore`));
 check('failed pagination offers an enabled explicit Retry',await page.eval(`!document.getElementById('older-hint').disabled&&document.getElementById('older-hint').textContent.includes(t('重试'))`));
 await click('#older-hint');await wait(`Object.keys(state.items).length===60&&!state.loadingOlder`);check('Retry actually loads the previously failed page',await page.eval(`state.order.length===60`));
 await click('#back');await open(1,'history-a');await page.eval(`fixture.delayOlder=true`);await click('#older-hint');await wait(`fixture.pending.length===1&&state.loadingOlder`);await click('#back');await open(2,'history-b');await click('#older-hint');await wait(`fixture.pending.length===2&&state.loadingOlder`);
 await page.eval(`fixture.pending.shift()(false)`);await pause(120);
 check('old conversation reply cannot inject content or cursor into new page',await page.eval(`state.thread.id==='history-b'&&Object.keys(state.items).length===30&&state.order.every(id=>id.startsWith('history-b-'))&&state.olderCursor==='history-b-older'&&!state.noMore`));
 check('old request completion cannot unlock new page pending pagination',await page.eval(`state.loadingOlder===true&&document.getElementById('older-hint').disabled`));
 await page.eval(`fixture.pending.shift()(false)`);await wait(`Object.keys(state.items).length===60&&!state.loadingOlder`);check('new page receives only its own delayed history',await page.eval(`state.order.length===60&&state.order.every(id=>id.startsWith('history-b-'))&&state.noMore`));
 await page.eval('fixture.delayOlder=false');
 for (const errorMessage of ['thread not loaded','thread/items/list is not supported yet','thread not found','request timeout']) {
  await click('#back');await wait(`state.view==='list'&&state.listReady`);await page.eval('fixture.failInitialOnce='+JSON.stringify(errorMessage));await click('#thlist .item:nth-child(1)');
  await wait(`!!document.querySelector('#body .history-load-error button')&&Object.keys(state.items).length===30&&!observerBusy`);
  check('initial '+errorMessage+' stays a visible failure rather than an empty new conversation',await page.eval(`document.querySelector('.history-load-error').textContent.includes(${JSON.stringify(errorMessage)})&&!document.querySelector('#body .empty')`));
  await click('#input');await page.send('Input.insertText',{text:' Preserve draft across history Retry.'});const draft=await page.eval(`document.getElementById('input').value`);
  const version=' Explicit Retry updated '+errorMessage;await page.eval('fixture.replyVersionText='+JSON.stringify(version));await click('#body .history-load-error button');await wait(`!document.querySelector('.history-load-error')&&Object.keys(state.items).length===30&&!observerBusy`);
  check('initial '+errorMessage+' Retry merges changed reply content already indexed by the observer',await page.eval(`document.getElementById('body').textContent.includes(${JSON.stringify(version)})`));
  check('initial '+errorMessage+' Retry preserves recovered real row index and exact draft',await page.eval(`state.order.length===30&&Object.values(state.items).every(r=>r.el.isConnected)&&document.getElementById('input').value===${JSON.stringify(draft)}&&!state.resumed`));
 }
 check('viewing and pagination never resume, start, steer, stop or unsubscribe',await page.eval(`!fixture.calls.some(m=>['thread/resume','thread/start','turn/start','turn/steer','turn/interrupt','thread/unsubscribe'].includes(m.method))`));
 check('browser has no uncaught exceptions',page.exceptions.length===0);
}finally{if(page)page.close();if(browser){try{await browser.send('Browser.close');}catch{}browser.ws.close();try{browser.proc.kill();}catch{}}if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}console.log(failed?failed+' failed':'All history pagination checks passed');process.exitCode=failed?1:0;})().catch(error=>{console.error(error.stack);process.exitCode=1;});
