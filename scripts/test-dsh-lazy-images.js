'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {
  KNOWN_REV,
  KNOWN_ACCOUNT_REV,
  IMAGE_ROUTE_PREFIX,
  isKnownBatchUrl,
  planDshLazyImages,
  rewriteOnboardingDataUrls,
} = require('./dsh-lazy-images');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log('✓ ' + name);
}

// Make independent, valid PNGs with random RGBA pixels. Their compressed data
// approximates the real already-compressed onboarding artwork, so gzip cannot
// hide a mistaken decision to keep embedding the pictures in JavaScript.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let i = 0; i < 32; i++) rows.push(Buffer.concat([Buffer.from([0]), crypto.randomBytes(32 * 4)]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const names = [
  'onboarding_welcome_default',
  'onboarding_welcome_dark_default',
  'onboarding_welcome_zh_default',
  'onboarding_welcome_zh_dark_default',
  'onboarding_recharge_default',
  'onboarding_recharge_dark_default',
  'onboarding_recharge_zh_default',
  'onboarding_recharge_zh_dark_default',
];
const source = names.map(name => `var ${name} = "data:image/png;base64,${png().toString('base64')}";`).join('\n') +
  '\n' + names.map(name => `void ${name};`).join('\n');

check('only the known plug-in batch URL qualifies', () => {
  assert.equal(isKnownBatchUrl(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${KNOWN_REV}`), true);
  assert.equal(isKnownBatchUrl(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${KNOWN_ACCOUNT_REV}`), true);
  assert.equal(isKnownBatchUrl(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=other`), false);
  assert.equal(isKnownBatchUrl(`/assets/index.js?rev=${KNOWN_REV}`), false);
  assert.equal(isKnownBatchUrl(`/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=${KNOWN_ACCOUNT_REV}`), false);
});
check('eight valid PNGs become same-origin, content-addressed URLs', () => {
  const out = rewriteOnboardingDataUrls(source);
  assert.ok(out);
  assert.equal(out.images.length, 8);
  assert.equal(new Set(out.images.map(x => x.path)).size, 8);
  for (const image of out.images) {
    assert.match(image.path, /^\/__bridge\/dsh-image\/[a-f0-9]{64}\.png$/);
    assert.equal(image.sha256, crypto.createHash('sha256').update(image.body).digest('hex'));
    assert.equal(image.contentType, 'image/png');
    assert.deepEqual(image.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(out.script.includes(image.path));
  }
  assert.ok(!out.script.includes('data:image/png;base64,'));
  assert.ok(IMAGE_ROUTE_PREFIX.startsWith('/'));
});
check('rewritten JavaScript still parses', () => {
  const out = rewriteOnboardingDataUrls(source);
  assert.doesNotThrow(() => new vm.Script(out.script.toString('utf8')));
});
check('the cold JavaScript transfer becomes much smaller', () => {
  const out = rewriteOnboardingDataUrls(source);
  assert.ok(zlib.gzipSync(source).length > 10 * zlib.gzipSync(out.script).length);
});
check('missing, duplicate and malformed image definitions fail closed', () => {
  assert.equal(rewriteOnboardingDataUrls(source.replace(/var onboarding_recharge_zh_dark_default = [^;]+;/, '')), null);
  assert.equal(rewriteOnboardingDataUrls(source + '\n' + source.split('\n')[0]), null);
  assert.equal(rewriteOnboardingDataUrls(source.replace('data:image/png;base64,', 'data:image/png;base64,bogus')), null);
});
check('public planner rejects a different build or body fingerprint', () => {
  assert.equal(planDshLazyImages(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${KNOWN_REV}`, Buffer.from(source)), null);
  assert.equal(planDshLazyImages(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${KNOWN_ACCOUNT_REV}`, Buffer.from(source)), null);
  assert.equal(planDshLazyImages(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=other`, Buffer.from(source)), null);
  assert.equal(planDshLazyImages(`/plugins/??@deepseek-ai/dsh-client-ui-settings-account/client.js&rev=${KNOWN_REV}`, source), null);
});

console.log(`${checks} DSH lazy image checks passed`);
