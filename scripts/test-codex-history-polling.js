'use strict';
// Isolated observer regression. It does not send to, resume, or modify Codex.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { extractFunction } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname,'..','pwa','codex.html'),'utf8');
let passed=0;const check=(name,ok)=>{assert.ok(ok,name);passed++;console.log('PASS '+name);};
function harness() {
 let now=100000;const calls=[],timers=[], changes=[], contents={data:[{turnId:'turn-1',item:{id:'item-1',type:'agentMessage',text:'Completed reply'}}]};
 const state={view:'thread',thread:{id:'thread-a'},ws:{close(){state.closed=true;}},ready:true,items:{},order:[]};
 const scenario={kind:'notLoaded',turnId:'turn-1',turnStatus:'completed',failMeta:false,failTurns:false,failItems:false,hold:false,pending:[]};
 const box={state,scenario,task:{activity:'',detail:''},document:{hidden:false},observerEpoch:1,observerTimer:null,observerBusy:false,activityVersion:0,PAGE_SIZE:30,
  Promise,JSON,Date:{now:()=>now},t:text=>text,clearTimeout(){},setTimeout(fn,delay){const token={fn,delay};timers.push(token);return token;},
  statusKind:s=>s?.type||'',refreshQueue(){},subscribeIfAlreadyLoaded(){},syncThreadIdentity(){},beforeFirstTurn(){return false;},
  setTask(kind,detail){box.task.kind=kind;box.task.detail=detail;},applyObservedStatus(meta,turn){box.task.kind=turn?.status||meta?.status?.type||'unknown';},renderTaskStatus(){},
  upsertItem(item){changes.push(item.id);state.items[item.id]={item,snapshot:JSON.stringify(item)};if(!state.order.includes(item.id))state.order.push(item.id);},noteActivity(){},tidyItems(){changes.push('tidy');},
  call(method,params,timeout){calls.push({method,params,timeout});
   if(method==='thread/read')return scenario.failMeta?Promise.reject(Error('metadata unavailable')):Promise.resolve({thread:{id:state.thread.id,status:{type:scenario.kind}}});
   if(method==='thread/turns/list')return scenario.failTurns?Promise.reject(Error('turn pagination unavailable')):Promise.resolve({data:[{id:scenario.turnId,status:scenario.turnStatus}]});
   if(method==='thread/loaded/list')return Promise.resolve({data:[]});
   if(method==='thread/items/list'){if(scenario.hold)return new Promise(resolve=>scenario.pending.push(resolve));return scenario.failItems?Promise.reject(Error('history unavailable')):Promise.resolve(contents);}
   throw Error('Unexpected write or non-read method '+method);
  }};
 vm.createContext(box);vm.runInContext(extractFunction(source,'refreshObservedThread'),box);
 const observe=async(force)=>{box.refreshObservedThread(force);await new Promise(resolve=>setImmediate(resolve));};
 return {box,state,scenario,calls,timers,changes,contents,observe,advance(ms){now+=ms;},itemsSince(index){return calls.slice(index).filter(r=>r.method==='thread/items/list');}};
}
(async()=>{
 const h=harness();await h.observe();check('first actual successful completed history sets a thread and turn-scoped cooldown',h.state.historyPoll?.threadId==='thread-a'&&h.state.historyPoll?.turnId==='turn-1'&&h.calls.some(r=>r.method==='thread/items/list'));
 let at=h.calls.length;await h.observe();check('completed unchanged history skips only the large item page',h.itemsSince(at).length===0&&['thread/read','thread/turns/list','thread/loaded/list'].every(method=>h.calls.slice(at).some(r=>r.method===method)));
 check('small status observation retains its 2.5-second cadence',h.timers.at(-1).delay===2500);
 check('unchanged history produces no DOM item rebuild or cleanup',h.changes.filter(v=>v==='item-1').length===1&&h.changes.filter(v=>v==='tidy').length===1);
 at=h.calls.length;h.advance(15000);await h.observe();check('cooldown expires at fifteen seconds and rereads the full latest page',h.itemsSince(at).length===1&&h.itemsSince(at)[0].params.limit===30);
 at=h.calls.length;await h.observe(true);check('explicit manual Refresh bypasses the cooldown',h.itemsSince(at).length===1);
 at=h.calls.length;h.scenario.turnId='turn-2';await h.observe();check('a new completed turn fetches history in the same observation',h.itemsSince(at).length===1&&h.state.historyPoll?.turnId==='turn-2');
 at=h.calls.length;h.scenario.kind='active';await h.observe();check('active metadata immediately fetches full history even if the last turn looks completed',h.itemsSince(at).length===1&&h.state.historyPoll===null);
 await h.observe();check('active tasks continue to fetch all thirty latest items without reduced tail limits',h.calls.at(-2).method==='thread/items/list'&&h.calls.at(-2).params.limit===30);
 h.scenario.kind='notLoaded';await h.observe();at=h.calls.length;h.scenario.turnStatus='inProgress';await h.observe();check('a running latest turn invalidates the completed cache and fetches immediately',h.itemsSince(at).length===1&&h.state.historyPoll===null);
 h.scenario.turnStatus='completed';await h.observe();at=h.calls.length;h.scenario.failMeta=true;await h.observe();check('metadata errors cannot suppress history reads or keep a completed cache',h.itemsSince(at).length===1&&h.state.historyPoll===null);
 h.scenario.failMeta=false;await h.observe();at=h.calls.length;h.scenario.failTurns=true;await h.observe();check('turn status errors immediately fetch history and clear the cooldown',h.itemsSince(at).length===1&&h.state.historyPoll===null);
 h.scenario.failTurns=false;await h.observe();h.scenario.failItems=true;at=h.calls.length;await h.observe(true);check('failed full history read invalidates cache and exposes the synchronization failure',h.itemsSince(at).length===1&&h.state.historyPoll===null&&h.box.task.detail.includes('进度内容暂未同步'));
 h.scenario.failItems=false;await h.observe();at=h.calls.length;h.state.thread={id:'thread-b'};await h.observe();check('another conversation cannot reuse the completed history cooldown',h.itemsSince(at).length===1&&h.state.historyPoll?.threadId==='thread-b');
 const busy=harness();busy.scenario.hold=true;busy.box.refreshObservedThread();await new Promise(resolve=>setImmediate(resolve));busy.box.refreshObservedThread(true);check('manual Refresh while a read is pending is retained without duplicate concurrent reads',busy.state.forceHistoryRefresh===true&&busy.scenario.pending.length===1);
 busy.scenario.hold=false;busy.scenario.pending.shift()(busy.contents);await new Promise(resolve=>setImmediate(resolve));check('pending manual Refresh schedules an immediate follow-up rather than waiting or disappearing',busy.timers.at(-1).delay===0);
 const before=busy.calls.length;busy.timers.at(-1).fn();await new Promise(resolve=>setImmediate(resolve));check('queued manual Refresh actually performs a fresh full history read',busy.itemsSince(before).length===1&&busy.state.forceHistoryRefresh===false);
 check('large content reads allow thirty seconds while small metadata reads remain bounded to eight seconds',h.calls.filter(c=>c.method==='thread/items/list').every(c=>c.timeout===30000)&&h.calls.filter(c=>c.method!=='thread/items/list').every(c=>c.timeout===8000));
 check('the production Refresh button explicitly forces the full history request',source.includes("$('task-refresh').onclick = function () { refreshObservedThread(true); };"));
 check('all observations are read-only and never resume or write to a conversation',h.calls.concat(busy.calls).every(c=>['thread/read','thread/turns/list','thread/items/list','thread/loaded/list'].includes(c.method)));
 console.log(passed+' history polling regression checks passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
