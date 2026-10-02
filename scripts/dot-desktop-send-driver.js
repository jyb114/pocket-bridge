'use strict';
// Independent native Dot text sender. No actions are enabled by default.
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const P = require('./dot-desktop-protocol.js');
const { DotDesktopError } = require('./dot-desktop-driver.js');
function createDotTextSender(options = {}) {
  const permitted = options.testOnlyEnableSend === true;
  const versions = new Set((options.allowedSendVersions || []).filter(v => typeof v === 'string' && /^\d+(?:\.\d+){3}$/.test(v)));
  const spawnHelper = options.spawn || spawn;
  const powershell = options.powershellPath || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const platform = options.platform || process.platform;
  const timeoutMs = Math.min(90000, Math.max(1000, options.timeoutMs || 80000));
  const runDesktopAction = options.runDesktopAction || require('./desktop-ui-action.js').runDesktopAction;
  async function attest(helper, child) {
    if (!helper || helper.pid !== child.pid) throw new DotDesktopError('unknown', null);
    let observed;
    if (options.observeHelper) observed = await options.observeHelper(helper.pid);
    else observed = await new Promise((resolve, reject) => {
      const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + helper.pid + "';if($null -eq $p){exit 2};[ordered]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;creationTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();path=[string]$p.ExecutablePath}|ConvertTo-Json -Compress";
      execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 7000, maxBuffer: 4096, encoding: 'utf8' }, (cause, stdout) => {
          if (cause) return reject(new DotDesktopError('unknown', null));
          try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch (_) { reject(new DotDesktopError('unknown', null)); }
        });
    });
    if (!observed || observed.pid !== child.pid || observed.parentPid !== process.pid ||
        observed.creationTicks !== helper.creationTicks || typeof observed.path !== 'string' ||
        path.resolve(observed.path).toLowerCase() !== path.resolve(powershell).toLowerCase()) throw new DotDesktopError('unknown', null);
  }
  return {
    supports(version) { return permitted && versions.has(version); },
    async send(input, callbacks = {}) {
      if (!permitted || platform !== 'win32' || !versions.has(callbacks.version) ||
          ['onLocked', 'onPrepared', 'onReady', 'beforeAck', 'onResult', 'onFailure', 'onClose'].some(key => typeof callbacks[key] !== 'function'))
        throw new DotDesktopError('send-unavailable', false);
      const request = P.normalizeRequest(input), operationId = crypto.randomUUID();
      return runDesktopAction('dot-send', () => new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'DSH_API_KEY', 'ACCESS_TOKEN']) delete env[key];
        const temporary = path.join(path.dirname(__dirname), 'logs', 'native-temp');
        fs.mkdirSync(temporary, { recursive: true }); env.TEMP = temporary; env.TMP = temporary;
        let child, helper = null, baseline = null, result = null, forced = null, nativeFailure = null;
        let received = 0, buffer = '', nextSequence = 1, closed = false, terminal = false, timer, killTimer;
        let tail = Promise.resolve();
        const stages = ['locked', 'prepared', 'ready-to-send', 'result'];
        const stop = cause => {
          if (!forced) forced = cause instanceof DotDesktopError ? cause : new DotDesktopError('unknown', null);
          // EOF withdraws permission at either handshake and lets PowerShell
          // run its clipboard finally. Hard-kill only if it does not close;
          // even then retain the lease until CLOSE, with result unknown.
          try { child?.stdin.end(); } catch (_) {}
          if (!killTimer) { killTimer = setTimeout(() => { try { child?.kill(); } catch (_) {} }, 1500); killTimer.unref(); }
        };
        async function ack(stage) {
          if (forced || closed || terminal) throw new DotDesktopError('unknown', null);
          await attest(helper, child);
          await callbacks.beforeAck(stage, request, operationId, baseline ? P.baselineDigest(baseline) : null);
          if (forced || closed || terminal) throw new DotDesktopError('unknown', null);
          child.stdin.write(JSON.stringify(P.acknowledgement(request, operationId, nextSequence - 1, stage, baseline)) + '\n');
        }
        async function consume(value) {
          if (forced || terminal) throw new DotDesktopError('unknown', null);
          if (value.stage === 'error') {
            nativeFailure = P.failureFrame(value, request, operationId, nextSequence, baseline); nextSequence++; terminal = true;
            await callbacks.onFailure(nativeFailure, request, operationId, baseline); return;
          }
          P.frame(value, request, operationId, nextSequence, stages[nextSequence - 1], baseline); nextSequence++;
          if (value.stage === 'locked') {
            helper = value.helper; await attest(helper, child); await callbacks.onLocked(helper, request, operationId);
            await ack('continue-preflight');
          } else if (value.stage === 'prepared') {
            baseline = P.normalizeObservation(value.baseline, request, operationId);
            await callbacks.onPrepared(request, operationId, baseline); await ack('paste');
          } else if (value.stage === 'ready-to-send') {
            await callbacks.onReady(request, operationId, baseline); await ack('invoke');
          } else {
            terminal = true;
            result = await callbacks.onResult(value, request, operationId, baseline);
          }
        }
        try {
          child = spawnHelper(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(__dirname, 'dot-desktop-send.ps1')], {
            cwd: path.dirname(__dirname), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch (_) { reject(new DotDesktopError('desktop-unavailable', false)); return; }
        timer = setTimeout(() => stop(new DotDesktopError('unknown', null)), timeoutMs); timer.unref();
        child.stderr.resume(); // Never log accessibility text, drafts or clipboard data.
        child.stdin.on('error', () => stop(new DotDesktopError('unknown', null)));
        child.stdout.on('data', chunk => {
          received += chunk.length;
          if (received > 128 * 1024) { stop(new DotDesktopError('unknown', null)); return; }
          buffer += chunk.toString('utf8');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
            if (!line || Buffer.byteLength(line) > 64 * 1024) { stop(new DotDesktopError('unknown', null)); return; }
            tail = tail.then(async () => { let value; try { value = JSON.parse(line.replace(/^\uFEFF/, '')); }
              catch (_) { throw new DotDesktopError('unknown', null); } await consume(value); }).catch(stop);
          }
        });
        child.on('error', () => {
          stop(new DotDesktopError('desktop-unavailable', null));
        });
        child.on('close', () => {
          closed = true; clearTimeout(timer); clearTimeout(killTimer);
          tail.then(async () => {
            try { await callbacks.onClose(helper, request, operationId, { terminal, forced: !!forced }); }
            catch (_) { forced = new DotDesktopError('unknown', null); }
            if (forced) { reject(forced); return; }
            if (buffer.trim() || !terminal) { reject(new DotDesktopError('unknown', null)); return; }
            if (nativeFailure) {
              const cause = new DotDesktopError(nativeFailure.code, nativeFailure.submitted);
              cause.desktopDraftRemaining = nativeFailure.draftRemaining; reject(cause); return;
            }
            resolve(result);
          }).catch(() => reject(new DotDesktopError('unknown', null)));
        });
        try {
          child.stdin.write(JSON.stringify({ action: 'send', protocol: 1, operationId, requestId: request.requestId,
            requestFingerprint: P.fingerprint(request), textSha256: P.sha(request.text), expectedThreadId: request.threadId,
            text: request.text, expectedVersion: callbacks.version, testOnlyPermitSend: true }) + '\n');
        } catch (_) { stop(new DotDesktopError('unknown', null)); }
      }));
    }
  };
}
module.exports = { createDotTextSender };
