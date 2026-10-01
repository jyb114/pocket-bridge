'use strict';

// Starts the unmodified gateway in its own directory and sends real HTTP
// requests. It never contacts a production gateway, DSH, or Codex listener.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SOURCE = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(path.dirname(SOURCE), 'auth-cookie-regression');
const RUN = path.join(ARTIFACTS, `run-${Date.now()}-${process.pid}`);
const report = [];
let passed = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(label, fn) {
  fn(); passed++;
  report.push('PASS ' + label);
  console.log('PASS ' + label);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, route, cookie, authority) {
  return new Promise((resolve, reject) => {
    const headers = { host: authority || `127.0.0.1:${port}`, 'user-agent': 'PocketBridge cookie regression', 'accept-language': 'en' };
    if (cookie) headers.cookie = cookie;
    const req = http.get({ host: '127.0.0.1', port, path: route, headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('isolated HTTP request timed out')));
  });
}

function responseCookies(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]);
}

async function exercise(mode) {
  const base = path.join(RUN, mode);
  fs.mkdirSync(base, { recursive: true });
  for (const name of ['scripts', 'pwa']) fs.cpSync(path.join(SOURCE, name), path.join(base, name), { recursive: true });
  const gatewayPort = await freePort();
  const unusedDshPort = await freePort();
  const unusedCodexPort = await freePort();
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ gatewayPort, dshPort: unusedDshPort, dshMode: 'web', dshWebExecutable: '', dshWebEntry: '', tunnelProvider: 'none', lanHttps: { enabled: false }, codex: { port: unusedCodexPort } }));
  const credentials = path.join(base, '.credentials.yaml');
  if (mode === 'dsh-cookie') {
    fs.writeFileSync(credentials, 'refs:\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: ' + crypto.randomBytes(32).toString('base64url') + '\n');
  }
  const stdout = fs.openSync(path.join(base, 'process.log'), 'w');
  const child = spawn(process.execPath, [path.join(base, 'scripts', 'mobile-proxy.js')], {
    cwd: base, windowsHide: true,
    env: { ...process.env, DSH_GW_PORT: String(gatewayPort), DSH_GW_TARGET_PORT: String(unusedDshPort), DSH_CREDENTIALS_FILE: credentials, DSH_HOME: base, DSH_GW_NO_NOTIFY: '1' },
    stdio: ['ignore', stdout, stdout]
  });
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error('isolated gateway exited before listening');
      try { await request(gatewayPort, '/__probe'); ready = true; break; } catch (_) { await sleep(250); }
    }
    assert.ok(ready, 'isolated gateway did not start');
    const key = fs.readFileSync(path.join(base, 'logs', 'access-key.txt'), 'utf8').trim();
    const entry = '/k/' + encodeURIComponent(key) + '?target=lite';
    const clean = await request(gatewayPort, entry);
    check(mode + ': a fresh valid key opens the lightweight shell', () => {
      assert.equal(clean.status, 200);
      assert.match(clean.body, /dsh-lite/);
    });
    const authPair = responseCookies(clean).find(pair => /^dsh-auth-|^pocket-bridge-auth-/.test(pair));
    assert.ok(authPair, 'authentication cookie not issued');
    const authName = authPair.slice(0, authPair.indexOf('='));
    const deviceName = responseCookies(clean).find(pair => /^dsh-gw-session-/.test(pair)).split('=')[0];
    const legacyAuthName = authName.replace(/-[a-f0-9]{16}$/, '');
    const legacyAuthPair = legacyAuthName + authPair.slice(authPair.indexOf('='));
    if (mode === 'dsh-cookie') assert.match(authName, /^dsh-auth-/);
    else assert.match(authName, /^pocket-bridge-auth-[a-f0-9]{16}$/);
    const staleAuth = `${authName}=obsolete-session; ${authName}=another-obsolete-session`;
    const recovered = await request(gatewayPort, entry, staleAuth + '; dsh-lang=en');
    check(mode + ': valid key replaces every stale authentication cookie on its first request', () => {
      assert.equal(recovered.status, 200);
      assert.match(recovered.body, /dsh-lite/);
      assert.ok(responseCookies(recovered).includes(authPair));
    });
    const localDevice = await request(gatewayPort, entry, staleAuth + `; ${deviceName}=forged-old-token; ${deviceName}=other-old-token`);
    check(mode + ': valid local key clears every stale device token on the first request', () => {
      assert.equal(localDevice.status, 200);
      assert.match(localDevice.body, /dsh-lite/);
      assert.ok(localDevice.headers['set-cookie'].some(value => value.startsWith(deviceName + '=;') && /Max-Age=0/.test(value)));
    });
    const localTokenWithoutKey = await request(gatewayPort, '/dsh-lite', authPair + `; ${deviceName}=forged-old-token`);
    check(mode + ': local forged device tokens without a key are still rejected', () => assert.equal(localTokenWithoutKey.status, 403));
    const noKey = await request(gatewayPort, '/dsh-lite', staleAuth);
    check(mode + ': stale authentication cookies without a valid key are still rejected', () => {
      assert.equal(noKey.status, 403);
      assert.equal(noKey.headers['x-dsh-auth-required'], '1');
    });
    const wrongKey = await request(gatewayPort, '/k/invalid-key?target=lite', staleAuth);
    check(mode + ': a wrong key cannot replace stale cookies', () => assert.equal(wrongKey.status, 403));
    const authority = 'cookie-regression.invalid:' + gatewayPort;
    const remote = await request(gatewayPort, entry, staleAuth + `; ${deviceName}=forged-old-token; ${deviceName}=other-old-token`, authority);
    const remotePairs = responseCookies(remote);
    check(mode + ': valid key replaces stale device tokens before the second authentication gate', () => {
      assert.equal(remote.status, 200);
      assert.match(remote.body, /dsh-lite/);
      assert.equal(remotePairs.filter(pair => pair.startsWith(deviceName + '=')).length, 1);
      assert.ok(!remotePairs.join('; ').includes('forged-old-token'));
    });
    const deviceOnly = await request(gatewayPort, '/dsh-lite', authPair + `; ${deviceName}=forged-old-token`, authority);
    check(mode + ': a forged device token without a key is still rejected', () => assert.equal(deviceOnly.status, 403));
    const revisit = await request(gatewayPort, '/dsh-lite', remotePairs.join('; '), authority);
    check(mode + ': the newly issued authentication and device cookies work on the following request', () => assert.equal(revisit.status, 200));
    const devicePair = remotePairs.find(pair => pair.startsWith(deviceName + '='));
    const legacyDevicePair = 'dsh-gw-session' + devicePair.slice(devicePair.indexOf('='));
    const migrated = await request(gatewayPort, '/dsh-lite', legacyAuthPair + '; ' + legacyDevicePair, authority);
    check(mode + ': a valid old login migrates both cookies and preserves the device identity', () => {
      assert.equal(migrated.status, 200);
      assert.ok(responseCookies(migrated).includes(authPair));
      assert.ok(responseCookies(migrated).includes(devicePair));
    });
    const invalidLegacy = await request(gatewayPort, '/dsh-lite', legacyAuthName + '=forged; ' + legacyDevicePair, authority);
    check(mode + ': another instance or forged legacy authentication cannot migrate', () => assert.equal(invalidLegacy.status, 403));
    const invalidScoped = await request(gatewayPort, '/dsh-lite', authName + '=forged; ' + legacyAuthPair + '; ' + legacyDevicePair, authority);
    check(mode + ': an invalid scoped login cannot downgrade to legacy authentication', () => assert.equal(invalidScoped.status, 403));

    // A second listener deliberately shares the same access key and upstream
    // credential. Only its gateway instance and port distinguish the cookies.
    const secondBase = path.join(RUN, mode + '-second-port');
    fs.mkdirSync(secondBase, { recursive: true });
    for (const name of ['scripts', 'pwa']) fs.cpSync(path.join(SOURCE, name), path.join(secondBase, name), { recursive: true });
    fs.mkdirSync(path.join(secondBase, 'logs'), { recursive: true });
    for (const name of ['access-key.txt', 'e2ee-secret.txt', 'mint-cookie.json']) {
      const sourceFile = path.join(base, 'logs', name);
      if (fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(secondBase, 'logs', name));
    }
    const secondPort = await freePort();
    fs.writeFileSync(path.join(secondBase, 'config.json'), JSON.stringify({ gatewayPort: secondPort, dshPort: unusedDshPort, dshMode: 'web', tunnelProvider: 'none', lanHttps: { enabled: false }, codex: { port: unusedCodexPort } }));
    const secondLog = fs.openSync(path.join(secondBase, 'process.log'), 'w');
    const second = spawn(process.execPath, [path.join(secondBase, 'scripts', 'mobile-proxy.js')], {
      cwd: secondBase, windowsHide: true,
      env: { ...process.env, DSH_GW_PORT: String(secondPort), DSH_GW_TARGET_PORT: String(unusedDshPort), DSH_CREDENTIALS_FILE: credentials, DSH_HOME: secondBase, DSH_GW_NO_NOTIFY: '1' },
      stdio: ['ignore', secondLog, secondLog]
    });
    try {
      for (let i = 0; i < 120; i++) {
        if (second.exitCode !== null) throw new Error('second isolated gateway exited before listening');
        try { await request(secondPort, '/__probe'); break; } catch (_) { await sleep(250); }
      }
      const secondLogin = await request(secondPort, entry, remotePairs.join('; '));
      const secondPairs = responseCookies(secondLogin);
      const secondAuth = secondPairs.find(pair => /^dsh-auth-|^pocket-bridge-auth-/.test(pair));
      check(mode + ': two ports sharing one access key issue different browser cookie names', () => {
        assert.equal(secondLogin.status, 200);
        assert.notEqual(secondAuth.split('=')[0], authName);
      });
      const sharedBrowserJar = remotePairs.concat(secondPairs).join('; ');
      const firstAgain = await request(gatewayPort, '/dsh-lite', sharedBrowserJar, authority);
      const secondAgain = await request(secondPort, '/dsh-lite', sharedBrowserJar);
      check(mode + ': both gateways remain authenticated in one browser cookie jar', () => {
        assert.equal(firstAgain.status, 200);
        assert.equal(secondAgain.status, 200);
      });
    } finally {
      if (second.exitCode === null) {
        const stopped = new Promise(resolve => second.once('exit', resolve));
        second.kill(); await stopped;
      }
      fs.closeSync(secondLog);
    }
    const blockedContent = await request(gatewayPort, '/__targets', remotePairs.join('; '), authority);
    check(mode + ': a key login still does not bypass fragment-key proof for content', () => {
      assert.equal(blockedContent.status, 403);
      assert.equal(blockedContent.headers['x-dsh-need-proof'], '1');
    });
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
    fs.closeSync(stdout);
  }
}

(async () => {
  fs.mkdirSync(RUN, { recursive: true });
  try {
    await exercise('gateway-cookie');
    await exercise('dsh-cookie');
    report.push(`${passed} real HTTP checks passed; no production process was contacted or restarted.`);
    console.log(report.at(-1));
  } catch (error) {
    report.push('FAIL ' + error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    const reportPath = path.join(RUN, 'REPORT.txt');
    fs.writeFileSync(reportPath, report.join(os.EOL) + os.EOL);
    console.log('Report: ' + reportPath);
  }
})();
