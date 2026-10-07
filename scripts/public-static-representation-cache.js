'use strict';

// Public code/artwork only. Every lookup rereads and hashes the real source;
// this cache avoids repeat compression, not source validation or private I/O.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const LIMITS = Object.freeze({ maxEntries: 64, maxBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 });

function createPublicStaticRepresentationCache(options = {}) {
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root) ||
      !Array.isArray(options.files) || !options.files.length || options.files.length > 128)
    throw new TypeError('An explicit public asset root and file allowlist are required');
  const root = path.resolve(options.root);
  const files = new Set(options.files);
  for (const file of files) {
    if (typeof file !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,199}$/i.test(file) ||
        file === '.' || file === '..' || path.dirname(path.resolve(root, file)) !== root)
      throw new TypeError('Public assets must be fixed filenames within their root');
  }
  const io = options.fs || fs, codec = options.zlib || zlib;
  const limits = {};
  for (const name of Object.keys(LIMITS)) {
    const value = options[name] === undefined ? LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[name])
      throw new RangeError('Public asset cache limits may only be reduced');
    limits[name] = value;
  }
  const entries = new Map(), sourceIdentities = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.body.length; entries.delete(key); }
  }
  function invalidate(file) {
    for (const [key, entry] of entries) if (entry.file === file) remove(key);
    sourceIdentities.delete(file);
  }
  function identity(stat) {
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Public asset is not a regular file');
    return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(name => {
      if (typeof stat[name] !== 'bigint') throw new Error('Public asset identity is unavailable');
      return stat[name].toString();
    }).join('|');
  }
  function readSource(file) {
    const absolute = path.resolve(root, file);
    let fd;
    try {
      const pathnameBefore = identity(io.lstatSync(absolute, { bigint: true }));
      fd = io.openSync(absolute, 'r');
      const before = io.fstatSync(fd, { bigint: true });
      const snapshot = identity(before);
      if (snapshot !== pathnameBefore) throw new Error('Public asset changed before reading');
      const raw = io.readFileSync(fd);
      if (!Buffer.isBuffer(raw) || before.size !== BigInt(raw.length) ||
          identity(io.fstatSync(fd, { bigint: true })) !== snapshot ||
          identity(io.lstatSync(absolute, { bigint: true })) !== snapshot)
        throw new Error('Public asset changed while reading');
      return { raw, metadata: snapshot,
        identity: snapshot + '|' + crypto.createHash('sha256').update(raw).digest('hex') };
    } finally {
      if (fd !== undefined) io.closeSync(fd);
    }
  }
  function confirmCurrent(file, source) {
    try {
      if (identity(io.lstatSync(path.resolve(root, file), { bigint: true })) !== source.metadata)
        throw new Error('Public asset changed before serving');
    } catch (error) { invalidate(file); throw error; }
  }
  function read(file, requestedEncoding) {
    if (!files.has(file)) throw new Error('File is outside the public asset allowlist');
    if (requestedEncoding !== null && requestedEncoding !== 'br' && requestedEncoding !== 'gzip')
      throw new TypeError('Unknown public asset encoding');
    let source;
    try { source = readSource(file); }
    catch (error) { invalidate(file); throw error; }
    if (sourceIdentities.get(file) !== source.identity) invalidate(file);
    sourceIdentities.set(file, source.identity);
    let encoding = source.raw.length > 512 ? requestedEncoding : null;
    const key = JSON.stringify([file, source.identity, encoding]);
    const hit = entries.get(key);
    if (hit) {
      confirmCurrent(file, source);
      entries.delete(key); entries.set(key, hit);
      return { body: Buffer.from(hit.body), encoding: hit.encoding, etag: hit.etag };
    }
    let body = source.raw;
    if (encoding) {
      try {
        body = encoding === 'br' ? codec.brotliCompressSync(body) : codec.gzipSync(body, { level: 6 });
      } catch (_) {
        // Preserve the existing identity fallback; never substitute old bytes.
        encoding = null;
      }
    }
    confirmCurrent(file, source);
    const etag = '"' + crypto.createHash('sha256').update(body).digest('hex') + '"';
    if (source.raw.length <= limits.maxFileBytes && body.length <= limits.maxBytes) {
      while (entries.size >= limits.maxEntries || bytes + body.length > limits.maxBytes)
        remove(entries.keys().next().value);
      // A failed compression is not a successful compressed representation.
      const storedKey = JSON.stringify([file, source.identity, encoding]);
      remove(storedKey);
      entries.set(storedKey, { file, body: Buffer.from(body), encoding, etag });
      bytes += body.length;
    }
    return { body, encoding, etag };
  }
  return Object.freeze({ read, stats: () => ({ entries: entries.size, bytes,
    maxEntries: limits.maxEntries, maxBytes: limits.maxBytes, maxFileBytes: limits.maxFileBytes }) });
}

module.exports = { createPublicStaticRepresentationCache, LIMITS };
