'use strict';

// Exercise the gateway's actual file sender with real temporary files and
// loopback HTTP. No installed Codex, production gateway, or real keys are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const e2ee = require('./e2ee');
const { extractFunction } = require('./page-source');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const senderSource = ['e2eeSecretOrNull', 'refuseEncryptionUnavailable', 'sendFile'].map(name => {
  const implementation = extractFunction(source, name);
  assert.ok(implementation, `actual ${name} function missing`);
  return implementation;
}).join('\n');
const secret = 'example-codex-file-content-test-key';
const sendFile = vm.runInNewContext(senderSource + '; sendFile', {
  fs, path, e2ee, log() {}, e2eeBridge: { readSecret: () => secret }
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-codex-file-content-'));
const entries = new Map();
let server, checks = 0;

function fixture(name, type, bytes) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  entries.set(name, { file, type, bytes: Buffer.from(bytes) });
}
async function get(name, encrypted) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port,
      path: '/' + encodeURIComponent(name) + (encrypted ? '?encrypted=1' : ''), timeout: 3000 }, res => {
      const pieces = [];
      res.on('data', data => pieces.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(pieces) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('isolated file response timed out')));
  });
}
function check(label, test) { test(); checks++; console.log('PASS ' + label); }
function decrypt(result) {
  for (const key of e2ee.candidateKeys(secret)) {
    const plain = e2ee.decrypt(key.b, result.body);
    if (plain) return plain;
  }
  throw new Error('file response did not authenticate');
}

(async () => {
  const marker = 'pb-disposable-script-marker';
  const active = [
    ['image.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.' + marker + '=true</script></svg>'],
    ['upper.SVG', 'image/png', '<svg xmlns="http://www.w3.org/2000/svg" onload="window.' + marker + '=true"/>'],
    ['page.html', 'text/html', '<script>window.' + marker + '=true</script>'],
    ['page.htm', 'text/plain', '<script>window.' + marker + '=true</script>'],
    ['page.xhtml', 'application/xhtml+xml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>window.' + marker + '=true</script></html>'],
    ['style.xml', 'application/xml', '<?xml version="1.0"?><marker>' + marker + '</marker>'],
    ['code.mjs', 'application/javascript', 'window.' + marker + '=true;'],
    ['mime-override.txt', 'IMAGE/SVG+XML; charset=utf-8', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.' + marker + '=true</script></svg>']
  ];
  for (const [name, type, bytes] of active) fixture(name, type, Buffer.from(bytes));
  // This suite checks response policy and byte preservation, not image
  // decoding. Use harmless binary markers for the raster MIME variants.
  const rasters = [
    ['image.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['image.jpg', 'image/jpeg', Buffer.from([255, 216, 255, 224, 255, 217])],
    ['image.gif', 'image/gif', Buffer.from('GIF89a')],
    ['image.webp', 'image/webp', Buffer.from('RIFF\0\0\0\0WEBP')]
  ];
  for (const item of rasters) fixture(...item);
  fixture('notes.txt', 'text/plain; charset=utf-8', Buffer.from('harmless notes'));
  fixture('archive.bin', 'application/octet-stream', Buffer.from([1, 2, 3, 4]));

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const entry = entries.get(decodeURIComponent(url.pathname.slice(1)));
    if (!entry) { res.writeHead(404); res.end(); return; }
    sendFile(res, entry.file, entry.type, url.searchParams.get('encrypted') === '1');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  for (const [name] of active) {
    const plain = await get(name, false), encrypted = await get(name, true);
    check(name + ' stays inert in direct and encrypted file responses', () => {
      assert.equal(plain.status, 200); assert.equal(encrypted.status, 200);
      assert.equal(plain.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(encrypted.headers['content-type'], 'application/octet-stream');
      assert.equal(encrypted.headers['x-dsh-e2ee'], '1');
      assert.equal(encrypted.headers['x-dsh-e2ee-type'], 'text/plain; charset=utf-8');
      for (const value of [plain, encrypted]) {
        assert.match(value.headers['content-disposition'], /^attachment(?:;|$)/);
        assert.equal(value.headers['x-content-type-options'], 'nosniff');
        assert.match(value.headers['content-security-policy'], /(?:^|;)\s*sandbox(?:;|$)/);
      }
      assert.equal(encrypted.headers['content-disposition'], 'attachment', 'encrypted headers must not expose a filename');
      assert.ok(!encrypted.body.includes(Buffer.from(marker)));
      assert.deepEqual(plain.body, entries.get(name).bytes);
      assert.deepEqual(decrypt(encrypted), entries.get(name).bytes);
    });
  }

  for (const [name, type] of rasters) {
    const plain = await get(name, false), encrypted = await get(name, true);
    check(name + ' keeps raster MIME, inline disposition, encryption, and exact bytes', () => {
      assert.equal(plain.status, 200); assert.equal(encrypted.status, 200);
      assert.equal(plain.headers['content-type'], type);
      assert.equal(encrypted.headers['x-dsh-e2ee-type'], type);
      assert.match(plain.headers['content-disposition'], /^inline;/);
      assert.equal(encrypted.headers['content-disposition'], 'inline');
      assert.equal(plain.headers['x-content-type-options'], 'nosniff');
      assert.equal(encrypted.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(plain.body, entries.get(name).bytes);
      assert.deepEqual(decrypt(encrypted), entries.get(name).bytes);
    });
  }
  const notes = await get('notes.txt', false), archive = await get('archive.bin', true);
  check('ordinary text remains readable; binary downloads stay encrypted attachments', () => {
    assert.equal(notes.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(notes.headers['content-disposition'], /^inline;/);
    assert.equal(archive.headers['content-disposition'], 'attachment');
    assert.equal(archive.headers['x-dsh-e2ee-type'], 'application/octet-stream');
    assert.deepEqual(decrypt(archive), entries.get('archive.bin').bytes);
  });
  console.log(checks + ' real HTTP/file response security groups passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  const actual = path.resolve(directory), parent = path.resolve(os.tmpdir());
  if (path.dirname(actual) !== parent || !path.basename(actual).startsWith('pb-codex-file-content-'))
    throw new Error('unsafe temporary cleanup path');
  fs.rmSync(actual, { recursive: true, force: true });
});
