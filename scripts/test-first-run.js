// Isolated first-install test: never touches the running gateway or user keys.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureFirstRun, validDshCookie } = require('./first-run.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-bridge-first-run-'));
const previousCredentials = process.env.DSH_CREDENTIALS_FILE;
const logs = path.join(root, 'logs');
const credentials = path.join(root, 'dsh-credentials.yaml');
const missingCredentials = path.join(root, 'not-installed.yaml');

try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, 'mint-cookie.js'), path.join(root, 'scripts', 'mint-cookie.js'));
  fs.copyFileSync(path.join(__dirname, 'config.js'), path.join(root, 'scripts', 'config.js'));
  process.env.DSH_CREDENTIALS_FILE = missingCredentials;

  const first = ensureFirstRun(root);
  assert.equal(first.createdAccessKey, true);
  assert.equal(first.createdE2eeKey, true);
  assert.equal(first.dshCookie, 'unavailable');
  const access = fs.readFileSync(path.join(logs, 'access-key.txt'), 'utf8');
  const e2ee = fs.readFileSync(path.join(logs, 'e2ee-secret.txt'), 'utf8');
  assert.match(access, /^[A-Za-z0-9_-]{24}$/);
  assert.match(e2ee, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(fs.existsSync(path.join(logs, 'mint-cookie.json')), false);
  console.log('OK clean Codex-only install generates local keys without a fake DSH cookie');

  const again = ensureFirstRun(root);
  assert.equal(again.createdAccessKey, false);
  assert.equal(again.createdE2eeKey, false);
  assert.equal(fs.readFileSync(path.join(logs, 'access-key.txt'), 'utf8'), access);
  assert.equal(fs.readFileSync(path.join(logs, 'e2ee-secret.txt'), 'utf8'), e2ee);
  console.log('OK upgrade/restart keeps both keys unchanged');

  const signingSecret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(credentials,
    `records:\n  client-connection/browser-session:\n    secret: ${signingSecret}\n`);
  process.env.DSH_CREDENTIALS_FILE = credentials;
  const withDsh = ensureFirstRun(root);
  assert.equal(withDsh.dshCookie, 'created');
  const cookieFile = path.join(logs, 'mint-cookie.json');
  assert.equal(validDshCookie(cookieFile), true);
  const savedCookie = fs.readFileSync(cookieFile, 'utf8');
  assert.equal(ensureFirstRun(root).dshCookie, 'existing');
  assert.equal(fs.readFileSync(cookieFile, 'utf8'), savedCookie);
  console.log('OK real DSH credentials mint a valid cookie and reuse it');

  const expired = JSON.parse(savedCookie);
  expired.expiresAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(cookieFile, JSON.stringify(expired));
  assert.equal(ensureFirstRun(root).dshCookie, 'created');
  assert.equal(validDshCookie(cookieFile), true);
  console.log('OK expired DSH cookie is renewed only when credentials are present');

  const isolatedConfig = require(path.join(root, 'scripts', 'config.js'));
  isolatedConfig.ensureInstanceIdentity();
  const instanceFile = path.join(logs, 'instance.json');
  const copiedMachine = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
  copiedMachine.fingerprint = 'copied-to-another-machine';
  fs.writeFileSync(instanceFile, JSON.stringify(copiedMachine));
  assert.equal(isolatedConfig.ensureInstanceIdentity().isNewMachine, true);
  assert.equal(fs.existsSync(path.join(logs, 'access-key.txt')), false);
  assert.equal(fs.existsSync(path.join(logs, 'e2ee-secret.txt')), false);
  process.env.DSH_CREDENTIALS_FILE = missingCredentials;
  ensureFirstRun(root);
  assert.notEqual(fs.readFileSync(path.join(logs, 'access-key.txt'), 'utf8'), access);
  assert.notEqual(fs.readFileSync(path.join(logs, 'e2ee-secret.txt'), 'utf8'), e2ee);
  console.log('OK copying to another machine invalidates and regenerates both keys');

  fs.writeFileSync(path.join(logs, 'access-key.txt'), 'bad');
  assert.throws(() => ensureFirstRun(root), /Invalid secret/);
  assert.equal(fs.readFileSync(path.join(logs, 'access-key.txt'), 'utf8'), 'bad');
  console.log('OK corrupt existing access key fails closed instead of rotating silently');
} finally {
  if (previousCredentials === undefined) delete process.env.DSH_CREDENTIALS_FILE;
  else process.env.DSH_CREDENTIALS_FILE = previousCredentials;
  // root comes only from mkdtempSync with a fixed leaf prefix.
  if (path.basename(root).startsWith('pocket-bridge-first-run-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
