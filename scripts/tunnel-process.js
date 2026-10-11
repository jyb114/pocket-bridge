'use strict';

// Persisted PIDs are not process ownership. This adapter binds the executable,
// complete argv and OS birth identity, and never signals a newly looked-up PID.
// Windows holds one Process handle across the final identity check and kill.
// Linux can inspect /proc, but persisted-process stop is deliberately unsupported
// until a pidfd-based implementation can provide the same binding guarantee.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const MAX_PID = 0x7fffffff;
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_PID;
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\0\r\n]/.test(value);
const validArgs = value => Array.isArray(value) && value.length <= 64 && value.every(validText);
function absolute(value, platform) {
  return validText(value) && (platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : value.startsWith('/'));
}
function samePath(a, b, platform) {
  if (!absolute(a, platform) || !absolute(b, platform)) return false;
  return platform === 'win32'
    ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
    : a === b;
}
const sameArgs = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

function splitWindowsArguments(commandLine) {
  // Our launch arguments never need escaped quotes or trailing directory
  // backslashes. Refuse ambiguous encodings instead of guessing equivalence.
  if (!validText(commandLine) || /\\"/.test(commandLine)) return null;
  const tokens = [], token = /\s*(?:"([^"\r\n]+)"|([^\s"]+))(?=\s|$)/y;
  let position = 0;
  while (position < commandLine.length) {
    if (/^\s*$/.test(commandLine.slice(position))) break;
    token.lastIndex = position;
    const match = token.exec(commandLine);
    if (!match) return null;
    tokens.push(match[1] === undefined ? match[2] : match[1]);
    position = token.lastIndex;
  }
  return tokens.length && tokens.length <= 65 && tokens.every(validText) ? tokens : null;
}

function markerValid(value, platform) {
  if (!value || !['primary', 'backup'].includes(value.role) ||
      typeof value.generation !== 'string' || !/^[0-9a-f]{32}$/.test(value.generation) ||
      !absolute(value.logFile, platform) || !absolute(value.configFile, platform)) return false;
  const parser = platform === 'win32' ? path.win32 : path.posix;
  if (parser.basename(value.logFile) !== `${value.role}-${value.generation}.log` ||
      parser.basename(parser.dirname(value.logFile)) !== 'tunnels' ||
      parser.basename(value.configFile) !== `${value.role}-${value.generation}.yml` ||
      parser.normalize(value.logFile) !== value.logFile || parser.normalize(value.configFile) !== value.configFile ||
      !samePath(parser.dirname(value.logFile), parser.dirname(value.configFile), platform)) return false;
  const args = value.args;
  return validArgs(args) && args.length === 10 && args[0] === 'tunnel' && args[1] === '--url' &&
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(args[2]) && Number(args[2].split(':').pop()) <= 65535 &&
    args[3] === '--no-autoupdate' && args[4] === '--logfile' && args[5] === value.logFile &&
    args[6] === '--metrics' && args[7] === '127.0.0.1:0' && args[8] === '--config' && args[9] === value.configFile;
}

function validProof(proof, platform) {
  if (!proof || proof.version !== 1 || proof.platform !== platform || !validPid(proof.pid) ||
      !absolute(proof.exe, platform) || !absolute(proof.nativeExe, platform) ||
      !absolute(proof.argv0, platform) || !validArgs(proof.args) || typeof proof.birth !== 'string') return false;
  if (platform === 'win32') {
    const argv = splitWindowsArguments(proof.commandLine);
    if (!/^[1-9][0-9]{16,18}$/.test(proof.birth) || !argv || argv[0] !== proof.argv0 ||
        !samePath(proof.argv0, proof.nativeExe, platform) || !sameArgs(argv.slice(1), proof.args)) return false;
  } else if (platform === 'linux') {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+$/.test(proof.birth)) return false;
  } else return false;
  const marked = ['role', 'generation', 'logFile', 'configFile'].some(key => Object.hasOwn(proof, key));
  return !marked || markerValid(proof, platform);
}

// Input is embedded only as base64 JSON, never interpolated PowerShell syntax.
// The process birth uses exact .NET ticks, stored as a string (not a JS Number).
// CIM timestamps are only a second cross-check, at their millisecond precision.
const WINDOWS_COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($Value) { $Value | ConvertTo-Json -Compress -Depth 8 }
function Same-Path($A, $B) {
  if (-not $A -or -not $B -or $A -notmatch '^[a-z]:[\\/]' -or $B -notmatch '^[a-z]:[\\/]') { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($A), [IO.Path]::GetFullPath($B), [StringComparison]::OrdinalIgnoreCase)
}
function Read-Info([int]$ProcessId) {
  $items = @(Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop)
  if ($items.Count -gt 1) { throw 'ambiguous-process' }
  if ($items.Count -eq 0) { return $null }
  return $items[0]
}
function Same-Birth($Info, $Held) {
  if (-not $Info -or -not $Info.CreationDate) { return $false }
  $one = ([datetime]$Info.CreationDate).ToUniversalTime().Ticks
  $two = $Held.StartTime.ToUniversalTime().Ticks
  return ($one -gt 0 -and ($one - ($one % 10000)) -eq ($two - ($two % 10000)))
}
function Read-One([int]$ProcessId) {
  $held = $null
  try {
    $first = Read-Info $ProcessId
    if (-not $first) { return @{state='exited'} }
    $held = Get-Process -Id $ProcessId -ErrorAction Stop
    $null = $held.Handle
    $info = Read-Info $ProcessId
    if ($held.HasExited) { return @{state='exited'} }
    if (-not (Same-Birth $info $held) -or [int]$info.ProcessId -ne $ProcessId -or
        -not $info.ExecutablePath -or -not $info.CommandLine) {
      return @{state='unknown'}
    }
    $birth = $held.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    return @{state='live'; process=@{pid=$ProcessId; nativeExe=[string]$info.ExecutablePath;
      commandLine=[string]$info.CommandLine; birth=$birth}}
  } catch { return @{state='unknown'} }
  finally { if ($held) { $held.Dispose() } }
}
`;

function windowsScript(operation, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  let body;
  if (operation === 'inspect') {
    body = 'Emit (Read-One ([int]$inputData.pid))';
  } else if (operation === 'list') {
    body = String.raw`
try {
  $name = [IO.Path]::GetFileName([string]$inputData.exe).Replace("'", "''")
  $items = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction Stop)
  if ($items.Count -gt 256) { throw 'too-many-candidates' }
  $found = @()
  foreach ($item in $items) {
    if (-not $item.ExecutablePath) { throw 'unreadable-candidate' }
    $record = Read-One ([int]$item.ProcessId)
    if ($record.state -eq 'unknown') { throw 'unreadable-candidate' }
    if ($record.state -eq 'live') { $found += $record.process }
  }
  Emit @{state='ok'; processes=@($found)}
} catch { Emit @{state='unknown'; processes=@()} }
`;
  } else if (operation === 'stop') {
    body = String.raw`
$held = $null
try {
  $held = Get-Process -Id ([int]$inputData.pid) -ErrorAction Stop
  # Opening this handle before any verification pins the process being stopped.
  $null = $held.Handle
  if ($held.HasExited) { Emit @{stopped=$true; code='already-exited'}; return }
  $birth = $held.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  if ($birth -cne [string]$inputData.birth) { Emit @{stopped=$false; code='process-changed'}; return }
  $info = Read-Info ([int]$inputData.pid)
  if (-not (Same-Birth $info $held) -or [int]$info.ProcessId -ne [int]$inputData.pid -or
      -not (Same-Path $info.ExecutablePath $inputData.nativeExe) -or
      -not [string]::Equals([string]$info.CommandLine, [string]$inputData.commandLine, [StringComparison]::Ordinal)) {
    Emit @{stopped=$false; code='identity-changed'}; return
  }
  # Never replace this with Stop-Process, taskkill, or a new PID lookup.
  $held.Kill()
  if ($held.WaitForExit([int]$inputData.waitMs)) { Emit @{stopped=$true; code='stopped'} }
  else { Emit @{stopped=$false; code='stop-unconfirmed'} }
} catch { Emit @{stopped=$false; code='stop-unconfirmed'} }
finally { if ($held) { $held.Dispose() } }
`;
  } else throw new TypeError('Invalid native process operation.');
  return `${WINDOWS_COMMON}\n$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n${body}`;
}

function createProcessAdapter(options = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || childProcess.execFile;
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);
  const readlink = options.readlink || fs.promises.readlink.bind(fs.promises);
  const realpath = options.realpath || fs.promises.realpath.bind(fs.promises);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 30000
    ? options.timeoutMs : 8000;
  const powershell = options.powershell || path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  async function resolveExe(exe) {
    if (!absolute(exe, platform)) throw Error('invalid-executable');
    const resolved = await realpath(exe);
    if (!absolute(resolved, platform)) throw Error('invalid-executable');
    return resolved;
  }
  async function windows(operation, input) {
    const script = windowsScript(operation, input);
    const stdout = await new Promise((resolve, reject) => {
      execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, output) => error ? reject(error) : resolve(output));
    });
    const result = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('invalid-native-result');
    return result;
  }
  async function windowsProof(record) {
    if (!record || !validPid(record.pid) || !absolute(record.nativeExe, platform)) return null;
    const argv = splitWindowsArguments(record.commandLine);
    if (!argv || !samePath(argv[0], record.nativeExe, platform)) return null;
    const proof = { version: 1, platform, pid: record.pid, exe: await resolveExe(record.nativeExe),
      nativeExe: record.nativeExe, argv0: argv[0], args: argv.slice(1), birth: record.birth,
      commandLine: record.commandLine };
    return validProof(proof, platform) ? proof : null;
  }
  function parseStat(text, pid) {
    const source = String(text), end = source.lastIndexOf(') ');
    if (!source.startsWith(`${pid} (`) || end < 0) throw Error('invalid-proc-stat');
    const fields = source.slice(end + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^[0-9]+$/.test(fields[19]) || !/^[A-Za-z]$/.test(fields[0])) throw Error('invalid-proc-stat');
    return { state: fields[0], start: fields[19] };
  }
  async function linux(pid) {
    const base = `/proc/${pid}`;
    let first;
    try { first = parseStat(await readFile(`${base}/stat`, 'utf8'), pid); }
    catch (error) { return { state: error.code === 'ENOENT' || error.code === 'ESRCH' ? 'exited' : 'unknown' }; }
    if (first.state === 'Z' || first.state === 'X') return { state: 'exited' };
    try {
      const boot = String(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const nativeExe = await readlink(`${base}/exe`);
      const bytes = await readFile(`${base}/cmdline`);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes[bytes.length - 1] !== 0 || / \(deleted\)$/.test(nativeExe)) return { state: 'unknown' };
      const argv = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\0');
      const second = parseStat(await readFile(`${base}/stat`, 'utf8'), pid);
      if (second.start !== first.start) return { state: 'unknown' };
      if (second.state === 'Z' || second.state === 'X') return { state: 'exited' };
      const proof = { version: 1, platform, pid, exe: await resolveExe(nativeExe), nativeExe,
        argv0: argv[0], args: argv.slice(1), birth: `${boot}:${first.start}` };
      if (!validProof(proof, platform) || !samePath(await resolveExe(proof.argv0), proof.exe, platform)) return { state: 'unknown' };
      return { state: 'live', proof };
    } catch (_) { return { state: 'unknown' }; }
  }
  async function read(pid) {
    if (!validPid(pid)) return { state: 'unknown' };
    try {
      if (platform === 'linux') return await linux(pid);
      if (platform !== 'win32') return { state: 'unknown' };
      const result = await windows('inspect', { pid });
      if (result.state === 'exited') return { state: 'exited' };
      if (result.state !== 'live') return { state: 'unknown' };
      const proof = await windowsProof(result.process);
      return proof && proof.pid === pid ? { state: 'live', proof } : { state: 'unknown' };
    } catch (_) { return { state: 'unknown' }; }
  }

  return Object.freeze({
    async capture(pid, launch) {
      if (!validPid(pid) || !markerValid(launch, platform)) return null;
      launch = { ...launch, args: [...launch.args] };
      try {
        const expected = await resolveExe(launch.exe), result = await read(pid);
        if (result.state !== 'live' || !samePath(expected, result.proof.exe, platform) ||
            !sameArgs(launch.args, result.proof.args)) return null;
        return { ...result.proof, role: launch.role, generation: launch.generation,
          logFile: launch.logFile, configFile: launch.configFile };
      } catch (_) { return null; }
    },
    async inspect(proof) {
      if (!validProof(proof, platform)) return { state: 'unknown', code: 'invalid-proof' };
      proof = { ...proof, args: [...proof.args] };
      const current = await read(proof.pid);
      if (current.state !== 'live') return current;
      if (current.proof.birth !== proof.birth) return { state: 'exited', code: 'birth-changed' };
      if (!samePath(current.proof.exe, proof.exe, platform) || current.proof.argv0 !== proof.argv0 ||
          !sameArgs(current.proof.args, proof.args) ||
          (platform === 'win32' && current.proof.commandLine !== proof.commandLine)) return { state: 'unknown', code: 'identity-changed' };
      return { state: 'live', proof: { ...proof, args: [...proof.args] } };
    },
    async stop(proof) {
      if (!validProof(proof, platform)) return { stopped: false, code: 'invalid-proof' };
      proof = { ...proof, args: [...proof.args] };
      if (platform !== 'win32') return { stopped: false, code: 'pidfd-required' };
      try {
        if (!samePath(await resolveExe(proof.nativeExe), proof.exe, platform)) return { stopped: false, code: 'identity-changed' };
        const result = await windows('stop', { ...proof, waitMs: Math.min(3000, timeoutMs - 500) });
        if (result.stopped === true && ['stopped', 'already-exited'].includes(result.code)) return { stopped: true, code: result.code };
        const code = ['process-changed', 'identity-changed', 'stop-unconfirmed'].includes(result.code) ? result.code : 'stop-unconfirmed';
        return { stopped: false, code };
      } catch (_) { return { stopped: false, code: 'stop-unconfirmed' }; }
    },
    async list({ exe } = {}) {
      if (platform !== 'win32') return { state: 'unknown', processes: [], code: 'discovery-unsupported' };
      try {
        const expected = await resolveExe(exe), result = await windows('list', { exe: expected });
        if (result.state !== 'ok' || !Array.isArray(result.processes) || result.processes.length > 256) throw Error('unreadable-candidates');
        const processes = [], pids = new Set();
        for (const record of result.processes) {
          const proof = await windowsProof(record);
          if (!proof || pids.has(proof.pid)) throw Error('invalid-candidate');
          pids.add(proof.pid);
          if (samePath(expected, proof.exe, platform)) processes.push(proof);
        }
        return { state: 'ok', processes };
      } catch (_) { return { state: 'unknown', processes: [], code: 'discovery-unavailable' }; }
    }
  });
}

module.exports = { createProcessAdapter };
