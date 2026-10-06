'use strict';

// New installers and current regressions serve DeepSeek Harness only.
// Legacy source remains readable in old checkpoints; it is never packaged or
// selected for automatic execution by this release profile.
const LEGACY_TESTS = new Set(['test-release-lock.js', 'test-pagehide-lock-safety.js',
  'test-desktop-ui-action.js', 'test-desktop-lifecycle.js', 'test-file-e2ee.js']);
function isCurrentTest(name) {
  return !/^test-(?:codex|dot)(?:-|\.)/i.test(name) && !LEGACY_TESTS.has(name);
}
function isPayloadPath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => p === '..' || p === '.')) return false;
  if (/^scripts\/(?:codex-|dot-)/i.test(relative) || relative === 'scripts/desktop-ui-action.js') return false;
  if (/^scripts\/test-/.test(relative) && !isCurrentTest(relative.slice(8))) return false;
  if (/^pwa\/(?:codex|dot)(?:[.-]|$)/i.test(relative)) return false;
  if (['docs/CODEX_SESSION_CONTROL.md', 'docs/desktop-relay-experimental.md', 'docs/dot-inbox-plugin.example.json'].includes(relative)) return false;
  return true;
}
module.exports = { isCurrentTest, isPayloadPath };
