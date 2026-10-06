(function () {
  'use strict';

  // Adapter contract (provided by the bridge, not by this view):
  //   connect(onEvent) -> Promise<void>; disconnect?() -> void|Promise<void>
  //   listProjects() -> Promise<Array<{id,name,path?}>>
  //   listSessions(projectId) -> Promise<Array<{id,title?,updatedAt?}>>
  //   loadSession(sessionId) -> Promise<{records:Array<{id?,role?,text?,title?,status?,attachments?}>,interactions?:Array}>
  //   createProject({path}) -> Promise<{id}>; createSession({projectId}) -> Promise<{id}>
  //   sendMessage({sessionId,text,attachments?}) -> Promise<void>
  //   uploadFile({sessionId,file}) -> Promise<{receiptId,file}> when supported;
  //     receipts are sent with the next message, not merely uploaded.
  //   listDirectories(path?) -> Promise<{path,parent,roots,directories}> when supported.
  //   listWorkspaceFiles({sessionId,path:'',offset:0}) ->
  //     Promise<{path,entries:[{name,path,type:'directory'|'file',bytes?}],nextOffset}>.
  //   capabilities?: {interactiveReplies:true} only when approval, choice and
  //     question replies are genuinely bridged for this DSH version.
  //   respondToInteraction({id,answer}) -> Promise<void> when supported.
  // Events: {type:'status',state:'connected'|'connecting'|'disconnected',userMessage?},
  // {type:'projects',projects}, {type:'sessions',projectId,sessions},
  // {type:'records',sessionId,records}, {type:'record',sessionId,record},
  // {type:'session-title',sessionId,title},
  // {type:'session-status',sessionId,running}, and records may carry hasMore.
  // {type:'interaction',interaction:{id,sessionId,kind,title?,text?,options?}},
  // A question interaction may carry `questions:[{id,question,detail?,
  // options?:[{label,description?}],multiSelect?}]`; one reply contains all
  // answers: {type:'answers',answers:[{id,selected:[label],custom?:string}]}.
  // {type:'interaction-resolved',id}, {type:'error',userMessage?}.
  // Interaction answers are semantic: {type:'approve'|'reject'},
  // {type:'choice',optionId}, or {type:'text',text}. The adapter maps them to
  // whichever DSH protocol/version is active. Only safe, user-facing error
  // messages belong in userMessage; this view never logs tokens or content.

  var active = null;

  // ── 文案取词（C8 三种语言）─────────────────────────────────────────────────
  //
  // 词条在 `/dsh-lite-lang.js` 里（中文原文当 key，翻不到就原样返回中文 ——
  // 见 pwa/i18n.js 开头那段说明）。这里**每次都现查 window.DshI18n**，
  // 而不是把函数拷一份出来：脚本是 defer 的，执行顺序不保证，
  // 拷一份就可能拿到"还没注册词条"的那份，界面就永远是中文。
  //
  // 兜底：i18n.js 没加载（被拦、老浏览器）时原样返回 —— 界面不会因此留空洞。
  function t(s) {
    try {
      if (window.DshI18n && typeof window.DshI18n.t === 'function') return window.DshI18n.t(s);
    } catch (err) { /* 取词失败就退回中文原文 */ }
    return s;
  }
  function $(id) { return document.getElementById(id); }

  // ── 极简 markdown 渲染 ────────────────────────────────────────────────────
  //
  // 为什么必须做：手机端原来把回复**当纯文本**塞进 textContent —— 于是
  // `**粗体**`、`|---|---|` 表格、``` 代码块 全是**裸露的符号**。
  // 使用者的截图里整屏都是 `**` 和 `|---|---|`，一句话要猜着读。
  //
  // ★ 安全顺序不能反：**先整体转义 HTML，再套 markdown 规则**。
  //   反过来的话，回复里随便写个 `<img onerror=...>` 就能在手机上执行 —— 那是 XSS。
  //   代码块要**先摘出来**（它内部不能再套行内规则），内容单独转义。
  //
  // 不引外部库：这一页是手机端最重的一份，为了几个星号去引一个几十 KB 的
  // markdown 库不划算，而且离线/内网时还要多一个请求。
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function markdownToHtml(text) {
    var src = String(text == null ? '' : text);

    // ① 摘出围栏代码块
    var codes = [];
    src = src.replace(/```[^\n`]*\n?([\s\S]*?)```/g, function (whole, body) {
      codes.push(String(body).replace(/\n$/, ''));
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    // ② 整体转义（这一步之后就没有可执行的 HTML 了）
    src = escapeHtml(src);

    // ③ 行内规则
    src = src
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // ④ 块级：逐行处理
    var lines = src.split('\n');
    var out = [];
    var openList = null;
    function closeList() { if (openList) { out.push('</' + openList + '>'); openList = null; } }
    function cells(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        .map(function (c) { return c.trim(); });
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      if (/^\u0000C\d+\u0000$/.test(trimmed)) { closeList(); out.push(trimmed); continue; }

      // 表格：`|a|b|` 后面紧跟 `|---|---|`
      if (/^\|.*\|$/.test(trimmed) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
        closeList();
        var head = cells(line);
        i++;                                   // 跳过分隔行
        var body = [];
        while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) {
          i++;
          body.push(cells(lines[i]));
        }
        var html = '<table><thead><tr>';
        head.forEach(function (c) { html += '<th>' + c + '</th>'; });
        html += '</tr></thead><tbody>';
        body.forEach(function (r) {
          html += '<tr>';
          head.forEach(function (_c, idx) { html += '<td>' + (r[idx] === undefined ? '' : r[idx]) + '</td>'; });
          html += '</tr>';
        });
        out.push(html + '</tbody></table>');
        continue;
      }

      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        var level = Math.min(4, heading[1].length) + 2;   // # → h3（手机屏小，别再大了）
        out.push('<h' + level + '>' + heading[2] + '</h' + level + '>');
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); out.push('<hr>'); continue; }

      var quote = /^&gt;\s?(.*)$/.exec(line);
      if (quote) { closeList(); out.push('<blockquote>' + quote[1] + '</blockquote>'); continue; }

      var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        var want = bullet ? 'ul' : 'ol';
        if (openList !== want) { closeList(); out.push('<' + want + '>'); openList = want; }
        out.push('<li>' + (bullet ? bullet[1] : numbered[1]) + '</li>');
        continue;
      }

      closeList();
      if (!trimmed) { out.push(''); continue; }
      out.push('<p>' + line + '</p>');
    }
    closeList();

    // ⑤ 代码块放回（内容单独转义 —— 摘出来的时候还没转义过）
    return out.join('\n').replace(/\u0000C(\d+)\u0000/g, function (whole, idx) {
      return '<pre class="md-code"><code>' + escapeHtml(codes[Number(idx)] || '') + '</code></pre>';
    });
  }
  function label(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }
  function safeId(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
  function safeError(error, fallback) {
    var message = error && typeof error.userMessage === 'string' ? error.userMessage.trim() : '';
    return message ? message.slice(0, 400) : fallback;
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function mount(adapter) {
    if (active) active.dispose();
    if (!adapter || typeof adapter.connect !== 'function') throw new Error('DSH lite adapter is unavailable');
    var refs = {
      status: $('connection-status'), reconnect: $('reconnect'), railReconnect: $('rail-reconnect'), retry: $('error-retry'),
      error: $('error-banner'), errorText: $('error-text'), projectsToggle: $('projects-toggle'),
      railActivity: $('rail-activity'), railScreen: $('rail-screen'), railSearch: $('rail-search'), search: $('nav-search'),
      railSettings: $('rail-settings'), settingsMenu: $('settings-menu'), settingsClassic: $('settings-classic'),
      sidebarClose: $('sidebar-close'), sidebarBackdrop: $('sidebar-backdrop'),
      projectList: $('project-list'), sessionList: $('session-list'), newProject: $('new-project'),
      newSession: $('new-session'), railNewProject: $('rail-new-project'), railNewSession: $('rail-new-session'),
      sessionTitle: $('session-title'), projectName: $('project-name'), classic: $('classic-view'),
      cryptoChip: $('crypto-chip'), goalBar: $('goal-bar'),
      queuePanel: $('queue-panel'), queueList: $('queue-list'), queueTitle: $('queue-title'),
      stop: $('stop-session'), historyBar: $('history-bar'), loadOlder: $('load-older'),
      tabConversation: $('tab-conversation'), tabActivity: $('tab-activity'),
      empty: $('empty-state'), records: $('record-list'), interactions: $('interaction-list'),
      interactionNote: $('interaction-note'),
      chat: $('chat'), composer: $('composer'), composerPicks: $('composer-picks'),
      composerConnection: $('composer-connection'), composerBalance: $('composer-balance'),
      input: $('message-input'), send: $('send-button'),
      upload: $('upload-button'), uploadInput: $('upload-input'), attachmentList: $('attachment-list'),
      modal: $('project-modal'), projectForm: $('project-form'), projectPath: $('project-path'),
      projectCancel: $('project-cancel'), projectSubmit: $('project-submit'),
      browseFolder: $('browse-folder'), folderBrowser: $('folder-browser'),
      filesOpen: $('files-open'), filesModal: $('files-modal'), filesClose: $('files-close'),
      filesProject: $('files-project'), filesCurrent: $('files-current'), filesUp: $('files-up'),
      filesFilter: $('files-filter'), filesList: $('files-list'), filesMore: $('files-more'), filesStatus: $('files-status')
    };
    var app = $('app');
    // Stored preferences already drive t(), but loading a fresh Chinese HTML
    // shell does not fire a language-change event. Translate static labels on
    // every mount without calling a previous controller's onLangChange hook.
    if (window.DshI18n && typeof window.DshI18n.apply === 'function') window.DshI18n.apply(document);
    if (adapter.capabilities && adapter.capabilities.imageAttachments === true && adapter.capabilities.fileAttachments === false) {
      refs.uploadInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
      refs.upload.title = t('上传图片');
      refs.upload.setAttribute('aria-label', t('上传图片'));
      refs.upload.setAttribute('data-i18n-title', '上传图片');
      refs.upload.setAttribute('data-i18n-aria', '上传图片');
    } else {
      refs.uploadInput.removeAttribute('accept');
      refs.upload.setAttribute('data-i18n-title', '上传文件');
      refs.upload.setAttribute('data-i18n-aria', '上传文件');
    }
    var mountSerial = (Number(window.__dshLiteMountSerial) || 0) + 1;
    window.__dshLiteMountSerial = mountSerial;
    app.dataset.liteUiBuild = 'session-create-v5';
    app.dataset.liteUiMount = String(mountSerial);
    app.dataset.liteCreate = 'idle';
    function createStage(value) {
      if (app.dataset.liteUiMount === String(mountSerial)) app.dataset.liteCreate = value;
    }
    // ── 记住上次看的项目和对话 ────────────────────────────────────────────────
    //
    // 手机上的实际用法是"切出去看一眼别的、再切回来"。没有这一段时，每次回来
    // 都要重新选项目、重新选对话 —— 用起来像是每次都从头开始。使用者反馈的原话是
    // 「切换应用后需要刷新和需要重新选择项目」。
    //
    // 存的是 id（不是名字），所以项目和对话被改名也不会错位。
    // localStorage 在隐私模式 / 存储被禁用时会直接抛异常，所以每一次都包起来：
    // 记不住只是回到"要重新选"的旧行为，绝不能让整个界面因为存不了而崩掉。
    function recall(key) {
      try { return window.localStorage.getItem('dsh-lite:' + key) || ''; } catch (err) { return ''; }
    }
    function remember(key, value) {
      try {
        if (value) window.localStorage.setItem('dsh-lite:' + key, String(value));
        else window.localStorage.removeItem('dsh-lite:' + key);
      } catch (err) { /* 存不了就算了，不影响这一轮使用 */ }
    }
    var pendingCreateKey = 'dsh-lite:pending-create';
    function pendingCreate() {
      try {
        var raw = window.sessionStorage.getItem(pendingCreateKey);
        if (!raw) return null;
        var value = JSON.parse(raw);
        if (!value || typeof value.projectId !== 'string' ||
            !Array.isArray(value.knownIds) || value.knownIds.length > 10000 ||
            !Number.isFinite(value.startedAt) || Date.now() - value.startedAt > 30000 ||
            Date.now() < value.startedAt) {
          window.sessionStorage.removeItem(pendingCreateKey); return null;
        }
        return value;
      } catch (_) { return null; }
    }
    function savePendingCreate(value) {
      try { window.sessionStorage.setItem(pendingCreateKey, JSON.stringify(value)); } catch (_) {}
    }
    function clearPendingCreate(projectId) {
      try {
        var value = pendingCreate();
        if (value && value.projectId === projectId) window.sessionStorage.removeItem(pendingCreateKey);
      } catch (_) {}
    }
    var state = {
      connection: 'disconnected', projects: [], sessions: [], records: [], interactions: new Map(),
      projectId: recall('project'),
      // ★ 对话**不从记忆里直接读进来**，而是交给 restoreSession 那一套去恢复。
      //   为什么：记忆里的那个 id 可能是**已经不存在的对话**（被删了、换了项目）。
      //   直接当成"当前对话"用，界面会去加载一个不存在的会话然后停在空白上 ——
      //   也就是使用者说的"被强制跳回选择项目"。所以它必须先和**真实列表**核一遍。
      sessionId: '', tab: 'conversation', sending: false, uploading: false,
      drafts: new Map(), interactionDrafts: new Map(), interactionExpanded: new Set(),
      uploads: [], downloadUrls: new Map(), recordElements: new Map(),
      creating: false, creatingKind: '', connecting: 0, running: false, runningKnown: null, stopping: false,
      hasMore: false, loadingOlder: false,
      loadingProjects: false, loadingSessions: false,
      // C11 的另一半：项目/对话列表**读失败**的原因。
      // 非空时界面显示原因 + 重试，而不是假装"你还没有项目"。
      projectsError: '', sessionsError: '',
      projectLoad: 0, sessionLoad: 0, pendingRecords: [], loadingSession: '', folderLoad: 0,
      filesLoad: 0, filesPath: '', filesStack: [], filesEntries: [], filesNextOffset: null,
      filesLoading: false, filesRetry: null, filePreview: null, disposed: false,
      // C12 排队消息。手机端原来**完全看不到**执行中排队的内容。
      queued: [], queueLoading: false, queueRequest: 0, cwd: '',
      // C26 目标：`goal` 是最近一次读到的目标快照（null = 没有），
      // `goalEditing` 非空时目标条上是**内联输入框**（{text}）。
      // 放在 state 里而不是闭包里，是为了让"操作完重新读一遍"能重画同一条。
      goal: null, goalEditing: null, goalRequest: 0, goalError: '', contextVersion: 0,
      selection: { agentPreset: null, modelSelection: null, lastUsedModel: null, blank: null, plan: null },
      selectionRequest: 0,
      // 正在编辑的那条排队消息（{id, text, caret}）。放在 state 里而不是闭包里，
      // 是为了让"队列自动刷新"不至于把人家正在打的字冲掉（见 buildQueueEditor）。
      queueEditing: null,
      // 「这次打开还想接着看哪段对话」。只在启动时填一次，用掉就清 ——
      // 否则使用者手动换了对话以后，下一次重连又会被拽回去（那更烦人）。
      restoreSession: ''
    };
    var listeners = [];
    function listen(node, type, fn) { node.addEventListener(type, fn); listeners.push([node, type, fn]); }
    function closeSettingsMenu() {
      refs.settingsMenu.hidden = true;
      refs.railSettings.setAttribute('aria-expanded', 'false');
    }
    // 离开页面之前把当前选中的项目和对话存下来。
    //
    // 为什么放在这里而不是每个赋值点各插一句：赋值点有好几处（新建项目、
    // 列表首次加载自动选中、点选…），逐个去插一定会漏。而"离开页面"只有
    // 两个出口，覆盖全：
    //   · visibilitychange → 切到别的 App、锁屏、切标签页
    //   · pagehide         → 刷新、关闭、前进后退
    // 两个都注册，因为 iOS Safari 上不保证哪一个一定触发。
    function persistSelection() {
      remember('project', state.projectId);
      remember('session', state.sessionId);
    }
    // 启动时先把「上次那段对话」记在一边，等项目列表回来再恢复（见 reloadProjects）。
    scheduleSessionRestore();

    // ── 复制到剪贴板 ──────────────────────────────────────────────────────────
    //
    // 手机上**没有"拖选一段文字"这回事**，所以复制必须靠按钮（见 buildRecord）。
    // 而且必须带兜底：`navigator.clipboard` 只在**安全上下文**（HTTPS 或 localhost）
    // 才存在，而内网直连是 `http://192.168.x.x` —— 那里它压根没有，
    // 只用它会让"在家用内网"时复制直接失灵。所以退回 textarea + execCommand。
    function legacyCopy(text) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, area.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch (err) { return false; }
    }
    /**
     * 这一轮助手说过的话（合并成一整段）。
     *
     * ★ 为什么需要：一轮回复在界面上是**好几条 record**（流式分段落的），
     *   而"复制"原来只复制其中一条。使用者的原话是：
     *   「复制应该能一次性复制你一轮说的所有东西而不是一个小框框」。
     *
     * 怎么分组：从这条 record 往前找到**最近的一条用户消息**，
     * 再往后找到**下一条用户消息**，中间所有助手文本合成一段。
     * **不合并思考过程** —— 那是另一回事，它自己也有复制按钮。
     */
    function turnTextFor(record) {
      var list = state.records || [];
      // A keyed row can retain its copy button while a fresh snapshot supplies
      // equivalent new record objects. Resolve its stable ID against live data.
      var recordId = safeId(record && record.id);
      var at = recordId ? list.findIndex(function (row) { return safeId(row && row.id) === recordId; }) : list.indexOf(record);
      if (at < 0) return label(record && record.text, '');
      var start = 0;
      for (var i = at; i >= 0; i--) {
        if (list[i] && list[i].role === 'user') { start = i + 1; break; }
      }
      var end = list.length;
      for (var j = at + 1; j < list.length; j++) {
        if (list[j] && list[j].role === 'user') { end = j; break; }
      }
      var parts = [];
      for (var k = start; k < end; k++) {
        var row = list[k];
        if (!row || row.role !== 'assistant') continue;
        var text = label(row.text, '');
        if (text) parts.push(text);
      }
      return parts.join('\n\n');
    }

    function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(
          function () { return true; },
          function () { return legacyCopy(text); });
      }
      return Promise.resolve(legacyCopy(text));
    }
    listen(document, 'visibilitychange', function () {
      if (document.hidden) persistSelection();
    });
    listen(window, 'pagehide', persistSelection);
    // 自测用的只读探针。故意只读：不提供任何"设置状态"的口子，
    // 免得它变成一个绕过界面逻辑改状态的暗门。
    window.__dshLiteState = function () {
      return { sessionId: state.sessionId, projectId: state.projectId,
        restoreSession: state.restoreSession, sessions: state.sessions.length,
        connection: state.connection, running: state.running };
    };
    // Composer controls are built after this declaration; language changes
    // relabel those persistent buttons in place.
    // ★ 这个声明必须在 `installComposerPicks` **之前**：那里是往这个变量**赋值**，
    //   而 `var` 声明会提升、**赋值不会**。写在后面就等于"先被那个 IIFE 赋值、
    //   随后又被这行的空函数覆盖掉"，换语言时调到的永远是空函数。
    var composerPicksRelabel = function () {};
    // ── 挂载时自己建出来的那些浮层 ────────────────────────────────────────────
    //
    // The voice button, jump button, and overlays are created per mount.
    // Remove them before remounting so stale controls do not retain old adapters.
    var mountNodes = [];
    var mountTimers = [];
    var mountObservers = [];
    var mountCleanups = [];
    function keep(node) { if (node) mountNodes.push(node); return node; }
    // Keep failures beside the action that caused them. The global error bar is
    // behind a modal and cannot be seen while the folder picker is open.
    refs.projectFeedback = keep(el('p', 'files-status'));
    refs.projectFeedback.hidden = true;
    refs.projectFeedback.setAttribute('role', 'status');
    refs.projectForm.insertBefore(refs.projectFeedback, refs.projectForm.querySelector('.modal-actions'));
    refs.filesRetry = keep(el('button', 'files-more', t('重试读取')));
    refs.filesRetry.id = 'files-retry';
    refs.filesRetry.type = 'button';
    refs.filesRetry.hidden = true;
    refs.filesModal.querySelector('.modal').insertBefore(refs.filesRetry, refs.filesStatus);
    function projectMessage(message, failed) {
      refs.projectFeedback.textContent = message || '';
      refs.projectFeedback.dataset.state = failed ? 'error' : 'success';
      refs.projectFeedback.hidden = !message;
    }
    function draftKey(projectId, sessionId) { return projectId + '\n' + sessionId; }
    function saveCurrentDraft() {
      if (!state.projectId || !state.sessionId) return;
      var key = draftKey(state.projectId, state.sessionId);
      var draft = { text: refs.input.value, uploads: state.uploads.slice() };
      if (draft.text || draft.uploads.length) state.drafts.set(key, draft);
      else state.drafts.delete(key);
    }
    function restoreDraft(projectId, sessionId) {
      var draft = state.drafts.get(draftKey(projectId, sessionId));
      refs.input.value = draft ? draft.text : '';
      state.uploads = draft ? draft.uploads.slice() : [];
      renderUploads();
    }
    function resetSessionExtras() {
      clearLocalUploadPreviews(false);
      state.contextVersion++;
      state.goalRequest++;
      state.queueRequest++;
      state.selectionRequest++;
      state.selection = { agentPreset: null, modelSelection: null, lastUsedModel: null, blank: null, plan: null };
      state.goal = null;
      state.goalError = '';
      state.goalEditing = null;
      state.queued = [];
      state.queueLoading = false;
      state.queueEditing = null;
      renderGoalBar();
      renderQueue();
      composerPicksRelabel();
    }
    refs.retry.onclick = null;
    refs.reconnect.onclick = null;
    function canReply() {
      return !!(adapter.capabilities && adapter.capabilities.interactiveReplies === true &&
        typeof adapter.respondToInteraction === 'function');
    }
    function showError(error, fallback, kind) {
      refs.errorText.textContent = safeError(error, fallback);
      refs.error.dataset.kind = kind || 'operation';
      refs.error.hidden = false;
    }
    function clearError() { refs.error.hidden = true; refs.errorText.textContent = ''; delete refs.error.dataset.kind; }
    function setSidebar(open) {
      document.body.classList.toggle('sidebar-hidden', !open);
      refs.projectsToggle.setAttribute('aria-expanded', String(!!open));
    }
    function setStatus(value) {
      state.connection = value;
      // 状态**文案**单独记一份。为什么不复用 `state.connection`：
      // 它会被别处（比如适配器重连）改动，而"连接断开"那行字是使用者最后看到的事实。
      // 换语言时照这份重画，才不会把界面上的状态改回一个更旧的值。
      state.statusText = value === 'connected' ? '已连接' : value === 'connecting' ? '正在连接' : '连接断开';
      refs.status.dataset.state = value;
      refs.status.textContent = t(state.statusText);
      if (refs.composerConnection) {
        refs.composerConnection.dataset.state = value;
        refs.composerConnection.textContent = t(state.statusText);
      }
      renderControls();
      updateCryptoChip();
    }
    /** 换语言时把"连接状态"这行字重画一遍 —— 它是 setStatus 当时写死的，不会自己变。 */
    function relabelStatus() {
      if (state.connection) setStatus(state.connection);
      else if (state.statusText) refs.status.textContent = t(state.statusText);
    }
    function renderControls() {
      var ready = state.connection === 'connected';
      refs.newProject.disabled = !ready || state.creating || typeof adapter.createProject !== 'function';
      refs.newSession.disabled = !ready || !state.projectId || state.loadingProjects || state.loadingSessions ||
        state.creating || typeof adapter.createSession !== 'function';
      // ★ 下面这几行原来**把文案写死成中文** —— 后果是：i18n.js 刚把界面翻成
      //   英文，renderControls() 一跑又写回中文。使用者报的「英语，西班牙语的时候
      //   不是所有的都改变」，有相当一部分就是这里。
      //   规矩：凡是渲染时写进 DOM 的文字，一律过 t()。
      refs.newSession.textContent = state.creatingKind === 'session' ? t('正在创建…') : t('＋ 新对话');
      refs.railNewProject.disabled = refs.newProject.disabled;
      refs.railNewSession.disabled = refs.newSession.disabled;
      refs.railNewSession.setAttribute('aria-label',
        state.creatingKind === 'session' ? t('正在创建对话') : t('新建对话'));
      // ★ 输入框**永远可以打字**（2026-09-29 改）。
      //
      //   这里原来还有 `!ready`（连接没就绪）和 `state.sending`（正在发）——
      //   后果是网络一抖、或者刚点完发送，输入框就变灰**打不了字**，
      //   正打到一半的句子被打断。使用者报的就是这个：「网络不稳定的时候
      //   应该不能打断指令的输入」。
      //   要禁用的只是**发送按钮**，不是输入框 —— 连接回来了还能接着按发送。
      refs.input.disabled = typeof adapter.sendMessage !== 'function';
      refs.send.disabled = !ready || !state.sessionId || state.sending || state.uploading ||
        typeof adapter.sendMessage !== 'function' ||
        (!refs.input.value.trim() && !state.uploads.length);
      refs.upload.disabled = !ready || !state.sessionId || state.uploading || typeof adapter.uploadFile !== 'function';
      refs.projectSubmit.disabled = !ready || state.creating || typeof adapter.createProject !== 'function';
      refs.projectSubmit.textContent = state.creatingKind === 'project' ? t('正在添加…') : t('选择此文件夹');
      refs.browseFolder.hidden = typeof adapter.listDirectories !== 'function';
      refs.filesOpen.disabled = !ready || !state.sessionId || typeof adapter.listWorkspaceFiles !== 'function' ||
        typeof adapter.downloadFile !== 'function';
      refs.stop.hidden = !state.running || typeof adapter.cancelSession !== 'function';
      refs.stop.disabled = !ready || state.stopping;
      refs.stop.textContent = state.stopping ? t('正在停止…') : t('停止');
      refs.historyBar.hidden = !state.sessionId || !state.hasMore || typeof adapter.loadOlder !== 'function';
      refs.loadOlder.disabled = !ready || state.loadingOlder;
      refs.loadOlder.textContent = state.loadingOlder ? t('正在加载…') : t('加载更早内容');
    }
    function currentProject() { return state.projects.find(function (p) { return safeId(p.id) === state.projectId; }); }
    function currentSession() { return state.sessions.find(function (s) { return safeId(s.id) === state.sessionId; }); }
    function refreshSelection() {
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var request = ++state.selectionRequest;
      var row = currentSession();
      state.selection = {
        agentPreset: row && row.agentPreset || null,
        modelSelection: row && row.modelSelection || null,
        lastUsedModel: row && row.lastUsedModel || null,
        blank: row && typeof row.blank === 'boolean' ? row.blank : null,
        plan: row && row.plan || null
      };
      composerPicksRelabel();
      if (!sessionId || typeof adapter.readSelection !== 'function') return Promise.resolve(state.selection);
      return Promise.resolve().then(function () { return adapter.readSelection(sessionId); }).then(function (value) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || request !== state.selectionRequest) return state.selection;
        if (value && typeof value === 'object') {
          state.selection = {
            agentPreset: typeof value.agentPreset === 'string' && value.agentPreset || null,
            modelSelection: value.modelSelection || null,
            lastUsedModel: value.lastUsedModel || null,
            blank: typeof value.blank === 'boolean' ? value.blank : null,
            plan: value.plan && typeof value.plan.active === 'boolean' && typeof value.plan.pending === 'boolean' ? value.plan : null
          };
          composerPicksRelabel();
        }
        return state.selection;
      }).catch(function () { return state.selection; });
    }
    function renderProjects() {
      refs.projectList.replaceChildren();
      // ★ 先看**是不是根本没读到**（C11 的另一半）。
      //   原来不管三七二十一：列表空就显示「还没有项目。点击"添加项目"」——
      //   于是"读失败"和"你真的没有项目"长得一模一样，
      //   使用者会以为项目全没了。现在把原因说出来，并给一个重试。
      if (state.projectsError) {
        refs.projectList.append(el('div', 'list-empty', state.projectsError));
        var retry = el('button', 'text-action', t('重试读取'));
        retry.type = 'button';
        retry.addEventListener('click', function () { reloadProjects(); });
        refs.projectList.append(retry);
        return;
      }
      var term = refs.search.value.trim().toLocaleLowerCase();
      var projects = state.projects.filter(function (project) {
        return !term || (label(project.name, '') + ' ' + label(project.path, '')).toLocaleLowerCase().indexOf(term) >= 0;
      });
      if (!projects.length) {
        refs.projectList.append(el('div', 'list-empty', state.loadingProjects ? t('正在加载项目…') : term ? t('没有匹配的项目。') : t('还没有项目。点击“添加项目”。')));
        return;
      }
      projects.forEach(function (project) {
        var id = safeId(project.id);
        if (!id) return;
        var button = el('button', 'list-item');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(id === state.projectId));
        button.append(el('span', '', label(project.name, label(project.path, t('未命名项目')))));
        if (project.path) button.append(el('small', '', project.path));
        button.addEventListener('click', function () { selectProject(id); });
        refs.projectList.append(button);
      });
    }
    function renderSessions() {
      refs.sessionList.replaceChildren();
      if (!state.projectId) { refs.sessionList.append(el('div', 'list-empty', t('先选择项目。'))); return; }
      if (state.loadingSessions) { refs.sessionList.append(el('div', 'list-empty', t('正在加载对话列表…'))); return; }
      // ★ 读失败要说出来 —— 不然下面会画成「这个项目还没有对话。」（C11 的另一半）
      if (state.sessionsError) {
        refs.sessionList.append(el('div', 'list-empty', state.sessionsError));
        var retry = el('button', 'text-action', t('重试读取'));
        retry.type = 'button';
        retry.addEventListener('click', function () {
          if (state.projectId) selectProject(state.projectId);
        });
        refs.sessionList.append(retry);
        return;
      }
      var term = refs.search.value.trim().toLocaleLowerCase();
      var sessions = state.sessions.filter(function (session) {
        return !term || label(session.title, '').toLocaleLowerCase().indexOf(term) >= 0;
      });
      if (!sessions.length) { refs.sessionList.append(el('div', 'list-empty', term ? t('没有匹配的对话。') : t('这个项目还没有对话。'))); return; }
      sessions.forEach(function (session) {
        var id = safeId(session.id);
        if (!id) return;
        var button = el('button', 'list-item');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(id === state.sessionId));
        button.append(el('span', '', label(session.title, t('未命名对话'))));
        if (session.updatedAt) button.append(el('small', '', String(session.updatedAt)));
        button.addEventListener('click', function () { selectSession(id, 'user'); });
        refs.sessionList.append(button);
      });
    }
    function renderTitle() {
      var project = currentProject();
      var session = currentSession();
      refs.projectName.textContent = project ? label(project.name, label(project.path, t('项目'))) : '';
      refs.sessionTitle.textContent = session ? label(session.title, t('未命名对话')) : t('选择一个对话');
      renderEmpty();
    }
    function recordIsVisible(record) {
      if (!record) return false;
      var role = label(record.role, '');
      // 「轨迹」页：只看思考和工具，用来纵览一整轮做了什么
      if (state.tab === 'activity') return role === 'thought' || role === 'tool';
      // ★「对话」页现在**也显示**思考和工具（2026-09-29 改）。
      //   原来这里写的是 role !== 'thought' && role !== 'tool' —— 把两者从对话流里
      //   彻底滤掉，于是对话里只剩一问一答：看不到助手在想什么、看不到它调用了
      //   哪些工具、动了哪些文件。而那恰恰是"把 DSH 当编码助手用"的主体信息，
      //   使用者反馈的原话是「看不到你生成的文件、更改的文件、你的思考过程」。
      //   现在改成折叠呈现（见 buildRecord）：默认收起成一行标题，点开才看内容 ——
      //   过程看得见，又不会把正文挤下去。
      return true;
    }
    function visibleRecords() {
      return state.records.filter(recordIsVisible);
    }
    function setTab(tab) {
      state.tab = tab === 'activity' ? 'activity' : 'conversation';
      refs.tabConversation.setAttribute('aria-current', state.tab === 'conversation' ? 'page' : 'false');
      refs.tabActivity.setAttribute('aria-current', state.tab === 'activity' ? 'page' : 'false');
      refs.railActivity.setAttribute('aria-pressed', String(state.tab === 'activity'));
      renderRecords();
    }
    function renderEmpty() {
      if (visibleRecords().length) { refs.empty.hidden = true; return; }
      refs.empty.hidden = false;
      refs.empty.textContent = state.loadingSession ? t('正在加载对话内容…') :
        state.sessionId ? state.tab === 'activity' ? t('这段对话暂无可显示的轨迹。') : t('这段对话还没有消息。') :
          t('选择项目和对话，或新建对话。');
    }
    function buildRecord(record) {
        var role = label(record.role, t('消息'));
        var item = el('li', 'record');
        item.dataset.recordId = safeId(record.id);
        item.dataset.role = role;
        var meta = el('div', 'record-meta');
        meta.append(el('span', 'record-role', label(record.title,
          role === 'user' ? t('我') : role === 'assistant' ? 'DSH' : role === 'thought' ? t('思考') : role === 'tool' ? t('工具') : role)));
        item.append(meta);
        var recordText = typeof record.text === 'string' ? record.text : '';
        if (role === 'system' && record.status === 'error') {
          recordText = t(recordText);
          meta.querySelector('.record-role').textContent = t(label(record.title, '模型请求失败'));
        }
        // ★ 一键复制这一条。手机上没法拖选文字，没有按钮就等于复制不了。
        //   **助手说的和用户自己说的都要有**（用户的原话：「你的我的都不行」）。
        //
        // ★ 助手那条复制的是**整轮**，不是这一小条（2026-09-29 改）。
        //   使用者原话：「复制应该能一次性复制你一轮说的所有东西而不是一个小框框」。
        //   一轮回复在界面上是**好几条 record**（流式分段），原来只复制其中一条，
        //   等于把一整段回答切成几块分别复制 —— 用起来很别扭。
        //   用户自己说的、思考、工具：仍然只复制这一条（它们本来就是完整的一条）。
        if (recordText) {
          var wholeTurn = role === 'assistant';
          var copyButton = el('button', 'record-copy', wholeTurn ? t('复制整轮') : t('复制'));
          copyButton.type = 'button';
          copyButton.setAttribute('aria-label',
            (wholeTurn ? t('复制整轮') : t('复制')) + ' · ' + role);
          copyButton.addEventListener('click', function () {
            var payload = wholeTurn ? (turnTextFor(record) || recordText) : recordText;
            copyText(payload).then(function (done) {
              copyButton.textContent = done ? t('已复制') : t('复制失败');
              copyButton.classList.toggle('is-done', !!done);
              setTimeout(function () {
                copyButton.textContent = wholeTurn ? t('复制整轮') : t('复制');
                copyButton.classList.remove('is-done');
              }, 1600);
            });
          });
          meta.append(copyButton);
        }
        if (role === 'thought' || role === 'tool') {
          // 思考过程和工具调用是"过程"，默认折叠成一行；点标题才展开内容。
          // 例外：正在进行的（status 是 running / preparing）**默认展开** ——
          // 正在发生的事应该当场看得见，而不是等结束才知道它跑过。
          var busy = record.status === 'running' || record.status === 'preparing';
          var fold = el('details', 'record-fold');
          if (busy) fold.open = true;
          fold.append(el('summary', 'record-fold-summary',
            role === 'thought' ? t('思考') : label(record.title, t('工具'))));
          fold.append(el('p', 'record-text', recordText));
          item.append(fold);
          if (busy) item.append(el('span', 'record-status', t('进行中')));
        } else {
          // 助手和用户的话走 markdown 渲染（`**粗体**`、代码块、表格、列表…）。
          // 思考过程和工具调用**保持纯文本** —— 工具参数常常是 JSON，
          // 套 markdown 只会把它打乱。
          var body = el('p', 'record-text record-markdown');
          body.innerHTML = markdownToHtml(recordText);
          item.append(body);
        }
        if (Array.isArray(record.attachments) && record.attachments.length) {
          var attachments = el('div', 'record-attachments');
          record.attachments.forEach(function (attachment) {
            if (!attachment || typeof attachment !== 'object') return;
            var name = label(attachment.name, t('文件'));
            var path = typeof attachment.path === 'string' ? attachment.path : '';
            var officialImage = !path && officialImageAttachment(attachment);
            if ((!path || typeof adapter.downloadFile !== 'function') && !officialImage) {
              if (!path && localImageAttachment(attachment)) {
                attachments.append(buildLocalUploadImage(attachment, name));
                return;
              }
              var size = Number.isSafeInteger(attachment.size) && attachment.size >= 0 ?
                ' · ' + attachment.size + ' B' : '';
              attachments.append(el('span', 'record-file record-file-label', name + size));
              return;
            }
            var isImage = officialImage || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(path);
            var imageKey = officialImage ? officialImageKey(attachment) : path;
            var cached = imageKey && state.downloadUrls.get(imageKey);
            if (isImage) {
              // ── 图片直接显示出来（2026-09-29 补）────────────────────────────
              //
              // 使用者的原话：「看不到你生成的文件」以及「你的手机端有没有这个问题」。
              // 原来这里对图片也只是一个「↓ 下载 xxx.png」的文字按钮 ——
              // 也就是说**图片在轻量版界面里根本不会被画出来**，得先点下载、存到相册、
              // 再切出去看。这跟"看不到"没什么区别。
              //
              // 取字节走 adapter.downloadFile（它自己带端到端加密和证明重试），
              // 拿回来是 blob → 直接当 <img> 的地址。**不经过明文**：
              // 明文那条路网关会拒（内容通道拒绝明文、不降级），这也是 Codex 那边
              // 栽过的同一个坑，这里一次做对。
              var figure = el('figure', 'record-image');
              var holder = el('button', 'record-image-holder', t('点一下加载图片'));
              holder.type = 'button';
              holder.setAttribute('aria-label', t('加载图片') + ' ' + name);
              var image = el('img', 'record-image-img');
              image.alt = name;
              image.hidden = true;
              image.loading = 'lazy';
              if (cached && cached.url) { image.src = cached.url; image.hidden = false; holder.hidden = true; }
              figure.append(holder, image);
              // 顺手保留原来那个下载入口 —— 想存到手机上时还是要它。
              var keep = cached ? el('a', 'record-file', t('↓ 保存 ') + name) : el('button', 'record-file', t('↓ 下载 ') + name);
              if (cached) { keep.href = cached.url; keep.download = cached.name; }
              else {
                keep.type = 'button';
                keep.addEventListener('click', function () {
                  if (officialImage) downloadOfficialImage(attachment, keep);
                  else downloadAttachment(attachment, keep);
                });
              }
              var load = function () {
                if (image.getAttribute('src') || holder.disabled) return;
                var sessionId = state.sessionId, contextVersion = state.contextVersion;
                holder.disabled = true;
                holder.textContent = t('正在取图…');
                var read = officialImage ? cacheOfficialImage(attachment) : cacheDownload(path, name, sessionId);
                read.then(function (entry) {
                  if (!holder.isConnected || state.sessionId !== sessionId || state.contextVersion !== contextVersion || state.disposed) return;
                  if (!entry || !entry.url) { holder.textContent = t('取不到这张图，点这里再试'); return; }
                  image.src = entry.url;
                  image.hidden = false;
                  holder.hidden = true;
                }).catch(function (error) {
                  if (holder.isConnected) holder.textContent = t(safeError(error, '取不到这张图，点这里再试'));
                }).finally(function () { if (holder.isConnected) holder.disabled = false; });
              };
              holder.addEventListener('click', load);
              image.addEventListener('click', function () { if (image.getAttribute('src')) window.open(image.src, '_blank', 'noopener'); });
              image.addEventListener('error', function () {
                var failedUrl = image.getAttribute('src');
                image.removeAttribute('src');
                var entry = state.downloadUrls.get(imageKey);
                if (entry && entry.url === failedUrl) { URL.revokeObjectURL(entry.url); state.downloadUrls.delete(imageKey); }
                image.hidden = true;
                holder.hidden = false;
                holder.disabled = false;
                holder.textContent = t('取不到这张图，点这里再试');
              });
              attachments.append(figure, keep);
              return;
            }
            var file = cached ? el('a', 'record-file', t('↓ 保存 ') + name) : el('button', 'record-file', t('↓ 下载 ') + name);
            if (cached) {
              file.href = cached.url;
              file.download = cached.name;
            } else {
              file.type = 'button';
              file.addEventListener('click', function () { downloadAttachment(attachment, file); });
            }
            attachments.append(file);
          });
          item.append(attachments);
        }
        var statusText = record.status === 'running' ? t('进行中') : record.status === 'settled' ? t('已完成') :
          record.status === 'interrupted' ? t('已中断') : record.status === 'preparing' ? t('准备中') :
            record.status === 'error' ? t('失败') : '';
        if (statusText) item.append(el('small', 'record-status', statusText));
        return item;
    }
    var recordSnapshots = new Map();
    var recordFrame = null;
    var pendingRecordIds = new Set();
    function cancelRecordFrame() {
      if (recordFrame !== null) window.cancelAnimationFrame(recordFrame);
      recordFrame = null;
      pendingRecordIds.clear();
    }
    mountCleanups.push(cancelRecordFrame);
    function snapshotForRecord(record) {
      var attachments = Array.isArray(record.attachments) ? record.attachments : [];
      return { role: record.role, title: record.title, text: record.text, status: record.status,
        files: JSON.stringify(attachments.map(function (item) {
          if (!item || typeof item !== 'object') return null;
          var cached = state.downloadUrls.get(item.path || (officialImageAttachment(item) ? officialImageKey(item) : ''));
          var local = !item.path && localUploadPreview(item);
          return [item.id, item.kind, item.name, item.path, item.size, item.mimeType,
            cached && cached.url, cached && cached.name, !!local, local && local.url];
        })) };
    }
    function sameRecordSnapshot(a, b) {
      return a && b && a.role === b.role && a.title === b.title && a.text === b.text &&
        a.status === b.status && a.files === b.files;
    }
    function reconcileRecord(record, force) {
      var id = safeId(record.id);
      var previous = id && state.recordElements.get(id);
      var snapshot = snapshotForRecord(record);
      if (!force && previous && sameRecordSnapshot(recordSnapshots.get(id), snapshot)) return previous;
      var item = buildRecord(record);
      var oldFold = previous && previous.querySelector('.record-fold');
      var newFold = item.querySelector('.record-fold');
      if (oldFold && newFold) newFold.open = oldFold.open;
      if (id) { state.recordElements.set(id, item); recordSnapshots.set(id, snapshot); }
      return item;
    }
    function renderRecords(prepend, force) {
      cancelRecordFrame();
      var oldHeight = refs.records.scrollHeight;
      var oldTop = refs.records.scrollTop;
      var nearBottom = oldHeight - oldTop - refs.records.clientHeight < 100;
      var cursor = refs.records.firstChild;
      var currentIds = new Set();
      var changed = false;
      visibleRecords().forEach(function (record) {
        var item = reconcileRecord(record, force);
        var id = safeId(record.id);
        if (id) currentIds.add(id);
        if (item !== cursor) { refs.records.insertBefore(item, cursor); changed = true; }
        cursor = item.nextSibling;
      });
      while (cursor) { var next = cursor.nextSibling; cursor.remove(); cursor = next; changed = true; }
      Array.from(state.recordElements.keys()).forEach(function (id) {
        if (!currentIds.has(id)) { state.recordElements.delete(id); recordSnapshots.delete(id); }
      });
      renderEmpty();
      // ── 刷新后补回"正在运行"状态 ────────────────────────────────────────────
      //
      // DSH 只在状态**变化时**广播 running；刷新之后那条事件不会再发一次，
      // 而加载会话的代码会把 state.running 清成 false —— 于是任务还在跑、
      // 界面却认为它停了（「停止」按钮也跟着消失）。使用者的原话是
      // 「刷新后无任务状态」。
      //
      // 从记录自身把它推导回来：适配器给进行中的记录标了 status 'running'
      // （助手/思考）或 'preparing'（工具调用）。
      // ★ **只补 true，不清 false** —— 清零的时机仍然只由实时事件和会话切换决定，
      //   这样不会误伤「停止」按钮的判断。
      if (state.runningKnown === null && !state.running && state.records.some(function (r) {
        return r && (r.status === 'running' || r.status === 'preparing');
      })) {
        state.running = true;
        if (refs.stop) refs.stop.hidden = typeof adapter.cancelSession !== 'function';
      }
      if (changed) {
        if (prepend) refs.records.scrollTop = oldTop + refs.records.scrollHeight - oldHeight;
        else if (nearBottom) refs.records.scrollTop = refs.records.scrollHeight;
        else refs.records.scrollTop = oldTop;
      }
    }
    function upsertRecord(record) {
      if (!record) return;
      var id = safeId(record.id);
      var index = id ? state.records.findIndex(function (r) { return safeId(r && r.id) === id; }) : -1;
      if (index >= 0) state.records[index] = record;
      else state.records.push(record);
      if (!id) { renderRecords(); return; }
      pendingRecordIds.add(id);
      if (recordFrame !== null) return;
      var sessionId = state.sessionId, contextVersion = state.contextVersion;
      recordFrame = window.requestAnimationFrame(function () {
        recordFrame = null;
        var ids = Array.from(pendingRecordIds);
        pendingRecordIds.clear();
        if (state.disposed || state.sessionId !== sessionId || state.contextVersion !== contextVersion || !refs.records.isConnected) return;
        var nearBottom = refs.records.scrollHeight - refs.records.scrollTop - refs.records.clientHeight < 100;
        var changed = false;
        ids.forEach(function (rowId) {
          var record = state.records.find(function (item) { return safeId(item && item.id) === rowId; });
          if (!record) return;
          var previous = state.recordElements.get(rowId);
          if (recordIsVisible(record)) {
            var item = reconcileRecord(record);
            if (item !== previous) {
              if (previous) previous.replaceWith(item); else refs.records.append(item);
              changed = true;
            }
          } else if (previous) {
            previous.remove(); state.recordElements.delete(rowId); recordSnapshots.delete(rowId); changed = true;
          }
        });
        renderEmpty();
        if (changed && nearBottom) refs.records.scrollTop = refs.records.scrollHeight;
      });
    }
    function mergeRecords(base, pending, prepend) {
      state.records = Array.isArray(base) ? base.slice() : [];
      pending.forEach(function (record) {
        if (!record) return;
        var id = safeId(record.id);
        var index = id ? state.records.findIndex(function (r) { return safeId(r && r.id) === id; }) : -1;
        if (index >= 0) state.records[index] = record;
        else state.records.push(record);
      });
      renderRecords(prepend);
    }
    function clearDownloadUrls() {
      clearLocalUploadPreviews(false);
      officialImageEpoch++;
      officialImagePending.forEach(function (entry) { entry.controller.abort(); });
      officialImagePending.clear();
      state.downloadUrls.forEach(function (entry) { URL.revokeObjectURL(entry.url); });
      state.downloadUrls.clear();
      state.filePreview = null;
      renderFilePreview();
    }
    // Native DSH can confirm an attachment ID without exposing a downloadable
    // workspace path. Retain only this phone's verified original File, in memory,
    // until this context ends or the small LRU evicts it. Never infer a file path
    // from tool output, store bytes in drafts/storage, or fetch on history render.
    var localUploadPreviews = new Map();
    var localUploadPreviewBytes = 0;
    var localUploadPreviewEpoch = 0;
    var localUploadKeyCheck = 0;
    var MAX_LOCAL_UPLOAD_PREVIEWS = 4;
    var MAX_LOCAL_UPLOAD_PREVIEW_BYTES = 20 * 1024 * 1024;
    var officialImagePending = new Map();
    var officialImageEpoch = 0;
    function officialImageAttachment(attachment) {
      return attachment && attachment.kind === 'image' &&
        typeof attachment.id === 'string' && /^sha256:[a-f0-9]{64}$/.test(attachment.id) &&
        typeof adapter.downloadImageAttachment === 'function';
    }
    function officialImageKey(attachment) {
      return '\nimage-attachment\n' + JSON.stringify([state.sessionId, 'image', attachment.id]);
    }
    async function cacheOfficialImage(attachment) {
      if (!state.sessionId || !officialImageAttachment(attachment)) return false;
      var sessionId = state.sessionId, contextVersion = state.contextVersion, epoch = officialImageEpoch;
      var key = officialImageKey(attachment);
      var cached = state.downloadUrls.get(key);
      if (cached) return cached;
      var pending = officialImagePending.get(key);
      if (pending) return pending.promise;
      if (officialImagePending.size >= 3) throw { userMessage: t('已有三张图片正在读取，请稍后重试。') };
      var controller = new AbortController();
      var request = { controller: controller, promise: null };
      request.promise = (async function () {
        var keyIdentity = await localPreviewKeyIdentity();
        if (keyIdentity === null || epoch !== officialImageEpoch || state.disposed ||
            state.sessionId !== sessionId || state.contextVersion !== contextVersion) return false;
        var result = await adapter.downloadImageAttachment({ sessionId: sessionId,
          attachmentId: attachment.id, signal: controller.signal });
        if (!result || !result.blob || result.sessionId !== sessionId || result.attachmentId !== attachment.id ||
            !Number.isSafeInteger(result.blob.size) || !result.blob.size || result.blob.size > 8 * 1024 * 1024 ||
            !/^image\/(png|jpeg|webp|gif)$/.test(String(result.blob.type || ''))) throw { userMessage: t('图片格式不受支持。') };
        var currentKey = await localPreviewKeyIdentity();
        if (epoch !== officialImageEpoch || state.disposed || state.sessionId !== sessionId ||
            state.contextVersion !== contextVersion || currentKey !== keyIdentity) return false;
        if (state.downloadUrls.size >= 3) {
          var first = state.downloadUrls.keys().next().value;
          URL.revokeObjectURL(state.downloadUrls.get(first).url); state.downloadUrls.delete(first);
        }
        var entry = { url: URL.createObjectURL(result.blob), name: label(attachment.name, t('图片')),
          keyIdentity: keyIdentity, kind: 'official-image' };
        state.downloadUrls.set(key, entry);
        return entry;
      })().finally(function () { if (officialImagePending.get(key) === request) officialImagePending.delete(key); });
      officialImagePending.set(key, request);
      return request.promise;
    }
    async function downloadOfficialImage(attachment, button) {
      var sessionId = state.sessionId, contextVersion = state.contextVersion;
      button.disabled = true; button.textContent = t('正在读取…');
      try {
        if (!await cacheOfficialImage(attachment)) return;
        if (button.isConnected && state.sessionId === sessionId && state.contextVersion === contextVersion) {
          renderRecords(); clearError();
        }
      } catch (error) {
        if (button.isConnected && state.sessionId === sessionId && state.contextVersion === contextVersion) {
          button.disabled = false; button.textContent = t('↓ 重试下载');
          showError({ userMessage: t(safeError(error, '读取文件失败，请重试。')) }, '读取文件失败，请重试。');
        }
      }
    }
    function validPreviewId(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
        !/[\u0000-\u0020\u007f]/.test(value);
    }
    function localImageAttachment(attachment) {
      var type = String(attachment.mimeType || '').toLowerCase();
      return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(attachment.name || '')) &&
        (!type || type === 'application/octet-stream' || /^(image\/(?:png|jpeg|webp|gif|bmp|avif))$/.test(type));
    }
    function localUploadPreview(attachment) {
      var id = attachment && attachment.id;
      var entry = validPreviewId(id) && localUploadPreviews.get(id);
      if (!entry || entry.sessionId !== state.sessionId || entry.projectId !== state.projectId ||
          entry.contextVersion !== state.contextVersion || entry.name !== attachment.name ||
          (attachment.size != null && attachment.size !== entry.file.size) || !localImageAttachment(attachment)) return null;
      return entry;
    }
    function removeLocalUploadPreview(id) {
      var entry = localUploadPreviews.get(id);
      if (!entry) return;
      if (entry.url) URL.revokeObjectURL(entry.url);
      localUploadPreviewBytes -= entry.file.size;
      // Removed DOM handlers can briefly retain the entry object. Drop its File
      // too, so cache eviction/teardown cannot retain original bytes indirectly.
      entry.file = null; entry.url = '';
      localUploadPreviews.delete(id);
    }
    function clearLocalUploadPreviews(repaint) {
      localUploadPreviewEpoch++;
      localUploadKeyCheck++;
      localUploadPreviews.forEach(function (entry) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        entry.file = null; entry.url = '';
      });
      var hadEntries = localUploadPreviews.size > 0;
      localUploadPreviews.clear();
      localUploadPreviewBytes = 0;
      if (repaint && hadEntries && !state.disposed) renderRecords();
    }
    async function localPreviewKeyIdentity() {
      var secret = window.__dshE2eeSecret;
      if (typeof secret !== 'string' || !secret) return '';
      if (secret.length > 1024) return null;
      if (!window.crypto || !crypto.subtle || typeof TextEncoder !== 'function') return null;
      // Only an opaque digest is retained. No key, File, or blob URL enters
      // localStorage, sessionStorage, saved drafts, or diagnostic state.
      var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
      return Array.from(new Uint8Array(hash), function (n) { return n.toString(16).padStart(2, '0'); }).join('');
    }
    function checkLocalUploadPreviewKey() {
      if (!localUploadPreviews || (!localUploadPreviews.size && !Array.from(state.downloadUrls.values()).some(function (entry) {
        return entry.kind === 'official-image';
      }))) return;
      var check = ++localUploadKeyCheck;
      localPreviewKeyIdentity().then(function (identity) {
        if (check !== localUploadKeyCheck || state.disposed) return;
        if (identity === null || Array.from(localUploadPreviews.values()).some(function (entry) {
          return entry.keyIdentity !== identity;
        }) || Array.from(state.downloadUrls.values()).some(function (entry) {
          return entry.kind === 'official-image' && entry.keyIdentity !== identity;
        })) { clearDownloadUrls(); renderRecords(); }
      }).catch(function () { if (check === localUploadKeyCheck) { clearDownloadUrls(); renderRecords(); } });
    }
    async function retainLocalUploadPreview(file, result, scope, keyIdentity) {
      var metadata = result && result.file;
      if (!(file instanceof File) || !metadata || !validPreviewId(result.receiptId) ||
          !validPreviewId(metadata.attachmentId) || metadata.name !== file.name || metadata.bytes !== file.size ||
          !file.size || file.size > MAX_LOCAL_UPLOAD_PREVIEW_BYTES ||
          !localImageAttachment({ name: file.name, mimeType: file.type }) || keyIdentity === null) return;
      var head;
      try { head = new Uint8Array(await file.slice(0, 16).arrayBuffer()); } catch (_) { return; }
      var ascii = function (start, text) { return Array.from(text).every(function (c, i) { return head[start + i] === c.charCodeAt(0); }); };
      if (!(head[0] === 137 && ascii(1, 'PNG\r\n\u001a\n') ||
          head[0] === 255 && head[1] === 216 && head[2] === 255 ||
          ascii(0, 'GIF87a') || ascii(0, 'GIF89a') ||
          ascii(0, 'RIFF') && ascii(8, 'WEBP') || ascii(0, 'BM') ||
          ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis')))) return;
      var currentKey = await localPreviewKeyIdentity().catch(function () { return null; });
      if (state.disposed || state.sessionId !== scope.sessionId || state.projectId !== scope.projectId ||
          state.contextVersion !== scope.contextVersion || localUploadPreviewEpoch !== scope.epoch ||
          currentKey !== keyIdentity) return;
      var id = metadata.attachmentId;
      // A repeated ID cannot replace an original File with an unproven new one.
      if (localUploadPreviews.has(id)) { removeLocalUploadPreview(id); renderRecords(); return; }
      while (localUploadPreviews.size >= MAX_LOCAL_UPLOAD_PREVIEWS ||
          localUploadPreviewBytes + file.size > MAX_LOCAL_UPLOAD_PREVIEW_BYTES) {
        removeLocalUploadPreview(localUploadPreviews.keys().next().value);
      }
      localUploadPreviews.set(id, { file: file, name: file.name, sessionId: scope.sessionId,
        projectId: scope.projectId, contextVersion: scope.contextVersion, keyIdentity: keyIdentity, url: '' });
      localUploadPreviewBytes += file.size;
      renderRecords();
    }
    function buildLocalUploadImage(attachment, name) {
      var entry = localUploadPreview(attachment);
      var figure = el('figure', 'record-image record-local-image');
      figure.dataset.localPreview = entry ? 'available' : 'unavailable';
      if (!entry) {
        figure.append(el('span', 'record-file record-file-label', name +
          (Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? ' · ' + attachment.size + ' B' : '')),
          el('small', 'record-status', t('这张图片没有可读取的电脑路径，当前手机也没有临时副本。')));
        return figure;
      }
      var holder = el('button', 'record-image-holder', t('点一下加载手机临时预览'));
      holder.type = 'button';
      holder.setAttribute('aria-label', t('加载图片') + ' ' + name);
      var image = el('img', 'record-image-img');
      image.alt = name; image.hidden = true; image.loading = 'lazy';
      var save = el('a', 'record-file', t('↓ 保存 ') + name);
      save.hidden = true; save.download = name;
      function display(url) {
        image.src = url; image.hidden = false; holder.hidden = true;
        save.href = url; save.hidden = false;
      }
      if (entry.url) display(entry.url);
      holder.addEventListener('click', async function () {
        if (holder.disabled || image.getAttribute('src')) return;
        holder.disabled = true;
        var epoch = localUploadPreviewEpoch;
        try {
          var identity = await localPreviewKeyIdentity();
          if (!holder.isConnected || state.disposed || epoch !== localUploadPreviewEpoch ||
              localUploadPreview(attachment) !== entry) return;
          if (identity === null || entry.keyIdentity !== identity) { clearDownloadUrls(); renderRecords(); return; }
          if (!entry.url) entry.url = URL.createObjectURL(entry.file);
          localUploadPreviews.delete(attachment.id);
          localUploadPreviews.set(attachment.id, entry);
          display(entry.url);
        } catch (_) { if (holder.isConnected) holder.textContent = t('临时图片无法显示，点这里重试'); }
        finally { if (holder.isConnected) holder.disabled = false; }
      });
      image.addEventListener('click', function () {
        if (localUploadPreview(attachment) === entry && image.getAttribute('src') === entry.url) {
          window.open(entry.url, '_blank', 'noopener');
        }
      });
      image.addEventListener('error', function () {
        var url = image.getAttribute('src');
        image.removeAttribute('src'); image.hidden = true;
        save.removeAttribute('href'); save.hidden = true;
        if (localUploadPreview(attachment) === entry && entry.url === url) {
          URL.revokeObjectURL(entry.url); entry.url = '';
        }
        holder.hidden = false; holder.disabled = false;
        holder.textContent = t('临时图片无法显示，点这里重试');
      });
      figure.append(holder, image, save, el('small', 'record-status',
        t('仅此手机临时预览；刷新、切换对话或缓存回收后不可用。')));
      return figure;
    }
    var MAX_TEXT_PREVIEW_BYTES = 64 * 1024;
    async function textPreview(blob, name) {
      var type = String(blob.type || '').split(';')[0].toLowerCase();
      if (!/^text\//.test(type) && !/^(application\/(?:json|xml|javascript)|image\/svg\+xml)$/.test(type) &&
          !/\.(txt|md|markdown|json|jsonl|log|csv|tsv|ya?ml|toml|ini|conf|config|xml|html?|css|[cm]?js|jsx|tsx?|py|sh|ps1|bat|sql|svg)$/i.test(name)) return null;
      // Decode only a bounded slice of the already requested download. File
      // contents are never used as HTML, a document URL, or executable code.
      var text = await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text();
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
      return { text: text, truncated: blob.size > MAX_TEXT_PREVIEW_BYTES };
    }
    function renderFilePreview() {
      var panel = document.getElementById('files-preview');
      if (!panel) {
        panel = el('section', 'files-text-preview');
        panel.id = 'files-preview';
        panel.setAttribute('role', 'region');
        panel.style.cssText = 'margin-top:12px;padding:10px;border:1px solid var(--line);border-radius:10px;min-width:0;';
        refs.filesStatus.before(panel);
      }
      panel.replaceChildren();
      panel.hidden = !state.filePreview;
      if (!state.filePreview) return;
      var entry = state.downloadUrls.get(state.filePreview);
      if (!entry) { state.filePreview = null; panel.hidden = true; return; }
      panel.setAttribute('aria-label', t('文本预览') + ' · ' + entry.name);
      var header = el('div', 'files-navigation');
      var title = el('strong', '', t('文本预览') + ' · ' + entry.name);
      title.style.cssText = 'min-width:0;flex:1;overflow-wrap:anywhere;';
      header.append(title);
      var close = el('button', '', t('关闭预览'));
      close.type = 'button';
      close.addEventListener('click', function () { state.filePreview = null; renderFilePreview(); });
      header.append(close);
      panel.append(header);
      if (!entry.preview) {
        panel.append(el('p', '', t('此文件不支持文本预览，可保存后打开。')));
        return;
      }
      if (entry.preview.truncated) panel.append(el('p', 'files-preview-note',
        t('仅预览前 64 KB，保存可下载完整文件。')));
      var content = el('pre', 'files-preview-text', entry.preview.text || t('空文本文件。'));
      content.tabIndex = 0;
      content.style.cssText = 'max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:13px;line-height:1.5;user-select:text;';
      panel.append(content);
    }
    function openFilePreview(path) {
      state.filePreview = path;
      renderFilePreview();
      var panel = document.getElementById('files-preview');
      if (panel && !panel.hidden) panel.scrollIntoView({ block: 'nearest' });
    }
    async function cacheDownload(path, name, sessionId) {
      var contextVersion = state.contextVersion;
      var cached = state.downloadUrls.get(path);
      if (cached && state.sessionId === sessionId) return cached;
      var result = await adapter.downloadFile({ sessionId: sessionId, path: path });
      if (!result || !result.blob || typeof result.blob.size !== 'number') throw new Error('download data missing');
      var fileName = label(result.name, name);
      var preview = null;
      try { preview = await textPreview(result.blob, fileName); } catch (_) { /* Download remains available if text decoding fails. */ }
      if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || state.disposed) return false;
      if (state.downloadUrls.size >= 3) {
        var first = state.downloadUrls.keys().next().value;
        URL.revokeObjectURL(state.downloadUrls.get(first).url);
        state.downloadUrls.delete(first);
      }
      state.downloadUrls.set(path, { url: URL.createObjectURL(result.blob), name: fileName, preview: preview });
      // ★ 把刚存下的那一条**返回出去**：图片预览要直接用它当 <img> 的地址。
      //   原来只返回 true，于是调用方还得再往 Map 里查一次（而且查的是"路径"，
      //   一不留神就把别人的图当自己的）。
      return state.downloadUrls.get(path);
    }
    async function downloadAttachment(attachment, button) {
      if (!attachment || typeof attachment.path !== 'string' || !attachment.path ||
          !state.sessionId || typeof adapter.downloadFile !== 'function') return;
      var sessionId = state.sessionId;
      button.disabled = true;
      button.textContent = t('正在读取…');
      try {
        if (!await cacheDownload(attachment.path, label(attachment.name, '文件'), sessionId)) return;
        renderRecords();
        clearError();
      } catch (error) {
        if (state.sessionId === sessionId) {
          button.disabled = false;
          button.textContent = t('↓ 重试下载');
          showError(error, '读取文件失败，请重试。');
        }
      }
    }
    function interactionDraftKey(item) {
      return safeId(item && item.sessionId) + '\n' + safeId(item && item.id);
    }
    function captureInteractionDrafts() {
      Array.prototype.forEach.call(refs.interactions.querySelectorAll('.interaction[data-draft-key]'), function (card) {
        var questions = Array.prototype.map.call(card.querySelectorAll('fieldset.question'), function (field) {
          return {
            selected: Array.prototype.map.call(field.querySelectorAll('input:checked'), function (input) { return input.value; }),
            custom: field.querySelector('.question-custom') ? field.querySelector('.question-custom').value : ''
          };
        });
        var reply = card.querySelector('.interaction-reply');
        if (!questions.length && !reply) return;
        state.interactionDrafts.set(card.dataset.draftKey, { questions: questions, reply: reply ? reply.value : '' });
      });
    }
    function appendInteractionText(host, value, expandedKey, className, compactSummary) {
      var detail = String(value);
      if (detail.length <= 320) {
        host.append(el('p', className, detail));
        return;
      }
      var disclosure = el('details', 'question-detail-more');
      disclosure.open = state.interactionExpanded.has(expandedKey);
      var excerpt = compactSummary ? '' : ' · ' + detail.replace(/\s+/g, ' ').trim().slice(0, 36) + '…';
      disclosure.append(el('summary', '', t('查看完整说明') + excerpt));
      disclosure.append(el('p', className, detail));
      disclosure.addEventListener('toggle', function () {
        if (disclosure.open) state.interactionExpanded.add(expandedKey);
        else state.interactionExpanded.delete(expandedKey);
      });
      host.append(disclosure);
    }
    function renderInteractions() {
      // DSH can repeat an interaction event while a person is typing. Capture
      // the current DOM before rebuilding so answers survive updates and retries.
      captureInteractionDrafts();
      var focused = document.activeElement;
      var focusedCard = focused && focused.closest ? focused.closest('.interaction[data-draft-key]') : null;
      var focusHint = null;
      if (focusedCard) {
        var focusedQuestion = focused.closest('fieldset.question');
        var caret = null;
        try { if (typeof focused.selectionStart === 'number') caret = focused.selectionStart; }
        catch (err) { /* radio and checkbox inputs have no caret */ }
        focusHint = { key: focusedCard.dataset.draftKey,
          question: focusedQuestion ? Array.prototype.indexOf.call(focusedCard.querySelectorAll('fieldset.question'), focusedQuestion) : -1,
          kind: focused.classList.contains('question-custom') ? 'custom' :
            focused.classList.contains('interaction-reply') ? 'reply' : focused.tagName === 'INPUT' ? 'input' : '',
          value: focused.value, caret: caret };
      }
      refs.interactions.replaceChildren();
      refs.interactionNote.hidden = canReply();
      state.interactions.forEach(function (item) {
        if (!item || safeId(item.sessionId) !== state.sessionId) return;
        var card = el('article', 'interaction');
        var draftKey = interactionDraftKey(item);
        var draft = state.interactionDrafts.get(draftKey);
        card.dataset.draftKey = draftKey;
        // ★ 标题在这里拼，不在 adapter 里拼 —— adapter 是数据层，没有 t()。
        //   （它原来写死了 `'DSH 请求授权：' + toolName`，切英文后还是中文。）
        var interactionTitle = item.kind === 'approval'
          ? (item.toolName ? t('DSH 请求授权：') + item.toolName : t('需要授权'))
          : item.kind === 'choice' ? t('请选择') : t('需要回答');
        card.append(el('h2', '', label(item.title, interactionTitle)));
        appendInteractionText(card, label(item.text, t('DSH 正在等待你的回复。')),
          draftKey + '\nitem', 'interaction-detail', item.kind === 'question');
        var questions = item.kind === 'question' && Array.isArray(item.questions) ? item.questions : [];
        questions.forEach(function (question, index) {
          var fieldset = el('fieldset', 'question');
          fieldset.dataset.questionId = safeId(question && question.id);
          fieldset.append(el('legend', '', label(question && question.question, '问题 ' + (index + 1))));
          if (question && question.detail)
            appendInteractionText(fieldset, question.detail, draftKey + '\nquestion:' + index,
              'question-detail', true);
          var options = question && Array.isArray(question.options) ? question.options : [];
          options.forEach(function (option) {
            if (!option || !label(option.label, '')) return;
            var row = el('label', 'question-option');
            if (canReply()) {
              var input = el('input');
              input.type = question.multiSelect ? 'checkbox' : 'radio';
              input.name = 'dsh-question-' + safeId(item.id) + '-' + index;
              input.value = option.label;
              input.checked = !!(draft && draft.questions && draft.questions[index] &&
                draft.questions[index].selected.indexOf(option.label) >= 0);
              row.append(input);
            }
            var words = el('span');
            words.append(el('strong', '', option.label));
            if (option.description) words.append(el('small', '', option.description));
            row.append(words);
            fieldset.append(row);
          });
          if (canReply()) {
            var custom = el('textarea', 'question-custom');
            custom.rows = 2;
            custom.placeholder = options.length ? '补充或自定义回答（可选）' : '输入回答';
            custom.setAttribute('aria-label', '问题 ' + (index + 1) + ' 的自定义回答');
            custom.value = draft && draft.questions && draft.questions[index] ? draft.questions[index].custom : '';
            fieldset.append(custom);
          }
          card.append(fieldset);
        });
        if (!canReply()) {
          card.append(el('p', '', t('当前连接无法从手机回复，请在电脑端处理。')));
          refs.interactions.append(card);
          return;
        }
        var actions = el('div', 'interaction-actions');
        function action(caption, answer) {
          var button = el('button', '', caption);
          button.type = 'button';
          button.addEventListener('click', function () { respond(item, answer, card); });
          actions.append(button);
        }
        if (item.kind === 'approval') {
          action('允许', { type: 'approve' });
          action('拒绝', { type: 'reject' });
        } else if (item.kind === 'choice' && Array.isArray(item.options)) {
          item.options.forEach(function (option) {
            if (!safeId(option && option.id)) return;
            action(label(option.label, '选项'), { type: 'choice', optionId: safeId(option.id) });
          });
        } else if (item.kind === 'question' && questions.length) {
          var submitAll = el('button', '', '提交全部回答');
          submitAll.type = 'button';
          submitAll.addEventListener('click', function () {
            var answers = [];
            var fields = card.querySelectorAll('fieldset.question');
            for (var i = 0; i < fields.length; i++) {
              var fieldset = fields[i];
              var id = fieldset.dataset.questionId;
              var selected = Array.from(fieldset.querySelectorAll('input:checked')).map(function (input) { return input.value; });
              var customField = fieldset.querySelector('textarea.question-custom');
              var custom = customField ? customField.value.trim() : '';
              if (!id || (!selected.length && !custom)) {
                showError(null, '请先回答每一个问题，再一起提交。');
                if (customField) customField.focus();
                return;
              }
              var answer = { id: id, selected: selected };
              if (custom) answer.custom = custom;
              answers.push(answer);
            }
            respond(item, { type: 'answers', answers: answers }, card);
          });
          actions.append(submitAll);
        } else {
          var field = el('textarea', 'interaction-reply');
          field.rows = 3;
          field.setAttribute('aria-label', '回复');
          field.value = draft ? draft.reply : '';
          card.append(field);
          var submit = el('button', '', '提交回答');
          submit.type = 'button';
          submit.addEventListener('click', function () {
            if (field.value.trim()) respond(item, { type: 'text', text: field.value.trim() }, card);
          });
          actions.append(submit);
        }
        card.append(actions);
        refs.interactions.append(card);
      });
      refs.interactions.classList.toggle('has-questions', !!refs.interactions.querySelector('.question'));
      if (focusHint && focusHint.kind) {
        var card = Array.prototype.find.call(refs.interactions.querySelectorAll('.interaction[data-draft-key]'),
          function (node) { return node.dataset.draftKey === focusHint.key; });
        var field = card && focusHint.question >= 0 ? card.querySelectorAll('fieldset.question')[focusHint.question] : null;
        var target = focusHint.kind === 'reply' ? card && card.querySelector('.interaction-reply') :
          focusHint.kind === 'custom' ? field && field.querySelector('.question-custom') :
            field && Array.prototype.find.call(field.querySelectorAll('input'), function (input) { return input.value === focusHint.value; });
        if (target) {
          target.focus();
          if (focusHint.caret !== null && typeof target.setSelectionRange === 'function') {
            try { target.setSelectionRange(focusHint.caret, focusHint.caret); } catch (err) { /* radio */ }
          }
        }
      }
    }
    async function respond(item, answer, card) {
      if (state.connection !== 'connected' || !canReply() || !item || !safeId(item.id)) return;
      card.querySelectorAll('button,input,textarea').forEach(function (control) { control.disabled = true; });
      try {
        await adapter.respondToInteraction({ id: safeId(item.id), answer: answer });
        state.interactions.delete(safeId(item.id));
        state.interactionDrafts.delete(interactionDraftKey(item));
        Array.from(state.interactionExpanded).forEach(function (key) {
          if (key.indexOf(interactionDraftKey(item) + '\n') === 0) state.interactionExpanded.delete(key);
        });
        card.remove();
        renderInteractions();
        clearError();
      } catch (error) {
        card.querySelectorAll('button,input,textarea').forEach(function (control) { control.disabled = false; });
        showError(error, '提交回复失败，请重试。');
      }
    }
    function handleEvent(event) {
      if (state.disposed || !event || typeof event.type !== 'string') return;
      if (event.type === 'status') {
        if (event.state === 'connected' || event.state === 'connecting' || event.state === 'disconnected') setStatus(event.state);
        if (event.state === 'disconnected') showError(event, '与电脑的连接已断开，请重连。', 'connection');
        else if (event.state === 'connected' && refs.error.dataset.kind === 'connection') clearError();
      } else if (event.type === 'projects' && Array.isArray(event.projects)) {
        state.projects = event.projects;
        renderProjects(); renderTitle();
      } else if (event.type === 'sessions' && safeId(event.projectId) === state.projectId && Array.isArray(event.sessions)) {
        state.sessions = event.sessions;
        renderSessions(); renderTitle();
        reconcilePendingCreate();
      } else if (event.type === 'records' && safeId(event.sessionId) === state.sessionId) {
        if (typeof event.running === 'boolean') {
          state.runningKnown = event.running;
          state.running = event.running;
          if (!state.running) state.stopping = false;
          renderControls();
        }
        if (typeof event.hasMore === 'boolean') { state.hasMore = event.hasMore; renderControls(); }
        if (state.loadingSession === state.sessionId) state.pendingRecords.push.apply(state.pendingRecords, event.records || []);
        else mergeRecords(event.records, [], state.loadingOlder);
      } else if (event.type === 'record' && safeId(event.sessionId) === state.sessionId) {
        if (state.loadingSession === state.sessionId) state.pendingRecords.push(event.record);
        else upsertRecord(event.record);
      } else if (event.type === 'session-title' && safeId(event.sessionId)) {
        var session = state.sessions.find(function (value) { return safeId(value.id) === safeId(event.sessionId); });
        if (session && typeof event.title === 'string') {
          session.title = event.title;
          renderSessions(); renderTitle();
        }
      } else if (event.type === 'session-status' && safeId(event.sessionId) === state.sessionId) {
        state.runningKnown = event.running === true;
        state.running = event.running === true;
        if (!state.running) state.stopping = false;
        renderControls();
        // 任务开始/结束时队列一定会变（开始时原来那条被取走、结束时全部发出），
        // 这两个时刻各刷一次 —— 比等轮询快得多。
        refreshQueue();
        // 目标的阶段也会跟着动（active → complete / blocked），一起刷
        refreshGoal();
      } else if (event.type === 'interaction' && event.interaction && safeId(event.interaction.id)) {
        var previousInteraction = state.interactions.get(safeId(event.interaction.id));
        if (previousInteraction && JSON.stringify(previousInteraction) === JSON.stringify(event.interaction)) return;
        state.interactions.set(safeId(event.interaction.id), event.interaction);
        renderInteractions();
      } else if (event.type === 'interaction-resolved') {
        var resolved = state.interactions.get(safeId(event.id));
        if (resolved) state.interactionDrafts.delete(interactionDraftKey(resolved));
        if (resolved) Array.from(state.interactionExpanded).forEach(function (key) {
          if (key.indexOf(interactionDraftKey(resolved) + '\n') === 0) state.interactionExpanded.delete(key);
        });
        state.interactions.delete(safeId(event.id));
        Array.prototype.forEach.call(refs.interactions.querySelectorAll('.interaction[data-draft-key]'), function (card) {
          if (resolved && card.dataset.draftKey === interactionDraftKey(resolved)) card.remove();
        });
        renderInteractions();
      } else if (event.type === 'error') {
        showError(event, t('DSH 请求失败，请重试。'));
      }
    }
    // ── 「回来时接着看刚才那段对话」──────────────────────────────────────────
    //
    // 使用者反馈过两次：「有些时候还是得重新选择项目，就是强制跳转到选择项目上」。
    // 根因不只在项目上 —— **对话根本没有被恢复过**：
    //   · 启动时 `state.sessionId` 确实从 localStorage 读了回来；
    //   · 但紧接着 `reloadProjects()` 会调 `selectProject()`，
    //     而它第一件事就是把 `state.sessionId` 清成 ''（切项目本来就该清）；
    //   · 之后再没有任何一处把记住的那个 id 用回去。
    // 于是哪怕项目选对了，看到的也永远是「选择一个对话」的空页面 ——
    // 使用者眼里就是"被强制跳回选择页"。
    //
    // 这里把顺序理顺：**项目列表回来之后再恢复对话**，而且只做一次
    // （使用者后来自己换了对话，不该被下一次重连再拽回去）。
    function scheduleSessionRestore() {
      var wanted = recall('session');
      if (!wanted) return;
      state.restoreSession = wanted;
    }
    function restoreSessionIfPossible() {
      var wanted = state.restoreSession;
      if (!wanted || !state.projectId) return false;
      state.restoreSession = '';
      var exists = state.sessions.some(function (s) { return safeId(s.id) === wanted; });
      if (!exists) {
        // 对话被删了（或者换了项目）→ 把记录也清掉，免得每次打开都白找一遍。
        // 只清对话那条：项目还记着，下次打开直接落在同一个项目上。
        remember('session', '');
        return false;
      }
      // ★ 先写回 `state.sessionId` 再加载。为什么不能只调 selectSession：
      //   `selectSession` 是异步的，而它一开始就会把 `state.sessionId` 设成新值 ——
      //   这没错，但如果中间有任何一处读 `state.sessionId`（重连、渲染控件），
      //   读到的会是"还没选"的旧值，表现就是按钮又灰掉一次。
      state.sessionId = wanted;
      selectSession(wanted, 'restore');
      return true;
    }
    function reconcilePendingCreate() {
      if (state.creating || state.disposed || !state.projectId) return false;
      var pending = pendingCreate();
      if (!pending || pending.projectId !== state.projectId) return false;
      if (app.dataset.liteCreate === 'idle') createStage('pending-from-remount');
      var known = new Set(pending.knownIds.map(safeId));
      var added = state.sessions.filter(function (session) {
        var id = safeId(session && session.id);
        return id && !known.has(id);
      });
      var id = added.length === 1 ? safeId(added[0].id) :
        added.length > 1 && added.some(function (row) { return safeId(row.id) === pending.returnedId; })
          ? pending.returnedId : '';
      if (id) {
        clearPendingCreate(state.projectId);
        state.restoreSession = '';
        createStage('recovered-new');
        if (state.sessionId !== id) selectSession(id, 'create-recovery');
        return true;
      }
      if (added.length > 1) {
        clearPendingCreate(state.projectId);
        createStage('ambiguous');
        showError(null, '检测到多个新对话，请从列表中选择刚创建的一条。');
        return true;
      }
      return false;
    }
    function stateAfterProjectLoad() {
      if (state.disposed) return false;
      if (state.sessionId) {
        // 重连时要把**当前**这段对话重新拉一遍：DSH 只在状态变化时广播，
        // 断线期间发生的事不会有补发，不重载就会停在一份过期快照上。
        selectSession(state.sessionId, 'project-refresh');
        return true;
      }
      return restoreSessionIfPossible();
    }
    async function reloadProjects() {
      state.loadingProjects = true;
      state.projectsError = '';
      renderProjects(); renderControls();
      var projects;
      try {
        projects = await adapter.listProjects();
      } catch (error) {
        // ★ 项目列表读不到**不等于连接失败**（C11 的另一半）。
        //
        //   原来这里的异常会一路抛到 connect() 的 catch，于是界面显示
        //   「连接 DSH 失败」并把状态打成"已断开" —— 两处都误导：
        //   连接可能好好的，只是这一次列表没拿到，重试一下就行。
        //   更糟的是 renderProjects 会把空列表显示成「还没有项目。点击"添加项目"」，
        //   使用者以为项目全没了（这就是他说的「有些时候还是跳回选择项目」的感觉）。
        //   现在记下来，由 renderProjects 明说 + 给一个重试按钮。
        state.loadingProjects = false;
        state.projectsError = safeError(error, t('读不到项目列表，请重试。'));
        renderProjects(); renderControls();
        return;
      }
      state.loadingProjects = false;
      if (!Array.isArray(projects)) {
        state.projectsError = t('电脑报回来的项目列表格式不对。');
        renderProjects(); renderControls();
        return;
      }
      state.projects = projects;
      renderProjects();
      // 项目还在就留着（不该因为"列表回来了"就把使用者踢回选择页）；
      // 项目真的没了才退回第一个，并把记忆清掉 —— **别一直记着一个不存在的 id**。
      var remembered = state.projectId;
      var preferred = remembered && projects.some(function (p) { return safeId(p.id) === remembered; }) ? remembered : safeId(projects[0] && projects[0].id);
      if (remembered && preferred !== remembered) remember('project', '');
      await selectProject(preferred);
    }
    async function selectProject(id) {
      clearDownloadUrls();
      refs.filesModal.hidden = true;
      state.filesLoad++;
      saveCurrentDraft();
      var nextProjectId = safeId(id);
      var switchingProjects = state.projectId !== nextProjectId;
      state.projectId = nextProjectId;
      // A late reload of the *same* project must keep a conversation selected
      // while the list refreshes. Clearing it here let startup restoration
      // replace a just-created conversation with yesterday's saved one.
      if (switchingProjects) {
        state.sessionId = '';
        // A same-document remount does not fire pagehide. Persist the choice
        // now, so a delayed component reload cannot restore the old project.
        remember('project', state.projectId);
        remember('session', '');
      }
      state.sessionLoad++;
      state.sessions = [];
      state.records = [];
      restoreDraft('', '');
      resetSessionExtras();
      state.hasMore = false; state.running = false; state.runningKnown = null; state.stopping = false;
      state.interactions.clear();
      state.loadingSession = '';
      state.loadingSessions = !!state.projectId;
      state.projectLoad++;
      var token = state.projectLoad;
      renderProjects(); renderSessions(); renderTitle(); renderRecords(); renderInteractions(); renderControls();
      if (!state.projectId) return true;
      try {
        var sessions = await adapter.listSessions(state.projectId);
        if (token !== state.projectLoad || state.disposed) return false;
        if (!Array.isArray(sessions)) throw new Error('invalid session list');
        state.sessions = sessions;
        state.sessionsError = '';
        state.loadingSessions = false;
        renderSessions(); renderTitle(); renderControls();
        clearError();
        // 列表到手之后再决定"要不要接着看刚才那段对话" —— 在这之前
        // 我们既不知道该对话还在不在，也不该先把界面切走。
        if (!reconcilePendingCreate()) stateAfterProjectLoad();
        return true;
      } catch (error) {
        if (token === state.projectLoad) {
          state.loadingSessions = false;
          // ★ 同项目列表那个道理：记下原因让 renderSessions 明说，
          //   而不是画一个空列表让使用者以为"这个项目里没有对话"。
          state.sessionsError = safeError(error, t('读不到对话列表，请重试。'));
          renderSessions(); renderControls();
          showError(error, '加载对话列表失败，请重连后重试。');
        }
        return false;
      }
    }
    async function selectSession(id, source) {
      clearDownloadUrls();
      refs.filesModal.hidden = true;
      state.filesLoad++;
      saveCurrentDraft();
      state.sessionId = safeId(id);
      // No ID or conversation text is exposed. This fixed vocabulary helps
      // diagnose a late restore overriding a just-created conversation.
      app.dataset.liteSelect = source || 'internal';
      // The adapter/router may remount while this conversation is still
      // loading. pagehide never fires in that case, so keeping the previous
      // stored ID until tab close would silently jump back to the old chat.
      remember('project', state.projectId);
      remember('session', state.sessionId);
      state.records = [];
      restoreDraft(state.projectId, state.sessionId);
      resetSessionExtras();
      state.hasMore = false; state.running = false; state.runningKnown = null; state.stopping = false;
      state.loadingSession = state.sessionId;
      state.pendingRecords = [];
      // 换会话时把排队消息的编辑草稿丢掉 —— 它属于上一个会话。
      state.queueEditing = null;
      var token = ++state.sessionLoad;
      renderSessions(); renderTitle(); renderRecords(); renderInteractions(); renderControls();
      if (!state.sessionId) return true;
      document.body.classList.add('sidebar-hidden');
      refs.projectsToggle.setAttribute('aria-expanded', 'false');
      try {
        var result = await adapter.loadSession(state.sessionId);
        if (token !== state.sessionLoad || state.disposed) return;
        mergeRecords(result && result.records, state.pendingRecords);
        if (result && typeof result.hasMore === 'boolean') state.hasMore = result.hasMore;
        renderControls();
        state.pendingRecords = [];
        state.loadingSession = '';
        // An empty snapshot rendered above while loadingSession was still set.
        // Refresh the empty state now so a newly created conversation does not
        // remain stuck on “正在加载对话内容…” after loading has finished.
        renderEmpty();
        if (result && Array.isArray(result.interactions)) {
          result.interactions.forEach(function (item) { if (safeId(item && item.id)) state.interactions.set(safeId(item.id), item); });
          renderInteractions();
        }
        // 打开一段对话时顺带把排队消息读出来：DSH 只在状态**变化时**广播，
        // 刷新之后那批"已经排在那儿的"消息不会有补发。
        refreshQueue();
        refreshGoal();
        refreshSelection();
        clearError();
        return true;
      } catch (error) {
        if (token === state.sessionLoad) {
          state.loadingSession = '';
          renderEmpty();
          showError(error, '加载对话内容失败，请重连后重试。');
        }
        return false;
      }
    }
    async function connect() {
      closeSettingsMenu();
      clearDownloadUrls(); renderRecords();
      var token = ++state.connecting;
      setStatus('connecting'); clearError();
      try {
        if (typeof adapter.disconnect === 'function') await adapter.disconnect();
        await adapter.connect(function (event) { if (token === state.connecting) handleEvent(event); });
        if (token !== state.connecting || state.disposed) return;
        setStatus('connected');
        await reloadProjects();
      } catch (error) {
        if (token !== state.connecting || state.disposed) return;
        setStatus('disconnected');
        showError(error, '连接 DSH 失败。请确认电脑和隧道在线后重试。');
      }
    }
    async function createSession() {
      closeSettingsMenu();
      if (state.connection !== 'connected' || !state.projectId || state.creating) return;
      var projectId = state.projectId;
      var previousIds = new Set(state.sessions.map(function (session) { return safeId(session.id); }));
      var pending = { projectId: projectId, knownIds: Array.from(previousIds),
        returnedId: '', startedAt: Date.now() };
      savePendingCreate(pending);
      createStage('started');
      // A new user choice takes precedence over a still-pending startup
      // restore of the previously viewed conversation.
      state.restoreSession = '';
      state.creating = true; state.creatingKind = 'session'; renderControls();
      try {
        var created, createError = null;
        try { created = await adapter.createSession({ projectId: projectId }); }
        catch (error) { createError = error; }
        var returnedId = safeId(created && created.id);
        // The user may have switched projects while the tunnel was slow. The
        // new session belongs to the project captured at click time.
        if (state.projectId !== projectId || state.disposed) {
          createStage(state.disposed ? 'disposed' : 'project-changed'); return;
        }
        pending.returnedId = returnedId;
        savePendingCreate(pending);
        createStage(createError ? 'rpc-error' : 'rpc-ok');
        function additions(rows) {
          var seen = new Set();
          return rows.filter(function (session) {
            var id = safeId(session && session.id);
            if (!id || previousIds.has(id) || seen.has(id)) return false;
            seen.add(id); return true;
          });
        }
        async function refreshCreatedList() {
          var sessions;
          try { sessions = await adapter.listSessions(projectId); }
          catch (_) { sessions = null; }
          if (state.projectId !== projectId || state.disposed) return false;
          // A workspace/follow event can arrive *during* the list read. Take
          // the current rows only after awaiting, then keep any newly observed
          // ID missing from a stale snapshot. Sampling before the await lost
          // the event and left the old conversation selected.
          if (Array.isArray(sessions)) {
            var fetchedIds = new Set(sessions.map(function (row) { return safeId(row && row.id); }));
            state.sessions = additions(state.sessions).filter(function (row) {
              return !fetchedIds.has(safeId(row.id));
            }).concat(sessions);
          }
          renderSessions();
          return true;
        }
        if (!await refreshCreatedList()) return;
        var added = additions(state.sessions);
        function createdChoice(rows) {
          if (rows.length === 1) return safeId(rows[0].id);
          if (rows.length > 1) return rows.some(function (row) { return safeId(row.id) === returnedId; }) ? returnedId : '';
          return returnedId && !previousIds.has(returnedId) ? returnedId : '';
        }
        var id = createdChoice(added);
        // An HTTP response can be lost after the computer has created the
        // session. Give the workspace event/list a bounded chance to arrive
        // before claiming failure or tempting the user to create a duplicate.
        if (!id && !added.length) {
          for (var delays = [300, 700, 1500, 2500], i = 0; i < delays.length; i++) {
            await new Promise(function (resolve) { setTimeout(resolve, delays[i]); });
            if (state.projectId !== projectId || state.disposed) return;
            if (!await refreshCreatedList()) return;
            added = additions(state.sessions);
            if (added.length !== 0) {
              id = createdChoice(added);
              break;
            }
          }
        }
        if (!id) {
          createStage(added.length > 1 ? 'ambiguous' : 'unconfirmed');
          if (added.length > 1) clearPendingCreate(projectId);
          showError(null, added.length > 1 ?
            '检测到多个新对话，无法确认哪一个是刚创建的。请从列表中手动选择。' :
            createError ? '新建请求的结果未能确认。请检查对话列表，避免重复创建。' :
              '电脑返回的对话编号无法确认。请检查对话列表，避免重复创建。');
          return;
        }
        if (!state.sessions.some(function (s) { return safeId(s.id) === id; })) state.sessions.unshift({ id: id, title: '新对话' });
        renderSessions();
        clearPendingCreate(projectId);
        createStage('selected-new');
        if (await selectSession(id, 'create')) clearError();
      } catch (error) { if (state.projectId === projectId) showError(error, '新建请求未能完成，请检查对话列表后重试。'); }
      finally {
        state.creating = false; state.creatingKind = '';
        if (!state.disposed) {
          // A workspace event can arrive after our final list read but before
          // creating flips back to false. Its handler deliberately defers
          // reconciliation while creating; finish that deferred check here.
          reconcilePendingCreate();
          renderControls();
        }
      }
    }
    async function createProject(event) {
      event.preventDefault();
      var path = refs.projectPath.value.trim();
      if (!path || state.connection !== 'connected' || state.creating) return;
      var currentProjectId = state.projectId;
      state.creating = true; state.creatingKind = 'project';
      projectMessage('正在添加电脑上的项目…', false);
      renderControls();
      try {
        var created = await adapter.createProject({ path: path });
        var id = safeId(created && created.id);
        if (!id) throw new Error('project id missing');
        var projects;
        try { projects = await adapter.listProjects(); }
        catch (err) { projects = null; } // do not report a successful creation as failed
        if (Array.isArray(projects)) state.projects = projects;
        if (!state.projects.some(function (p) { return safeId(p.id) === id; })) state.projects.unshift({ id: id, name: path, path: path });
        renderProjects();
        if (refs.modal.hidden || state.projectId !== currentProjectId || state.disposed) return;
        refs.modal.hidden = true;
        refs.projectPath.value = '';
        projectMessage('', false);
        if (await selectProject(id)) clearError();
      } catch (error) {
        if (refs.modal.hidden) showError(error, '添加项目失败。请检查电脑上的文件夹路径。');
        else projectMessage(safeError(error, t('添加项目失败。请检查电脑上的文件夹路径。')), true);
      } finally { state.creating = false; state.creatingKind = ''; renderControls(); }
    }
    async function loadDirectory(path) {
      if (typeof adapter.listDirectories !== 'function') return;
      var token = ++state.folderLoad;
      projectMessage('', false);
      refs.folderBrowser.hidden = false;
      refs.folderBrowser.replaceChildren(el('div', 'list-empty', '正在读取电脑文件夹…'));
      try {
        var result = await adapter.listDirectories(path || undefined);
        if (token !== state.folderLoad || state.disposed) return;
        refs.folderBrowser.replaceChildren();
        if (result && typeof result.path === 'string' && result.path) refs.projectPath.value = result.path;
        function folderButton(item, prefix) {
          if (!item || typeof item.path !== 'string' || !item.path) return;
          var button = el('button', '', prefix + label(item.name, item.path));
          button.type = 'button';
          button.addEventListener('click', function () { loadDirectory(item.path); });
          refs.folderBrowser.append(button);
        }
        if (result && result.parent) folderButton({ name: '上一级', path: result.parent }, '↑ ');
        var roots = result && Array.isArray(result.roots) ? result.roots : [];
        if (!result.path) roots.forEach(function (item) { folderButton(item, '▣ '); });
        var directories = result && Array.isArray(result.directories) ? result.directories : [];
        directories.forEach(function (item) { folderButton(item, '▣ '); });
        if (!refs.folderBrowser.children.length) refs.folderBrowser.append(el('div', 'list-empty', '此处没有子文件夹。可直接选择当前文件夹。'));
        if (result && result.truncated) refs.folderBrowser.append(el('div', 'list-empty', '列表较长，仅显示部分文件夹。可手动输入完整路径。'));
        clearError();
      } catch (error) {
        if (token === state.folderLoad) {
          refs.folderBrowser.replaceChildren(el('div', 'list-empty', '读取文件夹失败，可直接输入完整路径。'));
          if (!refs.modal.hidden) projectMessage(safeError(error, t('读取电脑文件夹失败，请重试。')), true);
        }
      }
    }
    function renderFiles() {
      refs.filesCurrent.textContent = state.filesPath || t('项目根目录');
      refs.filesUp.disabled = !state.filesStack.length || state.filesLoading;
      refs.filesMore.hidden = state.filesNextOffset === null || !!state.filesRetry;
      refs.filesMore.disabled = state.filesLoading;
      refs.filesRetry.hidden = !state.filesRetry;
      refs.filesRetry.disabled = state.filesLoading;
      refs.filesList.replaceChildren();
      var filter = refs.filesFilter.value.trim().toLocaleLowerCase();
      var visibleEntries = state.filesEntries.filter(function (entry) {
        return !filter || label(entry && entry.name, entry && entry.path || '').toLocaleLowerCase().indexOf(filter) >= 0;
      });
      if (!visibleEntries.length) {
        refs.filesList.append(el('div', 'list-empty', state.filesLoading ? t('正在读取文件…') :
          state.filesRetry ? t('文件列表未加载。请点下方“重试读取”。') :
            filter && state.filesEntries.length ? t('当前列表没有匹配的文件。') : t('此文件夹没有文件。')));
      }
      visibleEntries.forEach(function (entry) {
        if (!entry || typeof entry.path !== 'string' || !entry.path) return;
        var name = label(entry.name, entry.path);
        if (entry.type === 'directory') {
          var folder = el('button', '', '▣ ' + name);
          folder.type = 'button';
          folder.addEventListener('click', async function () {
            var previous = state.filesPath;
            var sessionId = state.sessionId;
            state.filesStack.push(previous);
            var expected = state.filesLoad + 1;
            if (!await loadFiles(entry.path, false) && state.sessionId === sessionId &&
                state.filesLoad === expected && !refs.filesModal.hidden) { state.filesStack.pop(); renderFiles(); }
          });
          refs.filesList.append(folder);
        } else if (entry.type === 'file') {
          var cached = state.downloadUrls.get(entry.path);
          var file = el('button', '', cached ? t('预览') + ' · ' + name : '↓ ' + name);
          file.type = 'button';
          if (cached) {
            file.addEventListener('click', function () { openFilePreview(entry.path); });
          } else file.addEventListener('click', function () { readWorkspaceFile(entry, file); });
          refs.filesList.append(file);
          if (cached) {
            var save = el('a', '', t('↓ 保存 ') + name);
            save.href = cached.url; save.download = cached.name;
            refs.filesList.append(save);
          }
        }
      });
    }
    async function loadFiles(path, append) {
      if (!state.sessionId || typeof adapter.listWorkspaceFiles !== 'function') return false;
      if (append && state.filesNextOffset === null) return false;
      var sessionId = state.sessionId;
      var token = ++state.filesLoad;
      var offset = append ? state.filesNextOffset : 0;
      var previous = { path: state.filesPath, entries: state.filesEntries, nextOffset: state.filesNextOffset };
      state.filesLoading = true;
      state.filesRetry = null;
      if (!append) { state.filesEntries = []; state.filesNextOffset = null; }
      refs.filesStatus.textContent = t('正在读取电脑文件…');
      refs.filesStatus.dataset.state = 'success';
      renderFiles();
      try {
        var result = await adapter.listWorkspaceFiles({ sessionId: sessionId, path: path || '', offset: offset });
        if (token !== state.filesLoad || state.sessionId !== sessionId || state.disposed) return false;
        if (!result || !Array.isArray(result.entries) || typeof result.path !== 'string') throw new Error('invalid file list');
        state.filesPath = result.path;
        if (result.path !== previous.path) { refs.filesFilter.value = ''; state.filePreview = null; renderFilePreview(); }
        state.filesEntries = append ? state.filesEntries.concat(result.entries) : result.entries;
        state.filesNextOffset = Number.isSafeInteger(result.nextOffset) ? result.nextOffset : null;
        state.filesRetry = null;
        refs.filesStatus.textContent = '';
        refs.filesStatus.dataset.state = '';
        return true;
      } catch (error) {
        if (token === state.filesLoad) {
          if (!append) {
            state.filesPath = previous.path;
            state.filesEntries = previous.entries;
            state.filesNextOffset = previous.nextOffset;
          }
          state.filesRetry = { path: path || '', append: !!append };
          refs.filesStatus.textContent = safeError(error, t('读取电脑文件失败，请重试。'));
          refs.filesStatus.dataset.state = 'error';
        }
        return false;
      } finally {
        if (token === state.filesLoad) { state.filesLoading = false; renderFiles(); }
      }
    }
    async function readWorkspaceFile(entry, button) {
      if (!entry || typeof entry.path !== 'string' || !state.sessionId) return;
      var sessionId = state.sessionId;
      button.disabled = true;
      button.textContent = t('正在读取…');
      try {
        if (!await cacheDownload(entry.path, label(entry.name, '文件'), sessionId)) return;
        refs.filesStatus.textContent = t('文件已读取，请点“保存”下载到手机。');
        refs.filesStatus.dataset.state = 'success';
        renderFiles();
        openFilePreview(entry.path);
      } catch (error) {
        if (state.sessionId === sessionId) {
          refs.filesStatus.textContent = safeError(error, t('读取文件失败，请重试。'));
          refs.filesStatus.dataset.state = 'error';
          button.disabled = false;
          button.textContent = t('↓ 重试') + ' ' + label(entry.name, t('文件'));
        }
      }
    }
    async function send(event) {
      event.preventDefault();
      var submittedDraft = refs.input.value;
      var text = refs.input.value.trim();
      if ((!text && !state.uploads.length) || state.connection !== 'connected' || !state.sessionId || state.sending || state.uploading) return;
      var sessionId = state.sessionId;
      var projectId = state.projectId;
      var uploads = state.uploads.slice();
      saveCurrentDraft();
      state.sending = true; renderControls();
      try {
        await adapter.sendMessage({ sessionId: sessionId, text: text, attachments: uploads });
        // Sending may finish after more typing or a conversation switch. Clear
        // only this submission's unchanged text and exact attachment objects.
        var key = draftKey(projectId, sessionId);
        if (state.projectId === projectId && state.sessionId === sessionId) {
          if (refs.input.value === submittedDraft) refs.input.value = '';
          state.uploads = state.uploads.filter(function (upload) { return uploads.indexOf(upload) < 0; });
          saveCurrentDraft();
          renderUploads();
        } else {
          var saved = state.drafts.get(key);
          if (saved) {
            var remaining = { text: saved.text === submittedDraft ? '' : saved.text,
              uploads: saved.uploads.filter(function (upload) { return uploads.indexOf(upload) < 0; }) };
            if (remaining.text || remaining.uploads.length) state.drafts.set(key, remaining);
            else state.drafts.delete(key);
          }
        }
        clearError();
      } catch (error) {
        if (state.sessionId === sessionId) showError(error, '发送失败，文字已保留，请重试。');
      }
      finally { state.sending = false; renderControls(); }
    }
    async function loadOlder() {
      if (!state.sessionId || !state.hasMore || state.loadingOlder || typeof adapter.loadOlder !== 'function') return;
      var sessionId = state.sessionId;
      state.loadingOlder = true; renderControls();
      try {
        var page = await adapter.loadOlder(sessionId);
        if (state.sessionId === sessionId && page && typeof page.hasMore === 'boolean') state.hasMore = page.hasMore;
        clearError();
      } catch (error) { showError(error, '加载更早内容失败，请重试。'); }
      finally { state.loadingOlder = false; renderControls(); }
    }
    async function stopSession() {
      if (!state.sessionId || !state.running || state.stopping || typeof adapter.cancelSession !== 'function') return;
      var sessionId = state.sessionId;
      state.stopping = true; renderControls();
      try {
        await adapter.cancelSession(sessionId);
        clearError();
        // The command was accepted; turn/end confirms it actually stopped.
      } catch (error) {
        if (state.sessionId === sessionId) state.stopping = false;
        showError(error, '停止请求失败，请重试。');
      }
      renderControls();
    }
    function renderUploads() {
      refs.attachmentList.replaceChildren();
      state.uploads.forEach(function (upload, index) {
        var chip = el('span', 'attachment-chip');
        chip.append(el('span', '', label(upload.file && upload.file.name, t('文件')) + ' · ' + t('待发送')));
        var remove = el('button', '', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', t('移除附件') + ' ' + label(upload.file && upload.file.name, t('文件')));
        remove.addEventListener('click', function () {
          state.uploads.splice(index, 1);
          saveCurrentDraft();
          renderUploads(); renderControls();
        });
        chip.append(remove);
        refs.attachmentList.append(chip);
      });
    }
    async function uploadFiles() {
      var files = Array.from(refs.uploadInput.files || []);
      refs.uploadInput.value = '';
      if (!files.length || state.uploading || typeof adapter.uploadFile !== 'function' || !state.sessionId) return;
      if (files.some(function (file) { return file.size > 20 * 1024 * 1024; })) {
        showError(null, '文件超过 20 MB，未上传。');
        return;
      }
      if (files.some(function (file) { return file.size === 0; })) {
        showError(null, '空文件无法上传。');
        return;
      }
      var sessionId = state.sessionId;
      var projectId = state.projectId;
      var previewScope = { sessionId: sessionId, projectId: projectId,
        contextVersion: state.contextVersion, epoch: localUploadPreviewEpoch };
      var previewKey = localPreviewKeyIdentity().catch(function () { return null; });
      state.uploading = true; renderControls();
      try {
        for (var i = 0; i < files.length; i++) {
          var result = await adapter.uploadFile({ sessionId: sessionId, file: files[i] });
          if (!result || !safeId(result.receiptId)) throw new Error('upload receipt missing');
          var receipt = { receiptId: safeId(result.receiptId), file: result.file || { name: files[i].name } };
          if (state.sessionId !== sessionId || state.projectId !== projectId || state.disposed) {
            var key = draftKey(projectId, sessionId);
            var oldDraft = state.drafts.get(key) || { text: '', uploads: [] };
            oldDraft.uploads.push(receipt);
            state.drafts.set(key, oldDraft);
          } else {
            state.uploads.push(receipt);
            saveCurrentDraft();
            renderUploads();
            await retainLocalUploadPreview(files[i], result, previewScope, await previewKey);
          }
        }
        clearError();
      } catch (error) { showError(error, '上传失败，请检查文件后重试。已上传的文件仍待发送。'); }
      finally { state.uploading = false; renderControls(); }
    }
    listen(refs.reconnect, 'click', connect);
    listen(refs.railReconnect, 'click', connect);
    listen(refs.retry, 'click', connect);
    listen(refs.projectsToggle, 'click', function () {
      setSidebar(document.body.classList.contains('sidebar-hidden'));
    });
    listen(refs.railActivity, 'click', function () {
      closeSettingsMenu();
      if (!state.sessionId) { setSidebar(true); return; }
      setTab('activity');
      setSidebar(false);
    });
    // ── 看电脑屏幕 ────────────────────────────────────────────────────────────
    //
    // 用途：人不在电脑前时，用手机看一眼电脑现在什么样 —— 哪个窗口弹出来了、
    // 进度卡在哪、桌面上那个报错框写了什么。没有这个能力，很多事只能靠猜。
    //
    // 抓屏是**只读**操作：不注入、不抢焦点、不模拟按键、不碰任何窗口，
    // 所以它没有"用自动化去操作别的软件"那类"点到错误窗口上"的风险。
    // 画面本身是敏感的，所以它走和会话内容同一道加密门（桥侧每抓一次都写日志）。
    var screenOverlay = null;
    var overlaySerial = 0;
    function wireOverlay(box, heading, closeButton, opener) {
      heading.id = 'dsh-lite-overlay-title-' + (++overlaySerial);
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', heading.id);
      var app = document.getElementById('app');
      if (app) app.inert = true;
      var closed = false;
      box.__liteClose = function (restoreFocus) {
        if (closed) return;
        closed = true;
        box.remove();
        if (screenOverlay === box) screenOverlay = null;
        if (app && !document.querySelector('.screen-overlay')) app.inert = false;
        if (restoreFocus !== false) {
          var target = opener && opener.isConnected && !opener.closest('[hidden]') ? opener : refs.railSettings;
          if (target && typeof target.focus === 'function') target.focus();
        }
      };
      closeButton.addEventListener('click', function () { box.__liteClose(); });
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); box.__liteClose(); return; }
        if (event.key !== 'Tab') return;
        var focusable = Array.prototype.filter.call(
          box.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'),
          function (node) { return !node.hidden && node.getClientRects().length > 0; });
        if (!focusable.length) { event.preventDefault(); return; }
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      closeButton.focus();
    }
    function closeScreenOverlay() {
      if (screenOverlay) screenOverlay.__liteClose();
    }
    /**
     * 把一张截图存到手机。
     *
     * ★ 为什么要把 data URL 转成 **Blob** 再下载，而不是直接给 `<a href="data:...">`：
     *   iOS Safari 对 `data:` URL 上的 `download` 支持很差 —— 常常**静默什么都不做**，
     *   使用者以为存了其实没存。Blob URL 是可靠的（codex 那边下载交付物也是这么做的）。
     *   手机上会落进「照片」或「下载」。
     *
     * @returns {string} 给按钮显示的反馈文字
     */
    function saveShotToPhone(shot) {
      try {
        var bin = atob(String((shot && shot.image) || ''));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var mime = (shot && shot.mime) || 'image/jpeg';
        var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        var d = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        // 文件名带时间戳：连着存几张不会互相覆盖（手机上重名会变成 (1)(2)）
        var name = 'screen-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
          '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
          (mime.indexOf('png') >= 0 ? '.png' : '.jpg');
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 立刻 revoke 会让某些浏览器下载到一半失败，留一分钟
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return t('已开始下载');
      } catch (err) {
        // 极少数浏览器不给下载 —— 那时还能长按图片存
        return t('存不了，长按图片试试');
      }
    }
    function showScreenShot() {
      closeSettingsMenu();
      closeScreenOverlay();
      var box = el('div', 'screen-overlay');
      var bar = el('div', 'screen-bar');
      var heading = el('strong', '', t('电脑屏幕'));
      bar.append(heading);
      // 「保存」要等**真有图**了才能按 —— 没图时按下去只能报错。
      var save = el('button', 'screen-action', t('保存到手机'));
      save.classList.add('screen-save');
      save.disabled = true;
      var again = el('button', 'screen-action', t('再看一次'));
      var shut = el('button', 'screen-action', t('关闭'));
      bar.append(save, again, shut);
      var holder = el('div', 'screen-holder', t('正在抓屏…'));
      box.append(bar, holder);
      keep(box);
      document.body.append(box);
      screenOverlay = box;
      wireOverlay(box, heading, shut, refs.railScreen);
      box.addEventListener('click', function (event) { if (event.target === box) box.__liteClose(); });

      var lastShot = null;   // 最近一次抓到的图，供「保存到手机」用
      var captureRequest = 0;
      var capturePending = false;
      function currentCapture(request) {
        return !state.disposed && screenOverlay === box && box.isConnected && request === captureRequest;
      }
      save.addEventListener('click', function () {
        if (!lastShot) return;
        save.disabled = true;
        save.textContent = saveShotToPhone(lastShot);
        setTimeout(function () {
          if (!box.isConnected || screenOverlay !== box) return;
          save.textContent = t('保存到手机');
          save.disabled = capturePending || !lastShot;
        }, 1800);
      });

      function grab() {
        if (capturePending || !box.isConnected || screenOverlay !== box || state.disposed) return;
        if (typeof adapter.screenShot !== 'function') {
          holder.textContent = t('这个版本还不支持看电脑屏幕，请更新桥。');
          return;
        }
        holder.textContent = t('正在抓屏…');
        holder.classList.add('is-busy');
        var request = ++captureRequest;
        capturePending = true;
        again.disabled = true;
        // 抓的过程中先禁掉保存：不然按下会存到**上一张**（图上已经不是它了）
        lastShot = null;
        save.disabled = true;
        Promise.resolve().then(function () { return adapter.screenShot({ maxWidth: 1280 }); }).then(function (result) {
          if (!currentCapture(request)) return;
          if (!result || typeof result.image !== 'string' || !result.image ||
              (result.mime !== 'image/jpeg' && result.mime !== 'image/png')) throw new Error(t('抓屏失败。'));
          holder.classList.remove('is-busy');
          holder.textContent = '';
          lastShot = result;
          save.disabled = false;
          var img = el('img', 'screen-image');
          img.alt = t('电脑屏幕');
          img.src = 'data:' + (result.mime || 'image/jpeg') + ';base64,' + result.image;
          holder.append(img);
          holder.append(el('span', 'screen-meta',
            result.width + '×' + result.height + ' · ' + Math.round((result.bytes || 0) / 1024) + ' KB'));
        }).catch(function (problem) {
          if (!currentCapture(request)) return;
          holder.classList.remove('is-busy');
          holder.textContent = safeError(problem, t('抓屏失败。'));
          // 失败之后画面上已经没有图了，保存按钮也得跟着不可用 ——
          // 否则按下去存到的是**上一次**那张，人还以为存的是眼前这张。
          lastShot = null;
          save.disabled = true;
        }).finally(function () {
          if (!currentCapture(request)) return;
          capturePending = false;
          again.disabled = false;
        });
      }
      again.addEventListener('click', grab);
      grab();
    }
    listen(refs.railScreen, 'click', showScreenShot);

    // ── C6 余额 / C7 连接地址 ─────────────────────────────────────────────────
    //
    // 两项都**不需要桥端新代码** —— `/__deepseek/balance` 和 `/__routes`
    // 本来就是控制台在用的端点，手机这边带着会话 cookie 直接问就行。
    // 挂在设置菜单里（菜单本身已经在 HTML 里，只是往里加按钮，不动结构）。
    function overlay(title, build, openerOverride) {
      closeSettingsMenu();
      // 同时开两个面板没有意义，只会互相盖住 —— 先把已有的收掉。
      // （实测踩过：连点两次「计划/目标」会叠两层，里层点不到；
      //   而且"最后一个面板"和"第一个面板"不是同一个，排查时很误导。）
      Array.prototype.slice.call(document.querySelectorAll('.screen-overlay'))
        .forEach(function (node) { if (node.__liteClose) node.__liteClose(false); else node.remove(); });
      var opener = openerOverride || document.activeElement;
      var box = el('div', 'screen-overlay panel-overlay');
      var bar = el('div', 'screen-bar');
      var heading = el('strong', '', title);
      bar.append(heading);
      var shut = el('button', 'screen-action', t('关闭'));
      bar.append(shut);
      var body = el('div', 'panel-body');
      box.append(bar, body);
      keep(box);
      document.body.append(box);
      wireOverlay(box, heading, shut, opener);
      box.addEventListener('click', function (e) { if (e.target === box) box.__liteClose(); });
      build(body, box);
      var firstInput = body.querySelector('input:not([disabled]), textarea:not([disabled])');
      if (firstInput) firstInput.focus();
      return box;
    }
    function jsonGet(path) {
      return fetch(path, { credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    // 走**加密通道**的取数。
      // `/__dsh/lite-addresses` 挂在 E2EE 门里（实测：明文请求一律 403
      // `encrypted-channel-required`）。用明文 fetch 去调它必然失败 ——
      // 这就是「内网 / 外网点开是空的」的真正原因：端点早就做好了，**是调用方式错了**。
      function jsonGetEncrypted(path) {
        var e2ee = window.DshE2EE;
        if (!e2ee || !window.__dshE2eeSecret || typeof e2ee.encryptedFetch !== 'function') {
          return Promise.reject(new Error('缺少加密密钥'));
        }
        return e2ee.encryptedFetch(window.__dshE2eeSecret, path, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: '{}'
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
      }
      function showBalance() {
      if (refs.settingsMenu) refs.settingsMenu.hidden = true;
      overlay('余额', function (body) {
        body.textContent = '正在读取…';
        jsonGet('/__deepseek/balance').then(function (data) {
          body.textContent = '';
          var rows = [];
          if (data && typeof data === 'object') {
            // 端点的形状可能随版本变，所以只挑"看起来像余额"的字段显示，
            // 其余原样列出来 —— 宁可多显示一行，也不要因为改版就什么都看不到。
            ['currency', 'balance', 'total', 'remaining', 'available'].forEach(function (k) {
              if (data[k] !== undefined && data[k] !== null) rows.push(k + '：' + data[k]);
            });
            if (!rows.length) rows.push(JSON.stringify(data));
          } else rows.push(t('没有拿到数据'));
          rows.forEach(function (line) { body.append(el('p', 'panel-line', line)); });
        }).catch(function (err) {
          // 整句一起翻 —— 拼接出来的句子换语言后语序会不对
          body.textContent = t('读不到余额。这个功能走控制台端点，需要已登录的会话。') +
            (((err && err.message) ? '（' + err.message + '）' : ''));
        });
      });
    }
    function showAddresses() {
      if (refs.settingsMenu) refs.settingsMenu.hidden = true;
      overlay(t('连接地址'), function (body) {
        body.textContent = t('正在读取…');
        // ★ 原来问的是 `/__console/status`（**只认回环**，手机上必然 403）
        //   和 `/__routes`（要证明、形状也不同）。使用者报的「内网/外网面板
        //   也不行」就是这个原因。现在问桥里专门给手机开的那一个，
        //   它同时挂在加密门里（响应里的地址带访问密钥）。
        jsonGetEncrypted('/__dsh/lite-addresses').then(function (data) {
          body.textContent = '';
          var lan = Array.isArray(data && data.lan) ? (data.lan[0] || '') : '';
          var wan = (data && typeof data.wan === 'string') ? data.wan : '';
          var lanHttps = Array.isArray(data && data.lanHttps) ? (data.lanHttps[0] || '') : '';
          if (!lan && !wan) { body.textContent = t('桥没有报回地址。'); return; }
          var here = location.origin;
          // 手机自己地址里的 `#k=` 必须带过去 —— 换地址不能把加密弄丢。
          // 端点故意不回密钥，就是为了让"钥匙"只存在一个地方（这台手机）。
          function withKey(url) {
            if (!url) return '';
            var hash = '';
            try { hash = location.hash || ''; } catch (err) { hash = ''; }
            if (!hash || hash.indexOf('k=') < 0) return url;
            return url + hash;
          }
          function row(label, url, hint) {
            if (!url) return;
            var full = withKey(url);
            var line = el('div', 'addr-row');
            line.append(el('strong', '', t(label) + (url.indexOf(here) === 0 ? ' · ' + t('就是你现在用的这条') : '')));
            line.append(el('span', 'addr-url', full));
            if (url.indexOf(here) !== 0) {
              var go = el('button', 'screen-action', t('切到这个地址'));
              go.type = 'button';
              go.addEventListener('click', function () { location.href = full; });
              line.append(go);
            }
            body.append(line);
          }
          row('内网（同一个 WiFi）', lan);
          row('内网（HTTPS，全链路加密）', lanHttps);
          row('外网（隧道）', wan);
          if (!lan) body.append(el('p', 'panel-line', t('现在看不到内网地址（不在同一个 WiFi，或者电脑没连内网）。')));
          if (data && data.needsKey) {
            body.append(el('p', 'panel-line', '⚠️ ' + t('这条地址里没有加密密钥，所以内容通道用不了 —— 发送键会变灰、对话也加载不出来。请用带 #k= 的完整地址重新打开（电脑控制台里的「复制链接」给出的那条）。')));
          }
        }).catch(function (err) {
          body.textContent = '读不到地址（' + ((err && err.message) || '') + '）。';
        });
      });
    }
    // ── 选模型 / 选模式 ───────────────────────────────────────────────────────
    //
    // 两项共用一套「列表 + 点选」的界面。方法是 C3/C4 要求的功能，
    // 桥端白名单和适配器方法都已就位（方法名从 DSH 的 app.asar 里搜出来的）。
    //
    // 容错刻意做厚一点：DSH 给回来的列表结构没有文档，字段名可能变，
    // 所以 id/name 各试几个常见写法 —— 读不出来时显示"电脑没有报回可选项"，
    // 而不是静默什么都不画（静默失败最耗人）。
    function pickList(title, loader, onPick, options) {
      options = options || {};
      if (refs.settingsMenu) refs.settingsMenu.hidden = true;
      if (!state.sessionId) { setSidebar(true); return; }
      var sessionId = state.sessionId;
      overlay(t(title), function (body, box) {
        body.textContent = t('正在读取…');
        Promise.all([Promise.resolve().then(loader), options.selection ? refreshSelection() : null]).then(function (parts) {
          if (state.sessionId !== sessionId || !box.isConnected) return;
          var items = parts[0];
          body.textContent = '';
          if (typeof options.note === 'function') {
            var note = options.note(items);
            if (note) body.append(el('p', 'panel-line', note));
          }
          if (!items || !items.length) { body.append(el('p', 'panel-line', t('电脑没有报回可选项。'))); return; }
          items.slice(0, 80).forEach(function (item) {
            var id = typeof item === 'string' ? item
              : (item.id || item.modelId || item.presetId || item.value || item.name || '');
            var name = typeof item === 'string' ? item
              : (item.name || item.label || item.title || item.id || item.modelId || '');
            if (!id) return;
            // 诊断行（id 以 __ 开头）：只显示，不可点选 —— 它是"字段名没猜中"的线索，
            // 不是可选项。点了也不该去改模型。
            if (String(id).indexOf('__') === 0) {
              body.append(el('p', 'panel-line', String(name)));
              return;
            }
            var displayName = typeof options.displayName === 'function' ? options.displayName(String(id), String(name), item) : String(name);
            var row = el('button', 'pick-row');
            row.type = 'button';
            row.setAttribute('aria-selected', String(!!(options.isSelected && options.isSelected(String(id), item))));
            row.append(el('span', '', displayName + (row.getAttribute('aria-selected') === 'true' ? ' ✓' : '')));
            var details = [];
            if (item && item.isDefault === true) details.push(t('默认配置'));
            if (displayName !== String(name)) details.push(String(name));
            if (item && item.description) details.push(String(item.description));
            if (item && item.broken) details.push(t('不可用') + '：' + String(item.broken));
            if (details.length) row.append(el('small', '', details.join(' · ')));
            var locked = options.locked && options.locked(String(id), item);
            if (locked || (item && item.broken)) { row.disabled = true; body.append(row); return; }
            // C20：这个模型有思考强度可选 → 先让使用者选强度，再一起提交。
            // 不分两步的话，选完模型永远只能用默认强度（使用者反馈「不能选思考强度」）。
            // 顺手把目录里的默认档标出来，免得每次都要自己猜该选哪个。
            if (Array.isArray(item.efforts) && item.efforts.length) {
              var efforts = item.efforts.map(function (effort) {
                var mark = String(effort.id) === String(item.defaultEffort || '') ? '（默认）' : '';
                return { id: effort.id, name: (effort.name || effort.id) + mark,
                  description: effort.description || '' };
              });
              row.addEventListener('click', function () {
                if (state.sessionId !== sessionId) return;
                pickList(t('思考强度') + ' · ' + displayName,
                  function () { return Promise.resolve(efforts); },
                  function (effortId) { return onPick(String(id), String(effortId), item); },
                  { opener: refs.composerPicks.querySelector('[data-kind="model"]'),
                    isSelected: function (effortId) {
                    var chosen = state.selection.modelSelection;
                    return !!chosen && chosen.model === String(id) && chosen.reasoningEffort === effortId;
                  } });
              });
              body.append(row);
              return;
            }
            row.addEventListener('click', function () {
              if (state.sessionId !== sessionId) { row.textContent = t('对话已切换，请重新打开。'); return; }
              row.disabled = true;
              row.textContent = displayName + ' —— ' + t('正在切换…');
              onPick(String(id), '', item).then(function () {
                row.textContent = displayName + ' ✓ ' + t('已切换');
                setTimeout(function () { if (box && box.isConnected) box.__liteClose(); }, 700);
              }).catch(function (err) {
                row.disabled = false;
                row.textContent = displayName + '（' + t('失败') + '：' + ((err && err.message) || t('未知')) + '）';
              });
            });
            body.append(row);
          });
        }).catch(function (err) {
          if (box.isConnected) body.textContent = t('读不到列表：') + ((err && err.message) || t('未知'));
        });
      }, options.opener);
    }
    function showModels() {
      if (typeof adapter.listModels !== 'function' || typeof adapter.selectModel !== 'function') {
        overlay(t('选择模型'), function (body) {
          body.append(el('p', 'panel-line', t('此版本不支持选择模型，请在电脑端操作。')));
        }, refs.composerPicks.querySelector('[data-kind="model"]'));
        return;
      }
      pickList('选择模型',
        function () { return adapter.listModels(state.sessionId); },
        // ★ provider 必须一起提交（DSH 的 schema 是 { sessionId, provider, model,
        //   reasoningEffort? }）。它随模型项带出来，不再是猜的。
        function (id, effort, item) {
          var sessionId = state.sessionId;
          return adapter.selectModel(sessionId, id, effort, item && item.provider).then(function () {
            if (state.sessionId === sessionId) {
              state.selection.modelSelection = { provider: item && item.provider || '', model: id, reasoningEffort: effort || '' };
              composerPicksRelabel();
              refreshSelection();
            }
          });
        }, {
          opener: refs.composerPicks.querySelector('[data-kind="model"]'),
          selection: true,
          note: function (items) {
            var chosen = state.selection.modelSelection;
            var previous = state.selection.lastUsedModel;
            function nameOf(value) {
              var found = value && Array.isArray(items) && items.find(function (item) {
                return item && item.id === value.model && item.provider === value.provider;
              });
              return found ? String(found.name || found.id) : value && value.model;
            }
            return chosen ? t('下轮模型') + '：' + nameOf(chosen) :
              previous ? t('上轮模型') + '：' + nameOf(previous) + '。' + t('下轮模型未报告。') : t('下轮模型未报告。');
          },
          isSelected: function (id, item) {
            var chosen = state.selection.modelSelection;
            return !!chosen && chosen.model === id && chosen.provider === String(item && item.provider || '');
          }
        });
    }
    // C21：计划 / 目标。
    //
    // ★ 这里原来调 `session/selectMode` —— **那个 RPC 根本不存在**
    //   （asar 里 135 个 descriptor，session 命名空间下没有它）。所以这个按钮
    //   在手机端从来没成功过，而且失败还被界面当成"未识别的回应"吞掉了。
    //   真正的入口是**宿主命令**：`/plan` 进入或离开计划模式，走 commands/execute
    //   （和电脑端敲这些命令是同一条路、同一份实现）。
    /**
     * 目标条（C26）—— **照电脑端的 GoalBar 做**。
     *
     * 使用者原话：「你这目标的设置，ui 不能和电脑端一样吗？这样子像是90年代的感觉」。
     * 于是去 DSH 的打包文件里把电脑端那份读了：它不是面板，是**一条停在输入框
     * 上方的横条** ——
     *     目标图标 + 阶段文字 + **单行截断**的目标正文 + 右侧圆形图标按钮
     *     （暂停/恢复、编辑、清除）；**编辑是同一行里的内联输入框**，不弹面板；
     *     **完成的目标什么都不渲染**；建目标走 `/goal` 命令，不在这条上。
     * 这里逐条照搬（连 CSS 都是照它那份改的），只有尺寸按手机调了一档。
     */
    function goalGlyph() {
      var box = el('span', 'goal-glyph');
      box.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>' +
        '<circle cx="12" cy="12" r=".8"/></svg>';
      return box;
    }
    function goalIcon(kind, label, run) {
      var paths = {
        pause: '<path d="M9.5 5v14M14.5 5v14"/>',
        resume: '<path d="M7.5 4.5 19 12 7.5 19.5z"/>',
        edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14.5 5.5 18.5 9.5"/>',
        clear: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
        save: '<path d="M5 12.5 9.5 17 19 7"/>',
        read: '<path d="M20 6v6h-6M19.5 12a7.5 7.5 0 1 1-2.1-5.2L20 9"/>',
        cancel: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>'
      };
      var button = el('button', 'goal-icon');
      button.type = 'button';
      button.dataset.kind = kind;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[kind] || '') + '</svg>';
      button.addEventListener('click', function () { run(button); });
      return button;
    }
    /** 阶段文字 —— 用词和电脑端**一字不差**（phase.active / paused / blocked）。 */
    function goalPhaseText(phase) {
      if (phase === 'active') return t('进行中的目标');
      if (phase === 'paused') return t('已暂停的目标');
      if (phase === 'blocked') return t('受阻的目标');
      return t('目标');
    }
    function renderGoalBar() {
      var bar = refs.goalBar;
      if (!bar) return;
      var goal = state.goal;
      bar.dataset.state = state.goalError ? 'unavailable' : '';
      if (state.goalError && (!goal || goal.phase === 'complete') && !state.goalEditing) {
        bar.hidden = false;
        bar.replaceChildren();
        bar.append(el('span', 'goal-objective', t('目标状态暂时无法读取。')));
        var retry = el('button', 'screen-action', t('重试读取'));
        retry.type = 'button';
        retry.addEventListener('click', function () { retry.disabled = true; refreshGoal(); });
        bar.append(retry);
        return;
      }
      // 电脑端：**完成的目标什么都不渲染**（没有目标时同样不渲染）
      if ((!goal || goal.phase === 'complete') && !state.goalEditing) {
        bar.hidden = true;
        bar.replaceChildren();
        return;
      }
      bar.hidden = false;
      bar.dataset.phase = goal && goal.phase || '';
      bar.replaceChildren();
      bar.append(goalGlyph());
      if (state.goalError) bar.append(el('span', 'goal-state-note', t('上次读取的目标，当前状态未确认。')));

      // 编辑态：**同一行里的内联输入框**（电脑端就是这么做的）
      if (state.goalEditing) {
        var draft = state.goalEditing;
        var input = el('input', 'goal-input');
        input.type = 'text';
        input.value = draft.text;
        input.disabled = !!draft.pending;
        input.setAttribute('aria-label', t('目标内容'));
        if (draft.feedback) input.title = draft.feedback;
        input.addEventListener('input', function () { if (state.goalEditing === draft) draft.text = input.value; });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commitGoalEdit(input); }
          else if (ev.key === 'Escape' && !draft.pending) { state.goalEditing = null; renderGoalBar(); }
        });
        bar.append(input);
        var editing = el('span', 'goal-actions');
        var save = goalIcon(draft.uncertain ? 'read' : 'save', draft.uncertain ? t('重新读取目标') : t('保存目标'), function () {
          if (draft.uncertain) checkGoalEdit(draft);
          else commitGoalEdit(input);
        });
        save.dataset.kind = draft.uncertain ? 'read' : 'save';
        save.disabled = !!draft.pending || (!draft.uncertain && (!goal || goal.phase === 'complete'));
        editing.append(save);
        var cancel = goalIcon('cancel', t('取消编辑'), function () {
          state.goalEditing = null;
          renderGoalBar();
        });
        cancel.disabled = !!draft.pending;
        editing.append(cancel);
        bar.append(editing);
        if (draft.feedback) {
          var note = el('span', 'goal-state-note', draft.feedback);
          note.setAttribute('role', 'status');
          bar.append(note);
        }
        if (!draft.pending && !draft.uncertain) setTimeout(function () { if (input.isConnected) { input.focus(); input.select(); } }, 0);
        return;
      }

      bar.append(el('span', 'goal-label', goalPhaseText(goal.phase)));
      bar.append(el('span', 'goal-objective', goal.objective));
      if (typeof adapter.goalAction !== 'function') return;
      var actions = el('span', 'goal-actions');
      if (goal.phase === 'paused') {
        actions.append(goalIcon('resume', t('恢复目标'), function () { runGoal('resume'); }));
      } else if (goal.phase === 'active') {
        actions.append(goalIcon('pause', t('暂停目标'), function () { runGoal('pause'); }));
      }
      actions.append(goalIcon('edit', t('编辑目标'), function () {
        state.goalEditing = { text: goal.objective };
        renderGoalBar();
      }));
      actions.append(goalIcon('clear', t('清除目标'), function () { runGoal('clear'); }));
      bar.append(actions);
    }
    function commitGoalEdit(input) {
      var text = String(input.value || '').trim();
      if (!text) { showError({ userMessage: t('目标不能是空的。') }, t('目标不能是空的。')); return; }
      var draft = state.goalEditing;
      if (!state.goal || !draft || draft.pending || draft.uncertain) return;
      draft.text = input.value;
      draft.submitted = text;
      draft.pending = true;
      draft.feedback = '';
      renderGoalBar();
      runGoal('edit', text, draft);
    }
    function settleGoalEdit(draft) {
      if (state.goalEditing !== draft) return;
      draft.pending = false;
      if (!state.goalError && state.goal && state.goal.objective === draft.submitted) {
        state.goalEditing = null;
      } else {
        draft.uncertain = !!state.goalError;
        draft.feedback = state.goalError ? t('修改结果未确认，文字已保留。请先重新读取目标。') : t('已重新读取目标，请检查后保存。');
      }
      renderGoalBar();
    }
    function checkGoalEdit(draft) {
      if (state.goalEditing !== draft || draft.pending) return;
      var sessionId = state.sessionId, contextVersion = state.contextVersion;
      draft.pending = true;
      renderGoalBar();
      refreshGoal().then(function () {
        if (state.sessionId === sessionId && state.contextVersion === contextVersion) settleGoalEdit(draft);
      });
    }
    /** 对目标做一次操作，然后**重新读一遍** —— revision 会变，拿旧值再点会被 DSH 拒。 */
    function runGoal(kind, objective, draft) {
      var goal = state.goal;
      if (!goal || !state.sessionId || typeof adapter.goalAction !== 'function') return;
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var payload = { id: goal.id, revision: goal.revision };
      if (kind === 'edit') payload.objective = objective;
      Promise.resolve().then(function () { return adapter.goalAction(sessionId, kind, payload); }).then(function () {
        if (state.sessionId === sessionId && state.contextVersion === contextVersion) return refreshGoal().then(function () {
          if (draft) settleGoalEdit(draft);
        });
      }).catch(function (err) {
        if (state.sessionId === sessionId && state.contextVersion === contextVersion) {
          if (draft && state.goalEditing === draft) {
            draft.pending = false;
            draft.uncertain = true;
            draft.feedback = t('修改结果未确认，文字已保留。请先重新读取目标。');
            renderGoalBar();
          }
          showError(err, t('目标操作失败。'));
        }
      });
    }
    function refreshGoal() {
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var request = ++state.goalRequest;
      if (!sessionId || typeof adapter.readGoal !== 'function') {
        state.goal = null;
        state.goalError = '';
        renderGoalBar();
        return Promise.resolve();
      }
      return Promise.resolve().then(function () { return adapter.readGoal(sessionId); }).then(function (goal) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || request !== state.goalRequest) return;
        state.goal = goal || null;
        state.goalError = '';
        renderGoalBar();
      }).catch(function (error) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || request !== state.goalRequest) return;
        // A failed read is not proof that the saved goal disappeared.
        state.goalError = safeError(error, t('目标状态暂时无法读取。'));
        renderGoalBar();
      });
    }

    // C21：计划模式（进入 / 离开）。这是**另一件事**，不和目标混在一起。
    // ★ 原来这里调 `session/selectMode` —— **那个 RPC 根本不存在**（asar 里没有它）。
    //   真正的入口是宿主命令 `/plan`，走 commands/execute。
    // 「计划 / 目标」按钮打开的是**设定目标 + 计划模式 + 压缩上下文**这块小面板；
    // 目标本身显示在输入框上方那条**目标条**上（和电脑端一样）。
    // J 压缩上下文：把 /compact 当一条消息发出去。
    // 失败时必须显示原因，避免用户以为操作已经成功。
    function compactContext() {
      if (!state.sessionId) { setSidebar(true); return; }
      if (typeof adapter.sendMessage !== 'function') { showError(null, '这个版本不支持发送。'); return; }
      if (state.sending) { showError(null, "正在发送中，等这条发完再压缩。"); return; }
      adapter.sendMessage({ sessionId: state.sessionId, text: '/compact', attachments: [] })
        .catch(function (problem) {
          showError(problem, '压缩上下文没有发出去。');
        });
    }
    function showGoalModes() {
      if (!state.sessionId) { setSidebar(true); return; }
      var sessionId = state.sessionId;
      overlay(t('目标'), function (body, box) {
        body.append(el('p', 'panel-line', state.goalError ? t('目标状态暂时无法读取。') : state.goal
          ? t('目标显示在输入框上方那条里，点铅笔可以改。')
          : t('还没有设定目标。')));

        if (typeof adapter.goalAction !== 'function') {
          body.append(el('p', 'panel-line', t('此版本不支持目标，请在电脑端操作。')));
        } else {
          var input = el('textarea', 'goal-input');
          input.rows = 3;
          input.setAttribute('aria-label', t('目标内容'));
          input.value = state.goal ? state.goal.objective : '';
          input.placeholder = t('写一句话说明目标');
          var save = el('button', 'screen-action', state.goal ? t('保存目标') : t('设定目标'));
          var goalFeedback = el('p', 'files-status');
          goalFeedback.hidden = true;
          save.type = 'button';
          save.addEventListener('click', function () {
            var text = input.value.trim();
            if (!text) { goalFeedback.textContent = t('目标不能是空的。'); goalFeedback.hidden = false; return; }
            save.disabled = true;
            goalFeedback.hidden = true;
            var done = Promise.resolve().then(function () {
              if (state.sessionId !== sessionId) throw new Error(t('对话已切换，请重新打开。'));
              return state.goal
                ? adapter.goalAction(sessionId, 'edit',
                  { id: state.goal.id, revision: state.goal.revision, objective: text })
                : adapter.goalAction(sessionId, 'create', { objective: text });
            });
            done.then(function () { return refreshGoal(); }).then(function () {
              if (!box.isConnected || state.sessionId !== sessionId) return;
              save.disabled = false;
              var confirmed = !state.goalError && state.goal && state.goal.objective === text;
              goalFeedback.textContent = confirmed ? t('目标已保存。') : t('目标请求已发送，当前结果未确认，请重新读取。');
              goalFeedback.dataset.state = confirmed ? 'success' : 'error';
              goalFeedback.hidden = false;
            }).catch(function (err) {
              if (!box.isConnected || state.sessionId !== sessionId) return;
              save.disabled = false;
              goalFeedback.textContent = safeError(err, t('目标操作失败。'));
              goalFeedback.dataset.state = 'error';
              goalFeedback.hidden = false;
            });
          });
          var form = el('div', 'goal-form');
          form.append(input, save, goalFeedback);
          body.append(form);
        }

        var planHost = el('div', 'plan-controls', t('正在检查计划模式…'));
        body.append(planHost);
        var hasPlanCommand = null;
        function planAction(title, line) {
          var button = el('button', 'screen-action', t(title));
          button.type = 'button';
          button.addEventListener('click', function () {
            if (state.sessionId !== sessionId || !box.isConnected) return;
            button.disabled = true;
            button.textContent = t('正在切换…');
            Promise.resolve().then(function () { return adapter.runCommand(sessionId, line); }).then(function (reply) {
              var result = reply && reply.result;
              if (result && (result.kind === 'error' || result.kind === 'failure'))
                throw new Error(result.text || result.message || t('计划模式切换失败。'));
              return refreshSelection();
            }).then(function () {
              if (state.sessionId === sessionId && box.isConnected) renderPlanControls();
            }).catch(function (error) {
              if (state.sessionId !== sessionId || !box.isConnected) return;
              button.disabled = false;
              button.textContent = t(title);
              planHost.append(el('p', 'files-status', safeError(error, t('计划模式切换失败。'))));
            });
          });
          planHost.append(button);
        }
        function renderPlanControls() {
          if (state.sessionId !== sessionId || !box.isConnected) return;
          planHost.replaceChildren();
          if (typeof adapter.runCommand !== 'function') {
            planHost.append(el('p', 'panel-line', t('此版本不支持计划模式，请在电脑端操作。')));
            return;
          }
          var plan = state.selection.plan;
          if (!plan && hasPlanCommand === false) {
            planHost.append(el('p', 'panel-line', t('此对话的工具配置不支持计划模式。')));
          } else if (plan && plan.pending) {
            planHost.append(el('p', 'panel-line', plan.active ?
              t('正在退出计划模式，下一步骤生效。') : t('正在进入计划模式，下一步骤生效。')));
          } else if (plan) {
            planHost.append(el('p', 'panel-line', plan.active ? t('计划模式已启用。') : t('计划模式未启用。')));
            planAction(plan.active ? '退出计划模式' : '进入计划模式', plan.active ? '/plan off' : '/plan');
          } else {
            planHost.append(el('p', 'panel-line', t('无法读取当前计划状态，请明确选择操作。')));
            planAction('进入计划模式', '/plan');
            planAction('退出计划模式', '/plan off');
          }
        }
        Promise.all([
          refreshSelection(),
          typeof adapter.listCommands === 'function' ? Promise.resolve().then(function () {
            return adapter.listCommands(sessionId);
          }).then(function (commands) {
            hasPlanCommand = Array.isArray(commands) && commands.some(function (command) {
              return String(command && (command.name || command.command) || '').replace(/^\//, '').toLowerCase() === 'plan';
            });
          }).catch(function () { hasPlanCommand = null; }) : Promise.resolve()
        ]).then(renderPlanControls);

        // 压缩上下文放在目标面板里，不占用输入区下沿。
        // 真正干活的是 runCompact()（走 commands/execute，不是把 `/compact` 当消息发）。
        var compact = el('button', 'screen-action', t('压缩上下文'));
        compact.type = 'button';
        compact.addEventListener('click', function () {
          compact.disabled = true;
          // 就地显示进度和结果，不另开面板
          var slot = el('div', 'goal-compact-result');
          body.append(slot);
          runCompact(slot, function () { compact.disabled = false; });
        });
        body.append(compact);
      }, refs.composerPicks.querySelector('[data-kind="goal"]'));
    }
    // 「工具配置」= agent preset（DSH 的工具组合），走 agentPresets/select。
    // 目标（goal）不在这个列表里 —— 它是 `/goal` 命令（见上面的说明）。
    function uiLang() {
      try { return (window.DshI18n && window.DshI18n.lang && window.DshI18n.lang()) || 'zh'; }
      catch (_) { return 'zh'; }
    }
    function presetRow(id) { return (window.DshLitePresets || {})[String(id || '')] || null; }
    function presetLabel(id) { var row = presetRow(id); return row ? (row[uiLang()] || row.zh) : ''; }
    function presetHint(id) { var row = presetRow(id); return row && row.hint ? (row.hint[uiLang()] || row.hint.zh) : ''; }
    function showModes() {
      if (typeof adapter.listModes !== 'function' || typeof adapter.selectMode !== 'function') {
        overlay(t('工具配置'), function (body) {
          body.append(el('p', 'panel-line', t('此版本不支持选择工具配置，请在电脑端操作。')));
        }, refs.composerPicks.querySelector('[data-kind="mode"]'));
        return;
      }
      pickList('工具配置',
        function () {
          return adapter.listModes(state.sessionId).then(function (items) {
            // 顺手把官方说明挂成副标题 —— pickList 会把 item.description 显示在名字下面
            return (items || []).map(function (item) {
              var id = String((item && (item.id || item.name)) || '');
              var hint = presetHint(id);
              if (hint && item && !item.description) item.description = hint;
              return item;
            });
          });
        },
        function (id) {
          var sessionId = state.sessionId;
          return adapter.selectMode(sessionId, id).then(function () {
            if (state.sessionId === sessionId) {
              state.selection.agentPreset = id;
              composerPicksRelabel();
              refreshSelection();
            }
          });
        }, {
          opener: refs.composerPicks.querySelector('[data-kind="mode"]'),
          selection: true,
          note: function () {
            var current = state.selection.agentPreset;
            var line = current
              ? t('当前工具配置') + '：' + (presetLabel(current) || current) + '。'
              : t('当前工具配置未报告。');
            if (state.selection.blank === false) line += ' ' + t('对话开始后不能更换工具配置，请新建对话。');
            else if (state.selection.blank === null) line += ' ' + t('此版本未报告能否更换；若被拒绝，请新建对话。');
            return line;
          },
          displayName: function (id, name) { return presetLabel(id) || name; },
          isSelected: function (id) { return state.selection.agentPreset === id; },
          locked: function () { return state.selection.blank === false; }
        });
    }

    // ── J：压缩上下文 ─────────────────────────────────────────────────────────
    //
    // 使用者的原话是「压缩上下文的怎么没有」。查 asar 之后的做法是：**不**把
    // `/compact` 当一条消息发出去（那要指望宿主去解析斜杠命令，形状完全没保证），
    // 而是走 DSH 自己的命令 RPC：
    //     commands/list    → 列这个会话能用的斜杠命令（有 name/description）
    //     commands/execute → 执行一条命令（{agentId, line}）
    // 电脑端界面点"压缩"走的就是它，而且**不消耗模型回合**。
    //
    // 为什么先列一遍再执行：万一这个版本的 DSH 没有 /compact（插件没挂），
    // 直接把 `/compact` 发过去只会得到一条含糊的错误。先列出来就能明确说
    // "电脑上的这个 DSH 没有 /compact 命令" —— 这比"失败了"有用得多。
    /**
     * 压缩上下文。
     *
     * @param {Element} [host] 给一块现成的地方显示进度/结果。不传就自己开一个面板。
     *   （使用者要求把它挪进「计划 / 目标」面板，所以要能"就地显示"。）
     * @param {Function} [done] 结束回调 —— 用来把按钮恢复成可点。
     */
    function runCompact(host, done) {
      var finish = function () { if (typeof done === 'function') done(); };
      if (!state.sessionId) { setSidebar(true); finish(); return; }
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var render = function (body) {
        function current() {
          return !state.disposed && state.sessionId === sessionId &&
            state.contextVersion === contextVersion && body.isConnected;
        }
        // 列命令只是"先确认有没有"，**列不出来也照样往下走** ——
        // 老版本 DSH 可能没有 commands/list，那不构成"不能压缩"的理由。
        // 适配器没实现这两个方法时（旧版界面/旧桥）同样直接给出明确提示。
        if (typeof adapter.runCommand !== 'function') {
          body.textContent = t('此版本不支持压缩上下文，请在电脑端操作。');
          finish();
          return;
        }
        var listing = typeof adapter.listCommands === 'function'
          ? Promise.resolve().then(function () { return adapter.listCommands(sessionId); }).catch(function () { return null; })
          : Promise.resolve(null);
        listing.then(function (items) {
          // A closed sheet or a changed conversation cancels admission; a
          // command already admitted is never automatically repeated.
          if (!current()) return null;
          if (items) {
            var names = (items || []).map(function (item) {
              return (typeof item === 'string' ? item : String((item && (item.name || item.command)) || '')).replace(/^\//, '').toLowerCase();
            });
            if (names.length && names.indexOf('compact') < 0) {
              body.textContent = t('电脑上的这个 DSH 没有 /compact 命令。') +
                '（' + names.slice(0, 12).join(', ') + '）';
              return null;
            }
          }
          body.textContent = t('压缩上下文：正在压缩…');
          return adapter.runCommand(sessionId, '/compact');
        }).then(function (value) {
          if (value === null) { finish(); return; }
          if (!current()) { finish(); return; }
          var result = value && value.result;
          if (result && (result.kind === 'error' || result.kind === 'failure')) {
            body.textContent = t('压缩上下文失败。') + (typeof result.text === 'string' && result.text ? ' ' + result.text.slice(0, 600) : '');
            finish();
            return;
          }
          body.textContent = result && typeof result.text === 'string' && result.text
            ? t('电脑回应：') + ' ' + result.text.slice(0, 600)
            : t('压缩请求已发送，完成状态未确认，请在电脑端核对。');
          finish();
        }).catch(function (err) {
          if (current()) body.textContent = safeError(err, t('压缩上下文失败。'));
          finish();
        });
      };
      if (host) render(host);
      else overlay(t('压缩上下文'), render);
    }
    // ── 授权范围（DSH 的「权限预设」）──────────────────────────────────────────
    //
    // 使用者提的：「目前的手机版 dsh 没有授权范围，增加」。
    //
    // 电脑端界面上这一项叫「权限」，包是 @deepseek-ai/dsh-client-ui-permission-presets，
    // 三档内置预设（值和 DSH 的 SandboxMode 一一对应）：
    //     仅可查看       read-only
    //     工作区内修改   workspace-write
    //     完全权限       danger-full-access
    // 另有实验性的 auto（界面写 Auto review，带 EXP 标记）—— 默认装配里不挂，
    // 所以这里也不提供，免得给出一个电脑端都没有的选项。
    //
    // ★ 做法**不是**把 `/permission xxx` 当消息发出去。理由和压缩上下文那条一样
    //   （见上面 runCompact 的注释）：那要指望宿主去解析斜杠命令，形状完全没保证。
    //   走 DSH 自己的命令接口 commands/execute，也就是适配器里现成的 runCommand()。
    //
    // ★ 「完全权限」要二次确认。电脑端选它时也要求确认（原话：
    //   「通过可见选项选择完全权限或 Auto 时，需要分别确认对应风险」），
    //   手机端不该比电脑端更宽松 —— 这一项意味着减少确认步骤、可直接执行敏感操作。
    var PERMISSION_PRESETS = [
      { id: 'read-only', label: '仅可查看', hint: '只能看，不能改文件、不能执行命令。' },
      { id: 'workspace-write', label: '工作区内修改', hint: '可以在项目目录里改文件、执行命令；越界操作仍会询问。' },
      { id: 'danger-full-access', label: '完全权限', hint: '减少确认步骤，可直接执行敏感操作、修改文件、运行外部命令。', danger: true }
    ];
    /** 这一档需不需要用户先确认风险 */
    function permissionNeedsConfirm(id) { return id === 'danger-full-access'; }

    /**
     * 切换当前会话的授权范围。
     *
     * @param {Element} [host] 就地显示结果的地方；不传就自己开一个面板。
     * @param {Function} [done] 结束回调（恢复按钮可点）。
     */
    function showPermissions(host, done) {
      var finish = function () { if (typeof done === 'function') done(); };
      if (!state.sessionId) { setSidebar(true); finish(); return; }
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var render = function (body) {
        var pending = false;
        var readRequest = 0;
        var buttons = [];
        function current() {
          return !state.disposed && state.sessionId === sessionId &&
            state.contextVersion === contextVersion && body.isConnected;
        }
        body.replaceChildren();
        if (typeof adapter.runCommand !== 'function') {
          body.append(el('p', 'panel-line', t('此版本不支持切换授权范围，请在电脑端操作。')));
          finish();
          return;
        }
        body.append(el('p', 'panel-line',
          t('选择这个对话的授权范围。只有电脑返回当前配置后，才会显示已确认。')));

        var active = el('p', 'panel-line', t('当前授权范围未确认。'));
        active.setAttribute('role', 'status');
        body.append(active);
        var status = el('p', 'panel-line', '');
        status.setAttribute('role', 'status');
        function readCurrent() {
          var request = ++readRequest;
          if (typeof adapter.readPermission !== 'function') return Promise.resolve(null);
          return Promise.resolve().then(function () { return adapter.readPermission(sessionId); }).then(function (value) {
            if (!current() || request !== readRequest) return null;
            var id = typeof value === 'string' ? value : value && value.presetId;
            var preset = PERMISSION_PRESETS.find(function (item) { return item.id === id; });
            if (!preset) throw new Error(t('当前授权范围未确认。'));
            active.textContent = t('电脑当前授权范围：') + ' ' + t(preset.label);
            buttons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.preset === preset.id)); });
            return preset.id;
          }).catch(function () {
            if (current() && request === readRequest) {
              active.textContent = t('当前授权范围未确认。');
              buttons.forEach(function (button) { button.removeAttribute('aria-pressed'); });
            }
            return null;
          });
        }
        PERMISSION_PRESETS.forEach(function (preset) {
          var row = el('div', 'srow');
          var btn = el('button', 'screen-action', t(preset.label));
          btn.type = 'button';
          btn.dataset.preset = preset.id;
          buttons.push(btn);
          if (preset.danger) btn.classList.add('danger');
          btn.addEventListener('click', function () {
            if (!current() || pending) return;
            var go = function () {
              if (!current() || pending) return;
              pending = true;
              readRequest++;
              buttons.forEach(function (button) { button.disabled = true; });
              status.textContent = t('正在切换…');
              Promise.resolve().then(function () {
                if (!current()) return null;
                return adapter.runCommand(sessionId, '/permission ' + preset.id);
              }).then(function (value) {
                if (!current()) return null;
                var result = value && value.result;
                if (result && (result.kind === 'error' || result.kind === 'failure')) {
                  throw new Error(typeof result.text === 'string' && result.text || t('授权范围切换失败。'));
                }
                return readCurrent().then(function (currentPreset) {
                  if (!current()) return;
                  status.textContent = currentPreset === preset.id
                    ? t('已确认当前授权范围：') + ' ' + t(preset.label)
                    : t('授权请求已发送，是否生效未确认，请在电脑端核对。');
                });
              }).catch(function (err) {
                if (current()) status.textContent = safeError(err, t('授权范围切换失败。'));
              }).finally(function () {
                pending = false;
                if (current()) buttons.forEach(function (button) { button.disabled = false; });
              });
            };
            if (!permissionNeedsConfirm(preset.id)) { go(); return; }
            // 二次确认。用它自己的话讲清代价，不用含糊的"确定吗"。
            if (window.confirm(t('确认启用完全权限？') + '\n\n' + t(preset.hint) +
                '\n\n' + t('仅建议在你信任后续任务时使用。'))) go();
          });
          row.append(el('span', 'k', t(preset.label)), btn);
          body.append(row);
          body.append(el('p', 'panel-line', t(preset.hint)));
        });
        body.append(status);
        readCurrent();
      };
      if (host) render(host);
      else overlay(t('授权范围'), render, refs.composerPicks.querySelector('[data-kind="perm"]'));
    }
    // The narrow status line under the composer mirrors DSH's connection and
    // balance indicators. Codex and connection switching remain in Settings.
    (function installComposerStatus() {
      var balance = refs.composerBalance;
      if (!balance) return;
      balance.title = t('看余额');
      listen(balance, 'click', showBalance);
      loadBalance(balance);
      listen(document, 'visibilitychange', function () {
        if (!document.hidden) loadBalance(balance);
      });
      mountTimers.push(setInterval(function () { if (!document.hidden) loadBalance(balance); }, 60000));
    })();

    /** 读余额并写进那个标签。读不到就显示「—」，不弹错误框（它只是个常驻小字）。 */
    function loadBalance(node) {
      if (!node) return;
      jsonGet('/__deepseek/balance').then(function (data) {
        var cur = (data && data.currency) || '';
        var val = data ? (data.total !== undefined ? data.total : data.balance) : undefined;
        if (val === undefined || val === null) { node.textContent = t('余额 ?'); return; }
        var n = Number(val);
        node.textContent = t('余额') + ' · ' + (cur === 'CNY' ? '¥' : (cur ? cur + ' ' : '')) +
          (isFinite(n) ? n.toFixed(2) : String(val));
      }).catch(function () { node.textContent = t('余额 —'); });
    }

    // Keep message-specific actions at the lower edge of the composer. This
    // leaves the transcript clear while matching the original DSH hierarchy.
    (function installComposerPicks() {
      var plus = document.getElementById('upload-button');
      if (!plus || !plus.parentNode) return;
      // ── C9：语音输入 ──────────────────────────────────────────────────────
      //
      // 放在 ＋ 旁边：它和"发消息"是同一类动作（都是把内容送进去）。
      //
      // ★ 2026-09-29 修：使用者报「开了关不了」。两个原因，都得修：
      //   ① 我把"结束"做成了"等你停顿"—— 那是**看不见摸不着**的开关，人想停的时候
      //      没有一个能按的东西。现在开始听之后，按钮自己变成明确的**停止按钮**
      //      （红色 ■，旁边还写「停止」），点一下马上停；
      //   ② 更严重的一个 bug：识别一旦报错（没听到声音、没给麦克风权限），
      //      控制器没有被清掉 —— 按钮就**永远卡在"正在听"**，再点也只会去 stop
      //      一个已经死掉的识别器。现在无论成功、报错、还是没识别到，都一定复位。
      //
      // 识别结果直接写进输入框（而不是自动发送）：说话识错字是常事，
      // 让人看一眼、改一下再发，比"说错一个字就发出去"好得多。
      if (window.DshVoice && typeof window.DshVoice.start === 'function' &&
          typeof window.DshVoice.available === 'function') {
        var mic = el('button', 'composer-pick voice-button', '🎤');
        mic.type = 'button';
        mic.id = 'voice-button';
        mic.setAttribute('aria-label', t('语音输入'));
        if (!window.DshVoice.available()) mic.classList.add('is-unavailable');
        var controller = null;
        var base = '';
        var resetTimer = null;
        var voiceEpoch = 0;
        /** 无论怎么结束，UI 必须回到"没在听" —— 这是"关不了"那一条的根治。 */
        function reset() {
          voiceEpoch++;
          if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
          controller = null;
          mic.classList.remove('is-listening');
          mic.textContent = '🎤';
          mic.removeAttribute('data-stop-label');
          mic.setAttribute('aria-label', t('语音输入'));
          mic.setAttribute('aria-pressed', 'false');
          mic.disabled = false;
        }
        /**
         * 看门狗：**连续 30 秒一点动静都没有**才强制结束。
         *
         * ★ 每来一次识别结果就重新计时 —— 这一条不能省。
         *   原来的写法是"开始后 30 秒无条件复位"，后果是：
         *   使用者说一段长话，说到 30 秒界面自己复位成 🎤、话也被掐断，
         *   他以为是"关不掉/乱跳"（原话：「我刚刚说了一长串，无法关闭」）。
         *   兜底要防的是**卡死**（识别器既不回 onend 也不回 onerror），
         *   而"还在出字"恰恰证明它活得好好的，不该打断。
         */
        function armWatchdog() {
          if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
          resetTimer = setTimeout(function () {
            var live = controller;
            reset();
            if (live) {
              // 先把识别器弄死，界面才敢显示"没在听"（顺序不能反）
              try { live.stop(); } catch (err) { /* 已经死了 */ }
              try { if (live.abort) live.abort(); } catch (err) { /* 已经死了 */ }
            }
          }, 30000);
        }
        function stop() {
          var live = controller;
          // 先复位再让它停：`stop()` 在 iOS 上未必回调 onend，
          // 等回调就等于"点了没反应"。
          reset();
          if (live) {
            try { live.stop(); } catch (err) { /* 已经死了 */ }
            // stop() 只是"请给结果"，iOS 上未必真停。再 abort 一道硬的：
            // 否则识别器会继续往输入框灌字，而按钮已经显示"没在听"了 ——
            // 使用者看到 🎤 就去点，代码以为是"开始"，于是又 start 一个，
            // 和还活着的旧识别器打架（这就是"关了开不了"）。
            setTimeout(function () { try { if (live.abort) live.abort(); } catch (err) { /* 已经死了 */ } }, 250);
          }
        }
        mic.addEventListener('click', function () {
          if (controller) { stop(); return; }
          if (!window.DshVoice.available()) { window.DshVoice.explain(); return; }
          base = refs.input.value ? refs.input.value.replace(/\s*$/, '') + ' ' : '';
          var epoch = ++voiceEpoch;
          var draftBase = base;
          function currentRecognition() { return epoch === voiceEpoch && !state.disposed; }
          controller = window.DshVoice.start({
            lang: voiceLang(),
            onPartial: function (text) {
              if (!currentRecognition()) return;
              window.DshVoice.setInputValue(refs.input, draftBase + text);
              renderControls();
              armWatchdog();          // ★ 还在出字 = 活着，重新计时，别打断长句子
            },
            onFinal: function (text) {
              if (!currentRecognition()) return;
              window.DshVoice.setInputValue(refs.input, draftBase + text);
              renderControls();
              armWatchdog();
            },
            onError: function (message) {
              if (!currentRecognition()) return;
              showError({ userMessage: message }, t('语音输入失败。'));
              reset();                 // ★ 报错也必须复位，否则按钮永远卡在"正在听"
            },
            onEnd: function () { if (currentRecognition()) reset(); }
          });
          if (controller) {
            mic.classList.add('is-listening');
            mic.textContent = '■';
            mic.setAttribute('data-stop-label', t('停止'));
            mic.setAttribute('aria-label', t('停止'));
            mic.setAttribute('aria-pressed', 'true');
            armWatchdog();
          } else {
            reset();
          }
        });
        keep(mic);
        mountCleanups.push(stop);
        plus.parentNode.insertBefore(mic, plus.nextSibling);
      }
      var holder = refs.composerPicks;
      holder.replaceChildren();
      var picks = [
        ['model', '模型', '选择模型', showModels],
        ['mode', '工具组', '工具配置', showModes],
        ['perm', '授权范围', '选择授权范围', function () { showPermissions(); }],
        ['goal', '目标', '计划/目标', showGoalModes]
      ];
      picks.forEach(function (pair) {
        var button = el('button', 'composer-pick', t(pair[1]));
        button.type = 'button';
        button.dataset.kind = pair[0];
        button.setAttribute('aria-label', t(pair[2]));
        button.addEventListener('click', pair[3]);
        holder.append(button);
      });
      composerPicksRelabel = function () {
        holder.setAttribute('aria-label',
          t('模型') + ' / ' + t('工具配置') + ' / ' + t('授权范围') + ' / ' + t('目标'));
        Array.prototype.forEach.call(holder.children, function (button, index) {
          var pair = picks[index];
          var selected = pair[0] === 'model' ? state.selection.modelSelection : null;
          button.textContent = selected && selected.model ? selected.model : t(pair[1]);
          button.setAttribute('aria-label', t(pair[2]) + (selected && selected.model ? '：' + selected.model : ''));
          button.title = pair[0] === 'mode' && state.selection.agentPreset ?
            t('当前工具配置') + '：' + state.selection.agentPreset : button.getAttribute('aria-label');
        });
        if (refs.composerBalance) refs.composerBalance.title = t('看余额');
      };
      composerPicksRelabel();
    })();

    /**
     * 语音识别该用哪个语言。
     *
     * ★ 这是一个真 bug 的修复（使用者问「除了中文，其他的能适应吗」）：
     *   原来只有「界面是中文 → 'zh-CN'，否则 → 'en'/'es' 的裸代码」。
     *   而 `SpeechRecognition.lang` 要的是 **BCP-47 标签**（`en-US`、`es-ES`），
     *   裸 `en` / `es` 在不少浏览器上会被忽略或当成不支持 ——
     *   表现就是"换成英文以后语音就不认了"。
     *
     * 另外：**语音语言跟界面语言绑在一起是不对的** —— 界面看英文的人
     * 完全可能说中文。所以设置菜单里给了单独一项（存 `dsh-voice-lang`），
     * 默认跟随界面语言。没选过就跟着界面走。
     */
    function voiceLang() {
      var chosen = '';
      try { chosen = window.localStorage.getItem('dsh-voice-lang') || ''; } catch (err) { chosen = ''; }
      if (chosen) return chosen;
      var ui = 'zh';
      try { if (window.DshI18n && window.DshI18n.lang) ui = window.DshI18n.lang(); } catch (err) { ui = 'zh'; }
      return ui === 'en' ? 'en-US' : ui === 'es' ? 'es-ES' : 'zh-CN';
    }

    /**
     * 设置菜单里那几项运行时挂上去的东西（看余额 / 连接地址 / 界面语言 / 语音语言）。
     *
     * ★ 做成**具名函数**而不是原来的 IIFE（立即执行）：
     *   这些节点是运行时挂的，切了语言必须**重建一次**才会跟着变 ——
     *   而 IIFE 只跑一次，所以它们永远停在上一种语言。
     *   使用者报的「英语，西班牙语的时候不是所有的都改变」，这几项每次都在里面。
     *   函数体本来就是"先把自己上一轮加的删掉再建"，所以重复调用是安全的。
     */
    function installSettingsExtras() {
      var menu = refs.settingsMenu;
      if (!menu) return;
      // 设置菜单是 HTML 里就有的节点，所以这里加的东西**不能用 removeChild 收走**
      // （那样会把菜单本身也拆了）。改成记账：重新挂载时先把自己上一轮加的删掉。
      Array.prototype.slice.call(menu.querySelectorAll('.menu-extra')).forEach(function (node) { node.remove(); });
      var bal = el('button', 'menu-extra', t('看余额'));
      bal.type = 'button';
      bal.addEventListener('click', showBalance);
      var addr = el('button', 'menu-extra', t('连接地址（内网/外网）'));
      addr.type = 'button';
      addr.addEventListener('click', showAddresses);
      menu.append(bal, addr);
      // C8 三种语言的切换入口。放在设置里：它不是每天要用的东西，
      // 但"猜错了还改不回来"比"猜错"更让人恼火，所以必须有个地方能改。
      if (window.DshI18n && typeof window.DshI18n.makeSwitcher === 'function') {
        var langRow = el('div', 'menu-extra lang-row');
        langRow.append(el('span', '', t('语言')));
        langRow.append(window.DshI18n.makeSwitcher());
        menu.append(langRow);
      }
      // ★ 语音识别语言**单独一项**，默认跟着界面语言。
      //   为什么不跟界面绑死：界面看英文的人完全可能说中文（反过来也一样）。
      //   原来这行是硬写的：界面中文就 zh-CN、否则发一个裸的 `en` / `es` ——
      //   而 `SpeechRecognition.lang` 要的是 BCP-47 标签（`en-US`、`es-ES`），
      //   裸代码在不少浏览器上会被忽略，表现就是"换成英文以后语音不认了"。
      if (window.DshVoice && typeof window.DshVoice.available === 'function') {
        var voiceRow = el('div', 'menu-extra lang-row');
        voiceRow.append(el('span', '', t('语音语言')));
        var voiceSelect = el('select', 'voice-lang-select');
        voiceSelect.setAttribute('aria-label', t('语音语言'));
        [['', t('跟着界面语言')], ['zh-CN', '中文'], ['en-US', 'English'], ['es-ES', 'Español'],
          ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch']]
          .forEach(function (pair) {
            var option = el('option', '', pair[1]);
            option.value = pair[0];
            voiceSelect.append(option);
          });
        try { voiceSelect.value = window.localStorage.getItem('dsh-voice-lang') || ''; }
        catch (err) { voiceSelect.value = ''; }
        voiceSelect.addEventListener('change', function () {
          try {
            if (voiceSelect.value) window.localStorage.setItem('dsh-voice-lang', voiceSelect.value);
            else window.localStorage.removeItem('dsh-voice-lang');
          } catch (err) { /* 存不了就只影响这一次 */ }
        });
        voiceRow.append(voiceSelect);
        menu.append(voiceRow);
      }
    }
    installSettingsExtras();

    // ── E3：加密状态常驻标记 ─────────────────────────────────────────────────
    //
    // 使用者 2026-09-29 反馈：**没有密钥时界面上看不到任何"加密状态"的提示** ——
    // 他只发现"发送键变灰"，不知道是地址缺了 `#k=`。这条既是可用性问题，
    // 也是安全问题：使用者必须随时知道"我现在说的话是不是加密的"。
    //
    // 怎么判：地址里有 `#k=`（或有解析出来的密钥）→ 已加密；两者都没有 → 缺密钥。
    // 为什么不在 dsh-lite-update.js 里判（那里已经有一条缺密钥的横幅）：
    // 那一条是**一次性横幅**，而这一条要常驻，好让人随时能确认 —— 两条都有用，
    // 一条负责"当场说清楚"，一条负责"以后随时能查"。
    function hasLocalKey() {
      try {
        if (typeof window.__dshE2eeSecret === 'string' && window.__dshE2eeSecret.length >= 16) return true;
        var key = /(?:^#|&)k=([^&]+)/.exec(location.hash || '');
        return !!key && decodeURIComponent(key[1]).length >= 16;
      } catch (err) { return false; }
    }
    function encryptionReadiness() {
      if (!hasLocalKey()) return 'missing';
      var e2ee = window.DshE2EE;
      try {
        if (!e2ee || typeof e2ee.available !== 'function' || !e2ee.available() ||
            typeof e2ee.encryptedFetch !== 'function' ||
            !window.WebSocket || window.WebSocket.__dshE2ee !== true ||
            typeof window.__dshE2eeSecret !== 'string' || window.__dshE2eeSecret.length < 16) return 'unavailable';
        var proof = typeof e2ee.proofState === 'function' ? e2ee.proofState() : null;
        return state.connection === 'connected' && proof && proof.ok === true ? 'on' : 'pending';
      } catch (err) { return 'unavailable'; }
    }
    function updateCryptoChip() {
      checkLocalUploadPreviewKey();
      var node = refs.cryptoChip;
      if (!node) return;
      var readiness = encryptionReadiness();
      node.hidden = false;
      node.dataset.state = readiness === 'on' ? 'on' : readiness === 'pending' ? 'pending' : 'off';
      var title = readiness === 'on' ? t('已加密') : readiness === 'missing' ? t('缺密钥') :
        readiness === 'pending' ? t('加密待验证') : t('加密未就绪');
      node.textContent = (readiness === 'on' ? '🔒 ' : readiness === 'pending' ? '◷ ' : '⚠️ ') + title;
      node.setAttribute('aria-label', title);
    }
    function explainCrypto() {
      var readiness = encryptionReadiness();
      overlay(t('连接安全'), function (body) {
        if (readiness === 'on') {
          body.append(el('p', 'panel-line', t('已验证内容加密通道和设备授权。被动中继只能转发密文，不能读取对话正文。')));
          body.append(el('p', 'panel-line', t('页面代码由电脑桥提供；请使用你信任的桥和完整连接地址。加密不代表可以信任被篡改的页面。')));
        } else if (readiness === 'pending') {
          body.append(el('p', 'panel-line', t('加密组件已就绪，正在等待内容连接和设备授权验证。请先检查电脑和连接地址是否在线。')));
        } else if (readiness === 'unavailable') {
          body.append(el('p', 'panel-line', t('加密组件尚未就绪。请使用 HTTPS 完整地址，并更新或重新打开桥页面。不会改用明文发送。')));
        } else body.append(el('p', 'panel-line', t('这条地址里没有加密密钥，所以内容通道用不了 —— 发送键会变灰、对话也加载不出来。请用带 #k= 的完整地址重新打开（电脑控制台里的「复制链接」给出的那条）。')));
        // 备选：能连上内网时，那条地址自带密钥 —— 直接给出可点的入口。
        var lan = el('button', 'screen-action', t('连接地址（内网/外网）'));
        lan.type = 'button';
        lan.addEventListener('click', function () { showAddresses(); });
        body.append(lan);
      });
    }
    (function installCryptoChip() {
      updateCryptoChip();
      if (refs.cryptoChip) {
        refs.cryptoChip.type = 'button';
        refs.cryptoChip.hidden = false;
        listen(refs.cryptoChip, 'click', explainCrypto);
      }
      // 密钥可能比界面晚一步解析出来（e2ee.js 是 defer 的），所以多判几次；
      // 从后台切回来时再判一次 —— 那时候 `#k=` 一定已经在了。
      var tries = 0;
      var timer = setInterval(function () {
        updateCryptoChip();
        if (++tries >= 10 || (window.__dshE2eeSecret && refs.cryptoChip &&
            refs.cryptoChip.dataset.state === 'on')) clearInterval(timer);
      }, 600);
      mountTimers.push(timer);
      mountTimers.push(setInterval(function () { if (!document.hidden) updateCryptoChip(); }, 10000));
      listen(document, 'visibilitychange', function () { if (!document.hidden) updateCryptoChip(); });
      listen(window, 'hashchange', function () { clearDownloadUrls(); renderRecords(); updateCryptoChip(); });
    })();

    // 队列轮询。为什么需要它：DSH **没有**推送 inbox 投影的事件
    //（`$events` 里 27 个可订阅事件没有一个带投影），而读队列的唯一 RPC 是
    // `session/projections`。所以"别人在电脑端往队列里塞了一条"这种情况，
    // 只有轮询才看得到。
    //
    // 什么时候轮询：**只在任务进行中、且页面在前台时** —— 队列只在有任务时
    // 才会变，空闲时轮询是白耗流量（手机上这点很实在）。
    mountTimers.push(setInterval(function () {
      if (document.hidden) return;
      if (!state.sessionId || !state.running) return;
      refreshQueue();
      refreshGoal();   // 目标也可能在电脑端被改了，顺手对齐
      refreshSelection();
    }, 10000));

    // ── C8：换语言之后要把界面重画一遍 ──────────────────────────────────────
    //
    // 静态那几个（侧栏标题、按钮）由 i18n.js 的 data-i18n 机制处理；
    // 但对话列表、记录、输入区动作、错误条这些是**渲染时**取词的，
    // 不重画就还留着旧语言。所以这里挂上 onLangChange（i18n.js 在
    // applyAll 里会调它）重新渲染一遍。
    window.onLangChange = function () {
      try {
        renderProjects(); renderSessions(); renderTitle(); renderRecords(false, true);
        renderInteractions(); renderControls(); renderUploads(); renderQueue();
        renderFiles(); renderFilePreview();
        renderGoalBar();
        // 设置菜单里那几项是运行时挂的，必须重建才会跟着变；
        // 文件模态框同理（它平时是隐藏的，但打开时也得是新语言）。
        installSettingsExtras();
        // 空状态那行字（「这段对话还没有消息。」「正在加载对话内容…」）在
        // renderEmpty 里，它**不在**上面任何一条 render* 的调用链上，得单独点名。
        renderEmpty();
        // 「重试读取」这个按钮是**一次性建出来的**（不在 render* 里），
        // 所以得单独把文案改过来。
        if (refs.filesRetry) refs.filesRetry.textContent = t('重试读取');
        updateCryptoChip(); composerPicksRelabel(); relabelStatus();
        loadBalance(refs.composerBalance);
        var jump = document.querySelector('.jump-bottom');
        if (jump) jump.textContent = t('↑ 回到底部').replace(/^↑/, '↓');
        // 语音按钮的说明文字也要跟着换（它平时只显示一个 🎤，
        // 但无障碍标签和"停止"状态是文字）。
        var mic = document.getElementById('voice-button');
        if (mic && !mic.classList.contains('is-listening')) {
          mic.setAttribute('aria-label', t('语音输入'));
        }
        // ★ 最后再套一遍 data-i18n。
        //
        //   为什么必须放在**重渲染之后**：上面这些 render* 会**新建 DOM**
        //   （设置菜单里的按钮、交互卡片、文件列表…），而 i18n.js 的 applyAll()
        //   是在 setLang 里、**这些新元素出现之前**跑的 —— 新元素自然没被翻译。
        //   i18n.js 自己的注释就写着「新增的 DOM 要再调一次」，只是一直没人调。
        //   少了这一句，表现就是使用者说的「不是所有的都改变」。
        if (window.DshI18n && typeof window.DshI18n.apply === 'function') {
          window.DshI18n.apply(document);
        }
      } catch (err) { /* 重画失败不该影响切换语言本身 */ }
    };

    // ── C12：排队消息 ─────────────────────────────────────────────────────────
    //
    // 使用者原话：「在任务执行的时候发送信息，在手机端不显示，其实应该是发出去了
    // 在电脑端排队」。要做的不只是"显示"，还要能像电脑端一样对每条排队消息
    // 选择 **立即执行 / 修改 / 删除**（对应 DSH 的 steer / edit / remove）。
    //
    // 数据从哪来：适配器把 DSH 的 inbox 投影（`next-turn` + `next-step`）整理成
    // `state.queued`；投影一变就会推一次事件（见 handleEvent 的 'queue'）。
    function queueItemText(item) {
      return typeof item.text === 'string' ? item.text : '';
    }
    function queueAction(id, action, node, note) {
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var edit = action.kind === 'edit' && state.queueEditing && state.queueEditing.id === id ? state.queueEditing : null;
      if (edit) { edit.pending = true; edit.uncertain = false; edit.submitted = action.content[0].text; edit.feedback = ''; }
      if (node) node.disabled = true;
      Promise.resolve().then(function () { return adapter.updateQueueItem(sessionId, id, action); }).then(function () {
        return adapter.listQueued(sessionId);
      }).then(function (items) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion) return;
        if (!Array.isArray(items)) throw new Error(t('排队结果暂时无法确认，请重新读取。'));
        state.queued = items;
        if (edit && state.queueEditing === edit) {
          var found = items.find(function (item) { return safeId(item && item.id) === id; });
          if (!found || queueItemText(found) === edit.submitted) state.queueEditing = null;
          else {
            edit.pending = false; edit.uncertain = true;
            edit.feedback = t('排队结果暂时无法确认，请重新读取。');
          }
        }
        renderQueue();
      }).catch(function (err) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion) return;
        if (edit && state.queueEditing === edit) {
          edit.pending = false; edit.uncertain = true;
          edit.feedback = t('修改结果未确认，文字已保留。请先重新读取队列。');
          renderQueue();
          return;
        }
        if (note) note.textContent = ((err && err.message) || '') || '';
        if (node) node.disabled = false;
      });
    }
    /**
     * 排队消息的编辑框。
     *
     * ★ 为什么单独抽出来、而且内容从 state 恢复：
     *   队列在任务进行中**每 10 秒自动刷新一次**，而刷新会 `replaceChildren()`
     *   重建整个列表 —— 编辑框、已经打的字、光标位置全没了。使用者看到的就是
     *   「修改排队中的命令时被强制打断，需要重新按修改」。
     *   所以编辑态必须存在 state 里，重渲染时照它把编辑框原样重建出来。
     */
    function buildQueueEditor(item, note) {
      var id = safeId(item && item.id);
      var draft = state.queueEditing && state.queueEditing.id === id ? state.queueEditing : null;
      var area = el('textarea', 'queue-edit');
      area.rows = 2;
      area.value = draft ? draft.text : queueItemText(item);
      area.disabled = !!(draft && draft.pending);
      // 打字时只更新草稿，**不重渲染** —— 重渲染会丢焦点和光标。
      area.addEventListener('input', function () {
        if (state.queueEditing && state.queueEditing.id === id) {
          state.queueEditing.text = area.value;
          state.queueEditing.caret = area.selectionStart;
        }
      });
      var save = el('button', 'queue-action', t('保存'));
      save.type = 'button';
      save.disabled = !!(draft && (draft.pending || draft.uncertain));
      save.addEventListener('click', function () {
        var value = area.value.trim();
        if (!value) { note.textContent = t('这条排队消息不能改成空的。'); return; }
        save.disabled = true;
        area.disabled = true;
        cancel.disabled = true;
        queueAction(id, { kind: 'edit', content: [{ type: 'text', text: value }] }, save, note);
      });
      var cancel = el('button', 'queue-action', t('取消'));
      cancel.type = 'button';
      cancel.disabled = !!(draft && draft.pending);
      cancel.addEventListener('click', function () {
        state.queueEditing = null;                 // 放弃草稿
        renderQueue();
      });
      var box = el('div', 'queue-edit-box');
      box.append(area, save, cancel);
      if (draft && draft.feedback) note.textContent = draft.feedback;
      if (draft && draft.uncertain) {
        var read = el('button', 'queue-action', t('重新读取队列'));
        read.type = 'button';
        read.addEventListener('click', function () {
          var sessionId = state.sessionId, contextVersion = state.contextVersion;
          read.disabled = true;
          area.disabled = true;
          cancel.disabled = true;
          Promise.resolve().then(function () { return adapter.listQueued(sessionId); }).then(function (items) {
            if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || state.queueEditing !== draft) return;
            if (!Array.isArray(items)) throw new Error(t('排队结果暂时无法确认，请重新读取。'));
            state.queued = items;
            var found = items.find(function (item) { return safeId(item && item.id) === id; });
            if (!found || queueItemText(found) === draft.submitted) state.queueEditing = null;
            else { draft.uncertain = false; draft.feedback = t('已重新读取队列，请检查后保存。'); }
            renderQueue();
          }).catch(function () {
            if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || state.queueEditing !== draft) return;
            draft.feedback = t('排队结果暂时无法确认，请重新读取。');
            renderQueue();
          });
        });
        box.append(read);
      }
      // 重建之后把焦点和光标放回原处 —— 否则每次自动刷新都像"被打断了一下"
      if (draft) {
        setTimeout(function () {
          if (!area.isConnected) return;
          try {
            area.focus();
            var caret = Number.isSafeInteger(draft.caret) ? draft.caret : area.value.length;
            area.setSelectionRange(caret, caret);
          } catch (err) { /* 焦点抢不回来就算了，字还在 */ }
        }, 0);
      }
      return box;
    }
    function renderQueue() {
      var panel = refs.queuePanel, list = refs.queueList;
      if (!panel || !list) return;
      if (refs.queueTitle) refs.queueTitle.textContent = t('排队中（会在这一轮结束后发出）');
      var items = Array.isArray(state.queued) ? state.queued : [];
      if (!items.length) {
        panel.hidden = true;
        list.replaceChildren();
        state.queueEditing = null;        // 队列空了，草稿也没意义了
        return;
      }
      panel.hidden = false;
      list.replaceChildren();
      items.forEach(function (item) {
        var id = safeId(item && item.id);
        if (!id) return;
        var row = el('li', 'queue-item');
        var note = el('div', 'queue-note', '');
        // ★ 正在改的那一条：保持编辑态，不画成普通行（理由见 buildQueueEditor）
        if (state.queueEditing && state.queueEditing.id === id) {
          row.append(buildQueueEditor(item, note), note);
          list.append(row);
          return;
        }
        var text = el('div', 'queue-text', queueItemText(item));
        var actions = el('div', 'queue-actions');
        function action(kind, caption, run) {
          var button = el('button', 'queue-action', caption);
          button.type = 'button';
          button.dataset.kind = kind;
          button.addEventListener('click', function () { run(button, note); });
          actions.append(button);
          return button;
        }
        // 「立即执行」= steer：把这条从队列里拿出来插进当前这一轮。
        action('steer', t('立即执行'), function (button) {
          queueAction(id, { kind: 'steer' }, button, note);
        });
        action('edit', t('修改'), function () {
          var body = queueItemText(item);
          // 进编辑态就把内容存进 state —— 之后任何自动刷新都不会把它冲掉
          state.queueEditing = { id: id, text: body, caret: body.length };
          renderQueue();
        });
        action('remove', t('删除'), function (button) {
          queueAction(id, { kind: 'remove' }, button, note);
        });
        row.append(text, actions, note);
        list.append(row);
      });
    }
    function refreshQueue() {
      // ★ 正在改排队消息时**不要刷新**：刷新会重建列表，把使用者正在打的字冲掉。
      //   （他报的「被强制打断，需要重新按修改」就是这个。）
      //   保存或取消之后 queueEditing 会清掉，刷新自然恢复。
      if (state.queueEditing) return;
      var sessionId = state.sessionId;
      var contextVersion = state.contextVersion;
      var request = ++state.queueRequest;
      if (!sessionId || typeof adapter.listQueued !== 'function') {
        state.queued = [];
        renderQueue();
        return Promise.resolve();
      }
      state.queueLoading = true;
      return Promise.resolve().then(function () { return adapter.listQueued(sessionId); }).then(function (items) {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || request !== state.queueRequest) return;
        state.queueLoading = false;
        if (state.queueEditing) return;   // 请求飞在路上时使用者点了「修改」→ 这次结果丢掉
        if (Array.isArray(items)) state.queued = items;
        renderQueue();
      }).catch(function () {
        if (state.sessionId !== sessionId || state.contextVersion !== contextVersion || request !== state.queueRequest) return;
        // 读不到就什么都不显示 —— 这是**附加信息**，不该因为它失败而报错打扰人。
        state.queueLoading = false;
        if (state.queueEditing) return;
        renderQueue();
      });
    }
    renderQueue();

    // ── 一键滑到最下 ──────────────────────────────────────────────────────────
    //
    // 对话一长，往回翻之后就没有回去的路了：手机上的滚动条又细又难拖，
    // 流式输出时更是眼看着新内容在下面刷。做成右下角的浮动按钮 ——
    // **离底部远了才出现**，不挡视线；点一下回到底部。
    //
    // Place it at the bottom of a roomy record area. If goal/queue/error panels
    // leave less than 176px for history, dock it in the existing tab bar so it
    // cannot cover the transcript's copy/file controls.
    (function installJumpToBottom() {
      var list = refs.records;
      if (!list) return;
      var jump = el('button', 'jump-bottom', t('↑ 回到底部').replace(/^↑/, '↓'));
      jump.type = 'button';
      jump.hidden = true;
      keep(jump);
      refs.chat.append(jump);
      var tabs = refs.tabConversation && refs.tabConversation.parentNode;
      function atBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 120; }
      function position() {
        var chatBox = refs.chat.getBoundingClientRect();
        var listBox = list.getBoundingClientRect();
        var docked = !!tabs && listBox.height < 176;
        jump.classList.toggle('is-docked', docked);
        if (tabs) tabs.classList.toggle('has-docked-jump', docked && !jump.hidden);
        var parent = docked ? tabs : refs.chat;
        if (jump.parentNode !== parent) parent.append(jump);
        jump.style.bottom = docked ? '' : Math.max(12, Math.round(chatBox.bottom - listBox.bottom + 12)) + 'px';
      }
      function refresh() { jump.hidden = atBottom(); position(); }
      listen(list, 'scroll', refresh);
      listen(window, 'resize', refresh);
      jump.addEventListener('click', function () {
        list.scrollTop = list.scrollHeight;   // 贴到底
        refresh();
      });
      // 流式输出会不断插入新节点，光靠 scroll 事件来不及更新按钮状态
      if (typeof MutationObserver === 'function') {
        var changes = new MutationObserver(refresh);
        changes.observe(list, { childList: true, subtree: true });
        mountObservers.push(changes);
      }
      if (typeof ResizeObserver === 'function') {
        var sizes = new ResizeObserver(position);
        sizes.observe(refs.chat);
        sizes.observe(list);
        mountObservers.push(sizes);
      }
      refresh();
    })();
    listen(refs.railSearch, 'click', function () {
      closeSettingsMenu();
      var opening = refs.search.hidden;
      refs.search.hidden = !opening;
      refs.railSearch.setAttribute('aria-pressed', String(opening));
      if (opening) { setSidebar(true); refs.search.focus(); }
      else { refs.search.value = ''; renderProjects(); renderSessions(); }
    });
    listen(refs.search, 'input', function () { renderProjects(); renderSessions(); });
    listen(refs.railSettings, 'click', function () {
      refs.settingsMenu.hidden = !refs.settingsMenu.hidden;
      refs.railSettings.setAttribute('aria-expanded', String(!refs.settingsMenu.hidden));
    });
    listen(refs.sidebarClose, 'click', function () { setSidebar(false); });
    listen(refs.sidebarBackdrop, 'click', function () { setSidebar(false); });
    function openProjectModal() {
      closeSettingsMenu();
      projectMessage('', false);
      refs.modal.hidden = false;
      refs.projectPath.focus();
    }
    listen(refs.newProject, 'click', openProjectModal);
    listen(refs.railNewProject, 'click', openProjectModal);
    listen(refs.projectCancel, 'click', function () { refs.modal.hidden = true; });
    listen(refs.newSession, 'click', createSession);
    listen(refs.railNewSession, 'click', createSession);
    listen(refs.projectForm, 'submit', createProject);
    listen(refs.browseFolder, 'click', function () { loadDirectory(refs.projectPath.value.trim()); });
    listen(refs.filesOpen, 'click', function () {
      if (refs.filesOpen.disabled) return;
      var project = currentProject();
      refs.filesProject.textContent = project ? label(project.name, '项目') : '当前项目';
      refs.filesModal.hidden = false;
      state.filesStack = [];
      state.filesPath = '';
      refs.filesFilter.value = '';
      state.filesEntries = [];
      state.filesNextOffset = null;
      state.filesRetry = null;
      loadFiles('', false);
    });
    listen(refs.filesClose, 'click', function () { refs.filesModal.hidden = true; state.filesLoad++; });
    listen(refs.filesUp, 'click', async function () {
      if (!state.filesStack.length || state.filesLoading) return;
      var previous = state.filesStack.pop();
      var current = state.filesPath;
      var sessionId = state.sessionId;
      var expected = state.filesLoad + 1;
      if (!await loadFiles(previous, false) && state.sessionId === sessionId &&
          state.filesLoad === expected && !refs.filesModal.hidden) {
        state.filesStack.push(previous); state.filesPath = current; renderFiles();
      }
    });
    listen(refs.filesMore, 'click', function () { if (!state.filesLoading) loadFiles(state.filesPath, true); });
    listen(refs.filesFilter, 'input', renderFiles);
    listen(refs.filesRetry, 'click', async function () {
      if (state.filesLoading || !state.filesRetry) return;
      var retry = state.filesRetry;
      var previous = state.filesPath;
      var enteringFolder = !retry.append && retry.path !== previous;
      if (enteringFolder) state.filesStack.push(previous);
      if (!await loadFiles(retry.path, retry.append) && enteringFolder) state.filesStack.pop();
      renderFiles();
    });
    listen(refs.tabConversation, 'click', function () { setTab('conversation'); });
    listen(refs.tabActivity, 'click', function () { setTab('activity'); });
    listen(refs.loadOlder, 'click', loadOlder);
    listen(refs.stop, 'click', stopSession);
    listen(refs.composer, 'submit', send);
    listen(refs.upload, 'click', function () { refs.uploadInput.click(); });
    listen(refs.uploadInput, 'change', uploadFiles);
    listen(refs.input, 'input', function () { saveCurrentDraft(); renderControls(); });
    listen(refs.input, 'keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing) return;
      var shortcut = event.ctrlKey || event.metaKey;
      var mobileInput = window.innerWidth <= 700 || navigator.maxTouchPoints > 0 ||
        (typeof window.matchMedia === 'function' && window.matchMedia('(pointer:coarse)').matches);
      // The phone keyboard's Return inserts a newline. Sending stays an explicit
      // button action; Ctrl/Cmd+Enter remains an intentional keyboard shortcut.
      if (!shortcut && (mobileInput || event.shiftKey)) return;
      event.preventDefault(); refs.composer.requestSubmit();
    });
    listen(document, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      var overlays = document.querySelectorAll('.screen-overlay');
      if (overlays.length) {
        var top = overlays[overlays.length - 1];
        if (top.__liteClose) top.__liteClose();
      } else if (!refs.modal.hidden) refs.modal.hidden = true;
      else if (!refs.filesModal.hidden) { refs.filesModal.hidden = true; state.filesLoad++; }
      else if (!refs.settingsMenu.hidden) {
        refs.settingsMenu.hidden = true;
        refs.railSettings.setAttribute('aria-expanded', 'false');
      } else if (!refs.search.hidden) refs.railSearch.click();
    });
    // The upstream classic page does not use Lite's encrypted content wrapper.
    // Keep old IDs harmless for cached markup without advertising that route.
    [refs.classic, refs.settingsClassic].forEach(function (link) {
      if (!link) return;
      link.hidden = true;
      link.removeAttribute('href');
      link.setAttribute('aria-hidden', 'true');
    });
    renderProjects(); renderSessions(); renderTitle(); renderInteractions(); renderControls();
    setSidebar(true);
    connect();
    var controller = {
      dispose: function () {
        createStage('disposed');
        state.disposed = true;
        state.connecting++;
        state.filesLoad++;
        mountCleanups.forEach(function (cleanup) { try { cleanup(); } catch (_) {} });
        clearDownloadUrls();
        listeners.forEach(function (entry) { entry[0].removeEventListener(entry[1], entry[2]); });
        mountTimers.forEach(function (timer) { clearInterval(timer); });
        mountObservers.forEach(function (observer) { observer.disconnect(); });
        // 自己建出来的浮层也要收走 —— 否则重新挂载会留下"看得见、点了没用"的旧按钮。
        mountNodes.forEach(function (node) {
          try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (err) { /* 已经不在文档里 */ }
        });
        mountNodes.length = 0;
        if (typeof adapter.disconnect === 'function') Promise.resolve(adapter.disconnect()).catch(function () {});
      },
      reconnect: connect
    };
    active = controller;
    return controller;
  }

  function start() {
    if (window.__dshLiteDeferAutoMount === true) {
      $('connection-status').textContent = '正在识别 DSH 版本';
      return;
    }
    if (window.DshLiteAdapter) {
      mount(window.DshLiteAdapter);
    } else {
      var status = $('connection-status');
      status.textContent = '连接组件不可用';
      status.dataset.state = 'disconnected';
      $('error-text').textContent = 'DSH 手机版的连接组件未加载。请重新打开页面，或检查桥是否已更新。';
      $('error-banner').hidden = false;
      $('error-retry').onclick = function () { location.reload(); };
      $('reconnect').onclick = function () { location.reload(); };
    }
  }
  window.DshLiteUI = { mount: mount };
  document.addEventListener('dsh-lite-adapter-ready', function () {
    if (window.__dshLiteDeferAutoMount !== true && window.DshLiteAdapter && !active) mount(window.DshLiteAdapter);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
