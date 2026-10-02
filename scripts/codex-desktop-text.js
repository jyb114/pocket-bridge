'use strict';
const crypto = require('node:crypto');

// Clipboard proof v1 normalizes CRLF to LF and preserves every actual user
// newline/space. It never trims text or treats a prefix as a delivery match.
function normalizeComposerText(text) { return text.replace(/\r\n/g, '\n'); }
function verifyComposerTextProof(proof, requestedText) {
  try {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof requestedText !== 'string' ||
        Object.keys(proof).length !== 3 || Object.keys(proof).some(key => !['version', 'sha256', 'utf8Bytes'].includes(key)) ||
        proof.version !== 1 || typeof proof.sha256 !== 'string' || proof.sha256.length !== 64 ||
        !/^[0-9a-f]{64}$/.test(proof.sha256) || !Number.isSafeInteger(proof.utf8Bytes)) return null;
    const bytes = Buffer.from(normalizeComposerText(requestedText), 'utf8');
    if (proof.utf8Bytes !== bytes.length || proof.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) return null;
    return { version: 1, sha256: proof.sha256, utf8Bytes: proof.utf8Bytes };
  } catch (_) { return null; }
}
module.exports = { normalizeComposerText, verifyComposerTextProof };
