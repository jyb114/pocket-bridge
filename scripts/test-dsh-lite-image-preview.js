'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const api = require('./dsh-lite-image-preview');
const { inspectRaster } = require('./dsh-lite-attachment');
const parent = path.resolve(process.env.BRIDGE_IMAGE_TEST_ROOT || 'D:/bridge-dsh-image-preview-test-temp');
const scratch = path.join(parent, crypto.randomUUID());
const workspace = path.join(scratch, 'workspace'), other = path.join(scratch, 'outside'), logDir = path.join(scratch, 'logs');
for (const directory of [workspace, other, logDir]) fs.mkdirSync(directory, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=', 'base64');
// Bounded JPEG SOF fixture for transport-only tests; actual codec tested below.
const jpeg = Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1,255,217]);
const safe = path.join(workspace, 'safe.png'), external = path.join(other, 'outside.png');
fs.writeFileSync(safe, png); fs.writeFileSync(external, png);
const instanceId = '11111111-1111-4111-8111-111111111111';
const sessionId = 'fixture-session';
let at = 1800000000000, checks = 0;
const rootFor = id => id === sessionId ? workspace : null;
const options = { instanceId, logDir, workspaceRootFor: rootFor, now: () => at,
  thumbnailRenderer: async () => ({ data: jpeg, type: 'image/jpeg' }) };
const handler = api.createDshLiteImagePreview(options);
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
async function send(input = { sessionId, path: safe, variant: 'original' }, extra = {}) {
  const bytes = Buffer.from(extra.raw ?? JSON.stringify(input));
  const req = Readable.from([bytes]);
  req.method = extra.method || 'POST'; req.url = extra.url || '/__dsh/lite-image-preview';
  req.__dshE2eeDecrypted = extra.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': extra.encrypted === false ? '0' : '1', 'content-type': extra.contentType || 'application/json', 'content-length': String(bytes.length) };
  const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = body => { res.body = body; res.writableEnded = true; };
  await (extra.handler || handler)(req, res);
  return { status: res.status, headers: res.headers, body: res.body, json: Buffer.isBuffer(res.body) ? null : JSON.parse(res.body) };
}
function approve(extra = {}) { return api.approveImage({ ...options, sessionId, filePath: external, ...extra }); }
const registry = path.join(logDir, 'image-preview-grants.json');
function mockSpawn({ data = jpeg, code = 0, hold = false } = {}) {
  const calls = [];
  const spawn = (...args) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1)); };
    calls.push({ args, child });
    child.stdin.resume();
    child.stdin.once('finish', () => { if (!hold) setImmediate(() => { if (data) child.stdout.write(data); child.stdout.end(); child.emit('close', code); }); });
    return child;
  };
  return { spawn, calls };
}

(async () => {
 try {
  await check('workspace original returns exact bounded raster with protected headers', async () => { const result = await send(); assert.equal(result.status, 200); assert.deepEqual(result.body, png); assert.equal(result.headers['content-type'], 'image/png'); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff'); });
  await check('thumbnail uses JPEG transformer; original does not convert', async () => { let conversions = 0; const h = api.createDshLiteImagePreview({ ...options, thumbnailRenderer: async () => { conversions++; return { data: jpeg, type: 'image/jpeg' }; } }); assert.equal((await send({ sessionId, path: safe, variant: 'original' }, { handler: h })).status, 200); assert.equal(conversions, 0); const result = await send({ sessionId, path: safe, variant: 'thumbnail' }, { handler: h }); assert.equal(result.status, 200); assert.equal(result.headers['content-type'], 'image/jpeg'); assert.equal(conversions, 1); });
  await check('method, plaintext, query and invalid schema never read a file', async () => {
   for (const [extra, expected] of [[{ method: 'GET' },405],[{ encrypted:false },403],[{ decrypted:false },403],[{ contentType:'text/plain' },415],[{ url:'/__dsh/lite-image-preview?path=secret' },400],[{ raw:'{bad' },400]]) assert.equal((await send(undefined, extra)).status, expected);
   for(const input of [null,[],{}, {sessionId,path:safe,variant:'auto'}, {sessionId,path:safe,variant:'original',grant:true},{sessionId:'bad\n',path:safe,variant:'original'}])assert.equal((await send(input)).status,400);
  });
  await check('wrong session fails before arbitrary file access', async () => assert.equal((await send({sessionId:'other',path:safe,variant:'original'})).status,404));
  await check('aborted metadata stream releases its request slot', async () => {const make=()=>{const req=new PassThrough();req.method='POST';req.url='/__dsh/lite-image-preview';req.__dshE2eeDecrypted=true;req.headers={'x-dsh-e2ee':'1','content-type':'application/json'};const res=new EventEmitter();res.writeHead=status=>{res.status=status;};res.end=()=>{res.writableEnded=true;};return{req,res};};const a=make(),b=make();const first=handler(a.req,a.res),second=handler(b.req,b.res);assert.equal((await send()).status,429);a.req.emit('aborted');await first;assert.equal(a.res.status,499);assert.equal((await send()).status,200);b.req.emit('aborted');await second;a.req.destroy();b.req.destroy();});
  await check('outside project is denied without local approval', async () => { const result=await send({sessionId,path:external,variant:'original'});assert.equal(result.status,403);assert.equal(result.json.error,'image-local-approval-required');assert.equal(fs.existsSync(registry),false); });
  await check('instance identity can be resolved after factory construction', async () => {let id=null;const h=api.createDshLiteImagePreview({...options,instanceId:()=>id});assert.equal((await send(undefined,{handler:h})).status,503);id=instanceId;assert.equal((await send(undefined,{handler:h})).status,200);});
  await check('strict local approval grants exactly the named image only', async () => {const grant=approve();assert.equal(grant.approved,true);assert.equal((await send({sessionId,path:external,variant:'original'})).status,200);const second=path.join(other,'second.png');fs.writeFileSync(second,png);assert.equal((await send({sessionId,path:second,variant:'original'})).status,403);});
  await check('approval binds exact session workspace and gateway instance', async () => {const alternate=api.createDshLiteImagePreview({...options,instanceId:'22222222-2222-4222-8222-222222222222'});assert.equal((await send({sessionId,path:external,variant:'original'},{handler:alternate})).status,403);const moved=api.createDshLiteImagePreview({...options,workspaceRootFor:id=>id===sessionId?other:null});assert.equal((await send({sessionId,path:external,variant:'original'},{handler:moved})).status,200,'file inside newly selected workspace needs no external grant');const wrongRoot=path.join(scratch,'different-root');fs.mkdirSync(wrongRoot);const scoped=api.createDshLiteImagePreview({...options,workspaceRootFor:()=>wrongRoot});assert.equal((await send({sessionId,path:external,variant:'original'},{handler:scoped})).status,403);});
  await check('file replacement invalidates exact hash and identity approval', async () => {fs.writeFileSync(external,Buffer.concat([png,Buffer.from('changed')]));assert.equal((await send({sessionId,path:external,variant:'original'})).status,403);fs.writeFileSync(external,png);approve();});
  await check('unsigned registry modification is rejected', async () => {const before=fs.readFileSync(registry);const changed=JSON.parse(before);changed.entries[0].expiresAt+=1000;fs.writeFileSync(registry,JSON.stringify(changed));assert.equal((await send({sessionId,path:external,variant:'original'})).status,403);fs.writeFileSync(registry,before);});
  await check('expired and revoked approvals do not authorize cached images', async () => {at+=api.MAX_GRANT_MS+1;assert.equal((await send({sessionId,path:external,variant:'thumbnail'})).status,403);approve();assert.equal((await send({sessionId,path:external,variant:'thumbnail'})).status,200);approve({revoke:true});assert.equal((await send({sessionId,path:external,variant:'thumbnail'})).status,403);approve();});
  await check('revocation while thumbnail is pending fails closed at response', async () => {let finish;const h=api.createDshLiteImagePreview({...options,thumbnailRenderer:()=>new Promise(resolve=>{finish=resolve;})});const pending=send({sessionId,path:external,variant:'thumbnail'},{handler:h});while(!finish)await new Promise(resolve=>setImmediate(resolve));approve({revoke:true});finish({data:jpeg,type:'image/jpeg'});assert.equal((await pending).status,403);approve();});
  await check('concurrent approval cannot resurrect a successfully revoked grant', async () => {let attempted=false;const io=Object.create(fs);io.renameSync=(source,target)=>{if(target===registry&&!attempted){attempted=true;assert.throws(()=>approve({revoke:true}),error=>error.code==='image-approval-busy');}return fs.renameSync(source,target);};approve({fs:io});assert.equal(attempted,true);approve({revoke:true});assert.equal((await send({sessionId,path:external,variant:'original'})).status,403);approve();assert.equal(fs.existsSync(path.join(logDir,'image-preview-grants.lock')),false);});
  await check('overlarge and nonraster workspace files are never previewed', async () => {const text=path.join(workspace,'fake.png');fs.writeFileSync(text,'not an image');assert.equal((await send({sessionId,path:text,variant:'original'})).status,415);const large=path.join(workspace,'large.png');fs.writeFileSync(large,Buffer.alloc(api.MAX_IMAGE_BYTES+1));assert.equal((await send({sessionId,path:large,variant:'original'})).status,413);});
  await check('junction escape cannot inherit workspace authorization', async () => {const junction=path.join(workspace,'jump');fs.symlinkSync(other,junction,'junction');assert.equal((await send({sessionId,path:path.join(junction,'second.png'),variant:'original'})).status,403);});
  await check('descriptor/path identity mismatch is rejected before returning bytes', async () => {const io=Object.create(fs);let reads=0;io.readSync=(fd,...args)=>{const value=fs.readSync(fd,...args);if(!reads++)fs.writeFileSync(safe,Buffer.concat([png,Buffer.from('race')]));return value;};const h=api.createDshLiteImagePreview({...options,fs:io});assert.equal((await send(undefined,{handler:h})).status,409);fs.writeFileSync(safe,png);});
  await check('changed workspace while native conversion is pending fails closed', async () => {let finish,root=workspace;const h=api.createDshLiteImagePreview({...options,workspaceRootFor:()=>root,thumbnailRenderer:()=>new Promise(resolve=>{finish=resolve;})});const pending=send({sessionId,path:safe,variant:'thumbnail'},{handler:h});while(!finish)await new Promise(resolve=>setImmediate(resolve));root=other;finish({data:jpeg,type:'image/jpeg'});assert.equal((await pending).status,409);});
  await check('non-Windows thumbnail returns explicit manual-original fallback', async () => {const render=api.createThumbnailRenderer({platform:'linux'});await assert.rejects(render({data:png,type:'image/png'}),error=>error.code==='image-thumbnail-unsupported'&&error.status===501);const h=api.createDshLiteImagePreview({...options,thumbnailRenderer:render});assert.equal((await send({sessionId,path:safe,variant:'thumbnail'},{handler:h})).status,501);assert.equal((await send()).status,200);});
  await check('renderer stdout is bounded and non-image success is refused', async () => {for(const data of [Buffer.alloc(api.MAX_THUMBNAIL_BYTES+1),Buffer.from('not jpeg')]){const fake=mockSpawn({data});const render=api.createThumbnailRenderer({spawn:fake.spawn,platform:'win32',tempDir:path.join(scratch,'temp')});await assert.rejects(render({data:png,type:'image/png'}));assert.equal(fake.calls[0].args[2].shell,false);assert.equal(fake.calls[0].args[2].windowsHide,true);}});
  await check('renderer cancellation and timeout stop only their owned child', async () => {for(const mode of ['abort','timeout']){const fake=mockSpawn({hold:true});const render=api.createThumbnailRenderer({spawn:fake.spawn,platform:'win32',tempDir:path.join(scratch,'temp'),timeoutMs:50});const controller=new AbortController();const pending=render({data:png,type:'image/png'},{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));if(mode==='abort')controller.abort();await assert.rejects(pending,error=>error.code===(mode==='abort'?'image-preview-aborted':'image-thumbnail-timeout'));assert.equal(fake.calls[0].child.killed,true);await new Promise(resolve=>setImmediate(resolve));}});
  await check('native queue abort never cancels another active conversion', async () => {const fake=mockSpawn({hold:true});const render=api.createThumbnailRenderer({spawn:fake.spawn,platform:'win32',tempDir:path.join(scratch,'temp')});const first=new AbortController(),second=new AbortController();const pending=render({data:png,type:'image/png'},{signal:first.signal});await new Promise(resolve=>setImmediate(resolve));const queued=render({data:png,type:'image/png'},{signal:second.signal});assert.equal(fake.calls.length,1);second.abort();await assert.rejects(queued,error=>error.code==='image-preview-aborted');assert.equal(fake.calls[0].child.killed,undefined);first.abort();await assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));});
  await check('queue time counts toward timeout without spawning a second child', async () => {const fake=mockSpawn({hold:true});const busy=api.createThumbnailRenderer({spawn:fake.spawn,platform:'win32',tempDir:path.join(scratch,'temp'),timeoutMs:100});const queued=api.createThumbnailRenderer({spawn:fake.spawn,platform:'win32',tempDir:path.join(scratch,'temp'),timeoutMs:20});const first=busy({data:png,type:'image/png'});await assert.rejects(queued({data:png,type:'image/png'}),error=>error.code==='image-thumbnail-timeout');assert.equal(fake.calls.length,1);await assert.rejects(first,error=>error.code==='image-thumbnail-timeout');await new Promise(resolve=>setImmediate(resolve));});
  await check('serial native conversions and memory cache stay bounded', async () => {const ready=mockSpawn();const cached=api.createThumbnailRenderer({spawn:ready.spawn,platform:'win32',tempDir:path.join(scratch,'temp')});await Promise.all([cached({data:png,type:'image/png'}),cached({data:png,type:'image/png'})]);assert.equal(ready.calls.length,2);await cached({data:png,type:'image/png'});assert.equal(ready.calls.length,2);});
  await check('local CLI requires explicit approval and exact session mapping', async () => {const base=path.join(scratch,'installation'),home=path.join(scratch,'dsh-home');fs.mkdirSync(path.join(base,'logs'),{recursive:true});fs.mkdirSync(path.join(home,'storages'),{recursive:true});fs.writeFileSync(path.join(base,'logs','instance.json'),JSON.stringify({instanceId}));fs.writeFileSync(path.join(home,'storages','workspace.json'),JSON.stringify({tables:{workspaces:{w:{path:workspace,sessionIds:[sessionId]}}}}));const cli=path.join(__dirname,'approve-dsh-image.js');assert.throws(()=>execFileSync(process.execPath,[cli,'--base',base,'--session',sessionId,'--file',external],{stdio:'pipe'}));const result=JSON.parse(execFileSync(process.execPath,[cli,'--base',base,'--session',sessionId,'--file',external,'--dsh-home',home,'--approve'],{windowsHide:true}).toString());assert.equal(result.approved,true);assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes(external),false);});
  console.log('DSH raster preview: '+checks+' isolated authorization/thumbnail checks passed; no production files, approvals or services touched.');
 } finally {
  const owned=path.resolve(scratch);
  if(owned.startsWith(parent+path.sep)&&path.dirname(owned)===parent)fs.rmSync(owned,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
