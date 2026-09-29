'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const adapter = require('./dsh-adapter.js');
let checks = 0;
function check(label, fn) { fn(); checks++; console.log(`PASS ${label}`); }

function archiveFixture(version, options = {}) {
  const body = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version }));
  const padding = Buffer.from('body-prefix');
  const entry = { size: body.length, offset: String(padding.length), ...(options.entry || {}) };
  const tree = Buffer.from(JSON.stringify({ files: { 'package.json': entry } }));
  const headerSize = 8 + Math.ceil(tree.length / 4) * 4;
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4);
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize - 4, 0); header.writeUInt32LE(tree.length, 4); tree.copy(header, 8);
  return Buffer.concat([prefix, header, padding, body]);
}

function nestedArchiveFixture(packages) {
  const files = {}, bodies = []; let offset = 0;
  for (const [location, version] of Object.entries(packages)) {
    const body = Buffer.from(JSON.stringify({ version }));
    const entry = { size: body.length, offset: String(offset) };
    if (location === 'root') files['package.json'] = entry;
    else files[location] = { files: { 'package.json': entry } };
    bodies.push(body); offset += body.length;
  }
  const tree = Buffer.from(JSON.stringify({ files }));
  const size = 8 + Math.ceil(tree.length / 4) * 4;
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(size, 4);
  const header = Buffer.alloc(size); header.writeUInt32LE(size - 4, 0); header.writeUInt32LE(tree.length, 4); tree.copy(header, 8);
  return Buffer.concat([prefix, header, ...bodies]);
}

function memoryFs(files) {
  const reads = [], opens = [], closes = [];
  const lookup = name => {
    const content = files[name];
    if (content === undefined) throw new Error('ENOENT');
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  };
  return {
    reads, opens, closes,
    statSync: name => ({ size: lookup(name).length }),
    openSync: name => { lookup(name); opens.push(name); return name; },
    closeSync: name => { closes.push(name); },
    readFileSync: (name, encoding) => lookup(name).toString(encoding),
    readSync: (name, buffer, offset, length, position) => {
      reads.push({ name, length, position });
      const content = lookup(name);
      return content.copy(buffer, offset, position, Math.min(position + length, content.length));
    }
  };
}

function fakeRequest(result, options = {}) {
  const observed = [];
  const request = (opts, callback) => {
    observed.push(opts);
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      process.nextTick(() => {
        if (options.error) { req.emit('error', new Error('fixture failure')); return; }
        if (options.timeout) { req.emit('timeout'); return; }
        const res = new EventEmitter();
        res.statusCode = result.statusCode; res.headers = result.headers || {};
        res.complete = true; res.destroy = () => { res.destroyed = true; };
        callback(res);
        for (const chunk of result.chunks || [result.body || '']) res.emit('data', chunk);
        res.emit('end'); res.emit('close');
      });
    };
    return req;
  };
  return { request, observed };
}

(async () => {
  check('version normalization retains release candidate', () => assert.equal(adapter.normalizeVersion(' v0.1.7-rc.2 '), '0.1.7-rc.2'));
  check('version labels reject unbounded shell-like input', () => assert.equal(adapter.normalizeVersion('0.1.7 && other'), null));
  check('invalid ports excluded', () => { for (const p of [0, -1, 65536, '1234', NaN]) assert.equal(adapter.validPort(p), false); });

  const archive = archiveFixture('0.1.7-rc.2');
  const io = memoryFs({ '/app.asar': archive });
  check('ASAR package data begins at 8 + full header pickle size', () => assert.equal(adapter.readAsarVersion('/app.asar', { fs: io }), '0.1.7-rc.2'));
  check('ASAR reading stays bounded and closes descriptor', () => {
    assert.equal(io.opens.length, 1); assert.equal(io.closes.length, 1);
    assert.equal(io.reads.length, 3); assert.equal(io.reads[0].length, 8);
  });
  check('nested dsh package version takes precedence over wrapper metadata', () => assert.equal(adapter.readAsarVersion('/nested', { fs: memoryFs({ '/nested': nestedArchiveFixture({ root: '0.0.0', app: '0.1.1-rc.2', dsh: '0.1.7-rc.2' }) }) }), '0.1.7-rc.2'));
  check('nested app package supported before root wrapper', () => assert.equal(adapter.readAsarVersion('/nested', { fs: memoryFs({ '/nested': nestedArchiveFixture({ root: '0.0.0', app: '0.1.1-rc.2' }) }) }), '0.1.1-rc.2'));
  check('invalid nested version falls back to next known package', () => assert.equal(adapter.readAsarVersion('/nested', { fs: memoryFs({ '/nested': nestedArchiveFixture({ dsh: 'invalid', app: '0.1.1-rc.2' }) }) }), '0.1.1-rc.2'));
  check('truncated ASAR rejects', () => assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': archive.subarray(0, archive.length - 2) }) }), null));
  check('oversized ASAR header rejects before allocation', () => {
    const bad = Buffer.from(archive); bad.writeUInt32LE(32 * 1024 * 1024, 4);
    const data = memoryFs({ '/bad': bad }); assert.equal(adapter.readAsarVersion('/bad', { fs: data }), null); assert.equal(data.reads.length, 1);
  });
  check('wrong outer pickle size rejects', () => { const bad = Buffer.from(archive); bad.writeUInt32LE(8, 0); assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': bad }) }), null); });
  check('wrong header payload size rejects', () => { const bad = Buffer.from(archive); bad.writeUInt32LE(1, 8); assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': bad }) }), null); });
  check('unpacked ASAR entry does not read an unrelated file', () => assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': archiveFixture('0.1.7-rc.2', { entry: { unpacked: true } }) }) }), null));
  check('ASAR link entries reject', () => assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': archiveFixture('0.1.7-rc.2', { entry: { link: '../../elsewhere' } }) }) }), null));
  check('unsafe ASAR entry offset rejects', () => assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': archiveFixture('0.1.7-rc.2', { entry: { offset: '9007199254740992' } }) }) }), null));
  check('ASAR negative offset rejects', () => assert.equal(adapter.readAsarVersion('/bad', { fs: memoryFs({ '/bad': archiveFixture('0.1.7-rc.2', { entry: { offset: '-1' } }) }) }), null));

  const desktopIo = memoryFs({ 'D:\\Apps\\DSH\\resources\\app.asar': archive, 'D:\\Apps\\DSH\\resources\\app\\package.json': '{"version":"0.1.1-rc.2"}' });
  check('actual desktop adjacent ASAR wins over unpacked package', () => { const v = adapter.readDesktopVersion('D:\\Apps\\DSH\\DeepSeek Harness.exe', { fs: desktopIo }); assert.equal(v.version, '0.1.7-rc.2'); assert.equal(v.source, 'desktop-asar'); });
  check('unpacked desktop fallback reads adjacent metadata', () => assert.equal(adapter.readDesktopVersion('/app/dsh', { fs: memoryFs({ '/app/resources/app/package.json': '{"version":"0.1.1-rc.2"}' }) }).version, '0.1.1-rc.2'));
  check('macOS actual bundle Resources supported', () => assert.equal(adapter.readDesktopVersion('/DSH.app/Contents/MacOS/DSH', { fs: memoryFs({ '/DSH.app/Contents/Resources/app.asar': archive }) }).version, '0.1.7-rc.2'));
  check('CLI package version metadata is separate from desktop', () => assert.equal(adapter.readCliVersion('/cli/package.json', { fs: memoryFs({ '/cli/package.json': '{"version":"0.1.5-rc.3"}' }) }).source, 'cli-package'));
  check('package JSON without valid version rejects', () => assert.equal(adapter.readCliVersion('/cli/package.json', { fs: memoryFs({ '/cli/package.json': '{"version":"latest"}' }) }).version, null));

  check('desktop process with spaced executable', () => assert.equal(adapter.parseDshProcess({ name: 'DeepSeek Harness.exe', executablePath: 'D:\\Apps\\DeepSeek Harness.exe' }).kind, 'desktop'));
  check('npx scoped DSH web detected', () => assert.equal(adapter.parseDshProcess({ commandLine: 'npx @deepseek-ai/dsh web' }).kind, 'cli'));
  check('npx pinned version detected', () => assert.equal(adapter.parseDshProcess({ commandLine: 'npx @deepseek-ai/dsh@0.1.5-rc.3 web' }).advertisedVersion, '0.1.5-rc.3'));
  check('npm exec package form detected', () => assert.equal(adapter.parseDshProcess({ commandLine: 'npm exec --package=@deepseek-ai/dsh -- dsh web' }).kind, 'cli'));
  check('npm process under node detected', () => assert.equal(adapter.parseDshProcess({ name: 'node.exe', commandLine: '"C:\\node.exe" "C:\\npm-cli.js" exec -- @deepseek-ai/dsh web' }).kind, 'cli'));
  check('installed CLI node entry path detected and locates package', () => {
    const r = adapter.parseDshProcess({ name: 'node.exe', commandLine: '"C:\\node.exe" "D:\\cache\\node_modules\\@deepseek-ai\\dsh\\dist\\cli.js" web' });
    assert.equal(r.kind, 'cli'); assert.equal(r.packageJsonPath, 'D:\\cache\\node_modules\\@deepseek-ai\\dsh\\package.json');
  });
  check('standalone dsh web entry detected', () => assert.equal(adapter.parseDshProcess({ commandLine: 'dsh web --port 20000' }).kind, 'cli'));
  check('bare args for standalone CLI process supported', () => assert.equal(adapter.parseDshProcess({ name: 'dsh', args: ['web'] }).kind, 'cli'));
  check('bare args for node CLI process supported', () => assert.equal(adapter.parseDshProcess({ name: 'node', args: ['/npm/node_modules/@deepseek-ai/dsh/dist/cli.js', 'web'] }).kind, 'cli'));
  check('non-web CLI task excluded', () => assert.equal(adapter.parseDshProcess({ commandLine: 'npx @deepseek-ai/dsh chat' }), null));
  check('near-name npm packages excluded', () => assert.equal(adapter.parseDshProcess({ commandLine: 'npx @deepseek-ai/dsh-other web' }), null));
  check('unrelated node argument mentioning DSH excluded', () => assert.equal(adapter.parseDshProcess({ commandLine: 'node server.js D:/cache/node_modules/@deepseek-ai/dsh/dist/cli.js web' }), null));
  check('inline node code is not a CLI entry', () => assert.equal(adapter.parseDshProcess({ commandLine: 'node -e "D:/cache/node_modules/@deepseek-ai/dsh/dist/cli.js" web' }), null));
  check('generic node web server excluded', () => assert.equal(adapter.parseDshProcess({ commandLine: 'node web server.js' }), null));

  const auth = { statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'dsh web authentication required' };
  const html = { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>DeepSeek Harness</title><script type="module" src="./assets/index-abc.js"></script>' };
  check('exact DSH unauthenticated challenge confirms identity', () => assert.equal(adapter.fingerprintDshHttp(auth).identified, true));
  check('official rc.2 complete authentication challenge confirms identity', () => assert.equal(adapter.fingerprintDshHttp({ ...auth, body: 'dsh web authentication required; reopen the URL printed by dsh web.\n' }).identified, true));
  check('unrecognized authentication suffix is not accepted', () => assert.equal(adapter.fingerprintDshHttp({ ...auth, body: 'dsh web authentication required; arbitrary external text' }).identified, false));
  check('HTML with actual app title and assets confirms identity', () => assert.equal(adapter.fingerprintDshHttp(html).identified, true));
  check('generic HTML 200 excluded', () => assert.equal(adapter.fingerprintDshHttp({ ...html, body: '<html><title>Dashboard</title></html>' }).identified, false));
  check('DSH word in arbitrary error page excluded', () => assert.equal(adapter.fingerprintDshHttp({ ...html, body: '<html>DSH is unavailable</html>' }).identified, false));
  check('bare DSH title without application marker excluded', () => assert.equal(adapter.fingerprintDshHttp({ ...html, body: '<title>DeepSeek Harness</title>' }).identified, false));
  check('weak ./ redirect excluded', () => assert.equal(adapter.fingerprintDshHttp({ statusCode: 303, headers: { location: './' }, body: '' }).identified, false));
  check('auth phrase inside unrelated content excluded', () => assert.equal(adapter.fingerprintDshHttp({ ...auth, body: '<html>dsh web authentication required: external error</html>' }).identified, false));

  check('modern bootstrap metadata names actual stream and event separately', () => { assert.equal(adapter.PROFILES['remote-mux'].bootstrapStream, '$events'); assert.equal(adapter.PROFILES['remote-mux'].bootstrapEvent, 'ready'); });
  check('verified legacy build selects events adapter', () => assert.equal(adapter.detectProfile({ version: '0.1.0-rc.8' }).profile, 'legacy-events'));
  check('verified second legacy build selects events adapter', () => assert.equal(adapter.detectProfile({ version: '0.1.1-rc.2' }).profile, 'legacy-events'));
  check('verified earlier CLI release selects modern adapter', () => assert.equal(adapter.detectProfile({ kind: 'cli', version: '0.1.5-rc.3' }).profile, 'remote-mux'));
  check('current npm web release selects modern adapter', () => assert.equal(adapter.detectProfile({ kind: 'cli', version: '0.1.7-rc.2' }).profile, 'remote-mux'));
  check('desktop rc.3 IPC-only build does not select CLI web transport', () => { const p = adapter.detectProfile({ kind: 'desktop', version: '0.1.5-rc.3' }); assert.equal(p.profile, 'desktop-ipc'); assert.equal(p.supported, false); });
  check('same rc.3 version with unknown runtime kind requires inspection', () => assert.equal(adapter.detectProfile({ version: '0.1.5-rc.3' }).supported, false));
  check('observed active web capabilities override desktop version fallback', () => assert.equal(adapter.detectProfile({ kind: 'desktop', version: '0.1.5-rc.3', capabilities: { remoteMux: true } }).profile, 'remote-mux'));
  check('verified desktop rc.2 selects modern adapter', () => assert.equal(adapter.detectProfile({ version: '0.1.7-rc.2' }).profile, 'remote-mux'));
  check('unknown future build not silently assumed compatible', () => assert.equal(adapter.detectProfile({ version: '9.0.0' }).supported, false));
  check('unknown build can use observed modern capabilities', () => assert.equal(adapter.detectProfile({ version: '9.0.0', bundleText: 'connect("/api/remote.mux"); workspace.follow' }).profile, 'remote-mux'));
  check('old version label cannot override active modern endpoint', () => assert.equal(adapter.detectProfile({ version: '0.1.0-rc.8', capabilities: { remoteMux: true } }).profile, 'remote-mux'));
  check('legacy endpoint pair observed in native bundle', () => assert.equal(adapter.detectProfile({ bundleText: '/api/events.mux /api/events.host host.describe' }).profile, 'legacy-events'));
  check('single legacy endpoint insufficient capability evidence', () => assert.equal(adapter.detectProfile({ bundleText: '/api/events.mux' }).supported, false));
  check('conflicting protocol capabilities require explicit inspection', () => assert.equal(adapter.detectProfile({ capabilities: { remoteMux: true, legacyEvents: true } }).supported, false));
  check('legacy version with modern auth conflicts safely', () => assert.equal(adapter.detectProfile({ version: '0.1.1-rc.2', capabilities: { browserAuth: true } }).supported, false));

  check('unified desktop record prefers actual installed version', () => {
    const r = adapter.createRuntimeRecord({ process: { name: 'DeepSeek Harness.exe', executablePath: 'D:\\Apps\\DSH\\DeepSeek Harness.exe' }, version: '0.1.0-rc.8', port: 19387, httpResponse: auth }, { fs: desktopIo });
    assert.equal(r.kind, 'desktop'); assert.equal(r.version, '0.1.7-rc.2'); assert.equal(r.profile, 'remote-mux'); assert.equal(r.port, 19387); assert.equal(r.confidence, 'high'); assert.equal(r.versionSource, 'desktop-asar');
  });
  check('unified CLI record reads own package', () => {
    const r = adapter.createRuntimeRecord({ process: { name: 'node', commandLine: 'node /npm/node_modules/@deepseek-ai/dsh/dist/cli.js web' }, port: 15555 }, { fs: memoryFs({ '/npm/node_modules/@deepseek-ai/dsh/package.json': '{"version":"0.1.5-rc.3"}' }) });
    assert.equal(r.kind, 'cli'); assert.equal(r.profile, 'remote-mux'); assert.equal(r.confidence, 'medium');
  });

  const fake = fakeRequest(auth);
  const probed = await adapter.probeDshRuntime({ port: 19387, kind: 'desktop', version: '0.1.7-rc.2' }, { request: fake.request });
  check('HTTP probe identifies modern runtime', () => { assert.equal(probed.confidence, 'high'); assert.equal(probed.profile, 'remote-mux'); assert.equal(probed.httpEvidence, 'dsh-auth-challenge'); });
  check('HTTP probe uses unauthenticated loopback GET only', () => {
    const opts = fake.observed[0]; assert.equal(opts.hostname, '127.0.0.1'); assert.equal(opts.method, 'GET'); assert.equal(opts.path, '/');
    assert.equal(opts.headers.Cookie, undefined); assert.equal(opts.headers.Authorization, undefined); assert.equal(opts.headers['Accept-Encoding'], 'identity');
  });
  const redirect = fakeRequest({ statusCode: 303, headers: { location: 'https://example.test/' }, body: '' });
  const redirectRecord = await adapter.probeDshRuntime({ port: 19387 }, { request: redirect.request });
  check('HTTP probe never follows redirects', () => { assert.equal(redirect.observed.length, 1); assert.equal(redirectRecord.identified, false); });
  const large = fakeRequest({ ...auth, body: 'x'.repeat(300) });
  const largeRecord = await adapter.probeDshRuntime({ port: 19387 }, { request: large.request, maxBodyBytes: 256 });
  check('body limit rejects response instead of trusting truncated fingerprint', () => assert.equal(largeRecord.identified, false));
  const failing = fakeRequest(auth, { error: true });
  const failed = await adapter.probeDshRuntime({ port: 19387, fingerprint: { identified: true } }, { request: failing.request });
  check('HTTP failure clears stale positive fingerprint', () => assert.equal(failed.identified, false));
  const timeout = fakeRequest(auth, { timeout: true });
  const timedOut = await adapter.probeDshRuntime({ port: 19387 }, { request: timeout.request });
  check('HTTP timeout resolves unsupported candidate without hanging', () => assert.equal(timedOut.identified, false));
  const invalid = fakeRequest(auth);
  await adapter.probeDshRuntime({ port: 65536 }, { request: invalid.request });
  check('invalid port never sends an HTTP request', () => assert.equal(invalid.observed.length, 0));
  console.log(`DSH adapter: ${checks} isolated checks passed; no live DSH processes, credentials or network used.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
