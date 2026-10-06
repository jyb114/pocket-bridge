'use strict';
// Real file staging and upgrade-copy fixture; no compiler, installer, registry,
// desktop process or production installation is touched.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {execFileSync}=require('child_process');
const profile=require('./release-profile.js');
const root=path.resolve(__dirname,'..'),tempBase=path.resolve(os.tmpdir());
const scratch=fs.mkdtempSync(path.join(tempBase,'pb-dsh-payload-'));
const payload=path.join(scratch,'payload'),installed=path.join(scratch,'existing-D-install');
let passed=0;function check(name,fn){fn();passed++;console.log('OK '+name);}
function files(base){const out=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);assert(!e.isSymbolicLink());if(e.isDirectory())walk(p);else out.push(path.relative(base,p).replace(/\\/g,'/'));}}walk(base);return out;}
try{
 const newPublic=['desktop/brand-artwork.js','pwa/pocket-bridge.svg','pwa/icon-maskable.png','scripts/gateway-lifecycle.js','scripts/retired-targets.js','scripts/dsh-phone-surface.js','scripts/release-profile.js','scripts/test-gateway-lifecycle.js','scripts/test-dsh-only-retirement.js','scripts/test-dsh-phone-surface.js','scripts/test-dsh-ws-failclosed.js','scripts/test-dsh-payload.js','scripts/dsh-lite-attachment.js','scripts/dsh-runtime-identity.js','scripts/test-dsh-lite-attachment.js','scripts/test-dsh-lite-attachment-gateway.js'];
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString('utf8').split('\0').filter(Boolean);
 for(const name of newPublic)if(!tracked.includes(name))tracked.push(name);
 const stager=fs.readFileSync(path.join(root,'packaging/windows/stage.js'),'utf8');
 vm.runInNewContext(stager,{__dirname:path.join(root,'packaging/windows'),process:{argv:[process.execPath,'stage.js',payload]},console:{log(){}},require(name){if(name==='child_process')return{execFileSync(exe,args,options){assert.equal(exe,'git');assert.deepEqual(Array.from(args),['ls-files','-z']);assert.equal(options.cwd,root);return Buffer.from(tracked.join('\0')+'\0');}};if(name==='../../scripts/release-profile.js')return profile;return require(name);}}, {timeout:15000});
 const packaged=files(payload),set=new Set(packaged);
 check('large encrypted attachment helper is required before an installer can be built',()=>{
  assert(set.has('scripts/dsh-lite-attachment.js'));
  const without=tracked.filter(p=>p!=='scripts/dsh-lite-attachment.js');
  assert.throws(()=>vm.runInNewContext(stager,{__dirname:path.join(root,'packaging/windows'),process:{argv:[process.execPath,'stage.js',path.join(scratch,'missing-attachment-payload')]},console:{log(){}},require(name){if(name==='child_process')return{execFileSync(){return Buffer.from(without.join('\0')+'\0');}};if(name==='../../scripts/release-profile.js')return profile;return require(name);}}, {timeout:15000}),/Missing required payload file: scripts\/dsh-lite-attachment\.js/);
 });
 check('both validated runtime protocols require the shared guard in staged payload',()=>{
  assert(set.has('scripts/dsh-runtime-identity.js'));
  const without=tracked.filter(p=>p!=='scripts/dsh-runtime-identity.js');
  assert.throws(()=>vm.runInNewContext(stager,{__dirname:path.join(root,'packaging/windows'),process:{argv:[process.execPath,'stage.js',path.join(scratch,'missing-runtime-identity-payload')]},console:{log(){}},require(name){if(name==='child_process')return{execFileSync(){return Buffer.from(without.join('\0')+'\0');}};if(name==='../../scripts/release-profile.js')return profile;return require(name);}}, {timeout:15000}),/Missing required payload file: scripts\/dsh-runtime-identity\.js/);
 });
 check('new payload excludes every retired native helper, page, exclusive test and current guide',()=>{assert(packaged.length>120);for(const p of packaged)assert(profile.isPayloadPath(p),p);for(const p of ['scripts/codex-desktop-relay.js','scripts/dot-desktop-runtime.js','scripts/desktop-ui-action.js','pwa/codex.html','pwa/dot.html','pwa/dot-guide.html','scripts/test-codex-image.js','scripts/test-release-lock.js','docs/CODEX_SESSION_CONTROL.md'])assert(!set.has(p),p);});
 check('DSH and shared local runtime dependencies are closed over the actual staged bytes',()=>{const pending=['scripts/mobile-proxy.js','scripts/gateway-daemon.js','desktop/open-desktop-app.js','scripts/self-check.js','scripts/install-autostart.js'],seen=new Set();while(pending.length){const p=pending.pop();if(seen.has(p))continue;seen.add(p);assert(set.has(p),'missing active dependency: '+p);assert(profile.isPayloadPath(p));const code=fs.readFileSync(path.join(payload,p),'utf8');for(const m of code.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)){let dep=path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1]));if(!path.posix.extname(dep))dep+='.js';pending.push(dep);}}assert(seen.size>=30);});
 check('current CI/all-test selection cannot invoke an archived native integration',()=>{const ci=fs.readFileSync(path.join(payload,'scripts/run-ci-tests.js'),'utf8');for(const m of ci.matchAll(/\['(test-[^']+\.js)'/g))assert(profile.isCurrentTest(m[1]),m[1]);const all=fs.readFileSync(path.join(payload,'scripts/run-all-tests.js'),'utf8');assert.match(all,/release-profile\.js.*isCurrentTest/);});
 const retained=new Map([
  ['config.json',Buffer.from(JSON.stringify({gatewayPort:19411,custom:{deep:'retain'},codex:{port:18790,custom:'retain'},dot:{setting:'retain'},dshMode:'web'}))],
  ['logs/access-key.txt',Buffer.from('isolated-access-key-0123456789')],['logs/e2ee-secret.txt',Buffer.from('isolated-e2ee-secret-01234567890123456789')],
  ['logs/instance.json',Buffer.from('isolated existing machine identity')],['logs/devices.json',Buffer.from('isolated devices')],
  ['logs/codex-desktop-relay.json',Buffer.from('isolated legacy receipts')],['logs/codex-message-queue.json',Buffer.from('isolated legacy pending text')],
  ['logs/dot-private/state.dpapi',Buffer.from([0,1,255,17,33])],['logs/dot-private/requests.aes-gcm.json',Buffer.from('isolated encrypted Dot receipts')],
  ['logs/dot-private-anchor.dpapi',Buffer.from([6,5,4])],['uploads/codex/legacy/keep.bin',Buffer.from([1,0,239,31])],
  ['uploads/dsh/legacy/keep.txt',Buffer.from('isolated DSH upload')],['tls/ca.key',Buffer.from('isolated CA key')]
 ]);
 fs.mkdirSync(installed,{recursive:true});for(const [p,b]of retained){const dest=path.join(installed,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,b);}
 check('private and legacy state never enters the new payload',()=>{for(const p of retained.keys())assert(!set.has(p));for(const p of packaged)assert(!/^(?:logs|uploads|tls|private)\//.test(p));});
 for(const p of packaged){const dest=path.join(installed,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(payload,p),dest);}
 check('an isolated payload upgrade preserves all legacy, authentication and DSH data bytes',()=>{for(const[p,b]of retained)assert(fs.readFileSync(path.join(installed,p)).equals(b),p);assert.equal(path.dirname(path.join(installed,'config.json')),installed);});
 check('saving a DSH preference keeps legacy and unknown config fields',()=>{const config=require(path.join(installed,'scripts/config.js'));const before=config.loadConfig();config.saveConfig({...before,dshMode:'desktop'});const after=JSON.parse(fs.readFileSync(path.join(installed,'config.json'),'utf8'));assert.deepEqual(after.codex,before.codex);assert.deepEqual(after.dot,before.dot);assert.deepEqual(after.custom,before.custom);assert.equal(after.gatewayPort,19411);assert.equal(after.dshMode,'desktop');});
 // Match the installer generator's payload-only deletion semantics. Removing
 // code does not recursively delete user directories or untracked old assets.
 retained.set('config.json',fs.readFileSync(path.join(installed,'config.json')));
 for(const p of packaged)fs.unlinkSync(path.join(installed,p));
 check('payload-only uninstall simulation preserves every old and new private data file',()=>{for(const[p,b]of retained)assert(fs.readFileSync(path.join(installed,p)).equals(b),p);});
 check('retirement classification does not exclude DSH shared crypto, UI or runtime helpers',()=>{for(const p of ['scripts/e2ee.js','scripts/ws-e2ee-bridge.js','scripts/config.js','scripts/first-run.js','scripts/dsh-lite-rpc.js','pwa/dsh-lite-ui.js','pwa/dsh-lite-lang.js','pwa/dsh-lite.html'])assert(set.has(p),p);assert(!profile.isPayloadPath('scripts/../config.json'));assert(!profile.isPayloadPath('scripts\\codex-desktop-driver.js'));});
 console.log('Passed '+passed+' DSH payload and isolated retention checks; '+packaged.length+' actual staged files. No compiled-installer acceptance was claimed.');
}finally{const resolved=path.resolve(scratch);assert(resolved.startsWith(tempBase+path.sep)&&path.basename(resolved).startsWith('pb-dsh-payload-'));fs.rmSync(resolved,{recursive:true,force:true});}
