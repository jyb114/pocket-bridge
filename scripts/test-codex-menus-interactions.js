'use strict';
// Real mobile-sized browser clicks against an isolated Codex RPC fixture.
// No personal conversation is renamed, archived, or opened on the live service.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser } = require('./browser-check.js');
const root = path.resolve(__dirname, '..');

function bootstrap() {
  window.fixture = { messages: [], renameCount: 0, archiveCount: 0, nativeDialogs: [], fileClicks: [] };
  window.prompt = function () { fixture.nativeDialogs.push('prompt'); throw new Error('Native prompt must not be used'); };
  window.confirm = function () { fixture.nativeDialogs.push('confirm'); throw new Error('Native confirm must not be used'); };
  const originalClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file') { fixture.fileClicks.push(this.id); return; }
    return originalClick.call(this);
  };
  window.WebSocket = class {
    constructor() { this.readyState = 1; fixture.socket = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    emit(message) { if (this.onmessage) this.onmessage({ data: JSON.stringify(message) }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (!m.method || m.id === undefined) return;
      fixture.messages.push(m);
      let result = {}, error = null;
      if (m.method === 'thread/list') {
        result = { data: [{ id: 'menu-thread', name: 'Original name', cwd: 'D:/fixture', updatedAt: new Date().toISOString() }], nextCursor: null };
      } else if (m.method === 'thread/name/set') {
        fixture.renameCount++;
        if (fixture.renameCount === 1) error = { code: -32000, message: 'temporary rename error' };
      } else if (m.method === 'thread/archive') {
        fixture.archiveCount++;
        if (fixture.archiveCount === 1) error = { code: -32000, message: 'temporary archive error' };
      } else if (m.method === 'thread/start') {
        result = { thread: { id: 'new-project-thread', cwd: m.params.cwd } };
      } else if (['model/list', 'thread/items/list', 'thread/turns/list', 'thread/loaded/list'].includes(m.method)) {
        result = { data: [], nextCursor: null };
      } else if (m.method === 'thread/read') {
        result = { thread: { id: m.params.threadId, status: { type: 'notLoaded' } } };
      }
      setTimeout(() => this.emit(error ? { id: m.id, error } : { id: m.id, result }), 0);
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  };
}

(async () => {
  let browser, page, passed = 0, failed = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/codex/threads')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, list: [{ id: 'menu-thread', name: 'Original name', cwd: 'D:/fixture' }] }));
    }
    if (req.url.startsWith('/codex/queue')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"entries":[]}');
    }
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(root, 'pwa', name);
    if (name && file.startsWith(path.join(root, 'pwa') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain');
      return res.end(fs.readFileSync(file));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, 'pwa/codex.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const E = fn => page.eval('(' + fn.toString() + ')()');
  const wait = async (fn, ms = 2500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await E(fn)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for menu UI');
  };
  const check = async (name, fn) => {
    const ok = await E(fn);
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (ok) passed++; else failed++;
  };
  const clickRow = label => E(new Function('return Array.from(document.querySelectorAll("#sheetInner .srow")).find(x => x.querySelector(".k")?.textContent === t(' + JSON.stringify(label) + '))?.click()'));
  try {
    browser = await Browser.launch();
    page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + bootstrap.toString() + ')()' });
    await page.goto('http://127.0.0.1:' + server.address().port, 500);
    await wait(() => state.listReady && document.querySelector('#thlist .item'));
    await E(() => document.querySelector('#thlist .item').click());
    await wait(() => state.view === 'thread');

    await E(() => document.getElementById('menu').click());
    await clickRow('重命名这个会话');
    await check('rename opens an editable in-page panel with current name', () =>
      document.getElementById('rename-input')?.value === 'Original name' &&
      fixture.messages.filter(x => x.method === 'thread/name/set').length === 0 && fixture.nativeDialogs.length === 0);
    await E(() => document.querySelector('#sheetInner .sclose').click());
    await check('cancel rename returns to menu without sending', () =>
      !document.getElementById('rename-input') && fixture.renameCount === 0);

    await clickRow('重命名这个会话');
    await E(() => { document.getElementById('rename-input').value = '  '; document.getElementById('rename-save').click(); });
    await check('empty name is rejected inline before RPC', () =>
      !document.getElementById('rename-error').hidden && fixture.renameCount === 0);
    await E(() => { document.getElementById('rename-input').value = 'Better name'; document.getElementById('rename-save').click(); });
    await wait(() => fixture.renameCount === 1 && !document.getElementById('rename-save').disabled);
    await check('rename failure preserves input and offers retry', () =>
      document.getElementById('rename-input').value === 'Better name' &&
      document.getElementById('rename-error').textContent.includes('temporary rename error'));
    await E(() => document.getElementById('rename-save').click());
    await wait(() => fixture.renameCount === 2 && state.thread.name === 'Better name');
    await check('rename retry updates title and closes the sheet', () =>
      document.getElementById('title').textContent === 'Better name' &&
      !document.getElementById('sheet').classList.contains('on') && fixture.nativeDialogs.length === 0);

    await E(() => document.getElementById('menu').click());
    await clickRow('项目');
    await check('project sub-menu offers a manually entered folder', () =>
      !!document.getElementById('project-other-folder') &&
      document.getElementById('project-other-folder').textContent.includes(t('其他文件夹（手输绝对路径）')));
    await E(() => document.getElementById('project-other-folder').click());
    await check('other folder opens path picker without starting a conversation', () =>
      document.querySelector('#sheetInner input[type=text]') &&
      fixture.messages.filter(x => x.method === 'thread/start').length === 0);
    await E(() => {
      document.querySelector('#sheetInner input[type=text]').value = 'D:/other-project';
      Array.from(document.querySelectorAll('#sheetInner button')).find(x => x.textContent === t('使用此文件夹新建')).click();
    });
    await wait(() => state.thread?.id === 'new-project-thread');
    await check('manual project path is sent exactly once', () =>
      fixture.messages.filter(x => x.method === 'thread/start' && x.params.cwd === 'D:/other-project').length === 1);

    await E(() => document.getElementById('btn-attach').click());
    await check('attachment menu clearly separates conversation action', () => {
      const inner = document.getElementById('sheetInner');
      const sep = document.getElementById('new-thread-separator');
      return !!sep && sep.textContent.includes(t('会话操作（不是附件）')) &&
        Array.from(inner.children).indexOf(sep) > Array.from(inner.children).indexOf(document.getElementById('choose-file')) &&
        Array.from(inner.children).indexOf(sep) < Array.from(inner.children).indexOf(document.getElementById('choose-new'));
    });
    await E(() => document.getElementById('choose-image').click());
    await check('image option still reaches image chooser', () => fixture.fileClicks.includes('pick-images') && !document.getElementById('sheet').classList.contains('on'));
    await E(() => { document.getElementById('btn-attach').click(); document.getElementById('choose-file').click(); });
    await check('file option still reaches file chooser', () => fixture.fileClicks.includes('pick-files') && !document.getElementById('sheet').classList.contains('on'));
    await E(() => { document.getElementById('btn-attach').click(); document.getElementById('choose-new').click(); });
    await check('new conversation opens project picker, never a file chooser', () =>
      document.getElementById('sheet').classList.contains('on') &&
      document.querySelector('#sheetInner input[type=text]') && fixture.fileClicks.length === 2);
    await E(() => document.querySelector('#sheetInner .sclose').click());

    await E(() => { document.getElementById('back').click(); document.querySelector('#thlist .item').click(); document.getElementById('menu').click(); });
    await clickRow('归档这个会话');
    await check('archive opens explanation without archiving immediately', () =>
      !!document.getElementById('archive-confirm') &&
      document.getElementById('sheetInner').textContent.includes(t('归档之后它会从列表里消失（不会删除）。')) &&
      fixture.archiveCount === 0 && fixture.nativeDialogs.length === 0);
    await E(() => document.querySelector('#sheetInner .sclose').click());
    await check('cancel archive leaves conversation active', () => state.view === 'thread' && fixture.archiveCount === 0);
    await clickRow('归档这个会话');
    await E(() => document.getElementById('archive-confirm').click());
    await wait(() => fixture.archiveCount === 1 && !document.getElementById('archive-confirm').disabled);
    await check('archive failure remains on confirmation panel for retry', () =>
      document.getElementById('archive-error').textContent.includes('temporary archive error'));
    await E(() => document.getElementById('archive-confirm').click());
    await wait(() => fixture.archiveCount === 2 && state.view === 'list');
    await check('confirmed archive returns to list without native dialogs', () =>
      !document.getElementById('sheet').classList.contains('on') && fixture.nativeDialogs.length === 0);
    await check('no horizontal overflow on phone viewport', () => document.documentElement.scrollWidth <= innerWidth);
    await wait(() => !!document.querySelector('#thlist .item'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
    await E(() => {
      document.querySelector('#thlist .item').click();
      state.thread.name = 'A_very_long_unbroken_conversation_name_that_should_wrap_inside_the_panel';
      document.getElementById('menu').click();
      Array.from(document.querySelectorAll('#sheetInner .srow'))
        .find(x => x.querySelector('.k')?.textContent === t('重命名这个会话')).click();
    });
    await check('long rename title fits the 320px phone panel', () =>
      !!document.getElementById('rename-input') && document.documentElement.scrollWidth <= innerWidth);
  } catch (err) {
    console.error(err.stack || err);
    failed++;
  } finally {
    if (page) page.close();
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} browser.ws.close(); browser.proc.kill(); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`Codex menu interactions: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
