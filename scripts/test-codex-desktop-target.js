'use strict';
const assert = require('node:assert/strict');
const target = require('./codex-desktop-target.js');
const now = Date.parse('2026-10-01T12:00:00.000Z');
const request = { requestId: 'relay-request-1', threadId: '01a0f60e-881d-7ed0-8cfe-a5c356738b45', cwd: 'D:\\桥\\Project', text: 'Run the next harmless task.\nKeep this exact line.' };
const desktop = { exe: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_current\\app\\ChatGPT.exe', pid: 13628,
  processStartedAt: '2026-10-01T11:00:00.000Z', hwnd: '0x000a', windowPid: 13628, cwd: request.cwd };
const evidence = { ...desktop, actualCwd: request.cwd, observedAt: now, processAlive: true, windowExists: true, verifiedThreadId: request.threadId };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function denied(code, fn) { assert.throws(fn, error => error instanceof target.DesktopTargetError && error.code === code); }
function preflight(change = {}) { return target.preflightDesktopTarget(request, desktop, { ...evidence, ...change }, { now }); }

check('Windows project and executable case, slash style and realpath prefixes preserve identity', () => {
  assert.equal(preflight({ exe: desktop.exe.toLowerCase().replace(/\\/g, '/'), actualCwd: '\\\\?\\d:\\桥\\project\\', hwnd: '10' }).ok, true);
  assert.equal(target.sameWindowsPath('D:\\桥\\Project\\child\\..', request.cwd), true);
  assert.equal(target.sameWindowsPath('\\\\?\\UNC\\host\\share\\Project', '\\\\HOST\\SHARE\\project\\'), true);
});
check('another conversation with the same title is rejected', () => {
  denied('wrong-conversation', () => preflight({ verifiedThreadId: 'another-thread', title: 'Same title' }));
  denied('wrong-conversation', () => preflight({ verifiedThreadId: undefined, title: 'Same title' }));
});
check('sibling project, directory junction target and drive-relative paths cannot select another project', () => {
  denied('wrong-project', () => preflight({ actualCwd: request.cwd + '-other' }));
  denied('wrong-project', () => preflight({ actualCwd: 'D:\\another-junction-target' }));
  denied('invalid-path', () => target.validateDesktopRequest({ ...request, cwd: 'D:Project' }));
  denied('invalid-path', () => target.validateDesktopRequest({ ...request, cwd: '\\Project' }));
  denied('invalid-path', () => target.validateDesktopRequest({ ...request, cwd: request.cwd + ':stream' }));
  denied('invalid-path', () => target.validateDesktopRequest({ ...request, cwd: '\\\\.\\C:\\Project' }));
  denied('invalid-path', () => target.validateDesktopRequest({ ...request, cwd: '\\\\host\\share:stream\\Project' }));
});
check('reused PID, replaced window and changed executable are rejected', () => {
  denied('desktop-identity-changed', () => preflight({ processStartedAt: '2026-10-01T11:59:59.000Z' }));
  denied('desktop-identity-changed', () => preflight({ hwnd: '11' }));
  denied('desktop-identity-changed', () => preflight({ exe: 'D:\\other-app\\ChatGPT.exe' }));
  denied('window-process-mismatch', () => preflight({ windowPid: 9000 }));
  denied('wrong-application', () => preflight({ exe: 'D:\\codex.exe' }));
});
check('disappeared process/window and stale or future evidence cannot authorize sending', () => {
  denied('desktop-unavailable', () => preflight({ processAlive: false }));
  denied('desktop-unavailable', () => preflight({ windowExists: false }));
  denied('stale-preflight', () => preflight({ observedAt: now - 5001 }));
  denied('stale-preflight', () => preflight({ observedAt: now + 1 }));
});
check('a same-content transport retry returns the existing ambiguous receipt rather than preparing a second send', () => {
  const previous = target.makeDesktopReceipt(request, 'unknown', { at: now });
  const retry = target.checkDuplicateRequest({ ...request, cwd: request.cwd.toLowerCase() + '\\' }, previous);
  assert.equal(retry.duplicate, true); assert.equal(retry.receipt, previous);
  denied('request-id-conflict', () => target.checkDuplicateRequest({ ...request, text: 'Another prompt' }, previous));
  denied('request-id-conflict', () => target.checkDuplicateRequest({ ...request, threadId: 'another-thread' }, previous));
  denied('request-id-conflict', () => target.checkDuplicateRequest({ ...request, cwd: 'D:\\another-project' }, previous));
});
check('GUI submission and an empty composer never establish delivery or model completion', () => {
  const sent = target.makeDesktopReceipt(request, 'submitted', { at: now });
  assert.equal(sent.deliveryConfirmed, false); assert.equal(sent.executionConfirmed, false);
  denied('invalid-delivery-proof', () => target.makeDesktopReceipt(request, 'accepted', { at: now, composerEmpty: true }));
  denied('unconfirmed-delivery', () => target.makeDesktopReceipt(request, 'accepted', { at: now, proof: { threadId: 'wrong-thread', messageText: request.text, newUserMessage: true } }));
  const proof = { threadId: request.threadId, messageText: request.text, newUserMessage: true, turnId: 'actual-turn', turnStatus: 'inProgress' };
  const accepted = target.makeDesktopReceipt(request, 'accepted', { at: now, proof });
  assert.equal(accepted.deliveryConfirmed, true); assert.equal(accepted.executionConfirmed, false);
  denied('unconfirmed-task-state', () => target.makeDesktopReceipt(request, 'completed', { at: now, proof }));
});
check('text-only requests preserve multiline content and reject silently dropped attachments', () => {
  assert.equal(target.validateDesktopRequest(request).text, request.text);
  denied('unsupported-request', () => target.validateDesktopRequest({ ...request, attachments: [] }));
  denied('invalid-text', () => target.validateDesktopRequest({ ...request, text: ' ' }));
  denied('invalid-text', () => target.validateDesktopRequest({ ...request, text: '中'.repeat(22000) }));
});
console.log(`${checks} desktop target contract checks passed`);
