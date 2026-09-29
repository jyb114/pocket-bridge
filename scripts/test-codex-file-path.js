// `/codex/file` 的路径解析 —— 相对路径的回归测试。
//
// 为什么单独测这一项：
//   2026-09-29 使用者报「Codex 手机端无法查看图片」，界面上那句提示写的是
//      这张图没取回来：Reports/reality_overview_02.png
//   —— 一个**相对路径**。
//
//   服务端原来无条件 `path.resolve(raw)`，而 `path.resolve` 对相对路径是从
//   **桥进程的 cwd**（D:\Pocket Bridge）起算的：
//       D:\Pocket Bridge\Reports\reality_overview_02.png
//   那个位置不在"允许的根"里（允许的是 ~/.codex、上传目录、以及 **Codex 会话
//   自己的工作目录**），于是**稳定地 403** —— 手机上的表现就是"这张图没取回来"，
//   而且每次都是同一张。
//
// 这个测试只抠出三个纯函数在 vm 里跑，不启动网关、不碰真实会话、不读凭据。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const BASE = path.resolve(__dirname, '..');
const { extractFunction } = require('./page-source.js');

const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }

/**
 * 把 allowedRoots / fileAllowed / resolveRequestedPath 三个函数抠进一个隔离环境。
 * @param {object} o
 * @param {string[]} o.roots  冒充「Codex 会话的工作目录」
 * @param {string[]} [o.fileRoots]  冒充使用者在配置里显式允许的目录
 */
function fixture(o) {
  const box = {
    path, os, fs, console,
    BASE: o.base || 'D:/pocket-bridge-base',
    cfg: { loadConfig: () => ({ fileRoots: o.fileRoots || [] }) },
    sessionWorkDirs: () => o.roots,
    result: {}
  };
  vm.createContext(box);
  for (const name of ['allowedRoots', 'workspaceParents', 'fileAllowed', 'pickExisting',
    'allowedSubdirectories', 'fileExists', 'resolveRequestedPath']) {
    const src = extractFunction(SRC, name);
    assert.ok(src && src.length > 40, '抠不出 ' + name);
    vm.runInContext(src, box);
  }
  return box;
}

// 造一棵真实的目录树 —— 因为 resolveRequestedPath 现在按"文件真实存在"来选根，
// 用假路径测等于没测（每个候选都不存在，永远走 fallback 分支）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-filepath-'));
const SESSION = path.join(TMP, 'my-project');
const OTHER = path.join(TMP, 'another');
fs.mkdirSync(path.join(SESSION, 'Reports'), { recursive: true });
fs.mkdirSync(path.join(OTHER, 'Reports'), { recursive: true });
fs.writeFileSync(path.join(SESSION, 'Reports', 'reality_overview_02.png'), 'png');
fs.writeFileSync(path.join(OTHER, 'Reports', 'only-here.png'), 'png');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { } });

check('绝对路径照旧（不受这次改动影响）', () => {
  const b = fixture({ roots: [SESSION] });
  const inside = path.join(SESSION, 'Reports', 'reality_overview_02.png');
  assert.equal(b.resolveRequestedPath(inside), inside);
  assert.equal(b.fileAllowed(inside), true);
});

check('相对路径相对**会话目录**解析，而不是桥的 cwd', () => {
  const b = fixture({ roots: [SESSION] });
  const got = b.resolveRequestedPath('Reports/reality_overview_02.png');
  assert.equal(got, path.join(SESSION, 'Reports', 'reality_overview_02.png'));
  // 这正是原来那条死路：相对桥 cwd 解析出来的位置不允许
  assert.notEqual(got, path.resolve('Reports/reality_overview_02.png'));
  assert.equal(b.fileAllowed(path.resolve('Reports/reality_overview_02.png')), false,
    '相对桥 cwd 的那个位置本来就不该被允许（这就是 403 的来源）');
});

check('多个会话目录时，文件在哪个目录下就解析到哪个', () => {
  const b = fixture({ roots: [SESSION, OTHER] });
  assert.equal(b.resolveRequestedPath('Reports/reality_overview_02.png'),
    path.join(SESSION, 'Reports', 'reality_overview_02.png'));
  assert.equal(b.resolveRequestedPath('Reports/only-here.png'),
    path.join(OTHER, 'Reports', 'only-here.png'),
    '两个目录下都有 Reports/，必须按文件真实存在来选，不能只看顺序');
});

check('相对路径试图逃逸 → 不许通过', () => {
  const b = fixture({ roots: [SESSION] });
  const escaped = b.resolveRequestedPath('../../../Windows/System32/secret.dll');
  assert.equal(b.fileAllowed(escaped), false, '向上逃逸的相对路径必须被拒');
  // ★ 注意边界在哪：**工作目录的父目录是放行的**（见 workspaceParents 那段说明 ——
  //   这是为了让"隔壁项目"里的图片能读，代价与理由都写在代码里）。
  //   所以这里要断言的是**父目录之上**仍然读不到。
  const aboveParent = path.dirname(TMP);
  assert.equal(b.fileAllowed(path.join(aboveParent, 'outside.txt')), false,
    '工作目录的父目录之上仍然不许读');
});

check('文件确实不在任何允许目录下 → 退回允许的候选（交给 404），不越界', () => {
  const b = fixture({ roots: [SESSION] });
  const got = b.resolveRequestedPath('Reports/nope-does-not-exist.png');
  assert.ok(path.isAbsolute(got));
  // 具体退到哪个根不重要（上传目录排在最前），要紧的是**没跑到允许范围之外** ——
  // fileAllowed 就是这条边界，读不到文件时由 fs.stat 给出 404。
  assert.equal(b.fileAllowed(got), true, '仍然落在允许范围内 —— 由 fs.stat 给出 404');
  const roots = b.allowedRoots().map((r) => path.resolve(r));
  assert.ok(roots.some((r) => got === r || got.startsWith(r + path.sep)),
    '必须落在某个允许的根下');
});

check('允许的根包含 ~/.codex 与上传目录', () => {
  const b = fixture({ roots: [] });
  const roots = b.allowedRoots().map((r) => path.resolve(r));
  assert.ok(roots.some((r) => r === path.join(b.BASE, 'uploads', 'codex')),
    '上传目录应当在允许范围内');
  let codexDir = null;
  try { codexDir = path.resolve(path.join(os.homedir(), '.codex')); } catch (e) { }
  if (codexDir) assert.ok(roots.includes(codexDir), '~/.codex 应当在允许范围内');
});

check('使用者显式允许的目录也参与解析', () => {
  const extra = path.join(TMP, 'shared');
  fs.mkdirSync(path.join(extra, 'exports'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'exports', 'x.png'), 'png');
  const b = fixture({ roots: [], fileRoots: [extra] });
  assert.equal(b.resolveRequestedPath('exports/x.png'), path.join(extra, 'exports', 'x.png'));
});

check('★ 相对路径能落到**同级项目**里（Codex 报告图片的真实场景）', () => {
  // 实测数据：
  //   Codex 报回来的是相对路径 `Reports/reality_overview_02.png`
  //   文件其实在  D:\my_games\AshenCovenant3D\Reports\…
  //   而 Codex 的工作目录是 D:\my_games\Ashen_Covenant_V0.50.0_M7
  //   —— 那个 3D 项目**从来没被登记过**，于是那张图一律 403。
  // 这里就照这个形状搭一遍：工作目录是 projA，文件在**隔壁** projB。
  const devRoot = path.join(TMP, 'devroot');
  const projA = path.join(devRoot, 'projA');
  const projB = path.join(devRoot, 'projB');
  fs.mkdirSync(path.join(projB, 'Reports'), { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  fs.writeFileSync(path.join(projB, 'Reports', 'reality_overview_02.png'), 'png');

  const b = fixture({ roots: [projA] });
  const got = b.resolveRequestedPath('Reports/reality_overview_02.png');
  assert.equal(got, path.join(projB, 'Reports', 'reality_overview_02.png'),
    '必须往下探一层，才能命中隔壁项目里的文件');
  assert.equal(b.fileAllowed(got), true, '命中之后仍要落在允许范围内');
  // 但**不能**探到允许范围之外去
  assert.equal(b.fileAllowed(path.join(TMP, 'nope', 'x.png')), false);
});

check('绝对路径不受这个改动影响', () => {
  const devRoot = path.join(TMP, 'devroot');
  const projB = path.join(devRoot, 'projB');
  const b = fixture({ roots: [path.join(devRoot, 'projA')] });
  const abs = path.join(projB, 'Reports', 'reality_overview_02.png');
  assert.equal(b.resolveRequestedPath(abs), abs);
});

check('空路径与纯相对文件名不炸', () => {
  const b = fixture({ roots: [SESSION] });
  assert.ok(path.isAbsolute(b.resolveRequestedPath('a.png')));
  assert.equal(b.fileAllowed(''), false);
});

console.log('DSH codex file path: ' + checks + ' isolated groups passed');
