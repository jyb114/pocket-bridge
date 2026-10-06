'use strict';
// Configuration checks use only a disposable copy and owned random-port socket.
// No keys in this checkout, production listener or account are read or changed.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pb-config-isolated-'));let passed=0;
function check(name,fn){fn();passed++;console.log('OK '+name);}
(async()=>{try{
 fs.mkdirSync(path.join(scratch,'scripts'));fs.copyFileSync(path.join(__dirname,'config.js'),path.join(scratch,'scripts/config.js'));
 const cfg=require(path.join(scratch,'scripts/config.js'));const keys=['access-key.txt','e2ee-secret.txt','mint-cookie.json','vapid.json','push-subscriptions.json','pair-code.txt'];
 check('clean DSH config does not create retired integration defaults',()=>{const c=cfg.loadConfig();assert.equal(c.gatewayPort,8080);assert(!Object.hasOwn(c,'codex'));assert(!Object.hasOwn(c,'dot'));assert.equal(c.dshMode,'auto');assert.equal(fs.existsSync(cfg.CONFIG_FILE),false);});
 fs.writeFileSync(cfg.CONFIG_FILE,JSON.stringify({gatewayPort:19871,codex:{port:18790,legacy:true},dot:{keep:true},custom:{value:'retained'},dshMode:'web'}));
 check('DSH preference saves retain unknown and legacy nested fields',()=>{const before=cfg.loadConfig();cfg.saveConfig({...before,dshMode:'desktop'});const actual=JSON.parse(fs.readFileSync(cfg.CONFIG_FILE));assert.deepEqual(actual.codex,before.codex);assert.deepEqual(actual.dot,before.dot);assert.deepEqual(actual.custom,before.custom);assert.equal(actual.gatewayPort,19871);assert.equal(actual.dshMode,'desktop');assert.equal(fs.existsSync(cfg.CONFIG_FILE+'.tmp'),false);});
 const first=cfg.ensureInstanceIdentity();for(const k of keys)fs.writeFileSync(path.join(cfg.LOG_DIR,k),'isolated:'+k);
 check('same-machine repeated identity retains every authentication file',()=>{const again=cfg.ensureInstanceIdentity();assert.equal(again.instanceId,first.instanceId);assert.equal(again.isNewMachine,false);for(const k of keys)assert.equal(fs.readFileSync(path.join(cfg.LOG_DIR,k),'utf8'),'isolated:'+k);});
 const legacy=['codex-desktop-relay.json','codex-message-queue.json','dot-private-anchor.dpapi'];for(const k of legacy)fs.writeFileSync(path.join(cfg.LOG_DIR,k),'legacy:'+k);
 const instance=JSON.parse(fs.readFileSync(cfg.INSTANCE_FILE));instance.fingerprint='synthetic-other-machine';fs.writeFileSync(cfg.INSTANCE_FILE,JSON.stringify(instance));
 check('copied-machine identity rotates only authentication identity and preserves legacy data',()=>{const changed=cfg.ensureInstanceIdentity();assert.equal(changed.isNewMachine,true);assert.notEqual(changed.instanceId,first.instanceId);for(const k of keys)assert.equal(fs.existsSync(path.join(cfg.LOG_DIR,k)),false);for(const k of legacy)assert.equal(fs.readFileSync(path.join(cfg.LOG_DIR,k),'utf8'),'legacy:'+k);});
 const blocker=net.createServer();await new Promise(r=>blocker.listen(0,'0.0.0.0',r));try{const port=blocker.address().port,picked=await cfg.findAvailablePort(port,5);check('legacy matching-address availability probe avoids an owned occupied random port',()=>{assert(Number.isInteger(picked));assert.notEqual(picked,port);assert(picked>port&&picked<port+5);});}finally{await new Promise(r=>blocker.close(r));}
 console.log('Passed '+passed+' actual isolated DSH configuration checks.');
}finally{assert(path.basename(scratch).startsWith('pb-config-isolated-'));fs.rmSync(scratch,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
