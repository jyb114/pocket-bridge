'use strict';
// Local Chromium fixture with real mobile UI/translation code. All application
// transport is mocked; neither a gateway nor a public tunnel is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module); isolated.filename = browserFile; isolated.paths = module.paths;
isolated._compile(fs.readFileSync(browserFile, 'utf8').replace('    sweepOrphanBrowsers();', '    // Isolated fixture never sweeps other browser processes.'), browserFile);
const { Browser } = isolated.exports;
const fixtureScript = `
window.__proofReady = !location.search.includes('notready');
window.__backup = {enabled:true,supported:true,requested:true,backup:{phase:'ready',reachable:true,generation:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',origin:'https://fixture-backup.trycloudflare.com',url:'https://fixture-backup.trycloudflare.com/dsh-lite',checkedAt:Date.now()}};
window.__backupReads = 0; window.__copied = []; window.__opened = [];
window.__dshE2eeSecret = 'SYNTHETIC_BROWSER_FIXTURE_KEY';
window.WebSocket.__dshE2ee = true;
window.DshE2EE = {available:()=>true,proofState:()=>({ok:window.__proofReady}), encryptedFetch:async(secret,path,init)=>{
  if(path!=='/__dsh/lite-addresses') throw Error('Unexpected fixture route');
  window.__backupReads++;
  if(window.__readFailure) throw Error('Synthetic offline');
  return new Response(JSON.stringify({ok:true,tunnels:window.__backup}),{headers:{'content-type':'application/json','x-dsh-e2ee-decrypted':'1'}});
}};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.__clipboardDenied)throw Error('denied');window.__copied.push(value);}}});
window.open=(...args)=>{window.__opened.push(args);return null;};
window.fetch=async(path)=>{
  if(path==='/__deepseek/balance')return new Response('{}',{headers:{'content-type':'application/json'}});
  throw Error('Unexpected fixture fetch');
};
window.DshLiteAdapter={capabilities:{},connect:async cb=>cb({type:'status',state:'connected'}),disconnect:async()=>{},listProjects:async()=>[],listSessions:async()=>[]};
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const requested = [];
  const html = fs.readFileSync(path.join(root, 'pwa/dsh-lite.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</head>',
    '<script src="/i18n.js" defer></script><script src="/dsh-lite-lang.js" defer></script><script src="/fixture.js" defer></script><script src="/dsh-lite-ui.js" defer></script></head>');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname; requested.push(pathname);
    const headers = { 'cache-control': 'no-store' };
    if (pathname === '/app') { res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (pathname === '/other') { res.writeHead(200, { ...headers, 'content-type': 'text/html' }); res.end('<!doctype html><title>Other fixture</title><p>Local navigation fixture</p>'); return; }
    if (pathname === '/fixture.js') { res.writeHead(200, { ...headers, 'content-type': 'application/javascript' }); res.end(fixtureScript); return; }
    if (['/i18n.js', '/dsh-lite-lang.js', '/dsh-lite-ui.js', '/dsh-lite.css', '/pocket-bridge.svg'].includes(pathname)) {
      res.writeHead(200, { ...headers, 'content-type': pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript' });
      res.end(fs.readFileSync(path.join(root, 'pwa', pathname.slice(1)))); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await Browser.launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    const page = await browser.newPage();
    async function until(expression) {
      const end = Date.now() + 6000;
      while (Date.now() < end) { if (await page.eval(expression)) return; await sleep(30); }
      throw Error('Timed out: ' + expression);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
    await page.goto(base + '/app', 300);
    await until(`document.getElementById('dsh-lite-backup-settings')`);
    assert.equal(await page.eval(`!!document.getElementById('dsh-lite-backup-dialog')`), false, 'initial navigation has an optional entry without auto-modal');
    await page.eval(`document.getElementById('dsh-lite-backup-settings').click()`);
    await until(`document.getElementById('dsh-lite-backup-copy') && !document.getElementById('dsh-lite-backup-copy').disabled`);
    assert.equal(await page.eval(`document.getElementById('app').inert`), true);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await until(`!document.getElementById('dsh-lite-backup-dialog')`);
    assert.equal(await page.eval(`document.activeElement.id`), 'rail-settings', 'Escape returns focus to an available control');
    await page.send('Page.reload');
    await until(`document.getElementById('dsh-lite-backup-copy') && !document.getElementById('dsh-lite-backup-copy').disabled`);
    assert.equal(await page.eval(`performance.getEntriesByType('navigation')[0].type`), 'reload');
    assert.equal(await page.eval(`document.getElementById('dsh-lite-backup-dialog').getAttribute('role')`), 'dialog');
    assert.equal(await page.eval(`document.documentElement.scrollWidth <= innerWidth`), true, '320px fixture has no horizontal overflow');
    await page.eval(`document.getElementById('dsh-lite-backup-check').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await page.eval(`document.activeElement.closest('.screen-bar') !== null`), true, 'Tab wraps inside dialog');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    assert.equal(await page.eval(`document.activeElement.id`), 'dsh-lite-backup-check', 'Shift+Tab wraps to the final enabled action');
    for (const lang of ['zh', 'en', 'es']) {
      await page.eval(`window.DshI18n.setLang(${JSON.stringify(lang)})`);
      const copyLabel = await page.eval(`document.getElementById('dsh-lite-backup-copy').textContent`);
      assert.equal(copyLabel, { zh: '复制当前备用地址', en: 'Copy current backup address', es: 'Copiar dirección de respaldo actual' }[lang]);
      if (lang !== 'zh') assert.doesNotMatch(await page.eval(`document.getElementById('dsh-lite-backup-dialog').textContent`), /[\u4e00-\u9fff]/);
    }
    await page.eval(`document.getElementById('dsh-lite-backup-copy').click()`);
    await until(`window.__copied.length === 1`);
    assert.deepEqual(await page.eval(`window.__copied`), ['https://fixture-backup.trycloudflare.com/dsh-lite']);
    await page.eval(`window.__clipboardDenied = true;document.getElementById('dsh-lite-backup-copy').click()`);
    await until(`document.getElementById('dsh-lite-backup-status').textContent.includes('no permitió')`);
    assert.equal(await page.eval(`document.getElementById('dsh-lite-backup-address').selectionEnd`), 'https://fixture-backup.trycloudflare.com/dsh-lite'.length);
    await page.eval(`window.__backup.backup.generation='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';window.__backup.backup.origin='https://replacement-backup.trycloudflare.com';window.__backup.backup.url=window.__backup.backup.origin+'/dsh-lite';document.getElementById('dsh-lite-backup-check').click()`);
    await until(`!document.getElementById('dsh-lite-backup-changed').hidden`);
    await page.eval(`window.__backup.backup.reachable=false;document.getElementById('dsh-lite-backup-check').click()`);
    await until(`document.getElementById('dsh-lite-backup-copy').disabled && document.getElementById('dsh-lite-backup-address').hidden`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await until(`!document.getElementById('dsh-lite-backup-dialog')`);
    await page.eval(`history.pushState({},'',location.pathname+'#fixture-route');window.dispatchEvent(new PopStateEvent('popstate'));document.getElementById('rail-reconnect').click();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);
    await sleep(750);
    assert.equal(await page.eval(`!!document.getElementById('dsh-lite-backup-dialog')`), false, 'SPA route, reconnect and bfcache cannot repeat modal');
    await page.goto(base + '/app?notready=1', 200); await page.send('Page.reload');
    await until(`document.getElementById('crypto-chip')`); await sleep(200);
    assert.equal(await page.eval(`window.__backupReads`), 0, 'reload waits for actual E2EE proof');
    await page.eval(`window.__proofReady=true;document.dispatchEvent(new Event('visibilitychange'))`);
    await until(`document.getElementById('dsh-lite-backup-copy') && !document.getElementById('dsh-lite-backup-copy').disabled`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await page.goto(base + '/other', 100);
    await page.eval(`history.back()`);
    await until(`location.pathname === '/app' && document.getElementById('dsh-lite-backup-settings')`);
    await sleep(250); assert.equal(await page.eval(`!!document.getElementById('dsh-lite-backup-dialog')`), false, 'real browser back navigation does not prompt');
    assert.equal(page.exceptions.length, 0, 'browser reports no uncaught exception');
    console.log('Backup mobile browser fixture passed: real refresh gating, auth wait, navigation/back/reconnect, focus trap/Escape, 320px layout, ZH/EN/ES, bare copying, denied clipboard and generation/unavailable states.');
  } finally {
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} try { browser.ws.close(); } catch (_) {} }
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
