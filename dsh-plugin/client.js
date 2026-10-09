/* Pocket Bridge's DSH settings panel. MIT; no external assets or dependencies.
 * React is provided by DSH's own module loader, not bundled by this plugin.
 * Pairing links live only in this mounted panel's memory. */
window.__ModuleLoader__.load({
  id: 'pocket-bridge',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.pb-plugin{--pb-accent:#3269e8;--pb-border:color-mix(in srgb,currentColor 16%,transparent);--pb-muted:color-mix(in srgb,currentColor 64%,transparent);max-width:840px;margin:0 auto;padding:24px;line-height:1.5;color:inherit;font-family:inherit;box-sizing:border-box}
.pb-plugin *{box-sizing:border-box}.pb-plugin h2,.pb-plugin h3,.pb-plugin p{margin:0}.pb-plugin h2{font-size:25px;letter-spacing:-.6px;font-weight:650}.pb-plugin h3{font-size:16px;font-weight:620}.pb-plugin button,.pb-plugin input{font:inherit}.pb-plugin button{min-height:42px;border:1px solid var(--pb-border);border-radius:9px;padding:9px 14px;background:transparent;color:inherit;cursor:pointer;line-height:1.3}.pb-plugin button:hover:not(:disabled){background:color-mix(in srgb,currentColor 6%,transparent)}.pb-plugin button:focus-visible,.pb-plugin input:focus-visible{outline:3px solid var(--pb-accent);outline-offset:3px}.pb-plugin button:disabled{opacity:.45;cursor:not-allowed}.pb-plugin .pb-primary{background:var(--pb-accent);color:#fff;border-color:var(--pb-accent)}.pb-plugin .pb-primary:hover:not(:disabled){background:#2458cf}.pb-plugin .pb-danger{color:#bc3636;border-color:color-mix(in srgb,#bc3636 40%,transparent)}.pb-plugin .pb-header{display:flex;align-items:center;gap:13px;margin-bottom:24px}.pb-plugin .pb-logo{width:44px;height:44px;flex:none}.pb-plugin .pb-muted{color:var(--pb-muted);font-size:13px}.pb-plugin .pb-card{border:1px solid var(--pb-border);border-radius:14px;padding:20px;margin-bottom:16px}.pb-plugin .pb-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.pb-plugin .pb-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.pb-plugin .pb-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--pb-border);border-radius:20px;padding:4px 10px;font-size:12px;white-space:nowrap}.pb-plugin .pb-dot{width:7px;height:7px;border-radius:50%;background:#999}.pb-plugin .pb-dot.running{background:#20976a}.pb-plugin .pb-dot.unavailable{background:#be7322}.pb-plugin .pb-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}.pb-plugin .pb-value{font-size:14px;margin-top:3px;overflow-wrap:anywhere}.pb-plugin .pb-hint{margin-top:12px;color:var(--pb-muted);font-size:13px}.pb-plugin .pb-notice{border-radius:10px;background:color-mix(in srgb,var(--pb-accent) 8%,transparent);padding:12px 14px;margin-bottom:16px;font-size:13px;overflow-wrap:anywhere}.pb-plugin .pb-notice.error{background:color-mix(in srgb,#c53838 8%,transparent)}.pb-plugin .pb-notice button{margin:8px 8px 0 0;min-height:34px;padding:6px 10px}.pb-plugin .pb-pairing{display:grid;grid-template-columns:210px minmax(0,1fr);gap:20px;margin-top:20px;padding-top:20px;border-top:1px solid var(--pb-border);align-items:center}.pb-plugin .pb-qr{display:block;width:210px;height:210px;background:#fff;border-radius:8px;padding:8px;image-rendering:pixelated}.pb-plugin .pb-private-link{width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:inherit;background:transparent;border:1px solid var(--pb-border);border-radius:8px;padding:10px;margin-top:12px;min-height:42px}.pb-plugin .pb-checks{list-style:none;margin:16px 0 0;padding:0}.pb-plugin .pb-check{display:grid;grid-template-columns:24px 1fr;gap:8px;padding:12px 0;border-top:1px solid var(--pb-border)}.pb-plugin .pb-check-mark{font-size:16px}.pb-plugin .pb-check.pass .pb-check-mark{color:#20976a}.pb-plugin .pb-check.fail .pb-check-mark{color:#bc3636}.pb-plugin .pb-check-title{font-size:14px;font-weight:550}.pb-plugin .pb-confirm{border:1px solid color-mix(in srgb,#bc3636 40%,transparent);border-radius:10px;padding:16px;margin-top:16px}.pb-plugin .pb-footer{font-size:12px;color:var(--pb-muted);margin-top:22px}.pb-plugin .pb-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--pb-border);border-top-color:var(--pb-accent);border-radius:50%;animation:pb-spin .8s linear infinite;margin-right:7px;vertical-align:-1px}@keyframes pb-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.pb-plugin .pb-spinner{animation:none}}@media(max-width:560px){.pb-plugin{padding:18px 14px}.pb-plugin h2{font-size:22px}.pb-plugin .pb-card{padding:16px}.pb-plugin .pb-fields{grid-template-columns:1fr}.pb-plugin .pb-pairing{grid-template-columns:1fr}.pb-plugin .pb-qr{margin:auto}.pb-plugin .pb-row{align-items:flex-start;gap:10px}.pb-plugin .pb-actions button{flex:1 1 auto}.pb-plugin .pb-badge{font-size:11px;padding:4px 8px}}
`;

    function localHttpOrigin(location) {
      return !!location && /^(http:|https:)$/.test(location.protocol) &&
        ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
    }
    function localOrigin(location) {
      if (localHttpOrigin(location)) return true;
      if (!location || location.protocol !== 'dsh-app:' || location.hostname !== 'app' || location.port || location.username || location.password) return false;
      try {
        const native = new URL(location.href || 'dsh-app://app/');
        return native.protocol === 'dsh-app:' && native.hostname === 'app' && !native.port && !native.username && !native.password;
      } catch (_) { return false; }
    }
    function text(value, limit = 220) {
      return typeof value === 'string' ? value.replace(/(?:https?:\/\/[^\s]*?(?:\/k\/|#k=)[^\s]*|\b(?:sk-|Bearer\s+)[A-Za-z0-9_-]+|[?&#](?:key|token|k)=[^\s&#]+)/gi, '[private value omitted]').slice(0, limit) : '';
    }
    function consoleUrl(value) {
      try {
        if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\//i.test(value)) return null;
        const parsed = new URL(value);
        if (!localHttpOrigin(parsed) || parsed.username || parsed.password || parsed.hash ||
            !/^\/console(?:\/)?$/.test(parsed.pathname) || parsed.search) return null;
        return parsed.href;
      } catch (_) { return null; }
    }
    function pairingUrl(value) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 4096 ||
            !/^#k=[A-Za-z0-9_-]{16,256}$/.test(parsed.hash)) return null;
        return parsed.href;
      } catch (_) { return null; }
    }
    function identity(gateway) {
      if (!gateway || typeof gateway.bootId !== 'string' || typeof gateway.instanceId !== 'string') return '';
      return gateway.bootId + ':' + gateway.instanceId;
    }
    function encryptionLabel(status) {
      return status && status.connection && status.connection.encrypted === true ? 'Key ready; phone delivery not tested' : 'Encryption key not confirmed';
    }
    function transportChanged(connection, transport) {
      if (!connection || !transport) return false;
      return (typeof transport.mode === 'string' && transport.mode !== connection.mode) ||
        (typeof transport.host === 'string' && transport.host !== connection.host);
    }
    function diagnosticContext(status) {
      if (!status) return '';
      const gateway = status.gateway || {}, runtime = status.runtime || {}, connection = status.connection || {}, tunnel = status.tunnel || {};
      // Time-of-poll fields are deliberately excluded. These are the identities
      // and readiness signals that the diagnostic checklist actually describes.
      return JSON.stringify([status.state, status.version || '', status.code || '', gateway.bootId || '', gateway.instanceId || '', gateway.port || 0, gateway.pid || 0,
        runtime.port || 0, runtime.kind || '', runtime.version || '', runtime.available === true,
        connection.mode || '', connection.host || '', connection.available === true, connection.encrypted === true,
        tunnel.running === true, typeof tunnel.reachable === 'boolean' ? tunnel.reachable : null,
        status.operation && status.operation.phase || '', status.operation && status.operation.code || '']);
    }
    const RECOVERY = {
      'dsh-target-mismatch': 'This bridge is connected to a different DSH runtime. Open desktop controls and select this DSH instance, then refresh.',
      'unconfigured': 'Open desktop controls to finish the bridge setup, then refresh.',
      'not-configured': 'Open desktop controls to finish the bridge setup, then refresh.',
      'gateway-unavailable': 'Use Start bridge below. If startup fails, check the prerequisites and run diagnostics.',
      'gateway-not-running': 'Start the bridge, then try again.',
      'not-running': 'Start the bridge, then try again.',
      'tunnel-unavailable': 'The internet tunnel is not ready. Wait a moment, then refresh. Desktop controls show tunnel errors.',
      'connection-unavailable': 'The secure connection is not ready. Refresh the status or open desktop controls.',
      'stale-instance': 'The bridge restarted. Refresh before trying again.',
      'identity-mismatch': 'The bridge changed while this request was running. Refresh before trying again.',
      'forbidden': 'Open this panel in DSH on this computer using a localhost address.',
      'origin-forbidden': 'Open this panel in DSH on this computer using a localhost address.',
      'timeout': 'The bridge did not respond in time. Refresh to check what actually happened before trying again.',
      'network': 'The local connection was interrupted. Check that DSH and Pocket Bridge are running, then refresh.'
    };
    Object.assign(RECOVERY, {
      'installation-unavailable': 'Select a complete Pocket Bridge installation in this plugin’s configuration, then refresh.',
      'installation-not-configured': 'Select your Pocket Bridge installation in this plugin’s configuration, then refresh.',
      'node-24-required': 'The last start attempt found only an older Node.js runtime. Install genuine Node.js 24 or newer, restart DSH, then try Start bridge again.',
      'node-unavailable': 'The last start attempt could not find a usable genuine Node.js 24+ runtime. Install Node.js 24 or newer, restart DSH, then try Start bridge again. The DSH desktop app’s embedded runtime may not be usable.',
      'operation-pending': 'The bridge is already starting or stopping. Refresh to check its progress; do not repeat the request.',
      'operation-unconfirmed': 'The last operation was not confirmed. Refresh to check its state before retrying Start bridge; open desktop controls if available.',
      'start-unconfirmed': 'The bridge did not finish starting. Refresh before retrying Start bridge; open desktop controls if available.',
      'gateway-stopped': 'Start the bridge, then show the phone connection again.',
      'dsh-unavailable': 'This DSH runtime is not responding. Keep DSH open, then refresh the bridge status.',
      'gateway-identity-changed': 'The bridge restarted or its installation changed. Refresh before trying again.',
      'secure-connection-unavailable': 'A secure phone connection is not ready. Open desktop controls and check encryption and the tunnel.',
      'local-authenticated-request-required': 'Local authorization was rejected. Refresh this panel’s status, then retry. If it continues, reopen the authenticated DSH interface on this computer.',
      'control-token-unavailable': 'Local authorization is not ready. Refresh this panel’s status, then retry your action. No write request was sent.',
      'request-timeout': 'The local service did not respond in time. Refresh to check what actually happened before trying again.',
      'bridge-unavailable': 'The bridge service is unavailable. Refresh its status, then use Start bridge if it is stopped.',
      'plugin-unloaded': 'This plugin was reloaded or removed. Reload the DSH page before trying again.'
    });
    function recovery(code) { return RECOVERY[code] || 'Refresh the status. If the problem continues, run diagnostics or open desktop controls.'; }

    /* A small, original byte-mode QR encoder (ISO/IEC 18004 model 2, level L,
     * versions 1–10). No network request ever receives the pairing secret.
     * Longer links keep the Copy link option rather than truncating a QR. */
    function qrMatrix(value) {
      const bytes = new TextEncoder().encode(value);
      const specs = [null, [19, 7, [19]], [34, 10, [34]], [55, 15, [55]], [80, 20, [80]],
        [108, 26, [108]], [136, 18, [68, 68]], [156, 20, [78, 78]], [194, 24, [97, 97]],
        [232, 30, [116, 116]], [274, 18, [68, 68, 69, 69]]];
      let version = 1;
      while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > specs[version][0] * 8) version++;
      if (version > 10) throw new Error('qr-too-long');
      const [capacity, ecc, sizes] = specs[version], bits = [];
      function append(n, width) { for (let i = width - 1; i >= 0; i--) bits.push((n >>> i) & 1); }
      append(4, 4); append(bytes.length, version < 10 ? 8 : 16);
      for (const byte of bytes) append(byte, 8);
      append(0, Math.min(4, capacity * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => n * 2 + bit, 0));
      while (data.length < capacity) data.push((data.length - Math.ceil(bits.length / 8)) % 2 ? 0x11 : 0xec);
      function multiply(a, b) {
        let result = 0;
        for (let i = 7; i >= 0; i--) { result = (result << 1) ^ ((result >>> 7) * 0x11d); result ^= ((b >>> i) & 1) * a; }
        return result;
      }
      let generator = [1], power = 1;
      for (let i = 0; i < ecc; i++) {
        const next = new Array(generator.length + 1).fill(0);
        for (let j = 0; j < generator.length; j++) { next[j] ^= generator[j]; next[j + 1] ^= multiply(generator[j], power); }
        generator = next; power = multiply(power, 2);
      }
      const blocks = [], parity = []; let offset = 0;
      for (const count of sizes) {
        const block = data.slice(offset, offset + count), rem = new Array(ecc).fill(0); offset += count;
        for (const byte of block) { const factor = byte ^ rem.shift(); rem.push(0); for (let i = 0; i < ecc; i++) rem[i] ^= multiply(generator[i + 1], factor); }
        blocks.push(block); parity.push(rem);
      }
      const words = [];
      for (let i = 0; i < Math.max(...sizes); i++) for (const block of blocks) if (i < block.length) words.push(block[i]);
      for (let i = 0; i < ecc; i++) for (const block of parity) words.push(block[i]);
      const size = version * 4 + 17;
      const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
      const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
      function put(x, y, dark) { if (x >= 0 && y >= 0 && x < size && y < size) { matrix[y][x] = !!dark; reserved[y][x] = true; } }
      for (let i = 0; i < size; i++) { put(6, i, i % 2 === 0); put(i, 6, i % 2 === 0); }
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const distance = Math.max(Math.abs(dx), Math.abs(dy)); put(cx + dx, cy + dy, distance !== 2 && distance !== 4); }
      const centers = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version];
      for (let i = 0; i < centers.length; i++) for (let j = 0; j < centers.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(centers[i] + dx, centers[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
      let format = 8;
      for (let i = 0; i < 10; i++) format = (format << 1) ^ ((format >>> 9) * 0x537);
      format = ((8 << 10) | format) ^ 0x5412;
      const fbit = (i) => (format >>> i) & 1;
      for (let i = 0; i <= 5; i++) put(8, i, fbit(i));
      put(8, 7, fbit(6)); put(8, 8, fbit(7)); put(7, 8, fbit(8));
      for (let i = 9; i < 15; i++) put(14 - i, 8, fbit(i));
      for (let i = 0; i < 8; i++) put(size - 1 - i, 8, fbit(i));
      for (let i = 8; i < 15; i++) put(8, size - 15 + i, fbit(i));
      put(8, size - 8, true);
      if (version >= 7) {
        let remainder = version;
        for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
        const versionBits = (version << 12) | remainder;
        for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3), bit = (versionBits >>> i) & 1; put(a, b, bit); put(b, a, bit); }
      }
      let index = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          for (let j = 0; j < 2; j++) { const x = right - j; if (!reserved[y][x]) { const bit = index < words.length * 8 ? (words[index >>> 3] >>> (7 - (index & 7))) & 1 : 0; matrix[y][x] = !!(bit ^ ((x + y) % 2 === 0)); index++; } }
        }
      }
      return matrix;
    }

    function createController(env) {
      let disposed = false, generation = 0, diagnosticsEpoch = 0, timer = null, expiryTimer = null, statusPending = false, expectedAction = '', controlToken = '';
      const controllers = new Set(), subscribers = new Set();
      const now = () => typeof env.now === 'function' ? env.now() : Date.now();
      let state = { local: localOrigin(env.location), controlsReady: false, status: null, busy: '', error: '', code: '', note: '', connection: null, diagnostics: null, diagnosticsStale: false, confirmStop: false, loading: false };
      const emit = (patch) => { if (disposed) return; state = { ...state, ...patch }; for (const fn of subscribers) fn(state); };
      function clearConnection() { if (expiryTimer !== null) env.clearTimeout(expiryTimer); expiryTimer = null; if (state.connection) emit({ connection: null }); }
      function invalidate() { generation++; clearConnection(); }
      function clearAuthorization() { controlToken = ''; emit({ controlsReady: false }); }
      function clearDiagnostics() {
        diagnosticsEpoch++;
        if (state.diagnostics || state.busy === 'diagnostics') emit({ diagnostics: null, diagnosticsStale: true });
      }
      function expireIfNeeded() {
        if (!state.connection || Date.parse(state.connection.expiresAt) > now()) return;
        invalidate(); emit({ note: 'The private connection has been hidden automatically. Show it again when needed.' });
      }
      function armExpiry(expiresAt) {
        if (expiryTimer !== null) env.clearTimeout(expiryTimer);
        const token = generation;
        expiryTimer = env.setTimeout(() => {
          if (disposed || token !== generation) return;
          expiryTimer = null;
          // The elapsed timer also covers a clock moved backward after reveal.
          invalidate(); emit({ note: 'The private connection has been hidden automatically. Show it again when needed.' });
        }, Math.max(0, Date.parse(expiresAt) - now()));
      }
      async function request(route, body, timeout = 8000) {
        if (body !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(controlToken)) throw Object.assign(new Error('authorization'), { code: 'control-token-unavailable' });
        const abort = new env.AbortController(); controllers.add(abort);
        let timedOut = false;
        const deadline = env.setTimeout(() => { timedOut = true; abort.abort(); }, timeout);
        try {
          const response = await env.fetch('/pocket-bridge/' + route, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Pocket-Bridge-Control-Token': controlToken },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal
          });
          let result = await response.json();
          if (!response.ok || !result || (result.ok !== true && !(route === 'status' && ['unconfigured', 'unavailable'].includes(result.state)))) {
            const error = new Error('request'); error.code = text(result && result.code, 60) || (response.status === 403 ? 'forbidden' : 'request-failed'); throw error;
          }
          return result;
        } catch (error) {
          if (abort.signal.aborted && !timedOut) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          if (!error.code) error.code = timedOut ? 'timeout' : 'network';
          throw error;
        } finally { env.clearTimeout(deadline); controllers.delete(abort); }
      }
      function failed(error) {
        if (error.code === 'cancelled' || disposed) return;
        invalidate(); clearAuthorization(); clearDiagnostics(); emit({ error: recovery(error.code), code: error.code, note: '' });
      }
      async function refresh(options = {}) {
        if (!state.local || disposed || statusPending || env.document.hidden) return;
        statusPending = true; const token = generation;
        if (!options.quiet) emit({ loading: true });
        try {
          const packet = await request('status');
          if (disposed || token !== generation || env.document.hidden) return;
          if (!['running', 'stopped', 'unconfigured', 'unavailable'].includes(packet.state)) throw Object.assign(new Error('status'), { code: 'invalid-status' });
          // Only a current, authenticated status response can refresh the local
          // carrier capability. Strip it before anything enters React state.
          const { controlToken: supplied, ...result } = packet;
          const nextControlToken = typeof supplied === 'string' && /^[A-Za-z0-9_-]{43}$/.test(supplied) ? supplied : '';
          if (controlToken && controlToken !== nextControlToken) { invalidate(); clearDiagnostics(); }
          controlToken = nextControlToken; emit({ controlsReady: !!controlToken });
          if (diagnosticContext(state.status) !== diagnosticContext(result)) clearDiagnostics();
          if (identity(state.status && state.status.gateway) !== identity(result.gateway) || result.state !== 'running' || !result.connection || result.connection.available !== true || transportChanged(state.connection, result.connection) || (result.runtime && !result.runtime.available)) invalidate();
          expireIfNeeded();
          emit({ status: result, ...(!controlToken ? { error: recovery('control-token-unavailable'), code: 'control-token-unavailable' } : options.preserveError ? {} : { error: '', code: '' }) });
          if (expectedAction && result.state === (expectedAction === 'start' ? 'running' : 'stopped')) {
            emit({ note: expectedAction === 'start' ? 'The bridge is running. DSH stays open.' : 'The bridge is stopped. DSH stays open; phone connections are paused.' });
            expectedAction = '';
          } else if (expectedAction && result.operation && result.operation.phase === 'failed') {
            const code = result.operation.code || 'operation-unconfirmed';
            emit({ error: recovery(code), code, note: '' }); expectedAction = '';
          }
        } catch (error) { failed(error); emit({ status: null }); }
        finally { statusPending = false; emit({ loading: false }); }
      }
      function schedule() {
        if (timer) env.clearTimeout(timer);
        timer = null;
        if (disposed || !state.local || env.document.hidden) return;
        timer = env.setTimeout(async () => { await refresh({ quiet: true }); schedule(); }, 5000);
      }
      const visibility = () => {
        invalidate(); clearAuthorization(); diagnosticsEpoch++;
        if (env.document.hidden) { if (timer) env.clearTimeout(timer); timer = null; for (const abort of controllers) abort.abort(); }
        else { refresh(); schedule(); }
      };
      const leave = () => { invalidate(); clearAuthorization(); diagnosticsEpoch++; for (const abort of controllers) abort.abort(); };
      async function reveal() {
        expireIfNeeded();
        if (!state.local || state.busy || !state.status || ['starting', 'stopping'].includes(state.status.operation && state.status.operation.phase) || state.status.state !== 'running' || !state.status.connection || state.status.connection.available !== true || state.status.connection.encrypted !== true) return;
        invalidate(); const token = generation, expected = identity(state.status.gateway);
        emit({ busy: 'connection', error: '', note: '' });
        try {
          const result = await request('connection', {});
          if (disposed || token !== generation || env.document.hidden) return;
          const url = pairingUrl(result.url);
          if (!url || !expected || identity(result.gateway) !== expected || !['tunnel', 'private-https'].includes(result.mode)) throw Object.assign(new Error('connection'), { code: 'identity-mismatch' });
          const host = new URL(url).host;
          if (transportChanged({ host, mode: result.mode }, state.status.connection)) throw Object.assign(new Error('transport'), { code: 'connection-unavailable' });
          if (result.expiresAt && (!Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now())) throw Object.assign(new Error('expired'), { code: 'connection-unavailable' });
          const expiresAt = new Date(Math.min(result.expiresAt ? Date.parse(result.expiresAt) : now() + 120000, now() + 120000)).toISOString();
          let matrix = null; try { matrix = qrMatrix(url); } catch (_) { /* Copy remains available for unusually long links. */ }
          if (Date.parse(expiresAt) <= now()) throw Object.assign(new Error('expired'), { code: 'connection-unavailable' });
          emit({ connection: { url, matrix, expiresAt, host, mode: result.mode }, note: '' }); armExpiry(expiresAt);
        } catch (error) { failed(error); }
        finally { emit({ busy: '' }); }
      }
      async function diagnostics() {
        if (state.busy || !state.local) return;
        const epoch = diagnosticsEpoch, context = diagnosticContext(state.status);
        emit({ busy: 'diagnostics', error: '', note: '' });
        try {
          const result = await request('diagnostics', {}, 12000);
          if (disposed || env.document.hidden || epoch !== diagnosticsEpoch || context !== diagnosticContext(state.status)) { emit({ diagnosticsStale: true }); return; }
          if (!Array.isArray(result.checks)) throw Object.assign(new Error('diagnostics'), { code: 'invalid-response' });
          const checkedAt = typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt)) ? new Date(Date.parse(result.checkedAt)).toISOString() : new Date(now()).toISOString();
          emit({ diagnosticsStale: false, diagnostics: { checkedAt, checks: result.checks.slice(0, 30).map((check) => ({ id: text(check.id, 80), label: text(check.label, 100), state: ['pass', 'fail', 'unknown'].includes(check.state) ? check.state : 'unknown', detail: text(check.detail, 500) })) } });
        } catch (error) {
          if (disposed || env.document.hidden || epoch !== diagnosticsEpoch || context !== diagnosticContext(state.status)) { emit({ diagnosticsStale: true }); return; }
          failed(error);
        }
        finally { emit({ busy: '' }); }
      }
      async function action(action) {
        if (state.busy || !state.local || ['starting', 'stopping'].includes(state.status && state.status.operation && state.status.operation.phase) || !['start', 'stop'].includes(action)) return;
        if (action === 'stop' && !state.confirmStop) { emit({ confirmStop: true }); return; }
        expectedAction = action; invalidate(); clearDiagnostics(); emit({ busy: action, confirmStop: false, error: '', note: action === 'start' ? 'Starting the bridge…' : 'Stopping the bridge…' });
        const gateway = state.status && state.status.gateway;
        try {
          const result = await request('action', { action, ...(action === 'stop' && gateway && gateway.bootId ? { expectedBootId: gateway.bootId } : {}), ...(action === 'stop' && gateway && gateway.instanceId ? { expectedInstanceId: gateway.instanceId } : {}) }, 16000);
          emit({ note: text(result.message, 180) || (action === 'start' ? 'Start requested. Checking the bridge status…' : 'Stop requested. Checking the bridge status…') });
          // HTTP success is only acknowledgement; the fresh status is the source of truth.
          await refresh();
          const expected = action === 'start' ? 'running' : 'stopped';
          // Fresh failure/connection errors already carry recovery guidance.
          // Never replace them with an acknowledgement that sounds successful.
          if (!state.error) emit({ note: state.status && state.status.state === expected ? (action === 'start' ? 'The bridge is running. DSH stays open.' : 'The bridge is stopped. DSH stays open; phone connections are paused.') : 'The request was accepted. The bridge has not confirmed its new state yet; refresh to check.' });
        } catch (error) { expectedAction = ''; failed(error); await refresh({ quiet: true, preserveError: true }); }
        finally { emit({ busy: '' }); schedule(); }
      }
      return {
        getState() { expireIfNeeded(); return state; },
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
        start() { disposed = false; env.document.addEventListener('visibilitychange', visibility); env.window.addEventListener('pagehide', leave); refresh(); schedule(); },
        dispose() { if (disposed) return; invalidate(); clearAuthorization(); clearDiagnostics(); disposed = true; if (timer) env.clearTimeout(timer); for (const abort of controllers) abort.abort(); env.document.removeEventListener('visibilitychange', visibility); env.window.removeEventListener('pagehide', leave); subscribers.clear(); state = { ...state, connection: null, controlsReady: false, diagnostics: null }; },
        refresh, reveal, diagnostics, action,
        hide() { invalidate(); }, cancelStop() { emit({ confirmStop: false }); },
        setNote(note) { emit({ note: text(note) }); }
      };
    }

    function Logo() {
      return h('svg', { className: 'pb-logo', viewBox: '0 0 44 44', 'aria-hidden': true },
        h('rect', { x: 1, y: 1, width: 42, height: 42, rx: 13, fill: '#3269e8' }),
        h('path', { d: 'M12 31V22a10 10 0 0 1 20 0v9M8 27h28M17 27v7M27 27v7', fill: 'none', stroke: '#fff', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    function Qr({ matrix }) {
      const size = matrix.length, path = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) path.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      return h('svg', { className: 'pb-qr', viewBox: `0 0 ${size + 8} ${size + 8}`, role: 'img', 'aria-label': 'Private phone connection QR code', shapeRendering: 'crispEdges' },
        h('rect', { width: size + 8, height: size + 8, fill: '#fff' }), h('path', { d: path.join(''), fill: '#000' }));
    }
    function Panel() {
      const controllerRef = React.useRef(null), linkRef = React.useRef(null);
      if (!controllerRef.current) controllerRef.current = createController({ location: window.location, window, document, fetch: window.fetch.bind(window), AbortController: window.AbortController, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) });
      const controller = controllerRef.current;
      const [state, setState] = React.useState(controller.getState());
      React.useEffect(() => { const unsubscribe = controller.subscribe(setState); controller.start(); return () => { unsubscribe(); controller.dispose(); }; }, [controller]);
      const status = state.status, running = status && status.state === 'running', busy = !!state.busy;
      const operationPhase = status && status.operation && status.operation.phase;
      const operationPending = ['starting', 'stopping'].includes(operationPhase);
      const secure = !!(status && status.connection && status.connection.available === true && status.connection.encrypted === true);
      const desktop = status && status.gateway && consoleUrl(status.gateway.consoleUrl);
      const phase = state.busy === 'start' || operationPhase === 'starting' ? 'Starting…' : state.busy === 'stop' || operationPhase === 'stopping' ? 'Stopping…' : state.loading && !status ? 'Checking…' : status ? ({ running: 'Running', stopped: 'Stopped', unconfigured: 'Setup needed', unavailable: 'Unavailable' }[status.state]) : 'Not connected';
      const button = (label, handler, disabled, cls = '') => h('button', { type: 'button', className: cls, onClick: handler, disabled }, label);
      async function copy() {
        const current = controller.getState().connection;
        if (!current) return;
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard-unavailable');
          await navigator.clipboard.writeText(current.url);
          if (controller.getState().connection === current) controller.setNote('Private link copied. Share it only with someone you trust.');
        } catch (_) {
          if (controller.getState().connection !== current) return;
          if (linkRef.current) { linkRef.current.focus(); linkRef.current.select(); }
          controller.setNote('Clipboard access is unavailable. The private link is selected; copy it manually.');
        }
      }
      function openDesktop() {
        const latest = controller.getState().status;
        const url = latest && latest.gateway && consoleUrl(latest.gateway.consoleUrl);
        if (!url) { controller.setNote('No verified local controls address is available. Use Start bridge and check the prerequisites below.'); return; }
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return h('section', { className: 'pb-plugin', 'aria-label': 'Pocket Bridge controls' },
        h('style', null, CSS),
        h('header', { className: 'pb-header' }, h(Logo), h('div', null, h('h2', null, 'Pocket Bridge'), h('p', { className: 'pb-muted' }, 'Your DSH workspace, within reach.'))),
        !state.local && h('div', { className: 'pb-notice', role: 'status' }, 'Open this panel in the DSH desktop app or its authenticated localhost web interface on this computer. Remote pages cannot read or change the private bridge connection.'),
        state.error && h('div', { className: 'pb-notice error', role: 'alert' }, state.error, state.code && h('div', { className: 'pb-muted' }, 'Code: ', state.code), h('div', null, button('Refresh status', () => controller.refresh(), busy || state.loading), desktop && button('Open desktop controls', openDesktop, busy))),
        state.note && h('div', { className: 'pb-notice', role: 'status', 'aria-live': 'polite' }, busy && h('span', { className: 'pb-spinner', 'aria-hidden': true }), state.note),
        h('div', { className: 'pb-card' },
          h('div', { className: 'pb-row' }, h('div', null, h('h3', null, 'Bridge status'), h('p', { className: 'pb-muted' }, 'These controls manage Pocket Bridge. They do not close DSH.')), h('span', { className: 'pb-badge', role: 'status' }, h('span', { className: 'pb-dot ' + (status ? status.state : 'unavailable'), 'aria-hidden': true }), phase)),
          h('p', { className: 'pb-hint' }, 'Before starting: install genuine Node.js 24 or newer. Public internet tunnels also need cloudflared; private HTTPS does not. The Windows installer includes Node.js and cloudflared, but the plugin package does not.'),
          h('div', { className: 'pb-fields' },
            h('div', null, h('div', { className: 'pb-muted' }, 'Connection'), h('div', { className: 'pb-value' }, status && status.connection ? (status.connection.mode === 'tunnel' ? 'Internet tunnel' : status.connection.mode === 'private-https' ? 'Private HTTPS' : 'Not ready') : 'Not checked')),
            h('div', null, h('div', { className: 'pb-muted' }, 'DSH runtime'), h('div', { className: 'pb-value' }, status && status.runtime ? (status.runtime.available ? 'Available' : 'Unavailable') + (status.runtime.version ? ' · ' + text(status.runtime.version, 40) : '') : 'Not checked')),
            status && status.version && h('div', null, h('div', { className: 'pb-muted' }, 'Bridge version'), h('div', { className: 'pb-value' }, text(status.version, 60))),
            h('div', null, h('div', { className: 'pb-muted' }, 'Message encryption'), h('div', { className: 'pb-value' }, encryptionLabel(status)))),
          status && status.code && h('p', { className: 'pb-hint' }, recovery(status.code)),
          status && status.operation && status.operation.code && h('p', { className: 'pb-hint' }, recovery(status.operation.code)),
          h('div', { className: 'pb-actions' },
            button(state.busy === 'start' || operationPhase === 'starting' ? 'Starting…' : 'Start bridge', () => controller.action('start'), !state.local || !state.controlsReady || busy || operationPending || state.loading || !!running, 'pb-primary'),
            button(state.busy === 'stop' || operationPhase === 'stopping' ? 'Stopping…' : 'Stop bridge', () => controller.action('stop'), !state.local || !state.controlsReady || busy || operationPending || !running, 'pb-danger'),
            button(state.loading ? 'Refreshing…' : 'Refresh status', () => controller.refresh(), !state.local || busy || state.loading),
            button('Open desktop controls', openDesktop, !state.local || busy || !desktop)),
          h('p', { className: 'pb-hint' }, 'Disabling or uninstalling this plugin does not stop a running bridge. Use Stop bridge first to pause phone access. Stopping does not revoke paired devices or shared links. Tunnel addresses may change after restart. Manage or revoke access in desktop controls.'),
          state.confirmStop && h('div', { className: 'pb-confirm', role: 'group', 'aria-label': 'Confirm stop bridge' },
            h('h3', null, 'Pause phone access?'), h('p', { className: 'pb-hint' }, 'Stopping the bridge stops serving phone connections. DSH stays open, and its running tasks continue.'),
            h('div', { className: 'pb-actions' }, button('Cancel', () => controller.cancelStop(), busy), button('Stop bridge', () => controller.action('stop'), busy, 'pb-danger')))),
        h('div', { className: 'pb-card' },
          h('h3', null, 'Connect your phone'), h('p', { className: 'pb-hint' }, 'Open the secure link in your phone browser. Connection details stay hidden until you ask to see them.'),
          running && !secure && h('p', { className: 'pb-hint' }, 'The secure phone entrance is not ready. Keep the bridge running, then refresh or run diagnostics.'),
          h('div', { className: 'pb-actions' }, state.connection ? button('Hide connection', () => controller.hide(), false) : button(state.busy === 'connection' ? 'Preparing connection…' : 'Show connection', () => controller.reveal(), !state.local || !state.controlsReady || busy || operationPending || !running || !secure, 'pb-primary')),
          state.connection && h('div', { className: 'pb-pairing' },
            state.connection.matrix ? h(Qr, { matrix: state.connection.matrix }) : h('p', { className: 'pb-muted' }, 'This link is too long for the local QR code. Copy the private link instead.'),
            h('div', null, h('h3', null, 'Scan with your phone camera'), h('p', { className: 'pb-hint' }, 'This QR code contains a private access link. Anyone with the link can connect. Keep it out of screenshots and public posts.'),
              h('input', { ref: linkRef, className: 'pb-private-link', value: state.connection.url, readOnly: true, type: 'text', 'aria-label': 'Private phone connection link', autoComplete: 'off', spellCheck: false }),
              h('div', { className: 'pb-actions' }, button('Copy private link', copy, busy)), h('p', { className: 'pb-muted' }, 'Generated locally. No QR service receives your link. Hidden after two minutes; hiding does not revoke copied links.')))),
        h('div', { className: 'pb-card' },
          h('div', { className: 'pb-row' }, h('div', null, h('h3', null, 'Connection diagnostics'), h('p', { className: 'pb-muted' }, 'Check the local bridge, DSH runtime and secure connection.')), button(state.busy === 'diagnostics' ? 'Checking…' : 'Run diagnostics', () => controller.diagnostics(), !state.local || !state.controlsReady || busy)),
          state.diagnosticsStale && h('p', { className: 'pb-hint' }, 'Run diagnostics again for the current bridge state.'),
          state.diagnostics && h('p', { className: 'pb-hint' }, h('time', { dateTime: state.diagnostics.checkedAt }, 'Checked ', new Date(state.diagnostics.checkedAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }))),
          state.diagnostics && h('ul', { className: 'pb-checks' }, state.diagnostics.checks.map((check, i) => h('li', { key: check.id + '-' + i, className: 'pb-check ' + check.state },
            h('span', { className: 'pb-check-mark', 'aria-label': check.state }, check.state === 'pass' ? '✓' : check.state === 'fail' ? '!' : '–'),
            h('div', null, h('div', { className: 'pb-check-title' }, check.label || check.id || 'Check'), h('p', { className: 'pb-muted' }, check.detail || 'No additional information.')))))),
        h('p', { className: 'pb-footer' }, 'Unofficial integration for DeepSeek Harness. Phone controls remain in Pocket Bridge’s lightweight web interface.'));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'pocket-bridge', order: 60, label: () => 'Pocket Bridge' }, Panel));
      },
      // Export pure helpers for dependency-free isolated regression checks.
      createController, qrMatrix, localOrigin, consoleUrl, pairingUrl, encryptionLabel
    };
  }
});
