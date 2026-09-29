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
  var connected = false;
  var generation = 0;
  var timer = null;

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
    if (response.status === 409) throw problem('DSH 已切换到不同协议，请刷新页面重新检测版本。');
    if (!response.ok) throw problem('旧版 DSH 请求失败（HTTP ' + response.status + '），请重连。');
    var payload;
    try { payload = await response.json(); } catch (_) { throw problem('电脑返回的 DSH 数据无法读取。'); }
    if (!payload || !payload.result || payload.result.ok !== true)
      throw problem('DSH 拒绝了此操作：' + bounded(payload && payload.result && payload.result.error &&
        payload.result.error.message, 180));
    return payload.result.value;
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
        '对话 ' + (project.sessionIds.length - index), updatedAt: summary.updatedAt };
    });
  }
  function publishCatalog() {
    emit({ type: 'projects', projects: projectRows() });
    projects.forEach(function (project) {
      emit({ type: 'sessions', projectId: project.workspaceId, sessions: sessionRows(project.workspaceId) });
    });
  }
  async function refreshCatalog(epoch) {
    var values = await Promise.all([rpc('workspace.list', {}), rpc('session.list', {})]);
    if (epoch !== generation || !connected) return;
    if (!values[0] || !Array.isArray(values[0].items) ||
        !values[1] || !Array.isArray(values[1].items)) throw problem('电脑返回的项目列表无效。');
    projects = values[0].items.filter(function (item) {
      return item && validId(item.workspaceId) && Array.isArray(item.sessionIds);
    });
    summaries = new Map(values[1].items.filter(function (item) {
      return item && validId(item.sessionId);
    }).map(function (item) { return [item.sessionId, item]; }));
    publishCatalog();
    if (activeSessionId) {
      var summary = summaries.get(activeSessionId);
      if (summary) {
        emit({ type: 'session-status', sessionId: activeSessionId, running: summary.running === true });
        if (summary.updatedAt !== activeUpdatedAt || summary.running === true) {
          activeUpdatedAt = summary.updatedAt;
          await refreshActive(epoch);
        }
      }
    }
  }
  async function refreshActive(epoch) {
    var selected = activeSessionId;
    if (!selected) return;
    var hadOlder = activeHasMore;
    // Poll the recent tail. Walk back only if more than one page arrived since
    // the last check; never silently skip a burst of committed events.
    var page = await rpc('session.history', { sessionId: selected, maxMessages: 20 });
    if (epoch !== generation || selected !== activeSessionId) return;
    var pages = [page], prior = activeLastSeq, steps = 0;
    while (page.hasMore === true && Array.isArray(page.events) && page.events.length &&
           page.events[0].event && page.events[0].event.seq > prior + 1 && steps++ < 20) {
      page = await rpc('session.history', { sessionId: selected,
        beforeSeq: page.events[0].event.seq, maxMessages: 20 });
      if (epoch !== generation || selected !== activeSessionId) return;
      pages.unshift(page);
    }
    if (page.hasMore === true && page.events.length && page.events[0].event.seq > prior + 1)
      throw problem('对话新增内容较多，请重新打开以补齐记录。');
    pages.forEach(mergePage);
    // A later tail page may report that *its* 20-message window has older
    // data, even when those rows are already held from an earlier page load.
    activeHasMore = hadOlder;
    emit({ type: 'records', sessionId: selected, records: records(), hasMore: activeHasMore });
  }
  function schedule(epoch) {
    if (!connected || epoch !== generation) return;
    timer = global.setTimeout(async function () {
      timer = null;
      try { await refreshCatalog(epoch); }
      catch (error) { if (epoch === generation) emit({ type: 'error',
        userMessage: error && error.userMessage || '同步旧版 DSH 内容失败，请重连。' }); }
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
    if (timer) { global.clearTimeout(timer); timer = null; }
    emit({ type: 'status', state: 'disconnected' });
  }
  async function loadSession(sessionId) {
    if (!connected || !validId(sessionId)) throw problem('请先连接并选择对话。');
    var epoch = generation;
    activeSessionId = sessionId;
    activeEntries = new Map(); activeHasMore = false;
    activeFirstSeq = Number.MAX_SAFE_INTEGER; activeLastSeq = -1;
    var summary = summaries.get(sessionId);
    activeUpdatedAt = summary && summary.updatedAt;
    var page = await rpc('session.history', { sessionId: sessionId, maxMessages: 20 });
    if (epoch !== generation || activeSessionId !== sessionId) throw problem('对话已切换，请重新打开。');
    mergePage(page);
    return { records: records(), hasMore: activeHasMore, interactions: [] };
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
    if (input && Array.isArray(input.attachments) && input.attachments.length)
      throw problem('此旧版 DSH 不支持普通文件附件，请在对话中提供电脑文件路径。');
    var text = string(input && input.text);
    if (!text.trim()) throw problem('请输入消息。');
    var value = await rpc('session.prompt', { sessionId: string(input && input.sessionId),
      mode: 'queue', content: [{ type: 'text', text: text }] });
    if (!value || value.accepted !== true) throw problem('DSH 没有接受这条消息。');
    // Accepted prompts must not become apparent failures just because a
    // subsequent read timed out: retrying then could send the same text twice.
    refreshActive(generation).catch(function () {});
  }
  async function cancelSession(sessionId) {
    var value = await rpc('session.cancel', { sessionId: String(sessionId || '') });
    if (!value || value.accepted !== true) throw problem('DSH 没有接受停止请求。');
    return { accepted: true };
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
    profile: 'legacy-events', capabilities: { interactiveReplies: false, fileAttachments: false },
    connect: connect, disconnect: disconnect,
    listProjects: function () { return Promise.resolve(projectRows()); },
    listSessions: function (projectId) { return Promise.resolve(sessionRows(String(projectId))); },
    loadSession: loadSession, loadOlder: loadOlder, listDirectories: listDirectories,
    listWorkspaceFiles: listWorkspaceFiles, downloadFile: downloadFile,
    createProject: createProject, createSession: createSession,
    sendMessage: sendMessage, cancelSession: cancelSession
  };
})(window);
