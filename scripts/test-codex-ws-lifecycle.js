'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const box = {};
vm.createContext(box);
vm.runInContext(extractFunction(source, 'wireCodexWsLifecycle'), box);
assert.ok(source.includes('wireCodexWsLifecycle(socket, upstream);'), 'Live Codex proxy must install pair cleanup');

function closed(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Paired real TCP connection was left open')), 2000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
async function pair() {
  const accepted = [];
  const server = net.createServer(socket => { socket.on('error', () => {}); accepted.push(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = net.connect(port, '127.0.0.1');
  await new Promise(resolve => client.once('connect', resolve));
  while (!accepted.length) await new Promise(resolve => setImmediate(resolve));
  return { server, client, socket: accepted[0] };
}

(async () => {
  let checks = 0;
  for (const direction of ['phone', 'upstream']) {
    const phone = await pair(), backend = await pair();
    try {
      box.wireCodexWsLifecycle(phone.socket, backend.client);
      let phoneEnded = false;
      phone.socket.on('end', () => { phoneEnded = true; });
      if (direction === 'phone') {
        // Destroy locally: close fires without end. This was the missing path.
        phone.socket.destroy(); await closed(backend.client);
        assert.equal(phoneEnded, false);
      } else {
        backend.client.destroy(); await closed(phone.socket);
      }
      checks++; console.log('PASS actual TCP ' + direction + ' close destroys only its paired socket');
    } finally {
      phone.client.destroy(); phone.socket.destroy(); backend.client.destroy(); backend.socket.destroy();
      await Promise.all([new Promise(resolve => phone.server.close(resolve)), new Promise(resolve => backend.server.close(resolve))]);
    }
  }
  console.log(checks + ' actual TCP lifecycle checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
