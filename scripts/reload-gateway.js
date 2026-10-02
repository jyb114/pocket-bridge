'use strict';
// Scoped local admission only. The verified gateway owns drain and restart;
// this helper never signals/kills a process or launches another helper.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const MAX_RESPONSE_BYTES = 16 * 1024;
const CODES = new Set(['invalid-reload-request', 'instance-unavailable', 'gateway-unverified',
  'gateway-identity-mismatch', 'restart-not-scheduled', 'transport-failed', 'transport-timeout',
  'gateway-response-too-large', 'invalid-gateway-response']);
const fail = code => Object.assign(new Error(code), { code });
function uuid(value) { return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function readOwnIdentity(base) {
  const file = path.join(base, 'logs', 'instance.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RESPONSE_BYTES) throw fail('instance-unavailable');
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_RESPONSE_BYTES) throw fail('instance-unavailable');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!uuid(value?.instanceId)) throw fail('instance-unavailable');
    return { instanceId: value.instanceId };
  } catch (_) { throw fail('instance-unavailable'); }
}
function boundedHttpRequest({ method, port, pathname, body, headers, signal }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers, signal }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          // Reject with the sanitized reason before destroying transport. Do
          // not inject our error into a socket that may just have been freed
          // by Node's HTTP agent, where it would become an unhandled event.
          reject(fail('gateway-response-too-large')); request.destroy(); return;
        }
        chunks.push(chunk);
      });
      response.on('aborted', () => reject(fail('transport-failed')));
      response.on('error', () => reject(fail('transport-failed')));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', cause => reject(fail(CODES.has(cause?.code) ? cause.code : 'transport-failed')));
    if (body) request.write(body);
    request.end();
  });
}
function parseResponse(response) {
  if (!response || !Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599 ||
      !Buffer.isBuffer(response.body) && typeof response.body !== 'string') throw fail('invalid-gateway-response');
  const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, 'utf8');
  if (bytes.length > MAX_RESPONSE_BYTES) throw fail('gateway-response-too-large');
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid');
    return { statusCode: response.statusCode, body };
  } catch (_) { throw fail('invalid-gateway-response'); }
}
async function requestScopedGatewayRestart(options = {}) {
  const { base = path.resolve(__dirname, '..'), expectedPid, port = 8080,
    request = boundedHttpRequest, readIdentity = readOwnIdentity, timeoutMs = 5000 } = options;
  if (Object.keys(options).some(key => !['base', 'expectedPid', 'port', 'request', 'readIdentity', 'timeoutMs'].includes(key)) ||
      typeof base !== 'string' || !path.isAbsolute(base) || !Number.isSafeInteger(expectedPid) || expectedPid < 1 || expectedPid > 0xffffffff ||
      !Number.isInteger(port) || port < 1 || port > 65535 || typeof request !== 'function' || typeof readIdentity !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('invalid-reload-request');
  let identity;
  try { identity = readIdentity(base); } catch (_) { throw fail('instance-unavailable'); }
  if (!uuid(identity?.instanceId)) throw fail('instance-unavailable');
  const origin = `http://127.0.0.1:${port}`;
  async function call(method, pathname, json) {
    const bytes = json ? Buffer.from(JSON.stringify(json), 'utf8') : null;
    const controller = new AbortController(); let timer;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => request({ method, port, pathname, body: bytes, signal: controller.signal,
          headers: { host: `127.0.0.1:${port}`, origin, accept: 'application/json',
            ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) } })),
        new Promise((_, reject) => { timer = setTimeout(() => { const error = fail('transport-timeout'); controller.abort(error); reject(error); }, timeoutMs); })
      ]);
      return parseResponse(response);
    } catch (cause) { throw fail(CODES.has(cause?.code) ? cause.code : 'transport-failed'); }
    finally { clearTimeout(timer); }
  }
  const health = await call('GET', '/__health');
  if (health.statusCode !== 200 || health.body.service !== 'pocket-bridge-gateway' ||
      !uuid(health.body.bootId) || !uuid(health.body.instanceId) || !Number.isSafeInteger(health.body.pid) ||
      health.body.pid < 1 || health.body.port !== port) throw fail('gateway-unverified');
  if (health.body.pid !== expectedPid || health.body.instanceId !== identity.instanceId) throw fail('gateway-identity-mismatch');
  const action = await call('POST', '/__console/action', { action: 'restart-gateway',
    expectedBootId: health.body.bootId, expectedInstanceId: identity.instanceId, expectedPid });
  const state = action.body.shutdown;
  if (action.statusCode !== 202 || action.body.ok !== true || action.body.restarting !== true || action.body.restartScheduled !== true ||
      action.body.bootId !== health.body.bootId || action.body.restartBootId !== health.body.bootId ||
      action.body.instanceId !== identity.instanceId || action.body.pid !== expectedPid || !state ||
      !['draining', 'restarting'].includes(state.phase) || state.kind !== 'restart' || state.code !== null ||
      action.body.restartState?.phase !== state.phase || action.body.restartState?.kind !== state.kind || action.body.restartState?.code !== state.code) throw fail('restart-not-scheduled');
  return Object.freeze({ scheduled: true, completed: false });
}
async function main(argv = process.argv.slice(2), output = console) {
  try {
    if (argv.length < 1 || argv.length > 2 || !/^[1-9][0-9]{0,9}$/.test(argv[0]) ||
        argv[1] !== undefined && !/^[1-9][0-9]{0,4}$/.test(argv[1])) throw fail('invalid-reload-request');
    await requestScopedGatewayRestart({ expectedPid: Number(argv[0]), port: argv[1] === undefined ? 8080 : Number(argv[1]) });
    output.log('Gateway restart scheduled. Completion has not been confirmed.');
    return 0;
  } catch (cause) {
    output.error(`Gateway restart was not scheduled (${CODES.has(cause?.code) ? cause.code : 'transport-failed'}).`);
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { requestScopedGatewayRestart, boundedHttpRequest, readOwnIdentity, MAX_RESPONSE_BYTES, main };
