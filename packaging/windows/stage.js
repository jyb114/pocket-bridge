'use strict';

// Build an explicit payload from tracked source paths. The live workspace has
// config.json, logs and uploads beside code; copying the whole tree is unsafe.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
  && !excludedFiles.has(entry));

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
  'scripts/gateway-daemon.js', 'scripts/mobile-proxy.js', 'scripts/first-run.js',
  'scripts/desktop-ui-action.js', 'scripts/codex-desktop-driver.js',
  'scripts/codex-desktop-ui.ps1', 'scripts/codex-desktop-relay.js', 'scripts/codex-desktop-target.js', 'scripts/codex-desktop-text.js',
  'scripts/codex-desktop-source-guard.ps1',
  'scripts/dot-desktop-driver.js', 'scripts/dot-desktop-ui.ps1', 'scripts/dot-desktop-service.js',
  'scripts/dot-desktop-protocol.js', 'scripts/dot-desktop-owner.js', 'scripts/dot-desktop-journal.js',
  'scripts/dot-desktop-private-store.js', 'scripts/dot-desktop-runtime.js',
  'scripts/dot-desktop-send-driver.js', 'scripts/dot-desktop-send.ps1',
  'scripts/dot-desktop-source-guard.ps1', 'scripts/dot-desktop-navigation-guard.ps1', 'pwa/dot.html',
  'desktop/open-desktop.vbs', 'desktop/open-desktop-app.js',
  'desktop/icons/app.ico', 'pwa/console.html'
]) {
  if (!fs.existsSync(path.join(destination, required))) {
    throw new Error(`Missing required payload file: ${required}`);
  }
}
console.log(`Staged ${selected.length} allowlisted source files`);
