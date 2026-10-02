'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { runDesktopAction: sharedDesktopAction } = require('./desktop-ui-action.js');
const { verifyComposerTextProof } = require('./codex-desktop-text.js');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES = new Set(['desktop-unavailable', 'desktop-busy', 'draft-present', 'target-mismatch',
  'composer-unavailable', 'send-control-unavailable', 'unknown']);
// Diagnostic stages are fixed labels only: never accept UI text, prompts,
// clipboard contents, executable paths, or arbitrary helper output here.
const STAGES = new Set(['read-request', 'acquire-desktop-action', 'trust-desktop', 'activate-thread', 'bind-window',
  'verify-mode', 'read-source-draft', 'read-chatgpt-draft', 'switch-mode', 'verify-target', 'verify-composer-layout', 'read-codex-draft',
  'paste-text', 'verify-paste', 'verify-send', 'invoke-send', 'restore-clipboard', 'complete']);
function safeForegroundDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const diagnostic = {};
  for (const key of ['foregroundHandle', 'foregroundRootHandle', 'boundWindowHandle']) {
    if (typeof value[key] !== 'string' || !/^\d{1,20}(?![\s\S])/.test(value[key])) return null;
    diagnostic[key] = value[key];
  }
  for (const key of ['foregroundProcessId', 'foregroundRootProcessId', 'boundProcessId', 'elapsedMs']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    diagnostic[key] = value[key];
  }
  if (!['none', 'thread', 'cwd'].includes(value.identityCopyKind) ||
      !['none', 'before-sentinel', 'before-shortcut', 'after-shortcut', 'poll-shortcut', 'complete'].includes(value.identityCopyPhase)) return null;
  diagnostic.identityCopyKind = value.identityCopyKind;
  diagnostic.identityCopyPhase = value.identityCopyPhase;
  return diagnostic;
}
function safeModifierDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const diagnostic = {};
  for (const key of ['shift', 'control', 'alt', 'leftShift', 'rightShift', 'leftControl', 'rightControl',
    'leftAlt', 'rightAlt', 'leftWin', 'rightWin']) {
    if (typeof value[key] !== 'boolean') return null;
    diagnostic[key] = value[key];
  }
  return diagnostic;
}

class DesktopRelayError extends Error {
  constructor(code, message, submitted = false) {
    super(message);
    this.name = 'DesktopRelayError';
    this.code = CODES.has(code) ? code : 'unknown';
    this.submitted = submitted === true ? true : submitted === false ? false : null;
    if (this.code === 'desktop-busy') this.status = 409;
  }
}

function createDesktopDriver(options = {}) {
  const spawnHelper = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const runDesktopAction = options.runDesktopAction || sharedDesktopAction;
  const timeoutMs = Math.min(40000, Math.max(1000, Number(options.timeoutMs) || 38000));
  const powershell = options.powershellPath || path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'codex-desktop-ui.ps1');

  function run(payload) {
    return runDesktopAction(payload.action === 'send' ? 'codex-send' : 'codex-inspect', () => new Promise((resolve, reject) => {
      const isSend = payload.action === 'send';
      if (platform !== 'win32') {
        reject(new DesktopRelayError('desktop-unavailable', 'Desktop relay requires Windows.', false));
        return;
      }
      let child;
      const env = { ...process.env };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'DSH_API_KEY', 'ACCESS_TOKEN']) delete env[key];
      try {
        // Keep the native helper's Add-Type compiler scratch beside this
        // installed Bridge instead of inheriting the account's C: temp path.
        const nativeTemp = path.join(path.dirname(__dirname), 'logs', 'native-temp');
        fs.mkdirSync(nativeTemp, { recursive: true });
        env.TEMP = nativeTemp; env.TMP = nativeTemp;
        child = spawnHelper(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
          '-ExecutionPolicy', 'Bypass', '-File', script], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd: path.dirname(__dirname)
        });
      } catch (_) {
        reject(new DesktopRelayError('desktop-unavailable', 'Desktop helper could not start.', false));
        return;
      }
      const outputChunks = [];
      let outputBytes = 0, finished = false, forcedError = null;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        // Only the helper created by this call is stopped. Never stop Codex.
        forcedError = new DesktopRelayError('unknown', 'Desktop relay timed out; check the conversation before retrying.',
          isSend ? null : false);
        child.kill();
        // Keep the shared lease until close, including native clipboard cleanup.
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', chunk => {
        if (forcedError) return;
        outputBytes += chunk.length;
        if (outputBytes > 32768) {
          forcedError = new DesktopRelayError('unknown', 'Desktop helper returned an invalid response.', isSend ? null : false);
          child.kill();
        } else outputChunks.push(chunk);
      });
      // Do not put helper stderr, clipboard contents, or message text in logs.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => {
        forcedError = forcedError || new DesktopRelayError('desktop-unavailable', 'Desktop helper is unavailable.',
          isSend && child.pid ? null : false);
        if (child.pid) child.kill();
      });
      child.on('close', () => {
        if (finished) return;
        if (forcedError) { finish(forcedError); return; }
        let value;
        try { value = JSON.parse(Buffer.concat(outputChunks).toString('utf8').trim().replace(/^\uFEFF/, '')); }
        catch (_) {
          finish(new DesktopRelayError('unknown', 'Desktop helper did not return a verified result.', isSend ? null : false));
          return;
        }
        if (!value || value.ok !== true) {
          const error = new DesktopRelayError(value?.code, typeof value?.reason === 'string' ? value.reason : 'Desktop relay failed.',
            value?.submitted === false ? false : value?.submitted === true ? true : isSend ? null : false);
          if (STAGES.has(value?.stage)) error.stage = value.stage;
          const diagnostic = safeForegroundDiagnostic(value?.foregroundDiagnostic);
          if (diagnostic) error.foregroundDiagnostic = diagnostic;
          const modifiers = safeModifierDiagnostic(value?.modifierDiagnostic);
          if (modifiers) error.modifierDiagnostic = modifiers;
          if (typeof value?.desktopDraftRemaining === 'boolean') error.desktopDraftRemaining = value.desktopDraftRemaining;
          if (typeof value?.desktopDraftCleared === 'boolean') error.desktopDraftCleared = value.desktopDraftCleared;
          finish(error);
          return;
        }
        if (isSend && (value.submitted !== true || value.verifiedThreadId !== payload.threadId ||
          typeof value.actualCwd !== 'string' || !value.desktopIdentity)) {
          finish(new DesktopRelayError('unknown', 'Desktop submission identity was not verified.', null));
          return;
        }
        if (isSend) {
          const proof = verifyComposerTextProof(value.composerTextProof, payload.text);
          if (!proof) {
            finish(new DesktopRelayError('unknown', 'Desktop submission text could not be verified.', null));
            return;
          }
          value.composerTextProof = proof;
        }
        finish(null, value);
      });
      // The UUID, path, and private message all travel in stdin, never argv.
      child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
    }));
  }

  return {
    async inspect() {
      try {
        const value = await run({ action: 'inspect' });
        return { available: value.available === true, desktopRunning: value.desktopRunning === true,
          reason: value.reason || null, version: value.version || null };
      } catch (error) {
        return { available: false, desktopRunning: false, reason: error.code || 'unknown', version: null };
      }
    },
    async send(input) {
      if (!input || !THREAD_ID.test(input.threadId || '') || typeof input.cwd !== 'string' ||
        !path.win32.isAbsolute(input.cwd) || /^[a-z]:[^\\/]/i.test(input.cwd) || typeof input.text !== 'string' ||
        !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text, 'utf8') > 98304 ||
        typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 120) {
        throw new DesktopRelayError('target-mismatch', 'Invalid desktop relay target or message.', false);
      }
      const payload = { action: 'send', requestId: input.requestId,
        threadId: input.threadId.toLowerCase(), cwd: input.cwd, text: input.text };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 128 * 1024) {
        throw new DesktopRelayError('target-mismatch', 'Desktop relay message is too large.', false);
      }
      const value = await run(payload);
      return { submitted: true, verifiedThreadId: value.verifiedThreadId,
        actualCwd: value.actualCwd, desktopIdentity: value.desktopIdentity, composerTextProof: value.composerTextProof };
    }
  };
}

const defaultDriver = createDesktopDriver();
module.exports = { createDesktopDriver, DesktopRelayError, safeForegroundDiagnostic, safeModifierDiagnostic, inspect: defaultDriver.inspect, send: defaultDriver.send };
