'use strict';
// Meaningful metadata boundaries; no model, process, credentials or live RPC.
const assert = require('node:assert/strict');
const { buildFeatureCapabilities, FEATURES } = require('./dsh-feature-capabilities.js');
const runtime = require('./dsh-runtime.js'), adapter = require('./dsh-adapter.js');
let checks = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
function check(value, label) { assert.ok(value, label); checks++; }
function live(overrides = {}) { return { kind: 'cli', running: true, supported: true,
  profile: 'remote-mux', version: '0.1.7-rc.2', httpEvidence: 'dsh-auth-challenge', ...overrides }; }
function feature(input, name, context) { return buildFeatureCapabilities(input, context).features[name]; }

for (const input of [null, {}, { installed: true, version: '0.1.7-rc.2' },
  live({ running: false }), live({ running: 'true' }), live({ supported: false }),
  live({ httpEvidence: 'generic-html-200' }), live({ profile: 'unknown' })]) {
  const value = buildFeatureCapabilities(input);
  equal(value.recognizedProtocol, false, 'Version, installation or generic HTTP cannot certify a working protocol');
  equal(value.features.sendMessage.state, 'unverified', 'Unknown/offline evidence remains visible as unverified');
  check(Object.values(value.features).every(item => item.acceptance.status === 'not-run'), 'No disconnected record acquires a workflow pass');
}
const modern = buildFeatureCapabilities(live());
equal(Object.keys(modern.features), FEATURES, 'Stable documented feature keys');
check(Object.values(modern.features).every(item => item.state === 'supported'), 'Recognized implemented modern adapter interfaces are available');
check(Object.values(modern.features).every(item => item.acceptance.status === 'not-run' && item.acceptance.tree === null && item.acceptance.deviceScope === null), 'Protocol recognition is explicitly not human acceptance');
equal(modern.features.sendMessage.acceptance.distribution, 'cli', 'CLI distribution remains distinct from desktop');
equal(feature(live({ kind: 'desktop' }), 'sendMessage').acceptance.distribution, 'desktop', 'Desktop distribution is independently labeled');
equal(feature(live({ version: '9.2.4-preview.3' }), 'history').state, 'supported', 'Observed implemented protocol takes priority over a version allowlist');
equal(modern.features.toolPresets.state, 'supported', 'The modern adapter implements agentPresets list/select');
equal(modern.features.toolPresets.acceptance.status, 'not-run', 'Tool preset interface coverage is not a successful selection workflow');
const fromVersionOnly = adapter.createRuntimeRecord({ kind: 'cli', version: '0.2.0-rc.2', port: 19001 });
equal(adapter.buildFeatureCapabilities(fromVersionOnly).features.history.state, 'unverified', 'An adapter version classification is not running HTTP proof');

const legacy = live({ profile: 'legacy-events', version: '0.1.0-rc.8', httpEvidence: 'dsh-app-html' });
for (const name of ['projects', 'sessions', 'history', 'sendMessage', 'imageUpload', 'questions', 'approvals', 'modelSelection', 'toolPresets', 'reasoning']) {
  equal(feature(legacy, name).state, 'supported', 'Implemented legacy interface remains offered: ' + name);
}
for (const name of ['fileUpload', 'permissions', 'planMode', 'goals', 'queue', 'officialImageRead']) {
  equal(feature(legacy, name).state, 'unsupported', 'An absent legacy Bridge interface is not promised: ' + name);
}
const blocked = buildFeatureCapabilities(legacy, { credentialState: 'missing' });
equal(blocked.features.sendMessage.state, 'supported', 'Missing credentials do not erase implemented transport');
equal(blocked.features.sendMessage.acceptance.status, 'blocked-credentials', 'Model workflow is honestly credential-blocked');
equal(blocked.features.questions.acceptance.status, 'blocked-credentials', 'Model-triggered question lacks completed acceptance without credentials');
equal(blocked.features.reasoning.state, 'supported', 'Legacy reasoning rendering and advertised effort selection are implemented');
equal(blocked.features.reasoning.acceptance.status, 'blocked-credentials', 'Implemented reasoning is not a model acceptance pass without credentials');
equal(blocked.features.history.acceptance.status, 'not-run', 'Read history is independent of model credentials');
equal(blocked.features.fileUpload.acceptance.status, 'not-run', 'A missing adapter feature is not mislabeled as an auth problem');
equal(feature(legacy, 'sendMessage', { credentialState: 'available' }).acceptance.status, 'not-run', 'Available credential format is still not a model response');

const ipc = buildFeatureCapabilities({ kind: 'desktop', profile: 'desktop-ipc', version: '0.1.5-rc.3', running: true });
check(Object.values(ipc.features).every(item => item.state === 'unsupported'), 'IPC does not pretend to expose a Web transport');
equal(feature(legacy, 'fileUpload', { acceptance: { status: 'passed' } }).state, 'unsupported', 'Evidence cannot enable an unimplemented endpoint');
const observed = live({ featureObservations: { modelSelection: { interface: 'absent', basis: 'read-only-interface' } } });
equal(feature(observed, 'modelSelection').state, 'unsupported', 'Exact read-only interface absence can refine supported adapter coverage');
equal(feature(observed, 'history').state, 'supported', 'One missing feature does not disable unrelated interfaces');
equal(feature(live({ featureObservations: { modelSelection: { interface: 'absent', basis: 'transport-error' } } }), 'modelSelection').state, 'supported', 'Timeout/auth errors cannot declare the interface absent');
equal(feature({ ...legacy, featureObservations: { fileUpload: { interface: 'present', basis: 'read-only-interface' } } }, 'fileUpload').state, 'unsupported', 'A native hint cannot invent unimplemented legacy support');
equal(feature({ ...live({ profile: 'unknown' }), featureObservations: { history: { interface: 'present', basis: 'read-only-interface' } } }, 'history').state, 'unverified', 'A feature hint cannot identify an unknown protocol');

const malicious = live({ executablePath: 'PRIVATE_PATH', commandLine: '--token=PRIVATE_SECRET',
  version: '0.1.7-rc.2\nPRIVATE_SECRET', sourceTree: 'a'.repeat(40),
  acceptance: { status: 'passed', tree: 'b'.repeat(40), deviceScope: 'physical-phone' },
  featureObservations: { history: { interface: 'present', basis: 'read-only-interface', url: 'PRIVATE_URL', reason: 'PRIVATE_SECRET' } } });
const safe = buildFeatureCapabilities(malicious, { workflowEvidence: { status: 'passed' }, credential: 'PRIVATE_SECRET' });
check(!/PRIVATE_|physical-phone|a{40}|b{40}/.test(JSON.stringify(safe)), 'No secrets, paths, old trees or untrusted pass flags leak into the API');
equal(safe.features.history.acceptance.version, null, 'Untrusted version strings cannot become diagnostics');
check(Object.values(safe.features).every(item => item.acceptance.status === 'not-run'), 'Neither caller nor runtime can promote stale fixture evidence to a live pass');
const serialized = runtime.serializeRuntime(live());
equal(serialized.featureCapabilities, modern, 'Actual public runtime serializer exposes the same advisory contract');
equal(runtime.serializeRuntime(legacy, { credentialState: 'missing' }).featureCapabilities.features.sendMessage.acceptance.status, 'blocked-credentials', 'Serializer context remains separate from protocol support');
equal(adapter.buildFeatureCapabilities(live()), modern, 'Adapter and runtime exports use one definition');
equal(runtime.serializeRuntime(null), null, 'Absent runtime serialization stays compatible');
console.log('DSH feature capability boundaries passed: ' + checks);
