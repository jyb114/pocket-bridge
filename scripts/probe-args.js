// 给「探针」脚本用的参数检查。
//
// 这个项目里有一批脚本不是能独立跑的检查，而是**探针**：
// 地址、访问密钥、cookie 文件、输出文件都从 argv 传进来，需要有人带着参数调。
// （仓库里已经找不到调用它们的脚本了，多半是早期手工排查时留下的；
//   但它们的探测逻辑还有价值，所以留着 —— 只是不该在回归里假装成失败。）
//
// 它们原来直接往下跑，于是在 writeFileSync(undefined) 上抛一个
// TypeError 栈 —— 那个栈看起来像代码坏了，其实只是少给了参数。
// 后果不只是难看：`run-all-tests.js` 把 8 个这样的脚本全算成失败，
// 「32 通过 / 9 失败」里 8 条是假红，**真红会被淹掉**。
//
// 约定：缺参数就打印用法并 **exit 2**。
// 2 和 1 的区别是「我没法跑」和「我跑了，结果是坏的」——
// run-all-tests.js 据此把前者归为跳过。
'use strict';

/**
 * @param {string[]} argv      process.argv
 * @param {string[]} names     位置参数的名字（从 argv[2] 开始）
 * @param {string}   usage     一行用法说明
 * @param {object}   [opts]    { optional: 允许为空的参数名 }
 */
function requireArgs(argv, names, usage, opts = {}) {
  const optional = new Set(opts.optional || []);
  const missing = names.filter((n, i) => !optional.has(n) && !argv[i + 2]);
  if (!missing.length) return;

  console.error(usage);
  console.error(`缺少参数: ${missing.join(', ')}`);
  console.error('（这是探针脚本，由别的脚本驱动，单独跑没有意义。）');
  process.exit(2);
}

module.exports = { requireArgs };
