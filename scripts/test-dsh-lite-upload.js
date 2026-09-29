'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDshLiteUpload, MAX_UPLOAD_BYTES } = require('./dsh-lite-upload');

let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
function packet(data = Buffer.from('fixture'), meta = { sessionId: 's-1', name: '说明.txt' }) {
  const head = Buffer.from(JSON.stringify(meta));
  const length = Buffer.alloc(4); length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, Buffer.from(data)]);
}
async function invoke(handler, body = packet(), options = {}) {
  const bytes = Buffer.from(body);
  const req = Readable.from([bytes]);
  req.url = options.url || '/__dsh/lite-upload';
  req.method = options.method || 'POST';
  req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': options.encrypted === false ? '0' : '1',
    'content-type': options.contentType || 'application/octet-stream',
    'content-length': String(options.declaredLength ?? bytes.length) };
  const res = { status: null, headers: null, text: '', writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.text = String(text); this.writableEnded = true; } };
  await handler(req, res);
  return { status: res.status, headers: res.headers, body: JSON.parse(res.text) };
}

(async () => {
  const calls = [];
  const good = createDshLiteUpload({ callUpstream: async call => {
    calls.push(call);
    return { statusCode: 200, body: JSON.stringify({ ok: true,
      value: { receiptId: 'r-1', file: { attachmentId: 'a-1', name: '说明.txt', bytes: call.body.length } } }) };
  } });
  await check('encrypted bytes reach only fixed official session upload route', async () => {
    const response = await invoke(good);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.value.receiptId, 'r-1');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.path, '/api/session/uploadFileBinary?sessionId=s-1&name=%E8%AF%B4%E6%98%8E.txt');
    assert.equal(call.headers['content-type'], 'application/octet-stream');
    assert.equal(call.headers['accept-encoding'], 'identity');
    assert.deepEqual(call.body, Buffer.from('fixture'));
  });
  await check('unapproved methods, plaintext, MIME, names and upstream URLs fail closed', async () => {
    const before = calls.length;
    const options = [
      { method: 'GET' }, { encrypted: false }, { decrypted: false }, { contentType: 'application/json' },
      { url: '/__dsh/lite-upload?sessionId=s-1&name=x&url=http%3A%2F%2Fevil.test' },
      { declaredLength: MAX_UPLOAD_BYTES + 1 }
    ];
    for (const invalid of options) assert.ok((await invoke(good, Buffer.from('fixture'), invalid)).status >= 400);
    for (const meta of [{ sessionId: '', name: 'a' }, { sessionId: 's', name: '../bad' },
      { sessionId: 's', name: 'a\\b' }, { sessionId: 's', name: 'a', url: 'https://evil.test' }]) {
      assert.equal((await invoke(good, packet(Buffer.from('fixture'), meta))).status, 400);
    }
    assert.equal((await invoke(good, packet(Buffer.alloc(0)))).status, 400);
    assert.equal(calls.length, before);
  });
  await check('Host domain error is visible without reflecting raw details', async () => {
    const handler = createDshLiteUpload({ callUpstream: async () => ({ statusCode: 200,
      body: JSON.stringify({ ok: false, error: { code: 'attachment/unsupported', message: 'private path' } }) }) });
    const response = await invoke(handler);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: false, error: { code: 'attachment/unsupported' } });
  });
  await check('invalid upstream replies cannot masquerade as a receipt', async () => {
    const values = [
      { statusCode: 302, body: '<html>redirect</html>' },
      { statusCode: 200, body: '<script>secret</script>' },
      { statusCode: 200, body: JSON.stringify({ ok: true, value: { receiptId: 'x', file: { attachmentId: 'a', name: '../bad', bytes: 7 } } }) },
      { statusCode: 200, body: JSON.stringify({ ok: true, value: { receiptId: 'x', file: { attachmentId: 'a', name: 'a', bytes: 8 } } }) }
    ];
    for (const upstream of values) {
      const response = await invoke(createDshLiteUpload({ callUpstream: async () => upstream }));
      assert.equal(response.status, 502);
      assert.equal(JSON.stringify(response.body).includes('secret'), false);
    }
  });
  console.log('DSH lite upload: ' + checks + ' isolated groups passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
