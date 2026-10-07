'use strict';

// Actual publication PowerShell, owned files and inert node/git/gh functions.
// The package builder has a separate real npm-pack test. No installer, network,
// Git mutation, credential or public release is invoked by this regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-preview.yml'), 'utf8');
const blocks = workflow.replace(/\r\n/g, '\n').split(/\n(?=      - (?:name|uses):)/);
const steps = new Map(blocks.flatMap(block => {
  const name = /^      - name: (.+)$/m.exec(block)?.[1];
  if (!name) return [];
  const multiline = /        run: \|\n([\s\S]*)$/.exec(block);
  const run = multiline ? multiline[1].split('\n').map(line => {
    assert(!line || line.startsWith('          '), 'unexpected YAML run indentation');
    return line.slice(10);
  }).join('\n').trimEnd() : /        run: (.+)$/m.exec(block)?.[1];
  return [[name, { block, run }]];
}));
function step(name) { assert(steps.has(name), 'Missing step: ' + name); return steps.get(name); }
const gateFirst = step('Require independent push CI for this exact commit');
const isolated = step('Run isolated CI before packaging');
const installer = step('Build and smoke-test installer');
const plugin = step('Build and verify DSH plugin');
const checksums = step('Package source and checksums');
const gateLast = step('Reconfirm the same independent CI run before publication');
const publish = step('Create public preview release');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let passed = 0;
async function check(label, run) { await run(); passed++; console.log('OK ' + label); }

// Deterministic API metadata executes the preexisting JavaScript CI gate too.
const gateSource = /@'\n([\s\S]*?)\n'@/.exec(gateFirst.run)?.[1];
assert(gateSource);
const proof = new Map(), repository = 'fixture/pocket-bridge', sha = '1'.repeat(40), now = Date.now();
function runMetadata(id, workflowId, workflowPath, fields = {}) {
  return { id, workflow_id: workflowId, run_attempt: 1, path: workflowPath, head_sha: sha,
    head_branch: 'main', event: 'push', repository: { full_name: repository },
    head_repository: { full_name: repository }, created_at: new Date(now).toISOString(),
    status: 'completed', conclusion: 'success', ...fields };
}
async function gate(mode = 'success', recheck = false) {
  const proc = { env: { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '900', GITHUB_EVENT_NAME: 'push', RUNNER_TEMP: 'fixture-temp' },
    argv: ['node', 'gate.js', ...(recheck ? ['recheck'] : [])], exitCode: 0 };
  const publication = runMetadata(900, 40, '.github/workflows/publish-preview.yml');
  const run = runMetadata(901, 41, '.github/workflows/ci.yml',
    mode === 'failed' ? { conclusion: 'failure' } :
    mode === 'other-commit' ? { head_sha: '2'.repeat(40) } :
    mode === 'old-result' ? { created_at: new Date(now - 6 * 60 * 1000).toISOString() } :
    mode === 'rerun' ? { run_attempt: 2 } : {});
  const ci = { id: mode === 'same-workflow' ? 40 : 41, path: '.github/workflows/ci.yml', name: 'CI', state: 'active' };
  const api = (command, args) => {
    assert.equal(command, 'gh');
    const endpoint = args.find(value => typeof value === 'string' && value.startsWith('repos/'));
    const fixtures = {
      ['repos/' + repository + '/actions/runs/900']: publication,
      ['repos/' + repository + '/actions/workflows/ci.yml']: ci,
      ['repos/' + repository + '/actions/workflows/41/runs']: { total_count: 1, workflow_runs: [run] },
      ['repos/' + repository + '/actions/runs/901']: run,
    };
    assert(Object.hasOwn(fixtures, endpoint)); return JSON.stringify(fixtures[endpoint]);
  };
  vm.runInNewContext(gateSource, { process: proc, console: { log() {}, error() {} }, Date, Number, JSON,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return { execFileSync: api };
      if (name === 'node:fs') return {
        writeFileSync(file, bytes, options) { assert.equal(options.flag, 'wx'); assert(!proof.has(file)); proof.set(file, bytes); },
        readFileSync(file) { assert(proof.has(file)); return proof.get(file); },
      };
      throw new Error('Unexpected fixture import');
    }, setTimeout() { throw new Error('Completed fixtures must never enter a waiting loop'); },
  }, { timeout: 2000 });
  await new Promise(resolve => setImmediate(resolve));
  return proc.exitCode;
}

const tempBase = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempBase, 'pb-plugin-release-test-'));
const version = '1.0.0-preview.13', archiveName = 'pocket-bridge-' + version + '.tgz';
const archiveBytes = Buffer.from('ISOLATED_VERIFIED_PLUGIN_ARCHIVE_FIXTURE\n'), sidecarName = archiveName + '.verification.json';
const baseReport = { schemaVersion: 1, artifact: archiveName, package: { name: 'pocket-bridge', version },
  bytes: archiveBytes.length, sha256: sha256(archiveBytes), publicFileCount: 170,
  sourceManifestFileCount: 169, runtimeDependencyCount: 56, installHooks: false,
  privateDataIncluded: false, archivedTargetsIncluded: false, sourceModified: false, liveRuntimeTested: false };
let cases = 0;
function scenario(options = {}) {
  const fixture = path.join(scratch, 'case-' + ++cases), checkout = path.join(fixture, 'checkout');
  const runnerTemp = path.join(fixture, 'runner-temp'), input = path.join(fixture, 'input.json');
  fs.mkdirSync(path.join(checkout, 'dist'), { recursive: true }); fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'pocket-bridge', version }));
  fs.writeFileSync(path.join(checkout, 'dist', 'PocketBridge-' + version + '-win-x64-Setup.exe'), 'ISOLATED_INSTALLER_FIXTURE\n');
  fs.writeFileSync(input, JSON.stringify({ mode: options.mode || 'success', exitCode: options.exitCode || 0,
    archiveName, artifactBase64: archiveBytes.toString('base64'), report: { ...baseReport, ...options.report } }));
  const psFile = path.join(fixture, 'exercise.ps1');
  const run = options.run || [plugin.run, checksums.run, publish.run].join('\n');
  // Values come only from owned JSON/env; functions shadow executables entirely.
  fs.writeFileSync(psFile, String.raw`
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $env:PB_WORKFLOW_CHECKOUT
$fixtureInput = Get-Content -LiteralPath $env:PB_WORKFLOW_INPUT -Raw | ConvertFrom-Json
function node {
  if ($args.Count -ne 2 -or $args[0] -cne 'scripts/build-dsh-plugin.js') { throw 'Unexpected node invocation' }
  $output = [IO.Path]::GetFullPath($args[1])
  $runnerPrefix = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $checkoutPrefix = [IO.Path]::GetFullPath($env:PB_WORKFLOW_CHECKOUT).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $output.StartsWith($runnerPrefix, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($checkoutPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Plugin output must be a fresh runner directory outside checkout' }
  if (Test-Path -LiteralPath $output) { throw 'Plugin output was reused' }
  New-Item -ItemType Directory -Path $output | Out-Null
  [IO.File]::WriteAllText((Join-Path $env:PB_WORKFLOW_FIXTURE 'builder-output.txt'), $output)
  if ($fixtureInput.mode -ne 'missing-archive') {
    [IO.File]::WriteAllBytes((Join-Path $output $fixtureInput.archiveName), [Convert]::FromBase64String($fixtureInput.artifactBase64))
  }
  if ($fixtureInput.mode -ne 'missing-report') {
    $reportText = if ($fixtureInput.mode -eq 'invalid-json') { 'not json' } else { $fixtureInput.report | ConvertTo-Json -Depth 8 }
    [IO.File]::WriteAllText((Join-Path $output ($fixtureInput.archiveName + '.verification.json')), $reportText)
  }
  $global:LASTEXITCODE = $fixtureInput.exitCode
}
function git {
  if ($args.Count -ne 4 -or $args[0] -cne 'archive' -or $args[1] -cne '--format=zip' -or $args[3] -cne 'HEAD' -or -not $args[2].StartsWith('--output=dist/')) { throw 'Unexpected git invocation' }
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($args[2].Substring(9)), 'ISOLATED_SOURCE_ARCHIVE_FIXTURE')
  $global:LASTEXITCODE = 0
}
function gh {
  if ($args.Count -lt 2 -or $args[0] -cne 'release' -or $args[1] -cne 'create') { throw 'Unexpected gh invocation' }
  [IO.File]::WriteAllText((Join-Path $env:PB_WORKFLOW_FIXTURE 'release-args.json'), (ConvertTo-Json -InputObject @($args)))
  $global:LASTEXITCODE = 0
}
try {
` + run + String.raw`
  [IO.File]::WriteAllText((Join-Path $env:PB_WORKFLOW_FIXTURE 'result.json'), '{"ok":true}')
} catch {
  [IO.File]::WriteAllText((Join-Path $env:PB_WORKFLOW_FIXTURE 'result.json'), (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json))
  exit 17
}
`, 'utf8');
  const executed = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', psFile], {
    cwd: checkout, windowsHide: true, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_SHA: sha,
      PB_WORKFLOW_CHECKOUT: checkout, PB_WORKFLOW_INPUT: input, PB_WORKFLOW_FIXTURE: fixture },
  });
  assert(!executed.error, executed.error?.message);
  const resultFile = path.join(fixture, 'result.json');
  assert(fs.existsSync(resultFile), 'PowerShell did not finish fixture: ' + executed.stderr);
  return { ...JSON.parse(fs.readFileSync(resultFile)), exitCode: executed.status, fixture, checkout, runnerTemp };
}
function refused(options, error) {
  const result = scenario(options);
  assert.equal(result.ok, false); assert.equal(result.exitCode, 17);
  if (error) assert.match(result.error, error);
  assert(!fs.existsSync(path.join(result.checkout, 'dist', archiveName)), 'unverified plugin reached release directory');
  assert(!fs.existsSync(path.join(result.fixture, 'release-args.json')), 'failed packaging reached release creation');
}
(async () => {
  try {
    await check('independent gates surround isolated CI, installer and plugin packaging', () => {
      assert.deepEqual([...steps.keys()], [gateFirst, isolated, installer, plugin, checksums, gateLast, publish].map(entry => /^      - name: (.+)$/m.exec(entry.block)[1]));
      assert.match(gateFirst.run, /node .*pocket-bridge-independent-ci-gate\.js/);
      assert.match(gateLast.run, /node .*pocket-bridge-independent-ci-gate\.js.* recheck/);
      assert.match(isolated.run, /node scripts\/run-ci-tests\.js/);
      assert.match(isolated.run, /\$LASTEXITCODE -ne 0.*throw/);
      assert.equal(installer.run, './packaging/windows/build.ps1');
      assert.match(workflow, /contents: write/); assert.match(workflow, /actions: read/);
    });
    await check('independent CI records exact success and reconfirms the same run', async () => {
      assert.equal(await gate(), 0); assert.equal(proof.size, 1);
      const saved = JSON.parse([...proof.values()][0]);
      assert.equal(saved.sha, sha); assert.equal(saved.runId, 901); assert.equal(saved.runAttempt, 1);
      assert.equal(await gate('success', true), 0);
    });
    for (const mode of ['failed', 'other-commit', 'old-result', 'same-workflow']) {
      await check('independent CI refuses ' + mode, async () => { proof.clear(); assert.equal(await gate(mode), 1); assert.equal(proof.size, 0); });
    }
    await check('second gate refuses a rerun after packaging', async () => {
      proof.clear(); assert.equal(await gate(), 0); assert.equal(await gate('rerun', true), 1);
    });
    if (process.platform !== 'win32') { console.log('Windows PowerShell release fixtures not run on this platform.'); return; }
    await check('all publication run blocks parse as PowerShell', () => {
      const script = [...steps.values()].map((entry, index) => {
        const encoded = Buffer.from(entry.run, 'utf8').toString('base64');
        return "$parseTokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')), [ref]$parseTokens, [ref]$parseErrors); if ($parseErrors.Count) { throw 'Invalid PowerShell step " + index + "' }";
      }).join('\n');
      const parsed = scenario({ run: script }); assert.equal(parsed.ok, true, parsed.error);
    });
    let success;
    await check('fresh RUNNER_TEMP plugin and report copies preserve exact bytes', () => {
      success = scenario(); assert.equal(success.ok, true, success.error); assert.equal(success.exitCode, 0);
      const output = fs.readFileSync(path.join(success.fixture, 'builder-output.txt'), 'utf8');
      // PowerShell may expand a Windows 8.3 TEMP alias while Node retains it.
      // Both existing directories must resolve to the same real filesystem path.
      assert.equal(fs.realpathSync.native(path.dirname(output)), fs.realpathSync.native(success.runnerTemp));
      assert.equal(fs.readdirSync(success.runnerTemp).length, 1);
      assert(fs.readFileSync(path.join(success.checkout, 'dist', archiveName)).equals(archiveBytes));
      assert(fs.readFileSync(path.join(success.checkout, 'dist', sidecarName)).equals(fs.readFileSync(path.join(output, sidecarName))));
    });
    await check('SHA256SUMS covers installer, source, plugin and report exact bytes', () => {
      const dist = path.join(success.checkout, 'dist'), bytes = fs.readFileSync(path.join(dist, 'SHA256SUMS.txt'));
      assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
      const lines = bytes.toString('utf8').trim().split(/\r?\n/);
      const names = ['PocketBridge-' + version + '-win-x64-Setup.exe', 'PocketBridge-v' + version + '-source.zip', archiveName, sidecarName];
      assert.equal(lines.length, names.length);
      lines.forEach((line, index) => assert.equal(line, sha256(fs.readFileSync(path.join(dist, names[index]))).toUpperCase() + '  ' + names[index]));
    });
    await check('preview release attaches all five assets at the exact commit', () => {
      const args = JSON.parse(fs.readFileSync(path.join(success.fixture, 'release-args.json')));
      assert.deepEqual(args.slice(0, 8), ['release', 'create', 'v' + version, 'dist/PocketBridge-' + version + '-win-x64-Setup.exe',
        'dist/PocketBridge-v' + version + '-source.zip', 'dist/' + archiveName, 'dist/' + sidecarName, 'dist/SHA256SUMS.txt']);
      assert.deepEqual(args.slice(8), ['--target', sha, '--title', 'Pocket Bridge ' + version + ' (Windows preview)', '--notes-file', 'RELEASE_NOTES.md', '--prerelease']);
    });
    await check('builder failure blocks even generated artifacts', () => refused({ exitCode: 9 }, /build or verification failed/));
    for (const mode of ['missing-archive', 'missing-report', 'invalid-json']) {
      await check(mode + ' blocks release', () => refused({ mode }));
    }
    for (const [label, report] of [
      ['wrong hash', { sha256: '0'.repeat(64) }], ['wrong size', { bytes: archiveBytes.length + 1 }],
      ['wrong filename', { artifact: 'another-plugin.tgz' }], ['wrong package', { package: { name: 'pocket-bridge', version: '0.0.0' } }],
      ['private data', { privateDataIncluded: true }], ['modified source', { sourceModified: true }],
      ['install hooks', { installHooks: true }], ['archived integrations', { archivedTargetsIncluded: true }],
    ]) await check(label + ' blocks release before copying', () => refused({ report }, /report differs/));
    console.log('Passed ' + passed + ' plugin publication workflow checks. No installer, network or public release invoked.');
  } finally {
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), tempBase);
    assert(/^pb-plugin-release-test-[A-Za-z0-9]+$/.test(path.basename(resolved)));
    assert(!fs.lstatSync(resolved).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
