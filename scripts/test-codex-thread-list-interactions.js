'use strict';
// Exercise the real phone page in a browser while the Codex RPC is mocked.
// No live conversation is opened or modified.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser } = require('./browser-check.js');
const root = path.resolve(__dirname, '..');

function bootstrap() {
  const row = (id, name) => ({ id, name, cwd: 'D:/fixture', updatedAt: new Date().toISOString() });
  window.fixture = { messages: [], slowOlder: false };
  window.WebSocket = class {
    constructor() {
      this.readyState = 1;
      fixture.socket = this;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    emit(message) { if (this.onmessage) this.onmessage({ data: JSON.stringify(message) }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (!m.method || m.id === undefined) return;
      fixture.messages.push(m);
      let result = {};
      let delay = 0;
      if (m.method === 'thread/list') {
        const p = m.params || {};
        if (p.searchTerm === 'forgotten') {
          result = p.cursor ? { data: [row('forgotten-last', 'forgotten last')], nextCursor: null } :
            { data: [row('forgotten-first', 'forgotten first')], nextCursor: 'forgotten-next' };
        } else if (p.searchTerm === 'alpha') {
          result = { data: [row('alpha-id', 'alpha result')], nextCursor: null };
          delay = 700;
        } else if (p.searchTerm === 'beta') {
          result = { data: [row('beta-id', 'beta result')], nextCursor: null };
        } else if (p.cursor === 'older-cursor') {
          result = { data: Array.from({ length: 60 }, (_, i) => row('older-' + i, 'Older ' + i)), nextCursor: null };
          if (fixture.slowOlder) delay = 300;
        } else {
          result = { data: Array.from({ length: 60 }, (_, i) => row('recent-' + i, 'Recent ' + i)), nextCursor: 'older-cursor' };
        }
      } else if (['model/list', 'thread/turns/list', 'thread/items/list'].includes(m.method)) {
        result = { data: [], nextCursor: null };
      } else if (m.method === 'thread/read') {
        result = { thread: { id: m.params.threadId, status: { type: 'notLoaded' } } };
      } else if (m.method === 'thread/loaded/list') {
        result = { data: [] };
      }
      setTimeout(() => this.emit({ id: m.id, result }), delay);
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  };
}

(async () => {
  let browser, page, passed = 0, failed = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/codex/threads')) {
      // Arrives after the direct RPC and the second page. It must not erase them.
      return setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, list: [{ id: 'stale-cache', name: 'Stale cache', cwd: 'D:/fixture' }] }));
      }, 650);
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
    throw new Error('Timed out waiting for UI');
  };
  const check = async (name, fn) => {
    const ok = await E(fn);
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (ok) passed++; else failed++;
  };
  try {
    browser = await Browser.launch();
    page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + bootstrap.toString() + ')()' });
    await page.goto('http://127.0.0.1:' + server.address().port, 500);
    await wait(() => state.listReady && state.threads.length === 60);
    await check('first screen stays at 60 and offers older conversations', () =>
      document.querySelectorAll('#thlist .item').length === 60 &&
      document.getElementById('thread-list-more')?.textContent.includes(t('加载更早的会话')));

    await E(() => { document.getElementById('thread-list-more').click(); loadOlderThreads(); });
    await wait(() => state.threads.length === 120);
    await check('second page is appended once with one cursor request', () =>
      state.threads.length === 120 && document.querySelectorAll('#thlist .item').length === 120 &&
      fixture.messages.filter(x => x.method === 'thread/list' && x.params.cursor === 'older-cursor').length === 1);
    await new Promise(resolve => setTimeout(resolve, 720));
    await check('late gateway cache cannot erase older pages', () =>
      state.threads.length === 120 && !state.threads.some(x => x.id === 'stale-cache'));

    await E(() => {
      const input = document.getElementById('q');
      input.value = 'forgotten';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await check('search does not falsely report zero while global lookup runs', () =>
      document.getElementById('thlist').textContent.includes(t('正在搜索所有会话标题…')));
    await wait(() => state.searchReady && state.searchThreads.length === 1);
    await check('old title outside loaded pages is found', () =>
      document.getElementById('thlist').textContent.includes('forgotten first') &&
      document.getElementById('thread-list-scope').textContent.includes(t('已搜索所有会话标题；预览仅搜索已加载的 {n} 条', { n: 120 })));
    await E(() => document.getElementById('thread-list-more').click());
    await wait(() => state.searchThreads.length === 2);
    await check('older title search results can also be paged', () =>
      document.getElementById('thlist').textContent.includes('forgotten last') &&
      !document.getElementById('thread-list-more'));

    await E(() => {
      const input = document.getElementById('q');
      input.value = 'alpha'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(() => fixture.messages.some(x => x.method === 'thread/list' && x.params.searchTerm === 'alpha'));
    await E(() => {
      const input = document.getElementById('q');
      input.value = 'beta'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(() => state.searchReady && state.searchThreads[0]?.id === 'beta-id');
    await new Promise(resolve => setTimeout(resolve, 780));
    await check('late results from an earlier search cannot replace the current query', () =>
      document.getElementById('q').value === 'beta' && state.searchThreads[0].id === 'beta-id' &&
      !document.getElementById('thlist').textContent.includes('alpha result'));

    await E(() => {
      const input = document.getElementById('q');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
      loadThreads();
    });
    await wait(() => state.listReady && state.threads.length === 60);
    await E(() => {
      fixture.slowOlder = true;
      document.getElementById('thread-list-more').click();
      document.querySelector('#thlist .item').click();
    });
    await wait(() => state.view === 'thread');
    await new Promise(resolve => setTimeout(resolve, 380));
    await check('older-list response cannot replace a newly opened conversation', () =>
      state.view === 'thread' && state.thread?.id === 'recent-0' &&
      !document.getElementById('thlist'));
    await check('no horizontal overflow on phone viewport', () => document.documentElement.scrollWidth <= innerWidth);
  } catch (err) {
    console.error(err.stack || err);
    failed++;
  } finally {
    if (page) page.close();
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} browser.ws.close(); browser.proc.kill(); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`Codex thread-list interactions: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
