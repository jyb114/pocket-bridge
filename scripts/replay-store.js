'use strict';
// Server-side admission receipts, not an execution journal. No content or key
// is stored. Authentication must succeed BEFORE consume(); durable commit must
// succeed BEFORE forwarding. Active receipts are never evicted for capacity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ENTRIES = 50000, MAX_PER_SCOPE = 40000, MAX_SCOPES = 8;
const MAX_BYTES = 16 * 1024 * 1024, MAX_RETENTION_MS = 60 * 60 * 1000;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const scopeOf = secret => sha(String(secret));
const keyOf = (scope, token) => scope + ':' + token;
const integer = value => Number.isSafeInteger(value) && value >= 0;
function failure(code) { throw Object.assign(new Error('Replay admission unavailable.'), { code }); }
function noLinks(file) {
  for (let current = path.resolve(file);;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) failure('replay-store-linked'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
class ReplayStore {
  constructor(options = {}) {
    this.file = path.resolve(options.file || path.join(__dirname, '..', 'logs', 'replay-receipts.jsonl'));
    this.marker = this.file + '.initialized'; this.lock = this.file + '.lock';
    this.fs = options.fs || fs; // Only the isolated failure fixture injects fs.
    this.clock = options.clock || Date.now;
    this.maxEntries = options.maxEntries || MAX_ENTRIES;
    this.maxPerScope = options.maxPerScope || MAX_PER_SCOPE;
    this.maxScopes = options.maxScopes || MAX_SCOPES;
    this.maxBytes = options.maxBytes || MAX_BYTES;
    for (const [value, maximum] of [[this.maxEntries, MAX_ENTRIES], [this.maxPerScope, MAX_PER_SCOPE], [this.maxScopes, MAX_SCOPES], [this.maxBytes, MAX_BYTES]]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw Error('Invalid replay capacity.');
    }
    this.state = null; this.initializedSeen = false;
  }
  _newFile(file, bytes) {
    let fd;
    try { fd = this.fs.openSync(file, 'wx', 0o600); this._writeAll(fd, bytes, 0); this.fs.fsyncSync(fd); }
    finally { if (fd !== undefined) this.fs.closeSync(fd); }
  }
  _writeAll(fd, bytes, at) {
    let written = 0;
    while (written < bytes.length) {
      const count = this.fs.writeSync(fd, bytes, written, bytes.length - written, at + written);
      if (count <= 0) failure('replay-store-write'); written += count;
    }
  }
  _initialize(now) {
    const hasFile = this.fs.existsSync(this.file), hasMarker = this.fs.existsSync(this.marker);
    if (hasFile !== hasMarker || (!hasFile && this.initializedSeen)) failure('replay-store-incomplete');
    if (hasFile) { this.initializedSeen = true; return; }
    const id = crypto.randomBytes(16).toString('hex');
    const header = { v: 1, id, at: now }, bytes = Buffer.from(JSON.stringify(header) + '\n');
    // A crash between these durable writes is refused, never treated as empty.
    this._newFile(this.marker, Buffer.from(JSON.stringify({ v: 1, id, bytes: bytes.length, tail: sha(JSON.stringify(header)), at: now }) + '\n'));
    this._newFile(this.file, bytes);
    this.initializedSeen = true;
  }
  _checkpoint(state, bytes, tail, at) {
    // An intact hash chain alone cannot detect removal of complete final
    // records. Anchor its complete length and head in a separate durable file.
    // A crash between journal and checkpoint commits refuses subsequent use.
    const temporary = this.marker + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      this._newFile(temporary, Buffer.from(JSON.stringify({ v: 1, id: state.id, bytes, tail, at }) + '\n'));
      noLinks(this.marker);
      if (stamp(this.fs.statSync(this.marker)) !== state.markerSignature) failure('replay-store-changed');
      this.fs.renameSync(temporary, this.marker);
      return stamp(this.fs.statSync(this.marker));
    } finally { try { this.fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
  }
  _load(now) {
    noLinks(this.file); noLinks(this.marker);
    const markerStat = this.fs.statSync(this.marker), stat = this.fs.statSync(this.file);
    if (!markerStat.isFile() || markerStat.size > 320 || !stat.isFile() || stat.size > this.maxBytes) failure('replay-store-corrupt');
    const markerRaw = this.fs.readFileSync(this.marker, 'utf8');
    const marker = JSON.parse(markerRaw);
    if (!marker || marker.v !== 1 || !/^[a-f0-9]{32}$/.test(marker.id || '') || !integer(marker.bytes) || marker.bytes !== stat.size ||
      !integer(marker.at) || !/^[a-f0-9]{64}$/.test(marker.tail || '') ||
      markerRaw !== JSON.stringify({ v: 1, id: marker.id, bytes: marker.bytes, tail: marker.tail, at: marker.at }) + '\n') failure('replay-store-corrupt');
    const signature = stamp(stat), markerSignature = stamp(markerStat);
    if (this.state && this.state.signature === signature && this.state.markerSignature === markerSignature && this.state.id === marker.id) return this.state;
    const bytes = this.fs.readFileSync(this.file);
    if (bytes.length !== stat.size || !bytes.length || bytes[bytes.length - 1] !== 10 || stamp(this.fs.statSync(this.file)) !== signature) failure('replay-store-corrupt');
    const lines = bytes.toString('utf8').split('\n'); lines.pop();
    const header = JSON.parse(lines.shift());
    if (!header || header.v !== 1 || header.id !== marker.id || !integer(header.at) || lines.length > this.maxEntries ||
      JSON.stringify(header) !== JSON.stringify({ v: 1, id: header.id, at: header.at })) failure('replay-store-corrupt');
    let previous = sha(JSON.stringify(header)), lastAt = header.at;
    const entries = new Map(); let count = 0;
    for (const line of lines) {
      if (!line || line.length > 512 || ++count > this.maxEntries) failure('replay-store-corrupt');
      const row = JSON.parse(line);
      if (!Array.isArray(row) || row.length !== 6 || !/^[a-f0-9]{64}$/.test(row[0]) || typeof row[1] !== 'string' || !/^[a-z0-9:-]{1,160}$/.test(row[1]) ||
        !integer(row[2]) || !integer(row[3]) || row[3] < lastAt || row[2] <= row[3] || row[2] - row[3] > MAX_RETENTION_MS || row[4] !== previous || row[5] !== sha(JSON.stringify(row.slice(0, 5)))) failure('replay-store-corrupt');
      const key = keyOf(row[0], row[1]);
      if (entries.has(key) && entries.get(key).expires > row[3]) failure('replay-store-corrupt');
      entries.set(key, { scope: row[0], token: row[1], expires: row[2] }); previous = row[5]; lastAt = row[3];
    }
    if (previous !== marker.tail || lastAt !== marker.at) failure('replay-store-corrupt');
    const scopeCounts = new Map(); let nextExpiry = Infinity;
    for (const entry of entries.values()) {
      scopeCounts.set(entry.scope, (scopeCounts.get(entry.scope) || 0) + 1);
      nextExpiry = Math.min(nextExpiry, entry.expires);
    }
    this.state = { id: marker.id, signature, markerSignature, entries, scopeCounts, nextExpiry, lastAt, previous, count, size: stat.size };
    return this.state;
  }
  _prune(state, now) {
    // Do not scan the complete bounded ledger for every small incoming frame.
    if (now < state.nextExpiry) return;
    state.nextExpiry = Infinity;
    for (const [key, entry] of state.entries) {
      if (entry.expires > now) { state.nextExpiry = Math.min(state.nextExpiry, entry.expires); continue; }
      state.entries.delete(key);
      const count = state.scopeCounts.get(entry.scope) - 1;
      if (count) state.scopeCounts.set(entry.scope, count); else state.scopeCounts.delete(entry.scope);
    }
  }
  _compact(state, now) {
    const header = { v: 1, id: state.id, at: now };
    const parts = [JSON.stringify(header) + '\n']; let previous = sha(JSON.stringify(header));
    for (const entry of state.entries.values()) {
      const row = [entry.scope, entry.token, entry.expires, now, previous]; row.push(sha(JSON.stringify(row)));
      parts.push(JSON.stringify(row) + '\n'); previous = row[5];
    }
    const bytes = Buffer.from(parts.join(''));
    if (bytes.length > this.maxBytes) failure('replay-capacity');
    const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      this._newFile(temporary, bytes); noLinks(this.file);
      if (stamp(this.fs.statSync(this.file)) !== state.signature) failure('replay-store-changed');
      this.fs.renameSync(temporary, this.file);
      this._checkpoint(state, bytes.length, previous, now);
    } finally { try { this.fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
    this.state = null; return this._load(now);
  }
  consume(scope, token, expires) {
    let ownedLock = null;
    try {
      const now = this.clock();
      if (!integer(now) || !/^[a-f0-9]{64}$/.test(scope || '') || typeof token !== 'string' || !/^[a-z0-9:-]{1,160}$/.test(token) || !integer(expires) || expires <= now || expires - now > MAX_RETENTION_MS) failure('replay-invalid');
      noLinks(path.dirname(this.file)); this.fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); noLinks(path.dirname(this.file));
      try { this.fs.mkdirSync(this.lock, { mode: 0o700 }); ownedLock = stamp(this.fs.lstatSync(this.lock)); }
      catch (err) { if (err.code === 'EEXIST') failure('replay-store-busy'); throw err; }
      this._initialize(now);
      let state = this._load(now);
      // Persisted watermark also survives compaction/restart. A backward clock
      // cannot reopen a discarded slot or proof-validity window.
      if (now < state.lastAt) failure('replay-clock-rollback');
      const key = keyOf(scope, token);
      if (state.entries.has(key) && state.entries.get(key).expires > now) return { ok: false, code: 'replayed-request' };
      this._prune(state, now);
      if (state.entries.size >= this.maxEntries || (state.scopeCounts.get(scope) || 0) >= this.maxPerScope || (!state.scopeCounts.has(scope) && state.scopeCounts.size >= this.maxScopes)) failure('replay-capacity');
      let row = [scope, token, expires, now, state.previous]; row.push(sha(JSON.stringify(row)));
      let bytes = Buffer.from(JSON.stringify(row) + '\n');
      if (state.count >= this.maxEntries || state.size + bytes.length > this.maxBytes) {
        state = this._compact(state, now); row = [scope, token, expires, now, state.previous]; row.push(sha(JSON.stringify(row))); bytes = Buffer.from(JSON.stringify(row) + '\n');
      }
      if (state.size + bytes.length > this.maxBytes) failure('replay-capacity');
      let fd;
      try {
        noLinks(this.file); fd = this.fs.openSync(this.file, 'r+');
        if (stamp(this.fs.fstatSync(fd)) !== state.signature) failure('replay-store-changed');
        this._writeAll(fd, bytes, state.size); this.fs.fsyncSync(fd);
        const committed = this.fs.fstatSync(fd);
        if (committed.size !== state.size + bytes.length) failure('replay-store-changed');
        const markerSignature = this._checkpoint(state, committed.size, row[5], now);
        state.entries.set(key, { scope, token, expires }); state.lastAt = now; state.previous = row[5]; state.count++; state.size = committed.size; state.signature = stamp(committed);
        state.markerSignature = markerSignature;
        state.scopeCounts.set(scope, (state.scopeCounts.get(scope) || 0) + 1); state.nextExpiry = Math.min(state.nextExpiry, expires);
      } finally { if (fd !== undefined) this.fs.closeSync(fd); }
      return { ok: true };
    } catch (err) {
      this.state = null;
      return { ok: false, code: /^(?:replay-invalid|replay-clock-rollback|replay-capacity|replay-store-[a-z-]+)$/.test(err.code || '') ? err.code : 'replay-store-unavailable' };
    } finally {
      if (ownedLock) {
        // Never recursively remove a lock, take over a stale owner, or remove
        // a lock replaced by another actor. An interrupted owner fails closed.
        try {
          if (stamp(this.fs.lstatSync(this.lock)) !== ownedLock) failure('replay-store-lock-changed');
          this.fs.rmdirSync(this.lock);
        } catch (_) { this.state = null; return { ok: false, code: 'replay-store-lock-unavailable' }; }
      }
    }
  }
}

const defaultStore = new ReplayStore();
module.exports = { ReplayStore, defaultStore, scopeOf, MAX_ENTRIES, MAX_PER_SCOPE, MAX_SCOPES, MAX_BYTES, MAX_RETENTION_MS };
