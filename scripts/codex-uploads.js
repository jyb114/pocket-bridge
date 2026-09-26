'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const MAX_BYTES=20*1024*1024;
function safeName(name) {
  let n=String(name||'file').replace(/\\/g,'/').split('/').pop().normalize('NFC')
    .replace(/[\x00-\x1f<>:"|?*]/g,'_').replace(/[. ]+$/g,'').slice(0,150);
  if(!n || /^\.+$/.test(n))n='file';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n))n='_'+n;
  return n;
}
function imageType(b) {
  if(b.length>=8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b.length>=3 && b[0]===255 && b[1]===216 && b[2]===255)return 'image/jpeg';
  if(b.length>=6 && /^GIF8[79]a$/.test(b.toString('ascii',0,6)))return 'image/gif';
  if(b.length>=12 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
function createUploadHandler(directory,{maxBytes=MAX_BYTES}={}) {
  let active=0;
  return function(req,res) {
    const json=(code,data)=>{if(!res.writableEnded){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}};
    if(req.method!=='POST'){json(405,{error:'仅支持上传请求'});return;}
    // Route is behind the gateway's existing authentication. The custom header
    // also prevents cross-origin HTML forms from creating local files.
    if(req.headers['x-dsh-upload']!=='1'){json(403,{error:'无效上传请求'});return;}
    if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host){json(403,{error:'上传来源不匹配'});return;}}catch{json(403,{error:'无效来源'});return;}}
    if(Number(req.headers['content-length'])>maxBytes){json(413,{error:'单个文件不能超过 20 MB'});req.resume();return;}
    if(active>=3){json(429,{error:'正在上传其他文件，请稍后重试'});req.resume();return;}
    const url=new URL(req.url,'http://localhost');
    const name=safeName(url.searchParams.get('name'));
    active++; let chunks=[],size=0,done=false;
    const finish=()=>{if(done)return false;done=true;active--;req.setTimeout(0);return true;};
    req.setTimeout(60000,()=>{if(finish()){chunks=[];json(408,{error:'上传超时，请重试'});req.resume();}});
    req.on('aborted',()=>{if(finish())chunks=[];});
    req.on('error',()=>{if(finish()){chunks=[];json(400,{error:'上传连接中断'});}});
    req.on('data',chunk=>{
      if(done)return;
      size+=chunk.length;
      if(size>maxBytes){finish();chunks=[];json(413,{error:'单个文件不能超过 20 MB'});return;}
      chunks.push(chunk);
    });
    req.on('end',async()=>{
      if(done)return;
      let target;
      try{
        if(!size){finish();json(400,{error:'不能上传空文件'});return;}
        const bytes=Buffer.concat(chunks);chunks=[];
        const folder=path.join(path.resolve(directory),crypto.randomUUID());
        await fs.mkdir(folder,{recursive:true});
        target=path.join(folder,name);
        await fs.writeFile(target,bytes,{flag:'wx'});
        const mime=imageType(bytes);
        finish();json(201,{name,path:target,size,kind:mime?'image':'file',mime:mime||'application/octet-stream'});
      }catch{finish();json(500,{error:'文件保存失败，请重试'});}
    });
  };
}
module.exports={createUploadHandler,safeName,imageType,MAX_BYTES};
