'use strict';

// Public addresses are not credentials. Keep the private process evidence in
// this file, and expose only the small allowlisted projection below.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FRESHNESS_MS = 180000;
const ROLES = Object.freeze(['primary', 'backup']);
const GENERATION = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(['starting', 'ready', 'unreachable', 'rebuilding', 'blocked', 'unavailable', 'disabled']);
const failure = code => Object.assign(Error(code), { code });

function quickOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
        !['', '/'].includes(url.pathname) ||
        !/^(?!(?:api|www|dash|developers)\.)[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname)) return null;
    return url.origin;
  } catch (_) { return null; }
}

function backupPolicy(config = {}, platform = process.platform) {
  const provider = config.tunnelProvider === undefined ? 'auto' : config.tunnelProvider;
  const allowed = ['auto', 'cloudflare', 'cloudflare-quick'].includes(provider);
  const quick = allowed && (provider === 'cloudflare-quick' || (config.tunnelDomainMode || 'dynamic') === 'dynamic');
  const supported = quick && platform === 'win32';
  return { enabled: config.tunnelBackup?.enabled === true && supported, supported,
    requested: config.tunnelBackup?.enabled === true,
    code: provider === 'none' ? 'public-tunnels-disabled' : !quick ? 'quick-tunnels-required' :
      platform !== 'win32' ? 'dual-tunnel-platform-unsupported' : null };
}

function regularParents(file, io = fs) {
  let current = path.dirname(path.resolve(file));
  for (;;) {
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('tunnel-state-unavailable');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 &&
    UUID.test(value.instanceId || '') && Number.isSafeInteger(value.port) && value.port > 0 && value.port < 65536 &&
    value.slots && typeof value.slots === 'object' && !Array.isArray(value.slots) &&
    Object.keys(value.slots).every(role => ROLES.includes(role)) &&
    ROLES.every(role => {
      const slot = value.slots[role];
      return slot === undefined || slot && typeof slot === 'object' && !Array.isArray(slot) &&
        GENERATION.test(slot.generation || '') && PHASES.has(slot.phase) &&
        (slot.origin === null || slot.origin === undefined || quickOrigin(slot.origin) === slot.origin);
    });
}

function readTunnelState(logDir, io = fs) {
  const file = path.join(logDir, 'tunnels.json');
  let fd;
  try {
    regularParents(file, io);
    const before = io.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 131072)
      throw failure('tunnel-state-unavailable');
    fd = io.openSync(file, 'r');
    const held = io.fstatSync(fd);
    if (held.dev !== before.dev || held.ino !== before.ino) throw failure('tunnel-state-unavailable');
    const bytes = io.readFileSync(fd);
    const after = io.fstatSync(fd);
    if (after.size !== bytes.length || after.mtimeMs !== held.mtimeMs || bytes.length > 131072)
      throw failure('tunnel-state-unavailable');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!validState(value)) throw failure('tunnel-state-unavailable');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { invalid: true, code: 'tunnel-state-unavailable' };
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function writeTunnelState(logDir, value, io = fs) {
  if (!validState(value)) throw failure('tunnel-state-invalid');
  const file = path.join(logDir, 'tunnels.json');
  regularParents(file, io);
  try {
    const old = io.lstatSync(file);
    if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) throw failure('tunnel-state-unavailable');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(logDir, 'tunnels-' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(value)); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temporary); } catch (_) {}
  }
}

function publicTunnelState(state, { config = {}, now = Date.now(), platform = process.platform, instanceId, port, bootId } = {}) {
  const policy = backupPolicy(config, platform);
  const project = role => {
    const slot = state && !state.invalid && state.slots?.[role];
    const checked = Number(slot?.checkedAt);
    const fresh = Number.isFinite(checked) && checked > 0 && checked <= now && now - checked <= FRESHNESS_MS;
    const origin = quickOrigin(slot?.origin);
    const current = UUID.test(instanceId || '') && state?.instanceId === instanceId && Number.isSafeInteger(port) &&
      port > 0 && port < 65536 && slot?.targetPort === port && UUID.test(bootId || '') && slot?.verifiedBootId === bootId;
    const distinct = role !== 'backup' || !origin || origin !== quickOrigin(state?.slots?.primary?.origin);
    const slotEnabled = policy.enabled || role === 'primary' && policy.supported && !!state;
    const ready = slotEnabled && slot?.phase === 'ready' && slot?.reachable === true && fresh && current && distinct && !!origin;
    return {
      phase: !slotEnabled ? 'disabled' : state?.invalid || !distinct ? 'blocked' : slot?.phase === 'ready' && (!fresh || !current) ? 'unreachable' : slot?.phase || 'starting',
      generation: GENERATION.test(slot?.generation || '') ? slot.generation : null,
      origin: ready ? origin : null,
      url: ready ? origin + '/dsh-lite' : null,
      reachable: ready,
      checkedAt: Number.isFinite(checked) && checked > 0 ? checked : null,
      retryAt: Number.isFinite(slot?.retryAt) ? slot.retryAt : null
    };
  };
  const stateCode = ['tunnel-migration-unconfirmed', 'tunnel-discovery-unconfirmed'].includes(state?.code) ? state.code : null;
  return { enabled: policy.enabled, requested: policy.requested, supported: policy.supported, managed: !!state, code: policy.code || stateCode,
    primary: project('primary'), backup: project('backup') };
}

module.exports = { FRESHNESS_MS, ROLES, GENERATION, quickOrigin, backupPolicy, readTunnelState,
  writeTunnelState, publicTunnelState, validState };
