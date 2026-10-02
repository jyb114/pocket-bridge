'use strict';

// Independent native Your dot transport. No Codex app-server or cloud MCP RPCs.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES = new Set(['desktop-unavailable', 'desktop-ambiguous', 'desktop-busy', 'dot-unavailable',
  'target-mismatch', 'history-unavailable', 'clipboard-unavailable', 'draft-present', 'send-unavailable', 'unknown']);
const TEXT = Object.freeze({
  'desktop-unavailable': 'The official desktop app is unavailable. Open it and sign in first.',
  'desktop-ambiguous': 'More than one desktop window is open. Select one before using Dot.',
  'desktop-busy': 'The computer input is busy. Release the keys and try again.',
  'dot-unavailable': 'Your dot could not be identified in the official desktop app.',
  'target-mismatch': 'The desktop dot changed. Nothing was sent.',
  'history-unavailable': 'The current Dot messages could not be read safely.',
  'clipboard-unavailable': 'The computer clipboard could not be preserved.',
  'draft-present': 'The desktop contains an unsent draft. Nothing was sent.',
  'send-unavailable': 'Text sending is not yet available for this desktop version.',
  'unknown': 'The desktop action could not be confirmed.'
});
class DotDesktopError extends Error {
  constructor(code, submitted = false) {
    super(TEXT[code] || TEXT.unknown);
    this.code = CODES.has(code) ? code : 'unknown';
    this.submitted = submitted === true ? true : submitted === false ? false : null;
  }
}
function durableId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DotDesktopError('target-mismatch');
  return value.toLowerCase();
}
function validateSnapshot(value, expected) {
  if (!value || value.ok !== true || value.hostId !== 'durable' || !UUID.test(value.threadId || '') ||
      (expected && value.threadId.toLowerCase() !== expected) || value.historyScope !== 'materialized-recent' ||
      !Array.isArray(value.messages) || value.messages.length > 40 || !Number.isSafeInteger(value.materializedRowCount) ||
      value.materializedRowCount < value.messages.length || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0)
    throw new DotDesktopError('history-unavailable');
  const ids = new Set(); let bytes = 0;
  const messages = value.messages.map(message => {
    if (!message || typeof message.observationId !== 'string' || !/^[0-9a-f]{64}$/.test(message.observationId) ||
        ids.has(message.observationId) || !['user', 'assistant'].includes(message.role) ||
        typeof message.text !== 'string' || message.text.includes('\0') || message.text.length > 32768 ||
        typeof message.hasText !== 'boolean' || message.hasText !== (message.text.length > 0))
      throw new DotDesktopError('history-unavailable');
    ids.add(message.observationId); bytes += Buffer.byteLength(message.text);
    return { observationId: message.observationId, role: message.role, text: message.text, hasText: message.hasText };
  });
  if (bytes > 128 * 1024) throw new DotDesktopError('history-unavailable');
  return { hostId: 'durable', threadId: value.threadId.toLowerCase(), observedAt: value.observedAt,
    historyScope: 'materialized-recent', stableMessageIds: false,
    materializedRowCount: value.materializedRowCount, messages,
    taskExecution: 'unknown', localComputerAccess: 'unverified', sendAvailable: false,
    sendUnavailableCode: 'draft-reader-unverified' };
}
function createDotDesktopDriver(options = {}) {
  let runDesktopAction = options.runDesktopAction;
  if (!runDesktopAction) {
    try { runDesktopAction = require('./desktop-ui-action.js').runDesktopAction; } catch (_) {}
  }
  const spawnHelper = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const timeoutMs = Math.min(45000, Math.max(1000, Number(options.timeoutMs) || 42000));
  const powershell = options.powershellPath || path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  function run(payload) {
    if (typeof runDesktopAction !== 'function') return Promise.reject(new DotDesktopError('desktop-unavailable'));
    return runDesktopAction(payload.action === 'send' ? 'dot-send' : 'dot-read', () => new Promise((resolve, reject) => {
      if (platform !== 'win32') { reject(new DotDesktopError('desktop-unavailable')); return; }
      const env = { ...process.env };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'DSH_API_KEY', 'ACCESS_TOKEN']) delete env[key];
      let child, timer, settled = false, bytes = 0, forcedError = null;
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      try {
        // PowerShell Add-Type also needs scratch files. Keep them with this
        // installed bridge, rather than inheriting a different drive's TEMP.
        const temporary = path.join(path.dirname(__dirname), 'logs', 'native-temp');
        fs.mkdirSync(temporary, { recursive: true }); env.TEMP = temporary; env.TMP = temporary;
        child = spawnHelper(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy',
          'Bypass', '-File', path.join(__dirname, 'dot-desktop-ui.ps1')], {
          cwd: path.dirname(__dirname), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (_) { finish(new DotDesktopError('desktop-unavailable')); return; }
      // Retain the shared lease until the helper actually exits. Its Windows
      // mutex is held through clipboard restoration, including timeout cleanup.
      timer = setTimeout(() => { forcedError = new DotDesktopError('unknown'); child.kill(); }, timeoutMs);
      timer.unref();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) { forcedError = new DotDesktopError('history-unavailable'); child.kill(); }
        else chunks.push(chunk);
      });
      child.stderr.resume(); // Never log accessibility text, drafts, paths or clipboard data.
      child.stdin.on('error', () => {});
      child.on('error', () => {
        const error = new DotDesktopError('desktop-unavailable');
        if (child.pid) { forcedError = error; try { child.kill(); } catch (_) {} }
        else finish(error);
      });
      child.on('close', () => {
        if (settled) return;
        if (forcedError) { finish(forcedError); return; }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8').trim().replace(/^\uFEFF/, '')); }
        catch (_) { finish(new DotDesktopError('unknown')); return; }
        if (!value || value.ok !== true) { finish(new DotDesktopError(value?.code)); return; }
        finish(null, value);
      });
      child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
    }));
  }
  return {
    async inspect() {
      try {
        const value = await run({ action: 'inspect' });
        return { available: value.available === true, desktopRunning: value.desktopRunning === true,
          version: typeof value.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value.version) ? value.version : null,
          sendAvailable: false, reason: value.available ? 'ready-to-connect' : 'desktop-unavailable' };
      } catch (error) { return { available: false, desktopRunning: false, sendAvailable: false, reason: error.code || 'unknown' }; }
    },
    async snapshot(input = {}) {
      const expected = input.threadId == null ? null : durableId(input.threadId);
      return validateSnapshot(await run({ action: 'snapshot', expectedThreadId: expected, maximumMessages: 40 }), expected);
    },
    async send() { throw new DotDesktopError('send-unavailable', false); }
  };
}
module.exports = { createDotDesktopDriver, DotDesktopError, validateSnapshot, durableId };
