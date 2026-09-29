'use strict';

// Isolated adapter tests: no real DSH process, project, prompt, or network.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDshLiteRpc, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require('./dsh-lite-rpc');
const { createDshLiteScreen } = require('./dsh-lite-screen');

let checks = 0;
async function invoke(handler, payload, options = {}) {
  const bytes = options.raw === undefined ? Buffer.from(JSON.stringify(payload || {})) : Buffer.from(options.raw);
  const req = Readable.from([bytes]);
  req.method = options.method || 'POST';
  req.headers = { 'content-type': options.contentType || 'application/json',
    'x-dsh-e2ee': options.encrypted === false ? '0' : '1',
    'content-length': String(bytes.length) };
  req.__dshE2eeDecrypted = options.decrypted !== false;
  const res = { status: null, headers: null, text: '', writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.text = String(text); this.writableEnded = true; } };
  await handler(req, res);
  return { status: res.status, headers: res.headers, body: JSON.parse(res.text) };
}

async function check(name, test) { await test(); checks++; console.log('PASS ' + name); }

(async () => {
  const calls = [];
  const handler = createDshLiteRpc({ callUpstream: async call => {
    calls.push(call);
    return { statusCode: 200, body: JSON.stringify({ type: 'client-response', rpcId: JSON.parse(call.body).rpcId,
      result: { ok: true, value: call.path.endsWith('/create') ? { sessionId: 'test-session' } : { accepted: true } } }) };
  } });
  const projectPath = process.platform === 'win32' ? 'D:\\projects\\new-workspace' : '/tmp/new-workspace';

  await check('three known unary methods use fixed paths and official wire', async () => {
    const requests = [
      ['workspace/create', { path: projectPath }],
      ['session/create', { workspaceId: 'test-workspace' }],
      ['session/prompt', { requestId: 'test-request', sessionId: 'test-session', mode: 'queue',
        content: [{ type: 'text', text: 'isolated fixture' }] }]
    ];
    for (const [method, request] of requests) {
      const response = await invoke(handler, { method, request });
      assert.equal(response.status, 200);
      assert.equal(response.body.result.ok, true);
      assert.equal(response.headers['cache-control'], 'no-store');
      const call = calls.at(-1), wire = JSON.parse(call.body);
      assert.equal(call.path, '/api/' + method);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['accept-encoding'], 'identity');
      assert.deepEqual(Object.keys(wire).sort(), ['method', 'payload', 'rpcId', 'type']);
      assert.equal(wire.type, 'client-request');
      assert.equal(wire.method, method);
      assert.deepEqual(wire.payload, { args: { request } });
      assert.ok(typeof wire.rpcId === 'string' && wire.rpcId.length > 0);
    }
  });

  await check('event replies use the gateway-owned args shape', async () => {
    const requests = [
      { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', value: 'allowed-once' } },
      { clientId: 'client-1', eventId: 'event-2', outcome: { kind: 'result', value: 'rejected' } },
      { clientId: 'client-1', eventId: 'event-3', outcome: { kind: 'result', value: {
        answers: [{ id: 'question-1', selected: ['option A'] }, { id: 'question-2', selected: [], custom: 'typed answer' }]
      } } },
      { clientId: 'client-1', eventId: 'event-4', outcome: { kind: 'rejected', error: {
        name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED'
      } } }
    ];
    for (const request of requests) {
      const response = await invoke(handler, { method: '$events/result', request });
      assert.equal(response.status, 200);
      const call = calls.at(-1), wire = JSON.parse(call.body);
      assert.equal(call.path, '/api/$events/result');
      assert.equal(wire.method, '$events/result');
      assert.deepEqual(wire.payload, { args: request });
    }
  });

  await check('read-only session list accepts only empty or cursor request', async () => {
    for (const request of [{}, { cursor: 'opaque-page-token' }]) {
      const response = await invoke(handler, { method: 'session/list', request });
      assert.equal(response.status, 200);
      const call = calls.at(-1), wire = JSON.parse(call.body);
      assert.equal(call.path, '/api/session/list');
      assert.deepEqual(wire.payload, { args: { _request: request } });
    }
  });

  await check('bounded history page uses the official read-only request shape', async () => {
    const request = { address: { kind: 'session', sessionId: 's-1' }, throughSeq: 100,
      beforeSeq: 50, maxMessages: 20, turnWindow: { minMessages: 10, minTurns: 1 } };
    const response = await invoke(handler, { method: 'session/page', request });
    assert.equal(response.status, 200);
    const call = calls.at(-1), wire = JSON.parse(call.body);
    assert.equal(call.path, '/api/session/page');
    assert.deepEqual(wire.payload, { args: { request } });
  });

  await check('session cancel and file receipts use only fixed official fields', async () => {
    const cancel = await invoke(handler, { method: 'session/cancel', request: { sessionId: 's-1' } });
    assert.equal(cancel.status, 200);
    assert.equal(calls.at(-1).path, '/api/session/cancel');
    const prompt = { requestId: 'r-1', sessionId: 's-1', mode: 'queue',
      content: [{ type: 'text', text: 'read this' }, { type: 'file', receiptId: 'receipt-1' }] };
    assert.equal((await invoke(handler, { method: 'session/prompt', request: prompt })).status, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).body).payload, { args: { request: prompt } });
    prompt.content = [{ type: 'file', receiptId: 'receipt-1' }];
    assert.equal((await invoke(handler, { method: 'session/prompt', request: prompt })).status, 200);
  });

  await check('unknown method, extra fields, invalid records never hit upstream', async () => {
    const invalid = [
      { method: 'session/delete', request: { sessionId: 'x' } },
      { method: 'workspace/create', request: { path: 'relative' } },
      { method: 'workspace/create', request: { path: projectPath, url: 'https://example.test' } },
      { method: 'session/create', request: { workspaceId: 'x', cwd: projectPath } },
      { method: 'session/list', request: { cursor: '' } },
      { method: 'session/list', request: { cursor: 'x', limit: 99999 } },
      { method: 'session/page', request: { address: { kind: 'workspace', sessionId: 's' }, throughSeq: 2,
        beforeSeq: 1, maxMessages: 20, turnWindow: { minMessages: 10, minTurns: 1 } } },
      { method: 'session/page', request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 2,
        beforeSeq: 1, maxMessages: 100, turnWindow: { minMessages: 10, minTurns: 1 } } },
      { method: 'session/page', request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 2.5,
        beforeSeq: 1, maxMessages: 20, turnWindow: { minMessages: 10, minTurns: 1 } } },
      { method: 'session/cancel', request: { sessionId: 's', force: true } },
      { method: 'session/prompt', request: { requestId: 'r', sessionId: 's', mode: 'queue',
        content: [{ type: 'file', path: projectPath }] } },
      { method: 'session/prompt', request: { requestId: 'r', sessionId: 's', mode: 'queue',
        content: [{ type: 'file', receiptId: 'x' }, { type: 'file', receiptId: 'x' }] } },
      { method: 'session/prompt', request: { requestId: 'r', sessionId: 's', mode: 'queue',
        content: [{ type: 'file', receiptId: 'x', name: 'bad' }] } },
      { method: 'session/prompt', request: { requestId: 'r', sessionId: 's', mode: 'queue',
        content: [{ type: 'text', text: ' ' }] } },
      { method: 'session/create', request: { workspaceId: 's' }, upstreamUrl: 'http://evil.test' },
      { method: '$events/result', request: { clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: 'allowed-always' } } },
      { method: '$events/result', request: { clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: { arbitrary: true } } } },
      { method: '$events/result', request: { clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: { answers: [{ id: 'q', selected: ['a'], custom: 'x', extra: true }] } } } },
      { method: '$events/result', request: { clientId: 'c', eventId: 'e', outcome: { kind: 'rejected', error: { name: 'Error', message: 'forged', code: 'ANY' } } } }
    ];
    const before = calls.length;
    for (const input of invalid) assert.equal((await invoke(handler, input)).status, 400);
    assert.equal(calls.length, before);
  });

  await check('encrypted JSON POST required and 256KiB limit enforced', async () => {
    const valid = { method: 'session/create', request: { workspaceId: 'x' } };
    const before = calls.length;
    assert.equal((await invoke(handler, valid, { method: 'GET' })).status, 405);
    assert.equal((await invoke(handler, valid, { encrypted: false })).status, 403);
    assert.equal((await invoke(handler, valid, { decrypted: false })).status, 403);
    assert.equal((await invoke(handler, valid, { contentType: 'text/plain' })).status, 415);
    assert.equal((await invoke(handler, null, { raw: '{' })).status, 400);
    assert.equal((await invoke(handler, null, { raw: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
    assert.equal(calls.length, before);
  });

  await check('forged E2EE header cannot trigger a screen capture', async () => {
    const screen = createDshLiteScreen();
    const response = await invoke(screen, { maxWidth: 1280 }, { decrypted: false });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'encrypted-request-required');
  });

  await check('model selection accepts the optional reasoning effort field', async () => {
    // C20：DSH 的 schema 是 { sessionId, modelId, reasoningEffort? } —— 两把键
    // 必须能同时出现，否则「选完模型再选思考强度」这一步会被桥自己挡掉。
    const requests = [
      { sessionId: 's-1', modelId: 'deepseek-flash' },
      { sessionId: 's-1', modelId: 'deepseek-flash', reasoningEffort: 'max' },
      { sessionId: 's-1', model: 'deepseek-flash', reasoningEffort: 'off' }
    ];
    for (const request of requests) {
      const response = await invoke(handler, { method: 'session/selectModel', request });
      assert.equal(response.status, 200);
      const wire = JSON.parse(calls.at(-1).body);
      assert.equal(calls.at(-1).path, '/api/session/selectModel');
      assert.deepEqual(wire.payload, { args: { request } });
    }
    // 仍然是"恰好一个模型键"：不能两把都写，也不能带别的字段。
    for (const request of [
      { sessionId: 's-1', modelId: 'a', model: 'b' },
      { sessionId: 's-1', modelId: 'a', reasoningEffort: '' },
      { sessionId: 's-1', modelId: 'a', reasoningEffort: 'max', extra: 1 }
    ]) assert.equal((await invoke(handler, { method: 'session/selectModel', request })).status, 400);
  });

  await check('queued message operations use the official action union', async () => {
    // C12：{ sessionId, itemId, action }，action 只有三种形状。
    const requests = [
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'steer' } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'remove' } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'edit', content: [{ type: 'text', text: '改一下' }] } }
    ];
    for (const request of requests) {
      const response = await invoke(handler, { method: 'session/updateQueue', request });
      assert.equal(response.status, 200);
      const wire = JSON.parse(calls.at(-1).body);
      assert.equal(calls.at(-1).path, '/api/session/updateQueue');
      assert.deepEqual(wire.payload, { args: { request } });
    }
    const before = calls.length;
    for (const request of [
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'delete' } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'steer', force: true } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'edit', content: [] } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'edit', content: [{ type: 'text', text: '' }] } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'edit', content: [{ type: 'file', receiptId: 'r' }] } },
      { sessionId: 's-1', itemId: 'm-1', action: { kind: 'remove' }, itemIds: ['x'] },
      { sessionId: '', itemId: 'm-1', action: { kind: 'remove' } }
    ]) assert.equal((await invoke(handler, { method: 'session/updateQueue', request })).status, 400);
    assert.equal(calls.length, before);
  });

  await check('slash-command RPCs are flat and limited to a bare command', async () => {
    // J：压缩上下文走 DSH 自己的命令 RPC，而不是把 `/compact` 当消息发出去。
    const list = await invoke(handler, { method: 'commands/list', request: { agentId: 's-1' } });
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).body).payload, { args: { agentId: 's-1' } });
    assert.equal(calls.at(-1).path, '/api/commands/list');

    const run = await invoke(handler, { method: 'commands/execute',
      request: { agentId: 's-1', line: '/compact', submittedAttachments: [] } });
    assert.equal(run.status, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).body).payload,
      { args: { agentId: 's-1', line: '/compact', submittedAttachments: [] } });
    assert.equal(calls.at(-1).path, '/api/commands/execute');

    const before = calls.length;
    for (const input of [
      { method: 'commands/list', request: {} },
      { method: 'commands/list', request: { agentId: 's-1', all: true } },
      { method: 'commands/execute', request: { agentId: 's-1', line: 'compact' } },
      { method: 'commands/execute', request: { agentId: 's-1', line: '/compact --force' } },
      { method: 'commands/execute', request: { agentId: 's-1', line: '/rm -rf /' } },
      { method: 'commands/execute', request: { agentId: 's-1', line: '/compact\n/x' } },
      { method: 'commands/execute', request: { agentId: 's-1', line: '/compact',
        submittedAttachments: [{ type: 'file', receiptId: 'r-1' }] } },
      { method: 'commands/execute', request: { agentId: 's-1', line: '/compact', extra: 1 } }
    ]) assert.equal((await invoke(handler, input)).status, 400);
    assert.equal(calls.length, before);
  });

  await check('goal RPCs use the official flat args and always require a revision', async () => {
    // C26：形状来自 asar 的 descriptor —— scope.wire 是 agentId，其余按 wire 摊平：
    //   create → {agentId, request:{objective, maxGoalRounds?}}
    //   edit   → {agentId, ref, request:{objective, ...}}
    //   pause/resume/complete/clear → {agentId, ref}
    //   ref = {id, revision}（GoalRef）
    const ref = { id: 'goal-1', revision: 3 };
    const accepted = [
      ['goals/create', { agentId: 's-1', request: { objective: '把手机端做到能用' } }],
      ['goals/create', { agentId: 's-1', request: { objective: '目标', maxGoalRounds: 5 } }],
      ['goals/edit', { agentId: 's-1', ref, request: { objective: '改一下目标' } }],
      ['goals/pause', { agentId: 's-1', ref }],
      ['goals/resume', { agentId: 's-1', ref }],
      ['goals/complete', { agentId: 's-1', ref }],
      ['goals/clear', { agentId: 's-1', ref }]
    ];
    for (const [method, request] of accepted) {
      const response = await invoke(handler, { method, request });
      assert.equal(response.status, 200, method);
      assert.equal(calls.at(-1).path, '/api/' + method);
      assert.deepEqual(JSON.parse(calls.at(-1).body).payload, { args: request },
        method + ' 必须是摊平的 args');
    }

    const before = calls.length;
    for (const [method, request] of [
      // ref 少了 revision —— revision 是乐观并发保护，缺了就等于"盲改"
      ['goals/pause', { agentId: 's-1', ref: { id: 'goal-1' } }],
      ['goals/clear', { agentId: 's-1', ref: { id: 'goal-1', revision: -1 } }],
      ['goals/complete', { agentId: 's-1', ref: { id: 'goal-1', revision: 1.5 } }],
      // 目标正文不能是空白，也不能塞控制字符
      ['goals/create', { agentId: 's-1', request: { objective: '   ' } }],
      ['goals/create', { agentId: 's-1', request: { objective: 'ok\u0007bell' } }],
      ['goals/edit', { agentId: 's-1', ref, request: {} }],
      ['goals/edit', { agentId: 's-1', ref: { id: 'goal-1' }, request: { objective: 'x' } }],
      // 多余字段一律拒
      ['goals/create', { agentId: 's-1', request: { objective: 'x' }, extra: 1 }],
      ['goals/edit', { agentId: 's-1', ref, request: { objective: 'x' }, extra: 1 }],
      ['goals/complete', { agentId: 's-1', ref, force: true }],
      // 「读目标」不走 goals/get —— 它用 session/projections（见白名单说明）
      ['goals/get', { agentId: 's-1' }]
    ]) {
      assert.equal((await invoke(handler, { method, request })).status, 400,
        method + ' ' + JSON.stringify(request));
    }
    assert.equal(calls.length, before, '被拒的请求一个都不该打到上游');
  });

  await check('a wrong args shape is retried once with the other wrapping', async () => {
    // DSH 对形状不对的回应是明确的（gateway/arguments-invalid）。与其把这句
    // 错误原样丢给界面（使用者只会看到"DSH 拒绝了请求"），不如换一种外层包装
    // 再发一次 —— 业务字段一个字都不变。
    const seen = [];
    const retrying = createDshLiteRpc({ callUpstream: async call => {
      const wire = JSON.parse(call.body);
      seen.push(wire.payload.args);
      const first = seen.length === 1;
      return { statusCode: 200, body: JSON.stringify({ rpcId: wire.rpcId, result: first
        ? { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "request"' } }
        : { ok: true, value: { commands: [] } } }) };
    } });
    const response = await invoke(retrying, { method: 'commands/list', request: { agentId: 's-1' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.ok, true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { agentId: 's-1' });
    assert.deepEqual(seen[1], { request: { agentId: 's-1' } });

    // 两种形状都不对：保留**最后一次**的官方错误，界面照样能看见原因。
    const bothBad = createDshLiteRpc({ callUpstream: async call => {
      const wire = JSON.parse(call.body);
      return { statusCode: 200, body: JSON.stringify({ rpcId: wire.rpcId,
        result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'still wrong' } } }) };
    } });
    const failed = await invoke(bothBad, { method: 'commands/list', request: { agentId: 's-1' } });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.result.error.code, 'gateway/arguments-invalid');
  });

  await check('official domain failure result remains visible to UI', async () => {
    const failure = createDshLiteRpc({ callUpstream: async call => ({ statusCode: 200,
      body: { rpcId: JSON.parse(call.body).rpcId,
        result: { ok: false, error: { code: 'session/writer-held', message: 'busy', details: { sessionId: 'x' } } } } }) });
    const response = await invoke(failure, { method: 'session/create', request: { workspaceId: 'x' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.error.code, 'session/writer-held');
  });

  await check('bad and oversized upstream replies fail without raw body leak', async () => {
    const input = { method: 'session/create', request: { workspaceId: 'x' } };
    const values = [
      { statusCode: 302, body: '<a href="https://bad.test">redirect</a>' },
      { statusCode: 200, body: '<script>secret</script>' },
      { statusCode: 200, body: JSON.stringify({ result: { nope: true } }) },
      { statusCode: 200, body: JSON.stringify({ rpcId: 'other-request', result: { ok: true } }) },
      { statusCode: 200, body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }
    ];
    for (const value of values) {
      const response = await invoke(createDshLiteRpc({ callUpstream: async () => value }), input);
      assert.equal(response.status, 502);
      assert.equal(JSON.stringify(response.body).includes('secret'), false);
    }
  });

  console.log('DSH lite RPC: ' + checks + ' isolated groups passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
