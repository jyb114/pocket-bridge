'use strict';
const assert=require('assert/strict'),http=require('http'),fs=require('fs/promises'),os=require('os'),path=require('path');
const {createUploadHandler,safeName}=require('./codex-uploads.js');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-upload-test-'));
 const server=http.createServer(createUploadHandler(dir,{maxBytes:1024}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const send=(name,body,headers={})=>fetch(base+'/codex/upload?name='+encodeURIComponent(name),{method:'POST',headers:{'x-dsh-upload':'1',...headers},body});
 try{
  const a=await send('测试文件.txt',Buffer.from('附件内容'));assert.equal(a.status,201);const file=await a.json();assert.equal(file.name,'测试文件.txt');assert.equal(await fs.readFile(file.path,'utf8'),'附件内容');
  const b=await send('../../测试文件.txt',Buffer.from('第二份'));const other=await b.json();assert.notEqual(other.path,file.path);assert.equal(path.dirname(path.dirname(other.path)),dir);assert.equal(other.name,'测试文件.txt');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXsQAAAAASUVORK5CYII=','base64');
  const image=await (await send('照片.png',png)).json();assert.equal(image.kind,'image');assert.deepEqual(await fs.readFile(image.path),png);
  assert.equal((await send('large.bin',Buffer.alloc(1025))).status,413);
  assert.equal((await send('empty.txt',Buffer.alloc(0))).status,400);
  assert.equal((await send('bad.txt','x',{'x-dsh-upload':'0'})).status,403);
  assert.equal((await send('bad.txt','x',{origin:'https://unrelated.example'})).status,403);
  assert.equal((await fetch(base+'/codex/upload')).status,405);
  assert.equal(safeName('C:\\windows\\CON.txt'),'_CON.txt');
  console.log('PASS 10 upload checks: image/text bytes, unicode, traversal, collision, size, empty file, origin, header, method');
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
