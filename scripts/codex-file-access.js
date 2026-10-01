'use strict';

const fs = require('fs');
const path = require('path');

const ARTIFACT_FOLDERS = ['generated_images', 'visualizations'];
const PRIVATE_DIRECTORY = /^(?:\.git|\.ssh|\.aws|\.azure|\.sandbox-secrets)$/i;
const PRIVATE_NAME = /^(?:auth\.(?:json|toml)|\.?credentials?(?:\.[^.]+)*|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:access|api|auth|private|secret|session|refresh|e2ee|vapid)[-_]?(?:key|token|secret)(?:\.[^.]+)*|pair-code(?:\.[^.]+)*|mint-cookie(?:\.[^.]+)*|vapid\.json)$/i;
const PRIVATE_EXTENSION = /\.(?:key|pem|p12|pfx|keystore|env)$/i;

function normalized(value) {
  const result = path.resolve(value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function inside(value, root) {
  const relative = path.relative(normalized(root), normalized(value));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function sensitiveName(value) {
  const segments = String(value).split(/[\\/]+/);
  return segments.some(segment => PRIVATE_DIRECTORY.test(segment)) ||
    PRIVATE_NAME.test(path.basename(value)) || PRIVATE_EXTENSION.test(path.basename(value));
}

function realPath(value) {
  return (fs.realpathSync.native || fs.realpathSync)(value);
}

// Resolve a missing leaf through its closest existing ancestor, so a legitimate
// missing project file still produces 404 while a directory junction cannot escape.
function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(realPath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

function artifactRoots(codexHomes) {
  return (codexHomes || []).filter(value => typeof value === 'string' && path.isAbsolute(value))
    .flatMap(home => ARTIFACT_FOLDERS.map(folder => path.join(home, folder)));
}

function lexicalAndRealPaths(values) {
  const paths = [];
  for (const value of values || []) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    paths.push(path.resolve(value));
    try { paths.push(canonicalPath(value)); } catch (_) { }
  }
  return paths;
}

function forbidden(value, options) {
  if (sensitiveName(value)) return true;
  if (lexicalAndRealPaths(options.forbiddenRoots).some(root => inside(value, root))) return true;
  if (lexicalAndRealPaths(options.forbiddenFiles).some(file => normalized(file) === normalized(value))) return true;
  // A project root can contain the Codex home as a child. Never expose its
  // credentials, caches, plugins, or runtime state through that parent project.
  const homes = lexicalAndRealPaths(options.codexHomes);
  const artifacts = artifactRoots(homes);
  return homes.some(home => inside(value, home) && !artifacts.some(root => inside(value, root)));
}

function allowedRoots(options) {
  const candidates = [options.uploadRoot, ...artifactRoots(options.codexHomes),
    ...(options.projectRoots || []), ...(options.extraRoots || [])];
  const roots = new Map();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    const root = path.resolve(candidate);
    if (normalized(root) === normalized(path.parse(root).root) || forbidden(root, options)) continue;
    roots.set(normalized(root), root);
  }
  return [...roots.values()];
}

/** Authorize lexical and real paths against the same explicitly allowed root. */
function checkPath(value, options) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) return null;
  // NTFS alternate data streams do not appear as normal files in a directory.
  if (process.platform === 'win32' && value.slice(path.parse(value).root.length).includes(':')) return null;
  const absolutePath = path.resolve(value);
  if (forbidden(absolutePath, options)) return null;
  let canonical, stat = null;
  try {
    canonical = canonicalPath(absolutePath);
    if (forbidden(canonical, options)) return null;
    try { stat = fs.statSync(canonical); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null; }
    // A hard link's original location cannot be established by realpath.
    // Refuse files with multiple names rather than trusting a harmless alias.
    if (stat && stat.isFile() && stat.nlink !== 1) return null;
    for (const root of options.roots || allowedRoots(options)) {
      if (!inside(absolutePath, root)) continue;
      let canonicalRoot;
      try { canonicalRoot = realPath(root); } catch (_) { continue; }
      // A registered lexical root must not silently adopt a junction target.
      if (normalized(canonicalRoot) !== normalized(root) || forbidden(canonicalRoot, options)) continue;
      if (inside(canonical, canonicalRoot)) return { absolutePath, realPath: canonical, stat };
    }
  } catch (_) { }
  return null;
}

module.exports = { allowedRoots, checkPath, artifactRoots, sensitiveName, inside };
