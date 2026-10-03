'use strict';

// Isolated browser/DOM check. No DSH process, gateway, credentials or external
// network is used; an in-memory adapter implements the documented UI contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module);
isolated.filename = browserFile;
isolated.paths = module.paths;
isolated._compile(fs.readFileSync(browserFile, 'utf8').replace('    sweepOrphanBrowsers();', '    // Isolated test: do not sweep other tasks\' browsers.'), browserFile);
const { Browser } = isolated.exports;

const fakeAdapter = `
window.__fake = { calls: [], onEvent: null };
window.DshLiteAdapter = {
  capabilities: {interactiveReplies:true},
  async disconnect() {},
  async connect(onEvent) { window.__fake.onEvent = onEvent; onEvent({type:'status',state:'connected'}); },
  async listProjects() { return [{id:'p1',name:'测试项目',path:'D:/example'}]; },
  async listSessions(projectId) { window.__fake.calls.push(['listSessions',projectId]); return projectId === 'p2' ? [] : [{id:'s1',title:'昨天的对话'}]; },
  async loadSession(sessionId) { window.__fake.calls.push(['loadSession',sessionId]); if (sessionId === 's2') { window.__fake.onEvent({type:'records',sessionId,records:[],hasMore:false}); return {hasMore:false,records:[]}; } return {hasMore:true,records:[{id:'m1',role:'assistant',text:'<img src=x onerror=alert(1)>',attachments:[{name:'report.txt',path:'D:/example/report.txt'},{name:'unknown.txt',size:2048}]}]}; },
  async loadOlder(sessionId) { window.__fake.calls.push(['loadOlder',sessionId]); window.__fake.onEvent({type:'records',sessionId,hasMore:false,records:[{id:'old',role:'user',text:'更早的消息'},{id:'m1',role:'assistant',text:'<img src=x onerror=alert(1)>'}]}); return {hasMore:false}; },
  async createProject(value) { window.__fake.calls.push(['createProject',value.path]); return {id:'p2'}; },
  async createSession(value) { window.__fake.calls.push(['createSession',value.projectId]); return {id:'s2'}; },
  async sendMessage(value) { window.__fake.calls.push(['sendMessage',value.sessionId,value.text,value.attachments]); },
  async uploadFile(value) { window.__fake.calls.push(['uploadFile',value.sessionId,value.file.name]); return {receiptId:'receipt-1',file:{name:value.file.name,attachmentId:'file-1',bytes:value.file.size}}; },
  async downloadFile(value) { window.__fake.calls.push(['downloadFile',value.sessionId,value.path]); return {blob:new Blob(['ok']),name:'report.txt'}; },
  async listWorkspaceFiles(value) { window.__fake.calls.push(['listWorkspaceFiles',value.sessionId,value.path,value.offset]); if(window.__fake.failFiles) throw {userMessage:'文件浏览服务未启用'}; return value.path === 'src' ? {path:'src',entries:[{name:'app.js',path:'src/app.js',type:'file',bytes:2}],nextOffset:null} : value.offset ? {path:'',entries:[{name:'more.txt',path:'more.txt',type:'file',bytes:2}],nextOffset:null} : {path:'',entries:[{name:'src',path:'src',type:'directory'},{name:'report.txt',path:'report.txt',type:'file',bytes:2}],nextOffset:2}; },
  async listDirectories(path) { window.__fake.calls.push(['listDirectories',path]); return path ? {path,parent:null,roots:[],directories:[{name:'child',path:path+'/child'}]} : {path:'',parent:null,roots:[{name:'D:',path:'D:/'}],directories:[]}; },
  async cancelSession(sessionId) { window.__fake.calls.push(['cancelSession',sessionId]); },
  async respondToInteraction(value) { window.__fake.calls.push(['respond',value.id,value.answer]); },
  // J 压缩上下文：走 DSH 的命令 RPC（不是把 /compact 当消息发出去）。
  async listCommands(sessionId) { window.__fake.calls.push(['listCommands',sessionId]);
    return [{name:'compact',description:'Compact older conversation history'},{name:'plan',description:'plan mode'}]; },
  async runCommand(sessionId,line) { window.__fake.calls.push(['runCommand',sessionId,line]);
    return {commandId:'cmd-1',result:{kind:'success',text:'已压缩'}}; },
  // C12 排队消息：默认空队列，具体用例里再改。
  async listQueued(sessionId) { window.__fake.calls.push(['listQueued',sessionId]); return window.__fake.queued || []; },
  async updateQueueItem(sessionId,itemId,action) { window.__fake.calls.push(['updateQueueItem',sessionId,itemId,action.kind]);
    return {accepted:true}; },
  // C3/C20/C4：形状对齐 DSH 的真实 schema（provider + model + reasoningEffort）。
  async listModels() { window.__fake.calls.push(['listModels']);
    return [{id:'m1',name:'模型一号（组A）',provider:'group-a',defaultEffort:'max',
      efforts:[{id:'off',name:'Off'},{id:'max',name:'Max'}]}]; },
  async selectModel(sessionId,modelId,effort,provider) {
    window.__fake.calls.push(['selectModel',sessionId,modelId,effort || '',provider || '']); },
  async listModes() { window.__fake.calls.push(['listModes']); return [{id:'standard',name:'标准'},{id:'creative',name:'创造'}]; },
  async selectMode(sessionId,presetId) { window.__fake.calls.push(['selectMode',sessionId,presetId]); },
  // C26 目标：读走 session/projections（替身直接给结果），改走 goals/*
  async readGoal(sessionId) {
    window.__fake.calls.push(['readGoal',sessionId]);
    return window.__fake.goal || null;
  },
  async goalAction(sessionId,kind,payload) {
    window.__fake.calls.push(['goalAction',sessionId,kind,payload && payload.objective,payload && payload.revision]);
    const g = window.__fake.goal;
    const bump = (patch) => { window.__fake.goal = Object.assign({}, g, patch, { revision: (g ? g.revision : 0) + 1 }); };
    if (kind === 'clear') window.__fake.goal = null;
    else if (kind === 'create') window.__fake.goal = { id:'g1', revision:1, objective:payload.objective, phase:'active', blockedReason:'', maxGoalRounds:0 };
    else if (kind === 'edit') bump({ objective: payload.objective });
    else if (kind === 'pause') bump({ phase: 'paused' });
    else if (kind === 'resume') bump({ phase: 'active' });
    else if (kind === 'complete') bump({ phase: 'complete' });
    return { ok: true };
  }
};
// C9 语音输入的替身。**必须在页面脚本跑之前就挂上**（dsh-lite-ui.js 会检查它）。
// 曾经这份替身和它的测试被一次错误的双向同步覆盖掉过 —— 所以这里写清楚：
// 它测的是"按钮到底关不关得掉"，那正是使用者报过的 bug。
window.__voice = { started: 0, stopped: 0, aborted: 0, stalled: false, handlers: null, fail: false, unavailable: false, explained: 0 };
window.DshVoice = {
  available() { return !window.__voice.unavailable; },
  explain() { window.__voice.explained++; },
  start(options) {
    window.__voice.started++;
    window.__voice.handlers = options;
    if (window.__voice.fail) {
      // 模拟"一开口就报错"（没给麦克风权限 / 没听到声音）——
      // 这条路径以前会让按钮永远卡在"正在听"。
      options.onError('测试：没听到声音');
      options.onEnd('');
      return null;
    }
    return { stop() { window.__voice.stopped++; if (!window.__voice.stalled && options.onEnd) options.onEnd(''); },
      abort() { window.__voice.aborted++; if (!window.__voice.stalled && options.onEnd) options.onEnd(''); } };
  },
  setInputValue(input, text) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
};
`;

async function run() {
  process.env.TEMP = 'D:/bridge-codex-test-temp';
  process.env.TMP = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const requested = [];
  const files = {
    '/dsh-lite.html': ['text/html; charset=utf-8', path.join(root, 'pwa/dsh-lite.html')],
    '/dsh-lite.css': ['text/css; charset=utf-8', path.join(root, 'pwa/dsh-lite.css')],
    '/dsh-lite-ui.js': ['text/javascript; charset=utf-8', path.join(root, 'pwa/dsh-lite-ui.js')],
    // 三语言（C8）走的是**真文件**：词条在 dsh-lite-lang.js，机制在 i18n.js，
    // 用替身测就等于什么都没测。
    '/i18n.js': ['text/javascript; charset=utf-8', path.join(root, 'pwa/i18n.js')],
    '/dsh-lite-lang.js': ['text/javascript; charset=utf-8', path.join(root, 'pwa/dsh-lite-lang.js')],
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requested.push(pathname);
    if (pathname === '/e2ee.js' || pathname === '/dsh-lite-adapter.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(pathname === '/e2ee.js' ? '' : fakeAdapter);
      return;
    }
    const entry = files[pathname];
    if (!entry) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': entry[0] });
    res.end(fs.readFileSync(entry[1]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await Browser.launch();
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    let state = await page.eval(`({status:document.getElementById('connection-status').textContent,project:document.getElementById('project-list').textContent,session:document.getElementById('session-list').textContent})`);
    assert.equal(state.status, '已连接');
    assert.match(state.project, /测试项目/);
    assert.match(state.session, /昨天的对话/);

    await page.eval(`document.querySelector('#session-list button').click()`);
    state = await page.eval(`({title:document.getElementById('session-title').textContent,text:document.querySelector('.record-text')?.textContent,images:document.querySelectorAll('#record-list img').length,composerDisabled:document.getElementById('message-input').disabled})`);
    assert.equal(state.title, '昨天的对话');
    assert.match(state.text, /<img src=x/);
    assert.equal(state.images, 0);
    assert.equal(state.composerDisabled, false);
    state = await page.eval(`({files:[...document.querySelectorAll('.record-file')].map(x=>({name:x.textContent,tag:x.tagName})),actions:document.querySelectorAll('.record-attachments button,.record-attachments a').length})`);
    assert.equal(state.files[0].tag, 'BUTTON');
    assert.equal(state.files[1].tag, 'SPAN');
    assert.match(state.files[1].name, /unknown\.txt · 2048 B/);
    assert.equal(state.actions, 1);
    await page.eval(`document.querySelector('.record-file').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`({href:document.querySelector('a.record-file')?.href,name:document.querySelector('a.record-file')?.download})`);
    assert.ok(state.href.startsWith('blob:'));
    assert.equal(state.name, 'report.txt');
    const downloadCalls = await page.eval(`window.__fake.calls`);
    assert.ok(downloadCalls.some(x => x[0] === 'downloadFile' && x[2] === 'D:/example/report.txt'));
    await page.eval(`document.getElementById('files-open').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`({list:document.getElementById('files-list').textContent,more:document.getElementById('files-more').hidden})`);
    assert.match(state.list, /src/);
    assert.equal(state.more, false);
    await page.eval(`document.querySelector('#files-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`document.getElementById('files-list').textContent`);
    assert.match(state, /app.js/);
    await page.eval(`document.getElementById('files-up').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    await page.eval(`document.getElementById('files-more').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`document.getElementById('files-list').textContent`);
    assert.match(state, /more.txt/);
    await page.eval(`document.querySelectorAll('#files-list button')[1].click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`({link:document.querySelector('#files-list a')?.href,status:document.getElementById('files-status').textContent})`);
    assert.ok(state.link.startsWith('blob:'));
    assert.match(state.status, /点“保存”/);
    assert.equal(await page.eval(`document.querySelector('#files-preview pre')?.textContent`), 'ok',
      'a clicked text file should be readable before saving');
    await page.eval(`document.getElementById('files-close').click()`);
    await page.eval(`window.__fake.failFiles=true;document.getElementById('files-open').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`document.getElementById('files-status').textContent`);
    assert.match(state, /文件浏览服务未启用/);
    await page.eval(`window.__fake.failFiles=false;document.getElementById('files-close').click()`);
    state = await page.eval(`({classic:new URL(document.getElementById('classic-view').href).searchParams.get('view'),older:document.getElementById('history-bar').hidden})`);
    assert.equal(state.classic, 'classic');
    assert.equal(state.older, false);
    if (process.argv.includes('--screenshot')) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
      const target = 'D:/桥/codex-joint-verification/dsh-lite-mobile.png';
      fs.writeFileSync(target, Buffer.from(screenshot.data, 'base64'));
      console.log('Mobile screenshot: ' + target);
    }

    await page.eval(`(async()=>{let x=document.getElementById('message-input');x.value='测试指令';x.dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();await new Promise(r=>setTimeout(r,30));})()`);
    let calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'sendMessage' && x[1] === 's1' && x[2] === '测试指令'));

    await page.eval(`window.__fake.onEvent({type:'record',sessionId:'s1',record:{id:'thought-1',role:'thought',title:'思考',text:'正在检查'}});document.getElementById('tab-activity').click();window.__fake.onEvent({type:'record',sessionId:'s1',record:{id:'thought-1',role:'thought',title:'思考',text:'检查完成'}})`);
    state = await page.eval(`({text:document.getElementById('record-list').textContent,count:document.querySelectorAll('#record-list .record').length})`);
    assert.match(state.text, /检查完成/);
    assert.equal(state.count, 1);
    await page.eval(`document.getElementById('tab-conversation').click();document.getElementById('load-older').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`({text:document.getElementById('record-list').textContent,older:document.getElementById('history-bar').hidden})`);
    assert.match(state.text, /更早的消息/);
    assert.equal(state.older, true);

    await page.eval(`(async()=>{const input=document.getElementById('upload-input');const transfer=new DataTransfer();transfer.items.add(new File(['abc'],'note.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,30));})()`);
    state = await page.eval(`({pending:document.getElementById('attachment-list').textContent,enabled:!document.getElementById('send-button').disabled})`);
    assert.match(state.pending, /note.txt · 待发送/);
    assert.equal(state.enabled, true);
    await page.eval(`(async()=>{document.getElementById('composer').requestSubmit();await new Promise(r=>setTimeout(r,30));})()`);
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'uploadFile' && x[2] === 'note.txt'));
    assert.ok(calls.some(x => x[0] === 'sendMessage' && x[2] === '' && x[3][0].receiptId === 'receipt-1'));
    state = await page.eval(`document.getElementById('attachment-list').textContent`);
    assert.equal(state, '');

    await page.eval(`window.__fake.onEvent({type:'session-status',sessionId:'s1',running:true});document.getElementById('stop-session').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'cancelSession' && x[1] === 's1'));
    await page.eval(`window.__fake.onEvent({type:'session-status',sessionId:'s1',running:false})`);
    state = await page.eval(`document.getElementById('stop-session').hidden`);
    assert.equal(state, true);

    await page.eval(`window.__fake.onEvent({type:'interaction',interaction:{id:'a1',sessionId:'s1',kind:'approval',title:'需要授权',text:'允许读取文件？'}})`);
    state = await page.eval(`({text:document.getElementById('interaction-list').textContent,buttons:[...document.querySelectorAll('.interaction button')].map(x=>x.textContent)})`);
    assert.match(state.text, /允许读取文件/);
    assert.deepEqual(state.buttons, ['允许', '拒绝']);
    await page.eval(`(async()=>{document.querySelector('.interaction button').click();await new Promise(r=>setTimeout(r,30));})()`);
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'respond' && x[1] === 'a1' && x[2].type === 'approve'));

    await page.eval(`window.__fake.onEvent({type:'interaction',interaction:{id:'q1',sessionId:'s1',kind:'question',title:'需要回答',questions:[{id:'one',question:'选择安全级别',detail:'只选一项',options:[{label:'普通',description:'常规模式'},{label:'严格',description:'多一步确认'}],multiSelect:false},{id:'two',question:'选择功能',options:[{label:'A',description:'功能 A'},{label:'B',description:'功能 B'}],multiSelect:true},{id:'three',question:'其他说明',options:[]}]}})`);
    state = await page.eval(`({questions:[...document.querySelectorAll('.question legend')].map(x=>x.textContent),details:document.getElementById('interaction-list').textContent,types:[...document.querySelectorAll('.question-option input')].map(x=>x.type)})`);
    assert.deepEqual(state.questions, ['选择安全级别', '选择功能', '其他说明']);
    assert.match(state.details, /多一步确认/);
    assert.deepEqual(state.types, ['radio', 'radio', 'checkbox', 'checkbox']);
    await page.eval(`document.querySelector('.interaction-actions button').click()`);
    state = await page.eval(`({error:document.getElementById('error-text').textContent,responds:window.__fake.calls.filter(x=>x[0]==='respond').length})`);
    assert.match(state.error, /每一个问题/);
    assert.equal(state.responds, 1);
    await page.eval(`(async()=>{const q=[...document.querySelectorAll('fieldset.question')];q[0].querySelectorAll('input')[1].click();q[1].querySelectorAll('input')[0].click();q[1].querySelectorAll('input')[1].click();q[1].querySelector('textarea').value='补充说明';q[2].querySelector('textarea').value='自由输入';document.querySelector('.interaction-actions button').click();await new Promise(r=>setTimeout(r,30));})()`);
    calls = await page.eval(`window.__fake.calls`);
    const answer = calls.find(x => x[0] === 'respond' && x[1] === 'q1');
    assert.deepEqual(answer[2], {type:'answers',answers:[{id:'one',selected:['严格']},{id:'two',selected:['A','B'],custom:'补充说明'},{id:'three',selected:[],custom:'自由输入'}]});

    await page.eval(`document.getElementById('projects-toggle').click();document.getElementById('new-session').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'createSession' && x[1] === 'p1'));
    state = await page.eval(`({empty:document.getElementById('empty-state').textContent,loading:document.getElementById('empty-state').hidden})`);
    assert.match(state.empty, /还没有消息/);
    assert.equal(state.loading, false);

    await page.eval(`document.getElementById('projects-toggle').click();document.getElementById('new-project').click();document.getElementById('browse-folder').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`document.getElementById('folder-browser').textContent`);
    assert.match(state, /D:/);
    await page.eval(`document.getElementById('project-path').value='D:/new-project';document.getElementById('project-form').requestSubmit()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'createProject' && x[1] === 'D:/new-project'));

    await page.eval(`window.__fake.onEvent({type:'status',state:'disconnected'})`);
    state = await page.eval(`({status:document.getElementById('connection-status').textContent,error:document.getElementById('error-banner').hidden,send:document.getElementById('send-button').disabled})`);
    assert.equal(state.status, '连接断开');
    assert.equal(state.error, false);
    assert.equal(state.send, true);

    await page.eval(`(async()=>{window.DshLiteAdapter.capabilities={interactiveReplies:false};window.DshLiteUI.mount(window.DshLiteAdapter);await new Promise(r=>setTimeout(r,30));document.querySelector('#session-list button').click();await new Promise(r=>setTimeout(r,30));window.__fake.onEvent({type:'interaction',interaction:{id:'a2',sessionId:'s1',kind:'question',questions:[{id:'q',question:'电脑端的问题',options:[{label:'是',description:'同意'}]}]}});})()`);
    state = await page.eval(`({note:document.getElementById('interaction-note').hidden,buttons:document.querySelectorAll('.interaction button').length,text:document.getElementById('interaction-list').textContent})`);
    assert.equal(state.note, false);
    assert.equal(state.buttons, 0);
    assert.match(state.text, /电脑端处理/);
    assert.match(state.text, /电脑端的问题/);
    assert.equal(requested.some(x => x.startsWith('/plugins/') || x.startsWith('/assets/')), false);
    for (const width of [320, 375, 412]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      state = await page.eval(`(() => {
        const input = document.getElementById('message-input');
        input.style.height = '132px'; // keyboard/draft/attachments change the bottom area's height
        const composer = document.getElementById('composer');
        const row = composer.querySelector('.composer-row');
        const bottom = composer.querySelector('.composer-bottom');
        const status = composer.querySelector('.composer-status');
        const picks = [...bottom.querySelectorAll('.composer-pick[data-kind]')];
        const textarea = input.getBoundingClientRect();
        const footer = bottom.getBoundingClientRect();
        const frame = row.getBoundingClientRect();
        const footnote = status.getBoundingClientRect();
        const result = { viewport: innerWidth, scroll: document.documentElement.scrollWidth,
          send: document.getElementById('send-button').getBoundingClientRect().right,
          inputBottom: textarea.bottom, footerTop: footer.top, footerBottom: footer.bottom,
          frameBottom: frame.bottom, statusTop: footnote.top, statusBottom: footnote.bottom,
          pickHeight: Math.min(...picks.map(x => x.getBoundingClientRect().height)),
          pickKinds: picks.map(x => x.dataset.kind),
          separateBar: !!document.querySelector('.quick-bar') };
        input.style.height = '';
        return result;
      })()`);
      assert.ok(state.scroll <= state.viewport + 1, 'mobile shell overflows at ' + width);
      assert.ok(state.send <= state.viewport + 1, 'composer is outside viewport at ' + width);
      assert.ok(state.inputBottom <= state.footerTop + 1 && state.footerBottom <= state.frameBottom + 1,
        'model and mode should sit below the text inside the composer at ' + width + ': ' + JSON.stringify(state));
      assert.ok(state.frameBottom <= state.statusTop + 1 && state.statusBottom <= 845,
        'connection and balance should sit below the composer at ' + width + ': ' + JSON.stringify(state));
      assert.deepEqual(state.pickKinds, ['model', 'mode', 'goal']);
      assert.equal(state.separateBar, false, 'the old separate toolbar must be gone');
      assert.ok(state.pickHeight >= 40, 'composer selectors are too short at ' + width);
      const operations = await page.eval(`(async () => {
        const holder = document.getElementById('composer-picks');
        const result = [];
        for (const kind of ['model', 'mode', 'goal']) {
          const button = holder.querySelector('[data-kind="' + kind + '"]');
          button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const b = button.getBoundingClientRect(), h = holder.getBoundingClientRect();
          const reachable = b.left >= h.left - 1 && b.right <= h.right + 1;
          button.click();
          await new Promise(resolve => setTimeout(resolve, 25));
          const overlay = document.querySelector('.screen-overlay');
          result.push({ kind, reachable, opened: !!overlay });
          if (overlay) overlay.querySelector('.screen-action').click();
        }
        return result;
      })()`);
      assert.ok(operations.every(x => x.reachable && x.opened),
        'all composer selectors must remain reachable and open at ' + width + ': ' + JSON.stringify(operations));
      await new Promise(resolve => setTimeout(resolve, 30));
      // The jump control belongs over the record area, never on top of the composer.
      state = await page.eval(`(() => {
        const jump = document.querySelector('.jump-bottom');
        const composer = document.getElementById('composer');
        if (!jump || !composer) return null;
        jump.hidden = false;                    // 它平时是"离底部远才出现"，这里强制显示来量
        const j = jump.getBoundingClientRect(), c = composer.getBoundingClientRect();
        const overlap = !(j.right <= c.left || j.left >= c.right || j.bottom <= c.top || j.top >= c.bottom);
        return { overlap: overlap, jumpBottom: Math.round(j.bottom), composerTop: Math.round(c.top) };
      })()`);
      if (state) {
        assert.equal(state.overlap, false,
          '@' + width + 'px 「回到底部」和输入区重合了：' + JSON.stringify(state));
      }
    }
    assert.equal(page.exceptions.length, 0);

    // ── E3：加密状态常驻标记 ─────────────────────────────────────────────────
    // 没有密钥时使用者只看到"发送键变灰"，不知道原因其实是地址缺了 #k=。
    await page.eval(`document.querySelector('#session-list button')?.click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await page.eval(`(() => {
      const chip = document.getElementById('crypto-chip');
      return { hidden: chip.hidden, state: chip.dataset.state, text: chip.textContent };
    })()`);
    assert.equal(state.hidden, false, '加密状态标记应当是常驻的');
    assert.equal(state.state, 'off', '测试页没有密钥，应当显示"缺密钥"');
    assert.match(state.text, /缺密钥/);
    await page.eval(`document.getElementById('crypto-chip').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`({overlay: !!document.querySelector('.screen-overlay'),
      overlayCount: document.querySelectorAll('.screen-overlay').length,
      text: document.querySelector('.screen-overlay')?.textContent || ''})`);
    assert.ok(state.overlay, '点加密标记应当弹出说明面板');
    assert.equal(state.overlayCount, 1, '重新挂载后点击加密标记只能打开一个说明面板');
    assert.match(String(state.text), /没有加密密钥/, '点开应当说明地址缺了什么以及怎么办');
    await page.eval(`document.querySelector('.screen-overlay .screen-action')?.click()`);

    // ── J：压缩上下文走 commands/execute，不是把 /compact 当消息发出去 ────────
    //
    // The composer keeps only the three session-specific selectors. Compact
    // remains inside the goal panel, and app/address actions live in Settings.
    state = await page.eval(`([...document.querySelectorAll('.composer-pick[data-kind]')].map(b => b.textContent))`);
    assert.equal(state.some(x => x.indexOf('压缩上下文') >= 0), false,
      '压缩上下文不该占据输入区下沿：' + state.join('|'));
    assert.ok(state.some(x => x === '目标'), '输入区下沿应当有目标入口');
    const composerInfo = await page.eval(`(() => {
      const picks = document.querySelectorAll('#composer-picks');
      const settings = document.getElementById('settings-menu');
      return { pickGroups: picks.length,
        codex: !!settings.querySelector('#settings-codex'),
        address: [...settings.querySelectorAll('.menu-extra')].some(x => x.textContent.includes('连接地址')),
        balance: !!document.getElementById('composer-balance') };
    })()`);
    assert.equal(composerInfo.pickGroups, 1, '重新挂载不该留下第二组输入动作');
    assert.equal(composerInfo.codex && composerInfo.address && composerInfo.balance, true,
      'Codex、地址与余额仍须容易找到');
    await page.eval(`document.getElementById('rail-settings').click()`);
    state = await page.eval(`(() => { const menu = document.getElementById('settings-menu');
      const codex = document.getElementById('settings-codex');
      const address = [...menu.querySelectorAll('.menu-extra')].find(x => x.textContent.includes('连接地址'));
      return { open: !menu.hidden, codexHeight: codex.getBoundingClientRect().height,
        addressHeight: address.getBoundingClientRect().height }; })()`);
    assert.equal(state.open, true, '设置入口应当打开');
    assert.ok(state.codexHeight >= 44 && state.addressHeight >= 44,
      '设置里的 Codex 和连接地址需要易点的触控区域');
    await page.eval(`[...document.querySelectorAll('#settings-menu .menu-extra')]
      .find(x => x.textContent.includes('连接地址')).click()`);
    assert.match(await page.eval(`document.querySelector('.screen-overlay .screen-bar').textContent`), /连接地址/);
    await page.eval(`document.querySelector('.screen-overlay .screen-action').click()`);
    await page.eval(`document.querySelector('.composer-pick[data-kind="model"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await page.eval(`document.querySelector('.screen-overlay').textContent`), /模型一号/);
    await page.eval(`document.querySelector('.screen-overlay .screen-action').click()`);
    await page.eval(`document.querySelector('.composer-pick[data-kind="mode"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await page.eval(`document.querySelector('.screen-overlay').textContent`), /标准/);
    await page.eval(`document.querySelector('.screen-overlay .screen-action').click()`);

    await page.eval(`document.querySelector('.composer-pick[data-kind="goal"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    const compactClicked = await page.eval(`(() => {
      const target = [...document.querySelectorAll('.screen-overlay .screen-action')]
        .find(b => b.textContent === '压缩上下文');
      if (!target) return 'no-button';
      target.click();
      return 'clicked';
    })()`);
    assert.equal(compactClicked, 'clicked', '「计划 / 目标」面板里应当有「压缩上下文」');
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'listCommands'), '应当先列一次命令目录：' + JSON.stringify(calls.slice(-6)));
    assert.ok(calls.some(x => x[0] === 'runCommand' && x[1] === 's1' && x[2] === '/compact'),
      '/compact 必须走 commands/execute，而不是 session/prompt：' + JSON.stringify(calls.slice(-6)));
    assert.equal(calls.some(x => x[0] === 'sendMessage' && String(x[2]).indexOf('/compact') >= 0), false,
      '/compact 绝不能被当成一条普通消息发出去');
    // 结果要**就地**显示在目标面板里（不另开面板把看板顶掉）
    state = await page.eval(`(() => {
      const slot = document.querySelector('.goal-compact-result');
      return { hasSlot: !!slot, text: slot ? slot.textContent : '' };
    })()`);
    assert.equal(state.hasSlot, true, '压缩结果要就地显示在面板里');
    assert.match(String(state.text), /压缩|已压缩/, '结果文字要显示出来');
    await page.eval(`document.querySelector('.screen-overlay .screen-action')?.click()`);

    // ── C12：排队消息可见，且能立即执行 / 修改 / 删除 ────────────────────────
    await page.eval(`window.__fake.onEvent({type:'session-status',sessionId:'s1',running:true})`);
    await page.eval(`window.__fake.queued = [
      {id:'q1',text:'先看看这个文件',target:'turn'},
      {id:'q2',text:'然后跑测试',target:'turn'}
    ]`);
    await page.eval(`window.DshLiteAdapter.updateQueueItem = async (sid,id,action) => {
      window.__fake.calls.push(['updateQueueItem',sid,id,action.kind,action.content]);
      window.__fake.queued = (window.__fake.queued || []).filter(x => x.id !== id);
      return {accepted:true};
    }`);
    // 轮询是 10 秒一次，测试里等不起 —— 用界面自己的路径触发：切一次对话会顺带读队列。
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await page.eval(`({hidden:document.getElementById('queue-panel').hidden,
      text:document.getElementById('queue-list').textContent,
      rows:document.querySelectorAll('#queue-list .queue-item').length})`);
    assert.equal(state.hidden, false, '排队消息应当显示出来（原来手机端完全看不到）');
    assert.equal(state.rows, 2);
    assert.match(state.text, /先看看这个文件/);

    // 「立即执行」= steer
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '立即执行').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'updateQueueItem' && x[2] === 'q1' && x[3] === 'steer'));
    state = await page.eval(`document.querySelectorAll('#queue-list .queue-item').length`);
    assert.equal(state, 1, '被立即执行的那条应当从列表里消失');

    // 「修改」= edit，并且只送 text part
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '修改').click()`);
    const c12Typed = await page.eval(`(() => { const a = document.querySelector('.queue-edit');
      if (!a) return 'no-editor';
      a.value = '改过的内容'; return 'ok'; })()`);
    assert.equal(c12Typed, 'ok', '点「修改」应当出现编辑框');
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '保存').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    calls = await page.eval(`window.__fake.calls`);
    const edit = calls.find(x => x[0] === 'updateQueueItem' && x[3] === 'edit');
    assert.ok(edit, '应当发出 edit 操作');
    assert.deepEqual(edit[4], [{ type: 'text', text: '改过的内容' }], 'edit 只能送 text part');

    // 「删除」= remove
    await page.eval(`window.__fake.queued = [{id:'q9',text:'不要的',target:'turn'}]`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '删除').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'updateQueueItem' && x[2] === 'q9' && x[3] === 'remove'));

    // ★ 编辑排队消息时**不能被自动刷新打断**（使用者报「修改排队中的命令时被强制打断，
    //   需要重新按修改」）。
    //
    //   根因：队列在任务进行中每 10 秒自动刷新一次，而刷新会 replaceChildren() 重建
    //   整个列表 —— 编辑框、已经打的字、光标全没了。
    //   现在：编辑态存在 state 里，而且刷新期间**主动跳过**。
    //   旧实现下这条必然失败（编辑框会被重建掉）。
    await page.eval(`window.__fake.queued = [{id:'e1',text:'原来的内容',target:'turn'}]`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '修改').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    state = await page.eval(`({ area: !!document.querySelector('.queue-edit'),
      value: document.querySelector('.queue-edit') ? document.querySelector('.queue-edit').value : '',
      plainRow: !!document.querySelector('.queue-text') })`);
    assert.equal(state.area, true, '点「修改」应当出现编辑框');
    assert.equal(state.value, '原来的内容', '编辑框要预填原来的内容');
    assert.equal(state.plainRow, false, '编辑中的那条不该还是普通行');

    // 打字（只更新草稿，不重渲染）
    const typed = await page.eval(`(() => { const a = document.querySelector('.queue-edit');
      if (!a) return 'no-editor';
      a.value = '我改了一半'; a.dispatchEvent(new Event('input')); return 'ok'; })()`);
    assert.equal(typed, 'ok', '编辑框必须在（否则下面验不了"字还在不在"）');

    // ★ 触发那条自动刷新的路（状态事件 → refreshQueue；轮询走的是同一个函数）
    await page.eval(`window.__fake.onEvent({type:'session-status',sessionId:'s1',running:true})`);
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await page.eval(`({ area: !!document.querySelector('.queue-edit'),
      value: document.querySelector('.queue-edit') ? document.querySelector('.queue-edit').value : '' })`);
    assert.equal(state.area, true, '自动刷新不该把编辑框弄没 —— 这就是"被强制打断"');
    assert.equal(state.value, '我改了一半', '已经打的字必须还在');

    // 保存仍然正常，而且要送出去改后的内容
    await page.eval(`[...document.querySelectorAll('.queue-edit-box .queue-action')].find(b => b.textContent === '保存').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    const savedEdit = calls.find(x => x[0] === 'updateQueueItem' && x[2] === 'e1' && x[3] === 'edit');
    assert.ok(savedEdit, '应当发出 edit');
    assert.equal(savedEdit[4][0].text, '我改了一半');
    assert.equal(await page.eval(`!!document.querySelector('.queue-edit')`), false, '保存后编辑框应当收起');
    // 取消也要能收起
    await page.eval(`window.__fake.queued = [{id:'e2',text:'再改一次',target:'turn'}]`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    await page.eval(`[...document.querySelectorAll('.queue-action')].find(b => b.textContent === '修改').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(await page.eval(`!!document.querySelector('.queue-edit')`), true);
    await page.eval(`[...document.querySelectorAll('.queue-edit-box .queue-action')].find(b => b.textContent === '取消').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(await page.eval(`!!document.querySelector('.queue-edit')`), false, '取消后编辑框应当收起');
    console.log('DSH mobile shell queue-edit checks passed (survives auto-refresh / save / cancel)');

    // ── C26：目标条（照电脑端的 GoalBar 做）─────────────────────────────────
    //
    // 使用者原话：「你这目标的设置，ui 不能和电脑端一样吗？这样子像是90年代的感觉」。
    // 电脑端**不是面板**，是一条停在输入框上方的横条：图标 + 阶段文字 +
    // 单行截断的目标正文 + 右侧圆形图标按钮；**编辑是同一行里的内联输入框**；
    // **完成的目标什么都不渲染**。下面逐条验。
    await page.eval(`window.__fake.goal = { id:'g1', revision:3, objective:'把手机端做到能用',
      phase:'active', blockedReason:'', maxGoalRounds:10 }`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    state = await page.eval(`(() => {
      const bar = document.getElementById('goal-bar');
      if (!bar) return { missing: true };
      return { hidden: bar.hidden, phase: bar.dataset.phase || '',
        label: bar.querySelector('.goal-label') ? bar.querySelector('.goal-label').textContent : '',
        objective: bar.querySelector('.goal-objective') ? bar.querySelector('.goal-objective').textContent : '',
        icons: [...bar.querySelectorAll('.goal-icon')].map(b => b.dataset.kind),
        glyph: !!bar.querySelector('.goal-glyph svg'),
        panel: !!document.querySelector('.screen-overlay') };
    })()`);
    assert.ok(!state.missing, 'HTML 里应当有目标条');
    assert.equal(state.hidden, false, '有目标时目标条应当显示在输入框上方');
    assert.equal(state.phase, 'active');
    assert.equal(state.label, '进行中的目标', '用词要和电脑端一字不差');
    assert.equal(state.objective, '把手机端做到能用');
    assert.equal(state.glyph, true, '左边要有目标图标');
    assert.deepEqual(state.icons, ['pause', 'edit', 'clear'], '右边是圆形图标按钮：暂停/编辑/清除');
    assert.equal(state.panel, false, '目标是**一条**，不该弹面板（"90年代感"就是从弹面板来的）');

    // 暂停 —— 必须带上**最新的 revision**（DSH 用它做乐观并发保护）
    await page.eval(`document.querySelector('.goal-icon[data-kind="pause"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    const pausedCall = calls.find(x => x[0] === 'goalAction' && x[2] === 'pause');
    assert.ok(pausedCall, '应当发出 pause');
    assert.equal(pausedCall[4], 3, 'pause 必须带上读到的 revision');
    state = await page.eval(`(() => { const bar = document.getElementById('goal-bar');
      return { phase: bar.dataset.phase,
        label: bar.querySelector('.goal-label').textContent,
        icons: [...bar.querySelectorAll('.goal-icon')].map(b => b.dataset.kind) }; })()`);
    assert.equal(state.phase, 'paused', '操作完要重新读一次，状态跟着变');
    assert.equal(state.label, '已暂停的目标');
    assert.deepEqual(state.icons, ['resume', 'edit', 'clear'], '暂停之后按钮要变成"恢复"');

    // 编辑：**同一条里的内联输入框**（不是弹面板）
    await page.eval(`document.querySelector('.goal-icon[data-kind="edit"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await page.eval(`(() => { const bar = document.getElementById('goal-bar');
      const input = bar.querySelector('.goal-input');
      return { inBar: !!input, value: input ? input.value : '',
        icons: [...bar.querySelectorAll('.goal-icon')].map(b => b.dataset.kind),
        inPanel: !!document.querySelector('.screen-overlay .goal-input') }; })()`);
    assert.equal(state.inBar, true, '编辑框要在**同一条里**（内联）');
    assert.equal(state.inPanel, false, '不该弹面板');
    assert.equal(state.value, '把手机端做到能用', '要预填当前目标');
    assert.deepEqual(state.icons, ['save', 'cancel'], '编辑时是保存/取消');
    state = await page.eval(`(() => { const bar = document.getElementById('goal-bar').getBoundingClientRect();
      const input = document.querySelector('#goal-bar .goal-input').getBoundingClientRect();
      return { inputHeight: input.height, inputRight: input.right, barRight: bar.right }; })()`);
    assert.ok(state.inputHeight <= 44 && state.inputRight <= state.barRight + 1,
      'goal editor should stay on one compact row: ' + JSON.stringify(state));
    await page.eval(`(() => { const i = document.querySelector('#goal-bar .goal-input');
      i.value = '改成这个目标'; i.dispatchEvent(new Event('input')); return 'ok'; })()`);
    await page.eval(`document.querySelector('.goal-icon[data-kind="save"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    const editedCall = calls.find(x => x[0] === 'goalAction' && x[2] === 'edit');
    assert.ok(editedCall, '应当发出 edit');
    assert.equal(editedCall[3], '改成这个目标');
    assert.equal(await page.eval(`!!document.querySelector('.goal-card')`), false,
      '旧的卡片式面板不该再出现');

    // 完成的目标 → **什么都不渲染**（和电脑端一致）
    await page.eval(`window.__fake.goal.phase = 'complete'`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(await page.eval(`document.getElementById('goal-bar').hidden`), true,
      '完成的目标什么都不渲染');

    // 清除 → 条消失
    await page.eval(`window.__fake.goal = { id:'g2', revision:1, objective:'待清除的目标',
      phase:'active', blockedReason:'', maxGoalRounds:0 }`);
    await page.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(await page.eval(`document.getElementById('goal-bar').hidden`), false);
    await page.eval(`document.querySelector('.goal-icon[data-kind="clear"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'goalAction' && x[2] === 'clear'), '应当发出 clear');
    assert.equal(await page.eval(`document.getElementById('goal-bar').hidden`), true, '清除后条要消失');

    // 没有目标时：从「计划 / 目标」面板建一个（手机上没有 /goal 补全，得给个入口）
    await page.eval(`document.querySelector('.composer-pick[data-kind="goal"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    const created = await page.eval(`(() => {
      const input = document.querySelector('.screen-overlay .goal-input');
      if (!input) return 'no-input';
      input.value = '新目标';
      const btn = [...document.querySelectorAll('.screen-overlay .screen-action')]
        .find(b => b.textContent === '设定目标');
      if (!btn) return 'no-button';
      btn.click();
      return 'ok';
    })()`);
    assert.equal(created, 'ok', '没有目标时要能从面板里建一个');
    await new Promise(resolve => setTimeout(resolve, 90));
    calls = await page.eval(`window.__fake.calls`);
    assert.ok(calls.some(x => x[0] === 'goalAction' && x[2] === 'create' && x[3] === '新目标'));
    await page.eval(`document.querySelector('.screen-overlay .screen-action')?.click()`);
    console.log('DSH mobile shell goal-bar checks passed (strip / inline edit / icons / complete-hidden)');

    // ── C9：语音输入必须"开得了、也关得了" ──────────────────────────────────
    //
    // 使用者报过「语音模式，开了关不了」。两个根因各验一条：
    //   ① 停的入口看不见 → 现在开始听之后按钮就是红的「停止」，点一下立刻停；
    //   ② 报错时控制器没清掉 → 按钮永远卡在"正在听"。这条必须验。
    state = await page.eval(`(() => {
      const mic = document.getElementById('voice-button');
      return { exists: !!mic, label: mic ? mic.getAttribute('aria-label') : '' };
    })()`);
    assert.equal(state.exists, true, '输入框旁应当有语音按钮');
    assert.match(state.label, /语音输入/);
    await page.eval(`document.getElementById('voice-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`(() => {
      const mic = document.getElementById('voice-button');
      return { listening: mic.classList.contains('is-listening'), text: mic.textContent,
        label: mic.getAttribute('aria-label'), stopLabel: mic.getAttribute('data-stop-label'),
        started: window.__voice.started };
    })()`);
    assert.equal(state.started, 1, '点一下应当开始识别');
    assert.equal(state.listening, true);
    assert.match(state.text, /■/);
    assert.match(state.label, /停止/, '开始听之后按钮自己就是停止按钮');
    assert.match(String(state.stopLabel), /停止/);
    await page.eval(`window.__voice.handlers.onPartial('你好世界')`);
    assert.equal(await page.eval(`document.getElementById('message-input').value`), '你好世界');
    await page.eval(`document.getElementById('voice-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`(() => {
      const mic = document.getElementById('voice-button');
      return { listening: mic.classList.contains('is-listening'), text: mic.textContent,
        stopped: window.__voice.stopped, disabled: mic.disabled };
    })()`);
    assert.equal(state.listening, false, '再点一下必须真的停下来');
    assert.equal(state.stopped, 1);
    assert.match(state.text, /🎤/);
    assert.equal(state.disabled, false, '停完按钮要能再点');
    // ★ 报错那条路（以前会让按钮永远卡住）
    await page.eval(`window.__voice.fail = true; window.__voice.started = 0`);
    await page.eval(`document.getElementById('voice-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await page.eval(`(() => {
      const mic = document.getElementById('voice-button');
      return { listening: mic.classList.contains('is-listening'), disabled: mic.disabled,
        error: document.getElementById('error-text').textContent, started: window.__voice.started };
    })()`);
    assert.equal(state.started, 1, '报错那次也要真的尝试过');
    assert.equal(state.listening, false, '报错后按钮必须复位（原来会永远卡在"正在听"）');
    assert.equal(state.disabled, false);
    assert.match(String(state.error), /没听到声音|语音/, '错误要如实显示出来');
    // 报错之后还能正常再用一次
    await page.eval(`window.__voice.fail = false`);
    await page.eval(`document.getElementById('voice-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await page.eval(`document.getElementById('voice-button').classList.contains('is-listening')`), true,
      '报错之后必须还能重新开始');
    await page.eval(`document.getElementById('voice-button').click()`);
    // 设置里有单独的语音语言（不跟界面语言绑死）
    state = await page.eval(`(() => {
      const sel = document.querySelector('.voice-lang-select');
      if (!sel) return null;
      sel.value = 'en-US';
      sel.dispatchEvent(new Event('change'));
      return { options: sel.options.length, stored: localStorage.getItem('dsh-voice-lang') };
    })()`);
    assert.ok(state, '设置里应当有语音语言一项');
    assert.ok(state.options >= 5, '至少要有中/英/西/日/韩可选');
    assert.equal(state.stored, 'en-US');
    await page.eval(`(() => { localStorage.removeItem('dsh-voice-lang'); return 'ok'; })()`);
    await page.eval(`document.querySelector('.screen-overlay .screen-action')?.click()`);
    console.log('DSH mobile shell voice checks passed (start / stop / error-recovery / language)');

    // ── C8：三种语言 ────────────────────────────────────────────────────────
    state = await page.eval(`({has:typeof window.DshI18n, langs:window.DshI18n && window.DshI18n.SUPPORTED})`);
    assert.equal(state.has, 'object', 'i18n.js 必须加载（否则界面永远只有中文）');
    assert.deepEqual(state.langs, ['zh', 'en', 'es']);
    const switchers = await page.eval(`(() => {
      const all = [...document.querySelectorAll('#settings-menu select')];
      const voice = document.querySelector('.voice-lang-select');
      const ui = all.filter(s => s !== voice);
      return { total: all.length, uiCount: ui.length, uiOptions: ui[0] ? ui[0].options.length : 0,
        voiceOptions: voice ? voice.options.length : 0 };
    })()`);
    assert.equal(switchers.uiCount, 1, '界面语言只能有一个切换器（重新挂载不能留下旧的）');
    assert.equal(switchers.uiOptions, 3, '界面语言三种');
    assert.ok(switchers.voiceOptions >= 5, '语音语言至少要有中/英/西/日/韩可选');
    assert.equal(await page.eval(`(() => { window.DshI18n.setLang('en'); return 'ok'; })()`), 'ok');
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await page.eval(`({
      lang:document.documentElement.lang,
      status:document.getElementById('connection-status').textContent,
      picks:[...document.querySelectorAll('.composer-pick[data-kind]')].map(b=>b.textContent),
      goalLabel:document.querySelector('.composer-pick[data-kind="goal"]').getAttribute('aria-label'),
      chip:document.getElementById('crypto-chip').textContent,
      queue:document.getElementById('queue-title').textContent
    })`);
    assert.equal(state.lang, 'en');
    // 状态那行字是 setStatus 当时写死的，换语言后必须重画。
    // 不直接拿 `state.status` 去断言：测试前面触发过 visibilitychange，
    // 适配器可能刚好在重连，值本身会漂 —— 这里先把状态摆成一个**确定值**再验。
    assert.equal(await page.eval(`(() => {
      window.__fake.onEvent({type:'status',state:'disconnected'});
      return document.getElementById('connection-status').textContent;
    })()`), 'Disconnected');
    assert.equal(await page.eval(`(() => {
      window.__fake.onEvent({type:'status',state:'connected'});
      return document.getElementById('connection-status').textContent;
    })()`), 'Connected');
    assert.deepEqual(state.picks, ['Model', 'Tools', 'Goal'], '输入区动作应当跟着切成英文');
    assert.equal(state.goalLabel, 'Plan/Goal', '目标按钮应说明也能打开计划模式');
    assert.equal(state.picks.some(x => x === 'Compact'), false,
      '压缩上下文只在目标面板里');
    assert.match(state.chip, /No key/);
    assert.match(state.queue, /Queued/);
    await page.eval(`(() => { window.DshI18n.setLang('es'); return 'ok'; })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await page.eval(`({status:(() => {
        window.__fake.onEvent({type:'status',state:'disconnected'});
        return document.getElementById('connection-status').textContent;
      })(),
      picks:[...document.querySelectorAll('.composer-pick[data-kind]')].map(b=>b.textContent),
      composerStatus:document.getElementById('composer-connection').textContent})`);
    assert.equal(state.status, 'Sin conexión');
    assert.deepEqual(state.picks, ['Modelo', 'Herramientas', 'Meta'], '输入区西语也要生效');
    assert.equal(state.composerStatus, 'Sin conexión', '底部连接状态也要跟着切换语言');
    await page.eval(`(() => { window.DshI18n.setLang('zh'); return 'ok'; })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await page.eval(`document.getElementById('connection-status').textContent`), '连接断开');
    assert.equal(page.exceptions.length, 0);
    console.log('DSH mobile shell feature checks passed (crypto chip / queue / compact / i18n)');

    // ── 回复的 markdown 渲染 ─────────────────────────────────────────────────
    //
    // 使用者截图里满屏 `**` 和 `|---|---|` —— 回复原来是被当**纯文本**塞进 textContent 的，
    // 手机上几乎读不下去。
    await page.eval(`(() => {
      const lines = ['**粗体** 和 \`行内代码\`', '', '| 列A | 列B |', '|---|---|', '| 1 | 2 |',
        '', '\`\`\`', 'code line', '\`\`\`', '',
        '<img src=x onerror=window.__xss=1>'];
      window.__fake.onEvent({ type: 'record', sessionId: 's1',
        record: { id: 'md-1', role: 'assistant', text: lines.join('\\n') } });
      return 'ok';
    })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await page.eval(`(() => {
      const row = [...document.querySelectorAll('#record-list .record')]
        .find(r => r.dataset.recordId === 'md-1');
      if (!row) return null;
      const md = row.querySelector('.record-markdown');
      if (!md) return { hasMd: false };
      return { hasMd: true,
        strong: md.querySelectorAll('strong').length,
        inlineCode: md.querySelectorAll('code').length,
        pre: md.querySelectorAll('pre.md-code').length,
        table: md.querySelectorAll('table').length,
        th: md.querySelectorAll('th').length,
        tds: md.querySelectorAll('td').length,
        images: md.querySelectorAll('img').length,
        scriptish: md.innerHTML.indexOf('onerror') >= 0,
        rawStars: md.textContent.indexOf('**'),
        xss: window.__xss === 1 };
    })()`);
    assert.ok(state && state.hasMd, '助手消息应当用 markdown 容器渲染');
    assert.ok(state.strong >= 1, '**粗体** 要变成 <strong>');
    assert.ok(state.inlineCode >= 2, '行内代码 + 代码块都要有 <code>');
    assert.equal(state.pre, 1, '围栏代码块要变成 <pre>');
    assert.equal(state.table, 1, '| 表格 | 要变成 <table>');
    assert.equal(state.th, 2);
    assert.equal(state.tds, 2);
    assert.equal(state.rawStars, -1, '星号不能再裸露在正文里');
    // ★ 安全：渲染顺序是"先转义、再套规则"，所以标签只能是文字
    assert.equal(state.images, 0, 'XSS：回复里的 <img> 绝不能被真的创建');
    assert.equal(state.xss, false, 'XSS：onerror 绝不能被执行');
    console.log('DSH mobile shell markdown checks passed (bold / code / table / links / XSS-safe)');

    // ── C11：重新打开时应该**接着看刚才那段对话** ─────────────────────────────
    //
    // 使用者报的「有些时候还是得重新选择项目，就是强制跳转到选择项目上」，
    // 根因是记住的对话 id 没人用回去（selectProject 会把它清掉）。
    // 这一条就用"关掉再打开"来验：两次页面加载之间只共享 localStorage。
    await page.eval(`(() => {
      localStorage.setItem('dsh-lite:project', 'p1');
      localStorage.setItem('dsh-lite:session', 's1');
      return 'stored';
    })()`);
    await page.send('Page.reload', {}, 8000);
    await new Promise(resolve => setTimeout(resolve, 600));
    state = await page.eval(`({title:document.getElementById('session-title').textContent,
      selected:document.querySelector('#session-list [aria-selected="true"]')?.textContent || '',
      project:document.querySelector('#project-list [aria-selected="true"]')?.textContent || '',
      hidden:document.body.classList.contains('sidebar-hidden')})`);
    assert.equal(state.title, '昨天的对话', '重开页面后没有恢复上次的对话');
    assert.match(state.project, /测试项目/);
    assert.equal(state.hidden, true, '恢复对话后应当直接进入对话视图');
    assert.equal(page.exceptions.length, 0);

    // 记着的对话已经不存在（被删了 / 换了项目）时，必须先拿**电脑刚报回来的列表**
    // 核一遍，再决定要不要加载 —— 否则界面会去加载一个不存在的会话，停在空白上
    //（使用者眼里的"强制跳回选择项目"）。
    //
    // ★ 为什么这里不去造"记忆里存着一个不存在的 id"：实测（新开标签页 / 挂
    //   pagehide / 关掉写页都试过）**浏览器的会话恢复会抢在前面**，刷新后存储里
    //   又变回上一页的 id —— 这条注入路径在测试环境里走不通。所以改成验判据本身。
    const cold = await browser.newPage();
    await cold.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cold.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await cold.eval(`typeof window.__dshLiteState`), 'function');
    const judgment = await cold.eval(`(() => {
      const found = document.querySelectorAll('#session-list button').length;
      const selectedBefore = document.querySelectorAll('#session-list [aria-selected="true"]').length;
      return { found: found, selectedBefore: selectedBefore };
    })()`);
    assert.ok(judgment.found >= 1, '列表里应当有电脑报回来的对话');
    assert.equal(judgment.selectedBefore, 1, '恢复的那条对话应当被标成已选中');
    const coldState = await cold.eval(`window.__dshLiteState()`);
    assert.equal(coldState.restoreSession, '', '恢复用的一次性记忆应当已经用掉');
    assert.equal(coldState.projectId, 'p1', '应当落在记忆里的项目上');

    // 反过来：记忆里的对话**还在**列表里 → 必须被恢复（这才是 C11 的主路径）。
    await cold.eval(`(() => { localStorage.setItem('dsh-lite:session', 's1'); return 'stored'; })()`);
    await cold.send('Page.reload', {}, 8000);
    await new Promise(resolve => setTimeout(resolve, 700));
    state = await cold.eval(`({title:document.getElementById('session-title').textContent,
      remembered:localStorage.getItem('dsh-lite:session')})`);
    assert.equal(state.title, '昨天的对话', '冷启动时没有恢复记忆里的对话');
    assert.equal(state.remembered, 's1', '有效的对话记忆不该被清掉');
    const coldExceptions = cold.exceptions.length;
    cold.close();
    assert.equal(coldExceptions, 0, '冷启动那一页抛了脚本异常');
    await page.eval(`(() => { localStorage.clear(); return 'cleared'; })()`);

    async function waitForSessionList(targetPage) {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await targetPage.eval(`!!document.querySelector('#session-list button')`)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('isolated DSH session list did not finish loading');
    }

    // These checks reproduce mistakes found by actually using the phone-sized
    // page: cross-session drafts, hidden modal errors, and stale async results.
    const regress = await browser.newPage();
    await regress.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await regress.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(regress);
    await regress.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    await regress.eval(`(() => {
      const input = document.getElementById('message-input');
      input.value = '只属于旧对话的草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    state = await regress.eval(`({id:window.__dshLiteState().sessionId,draft:document.getElementById('message-input').value})`);
    assert.equal(state.id, 's2');
    assert.equal(state.draft, '', '新对话不能带着上一段对话的未发送文字');
    await regress.eval(`[...document.querySelectorAll('#session-list button')].find(x=>x.textContent.includes('昨天的对话')).click()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(await regress.eval(`document.getElementById('message-input').value`), '只属于旧对话的草稿',
      '回到旧对话应恢复它自己的草稿');

    await regress.eval(`(() => {
      window.__question = {type:'interaction',interaction:{id:'q-draft',sessionId:'s1',kind:'question',
        questions:[{id:'one',question:'写一段回答',options:[]}]}};
      window.__fake.onEvent(window.__question);
      const field = document.querySelector('.question-custom');
      field.value = '写到一半的回答'; field.dispatchEvent(new Event('input',{bubbles:true}));
      window.__fake.onEvent({type:'interaction',interaction:{...window.__question.interaction,title:'更新的问题'}});
    })()`);
    assert.equal(await regress.eval(`document.querySelector('.question-custom').value`), '写到一半的回答',
      '问题更新不能清空已填写的答案');
    await regress.eval(`(() => {
      window.DshLiteAdapter.respondToInteraction = async () => { throw {userMessage:'临时断线'}; };
      document.querySelector('.interaction-actions button').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await regress.eval(`document.querySelector('.question-custom').value`), '写到一半的回答',
      '提交失败后答案仍应可修改并重试');

    await regress.eval(`(() => {
      window.__longDetail = '请先仔细核对本次操作的项目、文件范围和授权对象。'.repeat(24);
      window.__longQuestion = {type:'interaction',interaction:{id:'q-long',sessionId:'s1',kind:'question',
        title:'详细询问',questions:[{id:'one',question:'是否继续？',detail:window.__longDetail,
          options:[{label:'继续',description:'确认后继续'},{label:'停止',description:'现在停止'}]}]}};
      window.__fake.onEvent(window.__longQuestion);
    })()`);
    state = await regress.eval(`(() => { const detail=document.querySelector('.question-detail-more');
      const field=detail?.closest('fieldset'); return {exists:!!detail,open:detail?.open,
        options:field?.querySelectorAll('.question-option').length,
        optionVisible:field?.querySelector('.question-option').getBoundingClientRect().height>0,
        summary:detail?.querySelector('summary').textContent}; })()`);
    assert.equal(state.exists, true, '长说明要折叠进可展开区域');
    assert.equal(state.open, false, '长说明默认收起，避免盖住选项');
    assert.equal(state.options, 2);
    assert.equal(state.optionVisible, true, '长说明收起时选项仍应可见');
    assert.match(state.summary, /查看完整说明/);
    await regress.eval(`document.querySelector('.question-detail-more summary').click()`);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(await regress.eval(`document.querySelector('.question-detail-more').open`), true);
    assert.equal(await regress.eval(`document.querySelector('.question-detail-more .question-detail').textContent`),
      await regress.eval(`window.__longDetail`), '展开后必须能读到完整说明');
    await regress.eval(`window.__fake.onEvent({type:'interaction',interaction:{...window.__longQuestion.interaction,
      title:'更新后的详细询问'}})`);
    assert.equal(await regress.eval(`document.querySelector('.question-detail-more').open`), true,
      '问题更新重新渲染后应保持展开状态');

    // Real approval requests may put their long explanation in item.text,
    // without a question.detail field. Reading the full text must remain
    // possible while Allow/Reject stay visible; this test never submits either.
    await regress.eval(`(() => {
      window.__longApprovalText = '请核对本次审批涉及的命令、文件和访问范围。'.repeat(28);
      window.__longApproval = {type:'interaction',interaction:{id:'a-long',sessionId:'s1',
        kind:'approval',title:'长审批',text:window.__longApprovalText}};
      window.__fake.onEvent(window.__longApproval);
    })()`);
    state = await regress.eval(`(() => {
      const card=[...document.querySelectorAll('.interaction')].find(x=>x.querySelector('h2')?.textContent==='长审批');
      const details=card?.querySelector('details');
      const actions=[...card.querySelectorAll('.interaction-actions button')];
      return {folded:!!details && !details.open,summary:details?.querySelector('summary')?.textContent,
        actions:actions.map(x=>x.textContent),visible:actions.every(x=>x.getBoundingClientRect().height>0)};
    })()`);
    assert.equal(state.folded, true, '长审批正文默认应折叠');
    assert.match(state.summary || '', /查看完整说明/, '长审批应提供明确的展开入口');
    assert.deepEqual(state.actions, ['允许', '拒绝']);
    assert.equal(state.visible, true, '正文折叠不能把允许/拒绝按钮藏起来');
    await regress.eval(`[...document.querySelectorAll('.interaction')]
      .find(x=>x.querySelector('h2')?.textContent==='长审批').querySelector('details summary').click()`);
    await new Promise(resolve => setTimeout(resolve, 35));
    state = await regress.eval(`(() => { const card=[...document.querySelectorAll('.interaction')]
      .find(x=>x.querySelector('h2')?.textContent==='长审批');
      const details=card.querySelector('details');
      return {open:details.open,full:details.querySelector('p')?.textContent}; })()`);
    assert.equal(state.open, true);
    assert.equal(state.full, await regress.eval(`window.__longApprovalText`), '展开后应读到完整审批正文');
    await regress.eval(`window.__fake.onEvent({type:'interaction',interaction:{...window.__longApproval.interaction,
      title:'长审批（已更新）'}})`);
    state = await regress.eval(`(() => { const card=[...document.querySelectorAll('.interaction')]
      .find(x=>x.querySelector('h2')?.textContent==='长审批（已更新）');
      return {open:card?.querySelector('details')?.open,
        actions:[...card.querySelectorAll('.interaction-actions button')].map(x=>x.textContent)}; })()`);
    assert.equal(state.open, true, '审批更新重新渲染后应保持展开');
    assert.deepEqual(state.actions, ['允许', '拒绝']);
    assert.equal((await regress.eval(`window.__fake.calls`)).filter(x=>x[0]==='respond' && x[1]==='a-long').length, 0,
      '折叠与展开审批说明不得真的提交审批');

    await regress.eval(`(() => {
      window.DshLiteAdapter.createProject = async () => { throw {userMessage:'路径不存在'}; };
      document.getElementById('rail-new-project').click();
      document.getElementById('project-path').value = 'Z:/missing';
      document.getElementById('project-form').requestSubmit();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    state = await regress.eval(`({open:!document.getElementById('project-modal').hidden,
      feedback:document.querySelector('#project-modal .files-status')?.textContent,
      progress:document.getElementById('project-submit').textContent})`);
    assert.equal(state.open, true);
    assert.match(state.feedback, /路径不存在/, '添加项目失败原因要显示在弹窗内');
    assert.equal(state.progress, '选择此文件夹');
    await regress.eval(`document.getElementById('project-cancel').click();
      window.__fake.failFiles=true; document.getElementById('files-open').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    state = await regress.eval(`({list:document.getElementById('files-list').textContent,
      retry:!document.getElementById('files-retry').hidden,
      status:document.getElementById('files-status').textContent})`);
    assert.equal(state.retry, true, '文件列表失败时要有就地重试');
    assert.doesNotMatch(state.list, /没有文件/, '读取失败不能伪装成空文件夹');
    assert.match(state.status, /未启用/);
    await regress.eval(`window.__fake.failFiles=false;document.getElementById('files-retry').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(await regress.eval(`document.getElementById('files-list').textContent`), /report.txt/);
    assert.equal(await regress.eval(`document.getElementById('files-retry').hidden`), true);
    regress.close();

    // File preview is a DOM safety regression, not an npm compatibility test.
    const previewPage = await browser.newPage();
    await previewPage.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await previewPage.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(previewPage);
    await previewPage.eval(`document.querySelector('#session-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    await previewPage.eval(`(() => {
      window.__previewExecuted = false;
      window.__previewPayload = '<img src=x onerror="window.__previewExecuted=true"></pre><script>window.__previewExecuted=true</script>';
      window.DshLiteAdapter.listWorkspaceFiles = async () => ({path:'',entries:[{name:'payload.html',path:'payload.html',type:'file'}],nextOffset:null});
      window.DshLiteAdapter.downloadFile = async () => {
        window.__fake.calls.push(['previewDownload']);
        return {blob:new Blob([window.__previewPayload],{type:'text/html'}),name:'payload.html'};
      };
      document.getElementById('files-open').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    await previewPage.eval(`document.querySelector('#files-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    state = await previewPage.eval(`({text:document.querySelector('#files-preview pre')?.textContent,
      expected:window.__previewPayload,active:window.__previewExecuted,
      executable:!!document.querySelector('#files-preview img,#files-preview script,#files-preview iframe'),
      save:document.querySelector('#files-list a')?.download})`);
    assert.equal(state.text, state.expected, 'HTML and script file contents must stay literal text');
    assert.equal(state.active, false);
    assert.equal(state.executable, false);
    assert.equal(state.save, 'payload.html');
    await previewPage.eval(`document.querySelector('#files-preview button').click();document.querySelector('#files-list button').click()`);
    assert.equal(await previewPage.eval(`window.__fake.calls.filter(c=>c[0]==='previewDownload').length`), 1,
      'reopening a preview must not download the file again');
    await previewPage.eval(`(() => {
      document.getElementById('files-close').click();
      window.DshLiteAdapter.listWorkspaceFiles = async () => ({path:'',entries:[{name:'large.txt',path:'large.txt',type:'file'}],nextOffset:null});
      window.DshLiteAdapter.downloadFile = async () => {
        const blob = new Blob(['x'.repeat(2*1024*1024)]);
        blob.text = () => {throw new Error('must never decode the full large file');};
        return {blob,name:'large.txt'};
      };
      document.getElementById('files-open').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    await previewPage.eval(`document.querySelector('#files-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    state = await previewPage.eval(`({length:document.querySelector('#files-preview pre')?.textContent.length,
      notice:document.querySelector('#files-preview .files-preview-note')?.textContent,
      save:document.querySelector('#files-list a')?.href})`);
    assert.equal(state.length, 64*1024, 'large text preview must decode only its bounded 64 KB slice');
    assert.match(state.notice, /64 KB/);
    assert.ok(state.save.startsWith('blob:'), 'the full download remains available after preview truncation');
    await previewPage.eval(`(() => {
      document.getElementById('files-close').click();
      window.DshLiteAdapter.listWorkspaceFiles = async () => ({path:'',entries:[{name:'binary.txt',path:'binary.txt',type:'file'}],nextOffset:null});
      window.DshLiteAdapter.downloadFile = async () => ({blob:new Blob([new Uint8Array([0,1,2,3])]),name:'binary.txt'});
      document.getElementById('files-open').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    await previewPage.eval(`document.querySelector('#files-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(await previewPage.eval(`!!document.querySelector('#files-preview pre')`), false,
      'binary controls in a renamed text file must not be rendered as text');
    assert.match(await previewPage.eval(`document.getElementById('files-preview').textContent`), /不支持文本预览/);
    previewPage.close();

    const race = await browser.newPage();
    await race.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await race.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(race);
    await race.eval(`(() => {
      window.DshLiteAdapter.createSession = async value => {
        window.__fake.calls.push(['createSession',value.projectId]);
        return new Promise(resolve => { window.__fake.resolveCreate = resolve; });
      };
      document.getElementById('new-session').click();
    })()`);
    await race.eval(`(() => {
      window.__fake.onEvent({type:'projects',projects:[{id:'p1',name:'项目一'},{id:'p2',name:'项目二'}]});
      document.querySelectorAll('#project-list button')[1].click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await race.eval(`window.__fake.resolveCreate({id:'s3'})`);
    await new Promise(resolve => setTimeout(resolve, 50));
    state = await race.eval(`({selected:window.__dshLiteState(),list:document.getElementById('session-list').textContent})`);
    assert.equal(state.selected.projectId, 'p2');
    assert.equal(state.selected.sessionId, '', '旧项目创建完成不能切走当前项目的对话');
    assert.doesNotMatch(state.list, /新对话/, '旧项目新会话不能插进当前项目');
    race.close();

    const createSelection = await browser.newPage();
    await createSelection.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await createSelection.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(createSelection);
    await createSelection.eval(`(() => {
      document.querySelector('#session-list button').click();
      window.DshLiteAdapter.createSession = async () => {
        window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
          {id:'s2',title:'对话 3'},{id:'s1',title:'对话 1'}]});
        return {id:'s1'}; // DSH reported an old ID, but the list gained s2.
      };
      window.DshLiteAdapter.listSessions = async () => [
        {id:'s2',title:'对话 3'},{id:'s1',title:'对话 1'}];
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 65));
    state = await createSelection.eval(`({selected:window.__dshLiteState().sessionId,
      title:document.getElementById('session-title').textContent,
      active:[...document.querySelectorAll('#session-list button[aria-selected="true"]')].map(x=>x.textContent)})`);
    assert.equal(state.selected, 's2', '新增对话应优先匹配列表里唯一的新 ID');
    assert.equal(state.title, '对话 3');
    assert.deepEqual(state.active, ['对话 3']);
    await createSelection.eval(`(() => {
      window.__fake.newSessionVisible = false;
      window.DshLiteAdapter.createSession = async () => {
        setTimeout(() => {
          window.__fake.newSessionVisible = true;
          window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
            {id:'s3',title:'对话 4'},{id:'s2',title:'对话 3'},{id:'s1',title:'对话 1'}]});
        }, 400);
        throw new Error('response lost after create');
      };
      window.DshLiteAdapter.listSessions = async () => window.__fake.newSessionVisible ? [
        {id:'s3',title:'对话 4'},{id:'s2',title:'对话 3'},{id:'s1',title:'对话 1'}] : [
        {id:'s2',title:'对话 3'},{id:'s1',title:'对话 1'}];
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 1150));
    state = await createSelection.eval(`({selected:window.__dshLiteState().sessionId,
      error:document.getElementById('error-text').textContent,
      count:document.querySelectorAll('#session-list button').length})`);
    assert.equal(state.selected, 's3', 'RPC 响应丢失后，应从稍后到达的列表事件恢复新会话');
    assert.equal(state.error, '');
    assert.equal(state.count, 3);
    await createSelection.eval(`(() => {
      window.DshLiteAdapter.createSession = async () => ({id:'s3'});
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 5150));
    state = await createSelection.eval(`({selected:window.__dshLiteState().sessionId,
      error:document.getElementById('error-text').textContent,
      count:document.querySelectorAll('#session-list button').length})`);
    assert.equal(state.selected, 's3', '无法确认新 ID 时不得跳到另一个旧对话');
    assert.match(state.error, /无法确认/);
    assert.equal(state.count, 3, '模糊返回值不应凭空插入一条重复对话');
    createSelection.close();

    const mismatchedCreate = await browser.newPage();
    await mismatchedCreate.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await mismatchedCreate.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(mismatchedCreate);
    await mismatchedCreate.eval(`(() => {
      window.DshLiteAdapter.createSession = async () => {
        window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
          {id:'s2',title:'真正新增'},{id:'s1',title:'昨天的对话'}]});
        return {id:'unlisted-id'};
      };
      window.DshLiteAdapter.listSessions = async () => [
        {id:'s2',title:'真正新增'},{id:'s1',title:'昨天的对话'}];
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    state = await mismatchedCreate.eval(`({selected:window.__dshLiteState().sessionId,
      count:document.querySelectorAll('#session-list button').length})`);
    assert.equal(state.selected, 's2', '唯一新增列表项应优先于不在列表的返回 ID');
    assert.equal(state.count, 2, '不得把不在列表的返回 ID 添加成假对话');
    await mismatchedCreate.eval(`(() => {
      window.DshLiteAdapter.createSession = async () => {
        window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
          {id:'s4',title:'另一个新增'},{id:'s3',title:'新增对话'},
          {id:'s2',title:'真正新增'},{id:'s1',title:'昨天的对话'}]});
        return {id:'s3'};
      };
      window.DshLiteAdapter.listSessions = async () => [
        {id:'s4',title:'另一个新增'},{id:'s3',title:'新增对话'},
        {id:'s2',title:'真正新增'},{id:'s1',title:'昨天的对话'}];
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(await mismatchedCreate.eval(`window.__dshLiteState().sessionId`), 's3',
      '多个新 ID 时仅信任与新增行吻合的返回 ID');
    mismatchedCreate.close();

    const racedList = await browser.newPage();
    await racedList.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await racedList.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(racedList);
    await racedList.eval(`(() => {
      window.DshLiteAdapter.createSession = async () => ({id:'s1'});
      window.DshLiteAdapter.listSessions = () => new Promise(resolve => setTimeout(() => {
        window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
          {id:'s2',title:'事件中刚创建'},{id:'s1',title:'旧对话'}]});
        resolve([{id:'s1',title:'旧对话'}]); // stale list response after newer event
      }, 10));
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 130));
    state = await racedList.eval(`({selected:window.__dshLiteState().sessionId,
      title:document.getElementById('session-title').textContent,
      source:document.getElementById('app').dataset.liteSelect})`);
    assert.equal(state.selected, 's2', '慢列表不得抹掉同时到达的新对话事件');
    assert.equal(state.title, '事件中刚创建');
    assert.equal(state.source, 'create');
    racedList.close();

    const delayedProject = await browser.newPage();
    await delayedProject.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delayedProject.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(delayedProject);
    await delayedProject.eval(`(() => {
      localStorage.setItem('dsh-lite:project','p1');
      localStorage.setItem('dsh-lite:session','s1');
      window.__fake.created = false;
      window.DshLiteAdapter.listProjects = () => new Promise(resolve => { window.__fake.resolveProjects = resolve; });
      window.DshLiteAdapter.listSessions = async () => window.__fake.created ? [
        {id:'s2',title:'刚创建的对话'},{id:'s1',title:'昨天的对话'}] : [{id:'s1',title:'昨天的对话'}];
      window.DshLiteAdapter.createSession = async () => { window.__fake.created = true; return {id:'s2'}; };
      window.DshLiteUI.mount(window.DshLiteAdapter);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await delayedProject.eval(`document.getElementById('new-session').disabled`), true,
      '项目列表未建立基线时，不应允许新建对话');
    await delayedProject.eval(`window.__fake.resolveProjects([{id:'p1',name:'测试项目',path:'D:/example'}])`);
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(await delayedProject.eval(`window.__dshLiteState().sessionId`), 's1');
    await delayedProject.eval(`document.getElementById('new-session').click()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(await delayedProject.eval(`window.__dshLiteState().sessionId`), 's2');
    await delayedProject.eval(`document.querySelector('#project-list button').click()`);
    await new Promise(resolve => setTimeout(resolve, 90));
    state = await delayedProject.eval(`({selected:window.__dshLiteState().sessionId,
      title:document.getElementById('session-title').textContent})`);
    assert.equal(state.selected, 's2', '同项目刷新不能恢复旧会话');
    assert.equal(state.title, '刚创建的对话');
    delayedProject.close();

    const remountedCreate = await browser.newPage();
    await remountedCreate.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await remountedCreate.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(remountedCreate);
    await remountedCreate.eval(`(() => {
      localStorage.setItem('dsh-lite:project','p1');
      localStorage.setItem('dsh-lite:session','s1');
      window.__fake.created = false;
      window.DshLiteAdapter.createSession = async () => new Promise(resolve => {
        window.__fake.resolveCreate = resolve;
      });
      window.DshLiteAdapter.listSessions = async () => window.__fake.created ? [
        {id:'s2',title:'新建后到达'},{id:'s1',title:'昨天的对话'}] : [{id:'s1',title:'昨天的对话'}];
      document.getElementById('new-session').click();
      window.__fake.created = true;
      window.__fake.onEvent({type:'sessions',projectId:'p1',sessions:[
        {id:'s2',title:'新建后到达'},{id:'s1',title:'昨天的对话'}]});
      window.DshLiteUI.mount(window.DshLiteAdapter);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 110));
    state = await remountedCreate.eval(`({selected:window.__dshLiteState().sessionId,
      title:document.getElementById('session-title').textContent,
      build:document.getElementById('app').dataset.liteUiBuild,
      mount:document.getElementById('app').dataset.liteUiMount,
      stage:document.getElementById('app').dataset.liteCreate,
      pending:sessionStorage.getItem('dsh-lite:pending-create')})`);
    assert.equal(state.selected, 's2', '创建途中重新挂载也应找回唯一新增会话');
    assert.equal(state.title, '新建后到达');
    assert.equal(state.build, 'session-create-v5');
    assert.ok(Number(state.mount) >= 2, 'DOM 应可读出重新挂载次数');
    assert.equal(state.stage, 'recovered-new', 'DOM 应可读出创建恢复路径');
    assert.equal(state.pending, null, '成功恢复后应清理待确认标记');
    await remountedCreate.eval(`window.__fake.resolveCreate({id:'s2'})`);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(await remountedCreate.eval(`window.__dshLiteState().sessionId`), 's2',
      '旧组件迟到的 RPC 回复不能再覆盖新组件选择');
    assert.equal(await remountedCreate.eval(`localStorage.getItem('dsh-lite:session')`), 's2',
      '新会话一选中即保存，不能等到页面离开');
    await remountedCreate.eval(`window.DshLiteUI.mount(window.DshLiteAdapter)`);
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await remountedCreate.eval(`({selected:window.__dshLiteState().sessionId,
      source:document.getElementById('app').dataset.liteSelect})`);
    assert.equal(state.selected, 's2', '新会话加载中重新挂载，也应恢复刚选中的对话');
    assert.equal(state.source, 'restore');
    remountedCreate.close();

    const extras = await browser.newPage();
    await extras.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await extras.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(extras);
    await extras.eval(`(() => {
      window.__fake.goalReads = 0; window.__fake.queueReads = 0;
      window.DshLiteAdapter.readGoal = sessionId => {
        if (sessionId !== 's1') return Promise.resolve(null);
        if (++window.__fake.goalReads === 1) return Promise.resolve({id:'old-goal',revision:1,objective:'旧对话目标',phase:'active'});
        return new Promise(resolve => { window.__fake.resolveOldGoal = resolve; });
      };
      window.DshLiteAdapter.listQueued = sessionId => {
        if (sessionId !== 's1') return Promise.resolve([]);
        if (++window.__fake.queueReads === 1) return Promise.resolve([{id:'old-queue',text:'旧对话排队消息'}]);
        return new Promise(resolve => { window.__fake.resolveOldQueue = resolve; });
      };
      document.querySelector('#session-list button').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    state = await extras.eval(`({goal:document.getElementById('goal-bar').textContent,
      queue:document.getElementById('queue-panel').textContent})`);
    assert.match(state.goal, /旧对话目标/);
    assert.match(state.queue, /旧对话排队消息/);
    await extras.eval(`(() => {
      window.__fake.onEvent({type:'session-status',sessionId:'s1',running:true});
      document.getElementById('new-session').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    state = await extras.eval(`({session:window.__dshLiteState().sessionId,
      goalHidden:document.getElementById('goal-bar').hidden,
      queueHidden:document.getElementById('queue-panel').hidden})`);
    assert.equal(state.session, 's2');
    assert.equal(state.goalHidden, true, '切会话时应立即清除旧目标');
    assert.equal(state.queueHidden, true, '切会话时应立即清除旧排队消息');
    await extras.eval(`(() => {
      window.__fake.resolveOldGoal({id:'old-goal',revision:1,objective:'迟到的旧目标',phase:'active'});
      window.__fake.resolveOldQueue([{id:'old-queue',text:'迟到的旧消息'}]);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await extras.eval(`({goalHidden:document.getElementById('goal-bar').hidden,
      queueHidden:document.getElementById('queue-panel').hidden})`);
    assert.equal(state.goalHidden, true, '旧目标的异步回复不能污染新对话');
    assert.equal(state.queueHidden, true, '旧排队消息的异步回复不能污染新对话');
    extras.close();

    const usability = await browser.newPage();
    await usability.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await usability.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(usability);
    await usability.eval(`(() => {
      window.DshLiteAdapter.readSelection = async () => ({agentPreset:'standard',
        modelSelection:{provider:'group-a',model:'m1',reasoningEffort:'max'},
        lastUsedModel:{provider:'group-a',model:'m0'},blank:false});
      document.querySelector('#session-list button').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(await usability.eval(`document.querySelector('.composer-pick[data-kind="model"]').textContent`), 'm1',
      '输入区应显示真正的下轮模型');
    await usability.eval(`document.querySelector('.composer-pick[data-kind="mode"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    state = await usability.eval(`(() => { const dialog=document.querySelector('.screen-overlay');
      const rows=[...dialog.querySelectorAll('.pick-row')];
      return {role:dialog.getAttribute('role'),modal:dialog.getAttribute('aria-modal'),
        light:dialog.classList.contains('panel-overlay'),inert:document.getElementById('app').inert,
        note:dialog.textContent,selected:rows[0].getAttribute('aria-selected'),locked:rows.every(x=>x.disabled),
        focused:dialog.contains(document.activeElement)}; })()`);
    assert.equal(state.role, 'dialog');
    assert.equal(state.modal, 'true');
    assert.equal(state.light, true, '选择面板应与主界面使用同一套浅色表面');
    assert.equal(state.inert && state.focused, true, '面板打开时焦点必须留在面板内');
    assert.match(state.note, /新建对话/, '已开始的对话要解释工具配置为何不能更改');
    assert.equal(state.selected, 'true');
    assert.equal(state.locked, true, '已开始的对话不能给出注定失败的工具配置选项');
    await usability.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    state = await usability.eval(`({open:!!document.querySelector('.screen-overlay'),
      focus:document.activeElement.dataset.kind,inert:document.getElementById('app').inert})`);
    assert.deepEqual(state, {open:false,focus:'mode',inert:false}, 'Escape 应关闭面板并把焦点还给原按钮');
    await usability.eval(`document.querySelector('.composer-pick[data-kind="model"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await usability.eval(`document.querySelector('.pick-row').getAttribute('aria-selected')`), 'true',
      '模型列表应标出下轮已选模型');
    await usability.eval(`document.querySelector('.screen-overlay .screen-action').click();document.getElementById('files-open').click()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await usability.eval(`(() => { const input=document.getElementById('files-filter');
      input.value='report';input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    state = await usability.eval(`document.getElementById('files-list').textContent`);
    assert.match(state, /report\.txt/);
    assert.doesNotMatch(state, /src/, '文件筛选应在长目录里迅速找到目标');
    await usability.eval(`(() => { document.getElementById('files-close').click();
      window.DshLiteAdapter.readSelection = async () => ({agentPreset:'standard',
        modelSelection:{provider:'group-a',model:'deepseek-flash'},lastUsedModel:null,blank:false});
      document.querySelector('#session-list button').click(); })()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await usability.eval(`({upload:document.getElementById('upload-button').getBoundingClientRect().height,
      send:document.getElementById('send-button').getBoundingClientRect().height,
      voice:document.querySelector('.voice-button').getBoundingClientRect().height,
      goalRight:document.querySelector('.composer-pick[data-kind="goal"]').getBoundingClientRect().right,
      sendLeft:document.getElementById('send-button').getBoundingClientRect().left})`);
    assert.ok(state.upload >= 44 && state.send >= 44 && state.voice >= 44,
      '手机上的上传、发送、语音按钮应有足够大的触控区域');
    assert.ok(state.goalRight <= state.sendLeft + 1,
      '模型名称变长后，目标入口仍须在手机宽度内直接点到');
    usability.close();

    const planPage = await browser.newPage();
    await planPage.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await planPage.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(planPage);
    await planPage.eval(`(() => {
      window.DshLiteAdapter.readSelection = async () => ({plan:{active:true,pending:false}});
      document.querySelector('#session-list button').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await planPage.eval(`document.querySelector('.composer-pick[data-kind="goal"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await planPage.eval(`({exit:[...document.querySelectorAll('.plan-controls button')].some(b=>b.textContent==='退出计划模式'),
      textarea:!!document.querySelector('.goal-form textarea')})`);
    assert.equal(state.exit, true, '已启用时必须给真正的退出命令');
    assert.equal(state.textarea, true, '长目标应能多行查看和编辑');
    await planPage.eval(`[...document.querySelectorAll('.plan-controls button')].find(b=>b.textContent==='退出计划模式').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok((await planPage.eval(`window.__fake.calls`)).some(x=>x[0]==='runCommand' && x[2]==='/plan off'),
      '退出计划模式必须发送 /plan off，不能再次发送 /plan');
    await planPage.eval(`(() => { document.querySelector('.screen-overlay .screen-action').click();
      window.DshLiteAdapter.readSelection = async () => ({plan:{active:false,pending:true}});
      document.querySelector('.composer-pick[data-kind="goal"]').click(); })()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await planPage.eval(`document.querySelector('.plan-controls').textContent`);
    assert.match(state, /下一步骤生效/, '计划模式待生效时不能当作已经切换完毕');
    assert.equal(await planPage.eval(`document.querySelectorAll('.plan-controls button').length`), 0);
    await planPage.eval(`(() => { document.querySelector('.screen-overlay .screen-action').click();
      window.DshLiteAdapter.readSelection = async () => ({plan:null});
      window.DshLiteAdapter.listCommands = async () => [{name:'compact'}];
      document.querySelector('.composer-pick[data-kind="goal"]').click(); })()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(await planPage.eval(`document.querySelector('.plan-controls').textContent`), /不支持计划模式/,
      '无 plan 插件的精简工具配置应明确说不支持');
    planPage.close();

    // Older DSH installations may expose only basic chat operations. A
    // missing optional method must produce a useful explanation in the panel,
    // never a silent button or an uncaught "is not a function" exception.
    const legacy = await browser.newPage();
    await legacy.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await legacy.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(legacy);
    await legacy.eval(`(() => {
      document.querySelector('#session-list button').click();
      for (const name of ['listModels','selectModel','listModes','selectMode',
        'goalAction','runCommand','listCommands']) delete window.DshLiteAdapter[name];
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await legacy.eval(`document.querySelector('.composer-pick[data-kind="model"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await legacy.eval(`document.querySelector('.screen-overlay').textContent`), /不支持.*选择模型/,
      '旧版缺少模型列表时，点“模型”应明确说明不支持');
    await legacy.eval(`document.querySelector('.screen-overlay .screen-action').click();
      document.querySelector('.composer-pick[data-kind="mode"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await legacy.eval(`document.querySelector('.screen-overlay').textContent`), /不支持.*工具配置/,
      '旧版缺少工具配置列表时，点“模式”应明确说明不支持');
    await legacy.eval(`document.querySelector('.screen-overlay .screen-action').click();
      document.querySelector('.composer-pick[data-kind="goal"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    state = await legacy.eval(`(() => { const panel=document.querySelector('.screen-overlay');
      return {text:panel.textContent,plan:panel.querySelector('.plan-controls')?.textContent,
        goal:panel.querySelector('.goal-form')?.textContent,
        enabledPlan:[...panel.querySelectorAll('.plan-controls button')].filter(x=>!x.disabled).length}; })()`);
    assert.match(state.goal || state.text, /不支持.*目标/,
      '缺少 goalAction 时，目标面板应说明无法设置目标');
    assert.match(state.plan || state.text, /不支持.*计划模式/,
      '缺少 runCommand 时，计划区应说明无法切换计划模式');
    assert.equal(state.enabledPlan, 0, '不能展示可点击但注定报错的计划按钮');
    await legacy.eval(`[...document.querySelectorAll('.screen-overlay button')]
      .find(x=>x.textContent.includes('压缩上下文')).click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await legacy.eval(`document.querySelector('.goal-compact-result')?.textContent || ''`),
      /不支持.*压缩上下文/, '缺少 runCommand 时，压缩操作应说明版本不支持');
    assert.equal(legacy.exceptions.length, 0, '旧版能力缺失时不得抛浏览器异常');
    assert.equal((await legacy.eval(`window.__fake.calls`)).filter(x =>
      ['selectModel','selectMode','goalAction','runCommand','listCommands'].includes(x[0])).length, 0,
    '缺少可选方法时不能发出对应操作');
    legacy.close();

    // A partial adapter may list choices but not implement their mutation
    // methods. Exercise the row taps as well, including the model-effort step.
    const partial = await browser.newPage();
    await partial.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await partial.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 300);
    await waitForSessionList(partial);
    await partial.eval(`(() => {
      document.querySelector('#session-list button').click();
      delete window.DshLiteAdapter.selectModel;
      delete window.DshLiteAdapter.selectMode;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await partial.eval(`document.querySelector('.composer-pick[data-kind="model"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await partial.eval(`document.querySelector('.screen-overlay').textContent`), /不支持.*选择模型/,
      '可列模型但不能选择时，点模型入口应明确说明不支持');
    assert.equal(await partial.eval(`document.querySelectorAll('.screen-overlay .pick-row').length`), 0,
      '不能展示注定失败的模型选项');
    await partial.eval(`document.querySelector('.screen-overlay .screen-action').click();
      document.querySelector('.composer-pick[data-kind="mode"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(await partial.eval(`document.querySelector('.screen-overlay').textContent`), /不支持.*工具配置/,
      '可列工具配置但不能选择时，点配置入口应明确说明不支持');
    assert.equal(await partial.eval(`document.querySelectorAll('.screen-overlay .pick-row').length`), 0,
      '不能展示注定失败的工具配置选项');
    assert.equal(partial.exceptions.length, 0, '部分旧版能力缺失时不得抛浏览器异常');
    assert.equal((await partial.eval(`window.__fake.calls`)).filter(x =>
      x[0] === 'selectModel' || x[0] === 'selectMode').length, 0,
    '缺少选择方法时不能尝试调用');
    partial.close();
    // Reproduce the live-install changes with actual pointer/keyboard input,
    // while retaining fixture-only model traffic and voice recognition.
    const merged = await browser.newPage();
    await merged.send('Emulation.setDeviceMetricsOverride', { width:320,height:844,deviceScaleFactor:1,mobile:true });
    await merged.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html',300);
    await waitForSessionList(merged);
    async function pointer(selector) {
      if (/^#(?:project|session)-list/.test(selector)) await openSidebar();
      let point;
      for (let attempt=0;attempt<12;attempt++) {
        try { point = await merged.eval(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||x<0||x>innerWidth||y<0||y>innerHeight||!node.contains(document.elementFromPoint(x,y)))throw Error('Fixture control is not visible: '+${JSON.stringify(selector)});return{x,y};})()`); break; }
        catch(error) { if(attempt===11)throw error; await new Promise(resolve=>setTimeout(resolve,50)); }
      }
      await merged.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await merged.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    async function inputText(text) {
      await pointer('#message-input');
      await merged.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await merged.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await merged.send('Input.insertText',{text});
    }
    async function openSidebar() {
      if (await merged.eval(`document.body.classList.contains('sidebar-hidden')`)) { await pointer('#projects-toggle'); await new Promise(resolve=>setTimeout(resolve,250)); }
    }
    async function appendInput(text) {
      await pointer('#message-input');
      await merged.send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35,modifiers:2});
      await merged.send('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35,modifiers:2});
      await merged.send('Input.insertText',{text});
    }
    await merged.eval(`window.DshI18n.setLang('en')`);
    assert.equal(await merged.eval(`document.getElementById('projects-toggle').getAttribute('aria-label')`),'Projects and chats');
    assert.equal(await merged.eval(`document.getElementById('new-project').textContent`),'+ Add project');
    assert.equal(await merged.eval(`document.querySelector('.voice-lang-select option').textContent`),'Same as interface');
    await merged.eval(`window.__savedProjects=window.DshLiteAdapter.listProjects;window.DshLiteAdapter.listProjects=async()=>{throw {userMessage:'Fixture projects unavailable.'}}`);
    await openSidebar();
    await pointer('#reconnect'); await new Promise(resolve=>setTimeout(resolve,50));
    assert.match(await merged.eval(`document.getElementById('project-list').textContent`),/Fixture projects unavailable/);
    assert.equal(await merged.eval(`window.__dshLiteState().connection`),'connected','list failure must not falsely disconnect a working transport');
    await merged.eval(`window.DshLiteAdapter.listProjects=window.__savedProjects`);
    await pointer('#project-list button'); await waitForSessionList(merged);
    await merged.eval(`window.__savedSessions=window.DshLiteAdapter.listSessions;window.DshLiteAdapter.listSessions=async()=>{throw {userMessage:'Fixture chats unavailable.'}}`);
    await pointer('#project-list button'); await new Promise(resolve=>setTimeout(resolve,50));
    assert.match(await merged.eval(`document.getElementById('session-list').textContent`),/Fixture chats unavailable/);
    await merged.eval(`window.DshLiteAdapter.listSessions=async()=>[{id:'s1',title:'First fixture chat'},{id:'s2',title:'Second fixture chat'}]`);
    await pointer('#session-list button'); await waitForSessionList(merged);
    await pointer('#session-list button'); await new Promise(resolve=>setTimeout(resolve,40));
    await merged.eval(`window.DshLiteAdapter.sendMessage=value=>new Promise(resolve=>{window.__sentValue=value;window.__releaseSend=resolve})`);
    await inputText('Original command'); await pointer('#send-button');
    assert.equal(await merged.eval(`document.getElementById('message-input').disabled`),false,'sending must not interrupt further typing');
    await appendInput(' plus newer draft');
    await merged.eval(`window.__fake.onEvent({type:'status',state:'disconnected'})`);
    assert.equal(await merged.eval(`document.getElementById('message-input').disabled`),false,'disconnect must not interrupt further typing');
    assert.equal(await merged.eval(`document.getElementById('send-button').disabled`),true);
    await merged.eval(`window.__fake.onEvent({type:'status',state:'connected'});window.__releaseSend()`);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await merged.eval(`document.getElementById('message-input').value`),'Original command plus newer draft','accepted Send must not clear newer input');
    await pointer('#send-button'); await appendInput(' retained after switching');
    await openSidebar();
    await pointer('#session-list button:nth-child(2)'); await new Promise(resolve=>setTimeout(resolve,40));
    await inputText('Different chat draft'); await merged.eval(`window.__releaseSend()`); await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(await merged.eval(`document.getElementById('message-input').value`),'Different chat draft');
    await openSidebar();
    await pointer('#session-list button'); await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(await merged.eval(`document.getElementById('message-input').value`),'Original command plus newer draft retained after switching','the original chat must keep text written after its submitted snapshot');
    await inputText('Exactly submitted text'); await pointer('#send-button'); await merged.eval(`window.__releaseSend()`); await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(await merged.eval(`document.getElementById('message-input').value`),'','only an unchanged submitted draft may be cleared');
    await merged.eval(`(()=>{window.__voice.stalled=true;window.__clockNow=0;window.__voiceTimers=new Map();let next=-1;
      const realSet=window.setTimeout,realClear=window.clearTimeout;
      window.setTimeout=(fn,delay,...args)=>{if(delay===30000){const id=next--;window.__voiceTimers.set(id,{fn,at:window.__clockNow+delay});return id}return realSet(fn,delay,...args)};
      window.clearTimeout=id=>{if(window.__voiceTimers.has(id))window.__voiceTimers.delete(id);else realClear(id)};
      window.__advanceVoice=ms=>{window.__clockNow+=ms;for(const [id,timer] of [...window.__voiceTimers])if(timer.at<=window.__clockNow){window.__voiceTimers.delete(id);timer.fn()}};})()`);
    await pointer('#voice-button');
    await merged.eval(`window.__advanceVoice(20000);window.__voice.handlers.onPartial('Long speech remains active');window.__advanceVoice(20000)`);
    assert.equal(await merged.eval(`document.getElementById('voice-button').classList.contains('is-listening')`),true,'40 seconds of active speech must not trip a fixed 30-second deadline');
    await merged.eval(`window.__advanceVoice(30001)`);
    assert.equal(await merged.eval(`document.getElementById('voice-button').classList.contains('is-listening')`),false,'30 seconds without new speech must stop a stuck recognizer');
    assert.ok(await merged.eval(`window.__voice.stopped>0&&window.__voice.aborted>0`));
    await pointer('#voice-button'); await merged.eval(`window.__oldVoiceHandlers=window.__voice.handlers`);
    await pointer('#voice-button'); await pointer('#voice-button');
    await merged.eval(`window.__voice.handlers.onPartial('Fresh recognition');window.__currentVoiceDraft=document.getElementById('message-input').value;
      window.__oldVoiceHandlers.onPartial('Stale recognition');window.__oldVoiceHandlers.onEnd('')`);
    assert.equal(await merged.eval(`document.getElementById('message-input').value===window.__currentVoiceDraft&&document.getElementById('voice-button').classList.contains('is-listening')`),true,'late callbacks from a stopped recognizer cannot change a newer draft or reset a new recording');
    await pointer('#voice-button');
    await merged.eval(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedTurn=text}}});
      window.__fake.onEvent({type:'records',sessionId:'s1',records:[{id:'u-merge',role:'user',text:'Question'},
      {id:'a-merge-one',role:'assistant',text:'First reply part.'},{id:'t-merge',role:'thought',text:'Private thought.'},
      {id:'a-merge-two',role:'assistant',text:'Second reply part.'},{id:'u-next',role:'user',text:'Next question'},
      {id:'a-next',role:'assistant',text:'A different turn.'}],hasMore:false})`);
    await pointer('#record-list .record[data-role="assistant"] .record-copy');
    assert.equal(await merged.eval(`window.__copiedTurn`),'First reply part.\n\nSecond reply part.','whole-reply copy must exclude thoughts and later turns');
    assert.equal(await merged.eval(`document.querySelector('.record[data-role="user"] .record-role').textContent`),'Me','generated self-message labels must follow the chosen interface language');
    await merged.send('Browser.setDownloadBehavior',{behavior:'deny'});
    await merged.eval(`window.DshLiteAdapter.screenShot=async()=>({mime:'image/png',image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII='})`);
    await pointer('#rail-screen'); await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await merged.eval(`document.querySelector('.screen-save').disabled`),false,'screen saving requires an actual current fixture image');
    await pointer('.screen-save');
    assert.equal(await merged.eval(`document.querySelector('.screen-save').textContent`),'Download started','a browser click cannot confirm that a file was saved');
    await merged.eval(`window.DshLiteAdapter.screenShot=async()=>{throw Error('Fixture capture failed')}`);
    await pointer('.screen-bar .screen-action:not(.screen-save)'); await new Promise(resolve=>setTimeout(resolve,1850));
    assert.equal(await merged.eval(`document.querySelector('.screen-save').disabled`),true,'the save feedback timer must not reenable a stale image after failed refresh');
    await pointer('.screen-bar .screen-action:last-child');
    assert.equal(await merged.eval(`document.documentElement.scrollWidth<=innerWidth`),true);
    assert.equal(merged.exceptions.length,0);
    assert.equal(await merged.eval(`localStorage.getItem('dsh-lite:drafts')`),null,'the safe merge must not introduce unscoped persistent conversation text');
    const mergedShot = await merged.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(root,'logs','dsh-live-merge-320.png'),Buffer.from(mergedShot.data,'base64'));
    merged.close();
    console.log('DSH live-change merge browser checks passed (pointer/keyboard retries / localization / send drafts / voice lifetime)');
    console.log('DSH mobile shell legacy capability checks passed (model / mode / goal / plan / compact)');
    console.log('DSH mobile shell usability checks passed (selection / lock / focus / files / touch)');
    console.log('DSH mobile shell plan-mode checks passed (enter / exit / pending / unsupported)');
    console.log('DSH mobile shell state isolation checks passed (drafts / interactions / modal errors / project race / async context)');
    console.log('DSH mobile shell session-restore checks passed');
    console.log('DSH mobile shell browser checks passed');
  } finally {
    if (browser) {
      try { await browser.send('Browser.close'); } catch (_) {}
      try { browser.ws.close(); } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 400));
      const profile = path.resolve(browser.profile || '');
      if (profile.startsWith(path.resolve(process.env.TEMP) + path.sep) && path.basename(profile).startsWith('dsh-gw-browser-')) {
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch (_) {}
      }
    }
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
