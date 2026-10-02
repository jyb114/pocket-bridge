// A desktop shortcut opens only the gateway advertised by this installation.
// Deliberate launch may start its daemon, but never adopts another installation.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_RESPONSE_BYTES = 16 * 1024;
const uuid = value => typeof value === 'string' && value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = () => Object.assign(new Error('desktop-launch-unverified'), { code: 'desktop-launch-unverified' });

function readOwnGatewayRecord(base, fileSystem = fs) {
  const logs = path.join(base, 'logs');
  try {
    const stat = fileSystem.lstatSync(logs);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  } catch (error) {
    if (error.code === 'ENOENT') return { instanceId: null, port: null };
    throw fail();
  }
  function read(name, limit) {
    const file = path.join(logs, name);
    try {
      const before = fileSystem.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw fail();
      const bytes = fileSystem.readFileSync(file);
      const after = fileSystem.lstatSync(file);
      if (bytes.length !== before.size || after.size !== before.size || after.dev !== before.dev ||
          after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail();
      return bytes.toString('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail();
    }
  }
  const rawIdentity = read('instance.json', MAX_RESPONSE_BYTES);
  let instanceId = null;
  if (rawIdentity !== null) {
    try {
      const record = JSON.parse(rawIdentity);
      if (!uuid(record?.instanceId)) throw fail();
      instanceId = record.instanceId;
    } catch (_) { throw fail(); }
  }
  const rawPort = read('gateway-port.txt', 32);
  let port = null;
  if (rawPort !== null) {
    const value = rawPort.trim();
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw fail();
    port = Number(value);
  }
  return { instanceId, port };
}

function probeHealth(port, { get = http.get, timeoutMs = 900 } = {}) {
  return new Promise(resolve => {
    let request, settled = false;
    function finish(value) { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); }
    // A peer sending a byte at a time must not keep the shortcut alive forever.
    const deadline = setTimeout(() => { finish(null); request?.destroy(); }, timeoutMs);
    try {
      request = get({ host: '127.0.0.1', port, path: '/__health', agent: false, timeout: timeoutMs }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { finish(null); request?.destroy(); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('error', () => finish(null));
        response.on('aborted', () => finish(null));
        response.on('end', () => {
          if (settled || response.statusCode !== 200) { finish(null); return; }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(value && !Array.isArray(value) && value.service === 'pocket-bridge-gateway' &&
              uuid(value.instanceId) && uuid(value.bootId) && value.port === port &&
              Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff ? value : null);
          } catch (_) { finish(null); }
        });
      });
      request.on('timeout', () => { finish(null); request.destroy(); });
      request.on('error', () => finish(null));
    } catch (_) { finish(null); }
  });
}

function createDesktopLauncher({ base = path.resolve(__dirname, '..'), executable = process.execPath,
  fileSystem = fs, get = http.get, launch = spawn, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, timeoutMs = 900, startupTimeoutMs = 30000 } = {}) {
  const sameRecord = (one, two) => one.instanceId === two.instanceId && one.port === two.port;
  async function findGateway() {
    const record = readOwnGatewayRecord(base, fileSystem);
    if (!record.instanceId || !record.port) return null;
    const first = await probeHealth(record.port, { get, timeoutMs });
    if (!first || first.instanceId !== record.instanceId || !sameRecord(record, readOwnGatewayRecord(base, fileSystem))) return null;
    const second = await probeHealth(record.port, { get, timeoutMs });
    if (!second || second.instanceId !== record.instanceId || second.bootId !== first.bootId || second.pid !== first.pid ||
        !sameRecord(record, readOwnGatewayRecord(base, fileSystem))) return null;
    return { port: record.port, instanceId: record.instanceId, bootId: second.bootId, pid: second.pid };
  }
  // Only a deliberate launch clears this installation's background-stop flag.
  // Missing or malformed identity files are not repaired by this launcher.
  function resumeForExplicitLaunch() {
    readOwnGatewayRecord(base, fileSystem);
    // Do not undo a stop during an outstanding daemon operation. Even stale
    // or incomplete ownership is evidence; this shortcut never reclaims it.
    try {
      fileSystem.lstatSync(path.join(base, 'logs', 'daemon-operation.lock'));
      throw fail();
    } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    const flag = path.join(base, 'logs', 'user-stopped.flag');
    try {
      const stat = fileSystem.lstatSync(flag);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
      fileSystem.unlinkSync(flag);
    } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
  }
  function start(args) {
    return new Promise((resolve, reject) => {
      let child, settled = false;
      const finish = ok => { if (settled) return; settled = true; clearTimeout(deadline); ok ? resolve() : reject(fail()); };
      const deadline = setTimeout(() => finish(false), 5000);
      try {
        child = launch(executable, args, { cwd: base, detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => finish(false));
        child.once('spawn', () => { child.unref(); finish(true); });
      } catch (_) { finish(false); }
    });
  }
  async function open() {
    let gateway = await findGateway();
    if (!gateway) {
      resumeForExplicitLaunch();
      await start([path.join(base, 'scripts', 'gateway-daemon.js')]);
      const deadline = now() + startupTimeoutMs;
      for (let attempt = 0; attempt < 30 && !gateway && now() < deadline; attempt++) {
        await sleep(Math.min(1000, Math.max(0, deadline - now())));
        if (now() >= deadline) break;
        gateway = await findGateway();
      }
    }
    if (!gateway) throw fail();
    await start([path.join(base, 'desktop', 'open-console-app.js'), String(gateway.port), 'console']);
    return { opened: true };
  }
  return { findGateway, open, resumeForExplicitLaunch };
}

async function main() {
  try { await createDesktopLauncher().open(); return 0; }
  catch (_) { console.error('Pocket Bridge could not verify or start this installation. No other gateway was opened.'); return 1; }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { createDesktopLauncher, readOwnGatewayRecord, probeHealth, MAX_RESPONSE_BYTES };
