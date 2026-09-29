'use strict';
// Safe opt-in regression against the running DSH frontend. Only fetches static
// HTML / plugin JavaScript; executes compiled session readiness code in a VM.
// No WebSocket is opened and no real project/session/task is selected or changed.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
if (!argv.includes('--live-frontend')) {
  console.log('SKIP: static DSH frontend probe requires --live-frontend (no live task actions).');
  process.exit(0);
}
function option(name, fallback) {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
}
const port = Number(option('--port', '19387'));
const runtime = option('--runtime', 'D:/Pocket Bridge');
const cookie = JSON.parse(fs.readFileSync(path.join(runtime, 'logs', 'mint-cookie.json'), 'utf8'));
function getStatic(asset) {
  assert(asset === '/' || asset.startsWith('/plugins/'), 'static assets only');
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: asset,
      headers: { Host: cookie.authority, Cookie: cookie.cookieName + '=' + cookie.cookieValue } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error('Static HTTP ' + res.statusCode)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Static asset timeout')));
    req.on('error', reject);
  });
}
function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, 'compiled frontend contains ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, 'compiled frontend boundary exists');
  return source.slice(start, end).trim();
}
function context(compat, missing) {
  const ctx = vm.createContext({ AbortController, AbortSignal, DOMException, setTimeout, clearTimeout });
  if (missing) vm.runInContext('delete Promise.withResolvers', ctx);
  vm.runInContext(compat, ctx, { filename: 'compat.js' });
  return ctx;
}

(async () => {
  const html = await getStatic('/');
  const paths = [...html.matchAll(/<link[^>]+href="(plugins[^\"]+)/g)]
    .map(m => '/' + m[1].replaceAll('&amp;', '&'));
  assert(paths.length > 0, 'DSH preloads compiled plugins');
  let compiled = '';
  for (const asset of paths) {
    const candidate = await getStatic(asset);
    if (candidate.includes('var ClientSessionReference = class')) compiled = candidate;
  }
  assert(compiled, 'session-controller compiled plugin found');
  const wait = between(compiled, 'async function waitForOpen(opening, signal)', 'var ClientSessionReference = class');
  const reference = between(compiled, 'var ClientSessionReference = class', '/** Host catalog and local reference allocator');
  const legacyCompat = fs.readFileSync(path.join(runtime, 'pwa', 'compat.js'), 'utf8');
  const patchedCompat = fs.readFileSync(path.join(root, 'pwa', 'compat.js'), 'utf8');
  let passed = 0;
  const check = (title, condition) => { assert(condition, title); passed++; console.log('PASS: ' + title); };
  for (const scenario of [
    { name: 'native', compat: legacyCompat, missing: false, succeeds: true },
    { name: 'legacy browser without compatibility', compat: '', missing: true, succeeds: false },
    { name: 'legacy browser + installed compatibility', compat: legacyCompat, missing: true, succeeds: vm.runInContext('typeof Promise.withResolvers === '+JSON.stringify('function'), context(legacyCompat, true)) },
    { name: 'legacy browser + repaired compatibility', compat: patchedCompat, missing: true, succeeds: true }
  ]) {
    const ctx = context(scenario.compat, scenario.missing);
    vm.runInContext(wait + '\n' + reference + '\nglobalThis.Reference = ClientSessionReference;', ctx);
    if (!scenario.succeeds) {
      const failure = vm.runInContext(`(() => { try { new Reference('fixture', { live: true, binding: {} }, () => {}); return null; } catch (error) { return error.message; } })()`, ctx);
      check(scenario.name + ' reproduces failed session initialization', /withResolvers/.test(failure || ''));
      const waitFailure = await vm.runInContext(`waitForOpen(Promise.resolve(), new AbortController().signal).then(() => null, error => error.message)`, ctx);
      check(scenario.name + ' reproduces failed workspace-opening wait', /withResolvers/.test(waitFailure || ''));
      continue;
    }
    vm.runInContext(`globalThis.binding = { state: 'ready' }; globalThis.reference = new Reference('fixture', { live: true, binding }, () => {}); reference.attachOpening(Promise.resolve(), new AbortController().signal);`, ctx);
    const ready = await vm.runInContext('reference.ready.then(value => value === binding)', ctx);
    check(scenario.name + ' completes actual compiled session readiness', ready);
    const opening = await vm.runInContext(`waitForOpen(Promise.resolve(), new AbortController().signal).then(() => true)`, ctx);
    check(scenario.name + ' completes actual compiled workspace-opening wait', opening);
    vm.runInContext(`globalThis.cancel = new AbortController(); globalThis.cancelled = waitForOpen(new Promise(() => {}), cancel.signal).then(() => false, error => error === cancel.signal.reason); cancel.abort(new Error('fixture abort'));`, ctx);
    check(scenario.name + ' preserves cancelled-opening semantics', await vm.runInContext('cancelled', ctx));
  }
  console.log('Compiled DSH browser compatibility regression: ' + passed + ' passed. Static assets only; no task actions.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
