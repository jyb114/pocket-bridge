'use strict';

// Full production adapter with a controlled proof promise, browser visibility,
// WebSocket and clock. No browser, real network, credentials or DSH is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-adapter.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const sockets = [], timers = new Map(), handlers = new Set(), events = [];
  let timerId = 0, proof = Promise.resolve(true), holdBaseline = false;
  class Socket {
    constructor(url) {
      assert.equal(url, 'wss://fixture.test/api/remote.mux');
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen();
      });
    }
    send(raw) {
      const wire = JSON.parse(raw);
      this.sent.push(wire);
      if (wire.type !== 'open') return;
      let value;
      if (wire.endpoint === '$events') value = { type: 'ready', clientId: 'fixture-client' };
      if (wire.endpoint === 'workspace/follow' && !holdBaseline) value = { type: 'baseline', value: { items: [
        { workspaceId: 'p', title: 'Fixture', sessionIds: ['A'] }
      ] } };
      if (wire.endpoint === 'session/follow') value = { type: 'snapshot', records: [],
        cursor: -1, hasMore: false, assistantStream: { revision: 0 } };
      if (value) queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        type: 'item', streamId: wire.streamId, value
      }) }));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }
  const document = {
    visibilityState: 'visible', dispatchEvent() {},
    addEventListener(type, handler) { assert.equal(type, 'visibilitychange'); handlers.add(handler); },
    removeEventListener(type, handler) { assert.equal(type, 'visibilitychange'); handlers.delete(handler); }
  };
  const runtime = {
    WebSocket: Socket, Map, Promise, Uint8Array, DataView, TextEncoder, Blob, Event: class {},
    document, location: { protocol: 'https:', host: 'fixture.test' },
    crypto: { randomUUID: () => 'owned-fixture' }, __dshE2eeSecret: 'fixture-only',
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    DshE2EE: {
      available: () => true, prove: () => proof,
      encryptedFetch: async () => ({ status: 200, ok: true,
        json: async () => ({ result: { ok: true, value: { items: [] } } }) })
    }
  };
  runtime.window = runtime;
  vm.runInNewContext(source, runtime, { filename: 'dsh-lite-adapter.js' });
  const api = runtime.DshLiteAdapter;
  const f = {
    api, sockets, events, timers,
    connect: () => api.connect(event => events.push(event)),
    async ready() { await f.connect(); await api.loadSession('A'); await flush(); },
    visible(value) {
      document.visibilityState = value ? 'visible' : 'hidden';
      for (const handler of handlers) handler();
    },
    holdProof() {
      let resolve, reject;
      proof = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { resolve, reject };
    },
    proofOkay() { proof = Promise.resolve(true); },
    holdBaseline(value) { holdBaseline = value; },
    expireInitial() {
      const deadlines = [...timers].filter(([, timer]) => timer.ms === 45000);
      assert.equal(deadlines.length, 1, 'foreground initial load retains its 45-second deadline');
      const [id, timer] = deadlines[0]; timers.delete(id); timer.fn();
    },
    retry() {
      const retries = [...timers].filter(([, timer]) => timer.ms <= 8000);
      assert.equal(retries.length, 1, 'exactly one bounded-backoff retry is scheduled');
      const [id, timer] = retries[0]; timers.delete(id); timer.fn();
    },
    open() { return sockets.filter(socket => socket.readyState === 1); },
    restored() {
      assert.equal(f.open().length, 1, 'only one live socket');
      const follows = f.open()[0].sent.filter(wire => wire.endpoint === 'session/follow');
      assert.equal(follows.length, 1, 'current conversation is resubscribed exactly once');
      assert.equal(follows[0].payload.args.request.address.sessionId, 'A');
      assert.equal(events.filter(event => event.type === 'status').at(-1).state, 'connected');
    },
    clean() {
      api.disconnect();
      assert.equal(f.open().length, 0, 'disconnect closes every socket created by this adapter');
      assert.equal(timers.size, 0, 'no retry or initial/session timer survives disconnect');
      assert.equal(handlers.size, 0, 'visibility listener is removed');
    }
  };
  return f;
}

function finish(pending, outcome) {
  if (outcome === 'error') pending.reject(new Error('synthetic proof failure'));
  else pending.resolve(outcome === 'success');
}

(async () => {
  let passed = 0;
  async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
  await check('shared proof after repeated foreground cycles creates one owned replacement', async () => {
    const f = fixture();
    try {
      await f.ready();
      const pending = f.holdProof(); f.sockets[0].close(); f.retry();
      for (let i = 0; i < 3; i++) { f.visible(false); f.visible(true); f.retry(); }
      pending.resolve(true); await flush();
      assert.equal(f.sockets.length, 2, 'superseded proof waiters never construct sockets');
      assert.equal(f.timers.size, 0); f.restored();
    } finally { f.clean(); }
  });

  for (const outcome of ['success', 'false', 'error']) {
    for (const staleFirst of [true, false]) {
      await check('superseded ' + outcome + ' / ' + (staleFirst ? 'stale-first' : 'current-first'), async () => {
        const f = fixture();
        try {
          await f.ready();
          const old = f.holdProof(); f.sockets[0].close(); f.retry();
          f.visible(false); f.visible(true);
          const current = f.holdProof(); f.retry();
          if (staleFirst) {
            finish(old, outcome); await flush();
            assert.equal(f.sockets.length, 1, 'old proof cannot create a socket');
            assert.equal(f.timers.size, 0, 'old failure cannot create another retry');
          }
          current.resolve(true); await flush();
          f.restored();
          if (!staleFirst) {
            const before = JSON.stringify(f.events);
            finish(old, outcome); await flush();
            assert.equal(JSON.stringify(f.events), before, 'old proof cannot change current status');
          }
          assert.equal(f.sockets.length, 2); assert.equal(f.timers.size, 0); f.restored();
        } finally { f.clean(); }
      });
    }
    await check('hidden page rejects late ' + outcome + ' and resumes with one connection', async () => {
      const f = fixture();
      try {
        await f.ready();
        const pending = f.holdProof(); f.sockets[0].close(); f.retry(); f.visible(false);
        const before = JSON.stringify(f.events);
        finish(pending, outcome); await flush();
        assert.equal(f.sockets.length, 1); assert.equal(f.open().length, 0);
        assert.equal(f.timers.size, 0, 'no background retry');
        assert.equal(JSON.stringify(f.events), before);
        f.proofOkay(); f.visible(true); f.retry(); await flush(); f.restored();
      } finally { f.clean(); }
    });
  }

  await check('current failed proof still retries and restores the session', async () => {
    const f = fixture();
    try {
      await f.ready();
      const first = f.holdProof(); f.sockets[0].close(); f.retry();
      first.resolve(false); await flush();
      const second = f.holdProof(); f.retry(); second.reject(new Error('synthetic')); await flush();
      f.proofOkay(); f.retry(); await flush(); f.restored();
      assert.equal(f.sockets.length, 2);
    } finally { f.clean(); }
  });

  await check('disconnect fences a pending proof even after an explicit new connection', async () => {
    const f = fixture();
    try {
      await f.ready();
      const old = f.holdProof(); f.sockets[0].close(); f.retry(); f.clean();
      f.proofOkay(); await f.ready();
      const before = JSON.stringify(f.events);
      old.resolve(true); await flush();
      assert.equal(f.sockets.length, 2); assert.equal(JSON.stringify(f.events), before); f.restored();
    } finally { f.clean(); }
  });

  await check('initial proof completing while hidden waits for foreground without opening a socket', async () => {
    const f = fixture();
    try {
      const pending = f.holdProof(), connecting = f.connect();
      f.visible(false); pending.resolve(true); await flush();
      assert.equal(f.sockets.length, 0);
      assert.equal(f.timers.size, 0, 'even a long hidden stay cannot expire the initial load');
      f.visible(true); f.retry(); await connecting; await flush();
      assert.equal(f.open().length, 1); assert.equal(f.timers.size, 0);
    } finally { f.clean(); }
  });
  await check('background pauses an initial baseline deadline and foreground resumes it', async () => {
    const f = fixture();
    try {
      f.holdBaseline(true);
      const connecting = f.connect(); await flush();
      assert.equal([...f.timers.values()].filter(timer => timer.ms === 45000).length, 1);
      f.visible(false);
      assert.equal(f.timers.size, 0, 'no initial deadline runs while hidden beyond 45 seconds');
      f.holdBaseline(false); f.visible(true);
      assert.equal([...f.timers.values()].filter(timer => timer.ms === 45000).length, 1);
      f.retry(); await connecting; await flush();
      assert.equal(f.open().length, 1); assert.equal(f.timers.size, 0);
    } finally { f.clean(); }
  });
  await check('foreground initial timeout cancels retries and fences delayed recovery proof', async () => {
    const f = fixture();
    try {
      f.holdBaseline(true);
      const connecting = f.connect();
      const rejected = assert.rejects(connecting, /加载项目超时/);
      await flush();
      const pending = f.holdProof(); f.sockets[0].close(); f.retry();
      f.expireInitial(); await rejected;
      assert.equal(f.timers.size, 0);
      pending.resolve(true); await flush();
      assert.equal(f.sockets.length, 1); assert.equal(f.open().length, 0);
      f.visible(false); f.visible(true);
      assert.equal(f.timers.size, 0, 'timed-out connection needs an explicit new connect');
    } finally { f.clean(); }
  });
  console.log('DSH reconnect races: ' + passed + ' full-adapter scenarios passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
