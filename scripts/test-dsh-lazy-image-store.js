'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./dsh-lazy-image-store.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

const BATCH = '25f9d923c1e6';
const ACCOUNT = '14fde0ab6608';
const html = `<link rel="preload" as="script" href="plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&amp;rev=${BATCH}">` +
  `<script type="application/json">{"url":"plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${ACCOUNT}",` +
  `"preload":"plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${BATCH}"}</script>`;
const marked = store.rewriteKnownHtml(html);

check('known rc.2 HTML marks all three plug-in URLs with distinct cache keys', () => {
  assert.equal((marked.match(/bridgeLazyImages=1/g) || []).length, 3);
  assert.match(marked, new RegExp(`&amp;rev=${BATCH}&amp;bridgeLazyImages=1`));
  assert.match(marked, new RegExp(`&rev=${ACCOUNT}&bridgeLazyImages=1`));
});
check('unknown build HTML remains unchanged', () => {
  assert.equal(store.rewriteKnownHtml(html.replace(BATCH, 'another-rev')), html.replace(BATCH, 'another-rev'));
  assert.equal(store.rewriteKnownHtml('<body>ordinary page</body>'), '<body>ordinary page</body>');
});
check('only known marked module URLs lose the private query before upstream', () => {
  const batch = `/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${BATCH}`;
  assert.equal(store.originalModuleUrl(batch + '&bridgeLazyImages=1'), batch);
  assert.equal(store.originalModuleUrl(batch), null);
  assert.equal(store.originalModuleUrl(batch + '&bridgeLazyImages=2'), null);
  assert.equal(store.originalModuleUrl(`/api/session/list&bridgeLazyImages=1`), null);
});

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lazy-image-store-'));
try {
  const directory = path.join(parent, 'images');
  const images = Array.from({ length: 8 }, (_, i) => {
    const body = Buffer.from(`stock-image-fixture-${i}`);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    return { sha256, body, path: `/__bridge/dsh-image/${sha256}.png` };
  });
  check('content-addressed images survive a new store read', () => {
    store.storeImages(directory, images);
    store.storeImages(directory, images);
    for (const image of images) assert.deepEqual(store.readImage(directory, image.path), image.body);
  });
  check('bad URL, missing file and changed bytes cannot be served', () => {
    assert.equal(store.readImage(directory, '/__bridge/dsh-image/../../secret.png'), null);
    assert.equal(store.readImage(directory, '/__bridge/dsh-image/' + 'a'.repeat(64) + '.png'), null);
    fs.writeFileSync(path.join(directory, `${images[0].sha256}.png`), 'tampered');
    assert.equal(store.readImage(directory, images[0].path), null);
    assert.throws(() => store.storeImages(directory, images), /integrity mismatch/);
  });
} finally {
  const resolved = path.resolve(parent);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('dsh-lazy-image-store-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

console.log(`${passed} DSH lazy image store checks passed`);
