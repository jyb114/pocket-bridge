'use strict';

// Actual screen handler + AES wrapper + owned loopback HTTP and Node children.
// Every image and process is synthetic; no PowerShell, desktop capture, user
// credentials, installed runtime, browser or external network is used.
require('./replay-isolated-fixture.js').install();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { extractFunction } = require('./page-source');
const e2ee = require('./e2ee');
const screenSource = fs.readFileSync(path.join(__dirname, 'dsh-lite-screen.js'), 'utf8');
const gatewaySource = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const SECRET = 'owned-screen-async-fixture-key-0123456789';
const ROUTE = '/__dsh/screen-shot';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { assert(Date.now() < end, 'owned fixture condition reached its deadline'); await delay(5); }
}

async function withScreen(test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-owned-screen-test-'));
  const state = { mode: {}, calls: 0, active: 0, peak: 0, kills: 0, logs: [], directories: [], deadlines: [] };
  const children = [], pending = new Set();
  const module = { exports: {} };
  const fixtureFs = { ...fs,
    mkdtempSync(prefix) {
      assert.equal(path.dirname(prefix), root);
      if (state.mode.directoryError) throw Error('synthetic temp-directory error');
      const directory = fs.mkdtempSync(prefix); state.directories.push(directory); return directory;
    },
    writeFileSync(file, value, options) {
      if (state.mode.writeError) throw Error('synthetic script-write error');
      return fs.writeFileSync(file, value, options);
    },
    readFileSync(file, options) {
      if (state.mode.readError && file.endsWith('.jpg')) throw Error('synthetic image-read error');
      return fs.readFileSync(file, options);
    },
    rmSync(directory, options) {
      assert(state.directories.includes(directory), 'cleanup targets only an owned unique directory');
      assert(!children.some(entry => entry.directory === directory && !entry.closed), 'never remove files while the child can still write');
      return fs.rmSync(directory, options);
    }
  };
  function spawn(command, args, options) {
    state.calls++;
    assert.equal(command, 'powershell');
    assert.equal(options.windowsHide, true);
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'ignore']);
    assert(!options.shell, 'never run through a shell');
    assert.deepEqual(Array.from(args.slice(0, 6)), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File']);
    assert(fs.readFileSync(args[6], 'utf8').startsWith('\uFEFF'), 'PowerShell 5.1 BOM is preserved');
    assert.equal(path.dirname(args[6]), path.dirname(args[8]));
    assert(state.directories.includes(path.dirname(args[8])));
    const mode = { ...state.mode };
    if (mode.throwSpawn) throw Error('synthetic synchronous spawn error');
    const code = `
      const fs = require('node:fs');
      const mode = ${JSON.stringify(mode)}, output = ${JSON.stringify(args[8])};
      const done = () => {
        if (mode.hang) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
        if (mode.exitError) { process.stderr.write('PRIVATE SYNTHETIC STDERR'); process.exit(7); }
        if (mode.overflow) { process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65)); setInterval(() => {}, 1000); return; }
        if (mode.noScreen) { process.stdout.write('RESULT=NO_SCREEN'); return; }
        if (!mode.empty) fs.writeFileSync(output, mode.tooLarge ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from([255,216,255,217]));
        process.stdout.write('RESULT=OK ${args[7]}x720');
      };
      setTimeout(done, mode.delay || 0);
    `;
    const child = mode.missingExecutable
      ? childProcess.spawn(path.join(root, 'missing-owned-executable'), [], options)
      : childProcess.spawn(process.execPath, ['-e', code], options);
    assert.equal(child.stdin, null); assert.equal(child.stderr, null);
    const entry = { child, directory: path.dirname(args[8]), closed: false, nativeKill: child.kill.bind(child) };
    entry.done = new Promise(resolve => child.once('close', () => {
      entry.closed = true; state.active--; resolve();
    }));
    child.kill = signal => {
      assert.equal(signal, 'SIGKILL', 'hard deadline targets only the owned child'); state.kills++;
      if (mode.delayedKill) { setTimeout(() => entry.nativeKill(signal), mode.delayedKill); return true; }
      return entry.nativeKill(signal);
    };
    children.push(entry); state.active++; state.peak = Math.max(state.peak, state.active);
    return child;
  }
  vm.runInNewContext('(function(require,module,exports){' + screenSource + '\n})', {
    Buffer, AbortController, process: { pid: process.pid }, clearTimeout,
    setTimeout(fn, ms) { assert.equal(ms, 20000); state.deadlines.push(ms); return setTimeout(fn, state.mode.shortTimeout || ms); }
  })(name => {
    if (name === 'node:fs') return fixtureFs;
    if (name === 'node:os') return { tmpdir: () => root };
    if (name === 'node:path') return path;
    if (name === 'node:child_process') return { spawn };
    throw Error('Unexpected screen dependency ' + name);
  }, module, module.exports);
  const handler = module.exports.createDshLiteScreen({ log: line => state.logs.push(line) });
  const tracked = (req, res) => {
    const work = handler(req, res); pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const context = vm.createContext({ Buffer, URL, Readable, e2ee, log() {},
    privateHttpsAdmission: require('./private-https-admission'), MAX_E2EE_BODY: 64 * 1024 * 1024,
    e2eeSecretOrNull: () => SECRET, clientWantsE2ee: req => req.headers['x-dsh-e2ee'] === '1',
    refuseEncryptionUnavailable() { throw Error('Unexpected absent fixture key'); }
  });
  vm.runInContext(extractFunction(gatewaySource, 'wrapEncryptedResponse') + '\n' + extractFunction(gatewaySource, 'e2eeWrap'), context);
  const wrapped = context.e2eeWrap(tracked);
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ active: state.active })); return; }
    assert.equal(req.url, ROUTE); req.__dshRequireE2ee = true; wrapped(req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  function send(payload = { maxWidth: 1280 }, extras = {}) {
    const wire = extras.wire || e2ee.encrypt(e2ee.deriveKeys(SECRET, e2ee.slotAt()).a, Buffer.from(JSON.stringify(payload)));
    let request;
    const promise = new Promise((resolve, reject) => {
      request = http.request({ host: '127.0.0.1', port, path: ROUTE, method: 'POST', headers: {
        'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json', 'content-length': wire.length
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const plain = response.headers['x-dsh-e2ee'] === '1'
              ? e2ee.candidateKeys(SECRET).map(keys => e2ee.decrypt(keys.b, raw)).find(Boolean) : raw;
            assert(plain, 'encrypted response must decrypt');
            resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(plain.toString()) });
          } catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('owned HTTP deadline'))); request.end(wire);
    });
    promise.catch(() => {}); // Cancellation intentionally rejects; callers still observe the original promise.
    return { request, promise };
  }
  function clean() { assert.equal(state.active, 0); assert.deepEqual(fs.readdirSync(root), []); }
  try { await test({ state, send, port, tracked, clean, pending }); }
  finally {
    server.closeAllConnections();
    for (const entry of children) if (!entry.closed) entry.nativeKill('SIGKILL');
    await Promise.all(children.map(entry => entry.done));
    await Promise.all(pending);
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await check('independent HTTP health responds while a real synthetic capture child is pending', async () => {
    await withScreen(async ({ state, port, clean }) => {
      state.mode = { delay: 700 };
      const client = `
        const http=require('node:http'), e2ee=require(${JSON.stringify(path.join(__dirname, 'e2ee.js'))});
        function read(route, wire) { const start=performance.now(); return new Promise((resolve,reject)=>{
          const req=http.request({host:'127.0.0.1',port:${port},path:route,method:wire?'POST':'GET',headers:wire?{
            'content-type':'application/octet-stream','x-dsh-e2ee':'1','x-dsh-e2ee-type':'application/json','content-length':wire.length}:{}},res=>{
            const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{
              const raw=Buffer.concat(chunks), plain=wire?e2ee.candidateKeys(${JSON.stringify(SECRET)}).map(k=>e2ee.decrypt(k.b,raw)).find(Boolean):raw;
              resolve({ms:performance.now()-start,status:res.statusCode,body:JSON.parse(plain.toString())});});});
          req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('owned client deadline')));req.end(wire);});}
        (async()=>{const wire=e2ee.encrypt(e2ee.deriveKeys(${JSON.stringify(SECRET)},e2ee.slotAt()).a,Buffer.from('{"maxWidth":1280}'));
          const shot=read(${JSON.stringify(ROUTE)},wire);await new Promise(r=>setTimeout(r,150));
          const health=await read('/health');console.log(JSON.stringify({health,shot:await shot}));})().catch(e=>{console.error(e);process.exitCode=1;});
      `;
      const measured = await new Promise((resolve, reject) => childProcess.execFile(process.execPath, ['-e', client], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true
      }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
      assert.equal(measured.health.body.active, 1, 'health finishes before capture child closes, not just before screenshot response');
      assert.equal(measured.shot.status, 200); assert.equal(measured.shot.body.image, JPEG.toString('base64'));
      assert(measured.health.ms < measured.shot.ms);
      console.log('  owned HTTP health=' + Math.round(measured.health.ms) + 'ms, pending capture=' + Math.round(measured.shot.ms) + 'ms');
      assert.equal(state.calls, 1); clean();
    });
  });

  await check('one capture at a time rejects excess requests encrypted and admits a fresh request after close', async () => {
    await withScreen(async ({ state, send, clean }) => {
      state.mode = { delay: 200 };
      const first = send(); await until(() => state.active === 1);
      const busy = await send().promise;
      assert.equal(busy.status, 429); assert.deepEqual(busy.body, { error: 'capture-busy' });
      assert.equal(busy.headers['x-dsh-e2ee'], '1'); assert.equal(busy.headers['cache-control'], 'no-store');
      assert.equal(state.calls, 1); assert.equal(state.directories.length, 1);
      assert.equal((await send({ maxWidth: 1280, unexpected: true }).promise).status, 400);
      assert.equal((await first.promise).status, 200); clean();
      state.mode = {}; const next = await send().promise;
      assert.equal(next.status, 200); assert.equal(next.body.width, 1280); assert.equal(next.body.height, 720);
      assert.equal(next.body.bytes, JPEG.length); assert.equal(next.body.mime, 'image/jpeg'); assert(Number.isFinite(Date.parse(next.body.capturedAt)));
      assert.equal(state.calls, 2); assert.equal(state.peak, 1);
      assert.equal(new Set(state.directories).size, 2); assert.equal(state.kills, 0, 'normal decrypted request close does not cancel capture'); clean();
    });
  });

  await check('aborted phone response kills its exact child and retains files/admission until confirmed close', async () => {
    await withScreen(async ({ state, send, clean, pending }) => {
      state.mode = { hang: true, delayedKill: 150 };
      const first = send(); await until(() => state.active === 1); first.request.destroy();
      await assert.rejects(first.promise); await until(() => state.kills === 1);
      assert(fs.existsSync(state.directories[0]), 'files remain during delayed termination');
      assert.equal((await send().promise).status, 429); assert.equal(state.calls, 1);
      await until(() => pending.size === 0); clean();
      assert(state.logs.some(line => line.includes('capture-aborted')));
      state.mode = {}; assert.equal((await send().promise).status, 200); clean();
    });
  });

  await check('20-second production deadline kills a hung child and only releases after close', async () => {
    await withScreen(async ({ state, send, clean, pending }) => {
      state.mode = { hang: true, shortTimeout: 100, delayedKill: 300 };
      const first = send(); await until(() => state.kills === 1);
      assert.deepEqual(state.deadlines, [20000]); assert(fs.existsSync(state.directories[0]));
      assert.equal((await send().promise).status, 429);
      const result = await first.promise; assert.equal(result.status, 502); assert.equal(result.headers['x-dsh-e2ee'], '1');
      assert.deepEqual(result.body, { error: 'capture-failed' }); assert(state.logs.some(line => line.includes('capture-timeout')));
      assert.equal(state.active, 1, 'HTTP deadline does not wait for delayed child termination');
      assert(fs.existsSync(state.directories[0])); assert.equal((await send().promise).status, 429);
      await until(() => pending.size === 0); clean();
      state.mode = {}; assert.equal((await send().promise).status, 200); clean();
    });
  });

  for (const [mode, status, error] of [
    [{ throwSpawn: true }, 502, 'capture-failed'], [{ missingExecutable: true }, 502, 'capture-failed'],
    [{ exitError: true }, 502, 'capture-failed'], [{ overflow: true }, 502, 'capture-failed'],
    [{ noScreen: true }, 502, 'no-screen'], [{ empty: true }, 502, 'capture-empty'],
    [{ tooLarge: true }, 413, 'capture-too-large'], [{ readError: true }, 502, 'capture-failed'],
    [{ writeError: true }, 502, 'capture-failed'], [{ directoryError: true }, 502, 'capture-failed']
  ]) await check('failed capture cleans its lease and files: ' + Object.keys(mode)[0], async () => {
    await withScreen(async ({ state, send, clean }) => {
      state.mode = mode; const result = await send().promise;
      assert.equal(result.status, status); assert.equal(result.body.error, error); assert.equal(result.headers['x-dsh-e2ee'], '1');
      if (mode.tooLarge) assert.equal(result.body.bytes, 4 * 1024 * 1024 + 1);
      assert(!state.logs.join('\n').includes('PRIVATE SYNTHETIC STDERR')); clean();
      state.mode = {}; assert.equal((await send().promise).status, 200); clean();
    });
  });

  await check('aborted request and preclosed response never produce an image or leak listeners', async () => {
    await withScreen(async ({ state, tracked, clean }) => {
      function invocation() {
        const req = Readable.from([Buffer.from('{"maxWidth":1280}')]); req.method = 'POST'; req.__dshE2eeDecrypted = true;
        req.headers = { 'content-type': 'application/json', 'x-dsh-e2ee': '1' };
        const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
          writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); this.writableEnded = true; } });
        return { req, res };
      }
      const early = invocation(); early.req.aborted = true; await tracked(early.req, early.res);
      const closed = invocation(); closed.res.destroyed = true; await tracked(closed.req, closed.res);
      assert.equal(state.calls, 0); assert.equal(state.directories.length, 0);
      state.mode = { hang: true }; const { req, res } = invocation(); const work = tracked(req, res);
      await until(() => state.active === 1); req.emit('aborted'); await work;
      assert.equal(res.body.error, 'capture-failed'); assert.equal(state.kills, 1);
      assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0); clean();
    });
  });

  await check('screen entry still requires existing device/proof and encrypted content gates', () => {
    const inner = gatewaySource.indexOf('function handleRequestInner(');
    const dispatch = gatewaySource.indexOf("if (u.pathname === '" + ROUTE + "')", inner);
    assert(dispatch > gatewaySource.indexOf('authProvenAt(dev.device.id)', inner));
    assert.match(gatewaySource.slice(dispatch, dispatch + 160), /serveDshLiteScreenE2ee\(req, res\)/);
    assert.match(gatewaySource, /const serveDshLiteScreenE2ee = e2eeWrap\(require\('\.\/dsh-lite-screen.js'\)/);
    const paths = gatewaySource.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/); assert(paths);
    assert(paths[1].includes("'" + ROUTE + "'"));
  });
  console.log('DSH async screen: ' + checks + ' isolated HTTP/process groups passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
