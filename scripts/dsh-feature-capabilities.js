'use strict';

// Advisory interface coverage only. This module performs no I/O, discovers no
// credentials and never authorizes an RPC or records a successful workflow.
// "supported" means this Bridge adapter implements the recognized protocol;
// it does not mean a model replied, a phone was tested, or every plugin exists.
const HTTP_EVIDENCE = new Set(['dsh-app-html', 'dsh-auth-challenge']);
const PROFILES = new Set(['remote-mux', 'legacy-events']);
const CORE = new Set(['projects', 'sessions', 'history', 'sendMessage', 'cancelSession',
  'workspaceFiles', 'fileDownload', 'imageUpload', 'questions', 'approvals', 'reasoning']);
const MODERN = new Set(['fileUpload', 'modelSelection', 'toolPresets', 'permissions',
  'planMode', 'goals', 'queue', 'officialImageRead']);
const LEGACY_SELECTION = new Set(['modelSelection', 'toolPresets']);
const FEATURES = Object.freeze([...CORE, ...MODERN]);
const MODEL_WORKFLOWS = new Set(['sendMessage', 'questions', 'approvals', 'reasoning']);
const OBSERVATION_REASONS = Object.freeze({ present: 'interface-observed', absent: 'interface-not-exposed' });

function versionLabel(value) {
  return typeof value === 'string' && value.length <= 100 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value) ? value : null;
}
function buildFeatureCapabilities(runtime, context = {}) {
  const value = runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? runtime : {};
  const profile = PROFILES.has(value.profile) ? value.profile : value.profile === 'desktop-ipc' ? 'desktop-ipc' : 'unsupported';
  const recognized = PROFILES.has(profile) && value.running === true && value.supported === true && HTTP_EVIDENCE.has(value.httpEvidence);
  const distribution = ['desktop', 'cli'].includes(value.kind) ? value.kind : 'unknown';
  const credentialsMissing = context && context.credentialState === 'missing';
  const features = {};
  for (const name of FEATURES) {
    let state = 'unverified', basis = 'none', reasonCode = 'protocol-not-confirmed';
    if (profile === 'desktop-ipc') {
      state = 'unsupported'; basis = 'adapter-interface'; reasonCode = 'desktop-ipc-no-web-interface';
    } else if (recognized) {
      if (CORE.has(name) || profile === 'remote-mux' || LEGACY_SELECTION.has(name)) {
        state = 'supported'; basis = 'recognized-adapter'; reasonCode = 'implemented-for-recognized-protocol';
      } else {
        state = 'unsupported'; basis = 'adapter-interface'; reasonCode = 'legacy-adapter-no-interface';
      }
      // Only an exact, read-only interface observation can refine the adapter
      // declaration. Authentication/timeout failures must not become "absent".
      const observation = value.featureObservations && value.featureObservations[name];
      if (state !== 'unsupported' && observation && observation.basis === 'read-only-interface' &&
          (observation.interface === 'present' || observation.interface === 'absent')) {
        state = observation.interface === 'present' ? 'supported' : 'unsupported';
        basis = 'read-only-interface'; reasonCode = OBSERVATION_REASONS[observation.interface];
      }
    } else if (PROFILES.has(profile) && value.running !== true) {
      reasonCode = 'runtime-not-running';
    }
    features[name] = {
      state, basis, reasonCode,
      acceptance: {
        status: state !== 'unsupported' && credentialsMissing && MODEL_WORKFLOWS.has(name) ? 'blocked-credentials' : 'not-run',
        distribution, version: versionLabel(value.version), tree: null, deviceScope: null
      }
    };
  }
  return { schemaVersion: 1, profile, recognizedProtocol: recognized,
    supportDefinition: 'implemented-interface-not-workflow-acceptance', features };
}

module.exports = { buildFeatureCapabilities, FEATURES };
