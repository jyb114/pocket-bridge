// Exercise the real exporter with synthetic records in an owned temporary tree.
// No live logs, gateway, device records, credentials or network are used.
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tempRoot = fs.realpathSync(path.resolve(os.tmpdir()));
const root = fs.mkdtempSync(path.join(tempRoot, 'pb-diagnostic-'));
const owner = crypto.randomBytes(24).toString('hex');
const marker = path.join(root, '.diagnostic-fixture');
const logs = path.join(root, 'logs');
const script = path.join(root, 'scripts', 'diagnostic-bundle.js');
fs.writeFileSync(marker, owner, { flag: 'wx' });

function writeJson(name, value) {
  fs.writeFileSync(path.join(logs, name), JSON.stringify(value, null, 2));
}

function run(stdout = true) {
  const result = spawnSync(process.execPath, [script, ...(stdout ? ['--stdout'] : [])], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true
  });
  if (result.error) throw result.error;
  return result;
}

function parseStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  const start = result.stdout.indexOf('{');
  assert(start >= 0, 'stdout must contain an actual JSON bundle');
  return JSON.parse(result.stdout.slice(start));
}

function exportsOnDisk() {
  return fs.readdirSync(logs).filter(name => /^diagnostic-.*\.json$/.test(name));
}

try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(logs);
  for (const name of ['diagnostic-bundle.js', 'sessions.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0-fixture' }));

  const empty = parseStdout(run());
  assert.equal(empty.devices, null);
  assert.equal(empty.status, null);
  assert.equal(empty.project.version, '0.0.0-fixture');
  assert.equal(empty.runtime.node, process.version);
  assert.deepEqual(exportsOnDisk(), []);
  console.log('OK missing optional files produce a valid stdout bundle without writing a file');

  const sessions = require(path.join(root, 'scripts', 'sessions.js'));
  const addresses = [
    '203.0.113.42', '192.168.48.7', '10.44.55.66', '172.20.22.24',
    '2001:db8:abcd:12::99', 'fe80::abcd', '::1', '::ffff:198.51.100.17'
  ];
  const expectedLabels = [];
  for (const ip of addresses) {
    const created = sessions.create({ ip });
    assert.equal(created.device.label, `未知设备（${ip}）`, 'exercise actual IP fallback creation');
    expectedLabels.push('未知设备');
  }
  const recovered = sessions.create({ ip: '2001:db8::123' });
  sessions.remove(recovered.device.id);
  assert.equal(sessions.recover(recovered.token, { ip: '2001:db8::123' }).label,
    '未知设备（2001:db8::123）', 'exercise actual IP fallback recovery');
  addresses.push('2001:db8::123');
  expectedLabels.push('未知设备');

  const customLabel = 'Synthetic Person / private-project / person@example.invalid';
  sessions.create({
    ua: 'Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/604.1',
    label: customLabel, authority: 'synthetic-authority', ip: '203.0.113.42'
  });
  expectedLabels.push('iPhone · Safari');

  const devices = JSON.parse(fs.readFileSync(sessions.FILE, 'utf8'));
  const arbitraryLabel = { privateName: 'synthetic-label-object', addresses };
  const timestamp = '2026-01-02T03:04:05.000Z';
  for (const [label, ua, expected] of [
    ['synthetic-legacy-label-without-ua', undefined, '未知设备'],
    [arbitraryLabel, { privateUa: 'synthetic-ua-object' }, '未知设备'],
    [['synthetic-label-array'], 'Windows Edg/130.0 synthetic-ua-marker', 'Windows · Edge']
  ]) {
    devices.devices.push({ label, ua, createdAt: timestamp, lastSeenAt: timestamp, revokedAt: timestamp });
    expectedLabels.push(expected);
  }
  writeJson('devices.json', devices);
  const beforeDevices = fs.readFileSync(sessions.FILE, 'utf8');

  // Real values exist in this fixture, so the redaction assertions cannot pass vacuously.
  const access = crypto.randomBytes(24).toString('hex');
  const encryption = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(logs, 'access-key.txt'), access);
  fs.writeFileSync(path.join(logs, 'e2ee-secret.txt'), encryption);
  fs.writeFileSync(path.join(logs, 'pair-code.txt'), '987654');
  writeJson('status.json', { state: 'running', tunnel: { running: true, reachable: false }, pairCode: '987654' });
  writeJson('tunnel-probe.json', { reachable: false, reason: 'fixture-unreachable' });
  writeJson('self-check.json', { checks: [{ id: 'fixture-check', status: 'ok' }] });
  fs.writeFileSync(path.join(logs, 'daemon.log'), `fixture-startup access=${access} encryption=${encryption} pair=987654\n`);
  fs.writeFileSync(path.join(logs, 'proxy.log'), 'fixture-request status=403\n');

  function verify(bundle) {
    assert.deepEqual(bundle.devices.map(device => device.label), expectedLabels,
      'export only fixed device/browser classifications, never the stored free-form label');
    const serialized = JSON.stringify(bundle);
    for (const value of [customLabel, ...addresses, 'synthetic-label-object', 'synthetic-label-array',
      'synthetic-legacy-label-without-ua', 'synthetic-ua-object', 'synthetic-ua-marker',
      'synthetic-authority', access, encryption, '987654',
      ...devices.devices.flatMap(device => [device.id, device.fp]).filter(Boolean)]) {
      assert(!serialized.includes(value), 'synthetic private device data or known credential leaked');
    }
    for (const [index, summary] of bundle.devices.entries()) {
      const original = devices.devices[index];
      assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'hasAuthority', 'label', 'lastSeenAt', 'revoked']);
      assert.equal(summary.createdAt, original.createdAt);
      assert.equal(summary.lastSeenAt, original.lastSeenAt);
      assert.equal(summary.revoked, !!original.revokedAt);
      assert.equal(summary.hasAuthority, !!original.authority);
    }
    assert.equal(bundle.status.state, 'running');
    assert.deepEqual(bundle.status.tunnel, { running: true, reachable: false });
    assert.equal(bundle.tunnelProbe.reason, 'fixture-unreachable');
    assert.equal(bundle.selfCheck.checks[0].status, 'ok');
    assert(bundle.logs.daemon[0].includes('fixture-startup'));
    assert.deepEqual(bundle.logs.proxy, ['fixture-request status=403']);
    assert.equal(fs.readFileSync(sessions.FILE, 'utf8'), beforeDevices, 'export cannot change local device records');
  }

  verify(parseStdout(run()));
  assert.deepEqual(exportsOnDisk(), []);
  console.log('OK stdout omits fallback IPs and arbitrary labels while preserving useful device types, times and status');

  const saved = run(false);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(exportsOnDisk().length, 1);
  verify(JSON.parse(fs.readFileSync(path.join(logs, exportsOnDisk()[0]), 'utf8')));
  console.log('OK file export applies the same privacy boundary and preserves the source records');

  // An unrecognised private-key block must fail closed before either output path.
  fs.writeFileSync(path.join(logs, 'proxy.log'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  const filesBefore = exportsOnDisk();
  for (const stdout of [true, false]) {
    const rejected = run(stdout);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /拒绝写出/);
    assert(!rejected.stdout.includes('{'), 'a failed self-check must not emit a bundle');
    assert.deepEqual(exportsOnDisk(), filesBefore, 'a failed self-check must not write a bundle');
  }
  console.log('OK residual private-key blocks are refused before stdout or file output');
} finally {
  const resolved = fs.realpathSync(root);
  const relative = path.relative(tempRoot, resolved);
  assert.equal(path.relative(root, resolved), '');
  assert.equal(path.dirname(relative), '.');
  assert.match(relative, /^pb-diagnostic-[A-Za-z0-9]{6}$/);
  assert(!fs.lstatSync(root).isSymbolicLink());
  assert.equal(fs.readFileSync(marker, 'utf8'), owner);
  fs.rmSync(resolved, { recursive: true, force: true });
}
