'use strict';

// Exercise the gateway's actual relative-path resolver against real files.
// A session authorizes its own project, never every sibling under its parent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source.js');
const codexFileAccess = require('./codex-file-access.js');
const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const tempParent = path.join(BASE, 'logs');
fs.mkdirSync(tempParent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(tempParent, 'codex-file-path-'));
const session = path.join(temporary, 'project');
const other = path.join(temporary, 'other-project');
const bridge = path.join(temporary, 'bridge');
const home = path.join(temporary, 'home');
const codexHome = path.join(home, '.codex');
let checks = 0;
function write(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'harmless path test'); return file; }
function check(name, test) { test(); checks++; console.log('PASS ' + name); }
function fixture(roots, extras = []) {
  const box = {
    path, fs, console, codexFileAccess, BASE: bridge, LOG_DIR: path.join(bridge, 'logs'),
    os: { homedir: () => home }, process: { env: { CODEX_HOME: codexHome } },
    cfg: { CONFIG_FILE: path.join(bridge, 'config.json'), loadConfig: () => ({ fileRoots: extras }) },
    sessionWorkDirs: () => roots
  };
  vm.createContext(box);
  for (const name of ['codexFileAccessOptions', 'allowedRoots', 'resolveCodexFileAccess',
    'fileAllowed', 'pickExisting', 'allowedSubdirectories', 'fileExists', 'resolveRequestedPath']) {
    const source = extractFunction(SRC, name);
    assert.ok(source && source.length > 20, 'Missing gateway function ' + name);
    vm.runInContext(source, box);
  }
  return box;
}

try {
  const report = write(path.join(session, 'Reports', 'result.png'));
  const otherReport = write(path.join(other, 'Reports', 'other.png'));
  for (const directory of [path.join(bridge, 'uploads', 'codex'), path.join(bridge, 'logs'),
    path.join(codexHome, 'generated_images'), path.join(codexHome, 'visualizations')]) fs.mkdirSync(directory, { recursive: true });
  check('absolute current-project paths remain accessible', () => {
    const box = fixture([session]); assert.equal(box.resolveRequestedPath(report), report); assert.ok(box.fileAllowed(report));
  });
  check('relative paths resolve to the actual session project', () => {
    const box = fixture([session]); assert.equal(box.resolveRequestedPath('Reports/result.png'), report);
    assert.equal(box.fileAllowed(path.resolve('Reports/result.png')), false);
  });
  check('multiple registered projects resolve by real file existence', () => {
    const box = fixture([session, other]); assert.equal(box.resolveRequestedPath('Reports/result.png'), report);
    assert.equal(box.resolveRequestedPath('Reports/other.png'), otherReport);
  });
  check('project parents and unregistered siblings stay denied', () => {
    const box = fixture([session]); assert.equal(box.fileAllowed(otherReport), false);
    assert.equal(box.fileAllowed(write(path.join(temporary, 'parent.txt'))), false);
    assert.notEqual(box.resolveRequestedPath('Reports/other.png'), otherReport);
  });
  check('explicit local file roots authorize only the selected sibling', () => {
    const box = fixture([session], [other]); assert.equal(box.resolveRequestedPath('Reports/other.png'), otherReport);
    assert.ok(box.fileAllowed(otherReport)); assert.equal(box.fileAllowed(path.join(temporary, 'parent.txt')), false);
  });
  check('known artifacts and own uploads are roots, the entire Codex home is not', () => {
    const box = fixture([]); const roots = Array.from(box.allowedRoots());
    assert.ok(roots.includes(path.join(bridge, 'uploads', 'codex')));
    assert.ok(roots.includes(path.join(codexHome, 'generated_images')));
    assert.ok(roots.includes(path.join(codexHome, 'visualizations')));
    assert.equal(roots.includes(codexHome), false);
    assert.equal(box.fileAllowed(write(path.join(codexHome, 'auth.json'))), false);
  });
  check('missing legitimate files resolve inside allowed roots for a 404', () => {
    const box = fixture([session]); const missing = box.resolveRequestedPath('Reports/missing.png');
    assert.ok(path.isAbsolute(missing)); assert.ok(box.fileAllowed(missing)); assert.equal(fs.existsSync(missing), false);
  });
  check('relative traversal and sensitive project files stay denied', () => {
    const box = fixture([session]);
    assert.notEqual(box.resolveRequestedPath('../parent.txt'), path.join(temporary, 'parent.txt'));
    assert.equal(box.fileAllowed(path.join(temporary, 'parent.txt')), false);
    assert.equal(box.fileAllowed(box.resolveRequestedPath('../../../../../../outside.txt')), false);
    assert.equal(box.fileAllowed(box.resolveRequestedPath('auth.json')), false);
    assert.equal(box.fileAllowed(''), false);
  });
  check('one-level search remains confined to an explicitly registered project', () => {
    const nested = write(path.join(session, 'exports', 'nested-project', 'Reports', 'chart.png'));
    const box = fixture([path.join(session, 'exports')]);
    assert.equal(box.resolveRequestedPath('Reports/chart.png'), nested); assert.ok(box.fileAllowed(nested));
    assert.equal(box.fileAllowed(otherReport), false);
  });
  console.log(checks + ' actual-filesystem relative path groups passed');
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== tempParent || !path.basename(resolved).startsWith('codex-file-path-')) throw Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
