'use strict';

const MIN_NODE_MAJOR = 24;

function isSupportedRuntime(version = process.versions.node, hasWebSocket = typeof globalThis.WebSocket === 'function') {
  const major = Number(String(version).split('.')[0]);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR && hasWebSocket === true;
}

function assertSupportedRuntime() {
  if (isSupportedRuntime()) return;
  throw new Error(`Pocket Bridge requires Node.js ${MIN_NODE_MAJOR} or newer with WebSocket support. `
    + `Current version: ${process.version}. The Windows installer includes a compatible runtime.`);
}

if (require.main === module) {
  try { assertSupportedRuntime(); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { MIN_NODE_MAJOR, isSupportedRuntime, assertSupportedRuntime };
