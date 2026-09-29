'use strict';

// The rc.2 DSH account plug-in embeds eight onboarding illustrations as PNG
// data URLs in its first script batch. A browser downloads all eight even when
// the onboarding screens are never shown. This pure transform replaces those
// data URLs with same-origin image URLs; the gateway may serve the returned
// PNG bytes only when the browser actually requests an illustration.
//
// Never apply a textual patch to a different DSH build. An unknown build must
// pass through unchanged until its own bundle has been inspected and tested.

const crypto = require('node:crypto');

const KNOWN_REV = '25f9d923c1e6';
const KNOWN_BODY_SHA256 = '7616dc34fa6a56416ce5f5196d576197d169eb85944953fe20e13bfc895314c0';
const KNOWN_BODY_LENGTH = 10837152;
// DSH also requests this account plug-in on its own; rewriting only the first
// preload batch would leave the single-module request needlessly expensive.
const KNOWN_ACCOUNT_REV = '14fde0ab6608';
const KNOWN_ACCOUNT_BODY_SHA256 = 'fc7f0600338976084f28bd21ed5ab40146b11e30a8cf6233d43d32751338f3c2';
const KNOWN_ACCOUNT_BODY_LENGTH = 5276781;
const KNOWN_BODIES = Object.freeze({
  [KNOWN_REV]: Object.freeze({ length: KNOWN_BODY_LENGTH, sha256: KNOWN_BODY_SHA256 }),
  [KNOWN_ACCOUNT_REV]: Object.freeze({ length: KNOWN_ACCOUNT_BODY_LENGTH, sha256: KNOWN_ACCOUNT_BODY_SHA256 }),
});
const IMAGE_ROUTE_PREFIX = '/__bridge/dsh-image/';
const EXPECTED_NAMES = new Set([
  'onboarding_welcome_default',
  'onboarding_welcome_dark_default',
  'onboarding_welcome_zh_default',
  'onboarding_welcome_zh_dark_default',
  'onboarding_recharge_default',
  'onboarding_recharge_dark_default',
  'onboarding_recharge_zh_default',
  'onboarding_recharge_zh_dark_default',
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DATA_URL_DEFINITION = /(var (onboarding_(?:welcome|recharge)(?:_zh)?(?:_dark)?_default) = ")(data:image\/png;base64,)([A-Za-z0-9+/=]+)(")/g;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPng(bytes) {
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
}

function knownBatchForUrl(requestUrl) {
  let url;
  try {
    url = new URL(requestUrl, 'http://localhost');
  } catch (_) {
    return null;
  }
  const rev = url.searchParams.get('rev');
  if (url.pathname !== '/plugins/' ||
      !url.search.includes('@deepseek-ai/dsh-client-ui-settings-account/client.js') ||
      !Object.hasOwn(KNOWN_BODIES, rev)) return null;
  return { rev, ...KNOWN_BODIES[rev] };
}

function isKnownBatchUrl(requestUrl) {
  return !!knownBatchForUrl(requestUrl);
}

// Lower-level pure rewrite, exposed so an isolated test can exercise malformed
// image and duplicate-name handling without bundling 10.8 MB of vendor code.
// Returns null unless all eight expected definitions appear exactly once.
function rewriteOnboardingDataUrls(source) {
  if (typeof source !== 'string') return null;
  const images = [];
  const seen = new Set();
  let invalid = false;
  const script = source.replace(DATA_URL_DEFINITION, (whole, prefix, name, mimePrefix, encoded, suffix) => {
    if (!EXPECTED_NAMES.has(name) || seen.has(name)) {
      invalid = true;
      return whole;
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || !isPng(bytes)) {
      invalid = true;
      return whole;
    }
    const digest = sha256(bytes);
    seen.add(name);
    images.push({ name, path: `${IMAGE_ROUTE_PREFIX}${digest}.png`, sha256: digest,
      contentType: 'image/png', body: bytes });
    return prefix + `${IMAGE_ROUTE_PREFIX}${digest}.png` + suffix;
  });
  if (invalid || seen.size !== EXPECTED_NAMES.size || images.length !== EXPECTED_NAMES.size) return null;
  if (DATA_URL_DEFINITION.test(script)) {
    DATA_URL_DEFINITION.lastIndex = 0;
    return null;
  }
  DATA_URL_DEFINITION.lastIndex = 0;
  return { script: Buffer.from(script, 'utf8'), images };
}

function planDshLazyImages(requestUrl, body) {
  const known = knownBatchForUrl(requestUrl);
  if (!known || !Buffer.isBuffer(body) ||
      body.length !== known.length || sha256(body) !== known.sha256) return null;
  const rewritten = rewriteOnboardingDataUrls(body.toString('utf8'));
  if (!rewritten) return null;
  return {
    sourceSha256: known.sha256,
    sourceRev: known.rev,
    script: rewritten.script,
    images: rewritten.images,
  };
}

module.exports = {
  KNOWN_REV,
  KNOWN_BODY_SHA256,
  KNOWN_ACCOUNT_REV,
  KNOWN_ACCOUNT_BODY_SHA256,
  IMAGE_ROUTE_PREFIX,
  isKnownBatchUrl,
  planDshLazyImages,
  rewriteOnboardingDataUrls,
};
