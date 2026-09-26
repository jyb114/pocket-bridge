// Controlled in-place gateway reload.  This is intentionally PID-based only
// after the caller has identified the active mobile-proxy process.
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const pid = Number(process.argv[2]);
const port = Number(process.argv[3] || 8080);
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Usage: reload-gateway.js <verified-proxy-pid> [port]');

const restart = spawn(process.execPath, [path.join(__dirname, 'restart-gateway.js'), '--port', String(port)], {
  cwd: path.resolve(__dirname, '..'), detached: true, stdio: 'ignore', windowsHide: true
});
restart.unref();

// The mobile proxy receives a normal termination signal.  restart-gateway.js
// waits for its health endpoint to disappear, then launches the daemon again.
process.kill(pid, 'SIGTERM');
console.log(`Reload requested for verified mobile gateway process ${pid} on port ${port}.`);
