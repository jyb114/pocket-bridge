'use strict';
// Image receipt/security fixtures. No real model request is generated.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDshLegacyAttachments, MAX_IMAGE_BYTES, MAX_BATCH_BYTES } = require('./dsh-legacy-attachments');
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const runtime = { running:true,profile:'legacy-events',pid:123,port:19087,version:'0.1.0-rc.8' };
function packet(bytes = png, meta = {sessionId:'s1',name:'image.png',mediaType:'image/png'}) {
  const json = Buffer.from(JSON.stringify(meta)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([length,json,bytes]);
}
async function invoke(service, bytes = packet(), options = {}) {
  const req = Readable.from([bytes]);req.url = options.url || '/__dsh/legacy-upload';req.method = options.method || 'POST';
  req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = {'x-dsh-e2ee':'1','content-type':'application/octet-stream','content-length':bytes.length,...options.headers};
  const res = {writeHead(status){this.status=status;},end(value){this.body=JSON.parse(value);this.writableEnded=true;}};
  await service.handle(req,res);return res;
}
(async()=>{
  let time=1000, owner={...runtime}, root='D:/project';
  const service=createDshLegacyAttachments({now:()=>time,getRuntime:async()=>owner,workspaceRootFor:id=>id==='s1'?root:null});
  try {
    for(const options of [{method:'GET'},{decrypted:false},{headers:{'x-dsh-e2ee':'0'}},{url:'/__dsh/legacy-upload?name=secret'},
      {headers:{'content-type':'application/json'}},{headers:{'content-length':MAX_IMAGE_BYTES+4101}}])
      assert.ok((await invoke(service,packet(),options)).status>=400);
    for(const name of ['../x.png','a\\b.png','C:x.png','..'])
      assert.equal((await invoke(service,packet(png,{sessionId:'s1',name,mediaType:'image/png'}))).status,400);
    assert.equal((await invoke(service,packet(Buffer.from('<svg onload=alert(1)>')))).status,415);
    assert.equal((await invoke(service,packet(png,{sessionId:'s1',name:'image.gif',mediaType:'image/gif'}))).status,415);
    assert.equal((await invoke(service,packet(png,{sessionId:'unknown',name:'image.png',mediaType:'image/png'}))).status,404);
    let uploaded=await invoke(service);assert.equal(uploaded.status,200);
    const receipt=uploaded.body.value.receiptId;
    assert.throws(()=>service.resolveForPrompt('s2',[receipt],owner));
    assert.throws(()=>service.resolveForPrompt('s1',['unknown'],owner));
    assert.throws(()=>service.resolveForPrompt('s1',[receipt,receipt],owner));
    const staged=service.resolveForPrompt('s1',[receipt],owner);
    assert.deepEqual(staged.content,[{type:'image',mediaType:'image/png',data:png.toString('base64'),name:'image.png'}]);
    assert.throws(()=>service.resolveForPrompt('s1',[receipt],owner),'one receipt cannot be submitted concurrently');
    staged.release();
    const retried=service.resolveForPrompt('s1',[receipt],owner);
    assert.equal(retried.content.length,1,'confirmed rejection can release a receipt for retry');
    staged.commit();
    assert.throws(()=>service.resolveForPrompt('s1',[receipt],owner),'an old reservation cannot release a newer submission');
    retried.release();
    const finalLease=service.resolveForPrompt('s1',[receipt],owner);
    assert.equal(finalLease.content.length,1,'an old commit cannot consume the newly reserved image');
    finalLease.commit();assert.throws(()=>service.resolveForPrompt('s1',[receipt],owner));
    uploaded=await invoke(service);const second=uploaded.body.value.receiptId;owner={...runtime,pid:124};
    assert.throws(()=>service.resolveForPrompt('s1',[second],owner));owner={...runtime};root='D:/changed-project';
    assert.throws(()=>service.resolveForPrompt('s1',[second],owner));root='D:/project';time+=600001;
    assert.throws(()=>service.resolveForPrompt('s1',[second],owner));
    owner={...runtime,pid:null};assert.equal((await invoke(service)).status,503);owner={...runtime};
    const large=Buffer.alloc(MAX_IMAGE_BYTES);png.copy(large);const ids=[];
    for(let i=0;i<3;i++){const result=await invoke(service,packet(large));assert.equal(result.status,200);ids.push(result.body.value.receiptId);}
    assert.throws(()=>service.resolveForPrompt('s1',ids,owner),error=>error.status===413);
    assert.equal(service.resolveForPrompt('s1',ids.slice(0,2),owner).content.length,2);
    assert.equal(MAX_BATCH_BYTES,2*MAX_IMAGE_BYTES);
    console.log('Legacy image receipts: E2EE, raster fence, Session/runtime/root binding, TTL, one-use and byte limits passed');
  } finally {service.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
