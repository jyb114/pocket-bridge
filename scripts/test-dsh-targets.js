'use strict';
// Run the actual targets module against in-memory OS/process/runtime boundaries.
// No installed application, account, project, process, or config file is touched.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const lang = require('./server-lang');
const source = fs.readFileSync(path.join(__dirname, 'targets.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0;

function fixture(options = {}) {
  const calls = { spawn: [], exec: [], kill: [], invalidations: 0, timers: 0, opened: [], closed: [], unrefs: 0 };
  const files = new Map();
  const normalize = value => path.win32.normalize(String(value));
  const installed = options.installed || { installed: false, kind: null, profile: 'unsupported', launch: null };
  let runtime = options.runtime || { installed: false, running: false, kind: null, port: null, profile: 'unsupported' };
  if (options.ownedPid) files.set(normalize('D:/fixture/logs/target-dsh-web.pid'), String(options.ownedPid));
  const io = {
    existsSync: () => false,
    readFileSync(file) { if (!files.has(normalize(file))) throw new Error('fixture file missing'); return files.get(normalize(file)); },
    writeFileSync(file, value) { files.set(normalize(file), String(value)); },
    appendFileSync() {}, mkdirSync() {},
    openSync(file, mode) { calls.opened.push({ file, mode }); return 71; },
    closeSync(fd) { calls.closed.push(fd); },
    unlinkSync(file) { files.delete(normalize(file)); }
  };
  const runtimeApi = {
    detectInstallation() { return clone(installed); },
    async resolveRuntime() { return clone(runtime); },
    serializeRuntime(value) { return clone(value); },
    invalidateRuntime() { calls.invalidations++; },
    scanProcesses() { return clone(options.processes || []); }
  };
  const childProcess = {
    spawn(exe, args, settings) {
      calls.spawn.push({ exe, args: clone(args), settings: clone(settings) });
      const child = new EventEmitter(); child.pid = options.childPid || 4567;
      child.unref = () => { calls.unrefs++; };
      if (options.afterSpawn) runtime = clone(options.afterSpawn);
      return child;
    },
    execFileSync(exe, args, settings) {
      calls.exec.push({ exe, args: clone(args), settings: clone(settings) });
      if (exe === 'tasklist') return 'DeepSeek Harness.exe 1234';
      return '';
    }
  };
  const cfg = { BASE: 'D:/fixture/base', LOG_DIR: 'D:/fixture/logs', loadConfig: () => clone(options.config || {}) };
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, URL, Date,
    process: { platform: 'win32', env: { LOCALAPPDATA: 'D:/fixture/local', ProgramFiles: 'D:/fixture/programs' },
      kill(pid, signal) { calls.kill.push({ pid, signal }); } },
    setTimeout(fn) { calls.timers++; queueMicrotask(fn); return { unref() {} }; }, clearTimeout() {},
    require(name) {
      if (name === 'fs') return io;
      if (name === 'os') return { homedir: () => 'D:/fixture/home' };
      if (name === 'path') return path;
      if (name === 'net') return { connect() { const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {}; queueMicrotask(() => socket.emit('error', new Error('fixture has no Codex listener'))); return socket; } };
      if (name === 'http') return { get() { throw new Error('unexpected live HTTP'); } };
      if (name === 'child_process') return childProcess;
      if (name === './config.js') return cfg;
      if (name === './server-lang.js') return lang;
      if (name === './dsh-runtime.js') return runtimeApi;
      throw new Error('Unexpected fixture dependency: ' + name);
    }
  };
  vm.runInNewContext(source, sandbox, { filename: 'targets.js' });
  return { api: sandbox.module.exports, calls, files };
}
const cliRuntime = { installed: true, running: true, kind: 'cli', version: '0.1.5-rc.3',
  source: 'process', profile: 'remote-mux', pid: 9001, port: 19387, supported: true };
const cliLaunch = { installed: true, kind: 'cli', version: '0.1.5-rc.3', profile: 'remote-mux',
  source: 'config.json', launch: { kind: 'cli', exe: 'D:/Node runtime/node.exe',
    args: ['D:/测试 项目/agent\'s $entry & main.js', 'web', '--no-open', '--port', '19387'], cwd: 'D:/测试 项目' } };
async function test(title, body) {
  try { await body(); passed++; console.log('PASS: ' + title); }
  catch (error) { failed++; console.error('FAIL: ' + title + ': ' + error.message); }
}

(async () => {
  await test('CLI-only running listener is installed, available and identifies its actual runtime', async () => {
    const f = fixture({ runtime: cliRuntime });
    const st = await f.api.dsh.status('en');
    assert.equal(st.installed, true); assert.equal(st.running, true); assert.equal(st.port, 19387);
    assert.equal(st.kind, 'cli'); assert.equal(st.source, 'process'); assert.equal(st.version, '0.1.5-rc.3');
    assert.equal(st.canStart, false); assert.equal(st.exe, null);
    const available = await f.api.available(); assert.equal(available.length, 1); assert.equal(available[0].id, 'dsh');
    assert.equal(f.calls.spawn.length, 0); assert.equal(f.calls.exec.length, 0);
  });
  await test('Runtime edition and version localize from cached status in all supported languages', async () => {
    const f = fixture({ runtime: cliRuntime }); const st = await f.api.dsh.status('zh');
    const expected = { zh: 'Web 版', en: 'Web', es: 'Web' };
    for (const language of ['zh', 'en', 'es']) {
      const translated = f.api.localize([st], language)[0];
      assert(translated.note.includes(expected[language])); assert(translated.note.includes('0.1.5-rc.3'));
      assert(translated.note.includes('19387')); assert(!/[{}]/.test(translated.note));
      if (language !== 'zh') assert(!/[\u4e00-\u9fff]/.test(translated.note));
    }
  });
  await test('Unknown runtime version gets a localized fallback, never an undefined label', async () => {
    const f = fixture({ runtime: { ...cliRuntime, version: null } });
    assert((await f.api.dsh.status('en')).note.includes('unknown version'));
    assert((await f.api.dsh.status('es')).note.includes('versión desconocida'));
  });
  await test('IPC-only desktop launch is rejected immediately without shell or waiting', async () => {
    const f = fixture({ installed: { installed: true, kind: 'desktop', profile: 'desktop-ipc', version: '0.1.0-rc.8', launch: null } });
    const st = await f.api.dsh.status('en'); assert.equal(st.noteKey, 'dshIpc'); assert.equal(st.running, false);
    const result = await f.api.dsh.start('en'); assert.equal(result.ok, false);
    assert(result.message.includes('does not share tasks')); assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.timers, 0);
  });
  await test('Detect and missing-install start never invoke npm, npx, shell or an installer', async () => {
    const f = fixture(); assert.equal(f.api.dsh.detect().installed, false);
    assert.equal((await f.api.dsh.start('en')).ok, false);
    assert.equal(f.calls.spawn.length, 0); assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.timers, 0);
  });
  await test('Configured CLI launches node with separate unchanged argv, hidden window and file logs', async () => {
    const f = fixture({ installed: cliLaunch, afterSpawn: { ...cliRuntime, pid: 4567 }, childPid: 4567 });
    const result = await f.api.dsh.start('en'); assert.equal(result.ok, true); assert.equal(result.port, 19387);
    assert.equal(f.calls.spawn.length, 1); const call = f.calls.spawn[0];
    assert.equal(call.exe, cliLaunch.launch.exe); assert.deepEqual(call.args, cliLaunch.launch.args);
    assert.equal(call.settings.cwd, cliLaunch.launch.cwd); assert.equal(call.settings.windowsHide, true);
    assert.equal(call.settings.detached, true); assert.equal(call.settings.shell, undefined);
    assert.deepEqual(call.settings.stdio, ['ignore', 71, 71]); assert.equal(f.calls.opened[0].mode, 'a');
    assert(/dsh-web\.log$/.test(f.calls.opened[0].file)); assert.deepEqual(f.calls.closed, [71]);
    assert.equal(f.calls.unrefs, 1); assert.equal(f.calls.exec.length, 0);
    assert.equal(f.files.get(path.win32.normalize('D:/fixture/logs/target-dsh-web.pid')), '4567');
  });
  await test('Existing CLI listener is reused without spawning a duplicate', async () => {
    const f = fixture({ installed: cliLaunch, runtime: cliRuntime }); const result = await f.api.dsh.start('en');
    assert.equal(result.ok, true); assert.equal(result.already, true); assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.invalidations, 0);
  });
  await test('Externally launched CLI is never stopped or replaced by desktop killing', async () => {
    const f = fixture({ runtime: cliRuntime }); const result = await f.api.dsh.stop('en');
    assert.equal(result.ok, false); assert(result.message.includes('original terminal'));
    assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.kill.length, 0);
  });
  await test('Stale PID pointing to arbitrary Node cannot authorize a CLI stop', async () => {
    const f = fixture({ runtime: cliRuntime, ownedPid: 9001, processes: [{ pid: 9001, kind: 'node' }] });
    assert.equal((await f.api.dsh.stop('en')).ok, false); assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.kill.length, 0);
  });
  await test('A different old bridge CLI PID cannot stop the selected external CLI', async () => {
    const f = fixture({ runtime: cliRuntime, ownedPid: 4567, processes: [{ pid: 4567, kind: 'cli' }, { pid: 9001, kind: 'cli' }] });
    assert.equal((await f.api.dsh.stop('en')).ok, false); assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.kill.length, 0);
  });
  await test('Owned selected CLI is stopped by its exact PID, without image-name or arbitrary Node killing', async () => {
    const f = fixture({ runtime: cliRuntime, ownedPid: 9001, processes: [{ pid: 9001, kind: 'cli' }] });
    assert.equal((await f.api.dsh.stop('en')).ok, true); assert.equal(f.calls.exec.length, 1);
    assert.equal(f.calls.exec[0].exe, 'taskkill'); assert.deepEqual(f.calls.exec[0].args, ['/PID', '9001', '/T', '/F']);
    assert.equal(f.calls.exec[0].settings.windowsHide, true); assert.equal(f.calls.kill.length, 0);
    assert.equal(f.files.has(path.win32.normalize('D:/fixture/logs/target-dsh-web.pid')), false);
    assert.equal(f.calls.invalidations, 1);
  });
  await test('Stopped CLI runtime does not fall through to killing the desktop application', async () => {
    const f = fixture({ installed: cliLaunch, runtime: { ...cliRuntime, running: false, port: null } });
    assert.equal((await f.api.dsh.stop('en')).ok, false); assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.kill.length, 0);
  });
  await test('Selected CLI installation with no runtime does not kill an unrelated desktop application', async () => {
    const f = fixture({ installed: cliLaunch }); assert.equal((await f.api.dsh.stop('en')).ok, false);
    assert.equal(f.calls.exec.length, 0); assert.equal(f.calls.kill.length, 0);
  });
  console.log('DSH targets lifecycle fixtures: ' + passed + ' passed, ' + failed + ' failed.');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
