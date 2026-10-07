'use strict';

// All executable files are owned inert fixtures. Version/where child queries
// are injected and inspected; no existing Node, Electron app, GUI or credential
// store is queried or launched by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveBridgeNode } = require('./dsh-plugin-node.js');

let passed = 0;
const failures = [];
async function fixture(run) {
  const parent = fs.realpathSync(process.env.TMPDIR || process.env.TEMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'pb-plugin-node-'));
  const bridge = path.join(root, 'bridge');
  const current = path.join(root, 'current', 'node.exe');
  const systemNode = path.join(root, 'path-bin', 'node.exe');
  const systemRoot = path.join(root, 'system-root');
  const where = path.join(systemRoot, 'System32', 'where.exe');
  const calls = [];
  const killed = [];
  const versions = new Map();
  const behavior = new Map();
  function file(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'Owned inert executable fixture; never actually executed.\n');
    return fs.realpathSync(filename);
  }
  file(current); file(systemNode); file(where); fs.mkdirSync(bridge);
  versions.set(current, 'v24.18.1\n'); versions.set(systemNode, 'v24.18.1\r\n');
  const env = { SystemRoot: systemRoot, PATH: path.dirname(systemNode) };
  let whereOutput = `${systemNode}\r\n`;
  const execute = (filename, args, options, callback) => {
    calls.push({ filename, args, options });
    const child = new EventEmitter();
    child.kill = () => { killed.push(filename); queueMicrotask(() => child.emit('error', Error('owned query deadline'))); };
    const custom = behavior.get(filename);
    if (custom) custom({ filename, args, options, callback, child });
    else queueMicrotask(() => callback(null, filename === where ? whereOutput : versions.get(filename) || 'invalid fixture output'));
    return child;
  };
  const options = { bridgeDirectory: bridge, processExecutable: current, nodeVersion: '24.18.1', isElectron: false };
  const deps = { platform: 'win32', fs, execFile: execute, env, probeTimeoutMs: 30, discoveryTimeoutMs: 30, totalTimeoutMs: 150 };
  const fx = { root, bridge, current, systemNode, systemRoot, where, calls, killed, versions, behavior, env, options, deps, file,
    addRuntime(name, output = 'v24.18.1\n') {
      const filename = file(path.join(bridge, 'runtime', name, 'node.exe')); versions.set(filename, output); return filename;
    }, set whereOutput(value) { whereOutput = value; },
    resolve(optionChanges = {}, dependencyChanges = {}) {
      return resolveBridgeNode({ ...options, ...optionChanges }, { ...deps, ...dependencyChanges });
    } };
  try { await run(fx); }
  finally {
    const absolute = fs.realpathSync(root);
    const relative = path.relative(parent, absolute);
    assert(!path.isAbsolute(relative) && !relative.startsWith('..') && relative.startsWith('pb-plugin-node-'));
    assert.equal(path.dirname(absolute), parent);
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
async function check(name, run) {
  try { await fixture(run); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures.push(name); process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
}
async function unavailable(promise, code = 'node-unavailable') {
  await assert.rejects(promise, error => error.code === code && error.message === code);
}

async function main() {
  await check('Selected bridge runtime wins over current Node and system PATH', async fx => {
    const bundled = fx.addRuntime('node-v24.18.1-win-x64');
    assert.equal(await fx.resolve(), bundled);
    assert.equal(fx.calls.length, 1); assert.deepEqual(fx.calls[0].args, ['--version']);
  });
  await check('Installed runtime candidates are ordered by actual numeric directory versions', async fx => {
    fx.addRuntime('node-v24.9.0-win-x64', 'v24.9.0\n');
    const newest = fx.addRuntime('node-v24.10.0-win-arm64', 'v24.10.0\n');
    assert.equal(await fx.resolve(), newest); assert.equal(fx.calls.length, 1);
  });
  await check('Directory version cannot override an older real Node result', async fx => {
    fx.addRuntime('node-v99.0.0-win-x64', 'v22.18.1\n');
    assert.equal(await fx.resolve(), fx.current); assert.equal(fx.calls.length, 1);
  });
  await check('Running genuine Node 24 returns its absolute path without another probe', async fx => {
    assert.equal(await fx.resolve(), fx.current); assert.equal(fx.calls.length, 0);
  });
  await check('Electron executable is never accepted as the current Node', async fx => {
    const electron = fx.file(path.join(fx.root, 'DeepSeek Harness.exe'));
    assert.equal(await fx.resolve({ isElectron: true, processExecutable: electron, nodeVersion: '28.0.0' }), fx.systemNode);
    assert(fx.calls.every(call => call.filename !== electron));
  });
  await check('Electron remains disallowed even if its executable was named node.exe', async fx => {
    assert.equal(await fx.resolve({ isElectron: true }), fx.systemNode);
    assert(fx.calls.every(call => call.filename !== fx.current));
  });
  await check('Executable basename blocks DeepSeek Harness.exe despite a claimed Node version', async fx => {
    const electron = fx.file(path.join(fx.root, 'DeepSeek Harness.exe'));
    fx.whereOutput = '';
    await unavailable(fx.resolve({ processExecutable: electron, nodeVersion: '28.0.0' }));
    assert(fx.calls.every(call => call.filename !== electron));
  });
  await check('System PATH fallback uses only bounded absolute where.exe then Node probes', async fx => {
    assert.equal(await fx.resolve({ isElectron: true }), fx.systemNode);
    assert.deepEqual(fx.calls.map(call => path.basename(call.filename)), ['where.exe', 'node.exe']);
    assert.deepEqual(fx.calls[0].args, ['node.exe']);
    for (const call of fx.calls) {
      assert(path.isAbsolute(call.filename)); assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.shell, false); assert(call.options.timeout > 0);
      assert(call.options.maxBuffer <= 16384); assert.deepEqual(call.options.env, fx.env);
      assert.equal(Object.hasOwn(call.options.env, 'ELECTRON_RUN_AS_NODE'), false);
    }
  });
  await check('Resolver leaves process PATH and the provided environment unchanged', async fx => {
    const processPath = process.env.PATH;
    const environment = JSON.stringify(fx.env);
    await fx.resolve({ isElectron: true });
    assert.equal(process.env.PATH, processPath); assert.equal(JSON.stringify(fx.env), environment);
  });
  await check('Version and discovery probes do not inherit module-injection or Electron environment flags', async fx => {
    Object.assign(fx.env, { NODE_OPTIONS: '--require owned-fixture.js', Node_Path: 'owned-modules', ELECTRON_RUN_AS_NODE: '1' });
    const original = { ...fx.env };
    assert.equal(await fx.resolve({ isElectron: true }), fx.systemNode);
    assert.deepEqual(fx.env, original);
    for (const call of fx.calls) {
      assert.notEqual(call.options.env, fx.env);
      assert(!Object.keys(call.options.env).some(key => ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
      assert.equal(call.options.env.PATH, fx.env.PATH);
      assert.equal(call.options.env.SystemRoot, fx.env.SystemRoot);
    }
  });
  await check('A valid older current Node falls back to a newer PATH binary', async fx => {
    assert.equal(await fx.resolve({ nodeVersion: '22.18.1' }), fx.systemNode);
  });
  await check('Only confirmed older Node yields node-24-required', async fx => {
    fx.whereOutput = '';
    await unavailable(fx.resolve({ nodeVersion: '22.18.1' }), 'node-24-required');
  });
  await check('A version-looking directory with older probe cannot be accepted', async fx => {
    fx.addRuntime('node-v24.0.0-win-ia32', 'v20.0.0\n'); fx.whereOutput = '';
    await unavailable(fx.resolve({ isElectron: true }), 'node-24-required');
  });
  await check('Missing binaries and discovery failures return sanitized node-unavailable', async fx => {
    await unavailable(fx.resolve({ processExecutable: path.join(fx.root, 'missing', 'node.exe'), nodeVersion: 'nonsense' },
      { discoverCandidates: () => { throw Error('PRIVATE fixture path error'); } }));
  });
  await check('Injected discovery cannot bypass absolute path and Node basename checks', async fx => {
    const gui = fx.file(path.join(fx.root, 'application.exe'));
    await unavailable(fx.resolve({ isElectron: true }, { discoverCandidates: async () => ['node.exe', gui, 'D:/..\u0000/node.exe'] }));
    assert.equal(fx.calls.length, 0);
  });
  for (const output of [' v24.0.0\n', 'v24.0.0\nextra-output', 'v24.0.0-rc.1\n', 'v024.0.0\n', '999999', 'v24.0.0\n\n']) {
    await check('Node output must be exactly a complete stable vX.Y.Z result', async fx => {
      fx.versions.set(fx.systemNode, output);
      await unavailable(fx.resolve({ isElectron: true }));
    });
  }
  await check('Oversized version stdout is rejected before parsing', async fx => {
    fx.versions.set(fx.systemNode, `v24.0.0\n${'x'.repeat(1024)}`);
    await unavailable(fx.resolve({ isElectron: true }));
  });
  await check('Version query errors are sanitized without forwarding original messages', async fx => {
    fx.behavior.set(fx.systemNode, ({ callback }) => queueMicrotask(() => callback(Error('PRIVATE local error path'), 'v24.0.0\n')));
    await unavailable(fx.resolve({ isElectron: true }));
  });
  await check('Version probing has an absolute deadline even if execFile never calls back', async fx => {
    fx.behavior.set(fx.systemNode, () => {});
    const start = Date.now();
    await unavailable(fx.resolve({ isElectron: true }));
    assert(Date.now() - start < 250); assert.deepEqual(fx.killed, [fx.systemNode]);
  });
  await check('where.exe discovery also has an absolute owned-child deadline', async fx => {
    fx.behavior.set(fx.where, () => {});
    const start = Date.now();
    await unavailable(fx.resolve({ isElectron: true }));
    assert(Date.now() - start < 250); assert.deepEqual(fx.killed, [fx.where]);
  });
  await check('Injected asynchronous discovery cannot hang the resolver', async fx => {
    const start = Date.now();
    await unavailable(fx.resolve({ isElectron: true }, { discoverCandidates: () => new Promise(() => {}) }));
    assert(Date.now() - start < 250); assert.equal(fx.calls.length, 0);
  });
  await check('Multiple unresponsive candidates share the overall deadline', async fx => {
    for (let index = 0; index < 8; index++) {
      const node = fx.addRuntime(`node-v24.${index}.0-win-x64`);
      fx.behavior.set(node, () => {});
    }
    const start = Date.now();
    await unavailable(fx.resolve({ isElectron: true }, { totalTimeoutMs: 70 }));
    assert(Date.now() - start < 200); assert(fx.killed.length <= 3);
  });
  await check('A binary modified during --version is never returned', async fx => {
    fx.behavior.set(fx.systemNode, ({ callback }) => queueMicrotask(() => {
      fs.appendFileSync(fx.systemNode, 'changed'); callback(null, 'v24.0.0\n');
    }));
    await unavailable(fx.resolve({ isElectron: true }));
  });
  await check('Read-only regular hardlinked Node executable is allowed', async fx => {
    fs.linkSync(fx.systemNode, path.join(fx.root, 'node-store-copy.exe'));
    assert.equal(await fx.resolve({ isElectron: true }), fx.systemNode);
  });
  await check('A file marked as a symlink is rejected without querying it', async fx => {
    const mocked = Object.create(fs);
    mocked.lstatSync = value => {
      const stat = fs.lstatSync(value);
      return value === fx.systemNode ? { ...stat, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true } : stat;
    };
    await unavailable(fx.resolve({ isElectron: true }, { fs: mocked }));
    assert(fx.calls.every(call => call.filename !== fx.systemNode));
  });
  await check('Linked runtime roots are refused before directory enumeration', async fx => {
    const elsewhere = path.join(fx.root, 'elsewhere'); fs.mkdirSync(elsewhere);
    fx.file(path.join(elsewhere, 'node-v24.0.0-win-x64', 'node.exe'));
    fs.symlinkSync(elsewhere, path.join(fx.bridge, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    fx.whereOutput = '';
    await unavailable(fx.resolve({ isElectron: true }));
    assert.equal(fx.calls.filter(call => path.basename(call.filename) === 'node.exe').length, 0);
  });
  await check('Selected runtime enumeration never descends into arbitrary subfolders', async fx => {
    fx.file(path.join(fx.bridge, 'runtime', 'nested', 'node-v24.0.0-win-x64', 'node.exe'));
    fx.addRuntime('node-v24.0.0-linux-x64'); fx.addRuntime('node-v24-win-x64'); fx.addRuntime('random-node-cache');
    fx.whereOutput = '';
    await unavailable(fx.resolve({ isElectron: true }));
    assert.equal(fx.calls.filter(call => path.basename(call.filename) === 'node.exe').length, 0);
  });
  await check('Unix PATH fallback inspects direct absolute entries without a shell', async fx => {
    const node = fx.file(path.join(fx.root, 'unix-bin', 'node')); fx.versions.set(node, 'v24.1.0\n');
    // The branch is simulated; fixture paths and delimiters stay native to the
    // machine running this test rather than pretending Windows paths are POSIX.
    assert.equal(await fx.resolve({ isElectron: true }, { platform: 'linux', env: { PATH: ['.', 'relative', path.dirname(node)].join(path.delimiter) } }), node);
    assert.equal(fx.calls.length, 1); assert.deepEqual(fx.calls[0].args, ['--version']);
    assert.equal(fx.calls[0].options.shell, false);
  });
  process.stdout.write(`Pocket Bridge Node resolver: ${passed} passed, ${failures.length} failed.\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
