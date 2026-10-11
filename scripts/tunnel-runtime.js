'use strict';

// Reconcile two explicitly opted-in Quick tunnels. Every mutation runs under
// the daemon's installation lease. A failed proof is a blocker, never permission
// to kill by PID or to start an untracked third public entrance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const stateApi = require('./tunnel-state.js');
const tunnel = require('./tunnel.js');

const CHECK_INTERVAL_MS = 60000;
const FAILURE_THRESHOLD = 3;
const START_GRACE_MS = 90000;
const failure = code => Object.assign(Error(code), { code });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nextDelay = count => Math.min(300000, 30000 * 2 ** Math.min(Math.max(count - 1, 0), 4));

function quickLaunch(logDir, role, generation, port, paths = path) {
  if (!stateApi.ROLES.includes(role) || !stateApi.GENERATION.test(generation) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) throw failure('invalid-quick-launch');
  const directory = paths.join(logDir, 'tunnels');
  const logFile = paths.join(directory, role + '-' + generation + '.log');
  const configFile = paths.join(directory, role + '-' + generation + '.yml');
  return { role, generation, logFile, configFile,
    outputFile: paths.join(directory, role + '-' + generation + '.output.log'),
    args: ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate',
      '--logfile', logFile, '--metrics', '127.0.0.1:0', '--config', configFile] };
}
function quickEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(?:TUNNEL_|CLOUDFLARED_)/i.test(name)));
}

function createTunnelRuntime(options, dependencies = {}) {
  const io = dependencies.fs || fs;
  const now = dependencies.now || Date.now;
  const wait = dependencies.sleep || sleep;
  const spawnChild = dependencies.spawn || spawn;
  const adapter = dependencies.processAdapter || require('./tunnel-process.js').createProcessAdapter();
  const probe = dependencies.probe || tunnel.probeUrl;
  const generation = dependencies.generation || (() => crypto.randomBytes(16).toString('hex'));
  const platform = dependencies.platform || process.platform;
  const canonicalExecutable = dependencies.canonicalExecutable || (value => io.realpathSync(value));
  const { logDir, instanceId, port, admission, loadConfig, discoverExecutable, verifyGateway } = options;
  if (!admission || typeof admission.beforeMutation !== 'function' || typeof admission.observeSpawn !== 'function' ||
      typeof loadConfig !== 'function' || typeof discoverExecutable !== 'function' || typeof verifyGateway !== 'function')
    throw failure('dual-tunnel-invalid-options');
  const startedPolicy = JSON.stringify(loadConfig());
  let state;
  let approvedExecutable = null;
  const equalPath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    (platform === 'win32' ? path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase() : left === right);

  function assertSlotOwnership(role, slot) {
    const proof = slot.proof;
    if (!proof) return;
    if (!approvedExecutable || !equalPath(proof.exe, approvedExecutable) || !Array.isArray(proof.args) ||
        !Number.isSafeInteger(slot.targetPort) || slot.targetPort < 1 || slot.targetPort > 65535)
      throw failure('tunnel-slot-owner-mismatch');
    const origin = 'http://127.0.0.1:' + slot.targetPort;
    if (slot.legacy === true) throw failure('tunnel-slot-owner-mismatch');
    const logFile = path.join(logDir, 'tunnels', role + '-' + slot.generation + '.log');
    const configFile = path.join(logDir, 'tunnels', role + '-' + slot.generation + '.yml');
    const expectedArgs = ['tunnel', '--url', origin, '--no-autoupdate', '--logfile', logFile,
      '--metrics', '127.0.0.1:0', '--config', configFile];
    if (proof.role !== role || proof.generation !== slot.generation || proof.logFile !== logFile ||
        proof.configFile !== configFile || JSON.stringify(proof.args) !== JSON.stringify(expectedArgs))
      throw failure('tunnel-slot-owner-mismatch');
  }

  function checkpoint() {
    admission.beforeMutation();
    if (JSON.stringify(loadConfig()) !== startedPolicy) throw failure('daemon-tunnel-policy-changed');
  }
  function persist() { checkpoint(); state.updatedAt = now(); stateApi.writeTunnelState(logDir, state, io); }
  async function after(promise) { const result = await promise; checkpoint(); return result; }
  function freshSlot(role) {
    return { generation: generation(), origin: null, phase: 'unavailable', proof: null, failures: 0,
      rebuilds: 0, checkedAt: null, reachable: false, retryAt: null, startedAt: null, targetPort: port, role };
  }
  function block(slot, code) { slot.phase = 'blocked'; slot.reachable = false; slot.code = code; persist(); }
  async function localReady() {
    if (!await after(verifyGateway())) throw failure('daemon-gateway-identity-changed');
  }
  function publicProjection() {
    return stateApi.publicTunnelState(state, { config: loadConfig(), now: now(), platform, instanceId, port, bootId: options.bootId });
  }

  async function inspectSlot(slot) {
    if (!slot.proof) return { state: slot.phase === 'starting' ? 'unknown' : 'exited' };
    assertSlotOwnership(slot.role, slot);
    return after(adapter.inspect(slot.proof));
  }

  async function stopSlot(slot) {
    if (!slot.proof) {
      if (slot.phase === 'starting' || slot.spawnUnconfirmed) { block(slot, 'tunnel-child-unconfirmed'); return false; }
      return true;
    }
    const inspected = await inspectSlot(slot);
    if (inspected.state === 'unknown') { block(slot, 'tunnel-owner-unconfirmed'); return false; }
    if (inspected.state === 'live') {
      const result = await after(adapter.stop(slot.proof));
      if (!result.stopped) { block(slot, 'tunnel-stop-unconfirmed'); return false; }
    }
    slot.proof = null; slot.origin = null; slot.reachable = false; slot.checkedAt = null;
    return true;
  }

  async function launch(role, slot, executable, allowPrimaryStart) {
    await localReady(); checkpoint();
    if (!stateApi.backupPolicy(loadConfig(), platform).enabled && !(allowPrimaryStart === true && role === 'primary'))
      throw failure('daemon-tunnel-policy-changed');
    const directory = path.join(logDir, 'tunnels');
    try { io.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch (_) { throw failure('tunnel-log-unavailable'); }
    const directoryStat = io.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure('tunnel-log-unavailable');
    const next = freshSlot(role);
    next.rebuilds = (slot.rebuilds || 0) + 1; next.phase = 'starting'; next.startedAt = now(); next.spawnUnconfirmed = true;
    state.slots[role] = next; persist();
    const { logFile, configFile, outputFile, args } = quickLaunch(logDir, role, next.generation, port);
    let fd, child, spawnFailed = false, childClosed = false, observedClose;
    try {
      // Do not inherit a user's named-tunnel, ingress or credential settings.
      // Quick mode gets an empty generation-specific config and explicit
      // loopback origin/metrics, with credential/provider env overrides removed.
      io.writeFileSync(configFile, '{}\n', { flag: 'wx', mode: 0o600 });
      io.writeFileSync(logFile, '', { flag: 'wx', mode: 0o600 });
      fd = io.openSync(outputFile, 'wx', 0o600); checkpoint();
      const environment = quickEnvironment(process.env);
      child = spawnChild(executable, args, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: environment });
      observedClose = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
      child.once('error', () => { spawnFailed = true; });
      const ready = admission.observeSpawn(child, 'tunnel'); child.unref(); await after(ready);
      const proof = await after(adapter.capture(child.pid, { exe: executable, args, role,
        generation: next.generation, logFile, configFile }));
      if (!proof) { block(next, 'tunnel-child-unconfirmed'); return; }
      next.proof = proof; next.spawnUnconfirmed = false; persist();
    } catch (error) {
      if (error.code === 'daemon-spawn-unverified' && spawnFailed && !child?.pid) {
        // A known failed spawn may recover only after its physical CLOSE.
        // Timeout or an ambiguous PID still retains uncertain evidence.
        let timeout;
        try {
          if (!childClosed) await Promise.race([observedClose, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(failure('daemon-spawn-unverified')), 10000);
          })]);
          checkpoint(); next.phase = 'unavailable'; next.spawnUnconfirmed = false;
          next.retryAt = now() + nextDelay(next.rebuilds); persist(); return;
        } finally { clearTimeout(timeout); }
      }
      // Admission cancellation belongs to the daemon, which retains uncertain
      // child evidence and prevents another startup. Never swallow it here.
      if (/^daemon-/.test(error.code || '')) throw error;
      if (!child) { next.phase = 'unavailable'; next.spawnUnconfirmed = false;
        next.retryAt = now() + nextDelay(next.rebuilds); persist(); return; }
      block(next, 'tunnel-child-unconfirmed'); return;
    } finally { if (fd !== undefined) io.closeSync(fd); }

    const deadline = now() + 60000;
    while (now() < deadline) {
      await after(wait(1500));
      const inspected = await inspectSlot(next);
      if (inspected.state !== 'live') {
        if (inspected.state === 'unknown') block(next, 'tunnel-owner-unconfirmed');
        else { next.proof = null; next.spawnUnconfirmed = false; next.phase = 'unavailable';
          next.retryAt = now() + nextDelay(next.rebuilds); persist(); }
        return;
      }
      try {
        const output = io.openSync(outputFile, 'r');
        let raw;
        try { const bytes = Buffer.alloc(262144); raw = bytes.subarray(0, io.readSync(output, bytes, 0, bytes.length, 0)).toString('utf8'); }
        finally { io.closeSync(output); }
        next.origin = stateApi.quickOrigin(tunnel.extractPublicUrl(raw));
      } catch (_) { /* Wait for this generation's output. */ }
      if (next.origin) break;
    }
    if (!next.origin) { next.phase = 'unreachable'; next.retryAt = now() + nextDelay(next.rebuilds); persist(); return; }
    const sibling = state.slots[role === 'primary' ? 'backup' : 'primary'];
    if (sibling?.origin === next.origin) {
      // Two processes pointing at the same advertised hostname are not two
      // entrances. Preserve the existing sibling and retry this new slot later.
      next.origin = null; next.phase = 'unreachable'; next.code = 'duplicate-tunnel-origin';
      next.retryAt = now() + nextDelay(next.rebuilds); persist(); return;
    }
    // An allocated hostname is not readiness. Only a complete external trip
    // back through Cloudflare to the expected gateway boot may advertise it.
    await checkHealth(next, { startup: true });
  }

  async function checkHealth(slot, { startup = false } = {}) {
    if (!slot.origin) return false;
    await localReady();
    const result = await after(probe(slot.origin, startup ? 20000 : 12000, { expectedBootId: options.bootId }));
    slot.checkedAt = now(); slot.reachable = result.ok === true;
    if (slot.reachable) {
      slot.verifiedBootId = options.bootId;
      slot.phase = 'ready'; slot.failures = 0; slot.rebuilds = 0; slot.retryAt = null; slot.code = null;
    } else {
      slot.phase = 'unreachable'; slot.failures = (slot.failures || 0) + 1;
      slot.code = 'public-probe-failed';
    }
    persist(); return slot.reachable;
  }

  async function initialize(executable) {
    const listed = await after(adapter.list({ exe: executable }));
    if (listed.state !== 'ok') throw failure('tunnel-discovery-unconfirmed');
    const processes = listed.processes || [];
    state = { version: 1, instanceId, port, updatedAt: now(), slots: {} };
    if (processes.length) {
      // Old single-tunnel launches have no installation/generation marker.
      // A compatible argv and saved URL do not prove this installation owns
      // the process. Leave it alive and require a verified desktop stop/start.
      for (const role of stateApi.ROLES) state.slots[role] = { ...freshSlot(role), phase: 'blocked' };
      state.code = 'tunnel-migration-unconfirmed'; persist();
      throw failure('tunnel-migration-unconfirmed');
    }
    persist();
  }

  async function reconcile({ refreshRole = null, allowPrimaryStart = false } = {}) {
    checkpoint();
    const policy = stateApi.backupPolicy(loadConfig(), platform);
    // none and unsupported providers/platforms have no process, log, timer or
    // network side effects through this path, including discovery.
    if (!policy.supported || loadConfig().tunnelProvider === 'none') return { state: null, public: publicProjection(), disabled: true };
    state = stateApi.readTunnelState(logDir, io);
    if (state?.invalid) throw failure('tunnel-state-unavailable');
    if (!policy.enabled && !state) return { state: null, public: publicProjection(), disabled: true };
    if (refreshRole !== null && !stateApi.ROLES.includes(refreshRole)) throw failure('invalid-tunnel-role');
    await localReady();
    const executable = await after(discoverExecutable());
    if (!executable) throw failure('cloudflared-unavailable');
    try { approvedExecutable = await after(canonicalExecutable(executable)); }
    catch (_) { throw failure('cloudflared-identity-unavailable'); }
    if (!state) await initialize(executable);
    if (state.instanceId !== instanceId) throw failure('tunnel-installation-mismatch');
    for (const role of stateApi.ROLES) if (state.slots[role]) {
      try {
        if (state.slots[role].role !== role) throw failure('tunnel-slot-owner-mismatch');
        assertSlotOwnership(role, state.slots[role]);
      } catch (error) {
        block(state.slots[role], 'tunnel-slot-owner-mismatch'); throw error;
      }
    }

    // Inventory is checked before creation even after restart. Extra unknown
    // processes may be an interrupted spawn and must not be ignored.
    const listed = await after(adapter.list({ exe: executable }));
    if (listed.state !== 'ok') throw failure('tunnel-discovery-unconfirmed');
    const known = Object.values(state.slots).map(slot => slot.proof).filter(Boolean);
    if ((listed.processes || []).some(proof => !known.some(item => item.pid === proof.pid && item.birth === proof.birth)))
      throw failure('tunnel-extra-process-unconfirmed');
    state.code = null;

    if (!policy.enabled) {
      if (state.slots.backup && await stopSlot(state.slots.backup)) {
        state.slots.backup.phase = 'disabled'; state.slots.backup.retryAt = null; persist();
      }
      // Opt-out stops automatic creation/repair, not truthful verification of
      // the surviving primary. Periodic helpers may refresh its health only;
      // they never resurrect an absent primary or recreate the backup.
      if (allowPrimaryStart !== true) {
        const primary = state.slots.primary;
        if (primary) {
          const inspected = await inspectSlot(primary);
          if (inspected.state === 'unknown') block(primary, 'tunnel-owner-unconfirmed');
          else if (inspected.state === 'exited') {
            primary.proof = null; primary.origin = null; primary.reachable = false;
            primary.phase = 'unavailable'; primary.checkedAt = null; persist();
          } else if (!primary.origin || primary.targetPort !== port) {
            primary.reachable = false; primary.phase = 'unreachable'; primary.checkedAt = null; persist();
          } else {
            const age = now() - Number(primary.checkedAt);
            if (primary.verifiedBootId !== options.bootId || !primary.checkedAt || age < 0 || age >= CHECK_INTERVAL_MS)
              await checkHealth(primary);
          }
        }
        return { state, public: publicProjection(), disabled: true };
      }
    }

    for (const role of stateApi.ROLES) {
      checkpoint();
      if (!policy.enabled && role !== 'primary') continue;
      if (refreshRole && role !== refreshRole) continue;
      let slot = state.slots[role];
      if (!slot) { slot = freshSlot(role); state.slots[role] = slot; persist(); }
      // Automatic checks never create a hot loop. Manual slot refresh only
      // bypasses the scheduled retry once, under the same ownership lease.
      if (refreshRole !== role && !(allowPrimaryStart === true && !policy.enabled && role === 'primary') &&
          slot.retryAt && now() < slot.retryAt) continue;
      const inspected = await inspectSlot(slot);
      if (inspected.state === 'unknown') { block(slot, 'tunnel-owner-unconfirmed'); continue; }
      let replace = inspected.state === 'exited' || (slot.targetPort || state.port) !== port || refreshRole === role;
      if (!replace && slot.origin) {
        const age = now() - Number(slot.checkedAt);
        if (slot.verifiedBootId === options.bootId && slot.checkedAt && age >= 0 && age < CHECK_INTERVAL_MS) continue;
        if (await checkHealth(slot)) continue;
        replace = slot.failures >= FAILURE_THRESHOLD && now() - (slot.startedAt || 0) >= START_GRACE_MS;
      } else if (!replace && !slot.origin) {
        replace = now() - (slot.startedAt || 0) >= START_GRACE_MS;
      }
      if (!replace) continue;
      if (!await stopSlot(slot)) continue;
      slot.phase = 'rebuilding'; slot.retryAt = now() + nextDelay((slot.rebuilds || 0) + 1); persist();
      await launch(role, slot, executable, allowPrimaryStart);
    }
    state.port = port; persist();
    return { state, public: publicProjection() };
  }

  return { reconcile };
}

module.exports = { createTunnelRuntime, CHECK_INTERVAL_MS, FAILURE_THRESHOLD, START_GRACE_MS, nextDelay, quickLaunch, quickEnvironment };
