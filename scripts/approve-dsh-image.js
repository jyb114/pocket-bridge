#!/usr/bin/env node
'use strict';

// LOCAL CLI ONLY. No HTTP route calls this function or mints file approvals.
const fs = require('node:fs');
const path = require('node:path');
const { approveImage } = require('./dsh-lite-image-preview');
const { workspaceRootFor } = require('./dsh-lite-download');

function main(argv) {
  const accepted = new Set(['--base', '--session', '--file', '--dsh-home']);
  const values = Object.create(null); let approve = false, revoke = false;
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at];
    if (name === '--approve' || name === '--revoke') {
      if (name === '--approve') { if (approve) throw Error('invalid-options'); approve = true; }
      else { if (revoke) throw Error('invalid-options'); revoke = true; }
    } else {
      if (!accepted.has(name) || Object.hasOwn(values, name) || !argv[at + 1] || argv[at + 1].startsWith('--')) throw Error('invalid-options');
      values[name] = argv[++at];
    }
  }
  if (approve === revoke || !values['--base'] || !values['--session'] || !values['--file'] || !path.isAbsolute(values['--base']) || !path.isAbsolute(values['--file'])) throw Error('explicit-local-approval-required');
  const base = fs.realpathSync(values['--base']), logDir = path.join(base, 'logs');
  const record = JSON.parse(fs.readFileSync(path.join(logDir, 'instance.json'), 'utf8'));
  const homes = values['--dsh-home'] ? [fs.realpathSync(values['--dsh-home'])] : undefined;
  const result = approveImage({ instanceId: record.instanceId, logDir, sessionId: values['--session'], filePath: values['--file'], revoke,
    workspaceRootFor: sessionId => workspaceRootFor(sessionId, homes ? { homes } : {}) });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  return result;
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: /^[a-z][a-z0-9-]{0,80}$/.test(error.code || '') ? error.code : 'local-image-approval-failed' }) + '\n'); process.exitCode = 1; }
}
module.exports = { main };
