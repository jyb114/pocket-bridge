// Regression check for the desktop entry point.  A .lnk that targets node.exe
// shows a command window on Windows; a deliberate desktop launch must also
// override only the background-autostart stop flag.
'use strict';

const fs = require('fs');
const path = require('path');
const BASE = path.resolve(__dirname, '..');
const shortcut = fs.readFileSync(path.join(BASE, 'desktop', 'install-shortcut.js'), 'utf8');
const launcher = fs.readFileSync(path.join(BASE, 'desktop', 'open-desktop-app.js'), 'utf8');
const build = fs.readFileSync(path.join(BASE, 'desktop', 'build.js'), 'utf8');

for (const [label, source, required] of [
  ['shortcut', shortcut, 'wscript.exe'],
  ['shortcut', shortcut, 'open-desktop.vbs'],
  ['build', build, 'open-desktop.vbs'],
  ['launcher', launcher, 'user-stopped.flag'],
  ['launcher', launcher, 'resumeForExplicitLaunch()']
]) {
  if (!source.includes(required)) throw new Error(`${label} is missing ${required}`);
}
console.log('PASS: desktop shortcut is hidden and explicit launch resumes the gateway.');
