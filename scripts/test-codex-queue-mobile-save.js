'use strict';
// Browser pointer/keyboard events -> actual HTTP handler -> real D-drive queue
// persistence. The app-server is isolated protocol data; no live model or task.
// These regressions supplement the separately recorded human save -> ordinary
// Connect -> explicit saved-send reproduction; they are not human acceptance.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),http=require('http');
const {Browser}=require('./browser-check.js');
const {createQueueService}=require('./codex-queue.js');
const root=path.resolve(__dirname,'..');
function bootstrap(){
  window.fixture={messages:[],connected:false};
  window.WebSocket=class{
    constructor(){this.readyState=1;setTimeout(()=>this.onopen&&this.onopen(),0);}
    send(raw){
      const m=JSON.parse(raw);fixture.messages.push(m);if(m.id===undefined||!m.method)return;
      let result={};
      if(m.method==='thread/list')result={data:[{id:'fixture-readonly',name:'Read-only queue save',cwd:'D:/fixture',status:{type:'notLoaded'}}]};
      if(['model/list','thread/items/list','collaborationMode/list'].includes(m.method))result={data:[]};
      if(m.method==='thread/resume'){fixture.connected=true;result={thread:{id:m.params.threadId,status:{type:'idle'}}};}
      if(m.method==='thread/loaded/list')result={data:fixture.connected?['fixture-readonly']:[]};
      if(m.method==='thread/turns/list')result={data:fixture.connected?[{id:'fixture-completed',status:'completed',items:[]}]:[]};
      if(m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:fixture.connected?'idle':'notLoaded'}}};
      setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,result})}),0);
    }
    close(){this.readyState=3;this.onclose&&this.onclose();}
  };
}
(async()=>{
  const dirRoot=path.join(root,'logs','isolated-tests');fs.mkdirSync(dirRoot,{recursive:true});
  const dir=fs.mkdtempSync(path.join(dirRoot,'queue-mobile-save-'));
  const service=createQueueService(dir,()=>0),rpc=[];service.store.rpc=async(method)=>{rpc.push(method);throw Error('Read-only save must not call an app-server');};
  let failNext=false,failNextGet=false,delay=180,browser,page,passed=0;
  const requests=[];
  const check=(name,condition)=>{assert.ok(condition,name);passed++;console.log('PASS '+name);};
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/codex/queue')){
      if(req.method==='POST'){
        const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{try{requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{}});
        if(delay){const end=res.end;res.end=function(...args){setTimeout(()=>end.apply(res,args),delay);return res;};}
      }
      if(req.method==='GET'&&failNextGet){failNextGet=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Isolated refresh failure'}));return;}
      if(req.method==='POST'&&failNext){failNext=false;req.resume();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Isolated save failure'}));return;}
      return service.handle(req,res);
    }
    const name=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,''),file=path.resolve(root,'pwa',name);
    if(name&&file.startsWith(path.join(root,'pwa')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
      res.setHeader('content-type',file.endsWith('.js')?'application/javascript; charset=utf-8':'text/plain');return res.end(fs.readFileSync(file));
    }
    res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'pwa','codex.html')));
  });
  async function click(selector){
    const pos=await page.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos});
  }
  async function type(text){await page.eval("document.getElementById('input').focus()");await page.send('Input.insertText',{text});}
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const profiles=path.join(root,'logs','browser-profiles');fs.mkdirSync(profiles,{recursive:true});process.env.TEMP=profiles;process.env.TMP=profiles;
    browser=await Browser.launch();page=await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+bootstrap.toString()+')()'});
    await page.goto('http://127.0.0.1:'+server.address().port,350);
    await click('.item');await wait(100);
    check('a read-only conversation visibly offers Save for later',await page.eval("document.getElementById('send').textContent===t('保存待办')"));
    await type('Disposable read-only saved instruction');await click('#send');
    check('the real Save button immediately shows pending feedback',await page.eval("document.getElementById('send').disabled && document.getElementById('send').textContent===t('保存中…') && !document.getElementById('queue-save-status').hidden"));
    await wait(300);
    const saved=service.store.list('fixture-readonly');
    check('the real HTTP queue handler persistently saves exactly one deferred message',saved.length===1&&saved[0].requiresConfirmation===true&&JSON.parse(fs.readFileSync(service.store.file,'utf8')).length===1);
    check('confirmed save clears only the submitted input and displays the queue card',await page.eval("document.getElementById('input').value==='' && document.getElementById('queued-messages').textContent.includes('Disposable read-only saved instruction') && document.getElementById('queue-save-status').textContent===t('已保存，尚未发送。')"));
    await service.store.tick();check('saving a read-only draft never resumes a writer or starts a turn',rpc.length===0&&await page.eval("!fixture.messages.some(m=>['thread/resume','turn/start','turn/steer'].includes(m.method))"));
    failNext=true;delay=0;await type('Keep this failed-save draft');await click('#send');await wait(100);
    check('a failed HTTP save keeps the draft and shows a persistent error',await page.eval("document.getElementById('input').value==='Keep this failed-save draft' && !document.getElementById('queue-save-status').hidden && document.getElementById('queue-save-status').textContent.includes('Isolated save failure') && !document.getElementById('send').disabled"));
    check('a failed HTTP save does not add a queue entry',service.store.list('fixture-readonly').length===1);
    await click('#send');await wait(100);
    check('explicit retry saves the preserved draft exactly once',service.store.list('fixture-readonly').length===2&&await page.eval("document.getElementById('input').value===''"));
    await page.eval("document.querySelector('#queued-messages .queued-row button').scrollIntoView({block:'nearest'})");
    await click('#queued-messages .queued-row button');await wait(100);
    check('cancelling an older entry does not clear the latest saved message confirmation',service.store.list('fixture-readonly').length===1&&await page.eval("!document.getElementById('queue-save-status').hidden && !document.getElementById('queued-messages').textContent.includes('Disposable read-only saved instruction')"));
    const projection=await (await fetch('http://127.0.0.1:'+server.address().port+'/codex/queue?threadId=fixture-readonly')).json();
    check('the queue snapshot exposes only a boolean confirmation flag without private request payload',projection.entries[0].requiresConfirmation===true&&!['input','model','effort','collaborationMode'].some(key=>key in projection.entries[0]));
    await click('#connect-current');await wait(120);
    check('ordinary Connect gains this conversation without activating or sending the saved entry',service.store.list('fixture-readonly')[0].requiresConfirmation===true&&!requests.some(r=>r.action==='activate')&&await page.eval("state.resumed && task.kind==='completed' && !fixture.messages.some(m=>m.method==='turn/start')"));
    await service.store.tick();
    check('saved input stays held after ordinary Connect and an idle completed snapshot',rpc.length===0&&service.store.list('fixture-readonly')[0].state==='queued');
    check('a connected held entry retains an explicit Send saved messages button',await page.eval("document.getElementById('queue-connect').textContent===t('发送已存内容') && !document.getElementById('queue-connect').disabled"));
    delay=180;failNext=true;await click('#queue-connect');
    check('explicit saved-send immediately shows busy feedback and disables duplicate sends',await page.eval("document.getElementById('queue-connect').disabled && document.getElementById('queue-connect').textContent===t('正在确认发送已存内容…') && document.getElementById('send').disabled"));
    await page.eval('void connectQueuedThread();void connectQueuedThread();');await wait(300);
    check('a failed activation is visible, keeps the held entry, and concurrent clicks make only one request',requests.filter(r=>r.action==='activate').length===1&&service.store.list('fixture-readonly')[0].requiresConfirmation===true&&await page.eval("document.getElementById('queue-activation-status').textContent.includes('Isolated save failure') && !document.getElementById('queue-connect').disabled"));
    check('failed activation cannot silently start a task or discard the saved instruction',rpc.length===0&&service.store.list('fixture-readonly')[0].state==='queued');
    let acknowledge,startRequested;
    const started=new Promise(resolve=>{startRequested=resolve;});
    service.store.rpc=async(method)=>{
      rpc.push(method);
      if(method==='thread/read')return {thread:{status:{type:'idle'}}};
      if(method==='thread/turns/list')return {data:[{id:'fixture-completed',status:'completed'}]};
      if(method==='turn/start'){startRequested();return new Promise(resolve=>{acknowledge=resolve;});}
      throw Error(method);
    };
    await click('#queue-connect');await wait(300);
    check('explicit saved-send retry activates exactly the held entry and does not resume again',requests.filter(r=>r.action==='activate').length===2&&service.store.list('fixture-readonly')[0].requiresConfirmation===false&&await page.eval("fixture.messages.filter(m=>m.method==='thread/resume').length===1 && !document.getElementById('queue-activation-status')"));
    const delivery=service.store.tick();await started;
    await click('#task-refresh');await wait(100);
    check('a server-confirmed sending entry keeps the save notice until delivery is acknowledged',service.store.list('fixture-readonly')[0].state==='sending'&&await page.eval("!document.getElementById('queue-save-status').hidden"));
    check('a sending entry cannot expose a resend action',await page.eval("!document.getElementById('queue-connect')"));
    acknowledge({turn:{id:'fixture-delivered'}});await delivery;
    failNextGet=true;await click('#task-refresh');await wait(100);
    check('a failed server queue refresh cannot claim or infer delivery',await page.eval("!document.getElementById('queue-save-status').hidden"));
    await click('#task-refresh');await wait(100);
    check('server-confirmed delivery clears both the queue card and its saved-not-sent notice',service.store.entries.some(e=>e.state==='sent'&&e.turnId==='fixture-delivered')&&await page.eval("document.getElementById('queue-save-status').hidden && document.getElementById('queued-messages').textContent===''"));
    await page.eval("state.resumed=false;setTask('unlinked','Isolated read-only cancellation setup');renderFooter()");delay=0;
    await type('Disposable cancellation check');await click('#send');await wait(100);
    await page.eval("document.querySelector('#queued-messages .queued-row button').scrollIntoView({block:'nearest'})");
    await click('#queued-messages .queued-row button');await wait(100);
    check('confirmed cancellation of the notice-owned entry clears its saved confirmation',service.store.list('fixture-readonly').length===0&&await page.eval("document.getElementById('queue-save-status').hidden"));
    console.log(passed+' mobile HTTP queue save checks passed');
  }finally{
    if(page)page.close();
    if(browser){try{await browser.send('Browser.close');}catch(e){}browser.ws.close();browser.proc.kill();}
    server.closeAllConnections();await new Promise(r=>server.close(r));
    if(fs.existsSync(service.store.file))fs.unlinkSync(service.store.file);
    const logs=path.dirname(service.store.file);if(fs.existsSync(logs))fs.rmdirSync(logs);fs.rmdirSync(dir);
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
