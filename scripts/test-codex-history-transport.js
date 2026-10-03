'use strict';
// Isolated lossless transport, actual AES frames, and native gzip decoding.
// Never contacts a user's gateway, desktop, account, app-server, or files.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto'),zlib=require('node:zlib');
const {extractFunction}=require('./page-source.js');
const {createTransport,METHOD,LIMITS,scopeOf}=require('./codex-history-transport.js');
const wsf=require('./ws-frame.js'),e2ee=require('./e2ee.js'),{WsCrypto}=require('./ws-crypt.js');
const source=fs.readFileSync(path.join(__dirname,'..','pwa','codex.html'),'utf8');
const contexts=new Set(),upgrade=Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
const query={threadId:'transport-fixture-thread',limit:30,sortDirection:'desc'};
const result={data:Array.from({length:30},(_,n)=>({turnId:'fixture-turn',item:{id:'fixture-item-'+n,type:n?'agentMessage':'commandExecution',
 ...(n?{text:'Reply '+n+'\nWhitespace stays. 中文'}:{aggregatedOutput:('Tool output\n 中文\t  authored whitespace\n').repeat(24000),status:'completed'})}})),nextCursor:'opaque-older-cursor',previousCursor:null,extra:{preserved:true}};
let passed=0,ids=0;const check=(name,condition)=>{assert.ok(condition,name);passed++;console.log('PASS '+name);};
const clone=value=>JSON.parse(JSON.stringify(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function message(buffer){const parsed=wsf.parseFrames(buffer);assert.equal(parsed.rest.length,0);assert.equal(parsed.frames.length,1);return JSON.parse(parsed.frames[0].payload.toString('utf8'));}
function frame(value,masked=true){return wsf.buildFrame(wsf.OP_TEXT,Buffer.from(JSON.stringify(value)),masked);}
function transport(options={},handshake=true){const local=[],errors=[];
 const t=createTransport({encrypted:true,onClientOutput:output=>local.push(output),onError:error=>errors.push(error.message),...options});contexts.add(t);
 if(handshake)assert.ok(t.fromUpstream(upgrade).equals(upgrade));return {t,local,errors};
}
function request(h,changes={},id=++ids){const params={v:1,nonce:crypto.randomBytes(16).toString('hex'),query:clone(query),acceptEncoding:['gzip'],...changes};
 const original={jsonrpc:'2.0',id,method:METHOD,params},wire=h.t.fromClient(frame(original));return {original,params,wire,upstream:wire.length?message(wire):null};
}
function reply(h,r,value=result){return message(h.t.fromUpstream(frame({jsonrpc:'2.0',id:r.upstream.id,result:value},false)));}
function client(options={}){const h=transport(),calls=[],scenario={...options};const ws={readyState:1};
 const box={state:{ws,ready:true,pending:{},nextId:1},window:{__dshE2eeOn:true,WebSocket:{__dshE2ee:true},crypto:crypto.webcrypto,DecompressionStream},
  Promise,JSON,Number,TextEncoder,TextDecoder,Uint8Array,Blob,atob,t:text=>text,HISTORY_WIRE_LIMIT:LIMITS.resultBytes,
  callRaw(method,params){calls.push({method,params});
   if(scenario.error){const err=new Error('Controlled transport error');err.code=scenario.error;err.rpcMethod=scenario.errorMethod||method;return Promise.reject(err);}
   if(method!==METHOD)return Promise.resolve(clone(result));
   const req=request(h,params);let response=reply(h,req,scenario.value||result);
   if(response.error){const err=new Error(response.error.message);err.code=response.error.code;err.rpcMethod=method;return Promise.reject(err);}
   if(scenario.modify)response.result=scenario.modify(response.result,params);
   return Promise.resolve(response.result);
  }};
 vm.createContext(box);vm.runInContext(['historyQueryScope','historyWireContext','forgetHistoryWirePage','cacheHistoryWirePage','historyWireError','inflateHistoryWire','decodeHistoryWire','callHistoryWire','call']
  .map(name=>extractFunction(source,name)).join('\n'),box);
 return {box,calls,scenario,h,ws,read:(params=query,legacy=false)=>box.call('thread/items/list',clone(params),30000,legacy)};
}
(async()=>{try{
 const h=transport(),first=request(h),answer=reply(h,first),env=answer.result;
 check('negotiated history forwards only the original official read with exact params',first.upstream.method==='thread/items/list'&&JSON.stringify(first.upstream.params)===JSON.stringify(query));
 check('internal response ID is separate and original phone ID is restored',first.upstream.id!==first.original.id&&answer.id===first.original.id);
 check('full gzip response carries exact nonce, normalized scope and opaque revision',env.__pbHistory===1&&env.nonce===first.params.nonce&&JSON.stringify(env.scope)===JSON.stringify(scopeOf(query))&&/^[a-f0-9]{64}$/.test(env.revision));
 const decoded=JSON.parse(zlib.gunzipSync(Buffer.from(env.body,'base64')));
 check('compressed history preserves all thirty rows, cursors, extra fields and authored whitespace',JSON.stringify(decoded)===JSON.stringify(result));
 check('base64 compression saves actual response bytes rather than merely compressed binary size',Buffer.byteLength(JSON.stringify(answer))<Buffer.byteLength(JSON.stringify(result))/5);
 const second=request(h,{revision:env.revision}),same=reply(h,second);
 check('unchanged history still issues an official upstream read every time',second.upstream.method==='thread/items/list'&&h.t.stats().rewritten===2);
 check('unchanged response is tiny and contains no original content or compressed body',same.result.unchanged===true&&!('body'in same.result)&&!('value'in same.result)&&Buffer.byteLength(JSON.stringify(same))<650);
 const changedResult=clone(result);changedResult.data[1].item.text+=' changed';
 const third=request(h,{revision:env.revision}),changed=reply(h,third,changedResult);
 check('one changed row forces a complete new page and changed revision',changed.result.unchanged===false&&changed.result.revision!==env.revision&&JSON.stringify(JSON.parse(zlib.gunzipSync(Buffer.from(changed.result.body,'base64'))))===JSON.stringify(changedResult));
 const other=request(h,{query:{...query,cursor:'other-page'},revision:env.revision}),otherReply=reply(h,other);
 check('a revision for another page cannot hide identical returned content',otherReply.result.unchanged===false&&otherReply.result.revision!==env.revision);
 const otherThread=request(h,{query:{...query,threadId:'other-thread'},revision:env.revision}),threadReply=reply(h,otherThread);
 check('a revision for another thread cannot hide identical returned content',threadReply.result.unchanged===false&&threadReply.result.revision!==env.revision);
 const otherConnection=transport(),cross=request(otherConnection,{revision:env.revision});
 check('a reconnect cannot reuse a prior connection revision',reply(otherConnection,cross).result.unchanged===false);
 const identity=request(h,{acceptEncoding:[]}),identityReply=reply(h,identity);
 check('browsers without gzip receive the complete original identity value',identityReply.result.encoding==='identity'&&JSON.stringify(identityReply.result.value)===JSON.stringify(result));
 const small={data:[],nextCursor:null,extra:'retained'},smallRead=request(h),smallReply=reply(h,smallRead,small);
 check('small responses use identity when base64 gzip would be larger',smallReply.result.encoding==='identity'&&JSON.stringify(smallReply.result.value)===JSON.stringify(small));
 const official=request(h),error={code:-32603,message:'Controlled upstream failure',data:{retained:true}};
 const officialError=message(h.t.fromUpstream(frame({jsonrpc:'2.0',id:official.upstream.id,error},false)));
 check('official errors keep their code, data and original request ID',officialError.id===official.original.id&&JSON.stringify(officialError.error)===JSON.stringify(error));
 const huge=transport({limits:{resultBytes:64}}),tooBig=request(huge),over=reply(huge,tooBig,result);
 check('oversize results explicitly refuse without a clipped tail or an implicit legacy read',over.error.code===-32071&&huge.t.stats().rewritten===1&&!over.result);
 const malformed=request(h,{query:{...query,input:[{type:'text',text:'never forward'}]}});
 check('history negotiation refuses extra write-shaped query fields before upstream',!malformed.wire.length&&message(h.local.pop()).error.code===-32602);
 const plaintext=transport({encrypted:false}),plain=request(plaintext);
 check('unencrypted custom transport never forwards private history requests',!plain.wire.length&&message(plaintext.local.pop()).error.code===-32072);
 const legacy=frame({jsonrpc:'2.0',id:777,method:'thread/items/list',params:query});
 check('legacy history bytes stay unchanged',h.t.fromClient(legacy).equals(legacy));
 const write=frame({jsonrpc:'2.0',id:778,method:'turn/start',params:{threadId:query.threadId,input:[{type:'text',text:'isolated bytes only'}]}});
 check('unrelated operation frames stay unchanged and never enter history retry logic',h.t.fromClient(write).equals(write));
 const collision=request(h),serverQuestion=frame({jsonrpc:'2.0',id:collision.upstream.id,method:'item/tool/requestUserInput',params:{safe:true}},false);
 check('server request IDs share a separate namespace and cannot consume a history response',h.t.fromUpstream(serverQuestion).equals(serverQuestion)&&h.t.stats().pending===1);
 const questionAnswer=frame({jsonrpc:'2.0',id:collision.upstream.id,result:{safe:true}});
 check('the phone answer to a same-ID server request passes through unchanged',h.t.fromClient(questionAnswer).equals(questionAnswer));reply(h,collision);
 const limit=transport({limits:{pending:1}}),held=request(limit),excess=request(limit);
 check('outstanding history reads are bounded without forwarding excess requests',held.wire.length>0&&!excess.wire.length&&message(limit.local.pop()).error.code===-32070);reply(limit,held);
 const expire=transport({limits:{pendingMs:10}}),late=request(expire);await pause(25);
 check('expired reads release their pending state and return an explicit error',expire.t.stats().pending===0&&message(expire.local.pop()).error.code===-32070);
 check('a late expired reply never leaks its full raw content to the phone',expire.t.fromUpstream(frame({jsonrpc:'2.0',id:late.upstream.id,result},false)).length===0&&expire.t.stats().orphaned===1);
 const split=transport({},false),head=upgrade.length-3;
 check('partial upstream upgrade produces no premature application output',split.t.fromUpstream(upgrade.subarray(0,head)).length===0);
 check('the exact complete upstream upgrade is retained byte for byte',split.t.fromUpstream(upgrade.subarray(head)).equals(upgrade));
 const fragmented=transport(),badFrame=frame({jsonrpc:'2.0',id:99,method:METHOD,params:first.params});badFrame[0]&=0x7f;
 check('fragmented plaintext application frames fail closed without an upstream prefix',fragmented.t.fromClient(badFrame).length===0&&fragmented.t.stats().closed);
 const secret=crypto.randomBytes(24).toString('base64url'),keys=e2ee.deriveKeys(secret,e2ee.slotAt());
 const secure=transport(),secureMessage={jsonrpc:'2.0',id:800,method:METHOD,params:first.params};
 const encrypted=wsf.buildFrame(wsf.OP_BIN,e2ee.encrypt(keys.a,Buffer.from(JSON.stringify(secureMessage))),true),upCrypto=new WsCrypto(secret,'decrypt');
 const secureForward=secure.t.fromEncryptedClient(encrypted,b=>upCrypto.push(b)),secureUp=message(secureForward);
 check('actual authenticated AES input forwards only the exact official history read',secureUp.method==='thread/items/list'&&JSON.stringify(secureUp.params)===JSON.stringify(query));
 const down=secure.t.fromUpstream(frame({jsonrpc:'2.0',id:secureUp.id,result},false)),cipher=new WsCrypto(secret,'encrypt').push(down);
 const cipherFrame=wsf.parseFrames(cipher).frames[0],plainEnvelope=e2ee.decrypt(keys.b,cipherFrame.payload);
 check('compression remains inside the unchanged authenticated binary AES envelope',cipherFrame.opcode===wsf.OP_BIN&&!!plainEnvelope&&JSON.parse(plainEnvelope).result.encoding==='gzip'&&!cipher.includes(Buffer.from('authored whitespace')));
 const tamper=transport(),badCipher=Buffer.from(e2ee.encrypt(keys.a,Buffer.from(JSON.stringify(secureMessage))));badCipher[13]^=1;const rejectCrypto=new WsCrypto(secret,'decrypt');
 check('an invalid AES tag cannot negotiate a history read',tamper.t.fromEncryptedClient(wsf.buildFrame(wsf.OP_BIN,badCipher,true),b=>rejectCrypto.push(b)).length===0&&tamper.t.stats().rewritten===0&&rejectCrypto.rejected===1);
 for(const mode of ['fragment','rsv','unmasked']){const invalid=transport(),f=Buffer.from(encrypted);if(mode==='fragment')f[0]&=0x7f;if(mode==='rsv')f[0]|=0x40;if(mode==='unmasked')f[1]&=0x7f;
  let decryptCalls=0;const out=invalid.t.fromEncryptedClient(f,b=>{decryptCalls++;return upCrypto.push(b);});
  check('original encrypted '+mode+' framing is refused before AES normalization',!out.length&&invalid.t.stats().closed&&decryptCalls===0);
 }
 const c=client(),loaded=await c.read();
 check('native gzip client decoding retains every original result field and Unicode byte',JSON.stringify(loaded)===JSON.stringify(result)&&c.calls.length===1&&c.calls[0].method===METHOD);
 const cached=await c.read();
 check('authenticated unchanged reply restores the complete exact cached page',JSON.stringify(cached)===JSON.stringify(result)&&c.calls[1].params.revision&&c.h.t.stats().unchanged===1);
 const changedClient=clone(result);changedClient.data[5].item.text='new reply';c.scenario.value=changedClient;
 check('changed active history replaces the exact page cache without losing intermediate rows',JSON.stringify(await c.read())===JSON.stringify(changedClient));
 await c.read({...query,cursor:'page-b'});
 check('different page scopes do not reuse a revision even on the same socket',!c.calls.at(-1).params.revision&&c.box.state.historyTransport.order.length===2);
 c.box.state.ws={readyState:1};await c.read();
 check('socket replacement clears previous page revisions before the next request',!c.calls.at(-1).params.revision&&c.box.state.historyTransport.order.length===1);
 const old=client({error:-32601});const originalRaw=old.box.callRaw;
 old.box.callRaw=function(method,params){if(method!==METHOD){old.calls.push({method,params});return Promise.resolve(clone(result));}return originalRaw(method,params);};
 await old.read();await old.read();
 check('only exact unsupported custom method falls back once then disables negotiation per socket',old.calls.map(v=>v.method).join(',')===METHOD+',thread/items/list,thread/items/list');
 const denied=client({error:-32603});await assert.rejects(denied.read());
 check('a real RPC failure never silently falls back or retries another operation',denied.calls.length===1);
 const wrongError=client({error:-32601,errorMethod:'turn/start'});await assert.rejects(wrongError.read());
 check('an unrelated method error cannot activate the history fallback',wrongError.calls.length===1);
 const deliberate=client({error:-32071});await assert.rejects(deliberate.read(),e=>e.code===-32071);
 check('oversize history exposes an actionable error without an automatic second read',deliberate.calls.length===1);
 deliberate.scenario.error=null;await deliberate.read(query,true);
 check('a deliberate legacy full-page request uses exactly the original history method and scope',deliberate.calls.at(-1).method==='thread/items/list'&&JSON.stringify(deliberate.calls.at(-1).params)===JSON.stringify(query));
 const noGzip=client();noGzip.box.window.DecompressionStream=undefined;await noGzip.read();
 check('missing browser gzip support negotiates identity without a parser error',noGzip.calls[0].params.acceptEncoding.length===0);
 const badConstructor=client();badConstructor.box.window.DecompressionStream=function(){throw Error('unsupported gzip');};await badConstructor.read();
 check('a present constructor that rejects gzip safely negotiates identity',badConstructor.calls[0].params.acceptEncoding.length===0);
 const local=client();local.box.window.__dshE2eeOn=false;await local.read();
 check('plaintext local mode retains the original history protocol and sends no revision',local.calls[0].method==='thread/items/list');
 const nonHistory=client({error:-32601});await assert.rejects(nonHistory.box.call('turn/start',{threadId:query.threadId},30000));
 check('send and writer methods never negotiate or retry through this extension',nonHistory.calls.length===1&&nonHistory.calls[0].method==='turn/start');
 for(const [name,modify]of [
  ['wrong nonce',env=>({...env,nonce:'0'.repeat(32)})],
  ['wrong thread scope',env=>({...env,scope:{...env.scope,threadId:'other-thread'}})],
  ['wrong page scope',env=>({...env,scope:{...env.scope,cursor:'other-page'}})],
  ['extra ambiguous envelope field',env=>({...env,value:{data:[]}})],
  ['invalid base64',env=>({...env,body:'not*base64'})],
  ['wrong decoded byte count',env=>({...env,decodedBytes:env.decodedBytes-1})],
  ['declared decompression overflow',env=>({...env,decodedBytes:LIMITS.resultBytes+1})],
  ['gzip expansion beyond declared size',env=>({...env,decodedBytes:10})],
  ['truncated gzip',env=>({...env,body:Buffer.from(env.body,'base64').subarray(0,20).toString('base64')})]
 ]){const invalid=client({modify});await assert.rejects(invalid.read());check(name+' is refused without cached content or a legacy retry',invalid.calls.length===1&&invalid.box.state.historyTransport.bytes===0);}
 const lost=client();await lost.read();lost.scenario.modify=(env,req)=>{lost.box.forgetHistoryWirePage(lost.box.state.historyTransport,JSON.stringify(scopeOf(req.query)));return env;};
 await assert.rejects(lost.read());check('unchanged without the matching complete cache entry refuses instead of showing a false empty chat',lost.calls.length===2&&lost.box.state.historyTransport.bytes===0);
 const stale=client(),context=stale.box.historyWireContext(stale.ws),decode=stale.box.decodeHistoryWire(env,first.params,context,JSON.stringify(scopeOf(query)));
 stale.box.state.ws={readyState:1};await assert.rejects(decode);
 check('a socket changed during asynchronous gzip decoding cannot populate current history',context.bytes===0);
 const bounded=client({value:{data:[{item:{id:'bounded',type:'agentMessage',text:'small'}}],nextCursor:null}});
 for(let n=0;n<6;n++)await bounded.read({...query,cursor:'bounded-'+n});
 check('per-socket page cache evicts older entries at four complete pages',bounded.box.state.historyTransport.order.length===4&&Object.keys(bounded.box.state.historyTransport.pages).length===4);
 const cacheContext=bounded.box.state.historyTransport;
 bounded.box.cacheHistoryWirePage(cacheContext,'large-a','a'.repeat(64),'one',LIMITS.resultBytes-10);
 bounded.box.cacheHistoryWirePage(cacheContext,'large-b','b'.repeat(64),'two',20);
 check('per-socket cache enforces its total eight-megabyte byte budget',cacheContext.bytes<=LIMITS.resultBytes&&cacheContext.order.length===1&&cacheContext.order[0]==='large-b');
 const mutation=client();const value=await mutation.read();value.data[0].item.aggregatedOutput='renderer-side mutation';
 check('cache stores exact immutable JSON rather than renderer-mutated item references',JSON.stringify(await mutation.read())===JSON.stringify(result));
 const retryCalls=[],olderState={olderLoadFailed:true,loadingOlder:false,noMore:false,olderCursor:'cursor-a',view:'thread',thread:{id:'thread-a'},ws:{readyState:1}};
 const olderBox={state:olderState,observerEpoch:1,document:{getElementById:()=>null},Promise,PAGE_SIZE:30,t:text=>text,
  $:()=>({scrollHeight:100,scrollTop:0}),firstVisibleBlock:()=>null,prependOlderHint(){},
  call(method,params,timeout,legacy){retryCalls.push({method,params,timeout,legacy});return Promise.resolve({data:[],nextCursor:null});}};
 vm.createContext(olderBox);vm.runInContext(extractFunction(source,'loadOlder'),olderBox);
 olderBox.loadOlder();check('scrolling a failed older page cannot replace its full-page button or silently retry it',retryCalls.length===0&&olderState.olderLoadFailed===true);
 olderBox.loadOlder(true,true);await pause(0);
 check('explicit older full-page retry forwards only the exact original cursor and clears the failed state',retryCalls.length===1&&retryCalls[0].params.cursor==='cursor-a'&&retryCalls[0].legacy===true&&olderState.loadingOlder===false&&olderState.olderLoadFailed===false);
 check('oversize full-page action is deliberately exposed for initial and older history errors',source.includes("loadInitialThreadHistory(thread,true)")&&source.includes("loadOlder(true,true)")&&source.includes("id=\"history-full-page\""));
 check('completed observer and original history pagination still call the official method contract',extractFunction(source,'refreshObservedThread').includes("read('thread/items/list'")&&extractFunction(source,'loadOlder').includes("call('thread/items/list'"));
 console.log(passed+' isolated history transport checks passed');
}finally{for(const t of contexts)t.close();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
