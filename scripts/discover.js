// 找 DSH 当前在哪个端口上。
//
// DSH 每次启动都换一个随机端口，而它只把端口写在自己的启动日志里：
//   一行 `dsh web: http://127.0.0.1:<port>/?token=...`，取最后一条就是当前实例。
//
// 单独抽成一个模块，是因为有两处要用：中间层（要跟住端口变化）和目标管理（要判断
// DSH 在不在跑）。各写一份正则的话，DSH 哪天改了日志格式就会只修好一处。
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(
  process.env.APPDATA || '',
  'DeepSeek Harness Desktop', 'logs', 'deepseek-harness-desktop.log'
);

/**
 * @returns {number|null} 当前端口；读不到返回 null（调用方应沿用上一次的值）
 */
function discoverDshPort(logFile = LOG_FILE) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const found = [...text.matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/g)];
    if (found.length) return Number(found[found.length - 1][1]);
  } catch (err) {
    // 读不到就返回 null，让调用方沿用旧值 —— 不影响已经建立的连接
  }
  return null;
}

module.exports = { discoverDshPort, LOG_FILE };
