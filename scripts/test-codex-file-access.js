'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const access = require('./codex-file-access.js');

const base = path.resolve(__dirname, '..', 'logs');
fs.mkdirSync(base, { recursive: true });
const temporary = fs.mkdtempSync(path.join(base, 'codex-file-acl-'));
let checks = 0, skipped = 0;
const project = path.join(temporary, 'project');
const sibling = path.join(temporary, 'sibling');
const home = path.join(temporary, 'codex-home');
const uploads = path.join(temporary, 'bridge', 'uploads', 'codex');
const logs = path.join(temporary, 'bridge', 'logs');
const config = path.join(temporary, 'bridge', 'config.json');
for (const directory of [project, sibling, uploads, logs, home,
  path.join(home, 'generated_images'), path.join(home, 'visualizations')]) fs.mkdirSync(directory, { recursive: true });
const options = { projectRoots: [project], uploadRoot: uploads, codexHomes: [home],
  extraRoots: [], forbiddenRoots: [logs], forbiddenFiles: [config] };
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'harmless filesystem test fixture'); return file; };
function check(name, test) { test(); checks++; console.log('PASS ' + name); }
function denied(file, override) { assert.equal(access.checkPath(file, override || options), null, file); }
function allowed(file, override) {
  const result = access.checkPath(file, override || options);
  assert.ok(result, file); assert.equal(result.realPath, fs.realpathSync(file));
}
function linkTest(name, create, test) {
  try { create(); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    skipped++; console.log('SKIP ' + name + ' (' + error.code + ')'); return;
  }
  check(name, test);
}

try {
  const report = write(path.join(project, 'Reports', 'result.txt'));
  check('real current project file is accessible', () => allowed(report));
  check('real uploaded file is accessible', () => allowed(write(path.join(uploads, 'upload-id', 'phone.txt'))));
  check('only known generated artifact folders are accessible in Codex home', () => {
    allowed(write(path.join(home, 'generated_images', 'image.png')));
    allowed(write(path.join(home, 'visualizations', 'chart.html')));
    denied(write(path.join(home, 'sessions', 'history.jsonl')));
    denied(write(path.join(home, 'browser', 'state.json')));
  });
  check('project parents and sibling folders are not implicitly authorized', () => {
    denied(write(path.join(temporary, 'parent.txt')));
    denied(write(path.join(sibling, 'separate.txt')));
    assert.ok(!access.allowedRoots(options).includes(temporary));
  });
  check('an explicitly configured sibling project is accessible without authorizing its parent', () => {
    allowed(path.join(sibling, 'separate.txt'), { ...options, extraRoots: [sibling] });
    denied(path.join(temporary, 'parent.txt'), { ...options, extraRoots: [sibling] });
  });
  check('credentials stay denied even when the enclosing project is registered', () => {
    const broadProject = { ...options, projectRoots: [temporary] };
    for (const file of ['auth.json', 'config.toml', 'cache/private-state.json']) denied(write(path.join(home, file)), broadProject);
    denied(write(config), broadProject);
    denied(write(path.join(logs, 'ordinary-name.json')), broadProject);
  });
  check('secret filenames remain denied inside legitimate projects and uploads', () => {
    for (const name of ['auth.json', '.env', '.env.local', 'production.env', '.credentials.yaml',
      'credentials.json', '.npmrc', '.netrc', 'access-key.txt', 'api_key.json', 'e2ee-secret.txt',
      'private-key.pem', 'id_ed25519', 'signing.key', 'client.pfx', 'vapid.json']) {
      denied(write(path.join(project, name))); denied(write(path.join(uploads, name)));
    }
    denied(write(path.join(project, '.git', 'config')));
    allowed(write(path.join(project, 'source', 'config.json')));
  });
  check('missing legitimate file stays within the project, while traversal is denied', () => {
    assert.ok(access.checkPath(path.join(project, 'Reports', 'missing.txt'), options));
    denied(path.resolve(project, '..', 'parent.txt'));
    denied('relative.txt'); denied(''); denied(path.join(project, 'bad\0name'));
    assert.ok(!access.allowedRoots({ ...options, extraRoots: [path.parse(project).root] }).includes(path.parse(project).root));
  });

  const outside = write(path.join(sibling, 'plain.txt'));
  const junction = path.join(project, 'linked-directory');
  linkTest('real directory link cannot escape to an unregistered sibling',
    () => fs.symlinkSync(sibling, junction, process.platform === 'win32' ? 'junction' : 'dir'), () => {
      denied(path.join(junction, 'plain.txt'));
      denied(path.join(junction, 'does-not-exist.txt'));
    });
  const adopted = path.join(temporary, 'adopted-root');
  linkTest('a directory link supplied as a root cannot silently adopt its outside target',
    () => fs.symlinkSync(sibling, adopted, process.platform === 'win32' ? 'junction' : 'dir'),
    () => denied(path.join(adopted, 'plain.txt'), { ...options, extraRoots: [adopted] }));
  const privateAlias = path.join(temporary, 'private-home-alias');
  linkTest('a private Codex home configured through a junction remains private at its real path',
    () => fs.symlinkSync(home, privateAlias, process.platform === 'win32' ? 'junction' : 'dir'), () => {
      const aliasOptions = { ...options, codexHomes: [privateAlias], projectRoots: [temporary] };
      denied(path.join(home, 'cache', 'private-state.json'), aliasOptions);
    });
  const hardlink = path.join(project, 'harmless-alias.txt');
  linkTest('real hard link cannot hide an outside file behind a project filename',
    () => fs.linkSync(outside, hardlink), () => {
      assert.ok(fs.statSync(hardlink).nlink > 1);
      denied(hardlink);
    });
  const fileLink = path.join(project, 'outside-file-link.txt');
  linkTest('real file symbolic link cannot escape the project',
    () => fs.symlinkSync(outside, fileLink, 'file'), () => denied(fileLink));
  if (process.platform === 'win32') {
    const main = write(path.join(project, 'stream.txt'));
    const stream = main + ':hidden'; fs.writeFileSync(stream, 'harmless alternate stream');
    check('real NTFS alternate stream is rejected', () => denied(stream));
  }
  console.log(`${checks} filesystem checks passed; ${skipped} link checks unavailable on this host`);
} finally {
  // Verify the exact generated target before a recursive Windows cleanup.
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('codex-file-acl-')) throw Error('Unsafe temporary cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
