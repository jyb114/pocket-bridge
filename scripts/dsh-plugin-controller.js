'use strict';

// The plugin never loads a second DSH, forwards arbitrary URLs, or reads model
// credentials. Only this selected bridge installation can receive commands.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createManagedInstallation } = require('./dsh-plugin-installation.js');
const { resolveBridgeNode } = require('./dsh-plugin-node.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const portValid = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;
const failure = code => Object.assign(Error(code), { code });

function createBridgeController(options = {}, dependencies = {}) {
  const base = path.resolve(options.bridgeDirectory || path.join(__dirname, '..'));
  const hostPort = options.hostRuntime?.port;
  const requestImpl = dependencies.request || http.request;
  const spawnImpl = dependencies.spawn || spawn;
  const now = dependencies.now || Date.now;
  const managed = options.managed ? createManagedInstallation({ sourceDirectory: options.sourceDirectory, bridgeDirectory: base }) : null;
  let disposed = false, pending = null, generation = 0, actionPending = false, operation = { phase: 'idle' };
  const requests = new Set();
  const starts = new Set();

  function regular(relative, limit = 65536, missing = false) {
    const file = path.join(base, relative);
    if (path.relative(base, file).startsWith('..') || path.isAbsolute(path.relative(base, file))) throw failure('unsafe-installation');
    let at = file;
    while (at) {
      try { if (fs.lstatSync(at).isSymbolicLink()) throw failure('unsafe-installation'); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('unsafe-installation'); }
      at = path.dirname(at) === at ? '' : path.dirname(at);
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      // pnpm legitimately hard-links immutable package files into its store.
      // Mutable user state must have a single directory entry.
      if (!stat.isFile() || (relative === 'config.json' || relative.startsWith('logs/')) && stat.nlink !== 1 || stat.size > limit) throw failure('unsafe-installation');
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (after.size !== bytes.length || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || bytes.length > limit) throw failure('installation-changed');
      return bytes;
    } catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      throw error.code?.startsWith('unsafe-') || error.code === 'installation-changed' ? error : failure('installation-unavailable');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function json(relative, missing = false, limit = 65536) {
    const bytes = regular(relative, limit, missing);
    if (!bytes) return null;
    try { const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
    catch (_) { throw failure('installation-unavailable'); }
  }

  function installation() {
    if (disposed) throw failure('plugin-unloaded');
    if (!portValid(hostPort)) throw failure('dsh-web-host-unavailable');
    if (managed && !managed.hasInstallation()) {
      const source = managed.manifest();
      return { version: source.package.version, identity: null, config: {}, recorded: {}, needsInstallation: true };
    }
    const manifest = json('package.json');
    if (manifest.name !== 'pocket-bridge' || !/^1\.0\.0(?:-[a-z0-9.-]+)?$/i.test(manifest.version || '')) throw failure('not-pocket-bridge');
    regular('scripts/gateway-daemon.js', 1024 * 1024);
    regular('scripts/mobile-proxy.js', 2 * 1024 * 1024);
    const identity = json('logs/instance.json', true);
    if (identity && !UUID.test(identity.instanceId || '')) throw failure('installation-identity-unavailable');
    const config = json('config.json', true) || {};
    const recorded = json('logs/status.json', true, 512 * 1024) || {};
    return { version: manifest.version, identity: identity?.instanceId || null, config, recorded };
  }

  function request(port, pathname, body, timeout = 2000, limit = 32768) {
    if (disposed || !portValid(port) || !['/__health', '/__dsh/lite-status', '/__console/status', '/__console/action'].includes(pathname)) return Promise.reject(failure('plugin-unloaded'));
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let req, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); requests.delete(req);
        error ? reject(failure(error)) : resolve(value);
      };
      const timer = setTimeout(() => { finish('gateway-timeout'); req?.destroy(); }, timeout);
      try {
        req = requestImpl({ host: '127.0.0.1', port, path: pathname, method: bytes ? 'POST' : 'GET',
          headers: { Host: `127.0.0.1:${port}`, ...(bytes ? { Origin: `http://127.0.0.1:${port}`,
            'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > limit) { finish('gateway-response-too-large'); req.destroy(); }
            else chunks.push(chunk); });
          response.on('error', () => finish('gateway-unavailable'));
          response.on('aborted', () => finish('gateway-unavailable'));
          response.on('end', () => {
            if (settled) return;
            if (![200, 202].includes(response.statusCode)) return finish('gateway-rejected');
            try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); finish(null, value); }
            catch (_) { finish('gateway-invalid-response'); }
          });
        });
        requests.add(req);
        req.on('error', () => finish(disposed ? 'plugin-unloaded' : 'gateway-unavailable'));
        req.end(bytes || undefined);
      } catch (_) { finish('gateway-unavailable'); }
    });
  }

  function same(a, b) {
    return a?.service === 'pocket-bridge-gateway' && a?.instanceId === b?.instanceId && a?.bootId === b?.bootId && a?.pid === b?.pid && a?.port === b?.port && a?.dshPort === b?.dshPort;
  }
  async function locate(install) {
    if (!install.identity) return null;
    const preferred = [install.recorded.gateway?.port, install.config.gatewayPort].filter(portValid);
    const ports = [...new Set([...preferred, ...Array.from({ length: 20 }, (_, i) => 8080 + i)])];
    const probe = async port => {
      try {
        const value = await request(port, '/__health', undefined, 450, 16384);
        return value.service === 'pocket-bridge-gateway' && value.instanceId === install.identity && value.port === port &&
          UUID.test(value.bootId || '') && Number.isSafeInteger(value.pid) && value.pid > 0 && portValid(value.dshPort) ? value : null;
      } catch (_) { return null; }
    };
    // Try the installation's exact recorded port first. The small fallback scan
    // is concurrent and read-only; another installation UUID is never adopted.
    for (const port of [...new Set(preferred)]) { const result = await probe(port); if (result) return result; }
    const remaining = ports.filter(port => !preferred.includes(port));
    const results = await Promise.all(remaining.map(probe));
    const found = results.filter(Boolean);
    if (found.length > 1) throw failure('multiple-gateways');
    return found[0] || null;
  }

  function publicGateway(health) {
    return { port: health.port, bootId: health.bootId, instanceId: health.instanceId, pid: health.pid,
      consoleUrl: `http://127.0.0.1:${health.port}/console` };
  }
  function baseOrigin(raw) {
    try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null; return url; }
    catch (_) { return null; }
  }
  function transport(install) {
    const privateEntry = install.config.privateHttps?.enabled === true && baseOrigin(install.config.privateHttps.origin);
    const tunnel = install.config.tunnelProvider === 'none' || install.recorded.tunnel?.disabled === true ? null : baseOrigin(install.recorded.tunnel?.url);
    const candidate = privateEntry || tunnel;
    return { available: !!candidate, mode: privateEntry ? 'private-https' : tunnel ? 'tunnel' : null, host: candidate?.host || null };
  }
  async function inspect() {
    const install = installation();
    const health = await locate(install);
    if (disposed) throw failure('plugin-unloaded');
    if (health && health.dshPort === hostPort && (operation.phase === 'starting' ||
      operation.phase === 'failed' && ['node-unavailable', 'node-24-required'].includes(operation.code))) operation = { phase: 'idle' };
    if (operation.phase === 'stopping' && !health) operation = { phase: 'idle' };
    if (operation.phase !== 'idle' && operation.startedAt && now() - operation.startedAt > 150000) operation = { phase: 'failed', code: 'operation-unconfirmed' };
    return { install, health };
  }
  async function statusFresh() {
    try {
      let { install, health } = await inspect();
      if (!health) return { ok: true, state: 'stopped', version: install.version, connection: { available: false, encrypted: false }, operation: { ...operation } };
      const matched = health.dshPort === hostPort;
      let encrypted = false;
      try { encrypted = (await request(health.port, '/__dsh/lite-status')).encrypted === true; } catch (_) { /* No optimistic encryption claim. */ }
      const entry = transport(install);
      const tunnelDisabled = install.config.tunnelProvider === 'none' || install.recorded.tunnel?.disabled === true;
      return { ok: true, state: matched ? 'running' : 'unavailable', ...(matched ? {} : { code: 'dsh-target-mismatch' }),
        version: install.version, gateway: publicGateway(health), connection: { ...entry,
          available: matched && health.dshAlive === true && encrypted && entry.available &&
            (entry.mode === 'private-https' || install.recorded.tunnel?.reachable !== false), encrypted },
        runtime: { available: matched && health.dshAlive === true, port: health.dshPort, ...(options.hostRuntime.version ? { version: options.hostRuntime.version } : {}) },
        tunnel: { disabled: tunnelDisabled, running: tunnelDisabled ? null : install.recorded.tunnel?.running === true,
          reachable: !tunnelDisabled && typeof install.recorded.tunnel?.reachable === 'boolean' ? install.recorded.tunnel.reachable : null,
          checkedAt: typeof install.recorded.updatedAt === 'string' ? install.recorded.updatedAt : null }, operation: { ...operation } };
    } catch (error) {
      return { ok: false, state: 'unconfigured', code: error.code || 'installation-unavailable', connection: { available: false, encrypted: false }, operation: { ...operation } };
    }
  }
  function status() {
    if (pending) return pending;
    const epoch = generation;
    const result = statusFresh(); pending = result;
    result.finally(() => { if (generation === epoch && pending === result) pending = null; }).catch(() => {});
    return result;
  }
  async function connection() {
    try {
      const { install, health } = await inspect();
      if (!health) throw failure('gateway-stopped');
      if (health.dshPort !== hostPort) throw failure('dsh-target-mismatch');
      if (health.dshAlive !== true) throw failure('dsh-unavailable');
      const data = await request(health.port, '/__console/status', undefined, 10000, 512 * 1024);
      if (data.instanceId !== install.identity || data.gateway?.bootId !== health.bootId || data.gateway?.port !== health.port || data.gateway?.dshPort !== hostPort || data.entries?.encrypted !== true) throw failure('gateway-identity-changed');
      const privateBase = install.config.privateHttps?.enabled === true && baseOrigin(install.config.privateHttps.origin);
      if (!privateBase && (install.config.tunnelProvider === 'none' || data.tunnel?.disabled === true)) throw failure('secure-connection-unavailable');
      const raw = data.entries.wan || (privateBase && (data.entries.lanHttps?.[0] || data.entries.lan?.[0]));
      let entry; try { entry = new URL(raw); } catch (_) { throw failure('secure-connection-unavailable'); }
      if ((!privateBase && entry.protocol !== 'https:' || privateBase && !['http:', 'https:'].includes(entry.protocol)) || entry.username || entry.password || !/^\/k\/[A-Za-z0-9_-]{16,128}$/.test(entry.pathname) ||
          entry.search || !/^#k=[A-Za-z0-9_-]{16,128}$/.test(entry.hash)) throw failure('secure-connection-unavailable');
      if (privateBase) entry = new URL(entry.pathname + entry.hash, privateBase.origin);
      else {
        const tunnelBase = baseOrigin(data.tunnel?.url);
        if (!tunnelBase || entry.origin !== tunnelBase.origin || data.tunnel?.reachable === false) throw failure('secure-connection-unavailable');
      }
      entry.searchParams.set('target', 'lite');
      const fresh = await request(health.port, '/__health');
      const current = installation();
      if (!privateBase && current.config.tunnelProvider === 'none') throw failure('secure-connection-unavailable');
      if (current.identity !== install.identity || !same(fresh, health) || fresh.dshAlive !== true || disposed) throw failure('gateway-identity-changed');
      return { ok: true, url: entry.href, mode: privateBase ? 'private-https' : 'tunnel', gateway: publicGateway(health), expiresAt: new Date(now() + 120000).toISOString() };
    } catch (error) { return { ok: false, code: error.code || 'connection-unavailable' }; }
  }

  function saveTarget(install) {
    if (install.config.dshPort && Number(install.config.dshPort) !== hostPort) throw failure('dsh-target-mismatch');
    if (install.config.dshPort === hostPort) return;
    // Explicit start initializes only an unselected target. Preserve all other
    // configuration, including unknown/private values; never redirect a target.
    const original = regular('config.json', 65536, true);
    const temporary = path.join(base, `.plugin-config-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let fd;
    try {
      const merged = { ...install.config, dshPort: hostPort, dshMode: 'web' };
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(merged, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const current = regular('config.json', 65536, true);
      if (original ? !current?.equals(original) : current !== null) throw failure('configuration-changed');
      fs.renameSync(temporary, path.join(base, 'config.json'));
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (_) {} }
  }
  function resumeMarker() {
    const bytes = regular('logs/user-stopped.flag', 65536, true);
    if (bytes) fs.unlinkSync(path.join(base, 'logs/user-stopped.flag'));
    return bytes;
  }
  async function action(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['start', 'stop'].includes(body.action)) return { ok: false, code: 'invalid-action' };
    const allowed = body.action === 'start' ? ['action'] : ['action', 'expectedBootId', 'expectedInstanceId'];
    if (Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key))) return { ok: false, code: 'invalid-action' };
    if (actionPending || operation.phase === 'starting' || operation.phase === 'stopping') return { ok: false, code: 'operation-pending' };
    actionPending = true;
    operation = { phase: body.action === 'start' ? 'starting' : 'stopping', startedAt: now() }; generation++; pending = null;
    let restoredMarker = null;
    try {
      let { install, health } = await inspect();
      if (body.action === 'start') {
        if (health) {
          if (health.dshPort !== hostPort) throw failure('dsh-target-mismatch');
          operation = { phase: 'idle' }; return { ok: true, phase: 'running', message: 'The selected bridge is already running.' };
        }
        if (fs.existsSync(path.join(base, 'logs/daemon-operation.lock'))) throw failure('operation-pending');
        const node = dependencies.nodeExecutable || await (dependencies.resolveBridgeNode || resolveBridgeNode)({ bridgeDirectory: base });
        if (disposed) throw failure('plugin-unloaded');
        if (managed) { managed.ensure(); install = installation(); }
        saveTarget(install); restoredMarker = resumeMarker();
        const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())));
        childEnvironment.DSH_GW_TARGET_PORT = String(hostPort);
        const child = spawnImpl(node, [path.join(base, 'scripts/gateway-daemon.js')], { cwd: base, stdio: 'ignore', windowsHide: true, env: childEnvironment });
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = error => {
            if (settled) return; settled = true; clearTimeout(timer); starts.delete(cancel);
            child.removeListener('spawn', onSpawn); child.removeListener('error', onError);
            // Keep a rejection handler for a late OS spawn failure. A timeout
            // cannot authorize a kill or imply that no process was created.
            child.on('error', () => {});
            error ? reject(failure(error)) : resolve();
          };
          const onSpawn = () => finish(disposed ? 'plugin-unloaded' : null);
          const onError = () => finish('start-unavailable');
          const cancel = () => finish('plugin-unloaded');
          const timer = setTimeout(() => finish('start-unconfirmed'), dependencies.startTimeoutMs || 10000);
          starts.add(cancel); child.once('spawn', onSpawn); child.once('error', onError);
          if (disposed) cancel();
        });
        restoredMarker = null;
        child.once('exit', code => { if (!disposed && code !== 0 && operation.phase === 'starting') operation = { phase: 'failed', code: 'start-unconfirmed' }; });
        child.unref();
        return { ok: true, phase: 'starting', message: 'Starting the bridge. Connection status will confirm when it is ready.' };
      }
      if (!UUID.test(body.expectedBootId || '') || !UUID.test(body.expectedInstanceId || '')) throw failure('invalid-action');
      if (!health || body.expectedBootId !== health.bootId || body.expectedInstanceId !== install.identity) throw failure('gateway-identity-changed');
      if (health.dshPort !== hostPort) throw failure('dsh-target-mismatch');
      const accepted = await request(health.port, '/__console/action', { action: 'stop-gateway', expectedBootId: health.bootId, expectedInstanceId: install.identity }, 10000);
      if (accepted.ok !== true || accepted.shutdownScheduled !== true || accepted.bootId !== health.bootId || accepted.instanceId !== install.identity || accepted.pid !== health.pid) throw failure('stop-unconfirmed');
      return { ok: true, phase: 'stopping', message: 'Pausing phone connections. DSH and its tasks keep running.' };
    } catch (error) {
      if (restoredMarker) { try { fs.writeFileSync(path.join(base, 'logs/user-stopped.flag'), restoredMarker, { flag: 'wx', mode: 0o600 }); } catch (_) {} }
      operation = { phase: 'failed', code: error.code || 'action-unavailable' };
      return { ok: false, code: operation.code };
    } finally { actionPending = false; generation++; pending = null; }
  }
  async function diagnostics() {
    const value = await statusFresh();
    // Read-only diagnostics never spawn a runtime probe or prepare an installation.
    // An operation error is historical evidence, not a fresh dependency check.
    const nodeError = value.operation?.phase === 'failed' && ['node-unavailable', 'node-24-required'].includes(value.operation.code) ? value.operation.code : null;
    const checks = [
      { id: 'node', label: 'Node.js 24+ startup runtime', state: nodeError ? 'fail' : 'unknown', detail: nodeError === 'node-24-required' ? 'The last start attempt found only an older Node.js runtime. Install Node.js 24 or newer, restart DSH, then retry Start bridge.' : nodeError ? 'The last start attempt could not find a usable genuine Node.js 24+ runtime. Install Node.js 24 or newer, restart DSH, then retry Start bridge.' : 'Not probed by read-only diagnostics. Start bridge checks for a usable genuine Node.js 24+ runtime; DSH’s embedded runtime alone does not confirm it.' },
      { id: 'installation', label: 'Selected bridge installation', state: value.version ? 'pass' : 'fail', detail: value.version ? `Pocket Bridge ${value.version}` : 'Choose a complete Pocket Bridge installation in this plugin configuration.' },
      { id: 'gateway', label: 'Bridge listener', state: value.state === 'running' ? 'pass' : 'fail', detail: value.state === 'running' ? 'The selected installation and current gateway identity match.' : value.code === 'dsh-target-mismatch' ? 'This bridge targets a different DSH instance. Select the matching installation or adjust its desktop controls.' : 'Start the bridge or open its desktop controls.' },
      { id: 'dsh', label: 'This DSH runtime', state: value.runtime?.available ? 'pass' : 'fail', detail: value.runtime?.available ? 'The bridge targets this running DSH host.' : 'The current DSH listener has not been confirmed by the bridge.' },
      { id: 'encryption', label: 'Phone content encryption', state: value.connection?.encrypted ? 'pass' : 'unknown', detail: value.connection?.encrypted ? 'The gateway reports an encryption key. Only a phone round trip verifies delivery.' : 'Encryption readiness has not been confirmed. No plaintext connection will be offered.' },
      { id: 'entrance', label: 'Secure phone entrance', state: value.connection?.available ? 'pass' : 'fail', detail: value.connection?.available ? 'A secure entrance is configured. Open it on a phone to verify connectivity.' : 'A complete HTTPS connection is not ready; use the desktop controls to configure it.' },
      { id: 'tunnel', label: 'Public entrance reachability', state: value.connection?.mode === 'private-https' ? 'unknown' : value.tunnel?.reachable === true ? 'pass' : value.tunnel?.reachable === false ? 'fail' : 'unknown', detail: value.tunnel?.disabled ? 'Public tunnel startup and probing are disabled. Existing tunnel processes have not been checked or stopped by this setting; verify and stop any existing tunnel separately before relying on local-only operation.' : value.connection?.mode === 'private-https' ? 'Private HTTPS does not require cloudflared or a public tunnel. Test the private address on your phone.' : value.tunnel?.reachable === true ? 'The last gateway probe succeeded; it does not prove current phone connectivity.' : value.tunnel?.reachable === false ? 'The last gateway probe failed. Keep the address and retry before requesting a replacement.' : 'Public internet tunnels require cloudflared, which is not bundled in the plugin package. Read-only diagnostics do not probe its executable. No current public reachability result is available.' }
    ];
    return { ok: true, checks, checkedAt: new Date(now()).toISOString(), ...(value.version ? { version: value.version } : {}) };
  }
  function dispose() { disposed = true; generation++; pending = null; operation = { phase: 'closed' }; for (const cancel of starts) cancel(); starts.clear(); for (const req of requests) req.destroy(); requests.clear(); }
  return { status, connection, diagnostics, action, dispose };
}
module.exports = { createBridgeController };
