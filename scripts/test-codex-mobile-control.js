'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {extractFunction}=require('./page-source.js');
const {validateCollaborationMode,QueueStore}=require('./codex-queue.js');
const source=fs.readFileSync(path.join(__dirname,'..','pwa','codex.html'),'utf8');
let passed=0;
function check(name,condition){assert.ok(condition,name);passed++;console.log('PASS '+name);}
function element(){
  const e={children:[],style:{},attrs:{},textContent:'',disabled:false,hidden:false,classList:{add(){},remove(){}},
    appendChild(c){this.children.push(c);return c;},insertBefore(c,ref){const i=this.children.indexOf(ref);this.children.splice(i<0?this.children.length:i,0,c);return c;},
    contains(c){return this.children.includes(c);},focus(){},select(){},remove(){},
    querySelector(sel){return sel==='.btns'?this._btns:sel==='.h'?this._heading:null;},
    querySelectorAll(sel){let found=[];for(const c of this.children){if(sel==='button'&&c.tag==='button')found.push(c);if(c.querySelectorAll)found=found.concat(c.querySelectorAll(sel));}return found;},
    setAttribute(k,v){this.attrs[k]=v;},click(){if(!this.disabled&&this.onclick)this.onclick();}};
  Object.defineProperty(e,'innerHTML',{get(){return this._html||'';},set(v){this._html=v;this.children=[];
    if(v.includes('class="btns"')){this._btns=element();this._btns.className='btns';this.children.push(this._btns);}
    if(v.includes('class="h"')){this._heading=element();this._heading.className='h';this.children.unshift(this._heading);}
  }});return e;
}
function harness(){
  const els={sheetInner:element(),sheet:element(),title:element(),lockhint:element(),input:{value:'Unsent phone draft'},main:{scrollTop:400},jump:element()};
  const state={thread:{id:'t',name:'',preview:'new',model:'gpt-6-astra'},view:'thread',ready:true,resumed:true,
    awaitingFirstTurn:false,running:false,releaseTimer:{},handedBackThreads:{},items:{},order:[],pick:{},approvals:{},pending:{},
    collaborationModes:[{mode:'plan',reasoning_effort:'medium'},{mode:'default',reasoning_effort:null}]};
  const calls=[],task={kind:'idle',activity:'old reply'};
  const box={state,task,document:{createElement:tag=>{const el=element();el.tag=tag;return el;},getElementById:id=>els[id]},$:id=>els[id],
    t:s=>s,tr:s=>s,esc:s=>s,window:{},Date,Object,Promise,activityVersion:0,detachedHandbacks:{},resumeSubscription:null,queueEntries:[],queueDraft:null,stick:false,
    openSheet(){},closeSheet(){},renderFooter(){},renderTaskStatus(){},scheduleRelease(){},toast(){},refreshObservedThread(){},scrollDown(){},connect(){calls.push('ws-connect');},
    clearTimeout(){},setTask(kind,detail){task.kind=kind;task.detail=detail;},
    forkCurrentThread(){calls.push('fork');},newThread(){calls.push('new');},
    askReleasePhone(tid,done){calls.push('phone');done('Handback requested; computer access is not verified.',true,{subscriptionStatus:'notSubscribed'});},
    call(method){calls.push(method);return Promise.resolve({});},
    reasoningText(){return '';},confirm(){throw Error('Native confirmation must not open');}};
  vm.createContext(box);
  for(const name of ['displayThreadTitle','bridgeUploadedFiles','userTextOf','baseName','openLockPanel','openPhoneReleasePanel','updateLockHint','statusKind','applyObservedStatus',
    'syncThreadIdentity','noteActivity','selectedCollaborationMode','subscribeIfAlreadyLoaded','onNotify','connectCurrentThread',
    'phoneHandbackIssue','verifyPhoneHandbackIdle','updateJump','resetConversationScroll','openRenameThreadPanel','showApproval','restorePhoneConnection'])vm.runInContext(extractFunction(source,name),box);
  return {box,state,task,calls,els};
}
{
 const h=harness();h.box.openLockPanel();
 const phone=h.els.sheetInner.children.find(e=>e.id==='lock-release-phone');phone.click();
 check('phone handback uses an inline confirmation without sending yet',h.calls.length===0&&h.els.sheetInner.children.some(e=>e.id==='phone-release-confirm'));
 h.els.sheetInner.children.find(e=>e.textContent==='取消').click();
 check('cancelling the inline confirmation performs no request',h.calls.length===0);
 h.box.openPhoneReleasePanel(h.state.thread);h.els.sheetInner.children.find(e=>e.id==='phone-release-confirm').click();
 check('confirmation requests only phone subscription handback',h.calls.join(',')==='phone');
 check('completed handback result hides its confirmation and offers Close instead of Cancel',h.els.sheetInner.children.find(e=>e.id==='phone-release-confirm').hidden&&h.els.sheetInner.children.some(e=>e.textContent==='关闭'&&e.onclick===h.box.closeSheet));
 check('handback remains viewing-only and never claims writer release',!h.state.resumed&&h.task.kind==='unlinked'&&/待确认/.test(h.task.detail));
 h.box.subscribeIfAlreadyLoaded(['t'],'t',1);
 check('observing after explicit handback does not silently resume',!h.calls.includes('thread/resume'));
 h.box.applyObservedStatus({status:{type:'idle'}},{id:'old',status:'completed'});
 check('idle server metadata does not undo explicit read-only handback',h.task.kind==='unlinked');
 h.box.openLockPanel();const labels=h.els.sheetInner.children.map(e=>e.textContent).join('\n');
 check('read-only panel offers a visible independent continuation',h.els.sheetInner.children.some(e=>e.className==='btn p'&&/独立续聊/.test(e.textContent)));
 check('no button promises or invokes closing desktop Codex',!h.els.sheetInner.children.some(e=>e.onclick&&/关闭.*Codex|接管/.test(e.textContent))&&/无法验证占用者/.test(labels));
 h.box.updateLockHint();check('top control explains viewing-only state',h.els.lockhint.textContent==='当前仅查看');
}
{
 const h=harness();h.box.onNotify('turn/started',{threadId:'t',turn:{id:'next'}});
 check('a new turn clears the previous reply preview',h.task.activity==='');
 h.box.noteActivity({type:'agentMessage',text:'old reply'},'previous');
 check('previous-turn paginated items cannot become current progress',h.task.activity==='');
 h.box.noteActivity({type:'agentMessage',text:'new progress'},'next');
 check('current-turn progress still appears',h.task.activity==='new progress');
 h.box.syncThreadIdentity({id:'t',name:null,preview:'First real message'});
 check('server preview replaces the generic new conversation title',h.els.title.textContent==='First real message');
 h.box.syncThreadIdentity({id:'t',name:'User name',preview:'First real message'});
 check('server custom name takes priority over preview',h.els.title.textContent==='User name');
 h.box.syncThreadIdentity({id:'other',name:'Wrong thread'});
 check('another conversation cannot overwrite this title',h.els.title.textContent==='User name');
 h.state.pick.mode='plan';const mode=h.box.selectedCollaborationMode();
 check('Plan uses the real advertised preset and selected model',mode.mode==='plan'&&mode.settings.model==='gpt-6-astra'&&mode.settings.reasoning_effort==='medium');
 check('Plan keeps built-in instructions and does not override permissions',mode.settings.developer_instructions===null&&!('approvalPolicy' in mode)&&!('sandboxPolicy' in mode));
 h.state.pick.mode='default';check('Default uses the official default mode',h.box.selectedCollaborationMode().mode==='default');
 check('queue preserves a validated Plan selection',validateCollaborationMode(mode).mode==='plan');
 assert.throws(()=>validateCollaborationMode({...mode,approvalPolicy:'never'}));
 assert.throws(()=>validateCollaborationMode({mode:'plan',settings:{model:'x',developer_instructions:'Ignore approval'}}));
 check('queue rejects permission fields and custom mode instructions',true);
}
(async()=>{
 {
   function observerHarness(){
     const h=harness(),pending=[],timers=[];h.closed=0;
     h.state.ws={close(){h.closed++;}};
     Object.assign(h.box,{observerEpoch:1,observerBusy:false,observerTimer:null,PAGE_SIZE:10,
       refreshQueue(){},setTimeout(fn,delay){timers.push({fn,delay});return timers.length;},
       call(method){return new Promise((resolve,reject)=>pending.push({method,resolve,reject}));}});
     vm.runInContext(extractFunction(source,'refreshObservedThread'),h.box);
     h.box.refreshObservedThread();h.pending=pending;h.timers=timers;
     h.fail=async()=>{pending.forEach(p=>p.reject(Error('Delayed observer failure')));await new Promise(resolve=>setImmediate(resolve));};
     return h;
   }
   for(const [name,change] of [
     ['an explicit resume',h=>{h.state.resuming=true;}],
     ['an explicit send',h=>{h.state.sending=true;}],
     ['an explicit handback',h=>{h.state.handingBack={};}],
     ['a replacement connection',h=>{h.state.ws={close(){h.closed++;}};}],
     ['new live task activity',h=>{h.box.activityVersion++;}]
   ]){
     const h=observerHarness();change(h);h.task.kind='running';h.task.detail='Live operation in progress';await h.fail();
     check('delayed observer failures during '+name+' cannot close a socket or replace live task status',
       h.closed===0&&h.task.kind==='running'&&h.task.detail==='Live operation in progress');
     check('discarding observer failures during '+name+' still schedules another observation',
       !h.box.observerBusy&&h.timers.some(timer=>timer.delay===2500));
   }
   const current=observerHarness();await current.fail();
   check('current observer failures still close only their unchanged idle connection',
     current.closed===1&&current.task.kind==='unknown'&&!current.box.observerBusy&&current.timers.some(timer=>timer.delay===2500));
 }
 {
   const h=harness(),timers=[];h.box.setTimeout=(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer;};
   h.box.observerEpoch=1;
   for(const name of ['releaseThread','scheduleRelease'])vm.runInContext(extractFunction(source,name),h.box);
   h.box.scheduleRelease();timers.find(timer=>timer.delay===30000).fn();
   check('idle auto-handback marks the conversation read-only before its unsubscribe request',
     h.calls.join(',')==='thread/unsubscribe'&&!h.state.resumed&&h.state.handedBackThreads.t);
   h.box.subscribeIfAlreadyLoaded(['t'],'t',1);await new Promise(resolve=>setImmediate(resolve));
   check('stale loaded-list results cannot auto-resume an idle handed-back conversation',
     h.calls.join(',')==='thread/unsubscribe'&&!h.state.resumed);
   h.box.applyObservedStatus({status:{type:'idle'}},{id:'completed',status:'completed'});
   check('later idle metadata preserves viewing-only mode until explicit Connect',h.task.kind==='unlinked'&&!h.state.resumed);
   h.box.call=(method,params)=>{h.calls.push(method);return Promise.resolve({thread:{id:params.threadId,status:{type:'idle'}}});};
   await h.box.connectCurrentThread(false);
   check('explicit Connect can reacquire after auto-handback without sending the saved draft',
     h.calls.join(',')==='thread/unsubscribe,thread/resume'&&h.state.resumed&&!h.state.handedBackThreads.t&&h.els.input.value==='Unsent phone draft');
 }
 {
   const h=harness();
   const suffix='\n\n用户上传的文件（已保存在电脑上，请按需读取）：\n'+JSON.stringify({name:'phone-upload.txt',path:'D:\\\\桥\\\\codex-real-use-20260930\\\\bridge\\\\uploads\\\\codex\\\\2477f728-b2de-4233-af9f-9e946a2ed9ad\\\\phone-upload.txt'});
   const title='Read only the attached phone-upload.txt file and tell me its exact text.';
   check('a real bridge attachment suffix is removed only from the display title',h.box.displayThreadTitle({preview:title+suffix})===title);
   check('ordinary user JSON remains visible in titles',h.box.displayThreadTitle({name:'Inspect this JSON: {"name":"x","path":"D:\\my-file.txt"}'})==='Inspect this JSON: {"name":"x","path":"D:\\my-file.txt"}');
   check('attachment-only conversation titles use the filename',h.box.displayThreadTitle({preview:suffix.trimStart()})==='phone-upload.txt');
   h.els['session-control-hint']=element();h.state.resumed=false;h.box.updateLockHint();
   check('an open settings panel updates when phone control becomes viewing-only',/当前仅查看/.test(h.els['session-control-hint'].textContent));
   h.state.resumed=true;h.box.updateLockHint();check('an open settings panel updates when the phone reconnects explicitly',/手机已连接/.test(h.els['session-control-hint'].textContent));
   h.state.threads=[h.state.thread];h.state.searchThreads=[];h.box.writeThreadCache=()=>{};h.box.promptInputStyle=()=>{};
   let closed=false;h.box.closeSheet=()=>{closed=true;};
   h.box.openRenameThreadPanel();check('renaming pauses idle unsubscribe without resuming or giving away the writer',h.state.renameEditingId==='t'&&h.state.releaseTimer===null&&h.state.resumed&&h.calls.length===0);
   const renameInput=h.els.sheetInner.children.find(e=>e.id==='rename-input');renameInput.value='Readable title';
   h.els.sheetInner.children.find(e=>e.id==='rename-save').click();await new Promise(r=>setImmediate(r));
   check('successful rename closes the sheet and preserves existing writer ownership',closed&&h.state.resumed&&h.state.renameEditingId===null&&h.els.title.textContent==='Readable title'&&h.calls.join(',')==='thread/name/set');
   const decisions=['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['powershell','-NoProfile','-Command','Get-Content']}},'decline'];
   let submitted;h.box.reply=(id,payload)=>{submitted={id,payload};return true;};h.box.renderPendingApprovals=()=>{};h.box.setTimeout=()=>{};
   h.box.showApproval({id:71,style:'v2',threadId:'t',title:'Read file',availableDecisions:decisions});
   const card=h.state.approvals[71].el,normal=card.querySelector('.btns'),once=normal.children.find(e=>e.attrs['data-scope']==='once');
   check('one-time approval is the clear primary action',once.className==='p'&&once.textContent==='仅批准本次');
   const ruleCard=card.children.find(e=>e.className==='approval-rule');
   check('rule details start collapsed with a readable command prefix',ruleCard.tag==='details'&&!ruleCard.open&&ruleCard.children.some(e=>e.textContent.includes('powershell -NoProfile -Command Get-Content')));
   const savedSection=card.children.find(e=>e.className==='btns'&&e!==normal),savedButton=savedSection.children[0];
   check('saved-rule approval is a separate secondary action',savedButton.attrs['data-scope']==='saved-rule'&&!normal.children.includes(savedButton));
   savedButton.click();check('rule decision is returned unchanged and every approval button disables',submitted.id===71&&submitted.payload.decision===decisions[1]&&card.querySelectorAll('button').every(b=>b.disabled));
 }
 function releaseHarness(options={}){
   const h=harness(),closed=[],rpc=[];
   h.state.ws={readyState:1,close(code,reason){closed.push({code,reason,marked:!!h.state.handedBackThreads.t});this.readyState=3;h.state.ready=false;}};
   h.box.call=async(method,params)=>{
     rpc.push({method,params});
     if(method==='thread/loaded/list')return options.list || {data:['t','background'],nextCursor:null};
     if(method==='thread/read'){
       if(options.readError)throw Error('Read unavailable');
       return {thread:{id:params.threadId,status:params.threadId==='background' ? (options.background || {type:'idle'}) : {type:'idle'}}};
     }
     if(method==='thread/unsubscribe'){
       if(options.arriveApproval)h.state.approvals.pending={threadId:'background'};
       if(options.replaceSocket)h.state.ws={readyState:1,close(){throw Error('A newer socket must never close');}};
       return {status:options.status || 'unsubscribed'};
     }
     throw Error('Unexpected '+method);
   };
   vm.runInContext(extractFunction(source,'askReleasePhone'),h.box);
   h.closed=closed;h.rpc=rpc;
   h.release=()=>h.box.askReleasePhone('t',(text,ok,j)=>{h.result={text,ok,j};});
   return h;
 }
 {
   const h=releaseHarness();await h.release();
   check('explicit idle handback unsubscribes on this socket and closes only its phone connection',h.result.ok&&h.rpc.filter(x=>x.method==='thread/unsubscribe').length===1&&h.rpc.find(x=>x.method==='thread/unsubscribe').params.threadId==='t'&&h.closed.length===1&&h.closed[0].reason==='phone-handoff');
   check('observation-only markers exist before socket closure for every loaded conversation',h.closed[0].marked&&h.state.handedBackThreads.background);
   check('socket closure keeps writer availability unknown',h.result.j.writerAvailability==='unknown'&&h.result.j.writerReleased===null&&!h.result.j.writerReleaseVerified&&/待实际确认/.test(h.result.text));
   check('handback result explains the roughly one-minute idle release delay without claiming immediate desktop access',/约一分钟/.test(h.result.text)&&/待实际确认/.test(h.result.text));
   check('explicit handback keeps live updates paused until the user restores the phone connection',h.state.handoffPaused===true&&!h.calls.includes('ws-connect'));
   h.state.ready=true;h.state.ws={readyState:1};h.box.subscribeIfAlreadyLoaded(['t','background'],'t',1);
   check('reconnected observation cannot reacquire the handed-back writer or activate a queue',!h.rpc.some(x=>x.method==='thread/resume'||x.method==='turn/start'||x.method==='queue/activate'));
   check('handback preserves the unsent draft',h.els.input.value==='Unsent phone draft');
   h.box.restorePhoneConnection();
   check('explicit Restore opens only the observer connection and retains handback markers',!h.state.handoffPaused&&h.calls.join(',')==='ws-connect'&&h.state.handedBackThreads.t&&!h.rpc.some(x=>x.method==='thread/resume'||x.method==='turn/start'));
 }
 for(const [name,configure] of [
   ['running current task',h=>{h.state.running=true;}],
   ['pending question or approval',h=>{h.state.approvals.ask={threadId:'background'};}],
   ['pending first-turn RPC',h=>{h.state.pending[17]={method:'turn/start'};}],
   ['queued messages',h=>{h.box.queueEntries=[{id:'q',state:'queued'}];}]
 ]){
   const h=releaseHarness();configure(h);await h.release();
   check(name+' prevents any unsubscribe or socket closure',!h.result.ok&&h.closed.length===0&&h.rpc.length===0&&h.state.resumed);
 }
 for(const [name,options] of [
   ['active background task',{background:{type:'active',activeFlags:[]}}],
   ['unknown background status',{background:{type:'futureUnknownStatus'}}],
   ['unreadable background task',{readError:true}],
   ['incomplete loaded-thread list',{list:{data:['t'],nextCursor:'more'}}]
 ]){
   const h=releaseHarness(options);await h.release();
   check(name+' preserves the phone connection without unsubscribing',!h.result.ok&&h.closed.length===0&&!h.rpc.some(x=>x.method==='thread/unsubscribe')&&h.state.resumed);
 }
 {
   const h=releaseHarness({arriveApproval:true});await h.release();
   check('a question arriving during unsubscribe prevents socket closure and stays available',!h.result.ok&&h.closed.length===0&&!!h.state.approvals.pending&&h.state.resumed);
   const changed=releaseHarness({replaceSocket:true});await changed.release();
   check('a changed connection is never closed by an old handback request',!changed.result.ok&&changed.closed.length===0);
   const scroll=harness();scroll.state.anchorStop=()=>{scroll.state.anchorCancelled=true;};scroll.box.resetConversationScroll();
   check('switching to an empty conversation clears the stale jump-to-latest and old scroll anchor',scroll.box.stick&&scroll.els.main.scrollTop===0&&scroll.els.jump.style.display==='none'&&scroll.state.anchorCancelled);
 }
 const h=harness();h.state.resumed=false;h.state.handedBackThreads.t=true;
 const rpc=[];h.box.call=(method,params)=>{rpc.push({method,params});return Promise.resolve({thread:{id:'t',status:{type:'idle'}},model:'gpt-6-astra'});};
 h.box.queueRequest=()=>{throw Error('Normal Connect must not activate saved messages');};
 await h.box.connectCurrentThread(false);
 check('normal Connect explicitly resumes this exact conversation',rpc.length===1&&rpc[0].method==='thread/resume'&&rpc[0].params.threadId==='t'&&rpc[0].params.excludeTurns===true);
 check('normal Connect preserves the draft and never starts a turn',h.els.input.value==='Unsent phone draft'&&!rpc.some(x=>x.method==='turn/start'));
 check('real idle resume enables sending and clears only the explicit handback marker',h.state.resumed&&h.task.kind==='idle'&&!h.state.handedBackThreads.t);
 const dirRoot=path.resolve(__dirname,'..','logs','isolated-tests');fs.mkdirSync(dirRoot,{recursive:true});
 const dir=fs.mkdtempSync(path.join(dirRoot,'codex-control-')),file=path.join(dir,'queue.json'),calls=[];
 try{
   const q=new QueueStore(file,async(method,params)=>{calls.push({method,params});if(method==='thread/read')return {thread:{status:{type:'idle'}}};if(method==='thread/turns/list')return {data:[{id:'completed',status:'completed'}]};if(method==='turn/start')return {turn:{id:'new'}};throw Error(method);});
   const mode={mode:'plan',settings:{model:'gpt-6-astra',reasoning_effort:'medium',developer_instructions:null}};
   q.enqueue({id:'saved',threadId:'t',input:[{type:'text',text:'Saved explicitly'}],requiresConfirmation:true,collaborationMode:mode});
   await q.tick();check('deferred saved messages do not auto-send merely because a writer is connected',calls.length===0&&q.list('t').length===1);
   q.activate('t');await q.tick();
   check('explicit activation sends a saved message with its selected Plan mode',calls.some(x=>x.method==='turn/start'&&x.params.collaborationMode.mode==='plan')&&q.list('t').length===0);
 }finally{if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);}
 console.log(passed+' mobile control regression checks passed');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
