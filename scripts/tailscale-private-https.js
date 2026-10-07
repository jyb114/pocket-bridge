'use strict';

// Advisory, local-console status only. This module cannot configure Tailscale,
// authenticate a device, admit a proxy, create an address, or open a listener.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LIMITS = Object.freeze({ commandMs: 4000, outputBytes: 1024 * 1024, configs: 17, entries: 128 });
const READ_COMMANDS = Object.freeze([
  Object.freeze(['version']),
  Object.freeze(['status', '--json']),
  Object.freeze(['serve', 'status', '--json'])
]);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = o => !!o && typeof o === 'object' && !Array.isArray(o);
const keysWithin = (o, names) => record(o) && Object.keys(o).length <= LIMITS.entries && Object.keys(o).every(k => names.includes(k));

function normalizePrivateOrigin(value) {
  if (typeof value !== 'string' || value.length > 260 || value !== value.trim()) return null;
  // Deliberately reject URL normalization tricks, wildcard/IDN names and any
  // secret-bearing path, query, fragment or userinfo before parsing the origin.
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || match[1].split('.').some(label => label.startsWith('xn--'))) return null;
  const port = match[2] ? Number(match[2]) : 443;
  if (port > 65535) return null;
  const origin = 'https://' + match[1] + (port === 443 ? '' : ':' + port);
  return Object.freeze({ origin, hostname: match[1], port, hostPort: match[1] + ':' + port });
}

function gatewayPortOf(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function versionOf(text) {
  const match = typeof text === 'string' && /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(?:\r?\n|$)/.exec(text.trim());
  return match ? { text: match[1] + '.' + match[2] + '.' + match[3], major: Number(match[1]), minor: Number(match[2]) } : null;
}

function proxyIsExact(value, port) {
  return value === 'http://127.0.0.1:' + port || value === 'http://127.0.0.1:' + port + '/';
}

function inspectServeConfig(config, options) {
  const origin = normalizePrivateOrigin(options && options.origin);
  const gatewayPort = gatewayPortOf(options && options.gatewayPort);
  if (!origin || !gatewayPort) return { configurationReady: false, code: 'invalid-options' };
  if (!record(config)) return { configurationReady: false, code: 'invalid-serve-status' };
  const configs = [];
  function collect(candidate, foreground) {
    if (!keysWithin(candidate, ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services', 'ETag'])) throw new Error('schema');
    if (configs.length >= LIMITS.configs) throw new Error('schema');
    for (const field of ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']) {
      if (own(candidate, field) && candidate[field] !== null && (!record(candidate[field]) || Object.keys(candidate[field]).length > LIMITS.entries)) throw new Error('schema');
    }
    // This first implementation understands node Serve, not hosted Services.
    if (candidate.Services && Object.keys(candidate.Services).length) throw new Error('schema');
    if (foreground && candidate.Foreground && Object.keys(candidate.Foreground).length) throw new Error('schema');
    configs.push(candidate);
    for (const child of Object.values(candidate.Foreground || {})) collect(child, true);
  }
  try { collect(config, false); } catch (_) { return { configurationReady: false, code: 'unsupported-serve-status' }; }
  let matches = 0;
  for (const candidate of configs) {
    for (const enabled of Object.values(candidate.AllowFunnel || {})) {
      if (typeof enabled !== 'boolean') return { configurationReady: false, code: 'invalid-serve-status' };
      // Conservative whole-node warning: never change an unrelated Funnel.
      if (enabled) return { configurationReady: false, code: 'funnel-present' };
    }
    for (const tcp of Object.values(candidate.TCP || {})) {
      if (!keysWithin(tcp, ['HTTPS', 'HTTP', 'TCPForward', 'TerminateTLS', 'ProxyProtocol'])) return { configurationReady: false, code: 'unsupported-serve-status' };
      if (['HTTPS', 'HTTP'].some(field => own(tcp, field) && typeof tcp[field] !== 'boolean') || ['TCPForward', 'TerminateTLS'].some(field => own(tcp, field) && typeof tcp[field] !== 'string') || (own(tcp, 'ProxyProtocol') && (!Number.isInteger(tcp.ProxyProtocol) || tcp.ProxyProtocol < 0))) return { configurationReady: false, code: 'invalid-serve-status' };
    }
    for (const [hostPort, web] of Object.entries(candidate.Web || {})) {
      if (!keysWithin(web, ['Handlers']) || !record(web.Handlers) || Object.keys(web.Handlers).length > LIMITS.entries) return { configurationReady: false, code: 'invalid-serve-status' };
      for (const [mount, handler] of Object.entries(web.Handlers)) {
        if (!keysWithin(handler, ['Path', 'Proxy', 'Text', 'AcceptAppCaps', 'Redirect'])) return { configurationReady: false, code: 'unsupported-serve-status' };
        if (['Path', 'Proxy', 'Text', 'Redirect'].some(field => own(handler, field) && typeof handler[field] !== 'string') || (own(handler, 'AcceptAppCaps') && (!Array.isArray(handler.AcceptAppCaps) || handler.AcceptAppCaps.some(cap => typeof cap !== 'string')))) return { configurationReady: false, code: 'invalid-serve-status' };
        if (proxyIsExact(handler.Proxy, gatewayPort) && (hostPort !== origin.hostPort || mount !== '/')) return { configurationReady: false, code: 'serve-conflict' };
      }
    }
    const tcp = (candidate.TCP || {})[String(origin.port)];
    const web = (candidate.Web || {})[origin.hostPort];
    if (!tcp && !web) continue;
    if (!tcp || !web || tcp.HTTPS !== true || tcp.HTTP === true || tcp.TCPForward || tcp.TerminateTLS || tcp.ProxyProtocol) return { configurationReady: false, code: 'serve-conflict' };
    const handlers = web.Handlers;
    const root = handlers && handlers['/'];
    if (!root || Object.keys(handlers).length !== 1 || !proxyIsExact(root.Proxy, gatewayPort) || root.Path || root.Text || root.Redirect || (root.AcceptAppCaps && (!Array.isArray(root.AcceptAppCaps) || root.AcceptAppCaps.length))) return { configurationReady: false, code: 'serve-conflict' };
    matches++;
  }
  return matches === 1 ? { configurationReady: true, code: 'configured' } : { configurationReady: false, code: matches ? 'serve-conflict' : 'serve-not-configured' };
}

function findInstalledCli() {
  if (process.platform !== 'win32') return null;
  // Avoid PATH and caller-supplied executables. Nonstandard installations are
  // reported as unavailable rather than invoking an untrusted command.
  const drive = /^[A-Za-z]:$/.test(process.env.SystemDrive || '') ? process.env.SystemDrive : 'C:';
  for (const base of ['Program Files', 'Program Files (x86)']) {
    const file = path.win32.join(drive + '\\', base, 'Tailscale', 'tailscale.exe');
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) return file;
    } catch (_) { /* Not installed at this supported location. */ }
  }
  return null;
}

function runReadOnly(file, args) {
  if (!READ_COMMANDS.some(allowed => allowed.length === args.length && allowed.every((part, index) => part === args[index]))) return Promise.reject(new Error('read-command-refused'));
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, shell: false, timeout: LIMITS.commandMs, maxBuffer: LIMITS.outputBytes, encoding: 'utf8' }, (error, stdout) => {
      // Neither stderr nor raw status is returned to a caller or logged.
      if (error) return reject(new Error('read-command-unavailable'));
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > LIMITS.outputBytes) return reject(new Error('read-command-unavailable'));
      resolve(stdout);
    });
  });
}

function parseBoundedJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.outputBytes) throw new Error('invalid-status');
  const value = JSON.parse(text);
  if (!record(value)) throw new Error('invalid-status');
  return value;
}

async function readStatus(options = {}, dependencies = {}) {
  const result = { mode: 'status-only', enabled: options.enabled === true, installed: false, connected: false, version: null, origin: null, gatewayPort: gatewayPortOf(options.gatewayPort), configurationReady: false, gatewayAdmissionImplemented: false, phoneVerified: false, mutationPerformed: false, code: 'disabled' };
  // Disabled means no CLI discovery, subprocess, daemon request or file read.
  if (!result.enabled) return result;
  const origin = normalizePrivateOrigin(options.origin);
  if (!origin || !result.gatewayPort) return { ...result, code: 'invalid-options' };
  result.origin = origin.origin;
  const discover = dependencies.findInstalledCli || findInstalledCli;
  const run = dependencies.runReadOnly || runReadOnly;
  let file;
  try { file = await discover(); } catch (_) { return { ...result, code: 'client-unavailable' }; }
  if (!file) return { ...result, code: 'not-installed' };
  result.installed = true;
  let version;
  try { version = versionOf(await run(file, [...READ_COMMANDS[0]])); } catch (_) { return { ...result, code: 'client-unavailable' }; }
  if (!version) return { ...result, code: 'invalid-client-version' };
  result.version = version.text;
  if (version.major !== 1 || version.minor < 52) return { ...result, code: 'unsupported-client-version' };
  let status;
  try { status = parseBoundedJson(await run(file, [...READ_COMMANDS[1]])); } catch (_) { return { ...result, code: 'daemon-unavailable' }; }
  if (status.BackendState === 'NeedsLogin' || status.BackendState === 'NeedsMachineAuth') return { ...result, code: 'needs-login' };
  if (status.BackendState !== 'Running' || !record(status.Self) || status.Self.Online !== true || status.Self.Expired === true) return { ...result, code: 'not-connected' };
  result.connected = true;
  // Only the exact self DNS name may be used. Peer/identity/IP/key fields are
  // never projected into the status result.
  if (status.Self.DNSName !== origin.hostname + '.' && status.Self.DNSName !== origin.hostname) return { ...result, code: 'origin-mismatch' };
  if (!record(status.CurrentTailnet) || status.CurrentTailnet.MagicDNSEnabled !== true || !Array.isArray(status.CertDomains) || !status.CertDomains.includes(origin.hostname)) return { ...result, code: 'https-not-enabled' };
  let serve;
  try { serve = parseBoundedJson(await run(file, [...READ_COMMANDS[2]])); } catch (_) { return { ...result, code: 'serve-status-unavailable' }; }
  return { ...result, ...inspectServeConfig(serve, options) };
}

module.exports = { LIMITS, READ_COMMANDS, normalizePrivateOrigin, gatewayPortOf, inspectServeConfig, readStatus };
