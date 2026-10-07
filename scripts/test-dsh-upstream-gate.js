// Execute the actual HTTP and WS entry functions against fake runtimes/sockets.
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),vm=require('vm'),{EventEmitter}=require('events');
const {extractFunction}=require('./page-source');const src=fs.readFileSync(path.join(__dirname,'mobile-proxy.js'),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));let checks=0;
function environment(runtime,explicit=false){let httpCount=0,wsCount=0,starts=0;
 const sock=new EventEmitter();Object.assign(sock,{destroyed:false,write(){},destroy(){this.destroyed=true;},pipe(){},end(){}});
 const response={headersSent:false,writeHead(code){this.headersSent=true;this.statusCode=code;},end(body){this.writableEnded=true;this.body=body;}};
 const box={console,Buffer,URL,privateHttpsAdmission:require('./private-https-admission.js'),cfg:{loadConfig:()=>({privateHttps:{enabled:false,origin:''}})},retiredTargets:require('./retired-targets.js'),dshPhoneSurface:require('./dsh-phone-surface.js'),isLocalRequest:require('./request-origin.js').isLoopback,Readable:require('stream').Readable,EXPLICIT_TARGET_PORT:explicit?19387:null,DSH_UPSTREAM_AUTH_OK:null,TARGET_PORT:19387,TARGET_HOST:'127.0.0.1',refreshDshRuntime:async()=>runtime,
  buildUpstreamHeaders:r=>r.headers,dshLazyImageStore:{originalModuleUrl:()=>null},http:{request(){httpCount++;const e=new EventEmitter();e.setHeader=()=>{};return e;}},net:{connect(){wsCount++;return sock;}},
  handleMissingDsh:(req,res)=>{res.end();return true;},ensureDshRunning:async()=>{starts++;return true;},serveLauncherPage:(req,res)=>res.end(),pageLanguage:()=> 'en',dshStartingPage:()=>'<starting>',log(){},markActivity(){},
  hasAuthCookie:()=>true,ensureDevice:()=>({ok:true,device:null}),e2eeSecretOrNull:()=>null,viaRelay:()=>false,e2eeBridge:{readSecret:()=>null,wanted:()=>false},setInterval:()=>({unref(){}}),clearInterval(){},setTimeout};
 vm.createContext(box);vm.runInContext(extractFunction(src,'proxyRequest'),box);vm.runInContext(extractFunction(src,'handleUpgrade'),box);
 const req={method:'GET',url:'/api/session/list',headers:{host:'localhost:19387'},socket:{remoteAddress:'127.0.0.1'},pipe(){},on(){},resume(){}};
 return {box,sock,response,req,counts:()=>({httpCount,wsCount,starts})};}
(async()=>{
 for(const value of [false,true]){const e=environment(value);e.box.proxyRequest(e.req,e.response);await flush();assert.equal(e.counts().httpCount,value?1:0);checks++;console.log('PASS HTTP '+(value?'verified upstream forwards':'rejected/reused old port never receives requests or cookies'));}
 for(const value of [false,true]){const e=environment(value);e.req.url='/api/remote.mux';e.box.handleUpgrade(e.req,e.sock,Buffer.alloc(0));await flush();assert.equal(e.counts().wsCount,value?1:0);assert.equal(e.sock.destroyed,!value);checks++;console.log('PASS WS '+(value?'verified upstream connects':'rejected/reused old port never receives WS or cookies'));}
 const explicit=environment(false,true);explicit.box.proxyRequest(explicit.req,explicit.response);assert.equal(explicit.counts().httpCount,1);checks++;console.log('PASS explicit standalone upstream retains documented override');
 for(const targetOverride of [false,true]){const remote=environment(true,targetOverride);remote.req.headers.host='phone.invalid';remote.box.proxyRequest(remote.req,remote.response);await flush();assert.equal(remote.response.statusCode,410);assert.equal(JSON.parse(remote.response.body).code,'dsh-classic-retired');assert.deepEqual(remote.counts(),{httpCount:0,wsCount:0,starts:0});checks++;console.log('PASS remote raw HTTP is retired even with a verified upstream or explicit port');}
 console.log('DSH verified upstream gates: '+checks+' isolated checks passed');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
