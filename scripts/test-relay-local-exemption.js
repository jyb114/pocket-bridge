'use strict';
// Real loopback HTTP requests exercise the production local/self-check
// predicates. No gateway instance, devices, keys or native app are mutated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'mobile-proxy.js'),'utf8');
const {extractFunction}=require('./page-source.js'),requestOrigin=require('./request-origin.js'),cfg=require('./config.js');
const context={requestOrigin,isOwnAddress:req=>cfg.isOwnAddress(null,req)};vm.createContext(context);
vm.runInContext(extractFunction(source,'isLocalRequest')+'\n'+extractFunction(source,'isSelfCheck'),context);
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({local:context.isLocalRequest(req),selfCheck:context.isSelfCheck(req)}));});
let checks=0;
async function request(headers) {
  return new Promise((resolve, reject) => {
    const q = http.get({hostname:'127.0.0.1',port:server.address().port,path:'/',headers}, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (cause) { reject(cause); } });
    });
    q.on('error', reject);
  });
}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const host='127.0.0.1:'+server.address().port;
 assert.deepEqual(await request({host,'x-dsh-selfcheck':'1'}),{local:true,selfCheck:true});checks++;
 for(const headers of [
  {host:'remote-phone.invalid'},
  {host,'cf-connecting-ip':'203.0.113.77'},
  {host,'cf-ray':'owned-relay-test'},
  {host,'cf-worker':'owned-relay-test'},
  {host,'x-forwarded-for':'203.0.113.77'},
  {host,'x-forwarded-host':'remote-phone.invalid'},
  {host,forwarded:'for=203.0.113.77;host=remote-phone.invalid'},
  {host:'localhost:'+server.address().port,'cf-connecting-ip':'203.0.113.77'}
 ]){assert.deepEqual(await request({...headers,'x-dsh-selfcheck':'1'}),{local:false,selfCheck:false});checks++;}
 console.log(checks+' production local-exemption HTTP boundary checks passed; no native/device action.');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
