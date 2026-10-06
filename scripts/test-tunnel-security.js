// Isolated regression for public tunnel request classification. Never starts
// a real tunnel or gateway and never reads runtime secrets.
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const tunnel = require('./tunnel.js');
const origin = require('./request-origin.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
const retiredTargets = require('./retired-targets.js');
const wsE2ee = require('./ws-e2ee-bridge.js');

const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const request = (host, remoteAddress = '127.0.0.1', extra = {}) => ({
  socket: { remoteAddress },
  headers: { host, ...extra }
});

function verifyRemoteContentBoundary() {
  const config = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  const ownAddress = vm.runInNewContext('(' + extractFunction(config, 'isOwnAddress') + ')', { os });
  const pathSource = gateway.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert(pathSource);
  const paths = new Set([...pathSource[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
  assert(paths.has('/__dsh/lite-rpc') && paths.has('/__dsh/lite-upload'));
  const gateAt = gateway.indexOf('if (E2EE_CONTENT_PATHS.has(u.pathname)'), gateOpen = gateway.indexOf('{', gateAt);
  const gateEnd = sliceBalanced(gateway, gateOpen, '{', '}'); assert(gateAt>=0 && gateEnd>gateOpen);
  const KEY='isolated-tunnel-fixture-secret-0123456789';
  let secret=KEY, authenticated=true, deviceOk=true, proof=true, connections=0, discoveries=0;
  const box=vm.createContext({ Buffer, URL, Date, requestOrigin:origin, cfg:{isOwnAddress:ownAddress},
    E2EE_CONTENT_PATHS:paths, dshPhoneSurface, retiredTargets,
    e2eeSecretOrNull:()=>secret,
    refuseEncryptionUnavailable(res){res.writeHead(503);res.end('encryption-unavailable');},
    refusePlaintext(_req,res){res.writeHead(403);res.end('encrypted-request-required');},
    clientWantsE2ee:(req,u)=>req.headers['x-dsh-e2ee']==='1'||u.searchParams.get('e2ee')==='1',
    e2eeBridge:{wanted:wsE2ee.wanted,readSecret:()=>secret},
    refuseEncryptionUnavailableUpgrade(socket){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');},
    hasAuthCookie:()=>authenticated, ensureDevice:()=>({ok:deviceOk,device:{id:'synthetic',label:'Fixture'}}),
    authProvenAt:()=>proof, proofBootWindowOpen:()=>false, proofLooksInProgress:()=>false,
    PROOF_WAIT_MS:10,PROOF_WAIT_FULL_MS:10,PROOF_WAIT_STEP_MS:1,
    EXPLICIT_TARGET_PORT:19003,TARGET_PORT:19003,TARGET_HOST:'127.0.0.1',
    refreshDshRuntime(){discoveries++;throw Error('refused request must not discover upstream');},
    net:{connect(){connections++;return new EventEmitter();}},log(){}
  });
  vm.runInContext(extractFunction(gateway,'isOwnAddress')+'\n'+extractFunction(gateway,'isLocalRequest')+
    '\n'+extractFunction(gateway,'handleUpgrade')+'\nfunction gate(req,res,u){'+gateway.slice(gateAt,gateEnd+1)+';return false;}',box);
  const res=()=>({writeHead(n){this.status=n;},end(v){this.body=v;}});
  const remoteCases=[request('public.fixture.invalid'),request('localhost:8080','127.0.0.1',{'cf-ray':'synthetic'}),
    request('localhost:8080','192.0.2.4')];
  for(const req of remoteCases) for(const pathname of paths){
    req.url=pathname;let r=res();secret=KEY;
    box.gate(req,r,new URL('http://localhost'+pathname));assert.equal(r.status,403);assert.equal(req.__dshRequireE2ee,true);
    r=res();box.gate(req,r,new URL('http://localhost'+pathname+'?e2ee=1'));assert.equal(r.status,undefined);
    secret=null;r=res();box.gate(req,r,new URL('http://localhost'+pathname+'?e2ee=1'));assert.equal(r.status,503);secret=KEY;
  }
  const local=request('localhost:8080');const r=res();
  box.gate(local,r,new URL('http://localhost/__dsh/lite-rpc'));assert.equal(r.status,undefined);
  assert.equal(local.__dshRequireE2ee,undefined,'only direct-computer entry receives the exemption');
  function upgrade(req,url){
    req={...req,headers:{...req.headers},url,method:'GET'};
    const socket=new EventEmitter();socket.destroyed=false;socket.text='';
    socket.write=v=>socket.text+=v;socket.end=v=>{socket.text+=v||'';socket.destroyed=true;};socket.destroy=()=>{socket.destroyed=true;};
    box.handleUpgrade(req,socket,Buffer.alloc(0));return {req,text:socket.text};
  }
  for(const req of remoteCases){
    authenticated=false;assert.match(upgrade(req,'/api/remote.mux?e2ee=1').text,/^HTTP\/1\.1 403/);authenticated=true;
    deviceOk=false;assert.match(upgrade(req,'/api/remote.mux?e2ee=1').text,/^HTTP\/1\.1 403/);deviceOk=true;
    proof=false;const denied=upgrade(req,'/api/remote.mux?e2ee=1');assert.match(denied.text,/x-dsh-need-proof: 1/);proof=true;
    secret=null;assert.match(upgrade(req,'/api/remote.mux?e2ee=1').text,/^HTTP\/1\.1 503/);secret=KEY;
    assert.match(upgrade(req,'/api/remote.mux').text,/^HTTP\/1\.1 403/);
    for(const url of ['/events?e2ee=1','/api/events.mux?e2ee=1','/api/remote.mux/?e2ee=1','/api/%72emote.mux?e2ee=1'])
      assert.match(upgrade(req,url).text,/^HTTP\/1\.1 410/);
  }
  assert.equal(connections,0,'denied routes never connect upstream');assert.equal(discoveries,0);
  const admitted=upgrade(remoteCases[0],'/api/remote.mux?e2ee=1');
  assert.equal(connections,1);assert.equal(admitted.text,'');assert.equal(admitted.req.__dshWsE2eeSecret,KEY);
  const direct=upgrade(local,'/events');assert.equal(connections,2);assert.equal(direct.req.__dshWsE2eeSecret,undefined);
}

(async () => {
  const providers = tunnel.listProviders().map((p) => p.id);
  assert.deepEqual(providers, ['cloudflare-named', 'cloudflare-quick']);
  assert.deepEqual(tunnel.candidatesForMode('dynamic').map((p) => p.id), ['cloudflare-quick']);
  assert.deepEqual(tunnel.candidatesForMode('fixed').map((p) => p.id), ['cloudflare-named']);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ngrok-free.app'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ngrok.io'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ts.net'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.trycloudflare.com'),
    'https://test.trycloudflare.com');

  // Old configurations may still explicitly ask for ngrok. It must not be
  // launched or silently replaced with a different public tunnel.
  const disabled = await tunnel.startTunnel(1, 'ngrok');
  assert.equal(disabled.provider, null);
  assert.equal(disabled.url, null);
  assert.deepEqual(disabled.attempts.map((a) => a.provider), ['ngrok']);
  assert.equal(disabled.attempts[0].ok, false);

  const ngrok = request('demo.ngrok-free.app:443');
  assert.equal(origin.viaRelay(ngrok), true);
  assert.equal(origin.isLoopback(ngrok), false);
  for (const host of ['demo.ngrok.io', 'demo.trycloudflare.com', 'bridge.example.org', '']) {
    const forwarded = request(host);
    assert.equal(origin.viaRelay(forwarded), true, `public/unknown Host ${host}`);
    assert.equal(origin.isLoopback(forwarded), false, `admin denied for ${host}`);
  }
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(origin.isLoopback(request('localhost:8080', remote)), true);
  }
  assert.equal(origin.viaRelay(request('127.0.0.1:8080', '127.0.0.1',
    { 'cf-ray': 'relay' })), true);
  assert.equal(origin.viaRelay(request('127.0.0.1:8080', '127.0.0.1',
    { 'x-forwarded-host': 'demo.ngrok-free.app' })), true);
  assert.equal(origin.isLoopback(request('localhost:8080', '203.0.113.9')), false);

  const lan = Object.values(os.networkInterfaces()).flat().find((x) =>
    x && x.family === 'IPv4' && !x.internal);
  if (lan) assert.equal(origin.viaRelay(request(`${lan.address}:8080`, lan.address)), false);

  // The pure boundary above must be the one used by the real admin and E2EE
  // gates; a future inline Cloudflare-only shortcut would reopen the hole.
  assert.match(gateway, /function isLoopback\(req\)\s*\{[\s\S]*?return requestOrigin\.isLoopback\(req\);/);
  assert.match(gateway, /function isSelfCheck\(req\)\s*\{\s*return req\.headers\['x-dsh-selfcheck'\] === '1' && isLocalRequest\(req\);/);
  assert.match(gateway, /function viaRelay\(req\)\s*\{\s*return requestOrigin\.viaRelay\(req\);/);
  assert.match(gateway, /u\.pathname === '\/__console\/status'[\s\S]{0,120}!isLoopback\(req\)/);
  verifyRemoteContentBoundary();

  console.log('Tunnel security: disabled providers; remote/LAN HTTP and exact mux require encryption, auth and proof; refused paths never reach upstream.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
