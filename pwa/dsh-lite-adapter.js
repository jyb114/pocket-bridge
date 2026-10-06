(function (global) {
  'use strict';

  // A small view over the computer's DSH gateway. The official plugin bundle is
  // never loaded here; only the observed remote.mux protocol is supported.
  var socket = null;
  var serial = 0;
  var generation = 0;
  var listener = function () {};
  var workspaces = [];
  var sessionSummaries = new Map();
  var workspaceReady = false;
  var initial = null;
  var sessionRequest = null;
  var activeSessionId = '';
  var activeSessionStream = '';
  var clientId = '';
  var pendingInteractions = new Map();
  var activeRecords = [];
  var activeJournal = [];
  var activeHasMore = false;
  var activeCursor = -1;
  var activeFirstSeq = 0;
  var activeAttempt = null;
  var assistantRevision = null;
  var reconnectTimer = null;
  var reconnectCount = 0;
  var reconnecting = false;
  var reconnectSince = 0;
  var live = false;
  var pageRequest = null;
  var toolRows = new Map();
  var rebaselineCount = 0;
  var pendingPrompt = null;
  var hiddenAt = 0;
  var resumeHandler = null;
  // 这次断开是不是**我们自己为了进后台而主动关的**。
  // 用来区分「人不在看，别白耗电重连」和「连接真的掉了，要重连」。
  var backgrounded = false;

  function error(message) { var e = new Error(message); e.userMessage = message; return e; }

  /**
   * 从 DSH 的列表回应里取出条目。
   *
   * ★ 取不到已知字段时**不返回空数组**，而是返回一行"原始回应" ——
   *   为什么：`session/modelCatalog` / `agentPresets/list` 的返回结构没有文档，
   *   字段名是猜的。猜不中就是空数组，界面显示"电脑没有报回可选项"，
   *   于是**看不出是"真没数据"还是"字段名猜错了"**（用户报的正是"点进去无任何内容"）。
   *   把原始 JSON 显示出来，空列表立刻变成线索。
   *   这一行的 id 以 `__` 开头，界面认得出来，不会让人误点。
   */
  function pickList(out, keys) {
    var payload = out && out.ok === true && out.value !== undefined ? out.value : out;
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') {
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
      }
      // 模型目录是**分组**的（实测 2026-09-29 拿到真实数据后才看清）：
      //   { default:{…}, routableProviders:[…], groups:[{id,name,models:[{id,name,…}]}] }
      // 所以要摊平 groups[].models，并把组名带上 —— 否则界面永远显示"未识别"。
      if (Array.isArray(payload.groups)) {
        var flat = [];
        payload.groups.forEach(function (g) {
          var gname = (g && (g.name || g.id)) || '';
          // ★ provider 就是这一层的组 id/名 —— **选模型时必须把它一起提交**
          //   （schema 是 { sessionId, provider, model, reasoningEffort? }）。
          //   把它随每个模型带出去，界面就不用再去猜"这个模型属于哪个 provider"。
          var provider = (g && (g.id || g.name)) || '';
          var list = (g && Array.isArray(g.models)) ? g.models : [];
          list.forEach(function (m) {
            if (!m || !m.id) return;
            var eff = (m.reasoning && Array.isArray(m.reasoning.efforts)) ? m.reasoning.efforts : [];
            flat.push({ id: m.id, name: (m.name || m.id) + (gname ? '（' + gname + '）' : ''),
              provider: String(provider),
              defaultEffort: (m.reasoning && m.reasoning.defaultEffort) || '',
              efforts: eff.map(function (e) { return { id: e.id, name: e.name || e.id,
                description: typeof e.description === 'string' ? e.description : '' }; }) });
          });
        });
        if (flat.length) return flat;
      }
      var names = Object.keys(payload);
      if (names.length) {
        return [{ id: '__diagnostic__', name: '未识别的回应（键：' + names.join(', ') + '）' +
          JSON.stringify(payload).slice(0, 400) }];
      }
    }
    return [];
  }
  function emit(value) { try { listener(value); } catch (_) {} }
  function id() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }
  function send(value) {
    if (!socket || socket.readyState !== 1) throw error('与电脑的连接已断开，请重连。');
    socket.send(JSON.stringify(value));
  }
  function openStream(name, endpoint, request) {
    send({ type: 'open', streamId: name, endpoint: endpoint,
      payload: { args: request === undefined ? {} : { request: request } } });
  }
  function cancelStream(name) {
    if (name && socket && socket.readyState === 1) {
      try { send({ type: 'cancel', streamId: name }); } catch (_) {}
    }
  }
  function projectList() {
    return workspaces.map(function (w) {
      return { id: String(w.workspaceId || w.id || ''),
        name: String(w.title || w.path || '未命名项目'), path: String(w.path || '') };
    }).filter(function (w) { return w.id; });
  }
  function modelSelection(value) {
    if (!value || typeof value !== 'object') return null;
    var provider = typeof value.provider === 'string' ? value.provider : '';
    var model = typeof value.model === 'string' ? value.model : '';
    if (!provider || !model) return null;
    var selected = { provider: provider, model: model };
    if (typeof value.reasoningEffort === 'string' && value.reasoningEffort)
      selected.reasoningEffort = value.reasoningEffort;
    return selected;
  }
  function planMode(value) {
    return value && typeof value.active === 'boolean' && typeof value.pending === 'boolean'
      ? { active: value.active, pending: value.pending } : null;
  }
  function selectionState(values, blankFallback) {
    var modelState = values && values.modelSelection;
    var metadata = values && values.sessionListMetadata;
    return {
      agentPreset: values && typeof values.agentPreset === 'string' && values.agentPreset
        ? values.agentPreset : null,
      // `next` includes a pending choice and is the model the next turn will use.
      // `lastUsed` is only what a previous turn used; the two may differ.
      modelSelection: modelSelection(modelState && modelState.next),
      lastUsedModel: modelSelection(modelState && modelState.lastUsed),
      // The plan projection is absent when this preset/version has no plan mode.
      // `/plan` only enters; `/plan off` leaves. `pending` awaits the next step.
      plan: planMode(values && values.plan),
      blank: metadata && typeof metadata.blank === 'boolean' ? metadata.blank
        : typeof blankFallback === 'boolean' ? blankFallback : null
    };
  }
  function sessionList(projectId) {
    var project = workspaces.find(function (w) { return String(w.workspaceId || w.id) === String(projectId); });
    if (!project || !Array.isArray(project.sessionIds)) return [];
    // DSH's durable Workspace.attachSession prepends a newly created ID.
    // This array is already newest-first. Reversing it made the new chat
    // appear as "对话 1" while old untitled chats changed their numbers.
    return project.sessionIds.map(function (sessionId, index) {
      var summary = sessionSummaries.get(String(sessionId));
      var values = summary && summary.projections && summary.projections.values;
      var title = values && values.title;
      var selection = selectionState(values, summary && summary.blank);
      return { id: String(sessionId), title: typeof title === 'string' && title.trim() ? title :
        '对话 ' + (project.sessionIds.length - index),
        blank: selection.blank, agentPreset: selection.agentPreset,
        modelSelection: selection.modelSelection, lastUsedModel: selection.lastUsedModel,
        plan: selection.plan };
    });
  }
  function publishWorkspaces() {
    emit({ type: 'projects', projects: projectList() });
    workspaces.forEach(function (w) {
      var projectId = String(w.workspaceId || w.id || '');
      if (projectId) emit({ type: 'sessions', projectId: projectId, sessions: sessionList(projectId) });
    });
  }
  function textParts(value, depth) {
    if (depth > 4 || value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(function (x) { return textParts(x, depth + 1); }).filter(Boolean).join('');
    if (typeof value !== 'object') return '';
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return textParts(value.content, depth + 1);
    if (value.message && typeof value.message === 'object') return textParts(value.message, depth + 1);
    return '';
  }
  function bounded(value, max) { return String(value || '').slice(0, max); }
  function messageAttachments(content) {
    if (!Array.isArray(content)) return [];
    return content.filter(function (block) {
      return block && (block.type === 'file' || block.type === 'image') && block.attachment && typeof block.attachment === 'object';
    }).slice(0, 32).map(function (block) {
      var item = block.attachment;
      return { id: String(item.id || item.attachmentId || ''),
        name: bounded(item.name || (block.type === 'image' ? '图片' : '文件'), 500),
        mimeType: bounded(item.mimeType || item.mediaType || '', 100),
        size: Number.isSafeInteger(item.bytes) ? item.bytes : Number.isSafeInteger(item.size) ? item.size : null,
        kind: block.type,
        path: typeof item.path === 'string' ? item.path : '' };
    });
  }
  function contentText(content, type) {
    if (!Array.isArray(content)) return '';
    return content.filter(function (block) { return block && block.type === type && typeof block.text === 'string'; })
      .map(function (block) { return block.text; }).join('');
  }
  function assistantRowId(data, message) {
    return Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step) ?
      'assistant:' + data.turn + ':' + data.step : String(message.id || data.id || '');
  }
  function normalizeRecord(record) {
    var event = record && (record.type === 'event' ? record.event : record.event || record);
    if (!event || typeof event.type !== 'string' || (event.surfaceOp && event.surfaceOp !== 'append')) return [];
    var data = event.data || {};
    if (event.type === 'turn/end' && data.reason && data.reason.kind === 'error') {
      var failure = data.reason.error || {};
      var failureText = Number(failure.status) === 401 || failure.code === 'AUTH'
        ? 'DSH 的模型服务拒绝了凭据（401）。请在电脑端更新 API key 后重试。'
        : Number(failure.status) === 402
          ? 'DSH 的模型账户余额不足。请在电脑端检查账户后重试。'
          : Number(failure.status) === 429
            ? 'DSH 的模型服务请求过于频繁。请稍后重试。'
            : bounded(failure.message || '模型请求未完成，请在电脑端检查 DSH 后重试。', 2000)
              .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_-]{12,}/gi, '[redacted]');
      return [{ id: 'turn-error:' + String(data.turn || event.seq), role: 'system',
        title: '模型请求失败', text: failureText, status: 'error' }];
    }
    if (event.type === 'user/message') {
      if (data.source && data.source.kind !== 'user') return [];
      var text = contentText(data.content, 'text') || textParts(data, 0);
      var attachments = messageAttachments(data.content);
      return text || attachments.length ? [{ id: String(data.id || event.seq), role: 'user', text: text,
        attachments: attachments }] : [];
    }
    if (event.type === 'assistant/message') {
      var message = data.message && typeof data.message === 'object' ? data.message : {};
      var base = assistantRowId(data, message);
      var answer = contentText(message.content, 'text');
      var thought = contentText(message.content, 'reasoning');
      var images = messageAttachments(message.content);
      var rows = [];
      if (thought) rows.push({ id: base + ':thought', role: 'thought', title: '思考过程',
        text: thought, status: data.interrupted === true ? 'interrupted' : 'settled' });
      if (answer || images.length) rows.push({ id: base, role: 'assistant', text: answer,
        status: data.interrupted === true ? 'interrupted' : 'settled', attachments: images });
      return rows;
    }
    if (event.type === 'tool/call' && data.callId) {
      var callId = String(data.callId), args = String(data.arguments || '');
      var row = { id: 'tool:' + callId, role: 'tool', title: bounded(data.name || '工具调用', 300),
        text: args, status: 'running' };
      toolRows.set(callId, row);
      return [row];
    }
    if (event.type === 'tool/result' && data.message && data.message.source && data.message.source.callId) {
      var resultId = String(data.message.source.callId);
      var previous = toolRows.get(resultId);
      var output = contentText(data.message.content, 'text');
      var fileParts = messageAttachments(data.message.content);
      var completed = { id: 'tool:' + resultId, role: 'tool',
        title: previous ? previous.title : '工具结果',
        text: (previous && previous.text ? previous.text + '\n\n' : '') + output,
        status: data.message.isError === true ? 'error' : 'settled', attachments: fileParts };
      toolRows.set(resultId, completed);
      return [completed];
    }
    return [];
  }
  function normalizeRecords(records) {
    var all = [], positions = new Map();
    (Array.isArray(records) ? records : []).forEach(function (entry) {
      normalizeRecord(entry).forEach(function (row) {
        var index = positions.get(row.id);
        if (index === undefined) { positions.set(row.id, all.length); all.push(row); }
        else all[index] = row;
      });
    });
    return all;
  }
  function journalRange(records) {
    if (!Array.isArray(records)) return null;
    var first = null, last = null;
    for (var i = 0; i < records.length; i++) {
      var entry = records[i];
      var seq = entry && entry.type === 'event' && entry.event && entry.event.seq;
      if (!Number.isSafeInteger(seq) || seq < 0 || (last !== null && seq !== last + 1)) return null;
      if (first === null) first = seq;
      last = seq;
    }
    return { first: first, last: last };
  }
  function settleInitial(ok, problem) {
    if (!initial) return;
    var waiting = initial;
    initial = null;
    clearTimeout(waiting.timer);
    if (ok) waiting.resolve(); else waiting.reject(problem || error('加载项目失败，请重连。'));
  }
  function settleSession(value, problem) {
    if (!sessionRequest) return;
    var waiting = sessionRequest;
    sessionRequest = null;
    clearTimeout(waiting.timer);
    if (problem) waiting.reject(problem); else waiting.resolve(value);
  }
  function settlePage(value, problem) {
    if (!pageRequest) return;
    var waiting = pageRequest;
    pageRequest = null;
    if (problem) waiting.reject(problem); else waiting.resolve(value);
  }
  function recordIndex(idValue) {
    return activeRecords.findIndex(function (row) { return row && row.id === idValue; });
  }
  function upsertActive(row, publish) {
    if (!row || !row.id) return;
    var index = recordIndex(row.id);
    if (index < 0) activeRecords.push(row); else activeRecords[index] = row;
    if (publish) emit({ type: 'record', sessionId: activeSessionId, record: row });
  }
  function attemptRows() {
    if (!activeAttempt) return [];
    var base = 'assistant:' + activeAttempt.turn + ':' + activeAttempt.step;
    var blocks = Array.from(activeAttempt.blocks.entries()).sort(function (a, b) { return a[0] - b[0]; });
    var answer = blocks.filter(function (pair) { return pair[1].type === 'text'; })
      .map(function (pair) { return pair[1].text; }).join('');
    var thought = blocks.filter(function (pair) { return pair[1].type === 'reasoning'; })
      .map(function (pair) { return pair[1].text; }).join('');
    var rows = [];
    if (thought) rows.push({ id: base + ':thought', role: 'thought', title: '思考过程', text: thought, status: 'running' });
    if (answer) rows.push({ id: base, role: 'assistant', text: answer, status: 'running' });
    blocks.forEach(function (pair) {
      var block = pair[1];
      if (block.type === 'tool-call' && block.id && block.name) rows.push({
        id: 'tool:' + block.id, role: 'tool', title: bounded(block.name, 300),
        text: block.arguments, status: 'preparing'
      });
    });
    return rows;
  }
  function foldChunk(chunk) {
    if (!activeAttempt || !chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 0) return;
    var block = activeAttempt.blocks.get(chunk.index) || { type: '', text: '', id: '', name: '', arguments: '' };
    if (chunk.type === 'block-start') {
      block = { type: chunk.blockType, text: '', id: '', name: '', arguments: '' };
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      block.type = chunk.type === 'text-delta' ? 'text' : 'reasoning';
      block.text += String(chunk.text || '');
    } else if (chunk.type === 'tool-call-delta') {
      block.type = 'tool-call';
      block.id = String(chunk.id || block.id || '');
      if (typeof chunk.name === 'string') block.name = chunk.name;
      block.arguments += String(chunk.argumentsDelta || '');
    } else if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
      var final = chunk.block;
      block = { type: String(final.type || ''), text: String(final.text || ''),
        id: String(final.id || ''), name: String(final.name || ''), arguments: String(final.arguments || '') };
    }
    activeAttempt.blocks.set(chunk.index, block);
  }
  function compactChunks(records) {
    var chunks = [];
    if (!Array.isArray(records)) return chunks;
    records.slice(0, 10000).forEach(function (record) {
      if (!record || typeof record !== 'object') return;
      if (record.type === 'chunk' && record.chunk) chunks.push(record.chunk);
      else if ((record.type === 'text-chunks' || record.type === 'reasoning-chunks') && Array.isArray(record.texts)) {
        record.texts.slice(0, 10000 - chunks.length).forEach(function (text) {
          chunks.push({ type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text: text });
        });
      } else if (record.type === 'tool-call-chunks' && Array.isArray(record.args)) {
        record.args.slice(0, 10000 - chunks.length).forEach(function (part) {
          chunks.push({ type: 'tool-call-delta', index: record.index, id: record.id,
            name: record.name, argumentsDelta: part });
        });
      }
    });
    return chunks;
  }
  function rebuildRecords() {
    toolRows.clear();
    activeRecords = normalizeRecords(activeJournal);
    attemptRows().forEach(function (row) {
      var index = recordIndex(row.id);
      if (index < 0 || activeRecords[index].status !== 'settled') upsertActive(row, false);
    });
    var latestRunning = null;
    activeJournal.forEach(function (entry) {
      var event = entry && entry.type === 'event' && entry.event;
      if (event && event.type === 'turn/start') latestRunning = true;
      else if (event && event.type === 'turn/end') latestRunning = false;
    });
    // A surviving running/preparing historical row is not the current turn.
    // Only a journal boundary or the explicit current assistant attempt proves
    // running state; an absent boundary stays unknown for older protocols.
    if (activeAttempt) latestRunning = true;
    var snapshot = { type: 'records', sessionId: activeSessionId, records: activeRecords.slice(), hasMore: activeHasMore };
    if (typeof latestRunning === 'boolean') snapshot.running = latestRunning;
    emit(snapshot);
  }
  function beginAssistantStream(value) {
    assistantRevision = value && Number.isSafeInteger(value.revision) ? value.revision : null;
    var opening = value && value.activeAttempt;
    activeAttempt = opening && Number.isSafeInteger(opening.turn) && Number.isSafeInteger(opening.step) ?
      { id: String(opening.attemptId || ''), turn: opening.turn, step: opening.step,
        nextIndex: Number.isSafeInteger(opening.nextIndex) ? opening.nextIndex : 0, blocks: new Map() } : null;
    if (activeAttempt) compactChunks(opening.stream).slice(0, activeAttempt.nextIndex).forEach(foldChunk);
  }
  function publishAttemptRows() {
    attemptRows().forEach(function (row) {
      var index = recordIndex(row.id);
      if (index < 0 || activeRecords[index].status !== 'settled') upsertActive(row, true);
    });
  }
  function rebaselineSession() {
    if (!socket || socket.readyState !== 1 || !activeSessionId) return;
    if (++rebaselineCount > 3) {
      emit({ type: 'error', userMessage: '对话流连续中断，请点重连后重试。' });
      return;
    }
    cancelStream(activeSessionStream);
    activeSessionStream = 'lite-session-' + (++serial);
    try { openSessionStream(); } catch (_) {
      emit({ type: 'error', userMessage: '重新订阅对话失败，请点重连。' });
    }
  }
  function handleAssistantFrame(frame) {
    if (!frame || !Number.isSafeInteger(frame.revision)) return;
    if (assistantRevision !== null && frame.revision !== assistantRevision + 1 &&
        !(frame.type === 'start' && frame.revision === 1)) {
      rebaselineSession(); return;
    }
    assistantRevision = frame.revision;
    if (frame.type === 'start') {
      if (!Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return;
      activeAttempt = { id: String(frame.attemptId || ''), turn: frame.turn, step: frame.step,
        nextIndex: 0, blocks: new Map() };
    } else if (frame.type === 'chunk') {
      if (!activeAttempt || activeAttempt.id !== String(frame.attemptId || '')) return;
      if (frame.index !== activeAttempt.nextIndex) { rebaselineSession(); return; }
      activeAttempt.nextIndex++;
      foldChunk(frame.chunk);
      publishAttemptRows();
    } else if (frame.type === 'end') {
      if (!activeAttempt || activeAttempt.id !== String(frame.attemptId || '')) return;
      if (frame.index !== activeAttempt.nextIndex) { rebaselineSession(); return; }
      activeAttempt = null;
      rebuildRecords();
    }
  }
  function handleWorkspace(value) {
    if (value.type === 'baseline' && value.value && Array.isArray(value.value.items)) {
      workspaces = value.value.items;
      workspaceReady = true;
      publishWorkspaces();
      settleInitial(true);
      reconnecting = false;
      reconnectCount = 0;
      reconnectSince = 0;
      emit({ type: 'status', state: 'connected' });
      refreshSessionSummaries();
    } else if (value.type === 'upsert' && value.workspace) {
      var next = value.workspace;
      var key = String(next.workspaceId || next.id || '');
      var index = workspaces.findIndex(function (w) { return String(w.workspaceId || w.id) === key; });
      if (index < 0) workspaces.push(next); else workspaces[index] = next;
      publishWorkspaces();
    } else if (value.type === 'remove') {
      workspaces = workspaces.filter(function (w) { return String(w.workspaceId || w.id) !== String(value.workspaceId); });
      publishWorkspaces();
    } else if (value.type === 'order' && Array.isArray(value.workspaceIds)) {
      var order = value.workspaceIds.map(String);
      workspaces.sort(function (a, b) { return order.indexOf(String(a.workspaceId || a.id)) - order.indexOf(String(b.workspaceId || b.id)); });
      publishWorkspaces();
    }
  }
  function handleSession(value, streamId) {
    if (streamId !== activeSessionStream || !activeSessionId) return;
    if (value.type === 'snapshot') {
      var range = journalRange(value.records);
      if (!range || !Number.isSafeInteger(value.cursor) || value.cursor < -1 ||
          (range.last !== null && range.last !== value.cursor) ||
          (range.last === null && value.cursor !== -1)) {
        settleSession(null, error('电脑返回的对话快照无效，请重连。'));
        return;
      }
      activeJournal = value.records.slice();
      activeCursor = value.cursor;
      activeFirstSeq = range.first === null ? activeCursor + 1 : range.first;
      activeHasMore = value.hasMore === true;
      rebaselineCount = 0;
      beginAssistantStream(value.assistantStream);
      rebuildRecords();
      var title = value.projections && value.projections.values && value.projections.values.title;
      if (typeof title === 'string' && title.trim()) {
        // A later workspace update will still be authoritative for the list.
        emit({ type: 'session-title', sessionId: activeSessionId, title: title });
      }
      settleSession({ records: activeRecords.slice(), hasMore: activeHasMore,
        interactions: Array.from(pendingInteractions.values()) });
    } else if (value.type === 'event') {
      var event = value.event;
      if (!event || !Number.isSafeInteger(event.seq)) return;
      if (event.seq <= activeCursor) return;
      if (event.seq !== activeCursor + 1) { rebaselineSession(); return; }
      activeCursor = event.seq;
      activeJournal.push(value);
      normalizeRecord(value).forEach(function (row) { upsertActive(row, true); });
      if (event.type === 'turn/start') emit({ type: 'session-status', sessionId: activeSessionId, running: true });
      if (event.type === 'turn/end') emit({ type: 'session-status', sessionId: activeSessionId, running: false });
    } else if (value.type === 'assistant-stream' && value.frame) {
      handleAssistantFrame(value.frame);
    }
  }
  function handleEvents(value) {
    if (value.type === 'ready') {
      clientId = typeof value.clientId === 'string' ? value.clientId : '';
    } else if (value.type === 'cancel' && value.eventId) {
      pendingInteractions.delete(String(value.eventId));
      emit({ type: 'interaction-resolved', id: String(value.eventId) });
    } else if (value.type === 'waterfall') {
      var interaction = normalizeInteraction(value);
      if (interaction) {
        pendingInteractions.set(interaction.id, interaction);
        emit({ type: 'interaction', interaction: interaction });
      }
    }
  }
  function normalizeInteraction(value) {
    if (!value || !value.eventId || !value.agentId) return null;
    var kind = value.event === 'approval/request' ? 'approval' :
      value.event === 'user-questions/request' ? 'question' : '';
    if (!kind) return null;
    var req = value.request || {};
    var text = typeof req.message === 'string' ? req.message :
      typeof req.reason === 'string' ? req.reason :
      typeof req.description === 'string' ? req.description : '';
    var questions = kind === 'question' && Array.isArray(req.questions) ?
      req.questions.filter(function (q) { return q && typeof q.id === 'string' && typeof q.question === 'string'; })
        .map(function (q) { return { id: q.id, question: q.question.slice(0, 3000),
          detail: typeof q.detail === 'string' ? q.detail.slice(0, 3000) : '',
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options) ? q.options.filter(function (o) { return o && typeof o.label === 'string'; })
            .map(function (o) { return { label: o.label.slice(0, 300),
              description: typeof o.description === 'string' ? o.description.slice(0, 500) : '' }; }) : [] }; }) : [];
    return { id: String(value.eventId), sessionId: String(value.agentId), kind: kind,
      title: kind === 'approval' ? 'DSH 请求授权：' + String(req.toolName || '操作').slice(0, 150) : 'DSH 需要回答',
      text: text.slice(0, 3000), questions: questions };
  }
  function handleFrame(raw) {
    var message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'error') {
      var code = message.error && message.error.code;
      var unsupported = code === 'gateway/namespace-not-found' || code === 'gateway/method-not-found';
      var problem = error(code === 'session/not-found' ? '这个对话已不存在，请返回项目列表。' :
        unsupported ? '当前 DSH 不提供新版实时接口，需切换到对应的旧版适配。' :
          'DSH 实时通道返回错误，请重连后重试。');
      if (message.streamId === 'lite-workspaces') {
        settleInitial(false, problem);
        live = false;
        try { if (socket) socket.close(); } catch (_) {}
        emit({ type: 'status', state: 'disconnected', userMessage: problem.userMessage });
      }
      if (message.streamId === activeSessionStream) settleSession(null, problem);
      emit({ type: 'error', userMessage: problem.userMessage });
      return;
    }
    if (message.type !== 'item' || !message.value) return;
    if (message.streamId === 'lite-workspaces') handleWorkspace(message.value);
    else if (message.streamId === 'lite-events') handleEvents(message.value);
    else if (message.streamId === activeSessionStream) handleSession(message.value, message.streamId);
  }
  function openSessionStream() {
    openStream(activeSessionStream, 'session/follow', {
      address: { kind: 'session', sessionId: activeSessionId },
      assistantStream: true, maxMessages: 30,
      turnWindow: { minMessages: 10, minTurns: 1 }
    });
  }
  function scheduleReconnect(epoch) {
    if (!live || epoch !== generation || reconnectTimer) return;
    if (!reconnectSince) reconnectSince = Date.now();
    if (Date.now() - reconnectSince > 60000) {
      live = false;
      settleSession(null, error('连接多次失败，请检查电脑或隧道后点重连。'));
      emit({ type: 'status', state: 'disconnected', userMessage: '连接多次失败，请检查电脑或隧道后点重连。' });
      return;
    }
    reconnecting = true;
    emit({ type: 'status', state: 'connecting', userMessage: '连接中断，正在自动恢复…' });
    var delay = Math.min(8000, 500 * Math.pow(2, Math.min(reconnectCount++, 4)));
    reconnectTimer = global.setTimeout(function () {
      reconnectTimer = null;
      openSocket(epoch, true);
    }, delay);
  }
  /**
   * 页面进入后台：**主动把 WebSocket 关掉**。
   *
   * 为什么不把连接留着：iOS（以及一些安卓浏览器）在页面失活时会**静默丢弃**
   * WebSocket，而 `readyState` 仍然是 1（OPEN）—— 这条连接就成了一个
   * "看着是通的、其实已经死了"的东西。
   *
   * 原来就是留着它，只在「离开超过 10 秒」时才在回前台时重连。于是：
   *   · 离开**不到 10 秒**（**正是系统权限弹窗那种几秒的失活** ——
   *     例如使用者同意麦克风权限）→ 回前台什么都不做 → 连接其实是死的 →
   *     对话内容再也加载不出来 → 只能刷新页面、重新选项目；
   *   · 离开超过 10 秒才走重连那条路 —— 所以表现为"有时好、有时要刷新"。
   *
   * 与其猜它死没死（判不出来），不如自己断掉：回来时一定是干净重连。
   * 顺带的好处：页面在后台时不再维持一条连接，手机省电省流量。
   */
  function goBackground() {
    hiddenAt = Date.now();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) {
      backgrounded = true;                 // 让 onclose 知道：这是我们主动断的
      try { socket.close(1000, 'background'); } catch (_) { /* 已经死了 */ }
    }
  }

  /**
   * 页面回到前台：**无条件重建连接**。
   *
   * 为什么无条件：后台期间的连接状态**不可信**（见 goBackground）。
   * 重建的代价是重发一次 baseline（项目列表 + 当前对话快照），
   * 而"使用者要刷新页面、重新选项目"的代价比它大得多。
   */
  function goForeground(epoch) {
    if (!live || epoch !== generation) return;
    hiddenAt = 0;
    backgrounded = false;
    // iOS 恢复页面时，旧连接可能一直停在 CLOSING，onclose 很晚才来（甚至不来）。
    // 先弃用它，再主动安排新连接；旧连接的回调有 socket !== ws 守卫，不会碰新连接。
    var stale = socket;
    socket = null;
    workspaceReady = false;
    clientId = '';
    settlePage(null, error('加载更早记录时连接中断，恢复后可重试。'));
    pendingInteractions.forEach(function (_item, key) { emit({ type: 'interaction-resolved', id: key }); });
    pendingInteractions.clear();
    if (stale && stale.readyState !== 3) {
      try { stale.close(1000, 'foreground-resync'); } catch (_) {}
    }
    // 后台停留时间不应计入重连失败的 60 秒期限。
    reconnectSince = 0;
    reconnectCount = 0;
    scheduleReconnect(epoch);
  }
  async function openSocket(epoch, reprove) {
    if (!live || epoch !== generation) return;
    if (reprove) {
      try {
        if (!await global.DshE2EE.prove(true)) { scheduleReconnect(epoch); return; }
      } catch (_) { scheduleReconnect(epoch); return; }
      if (!live || epoch !== generation) return;
    }
    var protocol = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + global.location.host + '/api/remote.mux';
    var ws;
    try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(epoch); return; }
    socket = ws;
    ws.onopen = function () {
      if (!live || epoch !== generation || socket !== ws) return;
      try {
        openStream('lite-events', '$events');
        openStream('lite-workspaces', 'workspace/follow');
        if (activeSessionId) {
          activeSessionStream = 'lite-session-' + (++serial);
          openSessionStream();
        }
      } catch (_) { try { ws.close(); } catch (_) {} }
    };
    ws.onmessage = function (event) {
      if (live && epoch === generation && socket === ws && typeof event.data === 'string') handleFrame(event.data);
    };
    ws.onerror = function () { /* Browser WS errors are followed by onclose. */ };
    ws.onclose = function () {
      if (!live || epoch !== generation || socket !== ws) return;
      socket = null;
      workspaceReady = false;
      clientId = '';
      settlePage(null, error('加载更早记录时连接中断，恢复后可重试。'));
      pendingInteractions.forEach(function (_item, key) { emit({ type: 'interaction-resolved', id: key }); });
      pendingInteractions.clear();
      // 我们主动为了进后台而断的：**不要在这里重连** —— 人没在看，重连纯属白耗电和流量。
      // 回到前台时 goForeground 会重新建连。
      if (backgrounded) return;
      scheduleReconnect(epoch);
    };
  }
  async function connect(callback) {
    disconnect();
    listener = typeof callback === 'function' ? callback : function () {};
    var epoch = ++generation;
    workspaces = []; workspaceReady = false; clientId = '';
    sessionSummaries.clear();
    emit({ type: 'status', state: 'connecting' });
    var e2ee = global.DshE2EE;
    if (!e2ee || !e2ee.available() || !global.__dshE2eeSecret) {
      throw error('缺少加密连接密钥。请用电脑控制台复制完整的轻量版地址打开。');
    }
    if (!await e2ee.prove(true)) throw error('连接授权未通过。请重新打开完整的轻量版地址。');
    if (epoch !== generation) return;
    live = true;
    if (global.document && typeof global.document.addEventListener === 'function') {
      resumeHandler = function () {
        if (global.document.visibilityState === 'hidden') { goBackground(); return; }
        goForeground(epoch);
      };
      global.document.addEventListener('visibilitychange', resumeHandler);
    }
    await new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        settleInitial(false, error('加载项目超时。请检查电脑和隧道，再点重连。'));
        live = false;
        try { if (socket) socket.close(); } catch (_) {}
      }, 45000);
      initial = { resolve: resolve, reject: reject, timer: timer };
      openSocket(epoch, false);
    });
    if (epoch !== generation) return;
  }
  function disconnect() {
    generation++;
    live = false;
    if (resumeHandler && global.document && typeof global.document.removeEventListener === 'function')
      global.document.removeEventListener('visibilitychange', resumeHandler);
    resumeHandler = null; hiddenAt = 0; reconnectSince = 0; reconnectCount = 0;
    backgrounded = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    settleInitial(false, error('连接已取消。'));
    settleSession(null, error('连接已取消。'));
    settlePage(null, error('连接已取消。'));
    try { if (socket) socket.close(1000, 'switch'); } catch (_) {}
    socket = null;
    activeSessionId = ''; activeSessionStream = '';
    activeRecords = []; activeJournal = []; activeHasMore = false; activeCursor = -1;
    activeAttempt = null; assistantRevision = null; toolRows.clear();
    pendingInteractions.clear();
  }
  async function rpc(method, request) {
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-rpc', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ method: method, request: request })
    }); };
    var response = await invoke();
    if (response.status === 403) {
      if (await e2ee.prove(true)) response = await invoke();
    }
    if (response.status === 401 || response.status === 403) throw error('连接授权未通过，请重新打开完整的轻量版地址。');
    if (!response.ok) throw error(response.status === 400 &&
      (method === 'session/page' || method === 'session/cancel') ?
      '桥服务尚未更新此功能，请先更新电脑端桥并重启服务。' :
      '电脑端 DSH 请求失败（HTTP ' + response.status + '），请重试。');
    var body;
    try { body = await response.json(); } catch (_) { throw error('电脑端返回的数据无法读取。'); }
    if (!body || !body.result || body.result.ok !== true) {
      var code = body && body.result && body.result.error && body.result.error.code;
      throw error(code ? 'DSH 拒绝了请求：' + String(code).slice(0, 100) : 'DSH 没有完成请求，请重试。');
    }
    return body.result.value || {};
  }
  async function refreshSessionSummaries() {
    var epoch = generation;
    try {
      var result = await rpc('session/list', {});
      if (epoch !== generation || !Array.isArray(result.items)) return;
      result.items.forEach(function (entry) {
        if (entry && entry.sessionId) sessionSummaries.set(String(entry.sessionId), entry);
      });
      publishWorkspaces();
    } catch (_) { /* IDs from workspace/follow remain usable without titles. */ }
  }
  function loadSession(sessionId) {
    if (!workspaceReady || !socket || socket.readyState !== 1) return Promise.reject(error('连接尚未准备好，请重连。'));
    cancelStream(activeSessionStream);
    settleSession(null, error('已切换对话。'));
    settlePage(null, error('已切换对话。'));
    activeSessionId = String(sessionId);
    activeSessionStream = 'lite-session-' + (++serial);
    activeRecords = []; activeJournal = []; activeHasMore = false; activeCursor = -1;
    activeAttempt = null; assistantRevision = null; toolRows.clear();
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        settleSession(null, error('加载对话超时，请点重连后重试。'));
      }, 60000);
      sessionRequest = { resolve: resolve, reject: reject, timer: timer };
      try { openSessionStream(); } catch (problem) { settleSession(null, problem); }
    });
  }
  async function loadOlder(sessionId) {
    var selected = String(sessionId || '');
    if (!selected || selected !== activeSessionId) throw error('请先打开要查看的对话。');
    if (!workspaceReady || !socket || socket.readyState !== 1) throw error('连接尚未恢复，请稍后重试。');
    if (!activeHasMore) return { records: activeRecords.slice(), hasMore: false };
    if (!Number.isSafeInteger(activeCursor) || activeCursor < -1 ||
        !Number.isSafeInteger(activeFirstSeq) || activeFirstSeq < 0) throw error('历史游标无效，请重开对话。');
    if (pageRequest) throw error('正在加载更早记录，请稍等。');
    var epoch = generation, firstSeq = activeFirstSeq, streamId = activeSessionStream;
    var result = await new Promise(function (resolve, reject) {
      pageRequest = { resolve: resolve, reject: reject };
      rpc('session/page', { address: { kind: 'session', sessionId: selected },
        throughSeq: activeCursor, beforeSeq: firstSeq, maxMessages: 20,
        turnWindow: { minMessages: 10, minTurns: 1 } }).then(function (value) {
        settlePage(value);
      }, function (problem) { settlePage(null, problem); });
    });
    if (epoch !== generation || selected !== activeSessionId || streamId !== activeSessionStream ||
        firstSeq !== activeFirstSeq) throw error('对话已更新，请重新加载更早记录。');
    if (!result || !Array.isArray(result.records) || typeof result.hasMore !== 'boolean')
      throw error('电脑返回的历史页无效，请重试。');
    var range = journalRange(result.records);
    if (!range || (range.last !== null && range.last !== firstSeq - 1) ||
        (range.last === null && result.hasMore)) throw error('历史页顺序无效，请重试。');
    activeJournal = result.records.concat(activeJournal);
    activeFirstSeq = result.records.length ? result.records[0].event.seq : firstSeq;
    activeHasMore = result.hasMore;
    rebuildRecords();
    return { records: activeRecords.slice(), hasMore: activeHasMore };
  }
  async function listDirectories(path) {
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
    var request = path === undefined ? {} : { path: String(path) };
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/directories', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(request)
    }); };
    var response = await invoke();
    if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
    if (!response.ok) throw error(response.status === 403 ? '读取电脑目录的授权已过期，请重连。' :
      '读取电脑目录失败（HTTP ' + response.status + '）。');
    var value;
    try { value = await response.json(); } catch (_) { throw error('电脑返回的目录信息无法读取。'); }
    if (!value || value.ok !== true || typeof value.path !== 'string' || !Array.isArray(value.roots) ||
        !Array.isArray(value.directories)) throw error('电脑返回的目录信息无效。');
    return value;
  }
  async function cancelSession(sessionId) {
    var value = await rpc('session/cancel', { sessionId: String(sessionId || '') });
    if (value.accepted !== true) throw error('DSH 没有接受停止请求，请重试。');
    return { accepted: true };
  }
  async function listWorkspaceFiles(input) {
    var sessionId = String(input && input.sessionId || '');
    var directory = input && input.path !== undefined ? String(input.path) : '';
    var offset = input && input.offset !== undefined ? Number(input.offset) : 0;
    if (!sessionId || !Number.isSafeInteger(offset) || offset < 0) throw error('文件列表请求无效。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-files', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: sessionId, path: directory, offset: offset })
    }); };
    var response = await invoke();
    if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
    if (!response.ok) throw error(response.status === 404 ? '桥服务尚未更新文件浏览功能。' :
      '读取工作区文件失败（HTTP ' + response.status + '）。');
    var result;
    try { result = await response.json(); } catch (_) { throw error('文件列表无法读取。'); }
    if (result && result.value && result.ok === true) result = result.value;
    if (!result || typeof result.path !== 'string' || !Array.isArray(result.entries) || result.entries.length > 100 ||
        !(result.nextOffset === null || (Number.isSafeInteger(result.nextOffset) &&
          result.nextOffset > offset)) ||
        result.entries.some(function (item) { return !item || typeof item.name !== 'string' ||
          typeof item.path !== 'string' || (item.type !== 'directory' && item.type !== 'file'); }))
      throw error('电脑返回的文件列表无效。');
    return result;
  }
  async function createProject(input) {
    var value = await rpc('workspace/create', { path: String(input.path || '') });
    var workspace = value.workspace || {};
    var projectId = workspace.workspaceId || workspace.id;
    if (!projectId) throw error('电脑创建项目后没有返回项目编号。');
    var next = Object.assign({ workspaceId: projectId, path: input.path, sessionIds: [] }, workspace);
    var index = workspaces.findIndex(function (w) { return String(w.workspaceId || w.id) === String(projectId); });
    if (index < 0) workspaces.push(next); else workspaces[index] = next;
    publishWorkspaces();
    return { id: String(projectId) };
  }
  async function createSession(input) {
    var projectId = String(input.projectId || '');
    var value = await rpc('session/create', { workspaceId: projectId });
    if (!value.sessionId) throw error('电脑创建对话后没有返回对话编号。');
    var project = workspaces.find(function (w) { return String(w.workspaceId || w.id) === projectId; });
    if (project) {
      if (!Array.isArray(project.sessionIds)) project.sessionIds = [];
      if (project.sessionIds.indexOf(value.sessionId) < 0) project.sessionIds.unshift(value.sessionId);
      publishWorkspaces();
    }
    return { id: String(value.sessionId) };
  }
  async function sendMessage(input) {
    var content = [];
    var text = String(input.text || '');
    if (text.trim()) content.push({ type: 'text', text: text });
    var attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (attachments.length > 5) throw error('每条消息最多发送 5 个文件。');
    attachments.forEach(function (entry) {
      if (!entry || typeof entry.receiptId !== 'string' || !entry.receiptId) throw error('附件尚未上传完成。');
      content.push({ type: 'file', receiptId: entry.receiptId });
    });
    if (!content.length) throw error('请输入文字或选择文件。');
    var sessionId = String(input.sessionId || '');
    var signature = JSON.stringify(content);
    if (!pendingPrompt || pendingPrompt.sessionId !== sessionId || pendingPrompt.signature !== signature)
      pendingPrompt = { sessionId: sessionId, signature: signature, requestId: id() };
    var value = await rpc('session/prompt', { requestId: pendingPrompt.requestId, sessionId: sessionId,
      mode: 'queue', content: content });
    if (value.accepted !== true) throw error('DSH 没有接收这条消息，请重试。');
    pendingPrompt = null;
  }
  async function uploadFile(input) {
    var file = input && input.file;
    var sessionId = String(input && input.sessionId || '');
    if (!sessionId || !file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function' ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 20 * 1024 * 1024)
      throw error('请选择非空且不超过 20 MB 的文件。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
    var meta = new TextEncoder().encode(JSON.stringify({ sessionId: sessionId, name: file.name }));
    var bytes = new Uint8Array(await file.arrayBuffer());
    var body = new Uint8Array(4 + meta.length + bytes.length);
    new DataView(body.buffer).setUint32(0, meta.length, false);
    body.set(meta, 4); body.set(bytes, 4 + meta.length);
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-upload', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/octet-stream' }, body: body
    }); };
    var response = await invoke();
    if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
    if (!response.ok) throw error(response.status === 404 ? '桥服务尚未更新文件上传功能。' :
      '文件上传失败（HTTP ' + response.status + '）。');
    var result;
    try { result = await response.json(); } catch (_) { throw error('上传结果无法读取。'); }
    if (!result || result.ok !== true || !result.value || typeof result.value.receiptId !== 'string')
      throw error('DSH 没有接受文件，请重试。');
    return { receiptId: result.value.receiptId, file: result.value.file || { name: file.name, bytes: file.size } };
  }
  async function downloadFile(input) {
    var sessionId = String(input && input.sessionId || '');
    var filePath = String(input && input.path || '');
    if (!sessionId || !filePath) throw error('没有可下载的电脑文件路径。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-download', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: sessionId, path: filePath })
    }); };
    var response = await invoke();
    if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
    if (!response.ok) throw error(response.status === 404 ? '文件不存在，或桥服务尚未更新下载功能。' :
      '文件下载失败（HTTP ' + response.status + '）。');
    return { blob: await response.blob(), name: filePath.split(/[\\/]/).pop() || 'download' };
  }
  async function downloadImageAttachment(input) {
    var sessionId = input && input.sessionId;
    var attachmentId = input && input.attachmentId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
        /[\u0000-\u0020\u007f]/.test(sessionId) || typeof attachmentId !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw error('图片附件标识无效。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret || typeof e2ee.encryptedFetch !== 'function')
      throw error('缺少加密连接密钥，请重新打开完整地址。');
    var invoke = function () { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-attachment', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: input.signal,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: sessionId, attachmentId: attachmentId })
    }); };
    var response = await invoke();
    if (response.status === 403 && typeof e2ee.prove === 'function' && await e2ee.prove(true)) response = await invoke();
    if (!response.ok) throw error(response.status === 501 ? '这个 DSH 版本尚不支持按附件标识读取图片。' :
      response.status === 404 ? 'DSH 找不到这张图片，或它不属于当前对话。' :
      response.status === 413 ? '图片超过安全预览限制。' : '图片读取失败，请检查连接后重试。');
    if (!response.headers || response.headers.get('x-dsh-e2ee-decrypted') !== '1' ||
        response.headers.get('x-dsh-e2ee') === '1') throw error('图片响应没有通过加密验证。');
    var type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw error('图片格式不受支持。');
    var blob = await response.blob();
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > 8 * 1024 * 1024 ||
        String(blob.type || '').toLowerCase() !== type) throw error('图片超过安全预览限制。');
    return { blob: blob, sessionId: sessionId, attachmentId: attachmentId };
  }
  async function respondToInteraction(input) {
    var interaction = pendingInteractions.get(String(input.id));
    if (!interaction || !clientId) throw error('这条请求已过期，请重连以获取最新请求。');
    var answer = input.answer || {};
    var outcome;
    if (interaction.kind === 'approval' && answer.type === 'approve') {
      outcome = { kind: 'result', value: 'allowed-once' };
    } else if (interaction.kind === 'approval' && answer.type === 'reject') {
      outcome = { kind: 'result', value: 'rejected' };
    } else if (interaction.kind === 'question' && answer.type === 'answers' && Array.isArray(answer.answers)) {
      var expected = interaction.questions || [];
      if (expected.length !== answer.answers.length || expected.some(function (q) {
        return !answer.answers.some(function (a) { return a && a.id === q.id; });
      })) throw error('请回答所有问题后再提交。');
      var answers = answer.answers.map(function (item) {
        var q = expected.find(function (x) { return x.id === item.id; });
        if (!q || !Array.isArray(item.selected) || item.selected.some(function (label) {
          return typeof label !== 'string' || !q.options.some(function (o) { return o.label === label; });
        }) || (!q.multiSelect && item.selected.length > 1)) throw error('选项无效，请重新选择。');
        var out = { id: q.id, selected: item.selected };
        if (typeof item.custom === 'string' && item.custom.trim()) out.custom = item.custom.trim();
        if (!out.selected.length && !out.custom) throw error('请回答所有问题后再提交。');
        return out;
      });
      outcome = { kind: 'result', value: { answers: answers } };
    } else {
      throw error('不支持这种回复，请到电脑端处理。');
    }
    await rpc('$events/result', { clientId: clientId, eventId: String(input.id), outcome: outcome });
    pendingInteractions.delete(String(input.id));
    emit({ type: 'interaction-resolved', id: String(input.id) });
  }
  global.DshLiteAdapter = {
    profile: 'remote-mux',
    capabilities: { interactiveReplies: true },
    connect: connect, disconnect: disconnect,
    // ── 选模型 / 选模式（C3 / C4）────────────────────────────────────────────
    //
    // 方法名是从 DSH 自己的 app.asar 里搜出来的：`session/modelCatalog`（列）、
    // `session/selectModel`（设）、`agentPresets/list`（列）、`agentPresets/select`（设）。
    // 桥端的白名单已经放行这四个（见 scripts/dsh-lite-rpc.js），其余方法一样进不来。
    //
    // 参数形状没能从 asar 里确认到，所以"设"这一步用候选键名逐个试：
    // DSH 参数不对只会回一个错误（安全失败、界面看得见），不会改坏会话。
    liteRpc: async function (method, request) {
      var e2ee = global.DshE2EE;
      if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
      var payload = JSON.stringify({ method: method, request: request || {} });
      var invoke = function () {
        return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-rpc', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: payload
        });
      };
      var response = await invoke();
      if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
      var result = null;
      try { result = await response.json(); } catch (_) { result = null; }
      if (!response.ok) {
        throw error((result && (result.error || result.message)) || ('HTTP ' + response.status));
      }
      var payload = (result && result.result !== undefined) ? result.result : result;
      // ★ 领域错误也要抛出来，而且**必须把 code 带上**。
      //   DSH 的失败分两种：网关级的（result.ok 为假、error.code 是
      //   `gateway/...`）和领域级的（`session/queue-item-not-found`、
      //   `session/steer-unavailable`…）。后者是**正常竞态**，调用方要按 code
      //   去分辨"这不是坏了、是电脑端已经处理掉了"。
      //   原来这里只看 `payload.value`，于是 ok:false 会被当成"成功且没有值"
      //   返回出去 —— 排队消息的失败提示就永远显示不出来。
      if (payload && payload.ok === false) {
        var code = String((payload.error && payload.error.code) || '');
        var message = String((payload.error && payload.error.message) || '');
        var failure = error(code ? code + (message ? '：' + message : '') : (message || 'DSH 拒绝了请求。'));
        failure.code = code;
        throw failure;
      }
      if (payload && payload.value !== undefined && payload.ok === true) payload = payload.value;
      return payload;
    },
    // ★ 「列模型 / 列模式」这两个方法**什么参数都不接受**。
    //
    //   实测（2026-09-29）DSH 依次回过两条：
    //     `unexpected "request"`   ← 桥转发时套的那层包装，已去掉
    //     `unexpected "sessionId"` ← 界面又塞了 sessionId，就是这里
    //   根因后来在 asar 里看清了：这两个方法的 descriptor 是 `parameters: []`，
    //   所以 args 必须是**空对象** —— 不是"摊平"，而是**本来就没有参数**。
    listModels: async function () {
      var out = await this.liteRpc('session/modelCatalog', {});
      return pickList(out, ['models', 'items', 'entries', 'catalog', 'list']);
    },
    // ── 选模型 / 思考强度（C3 / C20）────────────────────────────────────────
    //
    // ★ 形状是从 asar 的严格 schema 读出来的，不再靠猜：
    //     SessionSelectModelRequest
    //       { sessionId, provider: string, model: string, reasoningEffort?: string }
    //   上一版猜的是 `modelId`，而正确字段名是 **`model`**，并且**必须带 provider**
    //   （provider 就是模型目录里那一层的组名）。
    //
    //   `provider` 从哪来：listModels 把选中的 provider 一起塞进每一项（见 pickList）。
    //   万一没带（缓存了旧数据），退回"只发 model" —— 老写法有时也能过，
    //   而且 DSH 只会回一个参数错误，不会改坏会话。
    selectModel: async function (sessionId, modelId, reasoningEffort, provider) {
      function body(forProvider) {
        var request = { sessionId: sessionId, model: modelId };
        if (forProvider) request.provider = forProvider;
        if (reasoningEffort) request.reasoningEffort = reasoningEffort;
        return request;
      }
      try {
        return await this.liteRpc('session/selectModel', body(provider));
      } catch (first) {
        if (!provider) throw first;
        // 带 provider 被拒（可能是过期的 provider 名）→ 不带再试一次。
        return await this.liteRpc('session/selectModel', body(''));
      }
    },
    // agent preset（标准 / 创造这类"人格"）—— 注意它**不是**会话模式。
    // 正确形状：`{ agentId, agentPreset }`（真正摊平的双参数）。
    // 上一版猜的三个键名（presetId / preset / id）没有一个是对的。
    listModes: async function () {
      var out = await this.liteRpc('agentPresets/list', {});
      var payload = out && out.ok === true && out.value !== undefined ? out.value : out;
      var list = (payload && (payload.presets || payload.items || payload.entries || payload.agents)) || [];
      if (!Array.isArray(list) && payload && Array.isArray(payload.available)) list = payload.available;
      if (!Array.isArray(list) && Array.isArray(payload)) list = payload;
      return (Array.isArray(list) ? list : []).map(function (item) {
        if (typeof item === 'string') return { id: item, name: item,
          description: '', isDefault: false, broken: '' };
        var id = (item && (item.id || item.agentPreset || item.name)) || '';
        return { id: String(id), name: String((item && (item.name || item.title || item.id)) || id),
          description: item && typeof item.description === 'string' ? item.description : '',
          isDefault: !!(item && item.isDefault === true),
          broken: item && typeof item.broken === 'string' ? item.broken : '' };
      }).filter(function (item) { return item.id; });
    },
    selectMode: async function (sessionId, presetId) {
      return await this.liteRpc('agentPresets/select', { agentId: sessionId, agentPreset: presetId });
    },
    // Read the session's actual selections without changing either setting.
    // The catalog default is not the same as a session choice, especially after
    // a model was selected for the next turn but has not yet run.
    readSelection: async function (sessionId) {
      var selectedId = String(sessionId || '');
      if (!selectedId) throw error('请先打开要查看的对话。');
      var out = await this.liteRpc('session/projections', { sessionId: selectedId });
      var summary = sessionSummaries.get(selectedId);
      return selectionState(out && out.values, summary && summary.blank);
    },
    // Confirmed on the current desktop protocol: permissions.currentValue is a
    // session projection, not the acknowledgement of /permission execution.
    readPermission: async function (sessionId) {
      var selectedId = String(sessionId || '');
      if (!selectedId) throw error('请先打开要查看的对话。');
      var out = await this.liteRpc('session/projections', { sessionId: selectedId });
      var preset = out && out.values && out.values.permissions && out.values.permissions.currentValue;
      if (!out || !Number.isSafeInteger(out.asOfSeq) || out.asOfSeq < -1 ||
          ['read-only', 'workspace-write', 'danger-full-access'].indexOf(preset) < 0) {
        throw error('此版本未报告当前授权范围。');
      }
      return { presetId: preset, asOfSeq: out.asOfSeq };
    },
    // ── C21 「计划 / 目标」：**不是 RPC，是斜杠命令** ────────────────────────
    //
    // ★ 上一版这里写的是 `session/selectMode` —— 那个方法**根本不存在**
    //   （asar 里 135 个 RPC descriptor，session 命名空间下没有它；全文搜
    //   `selectMode` 只搜到一个 React 局部变量）。所以「计划 / 目标」按钮在
    //   手机端从来没成功过，而且错误还被界面当成"未识别的回应"吞掉了。
    //
    //   真正的入口是宿主命令：`/plan`（进入或离开计划模式）、`/goal <目标>`，
    //   走 commands/execute（和电脑端点那些命令是同一条路）。
    runCommand: async function (sessionId, line) {
      return await this.liteRpc('commands/execute', {
        agentId: sessionId, line: line, submittedAttachments: []
      });
    },
    listCommands: async function (sessionId) {
      var out = await this.liteRpc('commands/list', { agentId: sessionId });
      var payload = out && out.ok === true && out.value !== undefined ? out.value : out;
      return Array.isArray(payload) ? payload : [];
    },
    // ── C12 排队消息 ────────────────────────────────────────────────────────
    //
    // 读：`session/projections`（**唯一**能读到待处理队列的 RPC —— `session/page`
    //     里根本没有 queue 字段），取投影里的 `inbox`：
    //       values.inbox = { 'next-turn': [...], 'next-step': [...] }
    //     每一项是 message（有 id / content）。
    // 改：`session/updateQueue` { sessionId, itemId, action }。
    listQueued: async function (sessionId) {
      var out = await this.liteRpc('session/projections', { sessionId: sessionId });
      var value = out && out.ok === true && out.value !== undefined ? out.value : out;
      var values = value && value.values ? value.values : null;
      var inbox = values && values.inbox ? values.inbox : null;
      if (!inbox) return [];
      var rows = [];
      ['next-turn', 'next-step'].forEach(function (key) {
        var list = Array.isArray(inbox[key]) ? inbox[key] : [];
        list.forEach(function (message) {
          if (!message || typeof message !== 'object') return;
          var id = typeof message.id === 'string' ? message.id : '';
          if (!id) return;
          rows.push({ id: id, text: contentText(message.content, 'text'),
            target: key === 'next-turn' ? 'turn' : 'step' });
        });
      });
      return rows;
    },
    updateQueueItem: async function (sessionId, itemId, action) {
      if (!action || typeof action.kind !== 'string') throw error('排队消息的操作无效。');
      var request = { sessionId: sessionId, itemId: itemId, action: action };
      try {
        return await this.liteRpc('session/updateQueue', request);
      } catch (problem) {
        // 队列项已经不在（被电脑端处理掉了）或者这一轮不再接受插话 ——
        // 这两种都是**正常竞态**，不是故障：电脑端也是静默收敛的。
        var code = String((problem && problem.message) || '');
        if (code.indexOf('session/queue-item-not-found') >= 0) throw error('这条排队消息已经不在队列里了。');
        if (code.indexOf('session/steer-unavailable') >= 0) throw error('排队消息改不了：当前这一轮不再接受插话。');
        throw problem;
      }
    },
    // ── C26 目标（计划模式里那个"目标"）───────────────────────────────────────
    //
    // 使用者原话：「进去计划模式后…根本不能像客户端上看到你的目标，及完成情况，
    // 需要暂停，删除，更改都不行」。手机端原来只有 `/plan`（进入/离开计划模式），
    // **完全没有目标这一套**。
    //
    // 读：投影里的 `goal` 键（`session/projections` 本来就在用，零新增通道）。
    //     形状（从 asar 读出来的）：
    //       values.goal = null | { goal: GoalSnapshot }
    //       GoalSnapshot = { id, revision, objective, maxGoalRounds,
    //                        phase: 'active'|'paused'|'blocked'|'complete',
    //                        blockedReason?: { code, message } }
    // 改：goals/* —— args 是摊平的 { agentId, ref?, request? }。
    readGoal: async function (sessionId) {
      var out = await this.liteRpc('session/projections', { sessionId: sessionId });
      var value = out && out.ok === true && out.value !== undefined ? out.value : out;
      var values = value && value.values ? value.values : null;
      var entry = values && values.goal ? values.goal : null;
      var goal = entry && typeof entry === 'object' && entry.goal ? entry.goal : null;
      if (!goal || typeof goal !== 'object' || typeof goal.objective !== 'string') return null;
      var revision = Number(goal.revision);
      return {
        id: String(goal.id || ''),
        // ★ revision 必须原样带回去。DSH 用它做乐观并发控制 ——
        //   拿一个过期的 revision 去改会被拒（那是**对的**，说明目标刚被人改过）。
        revision: Number.isSafeInteger(revision) ? revision : 0,
        objective: goal.objective,
        phase: String(goal.phase || ''),
        blockedReason: goal.blockedReason && typeof goal.blockedReason.message === 'string'
          ? goal.blockedReason.message : '',
        maxGoalRounds: Number.isSafeInteger(goal.maxGoalRounds) ? goal.maxGoalRounds : 0
      };
    },
    /**
     * 对目标做一次操作。
     * @param {string} kind create | edit | pause | resume | complete | clear
     * @param {object} payload create 用 {objective}；其余用 {id, revision, objective?}
     */
    goalAction: async function (sessionId, kind, payload) {
      var action = String(kind || '');
      var input = payload || {};
      if (action === 'create') {
        var text = String(input.objective || '').trim();
        if (!text) throw error('目标不能是空的。');
        return await this.liteRpc('goals/create',
          { agentId: sessionId, request: { objective: text } });
      }
      var revision = Number(input.revision);
      var ref = { id: String(input.id || ''), revision: Number.isSafeInteger(revision) ? revision : -1 };
      if (!ref.id || ref.revision < 0) throw error('先读到目标才能改它。');
      if (action === 'edit') {
        var next = String(input.objective || '').trim();
        if (!next) throw error('目标不能是空的。');
        return await this.liteRpc('goals/edit',
          { agentId: sessionId, ref: ref, request: { objective: next } });
      }
      if (['pause', 'resume', 'complete', 'clear'].indexOf(action) < 0) {
        throw error('不认识的目标操作。');
      }
      return await this.liteRpc('goals/' + action, { agentId: sessionId, ref: ref });
    },
    // ── 抓一张电脑屏幕 ────────────────────────────────────────────────────────
    //
    // 用途：人不在电脑前时，用手机看一眼电脑现在什么样 —— 哪个窗口弹出来了、
    // 进度卡在哪、桌面上那个报错框写了什么。
    //
    // 这是**只读**操作：不注入、不抢焦点、不模拟按键、不碰任何窗口。
    // 所以它没有"自动化操作某个聊天软件"那类"点到别的窗口上"的风险。
    // 画面本身敏感，因此走和会话内容同一道加密门（/__dsh/screen-shot 在
    // E2EE_CONTENT_PATHS 里），桥侧每抓一次都会写日志。
    screenShot: async function (options) {
      var e2ee = global.DshE2EE;
      if (!e2ee || !global.__dshE2eeSecret) throw error('缺少加密连接密钥，请重新打开完整地址。');
      var asked = options && Number.isFinite(Number(options.maxWidth)) ? Number(options.maxWidth) : 1280;
      var invoke = function () {
        return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/screen-shot', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ maxWidth: asked })
        });
      };
      var response = await invoke();
      if (response.status === 403 && await e2ee.prove(true)) response = await invoke();
      if (!response.ok) {
        throw error(response.status === 404 ? '桥服务尚未更新抓屏功能。'
          : response.status === 413 ? '屏幕画面太大，请调小清晰度。'
            : '抓屏失败（HTTP ' + response.status + '）。');
      }
      var result;
      try { result = await response.json(); } catch (_) { throw error('抓屏结果无法读取。'); }
      if (result && result.value && result.ok === true) result = result.value;
      if (!result || result.ok !== true || typeof result.image !== 'string' || !result.image) {
        throw error('电脑返回的抓屏结果无效。');
      }
      return result;
    },
    listProjects: function () { return Promise.resolve(projectList()); },
    listSessions: function (projectId) { return Promise.resolve(sessionList(projectId)); },
    loadSession: loadSession, loadOlder: loadOlder, listDirectories: listDirectories,
    listWorkspaceFiles: listWorkspaceFiles,
    createProject: createProject, createSession: createSession,
    sendMessage: sendMessage, uploadFile: uploadFile, downloadFile: downloadFile,
    downloadImageAttachment: downloadImageAttachment,
    cancelSession: cancelSession, respondToInteraction: respondToInteraction
  };
  global.DshLiteRemoteAdapter = global.DshLiteAdapter;
  try { global.document.dispatchEvent(new Event('dsh-lite-adapter-ready')); } catch (_) {}
})(window);
