'use strict';
// Independent Dot persistence. This does not enable Send or operate the UI.
// Existing identities, a provisioned journal and ownership evidence are never
// reset automatically. Unexpected-crash locks require separately verified,
// explicit recovery; PID absence alone is not permission to remove them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createDotDesktopJournal } = require('./dot-desktop-journal.js');
const HASH = /^[0-9a-f]{64}$/;
const DOMAIN = 'PocketBridge.IndependentDot.PrivateStore.v1';
const fail = code => Object.assign(new Error(code), { code });
const keys = (value, names) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Constant program, data over stdin. Paths/key material are never interpolated
// into command text. Only DPAPI, the exact private path ACL and our own process
// metadata are touched; no desktop, registry, browser or application input.
const WINDOWS_PROGRAM = String.raw`
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
$task=[Console]::In.ReadToEnd()|ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function Assert-PrivateAcl([string]$target,[bool]$directory) {
  $item=Get-Item -LiteralPath $target -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory){throw 'private-path-invalid'}
  $acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or
      $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -cne $sid.Value -or $rules[0].IsInherited -or
      $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'private-acl-invalid'}
  $expected=[Security.AccessControl.InheritanceFlags]::None
  if($directory){$expected=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}
  if($rules[0].InheritanceFlags -ne $expected -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'private-acl-invalid'}
}
function Set-PrivateAcl([string]$target,[bool]$directory) {
    $item=Get-Item -LiteralPath $target -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory){throw 'private-path-invalid'}
    # New files/directories already belong to this user. Requesting an owner
    # write can fail under a restricted token despite a valid current owner.
    # Verify it first, then modify ONLY the Access section of the existing ACL.
    $ownerAcl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner)
    if($ownerAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value){throw 'private-owner-invalid'}
    $acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    if($directory){
      $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }else{$inherit=[Security.AccessControl.InheritanceFlags]::None}
    $acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$null=$acl.RemoveAccessRuleSpecific($existing)}
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,
      $inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule);$item.SetAccessControl($acl);Assert-PrivateAcl $target $directory
}
switch([string]$task.operation) {
  'acl-create' {Set-PrivateAcl ([IO.Path]::GetFullPath([string]$task.path)) ([bool]$task.directory);[Console]::Out.Write('{"ok":true}')}
  'acl-check' {Assert-PrivateAcl ([string]$task.path) ([bool]$task.directory);[Console]::Out.Write('{"ok":true}')}
  'protect' {
    Add-Type -AssemblyName System.Security
    $data=[Convert]::FromBase64String([string]$task.data);$entropy=[Text.Encoding]::UTF8.GetBytes('${DOMAIN}')
    try{$result=[Security.Cryptography.ProtectedData]::Protect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.Write((@{data=[Convert]::ToBase64String($result)}|ConvertTo-Json -Compress))
    }finally{[Array]::Clear($data,0,$data.Length)}
  }
  'unprotect' {
    Add-Type -AssemblyName System.Security
    $data=[Convert]::FromBase64String([string]$task.data);$entropy=[Text.Encoding]::UTF8.GetBytes('${DOMAIN}')
    $result=$null
    try{$result=[Security.Cryptography.ProtectedData]::Unprotect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.Write((@{data=[Convert]::ToBase64String($result)}|ConvertTo-Json -Compress))
    }finally{if($null -ne $result){[Array]::Clear($result,0,$result.Length)}}
  }
  'read-pair' {
    # One complete native observation, not twelve PowerShell launches per
    # journal-ready check. Recheck the directory and both protected file ACLs.
    Assert-PrivateAcl ([string]$task.directory) $true
    Assert-PrivateAcl ([string]$task.anchorFile) $false
    Assert-PrivateAcl ([string]$task.stateFile) $false
    Add-Type -AssemblyName System.Security
    $entropy=[Text.Encoding]::UTF8.GetBytes('${DOMAIN}')
    $anchor=$null;$state=$null
    try{
      foreach($file in @([string]$task.anchorFile,[string]$task.stateFile)){
        $length=(Get-Item -LiteralPath $file -Force).Length
        if($length -lt 1 -or $length -gt 32768){throw 'private-file-size-invalid'}
      }
      $anchor=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes([string]$task.anchorFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $state=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes([string]$task.stateFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      if($anchor.Length -lt 1 -or $anchor.Length -gt 8192 -or $state.Length -lt 1 -or $state.Length -gt 8192){throw 'private-plaintext-size-invalid'}
      [Console]::Out.Write((@{anchor=[Convert]::ToBase64String($anchor);state=[Convert]::ToBase64String($state)}|ConvertTo-Json -Compress))
    }finally{
      if($null -ne $anchor){[Array]::Clear($anchor,0,$anchor.Length)}
      if($null -ne $state){[Array]::Clear($state,0,$state.Length)}
    }
  }
  'write-protected' {
    # One native operation performs the scoped ACL check, DPAPI protection,
    # fsynced atomic write, exact final ACL check and verified DPAPI readback.
    $root=[IO.Path]::GetFullPath([string]$task.rootDirectory);$target=[IO.Path]::GetFullPath([string]$task.file)
    $targetParent=[IO.Path]::GetDirectoryName($target);$targetName=[IO.Path]::GetFileName($target)
    if(-not(($targetParent -ceq $root -and $targetName -ceq 'state.dpapi') -or
       ($targetParent -ceq [IO.Path]::GetDirectoryName($root) -and $targetName -ceq 'dot-private-anchor.dpapi'))){throw 'private-write-path-invalid'}
    Assert-PrivateAcl $root $true
    if([bool]$task.mustBeAbsent){if([IO.File]::Exists($target) -or [IO.Directory]::Exists($target)){throw 'private-file-exists'}}
    else{Assert-PrivateAcl $target $false}
    Add-Type -AssemblyName System.Security
    $entropy=[Text.Encoding]::UTF8.GetBytes('${DOMAIN}');$plain=[Convert]::FromBase64String([string]$task.data)
    $protected=$null;$verified=$null;$stream=$null;$pending=$target+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try{
      if($plain.Length -lt 1 -or $plain.Length -gt 8192){throw 'private-plaintext-size-invalid'}
      $protected=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $stream.Write($protected,0,$protected.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
      Set-PrivateAcl $pending $false
      # ReplaceFile merges destination security and can request rights that a
      # restricted current-user token does not have. A same-volume rename keeps
      # the already verified source ACL; no owner/security merge is requested.
      if(-not ('PocketBridgeDotPrivateNative' -as [type])){
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PocketBridgeDotPrivateNative {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileEx(string source, string target, uint flags);
}
'@
      }
      $flags=[uint32]8
      if(-not [bool]$task.mustBeAbsent){$flags=[uint32]9}
      if(-not [PocketBridgeDotPrivateNative]::MoveFileEx($pending,$target,$flags)){
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
      }
      $pending=$null;Assert-PrivateAcl $target $false
      $verified=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($target),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $sha=[Security.Cryptography.SHA256]::Create()
      try{$actual=-join @($sha.ComputeHash($verified)|ForEach-Object {$_.ToString('x2')});$expected=-join @($sha.ComputeHash($plain)|ForEach-Object {$_.ToString('x2')})}finally{$sha.Dispose()}
      if($actual -cne $expected -or $verified.Length -ne $plain.Length){throw 'private-write-unverified'}
      [Console]::Out.Write((@{verifiedSha256=$actual}|ConvertTo-Json -Compress))
    }finally{
      if($null -ne $stream){$stream.Dispose()}
      if($null -ne $pending -and [IO.File]::Exists($pending)){[IO.File]::Delete($pending)}
      [Array]::Clear($plain,0,$plain.Length)
      if($null -ne $protected){[Array]::Clear($protected,0,$protected.Length)}
      if($null -ne $verified){[Array]::Clear($verified,0,$verified.Length)}
    }
  }
  'parent' {
    $pidValue=[int]$task.pid;$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue)
    if($null -eq $p){throw 'parent-unavailable'}
    [Console]::Out.Write((@{pid=[int]$p.ProcessId;creationTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress))
  }
  default {throw 'private-operation-invalid'}
}
`;

function createWindowsAdapter(temporary, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw fail('private-store-platform-unavailable');
  const execute = options.execFileSync || execFileSync;
  const powershell = options.powershellPath || path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  function invoke(value) {
    const env = { ...process.env, TEMP: temporary, TMP: temporary };
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'DSH_API_KEY', 'ACCESS_TOKEN']) delete env[name];
    try {
      const output = execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROGRAM],
        { input: JSON.stringify(value), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32768,
          stdio: ['pipe', 'pipe', 'pipe'], env });
      return JSON.parse(output.replace(/^\uFEFF/, '').trim());
    } catch (_) { throw fail('private-store-unavailable'); }
  }
  function bytes(operation, input) {
    const value = invoke({ operation, data: input.toString('base64') });
    if (!keys(value, ['data']) || typeof value.data !== 'string' || !value.data.length ||
        Buffer.from(value.data, 'base64').toString('base64') !== value.data) throw fail('private-store-unavailable');
    return Buffer.from(value.data, 'base64');
  }
  return {
    protect: input => bytes('protect', input), unprotect: input => bytes('unprotect', input),
    writeProtectedFile(context, plain) {
      const result = invoke({ operation: 'write-protected', rootDirectory: context.directory, file: context.file,
        mustBeAbsent: context.mustBeAbsent, data: plain.toString('base64') });
      if (!keys(result, ['verifiedSha256']) || result.verifiedSha256 !== hash(plain)) throw fail('private-store-unavailable');
    },
    readProtectedPair(context) {
      const value = invoke({ operation: 'read-pair', ...context });
      if (!keys(value, ['anchor', 'state'])) throw fail('private-store-unavailable');
      const result = {};
      try {
        for (const name of ['anchor', 'state']) {
          if (typeof value[name] !== 'string' || !value[name].length ||
              Buffer.from(value[name], 'base64').toString('base64') !== value[name]) throw Error();
          result[name] = Buffer.from(value[name], 'base64');
          if (!result[name].length || result[name].length > 8192) throw Error();
        }
        return result;
      } catch (_) { for (const bytes of Object.values(result)) bytes.fill(0); throw fail('private-store-unavailable'); }
    },
    secureNewPath(file, directory) { if (invoke({ operation: 'acl-create', path: file, directory }).ok !== true) throw fail('private-store-unavailable'); },
    assertPrivatePath(file, directory) { if (invoke({ operation: 'acl-check', path: file, directory }).ok !== true) throw fail('private-store-unavailable'); },
    parentIdentity() { return invoke({ operation: 'parent', pid: process.pid }); }
  };
}

function createDotDesktopPrivateStore(options) {
  if (!options || Object.keys(options).some(name => !['base', 'protectedStore', 'parentIdentityProvider'].includes(name)) ||
      typeof options.base !== 'string' || !path.isAbsolute(options.base)) throw fail('private-store-options-invalid');
  let base;
  try { base = fs.realpathSync(options.base); if (!fs.statSync(base).isDirectory()) throw Error(); }
  catch (_) { throw fail('private-store-base-unavailable'); }
  const logs = path.join(base, 'logs'), directory = path.join(logs, 'dot-private');
  const stateFile = path.join(directory, 'state.dpapi'), anchorFile = path.join(logs, 'dot-private-anchor.dpapi');
  const journalFile = path.join(directory, 'requests.aes-gcm.json'), temporary = path.join(directory, 'native-temp');
  const adapter = options.protectedStore || createWindowsAdapter(temporary);
  if (['protect', 'unprotect', 'secureNewPath', 'assertPrivatePath'].some(name => typeof adapter[name] !== 'function'))
    throw fail('private-store-options-invalid');
  const identity = options.parentIdentityProvider || (() => adapter.parentIdentity());
  function exists(file, directoryExpected) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1))) throw Error();
      return true;
    } catch (cause) { if (cause.code === 'ENOENT') return false; throw fail('private-store-unavailable'); }
  }
  if (!exists(logs, true)) fs.mkdirSync(logs);
  const hadDirectory = exists(directory, true), hadAnchor = exists(anchorFile, false);
  if (hadDirectory !== hadAnchor) throw fail('private-store-continuity-unavailable');
  const newlyCreated = !hadDirectory;
  if (newlyCreated) {
    // Exclusive mkdir is the first-use fence. A partial first provisioning is
    // left blocked, never reinterpreted as a clean installation.
    try { fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(temporary, { mode: 0o700 });
      adapter.secureNewPath(directory, true); }
    catch (_) { throw fail('private-store-unavailable'); }
  } else adapter.assertPrivatePath(directory, true);
  if (!exists(temporary, true)) fs.mkdirSync(temporary, { mode: 0o700 });
  const pathIdentity = hash(Buffer.from(directory));
  let cachedPair = null;
  function clearPairCache() {
    if (cachedPair?.material) cachedPair.material.fill(0);
    cachedPair = null;
  }
  function statIdentity(stat) {
    return ['dev', 'ino', 'mode', 'size', 'nlink', 'uid', 'gid', 'birthtimeNs', 'mtimeNs', 'ctimeNs']
      .map(name => String(stat[name])).join(':');
  }
  function assertStructure() {
    if (!exists(logs, true) || !exists(directory, true) || fs.realpathSync(directory) !== directory)
      throw fail('private-store-continuity-unavailable');
  }
  function read(file) {
    assertStructure();
    if (!exists(file, false)) throw fail('private-store-continuity-unavailable');
    adapter.assertPrivatePath(directory, true); adapter.assertPrivatePath(file, false);
    let plain;
    try {
      const stat = fs.statSync(file);
      if (stat.size < 1 || stat.size > 32768) throw Error();
      plain = adapter.unprotect(fs.readFileSync(file));
      if (!Buffer.isBuffer(plain) || !plain.length || plain.length > 8192) throw Error();
      return JSON.parse(plain.toString('utf8'));
    } catch (_) { throw fail('private-store-continuity-unavailable'); }
    finally { if (Buffer.isBuffer(plain)) plain.fill(0); }
  }
  function observeProtectedPair() {
    assertStructure();
    const rootIdentity = statIdentity(fs.lstatSync(directory, { bigint: true }));
    const observation = { rootIdentity, files: [] };
    for (const file of [anchorFile, stateFile]) {
      if (!exists(file, false)) throw fail('private-store-continuity-unavailable');
      let descriptor;
      try {
        const link = fs.lstatSync(file, { bigint: true });
        if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1n || link.size < 1n || link.size > 32768n) throw Error();
        descriptor = fs.openSync(file, 'r');
        const stat = fs.fstatSync(descriptor, { bigint: true });
        if (statIdentity(stat) !== statIdentity(link)) throw Error();
        const bytes = fs.readFileSync(descriptor);
        if (bytes.length !== Number(stat.size) || statIdentity(fs.fstatSync(descriptor, { bigint: true })) !== statIdentity(stat)) throw Error();
        observation.files.push({ identity: statIdentity(stat), digest: hash(bytes) });
      } catch (_) { clearPairCache(); throw fail('private-store-continuity-unavailable'); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    if (statIdentity(fs.lstatSync(directory, { bigint: true })) !== rootIdentity) {
      clearPairCache(); throw fail('private-store-continuity-unavailable');
    }
    return JSON.stringify(observation);
  }
  function readPair() {
    const snapshot = observeProtectedPair();
    if (cachedPair && cachedPair.snapshot === snapshot) return {
      anchor: { ...cachedPair.anchor }, state: { ...cachedPair.state, material: cachedPair.material.toString('base64') }, snapshot
    };
    clearPairCache();
    if (typeof adapter.readProtectedPair !== 'function') {
      const pair = { anchor: read(anchorFile), state: read(stateFile), snapshot };
      if (observeProtectedPair() !== snapshot) throw fail('private-store-continuity-unavailable');
      return pair;
    }
    let result;
    try {
      result = adapter.readProtectedPair({ directory, anchorFile, stateFile });
      if (!keys(result, ['anchor', 'state']) || ['anchor', 'state'].some(name => !Buffer.isBuffer(result[name]) ||
          !result[name].length || result[name].length > 8192)) throw Error();
      // Bind the native ACL/DPAPI proof to exactly the bytes and identities
      // observed before it. Any concurrent replacement refuses this load.
      if (observeProtectedPair() !== snapshot) throw Error();
      return { anchor: JSON.parse(result.anchor.toString('utf8')), state: JSON.parse(result.state.toString('utf8')), snapshot };
    } catch (_) { throw fail('private-store-continuity-unavailable'); }
    finally { for (const name of ['anchor', 'state']) if (Buffer.isBuffer(result?.[name])) result[name].fill(0); }
  }
  function write(file, value, mustBeAbsent) {
    clearPairCache();
    if (typeof adapter.writeProtectedFile === 'function') {
      assertStructure();
      if (mustBeAbsent && exists(file, false)) throw fail('private-store-unavailable');
      const plain = Buffer.from(JSON.stringify(value));
      try { adapter.writeProtectedFile({ directory, file, mustBeAbsent }, plain);
        if (!exists(file, false)) throw Error();
        return;
      } catch (_) { throw fail('private-store-unavailable'); }
      finally { plain.fill(0); }
    }
    adapter.assertPrivatePath(directory, true);
    let plain, protectedBytes, descriptor;
    const pending = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    try {
      if (mustBeAbsent && exists(file, false)) throw Error();
      plain = Buffer.from(JSON.stringify(value)); protectedBytes = adapter.protect(plain);
      if (!Buffer.isBuffer(protectedBytes) || !protectedBytes.length || protectedBytes.length > 32768) throw Error();
      descriptor = fs.openSync(pending, 'wx', 0o600);
      fs.writeFileSync(descriptor, protectedBytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      adapter.secureNewPath(pending, false);
      if (mustBeAbsent && exists(file, false)) throw Error();
      fs.renameSync(pending, file); adapter.assertPrivatePath(file, false);
      if (JSON.stringify(read(file)) !== JSON.stringify(value)) throw Error();
    } catch (_) { throw fail('private-store-unavailable'); }
    finally {
      if (plain) plain.fill(0); if (protectedBytes) protectedBytes.fill(0);
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) {} }
      try { if (fs.existsSync(pending)) fs.unlinkSync(pending); } catch (_) {}
    }
  }
  if (newlyCreated) {
    const material = crypto.randomBytes(32);
    try {
      const shared = { version: 1, journalIdentity: crypto.randomBytes(32).toString('hex'), keyIdentity: hash(material), pathIdentity };
      write(stateFile, { ...shared, provisioned: false, material: material.toString('base64') }, true);
      write(anchorFile, shared, true);
    } finally { material.fill(0); }
  }
  let initial, unavailable = false, stopping = false, journalOpened = false, factoryActive = false,
    shutdownPromise = null, closed = false;
  function load() {
    if (unavailable || closed) throw fail('private-store-unavailable');
    try {
      const { anchor, state, snapshot } = readPair();
      if (!keys(anchor, ['version', 'journalIdentity', 'keyIdentity', 'pathIdentity']) ||
          !keys(state, ['version', 'journalIdentity', 'keyIdentity', 'pathIdentity', 'provisioned', 'material']) ||
          anchor.version !== 1 || state.version !== 1 || anchor.pathIdentity !== pathIdentity ||
          !HASH.test(anchor.journalIdentity || '') || !HASH.test(anchor.keyIdentity || '') ||
          !HASH.test(anchor.pathIdentity || '') || typeof state.provisioned !== 'boolean' ||
          Object.keys(anchor).some(name => state[name] !== anchor[name]) ||
          (initial && Object.keys(anchor).some(name => anchor[name] !== initial[name])) ||
          typeof state.material !== 'string') throw Error();
      const material = Buffer.from(state.material, 'base64');
      try {
        if (material.length !== 32 || material.toString('base64') !== state.material || hash(material) !== state.keyIdentity) throw Error();
        if (!cachedPair) { const stateMetadata = { ...state }; delete stateMetadata.material;
          cachedPair = { snapshot, anchor: { ...anchor }, state: stateMetadata, material: Buffer.from(material) }; }
      }
      finally { material.fill(0); }
      return state;
    } catch (_) { clearPairCache(); unavailable = true; throw fail('private-store-continuity-unavailable'); }
  }
  const first = load();
  initial = { version: first.version, journalIdentity: first.journalIdentity, keyIdentity: first.keyIdentity, pathIdentity: first.pathIdentity };
  delete first.material;
  const keyProvider = Object.freeze({
    readContinuityMarker() {
      const value = load(); return { version: 1, journalIdentity: value.journalIdentity, keyIdentity: value.keyIdentity, provisioned: value.provisioned };
    },
    readJournalKey(context) {
      const value = load();
      if (!keys(context, ['journalIdentity', 'keyIdentity']) || context.journalIdentity !== value.journalIdentity ||
          context.keyIdentity !== value.keyIdentity) throw fail('private-store-continuity-unavailable');
      return Buffer.from(value.material, 'base64');
    },
    commitProvisionedMarker(marker) {
      const value = load();
      if (!factoryActive || !keys(marker, ['version', 'journalIdentity', 'keyIdentity', 'provisioned']) || marker.version !== 1 ||
          marker.journalIdentity !== value.journalIdentity || marker.keyIdentity !== value.keyIdentity ||
          marker.provisioned !== true || value.provisioned !== false) throw fail('private-store-provisioning-conflict');
      // Called only by the parent-held journal owner after its encrypted first
      // file is fsynced. The marker is protected and atomically replaced too.
      if (!exists(journalFile, false)) throw fail('private-store-continuity-unavailable');
      write(stateFile, { ...value, provisioned: true }, false);
      if (load().provisioned !== true) throw fail('private-store-continuity-unavailable');
    }
  });
  function parentIdentityProvider() {
    let value;
    try { value = identity(); } catch (_) { throw fail('parent-identity-unavailable'); }
    if (!keys(value, ['pid', 'creationTicks']) || value.pid !== process.pid || typeof value.creationTicks !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(value.creationTicks)) throw fail('parent-identity-unavailable');
    return { ...value };
  }
  return Object.freeze({
    keyProvider, parentIdentityProvider,
    paths: Object.freeze({ directory, anchorFile, stateFile, journalFile, temporary }),
    discardSecrets() {
      // Failure disposal is deliberately NOT lifecycle cleanup. Unknown owned
      // helpers/receipts and parent lock evidence must remain untouched.
      clearPairCache(); initial = null; unavailable = true; stopping = true;
      return { discarded: true };
    },
    createJournal() {
      if (stopping || closed || journalOpened) throw fail('private-store-journal-unavailable');
      const marker = keyProvider.readContinuityMarker();
      // An old unprovisioned/partial installation is ambiguous, even when its
      // ciphertext is absent. Only this instance's exclusive first creation
      // may complete the first journal provisioning.
      if (!marker.provisioned && !newlyCreated) throw fail('private-store-continuity-unavailable');
      factoryActive = true;
      try {
        const journal = createDotDesktopJournal({ file: journalFile, keyProvider, parentIdentityProvider,
          ...(marker.provisioned ? {} : { provision: true }) });
        journalOpened = true; return journal;
      } finally { factoryActive = false; }
    },
    shutdown(options) {
      if (!options || !keys(options, ['service', 'stopNewSends', 'drainOwnedActions', 'timeoutMs']) ||
          typeof options.service?.close !== 'function' || typeof options.stopNewSends !== 'function' ||
          typeof options.drainOwnedActions !== 'function' || !Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 1 || options.timeoutMs > 120000) return Promise.reject(fail('private-store-shutdown-invalid'));
      if (closed) return Promise.resolve({ closed: true });
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      shutdownPromise = (async () => {
        // Trusted lifecycle callbacks must stop HTTP send admission and drain
        // promises that settle only on actual owned helper CLOSE, not kill/exit.
        if ((await options.stopNewSends())?.stopped !== true) throw fail('private-store-shutdown-unconfirmed');
        let timer;
        try {
          const drained = await Promise.race([Promise.resolve().then(options.drainOwnedActions),
            new Promise((_, reject) => { timer = setTimeout(() => reject(fail('private-store-shutdown-timeout')), options.timeoutMs); })]);
          if (drained?.allOwnedChildrenClosed !== true) throw fail('private-store-shutdown-unconfirmed');
        } finally { clearTimeout(timer); }
        // The real service and journal independently refuse inFlight/children.
        await options.service.close(); closed = true; initial = null; clearPairCache(); return { closed: true };
      })().finally(() => { shutdownPromise = null; });
      return shutdownPromise;
    }
  });
}
module.exports = { createDotDesktopPrivateStore, _testOnly: Object.freeze({ createWindowsAdapter, WINDOWS_PROGRAM }) };
