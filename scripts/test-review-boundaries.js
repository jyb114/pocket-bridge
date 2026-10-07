'use strict';
// Isolated regressions: no gateway, real tasks, credentials or network access.
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const { WsCrypto } = require('./ws-crypt');
const frames = require('./ws-frame');
let failed = 0;
async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  // Native Codex status control is retired; active shared crypto guards remain below.
  for (const opcode of [frames.OP_TEXT, frames.OP_BIN]) {
    await check('encrypted upstream rejects unauthenticated first frame opcode ' + opcode, () => {
      const crypt = new WsCrypto('fixture-secret-not-a-real-key', 'decrypt');
      assert.equal(crypt.push(frames.buildFrame(opcode, Buffer.from('fixture-sensitive-message'), true)).length, 0);
      assert.equal(crypt.rejected, 1);
    });
  }
  await check('unsupported downstream binary never leaks plaintext', () => {
    const crypt = new WsCrypto('fixture-secret-not-a-real-key', 'encrypt');
    const out = frames.parseFrames(crypt.push(frames.buildFrame(frames.OP_BIN, Buffer.from('fixture-private-file'), false))).frames;
    assert.equal(out.length, 0); assert.equal(crypt.invalidStream, true);
    assert.equal(crypt.lastFailureCode, 'ws-data-unsupported');
    assert.equal(crypt.push(frames.buildFrame(frames.OP_TEXT, Buffer.from('fixture-private-file'), false)).length, 0);
    const bridge = require('./ws-e2ee-bridge.js').attach('fixture-secret-not-a-real-key');
    const handshake = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
    assert.throws(() => bridge.fromUpstream(Buffer.concat([handshake,
      frames.buildFrame(frames.OP_BIN, Buffer.from('fixture-private-file'), false)])),
      error => error.code === 'ws-data-unsupported');
    assert.equal(bridge.stats().closed, true); assert.equal(bridge.stats().failureCode, 'ws-data-unsupported');
    assert.equal(bridge.isReady(), false);
    assert.throws(() => bridge.fromUpstream(frames.buildFrame(frames.OP_TEXT, Buffer.from('fixture-private-file'), false)),
      error => error.code === 'ws-data-unsupported');
    assert.throws(() => bridge.fromClient(Buffer.alloc(0)), error => error.code === 'ws-data-unsupported');
  });
  await check('malformed frame cannot bypass encryption transform', () => {
    const crypt = new WsCrypto('fixture-secret-not-a-real-key', 'decrypt');
    assert.equal(crypt.push(Buffer.from([0x82,127,255,255,255,255,255,255,255,255])).length,0);
    assert.equal(crypt.invalidStream,true);
  });
  await check('browser encryption failure never sends plaintext and closes transport', async () => {
    const sent = [], closed = [];
    class Socket { send(v) { sent.push(v); } addEventListener() {} removeEventListener() {} close(...v) { closed.push(v); } }
    const c = { TextEncoder, TextDecoder, URL, Uint8Array, ArrayBuffer, Map, Promise,
      crypto: { getRandomValues: v => v, subtle: { importKey: async () => { throw Error('fixture crypto unavailable'); } } },
      WebSocket: Socket, location: { href: 'https://fixture.invalid/' },
      btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary') };
    c.window = c; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(root, 'pwa/e2ee.js'), 'utf8'), c);
    assert.equal(c.DshE2EE.installWsEncryption('fixture-secret-not-a-real-key'), true);
    const ws = new c.WebSocket('wss://fixture.invalid/ws'); ws.send('fixture-private-text');
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 0); assert.equal(closed.length, 1);
  });
  await check('browser rejects incoming plaintext and unsupported outgoing binary', () => {
    const sent=[],closed=[];let listener,delivered=0;
    class Socket {send(v){sent.push(v);}addEventListener(type,fn){listener=fn;}removeEventListener(){}close(){closed.push(true);}}
    const c={TextEncoder,TextDecoder,URL,Uint8Array,ArrayBuffer,Map,Promise,crypto:require('crypto').webcrypto,
      WebSocket:Socket,location:{href:'https://fixture.invalid/'}};
    c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'pwa/e2ee.js'),'utf8'),c);
    c.DshE2EE.installWsEncryption('fixture-secret-not-a-real-key');const ws=new c.WebSocket('wss://fixture.invalid/ws');
    assert.throws(()=>ws.send(new Uint8Array([1,2,3])),/text messages only/);assert.equal(sent.length,0);
    ws.onmessage=()=>delivered++;listener({data:'unauthenticated response'});
    assert.equal(delivered,0);assert.equal(closed.length,1);
  });
  await check('CI must fail missing application files instead of skipping ENOENT', () => {
    const c={__dirname:path.join(root,'scripts'),process:{execPath:process.execPath,argv:[],exitCode:0},console:{log(){}},
      require(name){if(name==='path')return path;if(name==='child_process')return {spawnSync(_node,args){
        return args[0].endsWith('check-frontend.js')?{status:1,stderr:'ENOENT required application file'}:{status:0,stdout:''};
      }};throw Error(name);}};
    vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'scripts/run-ci-tests.js'),'utf8'),c);
    assert.equal(c.process.exitCode,1);
  });
  await check('baseline contains restorable sources and verify detects changes', () => {
    const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'pocket-baseline-fixture-'));
    fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'pwa'));
    fs.copyFileSync(path.join(root,'scripts/baseline-snapshot.js'),path.join(dir,'scripts/baseline-snapshot.js'));
    fs.writeFileSync(path.join(dir,'pwa/console.html'),'fixture original');
    const run=args=>require('child_process').spawnSync(process.execPath,[path.join(dir,'scripts/baseline-snapshot.js'),...args],{encoding:'utf8',timeout:10000});
    assert.equal(run([]).status,0);
    const snaps=path.join(dir,'logs/baselines');const backup=fs.readdirSync(snaps).find(n=>n.startsWith('backup-'));
    assert.equal(fs.readFileSync(path.join(snaps,backup,'pwa/console.html'),'utf8'),'fixture original');
    assert.equal(run(['--verify']).status,0);
    fs.writeFileSync(path.join(dir,'pwa/console.html'),'fixture changed');
    assert.equal(run(['--verify']).status,1);
  });
  process.exitCode = failed ? 1 : 0;
})();
