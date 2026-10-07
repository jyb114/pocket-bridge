'use strict';

// Isolated public source fixtures only: no gateway, native client, private
// configuration, credential, tunnel, or network operation is used by this test.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const vm = require('vm');
const { createPublicStaticRepresentationCache, LIMITS } = require('./public-static-representation-cache.js');
const { extractFunction } = require('./page-source.js');
const parent = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(parent, '.public-cache-test-'));
let checks = 0;
function check(name, action) { action(); checks++; console.log('PASS ' + name); }
function write(name, body) { fs.writeFileSync(path.join(root, name), body); }
function codec() {
  const calls = { br: 0, gzip: 0 };
  return { calls, brotliCompressSync(body) { calls.br++; return zlib.brotliCompressSync(body); },
    gzipSync(body, options) { calls.gzip++; return zlib.gzipSync(body, options); } };
}
function io(overrides = {}) {
  return Object.assign({ lstatSync: fs.lstatSync, openSync: fs.openSync,
    fstatSync: fs.fstatSync, readFileSync: fs.readFileSync, closeSync: fs.closeSync }, overrides);
}
function response() {
  return { writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); } };
}
try {
  const source = Buffer.from('Public source with no user data. '.repeat(70));
  write('public.js', source);
  const counted = codec();
  const cache = createPublicStaticRepresentationCache({ root, files: ['public.js'], zlib: counted });
  const br = cache.read('public.js', 'br');
  const gzip = cache.read('public.js', 'gzip');
  const identity = cache.read('public.js', null);
  check('current compression bytes and representation ETags remain exact', () => {
    assert.deepEqual(br.body, zlib.brotliCompressSync(source));
    assert.deepEqual(gzip.body, zlib.gzipSync(source, { level: 6 }));
    for (const value of [br, gzip, identity])
      assert.equal(value.etag, '"' + crypto.createHash('sha256').update(value.body).digest('hex') + '"');
    assert.deepEqual(zlib.brotliDecompressSync(br.body), source);
    assert.deepEqual(zlib.gunzipSync(gzip.body), source);
    assert.equal(new Set([br.etag, gzip.etag, identity.etag]).size, 3);
  });
  check('warm reads validate source without recompressing either encoding', () => {
    assert.deepEqual(cache.read('public.js', 'br'), br);
    assert.deepEqual(cache.read('public.js', 'gzip'), gzip);
    assert.deepEqual(counted.calls, { br: 1, gzip: 1 });
  });
  check('callers cannot mutate a cached representation through returned buffers', () => {
    br.body.fill(0); identity.body.fill(0);
    assert.deepEqual(zlib.brotliDecompressSync(cache.read('public.js', 'br').body), source);
    assert.deepEqual(cache.read('public.js', null).body, source);
  });
  check('only explicitly allowlisted public filenames can be read', () => {
    for (const name of ['../config.json', 'config.json', '/public.js', 'private/public.js'])
      assert.throws(() => cache.read(name, 'br'), /allowlist/);
    assert.throws(() => createPublicStaticRepresentationCache({ root, files: ['../config.json'] }), /fixed filenames/);
  });
  check('production memory and file limits cannot be increased', () => {
    assert.deepEqual(LIMITS, { maxEntries: 64, maxBytes: 8 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 });
    for (const name of Object.keys(LIMITS))
      assert.throws(() => createPublicStaticRepresentationCache({ root, files: ['public.js'], [name]: LIMITS[name] + 1 }), /reduced/);
  });
  check('editing source invalidates every prior encoding and ETag', () => {
    const changed = Buffer.from('Changed public source. '.repeat(100)); write('public.js', changed);
    const next = cache.read('public.js', 'br');
    assert.deepEqual(zlib.brotliDecompressSync(next.body), changed);
    assert.notEqual(next.etag, gzip.etag);
    assert.equal(cache.stats().entries, 1);
    assert.equal(counted.calls.br, 2);
  });
  check('same-size edits with unchanged metadata are detected by actual source hash', () => {
    write('edit.js', 'A'.repeat(1200));
    const metadata = stat => ({ isFile: () => true, isSymbolicLink: () => false,
      dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: 1n, ctimeNs: 1n });
    const fixed = io({ lstatSync: (...args) => metadata(fs.lstatSync(...args)),
      fstatSync: (...args) => metadata(fs.fstatSync(...args)) });
    const guarded = createPublicStaticRepresentationCache({ root, files: ['edit.js'], fs: fixed });
    const first = guarded.read('edit.js', 'br'); write('edit.js', 'B'.repeat(1200));
    const next = guarded.read('edit.js', 'br');
    assert.notEqual(next.etag, first.etag);
    assert.equal(zlib.brotliDecompressSync(next.body).toString(), 'B'.repeat(1200));
  });
  check('disk read failure cannot return a prior successful cached representation', () => {
    write('failure.js', source); let fail = false;
    const guarded = createPublicStaticRepresentationCache({ root, files: ['failure.js'],
      fs: io({ readFileSync: fd => { if (fail) throw Error('synthetic read failure'); return fs.readFileSync(fd); } }) });
    guarded.read('failure.js', 'br'); fail = true;
    assert.throws(() => guarded.read('failure.js', 'br'), /read failure/);
    assert.equal(guarded.stats().entries, 0);
    assert.equal(guarded.stats().bytes, 0);
  });
  check('errors at every source-validation stage invalidate an existing cached success', () => {
    for (const method of ['lstatSync', 'openSync', 'fstatSync', 'readFileSync', 'closeSync']) {
      write('stage-failure.js', source); let fail = false;
      const guarded = createPublicStaticRepresentationCache({ root, files: ['stage-failure.js'], fs: io({
        [method](...args) {
          if (fail) {
            if (method === 'closeSync') fs.closeSync(...args);
            throw Error('synthetic ' + method + ' failure');
          }
          return fs[method](...args);
        }
      }) });
      guarded.read('stage-failure.js', 'br'); fail = true;
      assert.throws(() => guarded.read('stage-failure.js', 'br'), new RegExp(method + ' failure'));
      assert.equal(guarded.stats().entries, 0); assert.equal(guarded.stats().bytes, 0);
    }
  });
  check('missing source never receives a cached success or 304 validator', () => {
    write('missing.js', source);
    const guarded = createPublicStaticRepresentationCache({ root, files: ['missing.js'] });
    guarded.read('missing.js', 'br'); fs.unlinkSync(path.join(root, 'missing.js'));
    assert.throws(() => guarded.read('missing.js', 'br'));
    assert.equal(guarded.stats().entries, 0);
  });
  check('a changed pathname identity during the held read is refused and its handle closed', () => {
    write('replaced.js', source); write('replacement.js', 'replacement source'); let closed = 0, read = false;
    const guarded = createPublicStaticRepresentationCache({ root, files: ['replaced.js'], fs: io({
      // A deterministic replacement-identity fixture also runs on Windows,
      // where replacing an open file itself is denied by the filesystem.
      lstatSync(file, options) { return fs.lstatSync(read ? path.join(root, 'replacement.js') : file, options); },
      readFileSync(fd) { const value = fs.readFileSync(fd); read = true; return value; },
      closeSync(fd) { closed++; fs.closeSync(fd); } }) });
    assert.throws(() => guarded.read('replaced.js', 'br'), /changed while reading/);
    assert.equal(closed, 1); assert.equal(guarded.stats().entries, 0);
  });
  check('a settled source replacement invalidates the old representation', () => {
    write('settled.js', source); write('settled-next.js', 'different replacement source'.repeat(40));
    const guarded = createPublicStaticRepresentationCache({ root, files: ['settled.js'] });
    const first = guarded.read('settled.js', 'br');
    fs.unlinkSync(path.join(root, 'settled.js')); fs.renameSync(path.join(root, 'settled-next.js'), path.join(root, 'settled.js'));
    const next = guarded.read('settled.js', 'br'); assert.notEqual(next.etag, first.etag);
    assert.equal(zlib.brotliDecompressSync(next.body).toString(), 'different replacement source'.repeat(40));
  });
  check('a source change during compression is refused before serving or caching', () => {
    write('during-codec.js', source);
    const guarded = createPublicStaticRepresentationCache({ root, files: ['during-codec.js'], zlib: {
      brotliCompressSync(body) { const output = zlib.brotliCompressSync(body);
        write('during-codec.js', 'changed during compression'); return output; } } });
    assert.throws(() => guarded.read('during-codec.js', 'br'), /changed before serving/);
    assert.equal(guarded.stats().entries, 0);
  });
  check('changed held-file metadata refuses inconsistent bytes', () => {
    write('unstable.js', source); let calls = 0;
    const guarded = createPublicStaticRepresentationCache({ root, files: ['unstable.js'], fs: io({
      fstatSync(...args) { const stat = fs.fstatSync(...args); if (++calls === 2) stat.ctimeNs++; return stat; } }) });
    assert.throws(() => guarded.read('unstable.js', 'br'), /changed while reading/);
    assert.equal(guarded.stats().entries, 0);
  });
  check('nonregular or linked public paths are refused before opening', () => {
    let opened = false;
    const guarded = createPublicStaticRepresentationCache({ root, files: ['public.js'], fs: io({
      lstatSync() { return { isFile: () => false, isSymbolicLink: () => true }; },
      openSync() { opened = true; throw Error('must not open'); } }) });
    assert.throws(() => guarded.read('public.js', 'br'), /regular file/); assert.equal(opened, false);
  });
  check('entry LRU eviction honors recent hits while preserving complete responses', () => {
    ['a.js', 'b.js', 'c.js'].forEach(name => write(name, source)); const counted = codec();
    const guarded = createPublicStaticRepresentationCache({ root, files: ['a.js', 'b.js', 'c.js'], maxEntries: 2, zlib: counted });
    for (const name of ['a.js', 'b.js', 'a.js', 'c.js', 'a.js'])
      assert.deepEqual(zlib.gunzipSync(guarded.read(name, 'gzip').body), source);
    assert.equal(counted.calls.gzip, 3); assert.equal(guarded.stats().entries, 2);
    guarded.read('b.js', 'gzip'); assert.equal(counted.calls.gzip, 4);
  });
  check('byte budget eviction remains bounded and serves full identity bytes', () => {
    ['byte-a.js', 'byte-b.js'].forEach(name => write(name, source));
    const guarded = createPublicStaticRepresentationCache({ root, files: ['byte-a.js', 'byte-b.js'], maxBytes: source.length + 1 });
    assert.deepEqual(guarded.read('byte-a.js', null).body, source);
    assert.deepEqual(guarded.read('byte-b.js', null).body, source);
    assert.equal(guarded.stats().entries, 1); assert.equal(guarded.stats().bytes, source.length);
  });
  check('oversize source bypasses caching without reducing functionality', () => {
    const counted = codec();
    const guarded = createPublicStaticRepresentationCache({ root, files: ['public.js'], maxFileBytes: 32, zlib: counted });
    for (let i = 0; i < 2; i++) assert.ok(zlib.gunzipSync(guarded.read('public.js', 'gzip').body).length > 32);
    assert.equal(counted.calls.gzip, 2); assert.equal(guarded.stats().entries, 0);
  });
  check('an oversize representation bypasses caching but still returns all bytes', () => {
    const random = crypto.randomBytes(1024); write('random.js', random);
    const guarded = createPublicStaticRepresentationCache({ root, files: ['random.js'], maxBytes: 100 });
    assert.deepEqual(zlib.gunzipSync(guarded.read('random.js', 'gzip').body), random);
    assert.equal(guarded.stats().entries, 0);
  });
  check('small files keep identity encoding and exact original bytes', () => {
    const small = Buffer.from('tiny public asset'); write('small.js', small); const counted = codec();
    const guarded = createPublicStaticRepresentationCache({ root, files: ['small.js'], zlib: counted });
    const value = guarded.read('small.js', 'br'); assert.equal(value.encoding, null);
    assert.deepEqual(value.body, small); assert.deepEqual(counted.calls, { br: 0, gzip: 0 });
  });
  check('compression failure falls back to current identity bytes, not old compressed bytes', () => {
    write('codec.js', source); let fail = false;
    const guarded = createPublicStaticRepresentationCache({ root, files: ['codec.js'], zlib: {
      brotliCompressSync(body) { if (fail) throw Error('codec failure'); return zlib.brotliCompressSync(body); } } });
    guarded.read('codec.js', 'br'); fail = true; const changed = Buffer.from('updated codec source'.repeat(90)); write('codec.js', changed);
    const value = guarded.read('codec.js', 'br'); assert.equal(value.encoding, null); assert.deepEqual(value.body, changed);
  });

  write('public.js', source); write('dsh-lite.html', source);
  const countedServe = codec();
  const routes = { '/public.js': { file: 'public.js', type: 'application/javascript', noCache: true, swAllowed: true } };
  const gatewaySource = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  const box = { Buffer, PWA_DIR: root, PWA_ROUTES: routes,
    phonePagePolicy: { headersFor: () => ({ 'content-security-policy': 'fixture policy', 'x-frame-options': 'DENY' }) },
    require(name) { assert.equal(name, './public-static-representation-cache.js');
      return { createPublicStaticRepresentationCache: options => createPublicStaticRepresentationCache({ ...options, zlib: countedServe }) }; } };
  vm.createContext(box); vm.runInContext(extractFunction(gatewaySource, 'servePwa'), box);
  function get(encoding = '', validator = '', method = 'GET', route = routes['/public.js']) {
    const res = response(); box.servePwa({ method, headers: { 'accept-encoding': encoding, 'if-none-match': validator } }, res, route); return res;
  }
  const first = get('br');
  check('actual servePwa uses cached exact representations for warm conditional responses', () => {
    const next = get('br', '"another", W/' + first.headers.etag);
    assert.equal(next.status, 304); assert.equal(next.body.length, 0);
    assert.equal(next.headers['content-length'], undefined); assert.equal(countedServe.calls.br, 1);
    assert.equal(next.headers.etag, first.headers.etag); assert.equal(next.headers.vary, 'Accept-Encoding');
    assert.equal(next.headers['service-worker-allowed'], '/'); assert.equal(next.headers['cache-control'], 'no-cache');
  });
  check('actual servePwa preserves HEAD, wildcard and encoding-specific validation', () => {
    assert.equal(get('br', '*').status, 304);
    const head = get('br', '', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], first.body.length);
    assert.equal(get('gzip', first.headers.etag).status, 200);
    assert.equal(get('br', '*', 'POST').status, 200);
  });
  check('actual Lite shell retains its security policy on cached 200 and 304 responses', () => {
    const route = { file: 'dsh-lite.html', type: 'text/html', noCache: true };
    const first = get('br', '', 'GET', route); const next = get('br', first.headers.etag, 'GET', route);
    for (const value of [first, next]) {
      assert.equal(value.headers['content-security-policy'], 'fixture policy'); assert.equal(value.headers['x-frame-options'], 'DENY');
    }
    assert.equal(next.status, 304);
  });
  check('actual servePwa cannot cache or read a private/dynamic route filename', () => {
    const denied = get('br', '', 'GET', { file: 'config.json', type: 'application/json' });
    assert.equal(denied.status, 404); assert.equal(denied.body.toString(), 'missing config.json');
  });
  check('actual servePwa never issues a stale 304 after source disappearance', () => {
    fs.unlinkSync(path.join(root, 'public.js')); const next = get('br', first.headers.etag);
    assert.equal(next.status, 404); assert.equal(next.headers.etag, undefined);
  });
  console.log(JSON.stringify({ passed: true, checks, networkUsed: false, nativeActions: false, privateConfigRead: false }));
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), parent);
  assert.match(path.basename(resolved), /^\.public-cache-test-[a-z0-9]+$/i);
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true });
}
