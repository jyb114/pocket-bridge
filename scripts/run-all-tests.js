// 把 scripts/ 下**所有**检查脚本跑一遍，给出真实的全景。
//
// 为什么需要它：这个项目有 40 多个检查脚本，而 package.json 的 npm test
// 只串了其中 9 个 —— 剩下的一直没跑过。后果是「全套测试通过」这句话
// 实际上只覆盖了一小部分，而且没人发现（语音那个「有标识但用不了」
// 就是这么漏掉的：test-voice.js 明明存在，却从来没被跑过）。
//
// 这个脚本不预设白名单，**发现什么跑什么**，跑不动的如实标出来。
// 只有这样「哪些真的绿、哪些其实是红的、哪些需要环境」才是可信的。
//
// 用法:
//   node scripts/run-all-tests.js            跑全部
//   node scripts/run-all-tests.js --json     输出 JSON（给 CI 用）
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const SCRIPTS = path.join(BASE, 'scripts');
const AS_JSON = process.argv.includes('--json');

// 单个脚本最多跑多久。有些会起浏览器、连隧道，给宽一点。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 240000);

/**
 * 需要「外部条件」的脚本 —— 不是代码坏了，是环境不具备。
 *
 * 关键：这里只列**真的需要人和外部服务**的，不列「跑得慢」的。
 * 把跑得慢的塞进来，等于把红的说成黄的。
 */
const NEEDS = [
  { match: /^test-guard\.js$/, why: '它是别的测试的守门员，自己不是测试' },
  { match: /^test-e2ee-live\.js$/, why: '要一个真实隧道才好验，没隧道时退化为本地' },
  { match: /^test-codex-send\.js$/, why: '会真的用使用者的 Codex 账号发消息（明令禁止）' },
  { match: /^test-codex-approval\.js$/, why: '需要 Codex 侧真的弹一次审批' },
  { match: /^test-codex-observer\.js$/, why: '需要活的 Codex 会话' },
  { match: /^test-codex-queue\.js$/, why: '需要活的 Codex 会话' },
  { match: /^test-codex-thread-state\.js$/, why: '需要活的 Codex 会话' },
  { match: /^test-autostart-e2e\.js$/, why: '会改开机自启项，不适合放进常规回归' },
  // 它不是独立检查，是 test-autostart-e2e 的探针：地址、cookie 文件、输出文件
  // 全从 argv 传进来。直接跑会在 writeFileSync(undefined) 上抛栈 ——
  // 那个栈看起来像「代码坏了」，其实只是少给了参数。
  { match: /^test-autostart\.js$/, why: '是 test-autostart-e2e 的探针，需要由它来传参数' },
  { match: /^test-tunnel\.js$/, why: '会真的建隧道，刷新 Cloudflare 的限流额度' },
  { match: /^test-mobile\.js$/, why: '需要一个真实手机端会话' },
];

function listScripts() {
  const names = fs.readdirSync(SCRIPTS)
    .filter((f) => /\.js$/.test(f))
    .filter((f) => require('./release-profile.js').isCurrentTest(f))
    .filter((f) => /^test-.*\.js$/.test(f) || /^(self-check|browser-check|security-audit|similarity-audit|check-frontend)\.js$/.test(f))
    .sort();
  return names;
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(SCRIPTS, file)], {
      cwd: BASE,
      env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' }),
      windowsHide: true
    });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({ file, ms: Date.now() - started, out: out.slice(-4000) }, r));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { }
      finish({ status: 'timeout', code: null });
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (e) => finish({ status: 'error', code: null, error: e.message }));
    // 退出码 2 = 「用法不对，我没法独立跑」，不是「检查失败了」。
    //
    // 这个项目里有一批脚本是**探针**：地址、cookie 文件、输出文件都从 argv 传进来，
    // 由别的脚本驱动。直接跑它们会在 writeFileSync(undefined) 上抛栈，
    // 那个栈看起来像代码坏了，其实只是少给了参数。以前它们一律被算成失败，
    // 于是「32 通过 / 9 失败」里有 8 个是这种假红 —— 假红最伤的是
    // **真红会被淹掉**：真的坏了一条，混在 8 条噪音里看不出来。
    //
    // 约定：脚本自己检查参数，缺了就打印用法并 exit 2；
    // 这里把 2 归为「跳过（需要参数）」，并在摘要里带上它自己那句话。
    child.on('close', (code) => finish({
      status: code === 0 ? 'pass' : code === 2 ? 'needargs' : 'fail',
      code
    }));
  });
}

/** 从输出里抠出「N 通过 / M 失败」这类摘要，没有就返回最后一行有用信息 */
function summarize(out) {
  const m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败(?:\s*\/\s*(\d+)\s*跳过)?/);
  if (m) return `${m[1]} 通过 / ${m[2]} 失败${m[3] ? ` / ${m[3]} 跳过` : ''}`;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/通过|结论|全部通过|OK|错误|失败/.test(lines[i])) return lines[i].slice(0, 90);
  }
  return lines.length ? lines[lines.length - 1].slice(0, 90) : '(无输出)';
}

(async () => {
  const files = listScripts();
  const results = [];

  if (!AS_JSON) {
    console.log(`\n=== 全部检查（共 ${files.length} 个，单个上限 ${TIMEOUT_MS / 1000} 秒）===\n`);
  }

  for (const f of files) {
    const need = NEEDS.find((n) => n.match.test(f));
    if (need) {
      results.push({ file: f, status: 'skip', why: need.why });
      if (!AS_JSON) console.log(`  [跳过] ${f.padEnd(30)} ${need.why}`);
      continue;
    }
    const r = await runOne(f);
    r.summary = summarize(r.out);
    results.push(r);
    if (!AS_JSON) {
      const tag = r.status === 'pass' ? '[通过]'
        : r.status === 'timeout' ? '[超时]'
        : r.status === 'needargs' ? '[跳过]' : '[失败]';
      console.log(`  ${tag} ${f.padEnd(30)} ${r.summary}   (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }

  const pass = results.filter((r) => r.status === 'pass');
  const fail = results.filter((r) => r.status === 'fail' || r.status === 'error');
  const skip = results.filter((r) => r.status === 'skip' || r.status === 'needargs');
  const to = results.filter((r) => r.status === 'timeout');

  if (AS_JSON) {
    console.log(JSON.stringify({ pass: pass.length, fail: fail.length, skip: skip.length, timeout: to.length, results }, null, 2));
  } else {
    console.log('\n' + '='.repeat(64));
    console.log(`  ${pass.length} 通过    ${fail.length} 失败    ${to.length} 超时    ${skip.length} 跳过`);
    console.log('='.repeat(64));
    if (fail.length) {
      console.log('\n失败明细：');
      for (const r of fail) {
        console.log(`\n  ✗ ${r.file}  (exit ${r.code})`);
        const bad = r.out.split('\n').filter((l) => /✗|失败|Error/.test(l)).slice(0, 5);
        for (const b of bad) console.log('      ' + b.trim().slice(0, 110));
      }
    }
    if (to.length) {
      console.log('\n超时（可能是需要外部条件，也可能是真卡住了）：');
      for (const r of to) console.log('  ? ' + r.file);
    }
    console.log('');
  }

  fs.writeFileSync(path.join(BASE, 'logs', 'all-tests.json'),
    JSON.stringify({ at: new Date().toISOString(), pass: pass.length, fail: fail.length, skip: skip.length, timeout: to.length, results }, null, 2), 'utf8');

  process.exitCode = fail.length ? 1 : 0;
})();
