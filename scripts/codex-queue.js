'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function validateCollaborationMode(mode){
  if(mode==null)return null;
  if(!mode||!['plan','default'].includes(mode.mode)||Object.keys(mode).some(k=>!['mode','settings'].includes(k)))throw Error('Invalid collaboration mode');
  const s=mode.settings;
  if(!s||typeof s.model!=='string'||!s.model||s.model.length>200||Object.keys(s).some(k=>!['model','reasoning_effort','developer_instructions'].includes(k))||
    (s.reasoning_effort!=null&&(typeof s.reasoning_effort!=='string'||s.reasoning_effort.length>100))||s.developer_instructions!=null)throw Error('Invalid collaboration mode settings');
  return {mode:mode.mode,settings:{model:s.model,reasoning_effort:s.reasoning_effort||null,developer_instructions:null}};
}

class QueueStore {
  constructor(file,rpc) {
    this.file=file;this.rpc=rpc;this.busy=false;this.entries=[];
    try{if(fs.existsSync(file))this.entries=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(this.entries))throw Error();}
    catch{this.entries=[];this.loadError='队列文件读取失败，请检查电脑端队列文件。';return;}
    for(const e of this.entries)if(e.state==='sending'){e.state='error';e.error='发送状态未确认，请先检查会话，避免重复发送。';}
    this.save();
  }
  save(){const keep=new Set(this.entries.filter(e=>e.state==='sent').slice(-200));this.entries=this.entries.filter(e=>e.state!=='sent'||keep.has(e));fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.entries));fs.renameSync(tmp,this.file);}
  list(tid){return this.entries.filter(e=>e.threadId===tid && e.state!=='sent');}
  enqueue(data){
    if(this.loadError)throw Error(this.loadError);
    const found=this.entries.find(e=>e.id===data.id);if(found)return found;
    if(this.entries.filter(e=>e.state!=='sent').length>=50)throw Error('待发送消息最多 50 条');
    const e={...data,state:'queued',createdAt:Date.now()};this.entries.push(e);this.save();return e;
  }
  cancel(tid,id){const e=this.entries.find(x=>x.id===id&&x.threadId===tid);if(!e)return;if(e.state==='sending'||e.state==='sent')throw Error('消息已经开始发送');this.entries=this.entries.filter(x=>x!==e);this.save();}
  activate(tid){for(const e of this.entries)if(e.threadId===tid&&e.state==='queued')e.requiresConfirmation=false;this.save();}
  note(e,text){if(e.state==='queued'&&this.entries.includes(e)&&e.note!==text){e.note=text;this.save();}}
  async tick(){
    if(this.busy||this.loadError)return;this.busy=true;
    try{
      const tids=[...new Set(this.entries.filter(e=>e.state==='queued').map(e=>e.threadId))];
      for(const tid of tids){
        const e=this.entries.find(e=>e.threadId===tid && e.state!=='sent');
        if(!e || e.state!=='queued')continue;
        if(e.requiresConfirmation){this.note(e,'已保存，尚未发送；请明确选择发送已存内容。');continue;}
        try{
          const status=await this.rpc('thread/read',{threadId:tid,includeTurns:false});
          const runtime=status.thread?.status?.type;
          // Persisted desktop history is not an authoritative live state. The
          // queue must never acquire a writer merely to try delivering input.
          if(runtime!=='active'&&runtime!=='idle'){
            this.note(e,'已保存，等待执行端连接；尚未送达 Codex。');continue;
          }
          if(runtime==='active'){this.note(e,'已连接，等待当前任务结束；尚未发送。');continue;}
          const turns=await this.rpc('thread/turns/list',{threadId:tid,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
          const turn=turns.data?.[0];
          if(!turn || turn.status==='inProgress'){this.note(e,'等待确认当前任务结束；尚未发送。');continue;}
          if(turn.status==='failed'||turn.status==='interrupted'){
            e.state='error';e.error='上一轮失败或已停止，队列已暂停。请取消后按需重新发送。';this.save();continue;
          }
          if(turn.status!=='completed' || (e.waitForTurnId && turn.id!==e.waitForTurnId)){
            this.note(e,'等待指定任务结束；任务轮次已变化时请取消后重新排队。');continue;
          }
          // Only dispatch to an already loaded, idle execution service. Do not
          // resume, unlock or transfer ownership, even after a completed snapshot.
          const verify=await this.rpc('thread/turns/list',{threadId:tid,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
          if(verify.data?.[0]?.id!==turn.id || verify.data[0].status!=='completed')continue;
          const live=await this.rpc('thread/read',{threadId:tid,includeTurns:false});
          if(live.thread?.status?.type!=='idle'){this.note(e,'等待执行端连接或当前任务结束；尚未发送。');continue;}
          if(e.state!=='queued'||!this.entries.includes(e))continue;
          e.state='sending';this.save();
          const params={threadId:tid,input:e.input,clientUserMessageId:e.id};
          if(e.model)params.model=e.model;if(e.effort)params.effort=e.effort;
          if(e.collaborationMode)params.collaborationMode=validateCollaborationMode(e.collaborationMode);
          const result=await this.rpc('turn/start',params);
          const turnId=result.turn?.id || result.turnId;
          if(!turnId)throw Error('服务未返回任务编号，请检查会话后再处理');
          e.state='sent';e.turnId=turnId;e.sentAt=Date.now();
          const next=this.entries.find(x=>x!==e&&x.threadId===tid&&x.state==='queued');
          if(next)next.waitForTurnId=turnId;
          this.save();
        }catch(err){
          // Transport failures before dispatch are retried; after dispatch they
          // are ambiguous and must never trigger an automatic duplicate send.
          if(e.state==='queued'&&/active writer|not found|not loaded|connection|连接|timeout|超时/i.test(err.message)){
            this.note(e,'已保存，等待执行端连接；尚未送达 Codex。');
          }else if(e.state==='sending' || !/connection|连接|timeout|超时/i.test(err.message)){
            const ambiguous=e.state==='sending';e.state='error';e.error=ambiguous?'发送状态未确认，请检查会话。':err.message;this.save();
          }
        }
      }
    }finally{this.busy=false;}
  }
}
function createRpc(port){
  let socket=null,connecting=null,next=0;const pending=new Map();
  function request(method,params){return new Promise((resolve,reject)=>{
    if(!socket||socket.readyState!==1){reject(Error('connection unavailable'));return;}
    const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('request timeout'));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });}
  async function connect(){
    if(connecting)return connecting;if(socket?.readyState===1)return;
    connecting=new Promise((resolve,reject)=>{
      const ws=new WebSocket('ws://127.0.0.1:'+port());socket=ws;
      ws.onmessage=({data})=>{
        // ★ 解析失败必须挡住。
        //
        //   原来这里是裸的 JSON.parse：上游 app-server 只要发一条非 JSON 文本
        //   （心跳、半截帧、协议版本对不上时的一行报错），回调就抛异常，
        //   而它是在事件回调里抛的 —— 没人接得住 → uncaughtException →
        //   整个网关 process.exit(1)。手机那边表现为「突然全断了」，
        //   而且重启之前完全不知道发生了什么。
        //   同一个项目的 codex-threads.js 就是正确 try/catch 的，这里漏了。
        let m;
        try { m = JSON.parse(data); } catch(err) { return; }
        if(!m||m.method)return;
        const p=pending.get(m.id);if(!p)return;
        pending.delete(m.id);clearTimeout(p.timer);
        if(m.error)p.reject(Error((m.error&&m.error.message)||'upstream error'));
        else p.resolve(m.result);
      };
      ws.onopen=()=>request('initialize',{clientInfo:{name:'pocket-bridge-queue',version:'1'},capabilities:{experimentalApi:true}}).then(resolve,reject);
      ws.onerror=()=>reject(Error('connection unavailable'));
      ws.onclose=()=>{if(socket===ws)socket=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('connection closed'));}pending.clear();};
    }).finally(()=>{connecting=null;});return connecting;
  }
  return async(method,params)=>{await connect();return request(method,params);};
}
function createQueueService(base,port){
  const store=new QueueStore(path.join(base,'logs','codex-message-queue.json'),createRpc(port));
  const timer=setInterval(()=>store.tick().catch(()=>{}),2000);timer.unref();
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  return {store,handle(req,res){
    if(store.loadError){json(res,503,{error:store.loadError});return;}
    const u=new URL(req.url,'http://localhost');
    if(req.method==='GET'){json(res,200,{entries:store.list(u.searchParams.get('threadId')).map(e=>({id:e.id,label:e.label,state:e.state,requiresConfirmation:e.requiresConfirmation===true,error:e.error,note:e.note||'已保存，等待确认执行端状态；尚未发送。',createdAt:e.createdAt}))});return;}
    if(req.method!=='POST'){json(res,405,{error:'不支持的请求'});return;}
    if(req.headers['x-dsh-queue']!=='1'){json(res,403,{error:'无效请求'});return;}
    if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)throw Error();}catch{json(res,403,{error:'来源不匹配'});return;}}
    let chunks=[],size=0,tooLarge=false;
    req.on('data',c=>{size+=c.length;if(size>128*1024){tooLarge=true;chunks=[];}else if(!tooLarge)chunks.push(c);});
    req.on('end',()=>{
      if(tooLarge){json(res,413,{error:'消息过长'});return;}
      try{
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof data.threadId!=='string'||data.threadId.length>80)throw Error('无效会话');
        if(data.action==='cancel'){store.cancel(data.threadId,data.id);json(res,200,{ok:true});return;}
        if(data.action==='activate'){store.activate(data.threadId);json(res,200,{ok:true});return;}
        if(data.action!=='enqueue'||!Array.isArray(data.input)||!data.input.length||data.input.length>6)throw Error('无效消息');
        for(const i of data.input){
          if(i.type==='text'){if(typeof i.text!=='string')throw Error('无效文字');}
          else if(i.type==='localImage'){
            const root=path.resolve(base,'uploads','codex')+path.sep;
            if(typeof i.path!=='string'||!path.resolve(i.path).startsWith(root)||!fs.existsSync(i.path))throw Error('图片附件不存在');
          }else throw Error('不支持的附件类型');
        }
        const id=String(data.id||crypto.randomUUID());if(id.length>80)throw Error('无效消息编号');
        const e=store.enqueue({id,threadId:data.threadId,waitForTurnId:String(data.waitForTurnId||''),input:data.input,label:String(data.label||'消息').slice(0,1000),model:typeof data.model==='string'?data.model:null,effort:typeof data.effort==='string'?data.effort:null,collaborationMode:validateCollaborationMode(data.collaborationMode),requiresConfirmation:data.requiresConfirmation===true});
        json(res,200,{ok:true,id:e.id});
      }catch(err){json(res,400,{error:err.message});}
    });
  }};
}
module.exports={QueueStore,createQueueService,createRpc,validateCollaborationMode};
