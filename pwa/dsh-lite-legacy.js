(function (global) {
  'use strict';

  // Browser side of the inspected legacy-events HTTP protocol. This page
  // never imports DSH's application bundle. All RPCs go through the bridge's
  // encrypted, allowlisted /__dsh/legacy-rpc endpoint; no raw legacy SSE is
  // opened because the existing /api/events.* proxy would expose its frames
  // to the tunnel. Live changes are recovered from durable history polling.
  var onEvent = function () {};
  var projects = [];
  var summaries = new Map();
  var activeSessionId = '';
  var activeEntries = new Map();
  var activeHasMore = false;
  var activeFirstSeq = 0;
  var activeLastSeq = -1;
  var activeUpdatedAt = null;
  var pendingInteractions = new Map();
  var connected = false;
  var generation = 0;
  var timer = null;
  var backgroundReadWarning = null;

  function problem(message) { var out = new Error(message); out.userMessage = message; return out; }
  function emit(item) { try { onEvent(item); } catch (_) {} }
  function string(value) { return typeof value === 'string' ? value : ''; }
  function bounded(value, max) { return string(value).slice(0, max); }
  function validId(value) { return typeof value === 'string' && value.length > 0; }
  function textOf(content, kind) {
    return (Array.isArray(content) ? content : []).filter(function (part) {
      return part && part.type === kind && typeof part.text === 'string';
    }).map(function (part) { return part.text; }).join('');
  }
  function recordRows(entry) {
    var event = entry && entry.event;
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) return [];
    var data = event.data && typeof event.data === 'object' ? event.data : {};
    var id = 'legacy:' + event.seq;
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
      return [{ id: id, role: 'system', title: '模型请求失败', text: failureText, status: 'error' }];
    }
    if (event.type === 'user/message') {
      if (data.source && data.source.kind !== 'user') return [];
      var userText = textOf(data.content, 'text');
      var images = Array.isArray(data.content) ? data.content.filter(function (part) {
        return part && part.type === 'image';
      }) : [];
      if (images.length) userText += (userText ? '\n' : '') + '[图片 ' + images.length + ' 张]';
      return userText ? [{ id: id, role: 'user', text: userText }] : [];
    }
    if (event.type === 'assistant/message') {
      var message = data.message && typeof data.message === 'object' ? data.message : {};
      var reasoning = textOf(message.content, 'reasoning');
      var answer = textOf(message.content, 'text');
      var rows = [];
      if (reasoning) rows.push({ id: id + ':thought', role: 'thought', title: '思考过程',
        text: reasoning, status: data.interrupted === true ? 'interrupted' : 'settled' });
      if (answer) rows.push({ id: id, role: 'assistant', text: answer,
        status: data.interrupted === true ? 'interrupted' : 'settled' });
      return rows;
    }
    if (event.type === 'tool/call') return [{ id: id, role: 'tool',
      title: bounded(data.name, 300) || '工具调用',
      text: string(data.arguments), status: 'running' }];
    if (event.type === 'tool/result') {
      var result = data.message && typeof data.message === 'object' ? data.message : {};
      return [{ id: id, role: 'tool', title: '工具结果',
        text: textOf(result.content, 'text'),
        status: result.isError === true ? 'error' : 'settled' }];
    }
    return [];
  }
  function records() {
    return Array.from(activeEntries.values()).sort(function (a, b) {
      return a.event.seq - b.event.seq;
    }).reduce(function (all, entry) { all.push.apply(all, recordRows(entry)); return all; }, []);
  }
  function mergePage(page) {
    if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean')
      throw problem('电脑返回的旧版对话记录格式无效。');
    page.events.forEach(function (entry) {
      var event = entry && entry.event;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
      activeEntries.set(event.seq, entry);
      if (event.seq > activeLastSeq) activeLastSeq = event.seq;
      if (event.seq < activeFirstSeq) activeFirstSeq = event.seq;
    });
    activeHasMore = page.hasMore;
    var title = page.projections && page.projections.values && page.projections.values.title;
    if (typeof title === 'string' && title.trim())
      emit({ type: 'session-title', sessionId: activeSessionId, title: title });
  }
  async function rpc(method, request) {
    var e2ee = global.DshE2EE, secret = global.__dshE2eeSecret;
    if (!e2ee || !secret || typeof e2ee.encryptedFetch !== 'function')
      throw problem('缺少加密连接密钥，请用完整地址重新打开桥。');
    function call() { return e2ee.encryptedFetch(secret, '/__dsh/legacy-rpc', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ method: method, request: request })
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (response.status === 404) throw problem('桥服务尚未更新旧版 DSH 适配，请更新桥后再试。');
    if (response.status === 409) {
      var conflict = null; try { conflict = await response.json(); } catch (_) {}
      if (conflict && conflict.error === 'image-receipt-expired')
        throw problem('图片附件已过期，请重新上传后发送。');
      throw problem('DSH 已切换到不同协议，请刷新页面重新检测版本。');
    }
    if (!response.ok) {
      var failure = problem('旧版 DSH 请求失败（HTTP ' + response.status + '），请重连。');
      // Only the gateway's exact, bounded runtime-unavailable read response
      // is eligible for the periodic warning. Authentication, encryption,
      // replay storage, protocol changes and every mutation stay hard errors.
      if (response.status === 503 && ['workspace.list', 'session.list', 'session.history'].indexOf(method) >= 0) {
        var unavailable = null;
        try { unavailable = await response.json(); } catch (_) {}
        if (unavailable && typeof unavailable === 'object' && !Array.isArray(unavailable) &&
            Object.keys(unavailable).length === 1 && unavailable.error === 'dsh-runtime-unavailable')
          failure.code = 'legacy-background-read-unavailable';
      }
      throw failure;
    }
    var payload;
    try { payload = await response.json(); } catch (_) { throw problem('电脑返回的 DSH 数据无法读取。'); }
    if (!payload || !payload.result || payload.result.ok !== true)
      throw problem('DSH 拒绝了此操作：' + bounded(payload && payload.result && payload.result.error &&
        payload.result.error.message, 180));
    return payload.result.value;
  }
  async function interactionRequest(path, body) {
    var e2ee = global.DshE2EE, secret = global.__dshE2eeSecret;
    function call() { return e2ee.encryptedFetch(secret, path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body)
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (response.status === 409) throw problem('这条请求已过期，请重连以获取最新请求。');
    if (!response.ok) throw problem('同步旧版 DSH 授权或询问失败，请重连。');
    var value = await response.json();
    if (!value || value.ok !== true) throw problem('同步旧版 DSH 授权或询问失败，请重连。');
    return value;
  }
  async function refreshInteractions(epoch) {
    var selected = activeSessionId;
    if (!selected) return;
    var result = await interactionRequest('/__dsh/legacy-interactions', { sessionId: selected });
    if (epoch !== generation || selected !== activeSessionId || !connected) return;
    if (!Array.isArray(result.interactions)) throw problem('同步旧版 DSH 授权或询问失败，请重连。');
    var current = new Map();
    result.interactions.forEach(function (item) {
      if (item && validId(item.id) && item.sessionId === selected &&
          (item.kind === 'approval' || item.kind === 'question')) current.set(item.id, item);
    });
    pendingInteractions.forEach(function (_item, id) {
      if (!current.has(id)) emit({ type: 'interaction-resolved', id: id });
    });
    pendingInteractions = current;
    current.forEach(function (item) { emit({ type: 'interaction', interaction: item }); });
  }
  async function respondToInteraction(input) {
    var item = pendingInteractions.get(String(input && input.id));
    if (!item || !connected || item.sessionId !== activeSessionId)
      throw problem('这条请求已过期，请重连以获取最新请求。');
    await interactionRequest('/__dsh/legacy-response', {
      sessionId: item.sessionId, id: item.id, answer: input.answer
    });
    pendingInteractions.delete(item.id);
    emit({ type: 'interaction-resolved', id: item.id });
  }
  function projectRows() {
    return projects.map(function (project) {
      return { id: String(project.workspaceId), name: string(project.title) || string(project.path) || '项目',
        path: string(project.path) };
    });
  }
  function sessionRows(projectId) {
    var project = projects.find(function (item) { return item.workspaceId === projectId; });
    if (!project || !Array.isArray(project.sessionIds)) return [];
    return project.sessionIds.slice().reverse().map(function (sessionId, index) {
      var summary = summaries.get(sessionId) || {};
      var title = summary.projections && summary.projections.values && summary.projections.values.title;
      return { id: sessionId, title: typeof title === 'string' && title.trim() ? title :
        '对话 ' + (project.sessionIds.length - index), updatedAt: summary.updatedAt,
        agentPreset: typeof summary.agentPreset === 'string' ? summary.agentPreset : null,
        blank: typeof summary.blank === 'boolean' ? summary.blank : null };
    });
  }
  function publishCatalog() {
    emit({ type: 'projects', projects: projectRows() });
    projects.forEach(function (project) {
      emit({ type: 'sessions', projectId: project.workspaceId, sessions: sessionRows(project.workspaceId) });
    });
  }
  async function refreshCatalog(epoch) {
    var selected = activeSessionId;
    var values = await Promise.all([rpc('workspace.list', {}), rpc('session.list', {})]);
    if (epoch !== generation || !connected || selected !== activeSessionId) return false;
    if (!values[0] || !Array.isArray(values[0].items) ||
        !values[1] || !Array.isArray(values[1].items)) throw problem('电脑返回的项目列表无效。');
    projects = values[0].items.filter(function (item) {
      return item && validId(item.workspaceId) && Array.isArray(item.sessionIds);
    });
    summaries = new Map(values[1].items.filter(function (item) {
      return item && validId(item.sessionId);
    }).map(function (item) { return [item.sessionId, item]; }));
    publishCatalog();
    if (selected) {
      var summary = summaries.get(selected);
      if (summary) {
        emit({ type: 'session-status', sessionId: selected, running: summary.running === true });
        if (summary.updatedAt !== activeUpdatedAt || summary.running === true ||
            backgroundReadWarning && backgroundReadWarning.epoch === epoch &&
            backgroundReadWarning.sessionId === selected) {
          // Commit this marker only after the matching history actually
          // arrived. Otherwise a failed tail read can be skipped forever
          // when the next catalog reports the same settled updatedAt.
          if (!await refreshActive(epoch) || epoch !== generation || !connected || selected !== activeSessionId)
            return false;
          activeUpdatedAt = summary.updatedAt;
        }
      }
      await refreshInteractions(epoch);
      if (!summary) return false;
    }
    return epoch === generation && connected && selected === activeSessionId;
  }
  async function refreshActive(epoch) {
    var selected = activeSessionId;
    if (!selected) return false;
    var hadOlder = activeHasMore;
    // Poll the recent tail. Walk back only if more than one page arrived since
    // the last check; never silently skip a burst of committed events.
    var page = await rpc('session.history', { sessionId: selected, maxMessages: 20 });
    if (epoch !== generation || selected !== activeSessionId || !connected) return false;
    var pages = [page], prior = activeLastSeq, steps = 0;
    while (page.hasMore === true && Array.isArray(page.events) && page.events.length &&
           page.events[0].event && page.events[0].event.seq > prior + 1 && steps++ < 20) {
      page = await rpc('session.history', { sessionId: selected,
        beforeSeq: page.events[0].event.seq, maxMessages: 20 });
      if (epoch !== generation || selected !== activeSessionId || !connected) return false;
      pages.unshift(page);
    }
    if (page.hasMore === true && page.events.length && page.events[0].event.seq > prior + 1)
      throw problem('对话新增内容较多，请重新打开以补齐记录。');
    pages.forEach(mergePage);
    // A later tail page may report that *its* 20-message window has older
    // data, even when those rows are already held from an earlier page load.
    activeHasMore = hadOlder;
    emit({ type: 'records', sessionId: selected, records: records(), hasMore: activeHasMore });
    return true;
  }
  function schedule(epoch) {
    if (!connected || epoch !== generation) return;
    timer = global.setTimeout(async function () {
      timer = null;
      var selected = activeSessionId;
      try {
        var refreshed = await refreshCatalog(epoch);
        if (refreshed === true && epoch === generation && connected && selected === activeSessionId &&
            backgroundReadWarning && backgroundReadWarning.epoch === epoch &&
            backgroundReadWarning.sessionId === selected) {
          backgroundReadWarning = null;
          emit({ type: 'background-read-recovered', tag: 'legacy-poll', sessionId: selected });
        }
      } catch (error) {
        if (epoch === generation && connected && selected === activeSessionId) {
          if (error && error.code === 'legacy-background-read-unavailable') {
            backgroundReadWarning = { epoch: epoch, sessionId: selected };
            emit({ type: 'background-read-warning', tag: 'legacy-poll', sessionId: selected });
          } else emit({ type: 'error',
            userMessage: error && error.userMessage || '同步旧版 DSH 内容失败，请重连。' });
        }
      }
      schedule(epoch);
    }, 5000);
  }
  async function connect(listener) {
    if (typeof listener === 'function') onEvent = listener;
    disconnect();
    var epoch = generation;
    emit({ type: 'status', state: 'connecting' });
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret || !await e2ee.prove(true))
      throw problem('连接授权失败，请用完整地址重新打开桥。');
    var host = await rpc('host.describe', {});
    if (epoch !== generation) return;
    // The inspected legacy host.describe implementation deliberately returns
    // the placeholder version "0.0.1" in both releases. The gateway's
    // verified runtime profile, not this field, is the version fence.
    if (!host || typeof host.version !== 'string' || typeof host.home !== 'string')
      throw problem('电脑返回的旧版 DSH 主机信息无效。');
    connected = true;
    try { await refreshCatalog(epoch); }
    catch (error) { connected = false; emit({ type: 'status', state: 'disconnected' }); throw error; }
    emit({ type: 'status', state: 'connected' });
    schedule(epoch);
  }
  function disconnect() {
    generation++;
    connected = false;
    backgroundReadWarning = null;
    if (timer) { global.clearTimeout(timer); timer = null; }
    pendingInteractions.forEach(function (_item, id) { emit({ type: 'interaction-resolved', id: id }); });
    pendingInteractions.clear();
    emit({ type: 'status', state: 'disconnected' });
  }
  async function loadSession(sessionId) {
    if (!connected || !validId(sessionId)) throw problem('请先连接并选择对话。');
    var epoch = generation;
    backgroundReadWarning = null;
    pendingInteractions.forEach(function (_item, id) { emit({ type: 'interaction-resolved', id: id }); });
    pendingInteractions.clear();
    activeSessionId = sessionId;
    activeEntries = new Map(); activeHasMore = false;
    activeFirstSeq = Number.MAX_SAFE_INTEGER; activeLastSeq = -1;
    var summary = summaries.get(sessionId);
    activeUpdatedAt = null;
    var page = await rpc('session.history', { sessionId: sessionId, maxMessages: 20 });
    if (epoch !== generation || activeSessionId !== sessionId) throw problem('对话已切换，请重新打开。');
    mergePage(page);
    if (epoch !== generation || activeSessionId !== sessionId) throw problem('对话已切换，请重新打开。');
    activeUpdatedAt = summary && summary.updatedAt;
    try { await refreshInteractions(epoch); }
    catch (error) { if (epoch === generation && activeSessionId === sessionId)
      emit({ type: 'error', userMessage: error && error.userMessage || '同步旧版 DSH 授权或询问失败，请重连。' }); }
    if (epoch !== generation || activeSessionId !== sessionId) throw problem('对话已切换，请重新打开。');
    return { records: records(), hasMore: activeHasMore, interactions: Array.from(pendingInteractions.values()) };
  }
  async function loadOlder(sessionId) {
    if (sessionId !== activeSessionId || !connected) throw problem('请重新打开对话。');
    if (!activeHasMore) return { records: records(), hasMore: false };
    if (!Number.isSafeInteger(activeFirstSeq) || activeFirstSeq < 0)
      throw problem('旧版对话没有可用的历史游标。');
    var epoch = generation;
    var page = await rpc('session.history', { sessionId: sessionId,
      beforeSeq: activeFirstSeq, maxMessages: 20 });
    if (epoch !== generation || activeSessionId !== sessionId) throw problem('对话已切换，请重试。');
    if (!Array.isArray(page.events) || page.events.some(function (entry) {
      return !entry || !entry.event || !Number.isSafeInteger(entry.event.seq) || entry.event.seq >= activeFirstSeq;
    })) throw problem('电脑返回的历史页顺序无效。');
    mergePage(page);
    var list = records();
    emit({ type: 'records', sessionId: sessionId, records: list, hasMore: activeHasMore });
    return { records: list, hasMore: activeHasMore };
  }
  async function createProject(input) {
    var value = await rpc('workspace.create', { path: string(input && input.path) });
    var workspace = value && value.workspace;
    if (!workspace || !validId(workspace.workspaceId)) throw problem('电脑没有返回新项目编号。');
    var existing = projects.findIndex(function (item) { return item.workspaceId === workspace.workspaceId; });
    if (existing < 0) projects.push(workspace); else projects[existing] = workspace;
    publishCatalog();
    refreshCatalog(generation).catch(function () {});
    return { id: workspace.workspaceId };
  }
  async function createSession(input) {
    var value = await rpc('session.create', { workspaceId: string(input && input.projectId) });
    if (!value || !validId(value.sessionId)) throw problem('电脑没有返回新对话编号。');
    var project = projects.find(function (item) { return item.workspaceId === string(input && input.projectId); });
    if (project && project.sessionIds.indexOf(value.sessionId) < 0) project.sessionIds.push(value.sessionId);
    publishCatalog();
    refreshCatalog(generation).catch(function () {});
    return { id: value.sessionId };
  }
  async function sendMessage(input) {
    var attachments = input && Array.isArray(input.attachments) ? input.attachments : [];
    if (attachments.length > 4 || attachments.some(function (item) {
      return !item || !validId(item.receiptId) || !item.file || item.file.kind !== 'image';
    })) throw problem('此旧版 DSH 仅支持 PNG、JPEG、WebP 和 GIF 图片附件。');
    var text = string(input && input.text);
    if (!text.trim() && !attachments.length) throw problem('请输入消息。');
    var request = { sessionId: string(input && input.sessionId), mode: 'queue', content: [{ type: 'text', text: text }] };
    if (attachments.length) request.attachmentReceipts = attachments.map(function (item) { return item.receiptId; });
    var value = await rpc('session.prompt', request);
    if (!value || value.accepted !== true) throw problem('DSH 没有接受这条消息。');
    // Accepted prompts must not become apparent failures just because a
    // subsequent read timed out: retrying then could send the same text twice.
    refreshActive(generation).catch(function () {});
  }
  async function uploadFile(input) {
    var file = input && input.file, sessionId = string(input && input.sessionId);
    var mediaType = file && String(file.type || '').toLowerCase();
    if (!mediaType && file) {
      if (/\.png$/i.test(file.name)) mediaType = 'image/png';
      else if (/\.jpe?g$/i.test(file.name)) mediaType = 'image/jpeg';
      else if (/\.webp$/i.test(file.name)) mediaType = 'image/webp';
      else if (/\.gif$/i.test(file.name)) mediaType = 'image/gif';
    }
    if (!file || !validId(sessionId) || !/^image\/(png|jpeg|webp|gif)$/.test(mediaType))
      throw problem('此旧版 DSH 仅支持 PNG、JPEG、WebP 和 GIF 图片附件。');
    if (file.size > 4 * 1024 * 1024) throw problem('图片超过 4 MB，未上传。');
    var metadata = new TextEncoder().encode(JSON.stringify({ sessionId: sessionId, name: file.name, mediaType: mediaType }));
    var bytes = new Uint8Array(await file.arrayBuffer());
    var packet = new Uint8Array(4 + metadata.length + bytes.length);
    new DataView(packet.buffer).setUint32(0, metadata.length, false);
    packet.set(metadata, 4); packet.set(bytes, metadata.length + 4);
    var e2ee = global.DshE2EE;
    function call() { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/legacy-upload', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/octet-stream' }, body: packet
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (response.status === 413) throw problem('图片超过 4 MB，未上传。');
    if (response.status === 415) throw problem('此旧版 DSH 仅支持 PNG、JPEG、WebP 和 GIF 图片附件。');
    if (!response.ok) throw problem('上传图片失败，请重新选择图片后重试。');
    var result = await response.json();
    if (!result || result.ok !== true || !result.value || !validId(result.value.receiptId) ||
        !result.value.file || result.value.file.kind !== 'image') throw problem('上传图片失败，请重新选择图片后重试。');
    return result.value;
  }
  async function cancelSession(sessionId) {
    var value = await rpc('session.cancel', { sessionId: String(sessionId || '') });
    if (!value || value.accepted !== true) throw problem('DSH 没有接受停止请求。');
    return { accepted: true };
  }
  // The two inspected HTTP releases share these exact dotted methods. They
  // use sessionId (not remote-mux's agentId). Catalog reads do not run a model;
  // writes are sent once, then confirmed by an independent authoritative read.
  function selectionId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
      value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function selectionTarget(sessionId, epoch) {
    if (!connected || !validId(sessionId) || sessionId.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(sessionId) || activeSessionId !== sessionId ||
        epoch !== undefined && generation !== epoch)
      throw problem('对话已切换或连接已断开，请重新打开要选择的对话。');
  }
  function modelSelection(value) {
    if (!value || !selectionId(value.provider) || !selectionId(value.model) ||
        value.reasoningEffort !== undefined && !selectionId(value.reasoningEffort))
      throw problem('电脑返回的旧版模型选择无效。');
    return { provider: value.provider, model: value.model,
      reasoningEffort: value.reasoningEffort || '' };
  }
  function modelCatalog(value) {
    if (!value || !Array.isArray(value.groups) || value.groups.length > 128 ||
        !Array.isArray(value.failures)) throw problem('电脑返回的旧版模型列表无效。');
    var list = [];
    value.groups.forEach(function (group) {
      if (!group || !selectionId(group.id) || typeof group.name !== 'string' ||
          !Array.isArray(group.models)) throw problem('电脑返回的旧版模型列表无效。');
      group.models.forEach(function (model) {
        if (!model || !selectionId(model.id) || typeof model.name !== 'string' || list.length >= 1024)
          throw problem('电脑返回的旧版模型列表无效。');
        var reasoning = model.reasoning;
        if (reasoning && (!Array.isArray(reasoning.efforts) || !reasoning.efforts.length ||
            reasoning.efforts.length > 64 || reasoning.defaultEffort !== undefined && !selectionId(reasoning.defaultEffort)))
          throw problem('电脑返回的旧版模型思考选项无效。');
        var efforts = reasoning ? reasoning.efforts.map(function (item) {
          if (!item || !selectionId(item.id) || typeof item.name !== 'string')
            throw problem('电脑返回的旧版模型思考选项无效。');
          return { id: item.id, name: item.name, description: bounded(item.description, 4096) };
        }) : [];
        list.push({ id: model.id, name: model.name + (group.name ? '（' + group.name + '）' : ''),
          provider: group.id, description: bounded(model.description, 4096),
          defaultEffort: reasoning && reasoning.defaultEffort || '', efforts: efforts });
      });
    });
    if (!list.length && value.failures.length) throw problem('旧版 DSH 的模型目录暂时不可用，请在电脑端检查模型配置。');
    return list;
  }
  async function listModels(sessionId) {
    if (!connected) throw problem('请先连接电脑上的 DSH。');
    var epoch = generation;
    if (sessionId) selectionTarget(sessionId, epoch);
    var value = await rpc(sessionId ? 'session.models' : 'llm.models', sessionId ? { sessionId: sessionId } : {});
    if (!connected || epoch !== generation) throw problem('连接已变化，请重新读取模型列表。');
    if (sessionId) selectionTarget(sessionId, epoch);
    return modelCatalog(value);
  }
  async function selectionSummary(sessionId, epoch) {
    var value = await rpc('session.list', {});
    selectionTarget(sessionId, epoch);
    if (!value || !Array.isArray(value.items)) throw problem('电脑返回的旧版对话选择无效。');
    var row = value.items.find(function (item) { return item && item.sessionId === sessionId; });
    if (!row || typeof row.blank !== 'boolean' || row.agentPreset !== undefined && !selectionId(row.agentPreset))
      throw problem('电脑尚未报告这条对话的工具配置。');
    summaries.set(sessionId, row);
    return row;
  }
  async function readSelection(sessionId) {
    var epoch = generation;
    selectionTarget(sessionId, epoch);
    var values = await Promise.all([rpc('session.models', { sessionId: sessionId }), selectionSummary(sessionId, epoch)]);
    selectionTarget(sessionId, epoch);
    return { agentPreset: values[1].agentPreset || null, blank: values[1].blank,
      modelSelection: modelSelection(values[0] && values[0].current), lastUsedModel: null, plan: null };
  }
  function unconfirmedSelection() {
    var out = problem('选择请求已发送，但尚未确认电脑的实际选择；请重新读取当前选择，勿重复提交。');
    out.code = 'selection-unconfirmed'; return out;
  }
  async function selectModel(sessionId, modelId, effort, provider) {
    var epoch = generation;
    selectionTarget(sessionId, epoch);
    if (!selectionId(modelId) || !selectionId(provider) ||
        effort !== undefined && effort !== null && effort !== '' && !selectionId(effort))
      throw problem('请从电脑返回的模型列表选择完整的模型与提供方。');
    var request = { sessionId: sessionId, provider: provider, model: modelId };
    if (effort) request.reasoningEffort = effort;
    var result = await rpc('session.selectModel', request);
    selectionTarget(sessionId, epoch);
    // No second write on transport failure, refusal or readback failure.
    try {
      var confirmed = await rpc('session.models', { sessionId: sessionId });
      selectionTarget(sessionId, epoch);
      var actual = modelSelection(confirmed && confirmed.current);
      var acknowledged = modelSelection(result && result.selected);
      if (acknowledged.provider !== provider || acknowledged.model !== modelId ||
          actual.provider !== provider || actual.model !== modelId ||
          effort && actual.reasoningEffort !== effort) throw unconfirmedSelection();
      return { selected: actual };
    } catch (_) { throw unconfirmedSelection(); }
  }
  async function listModes() {
    if (!connected) throw problem('请先连接电脑上的 DSH。');
    var epoch = generation, value = await rpc('agentPreset.list', {});
    if (!connected || epoch !== generation) throw problem('连接已变化，请重新读取工具配置。');
    if (!value || !Array.isArray(value.presets) || value.presets.length > 1024)
      throw problem('电脑返回的旧版工具配置列表无效。');
    return value.presets.map(function (item) {
      if (!item || !selectionId(item.id) || typeof item.isDefault !== 'boolean')
        throw problem('电脑返回的旧版工具配置列表无效。');
      return { id: item.id, name: bounded(item.name, 512) || item.id,
        description: bounded(item.description, 4096), isDefault: item.isDefault,
        broken: bounded(item.broken, 4096) };
    });
  }
  async function selectMode(sessionId, presetId) {
    var epoch = generation;
    selectionTarget(sessionId, epoch);
    if (!selectionId(presetId)) throw problem('请选择电脑返回的工具配置。');
    var known = summaries.get(sessionId);
    if (known && known.blank === false) throw problem('对话开始后不能更换工具配置，请新建对话。');
    var result = await rpc('agentPreset.select', { sessionId: sessionId, agentPreset: presetId });
    selectionTarget(sessionId, epoch);
    try {
      var row = await selectionSummary(sessionId, epoch);
      if (!result || result.agentPreset !== presetId || row.agentPreset !== presetId) throw unconfirmedSelection();
      return { agentPreset: row.agentPreset };
    } catch (_) { throw unconfirmedSelection(); }
  }
  async function listDirectories(path) {
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw problem('缺少加密连接密钥。');
    function call() { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/directories', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(path === undefined ? {} : { path: String(path) })
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (!response.ok) throw problem('读取电脑目录失败（HTTP ' + response.status + '）。');
    var value = await response.json();
    if (!value || value.ok !== true || !Array.isArray(value.directories))
      throw problem('电脑返回的目录信息无效。');
    return value;
  }
  // Files produced inside an existing workspace are a bridge-owned read, not
  // a legacy DSH attachment API. The server independently verifies the
  // session/workspace binding and canonical path before returning bytes.
  async function listWorkspaceFiles(input) {
    var sessionId = string(input && input.sessionId);
    var directory = input && input.path !== undefined ? String(input.path) : '';
    var offset = input && input.offset !== undefined ? Number(input.offset) : 0;
    if (!sessionId || !Number.isSafeInteger(offset) || offset < 0)
      throw problem('文件列表请求无效。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw problem('缺少加密连接密钥。');
    function call() { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-files', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: sessionId, path: directory, offset: offset })
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (!response.ok) throw problem(response.status === 404 ?
      '此旧版 DSH 的项目存储位置尚未被桥识别，暂时无法浏览文件。' :
      '读取工作区文件失败（HTTP ' + response.status + '）。');
    var result = await response.json();
    if (!result || typeof result.path !== 'string' || !Array.isArray(result.entries) ||
        !(result.nextOffset === null || Number.isSafeInteger(result.nextOffset)))
      throw problem('电脑返回的文件列表无效。');
    return result;
  }
  async function downloadFile(input) {
    var sessionId = string(input && input.sessionId);
    var filePath = string(input && input.path);
    if (!sessionId || !filePath) throw problem('请选择工作区里的文件。');
    var e2ee = global.DshE2EE;
    if (!e2ee || !global.__dshE2eeSecret) throw problem('缺少加密连接密钥。');
    function call() { return e2ee.encryptedFetch(global.__dshE2eeSecret, '/__dsh/lite-download', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: sessionId, path: filePath })
    }); }
    var response = await call();
    if (response.status === 403 && await e2ee.prove(true)) response = await call();
    if (!response.ok) throw problem(response.status === 404 ?
      '找不到该项目文件，或旧版 DSH 的项目存储位置尚未被桥识别。' :
      '下载文件失败（HTTP ' + response.status + '）。');
    return { blob: await response.blob(), name: filePath.split(/[\\/]/).pop() || 'download' };
  }

  global.DshLegacyAdapter = {
    profile: 'legacy-events', capabilities: { interactiveReplies: true, fileAttachments: false, imageAttachments: true },
    connect: connect, disconnect: disconnect,
    listProjects: function () { return Promise.resolve(projectRows()); },
    listSessions: function (projectId) { return Promise.resolve(sessionRows(String(projectId))); },
    loadSession: loadSession, loadOlder: loadOlder, listDirectories: listDirectories,
    listWorkspaceFiles: listWorkspaceFiles, downloadFile: downloadFile,
    createProject: createProject, createSession: createSession,
    sendMessage: sendMessage, cancelSession: cancelSession, respondToInteraction: respondToInteraction, uploadFile: uploadFile,
    listModels: listModels, selectModel: selectModel, listModes: listModes, selectMode: selectMode, readSelection: readSelection
  };
})(window);
