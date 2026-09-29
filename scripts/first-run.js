// First-run secrets are created on the user's computer, never in a release package.
// This module is intentionally synchronous: the gateway must not listen before its
// authentication and E2EE keys exist.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DSH_AUTHORITY = '127.0.0.1:58347';

function createSecretIfMissing(file, bytes) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(bytes).toString('base64url'), 'ascii'); }
    finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

function readValidSecret(file, minLength) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.length < minLength || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid secret in ${path.basename(file)}; it was not replaced automatically`);
  }
  return raw;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (err) { return false; }
}

/**
 * DSH 主目录（放 `.credentials.yaml` 的那一层）的候选位置。
 *
 * 为什么要列一串、而不是写一个常量：这个位置已经改过一次 ——
 * 旧版在 `%APPDATA%\DeepSeek Harness Desktop\harness-home`，
 * 而 2026-09 实测的 DSH 0.1.7-rc.2 换成了家目录下的 `~/.dsh`。
 *
 * 找错这一处的代价不小，而且**从现象上几乎看不出来**：
 * `mintDshCookie` 返回 unavailable，网关就种一个自己编的 cookie 名
 * （`pocket-bridge-auth`），而 DSH 对它的每个请求都回 401。
 * 手机上表现为「首页能开、点进去一直转圈」，电脑上只留一句很轻的日志。
 * 所以这里宁可多列几个候选，也不要在下一次改名时再整条断掉。
 */
function dshHomeCandidates() {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    process.env.DSH_HOME,                                          // 显式指定最优先
    path.join(home, '.dsh'),                                       // 新版（0.1.7+）
    process.env.APPDATA && path.join(process.env.APPDATA, 'DeepSeek Harness Desktop', 'harness-home'),
    path.join(home, 'AppData', 'Roaming', 'DeepSeek Harness Desktop', 'harness-home'),
    path.join(home, 'Library', 'Application Support', 'DeepSeek Harness Desktop', 'harness-home'),
    path.join(xdg, 'DeepSeek Harness Desktop', 'harness-home'),
    process.env.APPDATA && path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop')
  ].filter(Boolean);
}

/**
 * 最后一道兜底：在几个最可能的根目录下浅扫一遍，找 `.credentials.yaml`。
 *
 * 为什么值得做这件事：上面那份清单写的都是「已知会变的东西」，而它已经变过一次。
 * 与其等下次再有人来报「又识别不到了」，不如让它自己找得到。
 *
 * 代价是可控的：深度限死、跳过缓存/包管理这类又大又不可能的目录，
 * 而且**只在已知位置全部落空时**才跑（见 credentialCandidates）。
 */
function scanForCredentials() {
  const home = os.homedir();
  const roots = [
    { dir: home, depth: 2 },                                        // ~/.dsh/.credentials.yaml
    { dir: process.env.APPDATA, depth: 3 },                         // 旧版的 harness-home 在第 3 层
    { dir: process.env.XDG_CONFIG_HOME || path.join(home, '.config'), depth: 3 },
    { dir: process.env.LOCALAPPDATA, depth: 2 }
  ].filter((r) => r.dir);

  const skip = /^(node_modules|Packages|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|blob_storage|Local Storage|Session Storage|Network|Dictionaries|Temp|logs|Crashpad|Partitions)$/i;
  const found = [];

  const walk = (dir, depth) => {
    if (depth < 0 || found.length >= 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
      if (found.length >= 8) return;
      if (e.isFile()) {
        if (e.name === '.credentials.yaml') found.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isDirectory() || skip.test(e.name)) continue;
      walk(path.join(dir, e.name), depth - 1);
    }
  };

  const seen = new Set();
  for (const { dir, depth } of roots) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    walk(dir, depth);
  }
  return found;
}

/**
 * `.credentials.yaml` 的候选路径，按可信度排序。
 *
 * @returns {string[]} 第一个真实存在的就是我们要用的那个
 */
function credentialCandidates() {
  // An explicit path is authoritative, including when it is intentionally
  // nonexistent (useful for Codex-only installs and isolated tests).
  if (process.env.DSH_CREDENTIALS_FILE) return [process.env.DSH_CREDENTIALS_FILE];

  const explicit = [...new Set(dshHomeCandidates().map((h) => path.join(h, '.credentials.yaml')))];
  // 已知位置命中就不扫 —— 扫描只在兜底时才值得那点开销
  if (explicit.some(isFile)) return explicit;
  return [...new Set([...explicit, ...scanForCredentials()])];
}

function validDshCookie(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record.status === 'ok' &&
      record.authority === DSH_AUTHORITY &&
      /^dsh-auth-[A-Za-z0-9_-]+$/.test(record.cookieName || '') &&
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(record.cookieValue || '') &&
      Date.parse(record.expiresAt || '') > Date.now() + 60 * 60 * 1000;
  } catch (err) { return false; }
}

function mintDshCookie(base, logDir) {
  const target = path.join(logDir, 'mint-cookie.json');
  if (validDshCookie(target)) return { status: 'existing', credentials: null };
  const credentials = credentialCandidates().find(isFile);
  if (!credentials) return { status: 'unavailable', credentials: null };
  const temporary = path.join(logDir, `.mint-cookie.${process.pid}.tmp`);
  try {
    execFileSync(process.execPath, [path.join(base, 'scripts', 'mint-cookie.js'),
      credentials, DSH_AUTHORITY, temporary], {
      cwd: base, stdio: 'ignore', timeout: 10000, windowsHide: true
    });
    if (!validDshCookie(temporary)) return { status: 'invalid-credentials', credentials };
    fs.renameSync(temporary, target);
    return { status: 'created', credentials };
  } catch (err) {
    return { status: 'invalid-credentials', credentials };
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { /* no temporary file */ }
  }
}

function ensureFirstRun(base = path.resolve(__dirname, '..')) {
  const logDir = path.join(base, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const accessFile = path.join(logDir, 'access-key.txt');
  const e2eeFile = path.join(logDir, 'e2ee-secret.txt');
  const createdAccessKey = createSecretIfMissing(accessFile, 18);
  const createdE2eeKey = createSecretIfMissing(e2eeFile, 24);
  readValidSecret(accessFile, 16);
  readValidSecret(e2eeFile, 32);
  const dshCookie = mintDshCookie(base, logDir);
  // 把「用的是哪一份凭据」一并带出去：这一条链一旦断掉，现场只有这个路径
  // 能说明断在哪 —— 是没找到文件，还是文件找到了但签出来的 cookie 不认。
  return {
    createdAccessKey,
    createdE2eeKey,
    dshCookie: dshCookie.status,
    dshCredentials: dshCookie.credentials
  };
}

module.exports = {
  ensureFirstRun,
  credentialCandidates,
  dshHomeCandidates,
  scanForCredentials,
  validDshCookie,
  DSH_AUTHORITY
};
