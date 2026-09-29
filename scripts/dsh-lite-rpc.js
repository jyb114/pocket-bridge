'use strict';

// Narrow RPC adapter for the optional small mobile DSH UI. The caller must
// authenticate the device, verify its proof, decrypt the request with
// e2eeWrap, and supply a verified loopback DSH transport. This module never
// accepts an upstream URL or forwards arbitrary RPC methods.
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const METHODS = new Set(['workspace/create', 'session/create', 'session/prompt', 'session/list',
  'session/page', 'session/cancel', '$events/result',
  // 选模型 / 选模式（C3 / C4）。方法名是从 DSH 自己的 app.asar 里搜出来的，
  // 不是猜的：`session/modelCatalog`（列）、`session/selectModel`（设）、
  // `agentPresets/list`（列）、`agentPresets/select`（设）。
  // 另外 `session/model` 也存在，但它的用途不明确（可能是读当前值），先不启用 ——
  // 宁可少一个能用，也不要放一个会改状态的未知方法进来。
  'session/modelCatalog', 'session/selectModel', 'agentPresets/list', 'agentPresets/select',
  // C21 计划 / 目标模式。**这条是补上的** —— 上一版加白名单时漏了它，
  // 于是界面上点「计划 / 目标」被桥挡回来（invalid-rpc-request），
  // 看起来像这个功能没做，其实是白名单少了一行。
  'session/selectMode',
  // C12 排队消息的「立即执行 / 修改 / 删除」。
  // 参数形状是从 DSH 自己的 asar 里读出来的（见 validRequest 里的说明）。
  'session/updateQueue',
  // J 压缩上下文。**不是**把 `/compact` 当消息发出去 —— `session/prompt` 里
  // 根本没有斜杠解析（DSH 自己的 README 写着「命令行不会被静默降级为普通提示词」），
  // 那样发只会把 `/compact` 当普通文本送进模型。DSH 有一个正经的命令 RPC：
  //   commands/list   （列这个会话能用的斜杠命令）
  //   commands/execute（执行一条命令行）—— 电脑端界面点"压缩"走的就是它
  'commands/list', 'commands/execute',
  // C12 读排队消息。方法是从 asar 里挖出来的：**`session/page` 里没有任何
  // inbox/queue 字段**，读待处理队列的唯一 RPC 是 `session/projections`（只读）。
  // C26 也复用它读「目标 / 完成情况」（投影里的 `goal` 键）。
  'session/projections',
  // ── C26 目标（计划模式里那个"目标"）───────────────────────────────────────
  //
  // 使用者原话：「进去计划模式后…根本不能像客户端上看到你的目标，及完成情况，
  // 需要暂停，删除，更改都不行」。手机端原来只有 `/plan`（进入/离开计划模式），
  // **完全没有目标这一套**。
  //
  // 读：`session/projections` 的 `values.goal`（已经在上面，零新增）。
  // 改：下面这六个 —— 形状全部从 asar 的 descriptor 读出来的，不是猜的：
  //   scope.wire = 'agentId'，参数按 wire 名摊平
  //     goals/create → { agentId, request: { objective, maxGoalRounds? } }
  //     goals/edit   → { agentId, ref, request: { objective?, maxGoalRounds? } }
  //     goals/pause | resume | complete | clear → { agentId, ref }
  //   ref = { id, revision }（GoalRef）；phase = active|paused|blocked|complete
  'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear']);

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, required, optional = []) {
  return plainRecord(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validDirectory(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 4096 || value.includes('\0')) return false;
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\') && path.win32.isAbsolute(value);
  }
  return path.posix.isAbsolute(value);
}

function validQuestionAnswers(value) {
  if (!exactKeys(value, ['answers']) || !Array.isArray(value.answers) ||
      value.answers.length < 1 || value.answers.length > 20) return false;
  const ids = new Set();
  for (const answer of value.answers) {
    if (!exactKeys(answer, ['id', 'selected'], ['custom']) || !validId(answer.id) ||
        ids.has(answer.id) || !Array.isArray(answer.selected) || answer.selected.length > 20 ||
        answer.selected.some(label => typeof label !== 'string' || label.length < 1 || label.length > 2048 ||
          /[\u0000-\u001f\u007f]/.test(label)) ||
        new Set(answer.selected).size !== answer.selected.length ||
        (Object.hasOwn(answer, 'custom') &&
          (typeof answer.custom !== 'string' || answer.custom.length < 1 || answer.custom.length > 8192))) return false;
    ids.add(answer.id);
  }
  return true;
}

function validEventOutcome(outcome) {
  if (!plainRecord(outcome)) return false;
  if (outcome.kind === 'result' && exactKeys(outcome, ['kind', 'value'])) {
    return outcome.value === 'allowed-once' || outcome.value === 'rejected' ||
      validQuestionAnswers(outcome.value);
  }
  // This is the sole supported explicit cancellation. Never accept arbitrary
  // Remote rejection names, messages, codes, or details from the phone.
  return outcome.kind === 'rejected' && exactKeys(outcome, ['kind', 'error']) &&
    exactKeys(outcome.error, ['name', 'message', 'code']) &&
    outcome.error.name === 'UserQuestionError' &&
    outcome.error.message === 'the user cancelled ask_user_question' &&
    outcome.error.code === 'ASK_CANCELLED';
}

/**
 * 「设置某个东西」这类请求的校验：必须带合法的 sessionId，且**恰好**带一个候选键。
 *
 * 为什么要这么写：DSH 把实现打包在 asar 里，只搜得到方法名，搜不到参数形状。
 * 于是这里采取**宽松但有边界**的策略 —— 候选键名限死在几个显然的写法里，
 * 且不许出现任何多余字段（等价于 exactKeys 的约束）。
 *
 * 形状猜错时 DSH 会回参数错误：那是**安全失败**（界面会把错误显示出来），
 * 不会改坏会话。这里真正挡住的是「往 DSH 里塞任意结构」。
 */
function selectRequest(request, candidateKeys, optionalKeys = []) {
  if (!plainRecord(request) || !validId(request.sessionId)) return false;
  const rest = Object.keys(request).filter((key) => key !== 'sessionId' && optionalKeys.indexOf(key) < 0);
  if (rest.length !== 1 || candidateKeys.indexOf(rest[0]) < 0 || !validId(request[rest[0]])) return false;
  return optionalKeys.every((key) => !Object.hasOwn(request, key) || validId(request[key]));
}

/**
 * C12 排队消息的一次操作。
 *
 * 形状是从 asar 里的 schema 原文读出来的（不是猜的）：
 *   { sessionId, itemId, action }
 *   action = { kind: 'edit',  content: [{ type: 'text', text }] }
 *          | { kind: 'remove' }
 *          | { kind: 'steer' }        ← 「立即执行」
 *
 * 和「选模型」那类一样：字段名和取值都限死，多余字段一律拒绝。
 * 这里比别处更需要严格 —— 它**会改会话状态**（删掉/改写一条排队消息）。
 */
function validQueueUpdate(request) {
  if (!exactKeys(request, ['sessionId', 'itemId', 'action'])) return false;
  if (!validId(request.sessionId) || !validId(request.itemId)) return false;
  const action = request.action;
  if (!plainRecord(action)) return false;
  if (action.kind === 'remove' || action.kind === 'steer') return exactKeys(action, ['kind']);
  if (action.kind !== 'edit') return false;
  if (!exactKeys(action, ['kind', 'content']) || !Array.isArray(action.content)) return false;
  if (action.content.length < 1 || action.content.length > 6) return false;
  return action.content.every((part) => exactKeys(part, ['type', 'text']) &&
    part.type === 'text' && typeof part.text === 'string' &&
    part.text.length > 0 && part.text.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(part.text));
}

/**
 * 一条目标（goal）的引用。形状来自 asar：`GoalRef = { id, revision }`。
 *
 * ★ `revision` 是**乐观并发**用的：DSH 拿它挡住"两个人同时改同一个目标"。
 *   所以每次操作前都要拿**最新**的那一份（界面就是先读一次再改的）。
 */
function validGoalRef(value) {
  return exactKeys(value, ['id', 'revision']) && validId(value.id) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0;
}

/** 目标正文。给足长度（目标本来就该是一句话到一段话），但挡住控制字符。 */
function validGoalText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/** 目标的一次改动（create / edit 共用的那半）。 */
function validGoalPatch(value, requireObjective) {
  if (!exactKeys(value, ['objective'], ['maxGoalRounds'])) return false;
  if (requireObjective && !Object.hasOwn(value, 'objective')) return false;
  if (Object.hasOwn(value, 'objective') && !validGoalText(value.objective)) return false;
  if (Object.hasOwn(value, 'maxGoalRounds') &&
      (!Number.isSafeInteger(value.maxGoalRounds) || value.maxGoalRounds < 1 ||
       value.maxGoalRounds > 1000)) return false;
  return true;
}

/**
 * 一条斜杠命令。只认「`/名字`」这种最简形式：
 * 单行、以 / 开头、命令名是字母数字加连字符、后面不带参数。
 *
 * 为什么这么窄：手机端只需要按一下 `/compact`。放开参数就等于把
 * "随便什么命令都能从手机发进来"，而这一层的价值恰恰是**面窄**。
 */
function validCommandLine(value) {
  return typeof value === 'string' && /^\/[A-Za-z][A-Za-z0-9-]{0,61}$/.test(value);
}

function validPromptContent(content) {
  if (!Array.isArray(content) || content.length < 1 || content.length > 6) return false;
  let textSeen = false;
  let meaningfulText = false;
  const receipts = new Set();
  for (const part of content) {
    if (plainRecord(part) && part.type === 'text') {
      if (textSeen || !exactKeys(part, ['type', 'text']) || typeof part.text !== 'string') return false;
      textSeen = true;
      meaningfulText = part.text.trim().length > 0;
    } else if (plainRecord(part) && part.type === 'file') {
      if (!exactKeys(part, ['type', 'receiptId']) || !validId(part.receiptId) ||
          receipts.has(part.receiptId) || receipts.size >= 5) return false;
      receipts.add(part.receiptId);
    } else return false;
  }
  return meaningfulText || receipts.size > 0;
}

function validRequest(method, request) {
  if (method === 'workspace/create') {
    return exactKeys(request, ['path']) && validDirectory(request.path);
  }
  if (method === 'session/create') {
    return exactKeys(request, ['workspaceId']) && validId(request.workspaceId);
  }
  if (method === 'session/list') {
    return exactKeys(request, [], ['cursor']) &&
      (!Object.hasOwn(request, 'cursor') || validId(request.cursor));
  }
  if (method === 'session/page') {
    return exactKeys(request, ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow']) &&
      exactKeys(request.address, ['kind', 'sessionId']) &&
      request.address.kind === 'session' && validId(request.address.sessionId) &&
      Number.isSafeInteger(request.throughSeq) && request.throughSeq >= -1 &&
      Number.isSafeInteger(request.beforeSeq) && request.beforeSeq >= 0 &&
      Number.isSafeInteger(request.maxMessages) && request.maxMessages >= 1 && request.maxMessages <= 30 &&
      exactKeys(request.turnWindow, ['minMessages', 'minTurns']) &&
      Number.isSafeInteger(request.turnWindow.minMessages) &&
      request.turnWindow.minMessages >= 1 && request.turnWindow.minMessages <= request.maxMessages &&
      Number.isSafeInteger(request.turnWindow.minTurns) &&
      request.turnWindow.minTurns >= 1 && request.turnWindow.minTurns <= 10;
  }
  if (method === 'session/cancel') {
    return exactKeys(request, ['sessionId']) && validId(request.sessionId);
  }
  if (method === 'session/prompt') {
    return exactKeys(request, ['requestId', 'sessionId', 'mode', 'content']) &&
      validId(request.requestId) && validId(request.sessionId) &&
      (request.mode === 'queue' || request.mode === 'steer') &&
      validPromptContent(request.content);
  }
  if (method === '$events/result') {
    return exactKeys(request, ['clientId', 'eventId', 'outcome']) &&
      validId(request.clientId) && validId(request.eventId) &&
      validEventOutcome(request.outcome);
  }
  // ── 选模型 / 选模式 ────────────────────────────────────────────────────────
  //
  // 两个"列"的方法（modelCatalog / agentPresets/list）按只读处理：不接受任何
  // 业务参数，最多带一个 sessionId。
  //
  // 两个"设"的方法参数形状没能从 DSH 里确认到（它打包在 asar 里，只看得到方法名）。
  // 所以这里**宽松但有边界**：只允许「sessionId + 恰好一个候选键」，
  // 键名限定在几个显然的写法里，值必须是合法 id。
  // 形状猜错时 DSH 会回一个参数错误 —— 那是安全失败（界面把错误显示出来），
  // 不会改坏会话；而这里挡住的是"随便塞任意结构进 DSH"。
  if (method === 'session/modelCatalog') {
    return exactKeys(request, [], ['sessionId']) &&
      (!Object.hasOwn(request, 'sessionId') || validId(request.sessionId));
  }
  if (method === 'agentPresets/list') {
    return exactKeys(request, [], ['sessionId']) &&
      (!Object.hasOwn(request, 'sessionId') || validId(request.sessionId));
  }
  if (method === 'session/selectModel') {
    return selectRequest(request, ['modelId', 'model'], ['reasoningEffort', 'provider']);
  }
  // C20 思考强度：DSH 的 schema 是
  //   { sessionId, provider, model, reasoningEffort?: string (readonly, optional) }
  // —— 它**和选模型是同一个方法**，只是多带一个可选字段。
  // 上一版这里只允许「sessionId + 恰好一个候选键」，于是带 reasoningEffort
  // 的那次提交被桥当成多余字段挡掉（界面显示 invalid-rpc-request）——
  // 表现就是"模型能选、思考强度选不了"。
  //
  // ★ `provider` 也在可选字段里，但会被原样放行：DSH 的模型目录是
  //   `groups[].models[]`，组名就是 provider，选模型时一起带上它最稳。
  if (method === 'session/updateQueue') {
    return validQueueUpdate(request);
  }
  // C12 读排队消息。只读、只认一个 sessionId。
  if (method === 'session/projections') {
    return exactKeys(request, ['sessionId']) && validId(request.sessionId);
  }
  if (method === 'agentPresets/select') {
    // 真正摊平的双参数：`{ agentId, agentPreset }`。
    // 上一版按「sessionId + 候选键」去猜（还猜了 presetId / preset / id 三个名字），
    // 而 DSH 的 descriptor 写得很明确：
    //   { name:'agent', wire:'agentId', source:'lookup' } + { name:'agentPreset', wire:'agentPreset' }
    // —— 也就是说这个功能在手机端**从来没成功过**（一直靠错误信息猜形状）。
    if (!exactKeys(request, ['agentId', 'agentPreset'])) return false;
    return validId(request.agentId) && validId(request.agentPreset);
  }
  // 会话模式（计划 / 目标 / 标准）。参数形状仍未确认，所以按候选键名宽松校验 ——
  // 猜错时 DSH 会回参数错误，界面会把错误显示出来，照错误改即可。
  if (method === 'session/selectMode') {
    return selectRequest(request, ['modeId', 'mode', 'id']);
  }
  // ── 斜杠命令（压缩上下文走这里）─────────────────────────────────────────
  //
  // 这两个方法的 args 是**摊开的**，因为它们的 descriptor 没有 `request` 参数：
  //   commands/list    → { agentId }
  //   commands/execute → { agentId, line, submittedAttachments }
  // 这一点是从 asar 里那段 `assertExactArguments` 反推出来的（它按
  // `descriptor.parameters[].wire` 逐个核对字段名），再由上面的 schema 确认：
  //   line: string()；submittedAttachments: array(image|file-receipt)
  // 只放行**一条单行、不带参数**的命令（`/compact` 这种），并且不允许附件 ——
  // 手机端要的就是"按一下压缩"，没有别的东西要送进去。
  if (method === 'commands/list') {
    return exactKeys(request, ['agentId']) && validId(request.agentId);
  }
  if (method === 'commands/execute') {
    return exactKeys(request, ['agentId', 'line'], ['submittedAttachments']) &&
      validId(request.agentId) && validCommandLine(request.line) &&
      (!Object.hasOwn(request, 'submittedAttachments') ||
        (Array.isArray(request.submittedAttachments) && request.submittedAttachments.length === 0));
  }
  // ── C26 目标 ───────────────────────────────────────────────────────────────
  //
  // 这六个方法的 args 都是**摊平**的（每个业务字段各是一个 descriptor 参数，
  // 其中 agentId 来自 scope 的 lookup）—— 和 commands/*、agentPresets/select 同类。
  if (method === 'goals/create') {
    return exactKeys(request, ['agentId', 'request']) && validId(request.agentId) &&
      validGoalPatch(request.request, true);
  }
  if (method === 'goals/edit') {
    return exactKeys(request, ['agentId', 'ref', 'request']) && validId(request.agentId) &&
      validGoalRef(request.ref) && validGoalPatch(request.request, true);
  }
  if (method === 'goals/pause' || method === 'goals/resume' ||
      method === 'goals/complete' || method === 'goals/clear') {
    return exactKeys(request, ['agentId', 'ref']) && validId(request.agentId) &&
      validGoalRef(request.ref);
  }
  return false;
}

async function readLimited(req) {
  const length = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw Object.assign(new Error('too-large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw Object.assign(new Error('too-large'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function responseBody(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (plainRecord(input)) return Buffer.from(JSON.stringify(input), 'utf8');
  return null;
}

function createDshLiteRpc(options = {}) {
  if (typeof options.callUpstream !== 'function') throw new TypeError('callUpstream is required');

  return async function handleDshLiteRpc(req, res) {
    function reply(status, value) {
      if (res.destroyed || res.writableEnded) return;
      const body = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(body);
    }

    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
    // Only e2eeWrap's in-process request shim can prove that the body was
    // decrypted. A client can supply the header without encrypting anything.
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'json-required' }); return;
    }

    let input;
    try {
      const raw = await readLimited(req);
      input = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      reply(error && error.status === 413 ? 413 : 400, { error: error && error.status === 413 ? 'request-too-large' : 'invalid-json' });
      return;
    }
    if (!exactKeys(input, ['method', 'request']) || !METHODS.has(input.method) ||
        !validRequest(input.method, input.request)) {
      reply(400, { error: 'invalid-rpc-request' }); return;
    }

    // ★ 每个方法的 args **包装方式不一样**，这一点只能从 DSH 的错误里看出来。
    //
    //   实测（2026-09-29）：`session/modelCatalog` 不接受 `{request: …}` 这层包装，
    //   DSH 回的是
    //     `args fields do not match the descriptor: unexpected "request"`
    //   规则本身在 DSH 里是明确的（asar 的 `assertExactArguments`）：
    //   args 的键必须**逐个等于** descriptor 里每个参数的 `wire` 名，不多不少。
    //     · 单参数、wire 名就是 "request" → args = { request: {...} }
    //       （session/prompt、session/page、session/selectModel、session/updateQueue、
    //        session/projections…）
    //     · **没有参数**（parameters: []）→ args = {}，所以"摊平"其实是空对象
    //       （session/modelCatalog、agentPresets/list）
    //     · 多参数、每个业务字段各是一个参数 → args 直接就是那些字段
    //       （$events/result、commands/list、commands/execute、agentPresets/select）
    //   下面这张表照这条规则列；**拿不准的一律走"两种都试"**（见下面的重试），
    //   因为猜错的代价是"功能静默不可用"，而多试一次的代价只是一个来回。
    const FLAT_ARGS = new Set(['$events/result', 'session/modelCatalog', 'agentPresets/list',
      'commands/list', 'commands/execute', 'agentPresets/select',
      // C26 目标：{agentId} 或 {agentId, ref} 或 {agentId, ref, request} —— 都是摊平的
      'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear']);
    const shapeOf = (method) => {
      if (FLAT_ARGS.has(method)) return input.request;
      if (method === 'session/list') return { _request: input.request };
      return { request: input.request };
    };
    const args = shapeOf(input.method);
    const wire = { type: 'client-request', rpcId: crypto.randomUUID(), method: input.method,
      payload: { args } };
    const body = Buffer.from(JSON.stringify(wire), 'utf8');
    if (body.length > MAX_REQUEST_BYTES) { reply(413, { error: 'request-too-large' }); return; }

    try {
      let upstream = await sendUpstream(input.method, body);
      let decoded = decodeResult(upstream, wire.rpcId);

      // args 形状猜错时 DSH 会明确说是哪一个字段不对。与其把这句错误丢给使用者
      // （界面只能显示"DSH 拒绝了请求：gateway/arguments-invalid"），不如**换一种
      // 形状再发一次**：两种形状里必有一种是对的，另一种只会得到同一个错误。
      // 这一步不会把请求变成"别的东西" —— 换的只是外层包装，业务字段一模一样。
      if (decoded && decoded.error && decoded.error.code === 'gateway/arguments-invalid') {
        const alternate = FLAT_ARGS.has(input.method) ? { request: input.request } : input.request;
        const retryWire = { type: 'client-request', rpcId: crypto.randomUUID(), method: input.method,
          payload: { args: alternate } };
        const retryBody = Buffer.from(JSON.stringify(retryWire), 'utf8');
        if (retryBody.length <= MAX_REQUEST_BYTES) {
          const retryDecoded = decodeResult(await sendUpstream(input.method, retryBody), retryWire.rpcId);
          if (retryDecoded) decoded = retryDecoded;
        }
      }
      if (!decoded) { reply(502, { error: 'upstream-rpc-invalid' }); return; }
      // Keep the official result including a domain failure. Never proxy
      // arbitrary upstream headers, cookies, redirects, or raw error pages.
      reply(200, { result: decoded });
    } catch (_) {
      reply(502, { error: 'upstream-rpc-unavailable' });
    }

    /** 发一帧给上游，拿回原始响应。 */
    function sendUpstream(method, body) {
      return options.callUpstream({ path: '/api/' + method, method: 'POST', body,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length),
          'accept': 'application/json', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    }

    /**
     * 把上游回应解成 DSH 的官方 result 对象；形状不对就返回 null。
     *
     * `result.ok` 既可能是 true（成功）也可能是 false（**领域错误**）——
     * 后者必须原样带回界面（"排队项已经不在队列里"这类信息只能从这里看到）。
     */
    function decodeResult(upstream, rpcId) {
      const status = upstream && Number(upstream.statusCode ?? upstream.status);
      const bytes = upstream && responseBody(upstream.body);
      if (status !== 200 || !bytes || bytes.length > MAX_RESPONSE_BYTES) return null;
      let decoded;
      try { decoded = JSON.parse(bytes.toString('utf8')); } catch (_) { return null; }
      if (!plainRecord(decoded) || decoded.rpcId !== rpcId || !plainRecord(decoded.result) ||
          typeof decoded.result.ok !== 'boolean') return null;
      return decoded.result;
    }
  };
}

module.exports = { createDshLiteRpc, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
