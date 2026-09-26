// First-run secrets are created on the user's computer, never in a release package.
// This module is intentionally synchronous: the gateway must not listen before its
// authentication and E2EE keys exist.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DSH_AUTHORITY = '127.0.0.1:58347';

function createSecretIfMissing(file, bytes) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(bytes).toString('base64url'), 'ascii'); }
    finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

function readValidSecret(file, minLength) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.length < minLength || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid secret in ${path.basename(file)}; it was not replaced automatically`);
  }
  return raw;
}

function credentialCandidates() {
  // An explicit path is authoritative, including when it is intentionally
  // nonexistent (useful for Codex-only installs and isolated tests).
  if (process.env.DSH_CREDENTIALS_FILE) return [process.env.DSH_CREDENTIALS_FILE];
  const home = os.homedir();
  const suffix = ['DeepSeek Harness Desktop', 'harness-home', '.credentials.yaml'];
  const paths = [
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, '.credentials.yaml'),
    process.env.APPDATA && path.join(process.env.APPDATA, ...suffix),
    path.join(home, 'AppData', 'Roaming', ...suffix),
    path.join(home, 'Library', 'Application Support', ...suffix),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), ...suffix)
  ];
  return [...new Set(paths.filter(Boolean))];
}

function validDshCookie(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.status === 'ok' &&
      record.authority === DSH_AUTHORITY &&
      /^dsh-auth-[A-Za-z0-9_-]+$/.test(record.cookieName || '') &&
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(record.cookieValue || '') &&
      Date.parse(record.expiresAt || '') > Date.now() + 60 * 60 * 1000;
  } catch (err) { return false; }
}

function mintDshCookie(base, logDir) {
  const target = path.join(logDir, 'mint-cookie.json');
  if (validDshCookie(target)) return 'existing';
  const credentials = credentialCandidates().find((p) => {
    try { return fs.statSync(p).isFile(); } catch (err) { return false; }
  });
  if (!credentials) return 'unavailable';
  const temporary = path.join(logDir, `.mint-cookie.${process.pid}.tmp`);
  try {
    execFileSync(process.execPath, [path.join(base, 'scripts', 'mint-cookie.js'),
      credentials, DSH_AUTHORITY, temporary], {
      cwd: base, stdio: 'ignore', timeout: 10000, windowsHide: true
    });
    if (!validDshCookie(temporary)) return 'invalid-credentials';
    fs.renameSync(temporary, target);
    return 'created';
  } catch (err) {
    return 'invalid-credentials';
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { /* no temporary file */ }
  }
}

function ensureFirstRun(base = path.resolve(__dirname, '..')) {
  const logDir = path.join(base, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const accessFile = path.join(logDir, 'access-key.txt');
  const e2eeFile = path.join(logDir, 'e2ee-secret.txt');
  const createdAccessKey = createSecretIfMissing(accessFile, 18);
  const createdE2eeKey = createSecretIfMissing(e2eeFile, 24);
  readValidSecret(accessFile, 16);
  readValidSecret(e2eeFile, 32);
  const dshCookie = mintDshCookie(base, logDir);
  return { createdAccessKey, createdE2eeKey, dshCookie };
}

module.exports = { ensureFirstRun, credentialCandidates, validDshCookie, DSH_AUTHORITY };
