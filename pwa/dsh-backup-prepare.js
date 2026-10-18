/* Explicit, origin-bound preparation. Credentials never enter a navigation URL,
 * clipboard, DOM text, window.name, local logs or cross-origin fetch. */
(function (win) {
  'use strict';
  var PREFIX = 'pocket-bridge-backup-';
  function randomNonce() {
    var bytes = new Uint8Array(24); win.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  function origin(value) {
    try { var u = new URL(value); return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
      /^[a-z0-9-]+\.trycloudflare\.com$/.test(u.hostname) && u.origin === value ? value : ''; } catch (_) { return ''; }
  }
  function tuple(value, expected) {
    return value && value.origin === expected.origin && value.generation === expected.generation &&
      value.bootId === expected.bootId && value.preparationId === expected.preparationId;
  }
  async function jsonRequest(path, body, e2ee, key, current) {
    var aborter = new win.AbortController(), timer;
    try {
      return await Promise.race([(async function () {
        var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: aborter.signal };
        var response = e2ee ? await e2ee.encryptedFetch(key, path, init) : await win.fetch(path, init);
        if (!current() || !response.ok || response.redirected || (response.url && response.url !== win.location.origin + path) ||
            (e2ee && (!response.headers || response.headers.get('x-dsh-e2ee-decrypted') !== '1' || response.headers.get('x-dsh-e2ee') === '1')))
          throw Error('unverified-response');
        var data = await response.json();
        if (!current() || !data || data.ok !== true) throw Error('unverified-response');
        return data;
      })(), new Promise(function (_resolve, reject) {
        timer = win.setTimeout(function () { aborter.abort(); reject(Error('timeout')); }, 10000);
      })]);
    } finally { win.clearTimeout(timer); }
  }
  function createSource(options) {
    var attempt = null, disposed = false, result = null, verifiedContext = null;
    function state(phase, message) { result = { phase: phase, message: message }; options.onState(result); }
    function current(a) { return !disposed && attempt === a && options.ready() && options.active() &&
      win.DshE2EE === a.e2ee && win.__dshE2eeSecret === a.key && options.context() === a.context &&
      !a.child.closed && Date.now() < a.deadline; }
    function stop(message, succeeded) {
      var a = attempt; attempt = null;
      if (a) {
        win.clearTimeout(a.timer);
        if (!succeeded) {
          try { if (a.port) a.port.postMessage({ type: PREFIX + 'cancel', nonce: a.nonce }); } catch (_) {}
          if (a.preparationId && win.DshE2EE === a.e2ee && win.__dshE2eeSecret === a.key) {
            jsonRequest('/__dsh/backup-prepare', { action: 'revoke', preparationId: a.preparationId }, a.e2ee, a.key,
              function () { return win.DshE2EE === a.e2ee && win.__dshE2eeSecret === a.key; }).catch(function () {});
          }
          try { a.child.close(); } catch (_) {}
        }
        if (succeeded) verifiedContext = { e2ee: a.e2ee, key: a.key, context: a.context };
        if (a.port) { a.port.onmessage = null; a.port.close(); }
        a.key = null;
      }
      state(succeeded ? 'prepared' : 'failed', message);
      if (succeeded && a) { result.origin = a.origin; result.generation = a.generation; options.onState(result); }
    }
    function pulse(a) {
      if (!current(a)) { if (attempt === a) stop('准备已取消或超时。请重新打开准备流程。'); return; }
      if (a.origin && (!a.sent || (a.receiverConfirmed && !a.keySent))) {
        try { var hello = { type: PREFIX + 'hello', nonce: a.nonce, challenge: a.challenge, generation: a.generation };
          if (a.receiverConfirmed && a.port) a.port.postMessage(hello); else a.child.postMessage(hello, a.origin); } catch (_) {}
      }
      a.timer = win.setTimeout(function () { pulse(a); }, 500);
    }
    async function message(event, portAttempt) {
      var a = attempt, data = event.data;
      if (!a || !current(a) || !data || data.nonce !== a.nonce) return;
      if (portAttempt) { if (portAttempt !== a || !a.port) return; }
      else if (event.source !== a.child || event.origin !== a.origin || data.type !== PREFIX + 'ready' || a.sent) return;
      if (data.type === PREFIX + 'ready' && data.challenge === a.challenge && data.generation === a.generation && portAttempt === a && a.receiverConfirmed && !a.keySent) {
        if (data.bootId !== a.bootId || data.preparationId !== a.preparationId) { stop('备用地址已更换。请重新准备。'); return; }
        a.keySent = true;
        try { a.port.postMessage({ type: PREFIX + 'key', nonce: a.nonce, challenge: a.challenge, key: a.key,
          preparationId: a.preparationId, bootId: a.bootId, origin: a.origin, generation: a.generation }); } catch (_) { stop('无法安全准备备用入口。请检查连接后重试。'); return; }
        state('verifying', '正在备用页面验证登录、加密和浏览器存储…');
      } else if (data.type === PREFIX + 'ready' && data.challenge === a.challenge && data.generation === a.generation && !a.sent) {
        if (a.issuing) return;
        if (!a.ticket) {
          a.issuing = true;
          try {
            a.proofChallenge = a.challenge;
            var issued = await jsonRequest('/__dsh/backup-prepare', { action: 'issue', origin: a.origin, generation: a.generation,
              nonce: a.nonce, challenge: a.proofChallenge },
              a.e2ee, a.key, function () { return current(a); });
            if (!current(a) || issued.origin !== a.origin || issued.generation !== a.generation || issued.bootId !== data.bootId || issued.nonce !== a.nonce || issued.challenge !== a.proofChallenge ||
                !/^[a-zA-Z0-9_-]{16,160}$/.test(issued.ticket || '') || !/^[a-zA-Z0-9_-]{16,160}$/.test(issued.preparationId || '') ||
                !Number.isFinite(issued.expiresAt) || issued.expiresAt <= Date.now() || issued.expiresAt > Date.now() + 60000)
              throw Error('target-changed');
            a.ticket = issued.ticket; a.preparationId = issued.preparationId; a.bootId = issued.bootId;
            a.deadline = Math.min(a.deadline, issued.expiresAt); a.challenge = randomNonce();
            // A second current receiver acknowledgement follows issuance. A
            // readiness event from before a navigation cannot authorize transfer.
            a.issuing = false;
            a.child.postMessage({ type: PREFIX + 'hello', nonce: a.nonce, challenge: a.challenge, generation: a.generation }, a.origin);
          } catch (_) { if (attempt === a) stop('无法安全准备备用入口。请检查连接后重试。'); }
          return;
        }
        if (data.bootId !== a.bootId) { stop('备用地址已更换。请重新准备。'); return; }
        a.sent = true;
        var channel;
        try { channel = new win.MessageChannel(); } catch (_) { stop('无法安全准备备用入口。请检查连接后重试。'); return; } a.port = channel.port1;
        a.port.onmessage = function (event) { message(event, a); }; a.port.start();
        try { a.child.postMessage({ type: PREFIX + 'admit', nonce: a.nonce, challenge: a.challenge, proofChallenge: a.proofChallenge, ticket: a.ticket,
          preparationId: a.preparationId, bootId: a.bootId, origin: a.origin, generation: a.generation }, a.origin, [channel.port2]); } catch (_) { channel.port2.close(); stop('无法安全准备备用入口。请检查连接后重试。'); return; }
        a.ticket = null;
        state('verifying', '正在打开并验证备用入口…');
      } else if (data.type === PREFIX + 'receipt' && a.sent && !a.receiverConfirmed && !a.proofChecking && tuple(data, a)) {
        a.proofChecking = true;
        try {
          var confirmed = await jsonRequest('/__dsh/backup-prepare', { action: 'confirm-receiver', preparationId: a.preparationId,
            receipt: data.receipt, nonce: a.nonce, challenge: a.proofChallenge }, a.e2ee, a.key, function () { return current(a); });
          if (!tuple(confirmed, a) || confirmed.receiverVerified !== true || confirmed.nonce !== a.nonce || confirmed.challenge !== a.proofChallenge) throw Error('recipient-unverified');
          a.receiverConfirmed = true; a.challenge = randomNonce();
          a.port.postMessage({ type: PREFIX + 'hello', nonce: a.nonce, challenge: a.challenge, generation: a.generation });
        } catch (_) { if (attempt === a) stop('无法安全准备备用入口。请检查连接后重试。'); }
      } else if (data.type === PREFIX + 'complete' && a.keySent && tuple(data, a) && !a.checking) {
        a.checking = true;
        try {
          var verified = await jsonRequest('/__dsh/backup-prepare', { action: 'status', preparationId: a.preparationId },
            a.e2ee, a.key, function () { return current(a); });
          if (!tuple(verified, a) || verified.phase !== 'completed') throw Error('not-completed');
          stop('此浏览器的备用入口已完成登录与加密验证。请保存不含凭据的备用地址。', true);
        } catch (_) { if (attempt === a) stop('无法确认备用入口已准备好。请重新检查。'); }
      } else if (data.type === PREFIX + 'failed' && a.sent) stop('备用入口未能完成验证或保存。请重新准备。');
    }
    async function begin() {
      if (disposed || attempt || !options.ready() || !options.active()) return;
      if (!win.confirm(options.t('准备会在新窗口打开当前备用入口，并将此会话的临时登录票据和加密密钥交给同一台电脑的该入口。验证成功后，此浏览器会记住该入口的登录与密钥。继续吗？'))) return;
      var child;
      try {
        child = win.open('about:blank', '_blank');
        if (!child) throw Error('popup-blocked');
        child.opener = null; // Before any external navigation, including redirects.
      } catch (_) { if (child) try { child.close(); } catch (_) {} state('failed', '浏览器阻止了新窗口。请允许本次弹窗后重新点击“准备备用入口”。'); return; }
      var a;
      try {
        a = { child: child, e2ee: win.DshE2EE, key: win.__dshE2eeSecret, context: options.context(),
          nonce: randomNonce(), challenge: randomNonce(), deadline: Date.now() + 60000 };
        attempt = a; state('opening', '正在打开并验证备用入口…');
        var slot = await options.read();
        if (!current(a) || !slot || !slot.current() || !slot.url) throw Error('changed');
        a.origin = origin(new URL(slot.url).origin); a.generation = slot.generation;
        if (!a.origin || a.origin === win.location.origin) throw Error('not-alternate');
        a.child.location.replace(a.origin + '/__backup/prepare?source=' + encodeURIComponent(win.location.origin) + '&nonce=' + a.nonce);
        pulse(a);
      } catch (_) { if (attempt === a) stop('无法安全准备备用入口。请检查连接后重试。'); else try { child.close(); } catch (_) {} }
    }
    win.addEventListener('message', message);
    return { begin: begin, busy: function () { return !!attempt; }, result: function () { return result; },
      update: function () {
        if ((attempt && !current(attempt)) || (verifiedContext && (!options.ready() || win.DshE2EE !== verifiedContext.e2ee ||
            win.__dshE2eeSecret !== verifiedContext.key || options.context() !== verifiedContext.context))) {
          verifiedContext = null; stop('连接或密钥已更换。请重新准备备用入口。');
        }
      },
      invalidateTarget: function () {
        verifiedContext = null;
        if (attempt) stop('备用地址已更换。请重新准备。');
        else { result = null; options.onState(result); }
      },
      cancel: function () { if (attempt) stop('准备已取消。'); },
      dispose: function () { if (attempt) stop('准备已取消。'); disposed = true; win.removeEventListener('message', message); } };
  }
  function startReceiver(config) {
    var doc = win.document, state = 'waiting', parent = null, challenge = '', transfer = null, secret = null, e2ee = null;
    var alive = true, timer, port = null;
    var status = doc.getElementById('backup-prepare-status'), open = doc.getElementById('backup-prepare-open');
    function t(text) { return win.DshI18n ? win.DshI18n.t(text) : text; }
    function say(text) { status.textContent = t(text); }
    function current() { return alive && state === 'working' && win.DshE2EE === e2ee && win.__dshE2eeSecret === secret; }
    function notify(type, extra) { if (port) port.postMessage(Object.assign({ type: PREFIX + type, nonce: config.nonce }, extra || {}, transfer && {
      preparationId: transfer.preparationId, generation: transfer.generation, origin: config.origin, bootId: config.bootId })); }
    function fail(message) {
      if (state === 'completed' || state === 'failed') return;
      state = 'failed'; win.clearTimeout(timer);
      if (e2ee && secret && typeof e2ee.forgetPreparedSecret === 'function') e2ee.forgetPreparedSecret(secret);
      secret = null; if (transfer) { delete transfer.key; delete transfer.ticket; }
      say(typeof message === 'string' ? message : '备用入口未能完成验证或保存。请关闭此窗口，返回原页面重新准备。'); notify('failed');
      if (port) { port.onmessage = null; port.close(); }
    }
    function validConfig() {
      try { var from = new URL(config.source); return origin(config.origin) === win.location.origin && from.origin === config.source &&
        (from.protocol === 'https:' || (from.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(from.hostname))) &&
        /^[a-f0-9]{48}$/.test(config.nonce) && /^[a-zA-Z0-9-]{16,128}$/.test(config.bootId); } catch (_) { return false; }
    }
    // Only non-secret correlation data was navigated. Remove it too, before
    // any authentication work; reload/back cannot resume an old attempt.
    try { win.history.replaceState(null, '', '/__backup/prepare'); } catch (_) { fail(); return; }
    if (!validConfig()) { fail(); return; }
    if (!win.DshE2EE || ['startPrepared', 'savePreparedSecret', 'forgetPreparedSecret', 'encryptedFetch', 'prove'].some(function (name) { return typeof win.DshE2EE[name] !== 'function'; })) {
      fail('此备用入口缓存了旧版加密组件。请先打开备用页面完成正常更新，再返回原页面重新准备。');
      var update = doc.getElementById('backup-prepare-update');
      if (update) { update.hidden = false; update.href = config.origin + '/dsh-lite'; }
      return;
    }
    say('等待原页面确认此次备用入口准备…');
    timer = win.setTimeout(fail, 60000);
    async function receive(event, fromPort) {
      var data = event.data;
      if (!alive || state === 'failed' || state === 'completed' || !data || data.nonce !== config.nonce) return;
      if (fromPort) { if (!port) return; }
      else if (event.origin !== config.source || !event.source || (parent && parent !== event.source)) return;
      if (data.type === PREFIX + 'hello' && (state === 'waiting' || state === 'awaiting-key') && /^[a-f0-9]{48}$/.test(data.challenge || '')) {
        if (state === 'awaiting-key' && !fromPort) return;
        if (!fromPort) parent = event.source; challenge = data.challenge;
        var readyMessage = { type: PREFIX + 'ready', nonce: config.nonce, challenge: challenge,
          bootId: config.bootId, generation: data.generation, preparationId: transfer && transfer.preparationId };
        if (fromPort) port.postMessage(readyMessage); else parent.postMessage(readyMessage, config.source);
      } else if (data.type === PREFIX + 'cancel' && fromPort) fail();
      else if (data.type === PREFIX + 'admit' && state === 'waiting' && !fromPort && parent === event.source && data.challenge === challenge &&
          event.ports && event.ports.length === 1 &&
          data.origin === config.origin && data.bootId === config.bootId && /^[a-f0-9]{48}$/.test(data.proofChallenge || '') &&
          !Object.prototype.hasOwnProperty.call(data, 'key') && /^[A-Za-z0-9_-]{16,160}$/.test(data.ticket || '') &&
          /^[A-Za-z0-9_-]{16,160}$/.test(data.preparationId || '') && /^[A-Za-z0-9._:-]{1,128}$/.test(data.generation || '')) {
        state = 'redeeming'; transfer = Object.assign({}, data); e2ee = win.DshE2EE;
        port = event.ports[0]; port.onmessage = function (event) { receive(event, true); }; port.start();
        try {
          var redeemed = await jsonRequest('/__backup/redeem', { ticket: transfer.ticket, nonce: config.nonce, challenge: transfer.proofChallenge }, null, null,
            function () { return alive && state === 'redeeming' && win.DshE2EE === e2ee; });
          delete transfer.ticket;
          if (!tuple(redeemed, transfer) || redeemed.nonce !== config.nonce || redeemed.challenge !== transfer.proofChallenge || !/^[A-Za-z0-9_-]{16,160}$/.test(redeemed.receipt || '')) throw Error('redeem-failed');
          state = 'awaiting-key'; notify('receipt', { receipt: redeemed.receipt });
        } catch (_) { fail(); }
      } else if (data.type === PREFIX + 'key' && state === 'awaiting-key' && fromPort && data.challenge === challenge &&
          tuple(data, transfer) && /^[A-Za-z0-9_-]{16,256}$/.test(data.key || '')) {
        state = 'working'; secret = data.key;
        say('正在验证此备用入口的登录与加密…');
        try {
          if (!e2ee || win.DshE2EE !== e2ee || typeof e2ee.startPrepared !== 'function' || !e2ee.startPrepared(secret)) throw Error('redeem-failed');
          if (!current() || !await e2ee.prove(true) || !current()) throw Error('proof-failed');
          var completed = await jsonRequest('/__dsh/backup-prepare', { action: 'complete', preparationId: transfer.preparationId,
            origin: config.origin, generation: transfer.generation, nonce: config.nonce, challenge: transfer.proofChallenge }, e2ee, secret, current);
          if (!current() || !tuple(completed, transfer) || !e2ee.savePreparedSecret(secret) || !current()) throw Error('not-persisted');
          state = 'completed'; win.clearTimeout(timer); secret = null;
          say('此浏览器的备用入口现已验证并保存。清除网站数据、更换浏览器或地址后，需要重新准备。');
          open.hidden = false; open.href = config.origin + '/dsh-lite';
          notify('complete'); if (port) { port.onmessage = null; port.close(); }
        } catch (_) { fail(); }
      }
    }
    win.addEventListener('message', receive);
    win.addEventListener('pagehide', function () { alive = false; if (state !== 'completed') fail(); if (port) port.close(); });
    win.addEventListener('pageshow', function (event) { if (event.persisted) {
      alive = false; if (port) port.close();
      if (state !== 'completed') fail();
      else { open.hidden = true; say('此页面显示的是之前完成的验证。请重新打开备用页面，检查当前连接。'); }
    } });
    return { cancel: fail };
  }
  win.PocketBridgeBackupPrepare = { createSource: createSource, startReceiver: startReceiver };
  if (win.document) {
    var configNode = win.document.getElementById('backup-prepare-context');
    if (configNode) { try { startReceiver(JSON.parse(configNode.textContent)); } catch (_) {} }
  }
})(window);
