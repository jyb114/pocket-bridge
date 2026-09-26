// 验证注入是否真的出现在真实 DSH 页面里（不靠内部函数，发真实请求）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();

function get(p, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: p, headers },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers,
          body: Buffer.concat(c).toString('utf8')
        }));
      });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

(async () => {
  const enter = await get(`/k/${KEY}`);
  const cookie = String(enter.headers['set-cookie'] || '').split(';')[0];
  console.log(`密钥入口: HTTP ${enter.status}  cookie: ${cookie.split('=')[0]}`);

  const page = await get('/', { cookie });
  console.log(`工作台页面: HTTP ${page.status}  ${Buffer.byteLength(page.body)} 字节`);

  let allIn = true;
  for (const tag of ['/polyfill.js', '/compat.js', '/route.js', '/boot.js']) {
    const yes = page.body.includes(tag);
    if (!yes) allIn = false;
    console.log(`  ${tag.padEnd(15)} 已注入: ${yes ? '是' : '否'}`);
  }

  const i = page.body.indexOf('<head');
  console.log('\n注入位置：');
  console.log(page.body.slice(i, i + 300).replace(/></g, '>\n<'));

  // 注入的脚本必须真的能取到，否则页面会 404 一片
  console.log('\n注入的脚本可获取性：');
  for (const tag of ['/polyfill.js', '/compat.js', '/route.js', '/boot.js']) {
    const r = await get(tag);
    console.log(`  ${tag.padEnd(15)} HTTP ${r.status}  ${r.status === 200 ? Buffer.byteLength(r.body) + ' 字节' : r.error || ''}`);
  }

  console.log(`\n结论: 注入${allIn ? '完整' : '不完整'}`);
  process.exitCode = allIn ? 0 : 1;
})();
