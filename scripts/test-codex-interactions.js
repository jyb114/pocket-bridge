'use strict';
// Real phone UI with a mock app-server; no live account or task.
const fs=require('fs'),path=require('path'),http=require('http');
const {Browser}=require('./browser-check.js');
const root=path.resolve(__dirname,'..');
function bootstrap(){
 window.fixture={messages:[],owned:false,failSend:false};
 window.WebSocket=class{
  constructor(){this.readyState=1;fixture.socket=this;setTimeout(()=>this.onopen&&this.onopen(),0);}
  emit(m){this.onmessage&&this.onmessage({data:JSON.stringify(m)});}
  send(raw){
   const m=JSON.parse(raw);if(fixture.failSend&&!m.method)throw new Error('fixture send failed');
   fixture.messages.push(m);if(m.id===undefined||!m.method)return;
   let result={};
   if(['thread/list','model/list','thread/turns/list','thread/items/list'].includes(m.method))result={data:[]};
   if(m.method==='thread/start')result={thread:{id:'fixture-new-thread',cwd:'D:/fixture'}};
   if(m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:'notLoaded'}}};
   if(m.method==='thread/loaded/list')result={data:fixture.owned?['fixture-thread']:[]};
   if(m.method==='thread/resume'&&fixture.replay){setTimeout(()=>this.emit(fixture.replay),0);result={thread:{id:'fixture-thread'}};}
   setTimeout(()=>this.emit({id:m.id,result}),0);
  }
  close(){this.readyState=3;this.onclose&&this.onclose();}
 };
}
(async()=>{
 let browser,page,failed=0,passed=0;
 const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'');const file=path.resolve(root,'pwa',name);
  if(name&&file.startsWith(path.join(root,'pwa')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
   res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript; charset=utf-8':'text/plain');return res.end(fs.readFileSync(file));
  }
  if(req.url.startsWith('/codex/queue')){res.setHeader('Content-Type','application/json');return res.end('{"entries":[]}');}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'pwa/codex.html')));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const E=fn=>page.eval('('+fn.toString()+')()');
 const check=async(name,fn)=>{const ok=await E(fn);console.log((ok?'PASS ':'FAIL ')+name);ok?passed++:failed++;};
 try{
  browser=await Browser.launch();page=await browser.newPage();
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+bootstrap.toString()+')()'});
  await page.goto('http://127.0.0.1:'+server.address().port,400);
  await check('initialized before normal RPC',()=>fixture.messages[0].method==='initialize'&&fixture.messages[1].method==='initialized'&&fixture.messages[1].id===undefined&&state.ready);
  await E(()=>{state.thread={id:'fixture-thread'};state.view='thread';
   state.pending[77]={resolve:()=>fixture.collisionResolved=true,reject:()=>{}};
   fixture.socket.emit({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',networkApprovalContext:{host:'example.test',protocol:'https'},additionalPermissions:{network:{enabled:true}},availableDecisions:['decline','cancel'],reason:'fixture-network'}});
  });
  await check('request ID does not consume client result',()=>!!state.approvals[77]&&!!state.pending[77]&&!fixture.collisionResolved);
  await check('network destination and permissions visible',()=>state.approvals[77].el.textContent.includes('https://example.test')&&state.approvals[77].el.textContent.includes('"enabled"'));
  await check('only offered decisions shown',()=>state.approvals[77].el.querySelectorAll('button').length===2&&!state.approvals[77].el.textContent.includes(t('本次会话都批准')));
  await E(()=>{fixture.socket.emit({id:77,result:{}});state.approvals[77].el.querySelector('button').click();});
  await check('reply retains server ID',()=>fixture.collisionResolved&&fixture.messages.some(x=>x.id===77&&x.result&&x.result.decision==='decline'));
  await E(()=>{onServerRequest({id:78,method:'item/fileChange/requestApproval',params:{threadId:'fixture-thread',grantRoot:'D:/fixture'}});fixture.failSend=true;state.approvals[78].el.querySelector('button').click();});
  await check('send failure leaves controls actionable',()=>!!state.approvals[78]&&Array.from(state.approvals[78].el.querySelectorAll('button')).every(x=>!x.disabled));
  await E(()=>{fixture.failSend=false;state.approvals[78].el.querySelector('button').click();});
  await check('approval retry succeeds',()=>fixture.messages.some(x=>x.id===78&&x.result&&x.result.decision==='accept'));
  await E(()=>onServerRequest({id:79,method:'item/permissions/requestApproval',params:{threadId:'fixture-thread',permissions:{network:{enabled:true}}}}));
  await check('permission decline does not claim interruption',()=>state.approvals[79].el.querySelectorAll('button').length===3&&!state.approvals[79].el.textContent.includes(t('拒绝并中止')));
  await E(()=>state.approvals[79].el.querySelectorAll('button')[2].click());
  await check('permission rejection grants empty subset',()=>fixture.messages.some(x=>x.id===79&&x.result&&JSON.stringify(x.result.permissions)==='{}'&&x.result.scope==='turn'));
  await E(()=>onServerRequest({id:80,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',availableDecisions:[{applyNetworkPolicyAmendment:{network_policy_amendment:{host:'example.test',action:'deny'}}},'cancel']}}));
  await check('persistent rule details visible',()=>state.approvals[80].el.textContent.includes('example.test')&&state.approvals[80].el.textContent.includes('"deny"'));
  await E(()=>state.approvals[80].el.querySelectorAll('button')[1].click());
  await check('reply preserves offered rule object',()=>fixture.messages.some(x=>x.id===80&&x.result&&x.result.decision.applyNetworkPolicyAmendment.network_policy_amendment.action==='deny'));
  await E(()=>onServerRequest({id:81,method:'item/tool/requestUserInput',params:{threadId:'fixture-thread',questions:[
   {id:'choice',header:'Select path',question:'Choose one',isOther:true,options:[{label:'A',description:'option A details'},{label:'B',description:'option B details'}]},
   {id:'secret',header:'Secret',question:'Private answer',isSecret:true,options:null},
   {id:'normal',header:'Normal',question:'Choose label',options:[{label:'First',description:'first description'},{label:'Second',description:'second description'}]}
  ]}}));
  await check('question headers and descriptions visible',()=>state.approvals[81].el.textContent.includes('Select path')&&state.approvals[81].el.textContent.includes('option A details'));
  await check('explicit choice required',()=>Array.from(state.approvals[81].el.querySelectorAll('select')).every(x=>x.value===''));
  await check('secret input masked',()=>!!state.approvals[81].el.querySelector('input[type=password]'));
  await E(()=>{
   state.approvals[81].el.querySelector('input[type=password]').value='unsent private answer';
   state.thread={id:'other-thread'};renderPendingApprovals();
  });
  await check('another conversation never shows this pending question',()=>!document.getElementById('apprs').textContent.includes('Private answer'));
  await E(()=>{state.thread={id:'fixture-thread'};renderPendingApprovals();});
  await check('returning to the conversation restores its unanswered form',()=>
   document.getElementById('apprs').textContent.includes('Private answer')&&
   state.approvals[81].el.querySelector('input[type=password]').value==='unsent private answer');
  await E(()=>state.approvals[81].el.querySelector('button').click());
  await check('unanswered form does not reply',()=>!fixture.messages.some(x=>x.id===81&&x.result));
  await E(()=>{
   const c=state.approvals[81].el,s=c.querySelectorAll('select');s[0].value='__pocket_bridge_other__';s[0].dispatchEvent(new Event('change'));
   c.querySelector('input:not([type=password])').value='custom answer';c.querySelector('input[type=password]').value='fixture-private';s[1].value='Second';c.querySelector('button').click();fixture.answerTaskKind=task.kind;
  });
  await check('question IDs and answers preserved',()=>fixture.messages.some(x=>x.id===81&&x.result&&x.result.answers.choice.answers[0]==='custom answer'&&x.result.answers.secret.answers[0]==='fixture-private'&&x.result.answers.normal.answers[0]==='Second'));
  await check('answer updates task state',()=>fixture.answerTaskKind==='running');
  await E(()=>{onServerRequest({id:82,method:'mcpServer/elicitation/request',params:{threadId:'fixture-thread',serverName:'fixture-tool',mode:'form',message:'Confirm details',requestedSchema:{type:'object',properties:{name:{type:'string',minLength:2},count:{type:'integer',minimum:1,maximum:3},allow:{type:'boolean'},colour:{type:'string',enum:['red','blue']}},required:['name','count','allow','colour']}}});state.approvals[82].el.querySelector('[data-action=accept]').click();});
  await check('MCP form has no automatic approval',()=>!!state.approvals[82]&&!fixture.messages.some(x=>x.id===82&&x.result));
  await E(()=>{const c=state.approvals[82].el;c.querySelector('[name=name]').value='tester';c.querySelector('[name=count]').value='1.5';c.querySelector('[name=allow]').value='false';c.querySelector('[name=colour]').value='blue';c.querySelector('[data-action=accept]').click();});
  await check('invalid integer cannot submit',()=>!fixture.messages.some(x=>x.id===82&&x.result));
  await E(()=>{state.approvals[82].el.querySelector('[name=count]').value='2';state.approvals[82].el.querySelector('[data-action=accept]').click();});
  await check('MCP response content typed',()=>fixture.messages.some(x=>x.id===82&&x.result&&x.result.action==='accept'&&x.result.content.count===2&&x.result.content.allow===false&&x.result.content.colour==='blue'));
  await E(()=>onServerRequest({id:83,method:'mcpServer/elicitation/request',params:{threadId:'fixture-thread',serverName:'fixture-tool',mode:'url',message:'Link permission',url:'https://example.test/permission',elicitationId:'fixture'}}));
  await check('authorization URL explicit and isolated',()=>state.approvals[83].el.querySelector('a').href==='https://example.test/permission'&&state.approvals[83].el.querySelector('a').rel.includes('noopener')&&!fixture.messages.some(x=>x.id===83&&x.result));
  await E(()=>state.approvals[83].el.querySelector('[data-action=decline]').click());
  await check('URL can be declined without opening',()=>fixture.messages.some(x=>x.id===83&&x.result&&x.result.action==='decline'&&x.result.content===null));
  await E(()=>onServerRequest({id:84,method:'mcpServer/elicitation/request',params:{threadId:'fixture-thread',serverName:'fixture-tool',mode:'form',message:'Complex form',requestedSchema:{type:'object',properties:{nested:{type:'object'}}}}}));
  await check('unsupported schema offers cancel and disables accept',()=>state.approvals[84].el.querySelector('[data-action=accept]').disabled&&!state.approvals[84].el.querySelector('[data-action=cancel]').disabled);
  await E(()=>state.approvals[84].el.querySelector('[data-action=cancel]').click());
  await check('unsupported request resolves only by explicit action',()=>fixture.messages.some(x=>x.id===84&&x.result&&x.result.action==='cancel'));
  await E(()=>onServerRequest({id:85,method:'mcpServer/elicitation/request',params:{threadId:'fixture-thread',serverName:'fixture-tool',mode:'url',message:'Invalid URL',url:'javascript:alert(1)'}}));
  await check('unsafe URL cannot activate or approve',()=>!state.approvals[85].el.querySelector('a')&&state.approvals[85].el.querySelector('[data-action=accept]').disabled);
  await E(()=>onNotify('serverRequest/resolved',{threadId:'fixture-thread',requestId:85}));
  await check('resolved elsewhere removes request card',()=>!state.approvals[85]&&!document.getElementById('apprs').textContent.includes('Invalid URL'));
  await E(()=>{fixture.messages=[];state.resumed=false;ensureOwnershipAfterResume();});
  await new Promise(r=>setTimeout(r,120));
  await check('foreground history never resumes desktop thread',()=>!fixture.messages.some(x=>x.method==='thread/resume'));
  await E(()=>{fixture.owned=true;fixture.replay={id:86,method:'item/tool/requestUserInput',params:{threadId:'fixture-thread',questions:[{id:'replayed',header:'Pending',question:'Replayed question',options:null}]}};fixture.socket.close();});
  await new Promise(r=>setTimeout(r,1350));
  await check('reconnect replays original pending request ID',()=>state.ready&&!!state.approvals[86]&&state.approvals[86].el.textContent.includes('Replayed question'));
  await E(()=>{onNotify('serverRequest/resolved',{threadId:'fixture-thread',requestId:86});openLockPanel();});
  await check('help states desktop request boundary',()=>document.getElementById('sheetInner').textContent.includes(t('电脑端任务的授权、选择和提问仍需在电脑端处理；当前连接只能同步其记录。手机接管后发起的新任务，可以在这里处理请求。')));
  await check('lock explanation contains no raw Markdown emphasis',()=>!document.getElementById('sheetInner').textContent.includes('**'));
  await E(()=>{fixture.longStatus='Status detail '.repeat(16);setTask('running',fixture.longStatus);document.getElementById('task-more').click();});
  await check('status Details really expands the full text',()=>
   document.getElementById('task-status').classList.contains('expanded')&&
   document.getElementById('task-detail').textContent.includes(fixture.longStatus));
  await E(()=>setTask('running',fixture.longStatus+' updated'));
  await check('status remains expanded through live updates',()=>
   document.getElementById('task-status').classList.contains('expanded')&&
   document.getElementById('task-detail').textContent.includes(' updated'));
  await E(()=>{task.activity='A full completed reply that already appears in the conversation';setTask('completed','The latest turn finished.');renderTaskStatus();});
  await check('finished reply is not repeated in the phone status panel',()=>
   document.getElementById('task-activity').hidden&&
   !document.getElementById('task-status').textContent.includes('A full completed reply'));
  await check('finished task status leaves the conversation most of a phone screen',()=>
   document.getElementById('task-status').getBoundingClientRect().height<100);
  await E(()=>{
   state.models=[
    {id:'gpt-6-luna',displayName:'GPT-6 Luna',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
    {id:'gpt-5.6-sol',displayName:'GPT-5.6 Sol',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}
   ];
   openThread({id:'fixture-a',name:'A',cwd:'D:/fixture',model:'gpt-5.6-sol',reasoningEffort:'xhigh'});
   openSheet();
   Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('模型')).click();
   Array.from(document.querySelectorAll('#sheetInner .sopt')).find(x=>x.querySelector('.t')?.textContent==='GPT-6 Luna').click();
  });
  await check('different model shows its default effort instead of old xhigh',()=>{
   const row=Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('思考强度'));
   return state.pick.model==='gpt-6-luna'&&state.pick.effort===null&&row?.querySelector('.v')?.textContent===t('所选模型默认档位');
  });
  await E(()=>Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('思考强度')).click());
  await check('effort picker checks default and omits unsupported old effort',()=>{
   const options=Array.from(document.querySelectorAll('#sheetInner .sopt'));
   return options[0]?.querySelector('.t')?.textContent===t('所选模型默认档位')&&options[0]?.querySelector('.ck')?.textContent==='✓'&&
    !options.some(x=>x.querySelector('.t')?.textContent==='xhigh');
  });
  await E(()=>{
   Array.from(document.querySelectorAll('#sheetInner .sopt')).find(x=>x.querySelector('.t')?.textContent==='high').click();
  });
  await check('model and effort selected through settings belong to A',()=>state.thread.id==='fixture-a'&&state.pick.model==='gpt-6-luna'&&state.pick.effort==='high');
  await E(()=>{
   Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('模型')).click();
   Array.from(document.querySelectorAll('#sheetInner .sopt')).find(x=>x.querySelector('.t')?.textContent==='GPT-5.6 Sol').click();
  });
  await check('choosing the original model restores its original xhigh effort',()=>{
   const row=Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('思考强度'));
   return state.pick.model===null&&state.pick.effort===null&&row?.querySelector('.v')?.textContent==='xhigh';
  });
  await E(()=>{
   Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('模型')).click();
   Array.from(document.querySelectorAll('#sheetInner .sopt')).find(x=>x.querySelector('.t')?.textContent==='GPT-6 Luna').click();
   Array.from(document.querySelectorAll('#sheetInner .srow')).find(x=>x.querySelector('.k')?.textContent===t('思考强度')).click();
   Array.from(document.querySelectorAll('#sheetInner .sopt')).find(x=>x.querySelector('.t')?.textContent==='high').click();
  });
  await E(()=>{closeSheet();openThread({id:'fixture-b',name:'B',cwd:'D:/fixture',model:'gpt-5.6-sol',reasoningEffort:'xhigh'});openSheet();});
  await check('switching to B uses B model and effort, not A overrides',()=>{
   const rows=Array.from(document.querySelectorAll('#sheetInner .srow'));
   const model=rows.find(x=>x.querySelector('.k')?.textContent===t('模型'));
   const effort=rows.find(x=>x.querySelector('.k')?.textContent===t('思考强度'));
   return state.pick.model===null&&state.pick.effort===null&&state.currentEfforts===null&&model?.textContent.includes('GPT-5.6 Sol')&&effort?.textContent.includes('xhigh');
  });
  await E(()=>{closeSheet();openThread({id:'fixture-a',name:'A',cwd:'D:/fixture',model:'gpt-5.6-sol',reasoningEffort:'xhigh'});});
  await check('returning to A restores only A model and effort',()=>state.pick.model==='gpt-6-luna'&&state.pick.effort==='high');
  await E(()=>{loadThreads();openThread({id:'fixture-a',name:'A',cwd:'D:/fixture',model:'gpt-5.6-sol',reasoningEffort:'xhigh'});});
  await check('list navigation preserves A settings',()=>state.pick.model==='gpt-6-luna'&&state.pick.effort==='high');
  await E(()=>{closeSheet();newThread('D:/fixture');});
  await new Promise(r=>setTimeout(r,80));
  await check('new conversation starts without another conversation overrides',()=>state.thread.id==='fixture-new-thread'&&state.pick.model===null&&state.pick.effort===null);
  await E(()=>{state.ready=true;state.resuming=false;state.sending=false;setSendModePref('queue');state.running=false;task.kind='completed';renderFooter();});
  await check('completed turn shows Send arrow while retaining queue preference',()=>{
   const send=document.getElementById('send');
   return document.getElementById('send-mode').style.display==='none'&&send.textContent==='↑'&&
    send.getAttribute('aria-label')===t('发送')&&!send.classList.contains('queue')&&sendModePref()==='queue';
  });
  await E(()=>{state.running=true;task.kind='running';renderFooter();});
  await check('running turn restores queued action from saved preference',()=>{
   const send=document.getElementById('send');
   return document.getElementById('send-mode').style.display!== 'none'&&send.textContent===t('排队')&&
    send.getAttribute('aria-label')===t('加入队列')&&send.classList.contains('queue')&&sendModePref()==='queue';
  });
  await E(()=>{state.running=false;task.kind='unknown';renderFooter();});
  await check('unknown state labels queue honestly',()=>{
   const send=document.getElementById('send');
   return document.getElementById('send-mode').style.display!== 'none'&&send.textContent===t('排队')&&send.classList.contains('queue');
  });
  for(const width of [390,320]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
   for(const lang of ['zh','en','es']){
    // eval() does not capture Node closures; set the requested language on the page.
    await page.eval('window.fixture.testLang='+JSON.stringify(lang));
    await E(()=>{window.DshI18n.setLang(window.fixture.testLang);state.running=true;task.kind='running';setSendModePref('queue');renderFooter();});
    await check('queue label fits one line at '+width+'px in '+lang,()=>{
     const button=document.getElementById('send'),rect=button.getBoundingClientRect();
     const css=getComputedStyle(button),range=document.createRange();range.selectNodeContents(button);
     const label=range.getBoundingClientRect(),available=rect.width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
     return button.classList.contains('queue')&&css.whiteSpace==='nowrap'&&label.width<=available+0.5&&label.height<=rect.height&&
      label.left>=rect.left+parseFloat(css.paddingLeft)-0.5&&label.right<=rect.right-parseFloat(css.paddingRight)+0.5&&
      document.documentElement.scrollWidth<=innerWidth;
    });
    const size=await E(()=>{const b=document.getElementById('send'),r=b.getBoundingClientRect(),t=document.createRange(),c=getComputedStyle(b);t.selectNodeContents(b);return {button:r.width,label:t.getBoundingClientRect().width,labelHeight:t.getBoundingClientRect().height,height:r.height,padding:c.paddingLeft+'/'+c.paddingRight,whiteSpace:c.whiteSpace,scroll:b.scrollWidth,client:b.clientWidth,viewport:innerWidth,document:document.documentElement.scrollWidth};});
    console.log('QUEUE_GEOMETRY '+width+'px '+lang+' '+JSON.stringify(size));
   }
   await E(()=>{state.running=false;task.kind='completed';renderFooter();});
   await check('completed Send fits at '+width+'px',()=>{
    const send=document.getElementById('send');return send.textContent==='↑'&&send.getBoundingClientRect().width===34&&
     document.getElementById('send-mode').style.display==='none'&&document.documentElement.scrollWidth<=innerWidth;
   });
   await E(()=>{state.running=false;task.kind='unknown';renderFooter();});
   await check('unknown queued action fits at '+width+'px',()=>{
    const send=document.getElementById('send');return send.textContent===t('排队')&&send.getBoundingClientRect().width===64&&
     document.getElementById('send-mode').style.display!=='none'&&document.documentElement.scrollWidth<=innerWidth;
   });
  }
 }catch(e){console.error(e.stack||e);failed++;}
 finally{if(page)page.close();if(browser){try{await browser.send('Browser.close');}catch(e){}browser.ws.close();browser.proc.kill();}server.closeAllConnections();await new Promise(r=>server.close(r));}
 console.log('Interactions: '+passed+' passed, '+failed+' failed');process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
