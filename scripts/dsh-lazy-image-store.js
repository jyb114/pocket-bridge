'use strict';

// Only rc.2 HTML that names both verified plug-in responses receives a fresh
// query key. The key avoids old browser/SW caches of the original large code.
// The DSH upstream never sees it; the gateway strips it before forwarding.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lazyImages = require('./dsh-lazy-images.js');

const MARKER = 'bridgeLazyImages=1';
const BATCH_REV = lazyImages.KNOWN_REV;
const ACCOUNT_REV = lazyImages.KNOWN_ACCOUNT_REV;
const IMAGE_PATH = /^\/__bridge\/dsh-image\/([0-9a-f]{64})\.png$/;

function rewriteKnownHtml(html) {
  if (typeof html !== 'string' ||
      (html.match(new RegExp(`rev=${BATCH_REV}`, 'g')) || []).length !== 2 ||
      (html.match(new RegExp(`rev=${ACCOUNT_REV}`, 'g')) || []).length !== 1 ||
      !html.includes('@deepseek-ai/dsh-client-ui-settings-account/client.js')) return html;
  return html
    .replace(`&amp;rev=${BATCH_REV}`, `&amp;rev=${BATCH_REV}&amp;${MARKER}`)
    .replace(`&rev=${BATCH_REV}`, `&rev=${BATCH_REV}&${MARKER}`)
    .replace(`&rev=${ACCOUNT_REV}`, `&rev=${ACCOUNT_REV}&${MARKER}`);
}

function originalModuleUrl(requestUrl) {
  if (typeof requestUrl !== 'string' || !lazyImages.isKnownBatchUrl(requestUrl) ||
      !new RegExp(`&${MARKER}(?:&|$)`).test(requestUrl)) return null;
  return requestUrl.replace(new RegExp(`&${MARKER}(?=&|$)`), '');
}

function imageDigestFromPath(pathname) {
  const match = String(pathname || '').match(IMAGE_PATH);
  return match ? match[1] : null;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function storeImages(directory, images) {
  if (!Array.isArray(images) || images.length !== 8) throw new Error('unexpected image set');
  fs.mkdirSync(directory, { recursive: true });
  for (const image of images) {
    if (!image || !Buffer.isBuffer(image.body) || !/^[0-9a-f]{64}$/.test(image.sha256) ||
        image.path !== `/__bridge/dsh-image/${image.sha256}.png` ||
        digest(image.body) !== image.sha256) throw new Error('image integrity mismatch');
    const target = path.join(directory, `${image.sha256}.png`);
    if (fs.existsSync(target)) {
      if (digest(fs.readFileSync(target)) !== image.sha256) throw new Error('stored image integrity mismatch');
      continue;
    }
    const staged = path.join(directory, `.${image.sha256}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(staged, image.body, { flag: 'wx' });
      try { fs.renameSync(staged, target); }
      catch (error) {
        if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== image.sha256) throw error;
      }
    } finally {
      try { fs.unlinkSync(staged); } catch (_) { }
    }
  }
}

function readImage(directory, pathname) {
  const wanted = imageDigestFromPath(pathname);
  if (!wanted) return null;
  try {
    const bytes = fs.readFileSync(path.join(directory, `${wanted}.png`));
    return digest(bytes) === wanted ? bytes : null;
  } catch (_) { return null; }
}

module.exports = { MARKER, rewriteKnownHtml, originalModuleUrl, imageDigestFromPath, storeImages, readImage };
