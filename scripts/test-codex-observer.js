'use strict';
// Real UI, isolated transport: never contacts the gateway or a Codex session.
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { Browser } = require('./browser-check.js');
const root = path.resolve(__dirname, '..');
const bootstrap = `
window.fixture = { status: 'inProgress', calls: [], requests: [], fail: false, owned:false, approval:false, items: [], threadId: 'fixture-thread' };
window.WebSocket = class {
  constructor() { this.readyState = 1; window.fixture.socket = this; setTimeout(() => this.onopen && this.onopen(), 0); }
  send(raw) {
    const m = JSON.parse(raw); fixture.calls.push(m.method); fixture.requests.push(m);
    if (!m.method) return;
    if(fixture.hang && m.method.startsWith('thread/'))return;
    if(fixture.rejectSteer && m.method==='turn/steer') { setTimeout(()=>this.onmessage({data:JSON.stringify({id:m.id,error:{message:'thread not found'}})}),0);return; }
    if(fixture.rejectStart && m.method==='turn/start') { setTimeout(()=>this.onmessage({data:JSON.stringify({id:m.id,error:{message:'fixture send failed'}})}),0);return; }
    let result = {};
    if (m.method === 'thread/list') result = {data:[{id:'fixture-thread',name:'手机状态验证',status:{type:'notLoaded'}}]};
    if (m.method === 'thread/read') result = {thread:{id:m.params.threadId,status:fixture.unloaded?{type:'notLoaded'}:fixture.approval?{type:'active',activeFlags:['waitingOnApproval']}:{type:fixture.status==='inProgress'?'active':'idle'}}};
    if (m.method === 'thread/loaded/list') result = {data:fixture.owned?['fixture-thread']:[]};
    if (m.method === 'thread/resume' && fixture.approval) setTimeout(()=>this.onmessage({data:JSON.stringify({id:999,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:'fixture-turn',command:'fixture validation',reason:'隔离测试审批'}})}),10);
    if (m.method === 'turn/steer') result = {turnId:'fixture-turn'};
    if (m.method === 'thread/turns/list') result = {data:[{id:'fixture-turn',status:fixture.status,items:[]}]};
    if (m.method === 'thread/items/list') result = {data:fixture.items.map(item=>({turnId:'fixture-turn',item})),nextCursor:null};
    if (m.method === 'model/list') result = {data:[]};
    setTimeout(() => this.onmessage && this.onmessage({data:JSON.stringify(fixture.fail && m.method.startsWith('thread/')
      ? {id:m.id,error:{message:'fixture connection lost'}} : {id:m.id,result})}), 0);
  }
  close() { this.readyState = 3; if(this.onclose)this.onclose(); }
};
`;
(async () => {
  const html = fs.readFileSync(path.join(root, 'pwa/codex.html'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-review-observer-'));
  const uploadHandler = require('./codex-uploads.js').createUploadHandler(path.join(fixtureDir,'uploads'));
  const queueService = require('./codex-queue.js').createQueueService(path.join(fixtureDir,'queue'),()=>0);
  queueService.store.entries=[];queueService.store.save();
  queueService.store.rpc=async()=>{throw new Error('connection intentionally offline in UI test');};
  const server = http.createServer((req,res) => {
    if(req.url.startsWith('/codex/upload'))return uploadHandler(req,res);
    if(req.url.startsWith('/codex/queue'))return queueService.handle(req,res);
    // 页面按绝对路径取这几个脚本：/polyfill.js /i18n.js /compat.js /e2ee.js /voice.js。
    // 兜底分支一律回 HTML 的话，浏览器会把 HTML 当 JS 执行 ——
    // 报出来的是 5 个 "SyntaxError: Unexpected token '<'"，接着 t() 未定义，
    // 后面几十条断言全跟着倒，看起来像页面塌了，其实是这个宿主太旧。
    // 所以静态文件必须真的发出去，只对认不出的路径才兜底回页面。
    const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(path.join(root, 'pwa'), rel);
    if (rel && file.startsWith(path.join(root, 'pwa')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', /\.js$/.test(file) ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8');
      return res.end(fs.readFileSync(file));
    }
    res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser, page, failed = 0;
  const check = (name, value) => { console.log((value ? 'PASS ' : 'FAIL ') + name); if (!value) failed++; };
  const waitForPageReady = async () => {
    const deadline = Date.now() + 30000;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await page.eval(`(() => {
          const mode = document.getElementById('send-mode');
          return {
            loaded: document.readyState === 'complete',
            fixture: !!window.fixture,
            input: !!document.getElementById('input'),
            mode: !!mode && typeof mode.onchange === 'function',
            connected: typeof state !== 'undefined' && state.ready === true
          };
        })()`, 3000);
        if (Object.values(last).every(Boolean)) return;
      } catch (err) {
        // Page.navigate can return before the new execution context is available.
        last = { evaluationError: err.message };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Codex fixture page did not initialize: ' + JSON.stringify(last));
  };
  try {
    browser = await Browser.launch();
    page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:bootstrap});
    const forcedLanguage = process.argv.includes('--force-en') ? 'en-US'
      : process.argv.includes('--force-es') ? 'es-ES' : null;
    if (forcedLanguage) {
      await page.send('Page.addScriptToEvaluateOnNewDocument',{source:
        `Object.defineProperty(navigator,'language',{get:()=> ${JSON.stringify(forcedLanguage)}});Object.defineProperty(navigator,'languages',{get:()=> [${JSON.stringify(forcedLanguage)}]});`});
    }
    await page.goto('http://127.0.0.1:' + server.address().port,300);
    await waitForPageReady();
    // 像真人一样改：赋值 + 触发 change。直接写 .value 会绕过 onchange，
    // 而 onchange 里才记「使用者选的是哪个模式」—— 绕过它就测不出
    // 「选择被临时状态覆盖」那类问题。
    const pickMode = (v) => page.eval(`(()=>{const s=document.getElementById('send-mode');s.value=${JSON.stringify(v)};s.dispatchEvent(new Event('change'));})()`);
    await pickMode('immediate');
    await page.eval(`fixture.unloaded=true;openThread({id:'fixture-thread',name:'历史不能代替实时状态'})`);
    await new Promise(r=>setTimeout(r,250));
    check('unloaded historical active turn is queue-only',await page.eval(`task.kind==='unlinked' && queueOnly() && !state.running`));
    await page.eval(`fixture.status='completed';refreshObservedThread()`);
    await new Promise(r=>setTimeout(r,150));
    check('stale completed history cannot enable resume or steering',await page.eval(`task.kind==='unlinked' && queueOnly() && !fixture.calls.some(x=>['thread/resume','turn/steer','turn/start','turn/interrupt'].includes(x))`));
    await page.eval(`fixture.unloaded=false;fixture.status='inProgress'`);
    await page.eval(`openThread({id:'fixture-thread',name:'手机状态验证',status:{type:'notLoaded'}})`);
    await new Promise(r=>setTimeout(r,500));
    check('opening an already running desktop turn shows running', await page.eval(`state.running === true`));
    check('persistent task status is visible', await page.eval(`!!document.getElementById('task-status') && [t('执行中'),t('思考中')].some(x=>document.getElementById('task-status').textContent.includes(x))`));
    await page.eval(`onNotify('item/started',{threadId:'fixture-thread',item:{id:'reason-1',type:'reasoning',summary:[]}}); tidyItems(); onNotify('item/reasoning/summaryTextDelta',{threadId:'fixture-thread',itemId:'reason-1',summaryIndex:0,delta:'正在检查手机与电脑的状态同步。'});`);
    await new Promise(r=>setTimeout(r,100));
    check('summary arriving after empty placeholder cleanup is visible', await page.eval(`Array.from(document.querySelectorAll('.think')).some(x=>x.isConnected && getComputedStyle(x).display !== 'none' && x.textContent.includes('正在检查手机'))`));
    check('current summary opens automatically', await page.eval(`Array.from(document.querySelectorAll('.think')).some(x=>x.open && x.textContent.includes('正在检查手机'))`));
    check('viewing never resumes, interrupts or releases desktop thread', await page.eval(`!fixture.calls.some(x=>['thread/resume','turn/interrupt','thread/unsubscribe','turn/start'].includes(x))`));
    if (process.argv.includes('--expanded')) {
      await page.eval(`fixture.status='completed'; if(typeof refreshObservedThread==='function') refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,200));
      check('completion while viewing is recovered without notifications', await page.eval(`!state.running && document.getElementById('task-status').textContent.includes(t('已完成'))`));
      await page.eval(`fixture.status='failed'; refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,150));
      check('failed turn is not labelled completed', await page.eval(`document.getElementById('task-status').textContent.includes(t('执行失败'))`));
      await page.eval(`fixture.fail=true; refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,150));
      check('read failure shows unknown not success', await page.eval(`[t('暂时无法确认任务状态'),t('同步失败，暂时无法确认是否完成；将自动重试。'),t('连接中断 · 任务状态未知')].some(x=>document.getElementById('task-status').textContent.includes(x))`));
      await page.eval(`fixture.fail=false; fixture.status='inProgress'; fixture.items=[{id:'desktop-progress',type:'agentMessage',text:'已检查连接，正在验证状态恢复。'}];`);
      await new Promise(r=>setTimeout(r,1300));
      await page.eval(`refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,150));
      check('desktop progress is refreshed in timeline', await page.eval(`document.getElementById('body').textContent.includes('正在验证状态恢复')`));
      await page.eval(`onNotify('thread/status/changed',{threadId:'fixture-thread',status:{type:'active',activeFlags:['waitingOnApproval']}});`);
      check('approval wait is explicit', await page.eval(`document.getElementById('task-status').textContent.includes(t('等待审批'))`));
      await page.eval(`fixture.socket.close()`);
      check('disconnect does not imply task finished', await page.eval(`document.getElementById('task-status').textContent.includes(t('连接中断 · 任务状态未知'))`));
      await new Promise(r=>setTimeout(r,1300));
      check('reconnect refreshes currently open thread', await page.eval(`state.ready && state.running && document.getElementById('task-status').textContent.includes(t('执行中'))`));
      check('running turn offers stop and send together',await page.eval(`!!document.querySelector('.stop') && getComputedStyle(document.getElementById('send')).display!=='none' && !document.getElementById('send').disabled`));
      await page.eval(`document.getElementById('input').value='补充验证切屏恢复'; send();`);
      await new Promise(r=>setTimeout(r,100));
      const steered = await page.eval(`fixture.requests.some(x=>x.method==='turn/steer' && x.params.expectedTurnId==='fixture-turn') && !fixture.calls.includes('turn/start') && !fixture.calls.includes('turn/interrupt')`);
      // 这条失败时只说「没发 steer」，看不出是被哪道门挡下的 ——
      // send() 有好几个提前 return 的分支，失败时把状态打出来省得靠猜。
      if (!steered) console.log('      [诊断] ' + await page.eval(`JSON.stringify({running:state.running,kind:task.kind,ready:state.ready,turnId:state.turnId,sending:state.sending,resuming:state.resuming,thread:!!state.thread,queueOnly:queueOnly(),mode:document.getElementById('send-mode').value,lastCalls:fixture.calls.slice(-6)})`));
      check('mid-turn message uses steer with matching turn ID', steered);
      await page.eval(`fixture.rejectSteer=true;document.getElementById('input').value='必须保留的草稿';send();`);
      await new Promise(r=>setTimeout(r,100));
      check('rejected steering preserves unsent draft',await page.eval(`document.getElementById('input').value==='必须保留的草稿' && !fixture.calls.includes('turn/start')`));
      await page.eval(`fixture.rejectSteer=false;document.getElementById('input').value='';`);
      await page.eval(`fixture.owned=true;fixture.approval=true;refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,150));
      check('pending approval appears on attach without sending a message',await page.eval(`document.getElementById('apprs').textContent.includes('隔离测试审批') && state.resumed`));
      await page.eval(`onNotify('serverRequest/resolved',{threadId:'fixture-thread',requestId:999});fixture.approval=false;`);
      check('approval resolved elsewhere is removed',await page.eval(`!document.getElementById('apprs').textContent.includes('隔离测试审批')`));
      await page.eval(`fixture.status='completed';document.dispatchEvent(new Event('visibilitychange'));`);
      await new Promise(r=>setTimeout(r,150));
      check('returning to foreground resynchronizes immediately',await page.eval(`!state.running && document.getElementById('task-status').textContent.includes(t('已完成'))`));
      await page.eval(`fixture.status='inProgress';refreshObservedThread();`);
      await new Promise(r=>setTimeout(r,150));
      await page.eval(`window.dispatchEvent(new Event('pagehide'));`);
      check('backgrounding does not unsubscribe a running task',await page.eval(`!fixture.calls.includes('thread/unsubscribe')`));
      await page.eval(`onNotify('item/started',{threadId:'fixture-thread',item:{id:'reason-2',type:'reasoning',summary:[]}});tidyItems();onNotify('item/reasoning/summaryTextDelta',{threadId:'fixture-thread',itemId:'reason-2',delta:'正在验证前台恢复后的连接。',summaryIndex:0});`);
      await new Promise(r=>setTimeout(r,80));
      check('adjacent reasoning items keep their live targets',await page.eval(`state.items['reason-1'].el.isConnected && state.items['reason-2'].el.isConnected && state.items['reason-2'].el.textContent.includes('前台恢复')`));
      check('no horizontal overflow on phone',await page.eval(`document.documentElement.scrollWidth <= innerWidth`));
    }
    // ── 长列表不整页重绘 ────────────────────────────────────────────────────
    //
    // 判据用**节点身份**，不是看数量 —— 数量对得上也可能是全部拆了重建。
    // 真正的证据是：已有的那一条还是**同一个** DOM 元素，而且仍然挂在文档里。
    // 整页重绘的代价不只是慢：滚动位置、展开状态、选中状态都会丢。
    {
      const redraw = await page.eval(`(async () => {
        const tid = state.thread.id;
        for (let i = 0; i < 8; i++) {
          onNotify('item/started', { threadId: tid, item: { id: 'rd-' + i, type: 'reasoning', summary: [] } });
          onNotify('item/reasoning/summaryTextDelta', { threadId: tid, itemId: 'rd-' + i, summaryIndex: 0, delta: '第 ' + i + ' 条摘要' });
        }
        await new Promise(r => setTimeout(r, 120));
        const before = state.items['rd-0'] && state.items['rd-0'].el;
        const countBefore = document.querySelectorAll('.bub,.tool,.think').length;

        // 再来一条新的：只该新增，不该把前面那些重造一遍
        onNotify('item/started', { threadId: tid, item: { id: 'rd-new', type: 'reasoning', summary: [] } });
        onNotify('item/reasoning/summaryTextDelta', { threadId: tid, itemId: 'rd-new', summaryIndex: 0, delta: '最新一条' });
        await new Promise(r => setTimeout(r, 120));

        return {
          sameNode: !!(before && before.isConnected && state.items['rd-0'].el === before),
          countBefore: countBefore,
          countAfter: document.querySelectorAll('.bub,.tool,.think').length
        };
      })()`);
      check('新内容不重造已有节点（不整页重绘）', redraw.sameNode === true, JSON.stringify(redraw));
      check('新内容只新增自己那一条', redraw.countAfter === redraw.countBefore + 1,
        `${redraw.countBefore} → ${redraw.countAfter}`);
    }

    // ── 列表角标：未读 + 待审批 ─────────────────────────────────────────────
    //
    // 判据的来源要分清，不然很容易变成「编一个数字出来」：
    //   · 待审批 / 等待回复 → **只看服务端给的 activeFlags**，没有就不显示
    //   · 未读 → 用服务端的 updatedAt 和本地记的「上次打开时间」比。
    //     它表达的是「这条比你看的时候新」，**不是「有几条未读」** ——
    //     真实条数服务端并没有给。
    {
      const badges = await page.eval(`(() => {
        const out = {};
        const t1 = { id: 'fx-unread', name: '有未读', status: { type: 'notLoaded' }, updatedAt: Date.now() - 1000 };
        try { localStorage.removeItem('dsh-seen-fx-unread'); } catch (e) {}
        out.unreadShown = !!threadRow(t1).querySelector('.dot');
        markSeen(t1);
        out.unreadGoneAfterSeen = !threadRow(t1).querySelector('.dot');

        const t2 = { id: 'fx-appr', name: '等审批', status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
        out.apprChip = threadRow(t2).querySelector('.chip.appr')?.textContent === t('等待审批');
        const t4 = { id: 'fx-wait', name: '等回复', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } };
        out.waitChip = threadRow(t4).querySelector('.chip.wait')?.textContent === t('等待你回复');
        const t3 = { id: 'fx-flagless', name: '没有 flags', status: { type: 'active' } };
        out.noFakeChip = !threadRow(t3).querySelector('.chip.appr,.chip.wait');
        const t5 = { id: 'fx-nostatus', name: '没有状态' };
        out.noCrash = !!threadRow(t5);
        return out;
      })()`);
      check('列表：比上次看过更新的会话显示未读点', badges.unreadShown === true);
      check('列表：打开过之后未读点消失', badges.unreadGoneAfterSeen === true);
      check('列表：服务端说在等审批 → 显示待审批角标', badges.apprChip === true);
      check('列表：服务端说在等你回复 → 显示等待回复角标', badges.waitChip === true);
      check('列表：没有 activeFlags 时不凭空显示等待角标', badges.noFakeChip === true);
      check('列表：会话没有 status 也不炸', badges.noCrash === true);
    }

    check('no uncaught browser exceptions',page.exceptions.length===0);
    if(process.argv.includes('--attachments')){
      await page.eval(`openAttachmentPicker()`);
      check('attachment menu is visible',await page.eval(`getComputedStyle(document.getElementById('sheet')).display==='flex'`));
      await page.eval(`closeSheet();`);
      await page.eval(`(async()=>{
        const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXsQAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
        await chooseAttachments([new File([bytes],'手机截图.png',{type:'image/png'}),new File(['附件测试'],'说明.txt',{type:'text/plain'})]);
      })()`);
      check('image and document upload through real handler',await page.eval(`draftAttachments().length===2 && draftAttachments().every(a=>a.status==='ready') && draftAttachments()[0].upload.kind==='image'`));
      check('attachment cards show filename and ready status',await page.eval(`document.getElementById('attachments').textContent.includes('说明.txt') && document.getElementById('attachments').textContent.includes(t('已上传 · '))`));
      await page.eval(`fixture.status='inProgress';state.running=true;state.turnId='fixture-turn';task.kind='running';document.getElementById('input').value='';send();`);
      await new Promise(r=>setTimeout(r,100));
      check('attachments alone can be sent during a running turn',await page.eval(`fixture.requests.filter(x=>x.method==='turn/steer').some(x=>x.params.input.some(i=>i.type==='localImage') && x.params.input.some(i=>i.type==='text' && i.text.includes('说明.txt'))) && draftAttachments().length===0`));
      await page.eval(`chooseAttachments([new File(['另一份附件'],'待发送.txt',{type:'text/plain'})])`);
      await page.eval(`fixture.status='completed';state.running=false;task.kind='completed';state.resumed=true;fixture.rejectStart=true;document.getElementById('input').value='请查看文件';send();`);
      await new Promise(r=>setTimeout(r,100));
      check('failed new message keeps its attachments and text',await page.eval(`draftAttachments().length===1 && document.getElementById('input').value==='请查看文件'`));
      await page.eval(`fixture.rejectStart=false;state.running=false;task.kind='completed';send();`);
      await new Promise(r=>setTimeout(r,100));
      check('new message includes file path and clears only after acceptance',await page.eval(`fixture.requests.filter(x=>x.method==='turn/start').some(x=>x.params.input.some(i=>i.type==='text' && i.text.includes('待发送.txt'))) && draftAttachments().length===0`));

      // ── 上传中：真实进度 + 能取消且不丢文件 ────────────────────────────────
      //
      // 进度这里只显示「已经过去多久」。fetch 拿不到上传百分比（那是 XHR 的能力），
      // 所以**不能编** —— 而使用者会照着百分比判断还要等多久。
      const cancel = await page.eval(`(() => {
        const out = {};
        const a = { id:'att-cancel-probe', name:'取消探针.txt',
          file:new File(['abc'],'取消探针.txt',{type:'text/plain'}),
          threadId:state.thread.id, status:'uploading', startedAt:Date.now()-4000,
          canceled:false, __aborted:false,
          controller:{ abort(){ a.__aborted = true; } } };
        draftAttachments(state.thread.id).push(a);
        renderAttachments();
        const row = Array.from(document.querySelectorAll('.attachment'))
          .find(r => r.textContent.includes('取消探针.txt'));
        out.text = row ? row.textContent : '';
        const elapsed = Math.round((Date.now() - a.startedAt) / 1000);
        const status = row && row.querySelector('[data-attach-status]');
        out.showsElapsed = !!status && [elapsed - 1, elapsed, elapsed + 1]
          .some(n => n >= 0 && status.textContent === t('正在上传… {n}s', { n }));
        out.noFakePercent = !/%/.test(out.text);
        const btn = row && Array.from(row.querySelectorAll('button')).find(b => b.textContent === t('取消'));
        out.hasCancel = !!btn;
        if (btn) btn.click();
        out.markedCanceled = a.canceled === true;
        out.aborted = a.__aborted === true;
        // 取消之后的呈现：文件还在，而且给重试
        a.status = 'canceled';
        renderAttachments();
        const row2 = Array.from(document.querySelectorAll('.attachment'))
          .find(r => r.textContent.includes('取消探针.txt'));
        out.keptAfterCancel = !!row2;
        out.saysFileKept = !!(row2 && row2.textContent.includes(t('已取消上传，文件还在，可以重试')));
        out.hasRetry = !!(row2 && Array.from(row2.querySelectorAll('button')).find(b => b.textContent === t('重试')));
        // 清理，别影响后面的断言
        const list = draftAttachments(state.thread.id);
        const i = list.indexOf(a); if (i >= 0) list.splice(i, 1);
        renderAttachments();
        return out;
      })()`);
      check('上传中显示的是真实耗时，不是编出来的百分比',
        cancel.showsElapsed === true && cancel.noFakePercent === true, cancel.text);
      check('上传中提供「取消」', cancel.hasCancel === true);
      check('点取消会真的中止上传', cancel.markedCanceled === true && cancel.aborted === true);
      check('取消后文件保留（不用重新去相册找）', cancel.keptAfterCancel === true && cancel.saysFileKept === true);
      check('取消后可以重试', cancel.hasRetry === true);
    }
    if (page.exceptions.length) console.log(page.exceptions);
    if(process.argv.includes('--queue')){
      await page.eval(`fixture.status='inProgress';state.running=true;state.turnId='fixture-turn';task.kind='running';`);
      await pickMode('queue');
      await page.eval(`document.getElementById('input').value='排队的下一项任务';send();`);
      await new Promise(r=>setTimeout(r,180));
      check('queue mode saves message without steering',await page.eval(`queueEntries.some(e=>e.label.includes('排队的下一项任务')) && document.getElementById('input').value===''`));
      await page.goto('http://127.0.0.1:'+server.address().port,300);
      await waitForPageReady();
      await page.eval(`openThread({id:'fixture-thread',name:'队列恢复验证'})`);
      await new Promise(r=>setTimeout(r,200));
      check('queued message reappears after full page reload',await page.eval(`document.getElementById('queued-messages').textContent.includes('排队的下一项任务')`));
      await page.eval(`document.querySelector('#queued-messages button').click()`);
      await new Promise(r=>setTimeout(r,150));
      check('cancel removes persisted queue message',await page.eval(`queueEntries.length===0`));
      check('queue operations never start or steer the active turn',await page.eval(`!fixture.calls.includes('turn/start')&&!fixture.calls.includes('turn/steer')&&!fixture.calls.includes('turn/interrupt')`));
    }
    const shot=await page.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(fixtureDir,'preview.png'),Buffer.from(shot.data,'base64'));
  } finally {
    if(page)page.close();
    if(browser){try{await browser.send('Browser.close');}catch(e){}browser.ws.close();browser.proc.kill();}
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
  }
  process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
