'use strict';
require('./replay-isolated-fixture.js').install();

// Current DSH upload contract through real gateway entry/AES functions and an
// owned HTTP server. Upstream receipts/bytes are synthetic; no app or disk I/O.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto'),vm=require('node:vm'),{Readable}=require('node:stream');
const {extractFunction}=require('./page-source.js'),e2ee=require('./e2ee.js'),origin=require('./request-origin.js');
const {createDshLiteUpload,MAX_UPLOAD_BYTES}=require('./dsh-lite-upload.js');
const source=fs.readFileSync(path.join(__dirname,'mobile-proxy.js'),'utf8');
const SECRET='isolated-upload-secret-0123456789',LOGIN='isolated-upload-login';
let checks=0,proved=true;const calls=[];
const box=vm.createContext({Buffer,URL,Readable,crypto,path,e2ee,setTimeout,
 privateHttpsAdmission:require('./private-https-admission.js'),cfg:{loadConfig:()=>({privateHttps:{enabled:false,origin:''}})},
 retiredTargets:require('./retired-targets.js'),MAX_E2EE_BODY:64*1024*1024,
 e2eeBridge:{readSecret:()=>SECRET},isLocalRequest:origin.isLoopback,viaRelay:origin.viaRelay,
 isSelfCheck:()=>false,isSelfClientRequest:()=>false,COOKIE_NAME:'fixture-legacy-login',COOKIE_VALUE:LOGIN,
 GATEWAY_AUTH_COOKIE:'fixture-login',DEVICE_COOKIE:'fixture-device',LEGACY_DEVICE_COOKIE:'fixture-legacy-device',ACCESS_KEY:'fixture-access',
 routes:{clientIpOf:req=>req.socket.remoteAddress},sessions:{verify:t=>t==='valid-device'?{ok:true,device:{id:'synthetic',label:'Fixture'}}:{ok:false,reason:'revoked'}},
 authProvenAt:()=>proved,authObserved:new Set(),proofWaitHits:new Map(),proofBootWindowOpen:()=>false,proofLooksInProgress:()=>false,
 PROOF_WAIT_FULL_MS:100,PROOF_WAIT_MS:100,PROOF_WAIT_MAX_PER_DEVICE:1,PWA_ROUTES:{},dshLazyImageStore:{imageDigestFromPath:()=>null},
 E2EE_CONTENT_PATHS:new Set(['/__dsh/lite-upload']),handleConsole:()=>false,isBootstrapRequest:()=>false,
 pageLanguage:()=> 'en',pageText:()=>({errors:{noKey:'Authentication required: '}}),deviceErrorPage:()=> 'Device authentication failed.',
 pickLang:()=> 'en',PLAINTEXT_REFUSED:{en:{head:'Encrypted request required',body:'',how:''}},log(){}
});
const names=['readNamedCookie','readDeviceToken','hasLegacyAuthCookie','safeEqualStr','hasAuthCookie','keyMatches',
 'installCookieMerger','migrateLegacyRequestCookies','ensureDevice','rejectNeedProof','e2eeSecretOrNull',
 'refuseEncryptionUnavailable','refusePlaintext','clientWantsE2ee','wrapEncryptedResponse','e2eeWrap','handleRequest','handleRequestInner'];
vm.runInContext(names.map(name=>{
 if(name==='ensureDevice'){const at=source.indexOf('function ensureDevice('),open=source.indexOf(') {',at)+2;
  return source.slice(at,open)+extractFunction('function body() '+source.slice(open),'body').replace('function body() ','');}
 const code=extractFunction(source,name);assert(code,name);return code;
}).join('\n'),box);
box.serveDshLiteUploadE2ee=box.e2eeWrap(createDshLiteUpload({callUpstream:async call=>{
 const u=new URL(call.path,'http://localhost');assert.equal(u.pathname,'/api/session/uploadFileBinary');assert.equal(call.method,'POST');
 assert.deepEqual([...u.searchParams.keys()],['sessionId','name']);assert.equal(call.headers['content-type'],'application/octet-stream');
 assert.equal(call.headers['content-length'],String(call.body.length));assert.equal(call.headers['accept-encoding'],'identity');
 calls.push({sessionId:u.searchParams.get('sessionId'),name:u.searchParams.get('name'),body:Buffer.from(call.body),path:call.path});
 return {statusCode:200,body:JSON.stringify({ok:true,value:{receiptId:'receipt-'+calls.length,
  file:{attachmentId:'attachment-'+calls.length,name:u.searchParams.get('name'),bytes:call.body.length}}})};
}}));
const server=http.createServer((req,res)=>{try{box.handleRequest(req,res);}catch(error){res.writeHead(500);res.end('Isolated entry failed.');console.error(error);}});
function packet(name,bytes,sessionId='synthetic-session'){
 const meta=Buffer.from(JSON.stringify({sessionId,name})),count=Buffer.alloc(4);count.writeUInt32BE(meta.length);
 return Buffer.concat([count,meta,Buffer.from(bytes)]);
}
async function send(name,bytes,options={}){
 const body=options.body===undefined?packet(name,bytes,options.sessionId):options.body;
 const wire=options.wire|| (options.plain?body:e2ee.encrypt(e2ee.deriveKeys(SECRET,e2ee.slotAt()).a,body));
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:options.url||'/__dsh/lite-upload',method:options.method||'POST',headers:{
   host:'public.fixture.invalid',cookie:`fixture-login=${LOGIN}; fixture-device=valid-device`,accept:'application/json',
   'content-type':'application/octet-stream','content-length':wire.length,'x-dsh-e2ee':'1','x-dsh-e2ee-type':'application/octet-stream',...options.headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
    const raw=Buffer.concat(chunks);let opened=raw;
    if(res.headers['x-dsh-e2ee']==='1'){opened=e2ee.candidateKeys(SECRET).map(k=>e2ee.decrypt(k.b,raw)).find(Boolean);
     assert(opened,'response is authentic AES ciphertext');assert(!raw.includes(Buffer.from('receipt-')));assert.equal(res.headers['cache-control'],'no-store');}
    let body;try{body=JSON.parse(opened.toString());}catch(_){body=opened.toString();}
    resolve({status:res.statusCode,headers:res.headers,raw,body});
   });
  });req.on('error',reject);req.setTimeout(4000,()=>req.destroy(Error('Isolated upload timed out')));req.end(wire);
 });
}
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  let first;
  await check('Unicode filename and UTF-8 bytes stay encrypted and exactly session-bound',async()=>{
   const bytes=Buffer.from('附件内容');first=await send('测试文件.txt',bytes);assert.equal(first.status,200);assert.equal(first.body.ok,true);
   assert.equal(first.body.value.file.name,'测试文件.txt');assert.equal(first.body.value.file.bytes,bytes.length);
   assert.deepEqual(calls.at(-1).body,bytes);assert.equal(calls.at(-1).sessionId,'synthetic-session');assert(!first.raw.includes(bytes));
  });
  await check('Traversal and absolute/device path names fail before upstream dispatch',async()=>{
   const before=calls.length;for(const name of ['../../测试文件.txt','C:\\windows\\CON.txt','a\\b.txt','..','.','name\u0000.txt'])
    assert.equal((await send(name,'x')).status,400);assert.equal(calls.length,before);
  });
  await check('Repeated names retain distinct official receipts without a bridge disk overwrite',async()=>{
   const second=await send('测试文件.txt',Buffer.from('第二份'));assert.equal(second.status,200);
   assert.notEqual(second.body.value.receiptId,first.body.value.receiptId);assert.notEqual(second.body.value.file.attachmentId,first.body.value.file.attachmentId);
   assert.equal(second.body.value.file.name,first.body.value.file.name);assert.deepEqual(calls.at(-1).body,Buffer.from('第二份'));
   assert.equal(Object.hasOwn(second.body.value.file,'path'),false,'official attachment metadata never creates a local storage path');
  });
  await check('PNG binary bytes reach the fixed official route without conversion',async()=>{
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXsQAAAAASUVORK5CYII=','base64');
   const r=await send('照片.png',png);assert.equal(r.status,200);assert.deepEqual(calls.at(-1).body,png);
   assert.equal(r.body.value.file.name,'照片.png');assert.equal(r.body.value.file.bytes,png.length);
  });
  await check('Actual 20 MiB file limit rejects oversized decrypted bytes',async()=>{
   const before=calls.length;assert.equal((await send('large.bin',Buffer.alloc(MAX_UPLOAD_BYTES+1))).status,413);assert.equal(calls.length,before);
  });
  await check('Empty file cannot produce an upstream receipt',async()=>{
   const before=calls.length;assert.equal((await send('empty.txt',Buffer.alloc(0))).status,400);assert.equal(calls.length,before);
  });
  await check('Missing encrypted marker or a forged marker/plain packet cannot stage bytes',async()=>{
   const before=calls.length;assert.equal((await send('bad.txt','x',{headers:{'x-dsh-e2ee':'0'}})).status,403);
   assert.equal((await send('bad.txt','x',{plain:true})).status,400);assert.equal(calls.length,before);
  });
  await check('Foreign-origin plaintext and browser preflight cannot bypass encryption/CORS',async()=>{
   const before=calls.length,foreign={origin:'https://unrelated.fixture.invalid','sec-fetch-site':'cross-site'};
   const r=await send('bad.txt','x',{plain:true,headers:{...foreign,'x-dsh-e2ee':'0'}});assert.equal(r.status,403);assert.equal(r.headers['access-control-allow-origin'],undefined);
   const pre=await send('',Buffer.alloc(0),{method:'OPTIONS',body:Buffer.alloc(0),plain:true,headers:{...foreign,'x-dsh-e2ee':'0',
    'access-control-request-method':'POST','access-control-request-headers':'x-dsh-e2ee'}});
   assert.equal(pre.status,403);assert.equal(pre.headers['access-control-allow-origin'],undefined);assert.equal(calls.length,before);
  });
  await check('GET is refused even after authentic transport decryption',async()=>{
   const before=calls.length,r=await send('',Buffer.alloc(0),{method:'GET',body:Buffer.alloc(0),plain:true});
   assert.equal(r.status,405);assert.equal(r.headers['x-dsh-e2ee'],'1');assert.equal(calls.length,before);
  });
  await check('Login, registered device and key proof remain required',async()=>{
   const before=calls.length;assert.equal((await send('a.txt','x',{headers:{cookie:''}})).status,403);
   assert.equal((await send('a.txt','x',{headers:{cookie:`fixture-login=${LOGIN}; fixture-device=revoked`}})).status,403);
   proved=false;const r=await send('a.txt','x');proved=true;assert.equal(r.status,403);assert.equal(r.headers['x-dsh-need-proof'],'1');assert.equal(calls.length,before);
  });
  await check('Proof refusal does not consume the untouched encrypted body, but post-admission replay cannot dispatch it twice',async()=>{
   const before=calls.length,wire=e2ee.encrypt(e2ee.deriveKeys(SECRET,e2ee.slotAt()).a,packet('after-proof.txt',Buffer.from('verified once')));
   proved=false;let refusal;try{refusal=await send('','',{wire});}finally{proved=true;}
   assert.equal(refusal.status,403);assert.equal(refusal.headers['x-dsh-need-proof'],'1');assert.equal(calls.length,before);
   const accepted=await send('','',{wire});assert.equal(accepted.status,200);assert.equal(calls.length,before+1);
   const repeat=await send('','',{wire});assert.equal(repeat.status,409);assert.equal(repeat.body.code,'replayed-request');
   assert.equal(repeat.body.attemptDispatched,false);assert.equal(repeat.body.originalOutcomeUnknown,true);assert.equal(calls.length,before+1);
  });
  await check('Session/name/upstream URL query parameters cannot bypass the encrypted metadata envelope',async()=>{
   const before=calls.length;for(const url of ['/__dsh/lite-upload?name=secret.txt','/__dsh/lite-upload?sessionId=other','/__dsh/lite-upload?url=https://unrelated.fixture.invalid'])
    assert.equal((await send('a.txt','x',{url})).status,400);assert.equal(calls.length,before);
  });
  await check('Reserved-looking names remain metadata and session IDs are encoded exactly once',async()=>{
   const r=await send('CON.txt','metadata only',{sessionId:'session?other=bad&slash/'});assert.equal(r.status,200);
   const last=calls.at(-1);assert.equal(last.name,'CON.txt');assert.equal(last.sessionId,'session?other=bad&slash/');
   assert(last.path.includes('sessionId=session%3Fother%3Dbad%26slash%2F'));assert.equal(new URL(last.path,'http://localhost').searchParams.size,2);
  });
  console.log(checks+' encrypted DSH upload checks passed. No production/filesystem/model action.');
 }finally{await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
