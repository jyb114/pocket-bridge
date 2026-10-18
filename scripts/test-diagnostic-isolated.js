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

function run(stdout = true, env = {}) {
  const result = spawnSync(process.execPath, [script, ...(stdout ? ['--stdout'] : [])], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000, windowsHide: true
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

  // Windows installs commonly live below spaced user and application directories.
  // Exercise the actual daemon/self-check formats, JSON escapes and UNC shares,
  // rather than checking only whether a drive-letter prefix disappeared.
  const windowsHome = String.raw`C:\Users\Synthetic PrivateSurname`;
  const windowsNode = windowsHome + String.raw`\AppData\Local\Programs\Pocket Bridge\runtime\node\node.exe`;
  const windowsDsh = windowsHome + String.raw`\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`;
  const uncPath = String.raw`\\fixture-host\Private Share\Private Project\Private Report.txt`;
  const punctuatedPath = String.raw`C:\Users\Synthetic O'Connor\Private Project (draft)\Private Report.txt`;
  const pathStatus = { state: 'running', tunnel: { running: true, reachable: false },
    pairCode: '987654', numericPairCode: 987654,
    nested: { paths: [windowsNode, uncPath, punctuatedPath], values: [null, false, 42] },
    detail: `Could not open "${windowsDsh}"; retry=true`,
    [uncPath]: 'path-key-value' };
  writeJson('status.json', pathStatus);
  writeJson('self-check.json', { summary: { pass: 1, warn: 0, fail: 0 }, results: [
    { id: 'dsh-discovery', status: 'pass', detail: `来源「fixture」→ ${windowsDsh}` }
  ] });
  fs.writeFileSync(path.join(logs, 'daemon.log'),
    `2026-01-02T03:04:05.000Z 启动中间层（node: ${windowsNode}）\n`);
  fs.writeFileSync(path.join(logs, 'proxy.log'),
    `fixture-read "${uncPath}" status=403\nfixture-read ${punctuatedPath}\n` +
    `fixture-help ${windowsNode} https://example.invalid/support\n`);
  const sourceSnapshots = ['status.json', 'self-check.json', 'daemon.log', 'proxy.log']
    .map(name => [name, fs.readFileSync(path.join(logs, name), 'utf8')]);
  const windowsEnv = { HOME: windowsHome, USERPROFILE: windowsHome };

  function verifyWindowsPaths(bundle) {
    const serialized = JSON.stringify(bundle);
    for (const privatePart of ['PrivateSurname', 'fixture-host', 'Private Share', 'Private Project',
      'Private Report', "O'Connor", 'Pocket Bridge', 'DeepSeek Harness', '987654']) {
      assert(!serialized.includes(privatePart), `private Windows path component or credential leaked: ${privatePart}`);
    }
    assert.equal(bundle.status.state, 'running');
    assert.deepEqual(bundle.status.tunnel, { running: true, reachable: false });
    assert.equal(bundle.status.pairCode, '<配对码>');
    assert.equal(bundle.status.numericPairCode, '<配对码>');
    assert.deepEqual(bundle.status.nested.paths, ['<路径 .exe>', '<路径 .txt>', '<路径 .txt>']);
    assert.deepEqual(bundle.status.nested.values, [null, false, 42]);
    assert.equal(bundle.status.detail, 'Could not open "<路径 .exe>"; retry=true');
    assert.equal(bundle.status['<路径 .txt>'], 'path-key-value');
    assert.deepEqual(bundle.selfCheck.summary, { pass: 1, warn: 0, fail: 0 });
    assert.equal(bundle.selfCheck.results[0].detail, '来源「fixture」→ <路径 .exe>');
    assert.deepEqual(bundle.logs.daemon,
      ['2026-01-02T03:04:05.000Z 启动中间层（node: <路径 .exe>）']);
    assert.deepEqual(bundle.logs.proxy,
      ['fixture-read "<路径 .txt>" status=403', 'fixture-read <路径 .txt>',
        'fixture-help <路径 .exe> https://example.invalid/support']);
    for (const [name, original] of sourceSnapshots) {
      assert.equal(fs.readFileSync(path.join(logs, name), 'utf8'), original, 'export must preserve source files');
    }
  }

  verifyWindowsPaths(parseStdout(run(true, windowsEnv)));
  const beforeWindowsFiles = exportsOnDisk();
  const windowsSaved = run(false, windowsEnv);
  assert.equal(windowsSaved.status, 0, windowsSaved.stderr);
  const windowsFiles = exportsOnDisk().filter(name => !beforeWindowsFiles.includes(name));
  assert.equal(windowsFiles.length, 1);
  verifyWindowsPaths(JSON.parse(fs.readFileSync(path.join(logs, windowsFiles[0]), 'utf8')));
  console.log('OK spaced Windows and UNC paths are fully redacted in stdout/file exports without losing status or source records');

  // These are the exact accepted configuration/log shapes. No notification is
  // sent: the exporter runs only against synthetic files in this owned tree.
  const notificationCases = [
    { name: 'default providers',
      ntfy: 'https://ntfy.sh/SyntheticDefaultTopic', bark: 'https://api.day.app/SyntheticDefaultBarkKey',
      privateParts: ['SyntheticDefaultTopic', 'SyntheticDefaultBarkKey'] },
    { name: 'custom servers and nested paths/query credentials',
      ntfy: 'https://notify.example.invalid/private/SyntheticTopicKey?token=SyntheticQuerySecret&lang=zh',
      bark: 'https://bark.example.invalid/api/SyntheticBarkKey/',
      privateParts: ['SyntheticTopicKey', 'SyntheticQuerySecret', 'SyntheticBarkKey'] },
    { name: 'encoded paths/query values and canonical URLs',
      ntfy: 'HTTP://NOTIFY.EXAMPLE.INVALID:80/Topic%2fSecret%20Encoded?auth=Query%2bSecret%20Encoded',
      bark: 'https://bark.example.invalid/api/Bark%2fSecret%20Encoded/?token=SyntheticBarkQuery',
      privateParts: ['Topic/Secret Encoded', 'Query+Secret Encoded', 'Bark/Secret Encoded', 'SyntheticBarkQuery'] },
    { name: 'one-character topics/keys/query values',
      ntfy: 'https://notify.example.invalid/a?token=b', bark: 'https://bark.example.invalid/x/',
      privateParts: [] },
    { name: 'standalone short default-provider credentials',
      ntfy: 'https://ntfy.sh/a1b2', bark: 'https://api.day.app/b3c4d',
      privateParts: ['a1b2', 'b3c4d'], bareParts: ['a1b2', 'b3c4d'] },
    { name: 'standalone short custom-server credentials',
      ntfy: 'https://notify.example.invalid/api/key1234?token=q1w2e',
      bark: 'https://bark.example.invalid/api/z9x8c6/',
      privateParts: ['key1234', 'q1w2e', 'z9x8c6'], bareParts: ['key1234', 'q1w2e', 'z9x8c6'] },
    { name: 'accepted malformed notification URL',
      ntfy: 'https://[invalid/SyntheticMalformedKey?token=SyntheticMalformedQuery',
      bark: 'https://bark.example.invalid/SyntheticValidBark',
      privateParts: ['SyntheticMalformedKey', 'SyntheticMalformedQuery', 'SyntheticValidBark'] },
    { name: 'quoted notification destination',
      ntfy: 'https://notify.example.invalid/Synthetic"QuotedKey?token=SyntheticQuotedQuery',
      bark: 'https://bark.example.invalid/SyntheticOtherKey',
      privateParts: ['Synthetic"QuotedKey', 'SyntheticQuotedQuery', 'SyntheticOtherKey'] },
    { name: 'unpaired-surrogate destination retains raw/canonical protection',
      ntfy: 'https://notify.example.invalid/Odd\uD800PrivateKey',
      bark: 'https://bark.example.invalid/SyntheticSurrogateControl',
      privateParts: ['Odd\uD800PrivateKey', 'Odd\uFFFDPrivateKey', 'SyntheticSurrogateControl'] },
    { name: 'standalone quoted short credentials',
      ntfy: 'https://ntfy.sh/ab"cd', bark: 'https://bark.example.invalid/x"yz7',
      privateParts: ['ab"cd', 'x"yz7'], bareParts: ['ab"cd', 'x"yz7'] },
    { name: 'standalone backslash short credentials',
      ntfy: 'https://notify.example.invalid/ab%5Ccd', bark: 'https://bark.example.invalid/x%5Cyz7',
      privateParts: ['ab\\cd', 'x\\yz7'], bareParts: ['ab\\cd', 'x\\yz7'] }
  ];
  const notifyPath = path.join(logs, 'notify-targets.json');
  for (const item of notificationCases) {
    const targets = { ntfy: item.ntfy, bark: item.bark };
    writeJson('notify-targets.json', targets);
    const representations = [];
    for (const target of Object.values(targets)) {
      representations.push(target);
      try { representations.push(encodeURIComponent(target),
        encodeURIComponent(target).replace(/%[0-9a-f]{2}/gi, escape => escape.toLowerCase())); } catch (err) { }
      try { representations.push(decodeURIComponent(target)); } catch (err) { }
      try { representations.push(new URL(target).href); } catch (err) { }
    }
    writeJson('status.json', { state: 'running', numeric: 42, enabled: true,
      destinations: representations, [item.ntfy]: 'configured' });
    // Match the sender's actual transformations, which differ from the saved
    // URL when ntfy has a query or Bark has a trailing slash.
    fs.writeFileSync(path.join(logs, 'proxy.log'),
      `通知主题已设为 ${item.ntfy}\nBark 已设为 ${item.bark.replace(/\/+$/, '')}\n` +
      `ntfy-request ${item.ntfy.split('?')[0]}?title=Synthetic%20title&tags=robot\n` +
      `bark-request ${item.bark.replace(/\/+$/, '')}/Synthetic-title/Synthetic-content?group=dsh\n` +
      (item.bareParts || []).map(part => `credential=${part}\n` + JSON.stringify({ topic: part }) + '\n').join(''));
    const snapshots = ['notify-targets.json', 'status.json', 'proxy.log', 'devices.json']
      .map(name => [name, fs.readFileSync(path.join(logs, name), 'utf8')]);
    function verifyNotifications(bundle) {
      assert.equal(bundle.status.state, 'running');
      assert.equal(bundle.status.numeric, 42);
      assert.equal(bundle.status.enabled, true);
      assert(bundle.status.destinations.every(value => value === '<通知凭据>'),
        'full destinations, including short secrets, must become one fixed marker');
      assert.equal(bundle.status['<通知凭据>'], 'configured');
      const serialized = JSON.stringify(bundle);
      for (const value of [...representations, ...item.privateParts]) {
        assert(!serialized.includes(value), 'configured notification credential leaked: ' + item.name);
        assert(!serialized.includes(JSON.stringify(value).slice(1, -1)), 'escaped notification credential leaked');
      }
      assert(bundle.logs.proxy.every(line => line.includes('<通知凭据>')));
      for (const line of bundle.logs.proxy.filter(line => line.startsWith('{'))) {
        assert.equal(JSON.parse(line).topic, '<通知凭据>', 'JSON log values must not recover the original secret');
      }
      for (const [name, original] of snapshots) {
        assert.equal(fs.readFileSync(path.join(logs, name), 'utf8'), original, 'export must preserve source files');
      }
    }
    verifyNotifications(parseStdout(run()));
    const existingFiles = exportsOnDisk();
    const fileResult = run(false);
    assert.equal(fileResult.status, 0, fileResult.stderr);
    const added = exportsOnDisk().filter(name => !existingFiles.includes(name));
    assert.equal(added.length, 1);
    verifyNotifications(JSON.parse(fs.readFileSync(path.join(logs, added[0]), 'utf8')));
    console.log('OK notification stdout/file redaction: ' + item.name);
  }

  // Device timestamps are copied rather than scrubbed. A synthetic malformed
  // record exercises the final independent refusal path, including JSON's
  // escaping of a quoted destination. It must never write a partial bundle.
  const residualCases = notificationCases.map(item => ({ original: item.ntfy, destination: item.ntfy }));
  residualCases.push({ original: notificationCases[2].ntfy, destination: encodeURIComponent(notificationCases[2].ntfy) },
    { original: 'https://ntfy.sh/key1234', destination: 'key1234' },
    { original: 'https://notify.example.invalid/key1234', destination: 'key1234' },
    { original: 'https://ntfy.sh/ab"cd', destination: 'ab"cd' },
    { original: 'https://notify.example.invalid/ab"cd', destination: 'ab"cd' },
    { original: 'https://notify.example.invalid/ab"cd', destination: JSON.stringify({ topic: 'ab"cd' }) },
    { original: 'https://notify.example.invalid/ab%5Ccd', destination: JSON.stringify({ topic: 'ab\\cd' }) });
  for (const { original, destination } of residualCases) {
    writeJson('notify-targets.json', { ntfy: original });
    const invalidDevices = JSON.parse(beforeDevices);
    invalidDevices.devices[0].createdAt = destination;
    writeJson('devices.json', invalidDevices);
    const filesBefore = exportsOnDisk();
    for (const stdout of [true, false]) {
      const rejected = run(stdout);
      assert.equal(rejected.status, 1, 'residual configured target must fail closed');
      assert.match(rejected.stderr, /拒绝写出/);
      assert(!rejected.stdout.includes('{'));
      assert.deepEqual(exportsOnDisk(), filesBefore);
    }
  }
  fs.writeFileSync(path.join(logs, 'devices.json'), beforeDevices);
  fs.unlinkSync(notifyPath);
  console.log('OK known notification destinations, including short/encoded/quoted forms, fail closed if any survive');

  // Parser diagnostics can quote malformed source text. Never export that text.
  const malformed = 'PrivateMalformedSource { invalid JSON';
  fs.writeFileSync(path.join(logs, 'self-check.json'), malformed);
  const malformedBundle = parseStdout(run(true, windowsEnv));
  assert.deepEqual(malformedBundle.selfCheck, { _解析失败: '无效 JSON' });
  assert(!JSON.stringify(malformedBundle).includes('PrivateMal'));
  assert.equal(malformedBundle.status.state, 'running');
  console.log('OK malformed JSON returns a fixed failure marker without source snippets');

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
