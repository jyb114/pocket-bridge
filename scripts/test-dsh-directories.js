// Real filesystem/HTTP fixtures only; never enumerates a user's projects.
'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {createDirectoryService}=require('./dsh-directories');
let checks=0; function pass(name){checks++;console.log('PASS '+name);}
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-dsh-directories-'));
 let server;
 try {
  fs.mkdirSync(path.join(tmp,'项目2'));fs.mkdirSync(path.join(tmp,'项目10'));fs.writeFileSync(path.join(tmp,'private.txt'),'not-returned');
  const service=createDirectoryService({defaultPath:tmp});
  const listing=await service.list();
  assert.equal(listing.path,tmp);assert.equal(listing.parent,path.dirname(tmp));
  assert.deepEqual(listing.directories.map(d=>d.name),['项目2','项目10']);
  assert.ok(!JSON.stringify(listing).includes('private.txt'));pass('only computer directories, numeric sorting and no file names/content');
  assert.equal((await service.list({path:path.join(tmp,'项目2')})).parent,tmp);pass('enter selected folder and navigate parent');
  for(const input of [{path:'relative'},{path:23},{path:''},{path:'x\0y'}]) await assert.rejects(service.list(input),e=>e.code==='invalid-path');
  pass('reject relative, invalid, empty and NUL paths');
  await assert.rejects(service.list({path:path.join(tmp,'private.txt')}),e=>e.code==='not-a-directory');pass('cannot select a file');
  await assert.rejects(service.list({path:path.join(tmp,'missing')}),e=>e.code==='ENOENT');pass('missing directory is explicit');
  const limited=await createDirectoryService({defaultPath:tmp,maxEntries:1}).list();assert.equal(limited.directories.length,1);assert.equal(limited.truncated,true);pass('bounded directory response');
  assert.equal((await service.list({path:path.parse(tmp).root})).parent,null);pass('root has no fake parent');
  const win=createDirectoryService({platform:'win32',defaultPath:'D:\\fixture',fs:{stat:async()=>{throw Error('must-not-access')}}});
  await assert.rejects(win.list({path:'\\\\server\\share'}),e=>e.code==='invalid-path');pass('network and device paths rejected before filesystem access');
  server=http.createServer(service.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  let res=await fetch(url,{method:'POST',body:'{}'});assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal((await res.json()).path,tmp);pass('POST JSON handler works without caching');
  res=await fetch(url);assert.equal(res.status,405);pass('no GET metadata listing');
  res=await fetch(url,{method:'POST',body:'['});assert.equal(res.status,400);pass('malformed JSON rejected');
  res=await fetch(url,{method:'POST',body:'x'.repeat(8193)});assert.equal(res.status,413);pass('request body bounded');
  res=await fetch(url,{method:'POST',body:JSON.stringify({path:path.join(tmp,'missing')})});assert.equal(res.status,404);assert.equal((await res.json()).error,'ENOENT');pass('safe filesystem errors without stack or credentials');
  const proxy=fs.readFileSync(path.join(__dirname,'mobile-proxy.js'),'utf8'),client=fs.readFileSync(path.join(__dirname,'../pwa/e2ee.js'),'utf8');
  const route=proxy.indexOf("if (u.pathname === '/__dsh/directories')");assert.ok(route>proxy.indexOf('if (!hasAuthCookie(req) && !isStaticAsset)',proxy.indexOf('function handleRequestInner(')));
  const deviceCheck=proxy.indexOf('dev = ensureDevice(req, res);',proxy.indexOf('function handleRequestInner('));
  const proofCheck=proxy.indexOf('authProvenAt(dev.device.id)',deviceCheck);assert.ok(deviceCheck>0&&proofCheck>0&&route>proofCheck);
  assert.match(proxy,/const serveDshDirectoriesE2ee = e2eeWrap\(dshDirectories.handle\)/);assert.match(proxy,/E2EE_CONTENT_PATHS = new Set\(\[[\s\S]*?'\/__dsh\/directories'/);
  assert.match(client,/CONTENT_API_PATHS = \[[\s\S]*?'\/__dsh\/directories'/);pass('directory route remains behind login/proof and uses request/response encryption');
  console.log('DSH directory service: '+checks+' isolated checks passed');
 } finally {if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
