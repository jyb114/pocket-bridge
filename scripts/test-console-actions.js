// Regression check: the desktop UI action that rotates a temporary tunnel must
// be implemented by the gateway, otherwise the UI can only show “unknown error”.
'use strict';

const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const marker = "body.action === 'rotate-and-refresh-dynamic'";
const start = source.indexOf(marker);
if (start < 0) throw new Error('Missing rotate-and-refresh-dynamic console action');
const branch = source.slice(start, start + 2200);
for (const required of ['rotate-key', 'rotate-e2ee', 'refresh-tunnel.js', 'restartSelfSoon']) {
  if (!branch.includes(required)) throw new Error(`Incomplete temporary-tunnel rotation action: ${required}`);
}
console.log('PASS: temporary-tunnel rotation action is implemented by the gateway.');
