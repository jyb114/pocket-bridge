'use strict';

// The gateway owns this timer. The repair helper can only reconcile the exact
// already-running gateway boot; it has no permission to resurrect a gateway.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { backupPolicy } = require('./tunnel-state.js');
const INTERVAL_MS = 60000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function createTunnelWatchdog({ base, context, onError = () => {} }, dependencies = {}) {
  if (typeof context !== 'function') throw TypeError('Invalid tunnel watchdog context.');
  const spawnChild = dependencies.spawn || spawn;
  const schedule = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  const platform = dependencies.platform || process.platform;
  const executable = dependencies.executable || process.execPath;
  let closed = false, timer = null, pending = null, pendingIntent = null, queued = null;
  function report(code) { try { onError(code); } catch (_) {} }

  function plan() {
    if (closed || timer) return;
    timer = schedule(() => { timer = null; request(); plan(); }, INTERVAL_MS);
    timer.unref?.();
  }
  function request({ refreshRole = null, retireBackup = false } = {}) {
    if (closed) return false;
    const current = context();
    const policy = backupPolicy(current?.config, platform);
    if (!current || current.phase !== 'running' || !policy.supported ||
        !policy.enabled && !retireBackup && current.managed !== true || current.config?.tunnelProvider === 'none' ||
        !UUID.test(current.instanceId || '') || !UUID.test(current.bootId || '') ||
        !Number.isSafeInteger(current.port) || current.port < 1 || current.port > 65535 ||
        !Number.isSafeInteger(current.pid) || current.pid < 1 ||
        refreshRole !== null && !['primary', 'backup'].includes(refreshRole)) return false;
    if (pending) {
      if (pendingIntent?.refreshRole === refreshRole && pendingIntent.retireBackup === retireBackup &&
          pendingIntent.enabled === policy.enabled) return false;
      // An explicit disable during startup must be reconciled after the
      // current helper quiesces. Later managed/off ticks can verify the live
      // primary only. Keep the latest request for this exact gateway boot.
      queued = { refreshRole, retireBackup, bootId: current.bootId, instanceId: current.instanceId,
        pid: current.pid, port: current.port };
      return false;
    }
    const args = [path.join(base, 'scripts', 'gateway-daemon.js'), '--repair-tunnels', '--port', String(current.port),
      '--expected-instance', current.instanceId, '--expected-boot', current.bootId, '--expected-pid', String(current.pid)];
    if (refreshRole) args.push('--refresh-slot', refreshRole);
    try {
      const child = spawnChild(executable, args, { cwd: base, windowsHide: true, detached: false, stdio: 'ignore' });
      pending = child;
      pendingIntent = { refreshRole, retireBackup, enabled: policy.enabled };
      child.once('error', () => {
        // A failed spawn with no PID is known absent. A late failure with a PID
        // remains pending until close, rather than admitting another helper.
        if (!child.pid && pending === child) { pending = null; pendingIntent = null; }
        report('tunnel-repair-start-unconfirmed');
      });
      child.once('close', code => {
        if (pending === child) { pending = null; pendingIntent = null; }
        if (code) report('tunnel-repair-unavailable');
        const next = queued; queued = null;
        const fresh = context();
        if (next && !closed && ['bootId', 'instanceId', 'pid', 'port'].every(key => fresh?.[key] === next[key]))
          request({ refreshRole: next.refreshRole, retireBackup: next.retireBackup });
      });
      child.unref?.(); return true;
    } catch (_) { report('tunnel-repair-start-unconfirmed'); return false; }
  }
  function start() { if (closed) return false; plan(); return true; }
  function stop() { closed = true; queued = null; if (timer) cancel(timer); timer = null; }
  return { start, request, stop, status: () => ({ active: !closed, pending: !!pending }) };
}

module.exports = { createTunnelWatchdog, INTERVAL_MS };
