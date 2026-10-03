// Real owned HTTP/TCP sockets. No installed gateway, tunnel or desktop actions.
'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { bindGateway } = require('./gateway-listener.js');

let passed = 0;
const identity = { pid: process.pid, bootId: crypto.randomUUID(), instanceId: crypto.randomUUID() };
const owned = new Set();
function own(server) { owned.add(server); return server; }
function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(options, () => { server.removeListener('error', reject); resolve(); });
  });
}
function close(server) { return new Promise(resolve => server.listening ? server.close(resolve) : resolve()); }
function request(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/__health', agent: false }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    }); req.on('error', reject); req.setTimeout(1500, () => req.destroy(Error('request-timeout')));
  });
}
async function check(label, fn) { await fn(); passed++; console.log(`OK ${label}`); }
function fixture(overrides = {}) {
  let port;
  const handler = (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'pocket-bridge-gateway', port, ...identity, ...overrides }));
  };
  const make = () => {
    const server = own(http.createServer(handler));
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    return server;
  };
  const server = make();
  return { server, createSibling: make, identity, onPortBound(value) { port = value; } };
}
async function availablePort() {
  const server = own(net.createServer()); await listen(server, { host: '127.0.0.1', port: 0 });
  const port = server.address().port; await close(server); return port;
}
async function upgrade(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }); let data = '';
    socket.setTimeout(1500, () => socket.destroy(Error('upgrade-timeout')));
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    socket.on('data', chunk => { data += chunk; }); socket.on('error', reject);
    socket.on('end', () => resolve(data));
  });
}

(async () => {
  try {
    if (process.platform === 'win32') {
      await check('reproduces Windows wildcard origin diversion without touching production', async () => {
        const wildcard = own(http.createServer((_req, res) => res.end('original')));
        await listen(wildcard, { host: '::', port: 0 }); const port = wildcard.address().port;
        const portal = own(http.createServer((_req, res) => res.end('other')));
        await listen(portal, { host: '127.0.0.1', port });
        assert.strictEqual((await request('127.0.0.1', port)).data, 'other');
        await close(portal); await close(wildcard);
      });
    }
    await check('actual occupied loopback chooses another port and keeps foreign server alive', async () => {
      const blocker = own(http.createServer((_req, res) => { res.statusCode = 404; res.end('other'); }));
      await listen(blocker, { host: '127.0.0.1', port: 0 }); const preferred = blocker.address().port;
      const gateway = await bindGateway({ ...fixture(), preferred });
      assert(gateway.port > preferred);
      assert.strictEqual((await request('127.0.0.1', preferred)).data, 'other');
      const health = JSON.parse((await request('127.0.0.1', gateway.port)).data);
      assert.strictEqual(health.pid, process.pid); assert.strictEqual(health.bootId, identity.bootId);
      await gateway.close(); await close(blocker);
    });
    await check('exact loopback cannot be diverted by later specific-address listener', async () => {
      const gateway = await bindGateway({ ...fixture(), preferred: await availablePort() });
      const intruder = own(http.createServer((_req, res) => res.end('other')));
      await assert.rejects(listen(intruder, { host: '127.0.0.1', port: gateway.port }), { code: 'EADDRINUSE' });
      assert.strictEqual(JSON.parse((await request('127.0.0.1', gateway.port)).data).bootId, identity.bootId);
      await gateway.close();
    });
    await check('IPv6 sibling uses same health and upgrade behavior when available', async () => {
      const gateway = await bindGateway({ ...fixture(), preferred: await availablePort() });
      if (gateway.ipv6) {
        assert.strictEqual(JSON.parse((await request('::1', gateway.port)).data).bootId, identity.bootId);
        assert((await upgrade('::1', gateway.port)).startsWith('HTTP/1.1 101'));
      }
      assert((await upgrade('127.0.0.1', gateway.port)).startsWith('HTTP/1.1 101'));
      await gateway.close();
    });
    await check('disabled LAN retains only loopback sockets', async () => {
      const gateway = await bindGateway({ ...fixture(), preferred: await availablePort(), enableLan: false });
      const hosts = gateway.listeners.filter(server => server.listening).map(server => server.address().address);
      assert(hosts.every(host => ['127.0.0.1', '::1'].includes(host)));
      await gateway.close();
    });
    await check('wrong process identity fails startup and closes all candidate sockets', async () => {
      const preferred = await availablePort(), value = fixture({ pid: process.pid + 1 });
      await assert.rejects(bindGateway({ ...value, preferred }), { code: 'gateway-loopback-unverified' });
      assert(!value.server.listening); assert.strictEqual(value.server.listenerCount('connection'), 1);
      const again = own(net.createServer()); await listen(again, { host: '127.0.0.1', port: preferred }); await close(again);
    });
    await check('occupied IPv6 rolls back partial IPv4 listeners before retrying', async () => {
      const blocker = own(net.createServer(socket => socket.end('owned-other')));
      try { await listen(blocker, { host: '::', port: 0, ipv6Only: true }); }
      catch (error) {
        if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'ENODEV'].includes(error.code)) {
          console.log('SKIP IPv6 unavailable for partial-bind fixture'); return;
        }
        throw error;
      }
      const preferred = blocker.address().port;
      const gateway = await bindGateway({ ...fixture(), preferred });
      assert(gateway.port > preferred); assert(blocker.listening);
      await assert.rejects(request('127.0.0.1', preferred), { code: 'ECONNREFUSED' });
      await gateway.close(); await close(blocker);
    });
    await check('silent health has a bounded failure and closes its accepted socket', async () => {
      const preferred = await availablePort(), value = fixture();
      value.server.removeAllListeners('request'); value.server.on('request', () => {});
      const started = Date.now();
      await assert.rejects(bindGateway({ ...value, preferred, probeTimeoutMs: 50 }), { code: 'gateway-loopback-unverified' });
      assert(Date.now() - started < 1500); assert(!value.server.listening);
      const again = own(net.createServer()); await listen(again, { host: '127.0.0.1', port: preferred }); await close(again);
    });
    await check('explicit close destroys owned upgraded sockets and releases listeners', async () => {
      const value = fixture();
      // Keep an upgraded connection open to exercise ownership beyond HTTP close.
      value.server.removeAllListeners('upgrade'); value.server.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
      const gateway = await bindGateway({ ...value, preferred: await availablePort(), enableLan: false });
      const socket = net.connect({ host: '127.0.0.1', port: gateway.port });
      await new Promise((resolve, reject) => {
        socket.once('error', reject); socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
        socket.once('data', resolve);
      });
      const closed = new Promise(resolve => socket.once('close', resolve));
      await gateway.close(); await closed;
      assert(gateway.listeners.every(server => !server.listening));
      const again = own(net.createServer()); await listen(again, { host: '127.0.0.1', port: gateway.port }); await close(again);
    });
    await check('invalid port fails without creating a listening socket', async () => {
      const value = fixture();
      await assert.rejects(bindGateway({ ...value, preferred: 65536 }), { code: 'invalid-gateway-listener-options' });
      assert(!value.server.listening);
    });
    console.log(`${passed} passed, 0 failed (real owned sockets; no production processes).`);
  } finally { for (const server of owned) { server.closeAllConnections?.(); await close(server); } }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
