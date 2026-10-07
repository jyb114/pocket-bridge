'use strict';

// Build an explicit payload from tracked source paths. The live workspace has
// config.json, logs and uploads beside code; copying the whole tree is unsafe.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isPayloadPath } = require('../../scripts/release-profile.js');

const root = path.resolve(__dirname, '..', '..');
const destination = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node stage.js <empty-payload-directory>');
if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
  throw new Error(`Payload directory must be empty: ${destination}`);
}

const allowedRoots = new Set([
  'LICENSE', 'README.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md',
  'package.json', 'CHANGELOG.md', 'RELEASE_NOTES.md'
]);
const allowedDirs = ['scripts/', 'pwa/', 'desktop/', 'docs/'];
const excludedFiles = new Set([
  'desktop/setup.cmd', 'desktop/双击安装.vbs',
  'desktop/dsh-gateway.bat', 'desktop/fix-firewall.cmd'
]);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const selected = [...new Set([...tracked, 'scripts/first-run.js'])].filter((entry) =>
  (allowedRoots.has(entry) || allowedDirs.some((prefix) => entry.startsWith(prefix)))
  && !excludedFiles.has(entry) && isPayloadPath(entry));

fs.mkdirSync(destination, { recursive: true });
for (const relative of selected) {
  const source = path.join(root, relative);
  const stat = fs.lstatSync(source);
  if (!stat.isFile()) throw new Error(`Unexpected non-file tracked entry: ${relative}`);
  const output = path.join(destination, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(source, output);
}
for (const required of [
  "scripts/gateway-daemon.js",
  "scripts/mobile-proxy.js",
  "scripts/first-run.js",
  "scripts/gateway-listener.js",
  "scripts/gateway-lifecycle.js",
  "scripts/retired-targets.js",
  "scripts/dsh-phone-surface.js",
  "scripts/release-profile.js",
  "scripts/windows-shortcut.js",
  "scripts/dsh-runtime.js",
  "scripts/dsh-adapter.js",
  "scripts/dsh-feature-capabilities.js",
  "scripts/phone-page-policy.js",
  "scripts/replay-store.js",
  "scripts/private-https-admission.js",
  "scripts/tailscale-private-https.js",
  "scripts/dsh-lite-rpc.js",
  "pwa/dsh-lite-adapter.js",
  "pwa/dsh-lite-router.js",
  "pwa/dsh-lite-legacy.js",
  "scripts/dsh-lite-legacy-rpc.js",
  "scripts/dsh-lite-upload.js",
  "scripts/dsh-lite-download.js",
  "scripts/dsh-lite-files.js",
  "scripts/dsh-lite-attachment.js",
  "scripts/dsh-runtime-identity.js",
  "desktop/open-desktop.vbs",
  "desktop/open-desktop-app.js",
  "desktop/icons/app.ico",
  "desktop/brand-artwork.js",
  "pwa/pocket-bridge.svg",
  "pwa/icon-maskable.png",
  "pwa/console.html",
  "pwa/dsh-lite.html",
  "pwa/dsh-lite-ui.js",
  "pwa/dsh-lite-lang.js",
  "pwa/dsh-lite.css",
  "pwa/e2ee.js"
]) {
  if (!fs.existsSync(path.join(destination, required))) {
    throw new Error(`Missing required payload file: ${required}`);
  }
}
console.log(`Staged ${selected.length} allowlisted source files`);
