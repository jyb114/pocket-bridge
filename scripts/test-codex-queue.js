'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {QueueStore}=require('./codex-queue.js');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-queue-test-'));let turn={id:'original',status:'inProgress'},calls=[];
 const rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/read'||method==='thread/resume')return {thread:{status:{type:turn.status==='inProgress'?'active':'idle'}}};
  if(method==='thread/turns/list')return {data:[{...turn}]};
  if(method==='turn/start'){turn={id:params.clientUserMessageId,status:'inProgress'};return {turn:{...turn}};}
  throw Error('Unexpected RPC');
 };
 const file=path.join(dir,'queue.json');let q=new QueueStore(file,rpc);
 q.enqueue({id:'one',threadId:'thread',waitForTurnId:'original',input:[{type:'text',text:'第一项'}]});
 q.enqueue({id:'two',threadId:'thread',waitForTurnId:'original',input:[{type:'text',text:'第二项'}]});
 await q.tick();assert.equal(calls.filter(c=>c.method==='turn/start').length,0);console.log('PASS running task is never steered or interrupted by queue');
 q=new QueueStore(file,rpc);assert.equal(q.list('thread').length,2);console.log('PASS queue survives restart without browser');
 turn.status='completed';await q.tick();assert.equal(turn.id,'one');assert.equal(q.list('thread').length,1);console.log('PASS completed task starts first queued message');
 await q.tick();assert.equal(turn.id,'one');console.log('PASS next queue entry waits for new turn to finish');
 turn.status='completed';await q.tick();assert.equal(turn.id,'two');console.log('PASS FIFO across successive turns');
 q.enqueue({id:'three',threadId:'thread',waitForTurnId:'two',input:[{type:'text',text:'第三项'}]});turn.status='interrupted';await q.tick();assert.equal(q.list('thread')[0].state,'error');console.log('PASS stop pauses queue');
 q.cancel('thread','three');assert.equal(q.list('thread').length,0);console.log('PASS queued item can be cancelled');
 q.enqueue({id:'four',threadId:'thread',waitForTurnId:'two',input:[{type:'text',text:'第四项'}]});q.enqueue({id:'four',threadId:'thread',input:[]});assert.equal(q.list('thread').length,1);console.log('PASS retried enqueue is deduplicated');
 q.list('thread')[0].state='sending';q.save();q=new QueueStore(file,rpc);assert.equal(q.list('thread')[0].state,'error');console.log('PASS uncertain dispatch is not automatically repeated');
 assert(!calls.some(c=>c.method==='turn/steer'||c.method==='turn/interrupt'));console.log('PASS no interrupt or steering calls');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
