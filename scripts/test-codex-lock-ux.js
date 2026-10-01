'use strict';

// Exercise the actual mobile-page functions with fake RPCs, DOM, and timers.
// The queue case uses an isolated file. This test never touches the live bridge,
// a real Codex thread, or the desktop application.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./page-source.js');
const { QueueStore } = require('./codex-queue.js');

const ROOT = path.resolve(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'pwa', 'codex.html'), 'utf8');
let passed = 0, failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' → ' + detail : '')); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function loadFunctions(box, names) {
  vm.createContext(box);
  for (const name of names) {
    const source = extractFunction(PAGE, name);
    if (!source) throw Error('Missing mobile-page function: ' + name);
    vm.runInContext(source, box);
  }
  return box;
}

function ownershipHarness() {
  const rpc = [], timers = [], refreshed = [];
  let loaded = { data: [] };
  let runtime = 'active';
  const detachedHandbacks = Object.create(null);
  const state = {
    view: 'thread', thread: { id: 'source-thread', cwd: 'D:/fixture' },
    ready: true, resumed: false, running: false, resuming: false,
    releaseTimer: null
  };
  const box = loadFunctions({
    state, detachedHandbacks, Promise,
    call(method, params) {
      rpc.push({ method, params });
      if (method === 'thread/loaded/list') return Promise.resolve(loaded);
      if (method === 'thread/read') return Promise.resolve({ thread: { status: { type: runtime } } });
      if (method === 'thread/unsubscribe') return Promise.resolve({});
      if (method === 'thread/resume') return Promise.resolve({});
      throw Error('Unexpected RPC: ' + method);
    },
    renderFooter() {}, refreshObservedThread() { refreshed.push('refresh'); },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setTimeout(fn, delay) {
      const timer = { fn, delay, cancelled: false };
      timers.push(timer);
      return timer;
    }
  }, ['warmUpThread', 'statusKind', 'releaseThread', 'scheduleRelease',
    'scheduleDetachedHandback', 'ensureOwnershipAfterResume']);
  return { box, state, rpc, timers, refreshed, detachedHandbacks,
    setLoaded(value) { loaded = value; }, setRuntime(value) { runtime = value; } };
}

async function testOwnership() {
  console.log('\n[1] Reading and returning to a conversation never grabs a writer lock');
  {
    const h = ownershipHarness();
    h.box.warmUpThread();
    check('reading does not resume or unsubscribe a thread', h.rpc.length === 0);
    h.box.ensureOwnershipAfterResume();
    await flush();
    check('returning to a read-only view does not resume',
      !h.rpc.some(x => x.method === 'thread/resume'), JSON.stringify(h.rpc));
  }
  {
    const h = ownershipHarness();
    h.state.resumed = true;
    h.box.ensureOwnershipAfterResume();
    await flush();
    check('a lost phone writer is only observed, never silently reacquired',
      h.state.resumed === false && !h.rpc.some(x => x.method === 'thread/resume'), JSON.stringify(h.rpc));
  }
  {
    const h = ownershipHarness();
    h.state.resumed = true;
    h.setLoaded({ data: ['source-thread'] });
    h.box.ensureOwnershipAfterResume();
    await flush();
    check('a still-owned phone writer is left alone',
      h.state.resumed === true && !h.rpc.some(x => x.method === 'thread/resume'));
  }

  console.log('\n[2] Phone writer is handed back promptly, but never during a running turn');
  {
    const h = ownershipHarness();
    h.state.resumed = true;
    h.box.scheduleRelease();
    check('idle release uses at most a 30-second grace period',
      h.timers.length === 1 && h.timers[0].delay > 0 && h.timers[0].delay <= 30_000,
      String(h.timers[0] && h.timers[0].delay));
    h.timers[0].fn();
    await flush();
    check('idle release unsubscribes the phone, never closes desktop Codex',
      h.rpc.filter(x => x.method === 'thread/unsubscribe').length === 1 &&
      !h.rpc.some(x => x.method === 'thread/resume') && h.state.resumed === false,
      JSON.stringify(h.rpc));
  }
  {
    const h = ownershipHarness();
    h.state.resumed = true;
    h.state.running = true;
    h.box.scheduleRelease();
    h.timers[0].fn();
    await flush();
    check('running turn keeps ownership and schedules a later handback',
      h.state.resumed === true && h.timers.length >= 2 &&
      !h.rpc.some(x => x.method === 'thread/unsubscribe'));
    h.state.running = false;
    h.timers.at(-1).fn();
    await flush();
    check('handback happens after the turn is no longer running',
      h.rpc.filter(x => x.method === 'thread/unsubscribe').length === 1);
  }
}

async function testDetachedHandback() {
  console.log('\n[3] Leaving an active phone turn hands the source lock back after completion');
  for (const destination of ['list', 'other conversation']) {
    const h = ownershipHarness();
    h.state.running = true;
    h.state.resumed = true;
    h.box.releaseThread();
    check(destination + ': leaving an active turn does not unsubscribe immediately',
      !h.rpc.some(x => x.method === 'thread/unsubscribe') &&
      h.detachedHandbacks['source-thread'] && h.timers.length === 1,
      JSON.stringify(h.rpc));
    check(destination + ': detached check uses a 30-second grace period',
      h.timers[0]?.delay > 0 && h.timers[0]?.delay <= 30_000,
      String(h.timers[0]?.delay));

    h.state.running = false;
    h.state.resumed = false;
    h.state.view = destination === 'list' ? 'list' : 'thread';
    h.state.thread = destination === 'list' ? null : { id: 'another-thread' };
    h.setRuntime('active');
    h.timers[0].fn();
    await flush();
    check(destination + ': active source remains subscribed after checking status',
      !h.rpc.some(x => x.method === 'thread/unsubscribe') &&
      h.timers.length >= 2 && h.detachedHandbacks['source-thread'],
      JSON.stringify(h.rpc));

    h.setRuntime('idle');
    h.timers.at(-1).fn();
    await flush();
    check(destination + ': completion releases only the original phone thread',
      h.rpc.filter(x => x.method === 'thread/unsubscribe' &&
        x.params.threadId === 'source-thread').length === 1 &&
      !h.rpc.some(x => x.method === 'thread/resume' ||
        (x.method === 'thread/unsubscribe' && x.params.threadId === 'another-thread')),
      JSON.stringify(h.rpc));
    check(destination + ': handback clears its pending timer and never closes desktop',
      !h.detachedHandbacks['source-thread'] &&
      !h.rpc.some(x => /desktop|stop|close/i.test(x.method)));
  }
}

async function testQueue() {
  console.log('\n[4] Saved message cannot be delivered through a desktop-held writer');
  const tmp = fs.mkdtempSync(path.join(ROOT, '.codex-lock-ux-test-'));
  try {
    const calls = [];
    const queue = new QueueStore(path.join(tmp, 'queue.json'), async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' } } };
      if (method === 'thread/turns/list') return { data: [{ id: 'desktop-turn', status: 'completed' }] };
      throw Error('Queue must not call ' + method);
    });
    queue.enqueue({ id: 'saved', threadId: 'desktop-owned', input: [{ type: 'text', text: 'phone draft' }], label: 'phone draft' });
    await queue.tick();
    check('completed desktop task alone does not deliver saved input',
      queue.list('desktop-owned')[0]?.state === 'queued' &&
      !calls.some(x => x.method === 'turn/start'), JSON.stringify(calls));
    check('queue never resumes, unlocks, or interrupts desktop',
      !calls.some(x => ['thread/resume', 'thread/unsubscribe', 'turn/interrupt', 'turn/steer'].includes(x.method)));
    check('queue explains that the saved message has not reached Codex',
      /尚未|未送达/.test(queue.list('desktop-owned')[0]?.note || ''));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testQueuePresentation() {
  console.log('\n[5] Queue label distinguishes saved on PC from delivered to Codex');
  function element(tag) {
    return {
      tag, children: [], innerHTML: '', textContent: '', id: '',
      appendChild(child) { this.children.push(child); return child; }
    };
  }
  const queueBox = element('div');
  const state = { ready: true, resuming: false, thread: { id: 'desktop-owned' } };
  const box = loadFunctions({
    state, task: { kind: 'unlinked' },
    queueEntries: [{ id: 'saved', state: 'queued', label: 'phone draft',
      note: '已保存，等待执行端连接；尚未送达 Codex。' }],
    document: { createElement: element },
    $: id => id === 'queued-messages' ? queueBox : null,
    t: value => value, window: {},
    connectQueuedThread() {}, queueRequest() { return Promise.resolve({}); },
    refreshQueue() {}
  }, ['renderQueue']);
  box.renderQueue();
  const texts = [queueBox, ...queueBox.children,
    ...queueBox.children.flatMap(x => x.children || [])].map(x => x.textContent).join(' | ');
  check('saved row says the message is not delivered',
    /尚未送达|尚未发送|not (yet )?delivered|not sent/i.test(texts), texts);
  check('desktop-held writer explains why completion alone will not send',
    /电脑|写锁|占用|desktop|writer lock/i.test(texts) &&
    /等待|需|必须|until|need/i.test(texts), texts);
}

async function testSavedQueueActivation() {
  console.log('\n[5b] Saved-message activation stays explicit, guarded, and conversation-scoped');
  function harness() {
    function element(tag) { return {tag,children:[],style:{},innerHTML:'',textContent:'',id:'',appendChild(child){this.children.push(child);return child;},setAttribute(){}}; }
    const thread={id:'held'},state={view:'thread',thread,ws:{},ready:true,resumed:true,resuming:false,sending:false},task={kind:'completed'};
    const queueBox=element('div'),requests=[],rpc=[],messages=[];let footerRenders=0;
    const box=loadFunctions({state,task,queueEntries:[{id:'saved',state:'queued',requiresConfirmation:true,label:'Held instruction'}],
      document:{createElement:element},$:()=>queueBox,t:s=>s,window:{},Promise,Object,
      renderFooter(){footerRenders++;},scheduleRelease(){},refreshQueue(){},applyObservedStatus(){task.kind='idle';},toast(s){messages.push(s);},
      refreshObservedThread(){},call(method,params){rpc.push({method,params});return Promise.resolve({thread:{id:params.threadId,status:{type:'idle'}}});},
      queueRequest(body){requests.push(body);return Promise.resolve({ok:true});}},['renderQueue','connectQueuedThread','connectCurrentThread']);
    return {box,state,task,thread,requests,rpc,messages,queueBox,renderCount:()=>footerRenders};
  }
  for(const entry of [{state:'error',requiresConfirmation:true},{state:'sending',requiresConfirmation:true},{state:'queued',requiresConfirmation:false}]){
    const h=harness();h.box.queueEntries=[{...entry,id:'saved',label:'Saved'}];h.box.renderQueue();
    check(entry.state+' / confirmation '+entry.requiresConfirmation+' does not offer connected resend',!h.queueBox.children.some(el=>el.id==='queue-connect'));
    await h.box.connectQueuedThread();check(entry.state+' / confirmation '+entry.requiresConfirmation+' cannot activate through a stale callback',h.requests.length===0);
  }
  for(const flag of ['ready','resuming','handingBack','sending']){
    const h=harness();h.state[flag]=flag==='ready'?false:true;h.box.renderQueue();
    check(flag+' guards the saved-send button',h.queueBox.children.find(el=>el.id==='queue-connect')?.disabled===true);
    await h.box.connectQueuedThread();check(flag+' guards direct saved-send invocation',h.requests.length===0&&h.rpc.length===0);
  }
  {
    const h=harness();let resolve;h.box.queueRequest=body=>{h.requests.push(body);return new Promise(r=>{resolve=r;});};
    const first=h.box.connectQueuedThread();await flush();await h.box.connectQueuedThread();
    check('concurrent connected activation calls issue only one HTTP action and no resume',h.requests.length===1&&h.rpc.length===0&&!!h.state.queueActivating);
    resolve({ok:true});check('confirmed activation clears busy state without claiming delivery',await first===true&&!h.state.queueActivating&&h.messages.some(s=>/执行结果/.test(s)));
  }
  {
    const h=harness();h.box.queueRequest=body=>{h.requests.push(body);return Promise.reject(Error('Activation outcome unknown'));};
    await h.box.connectQueuedThread();
    check('failed activation retains the entry and reports an unconfirmed outcome',!h.state.queueActivating&&h.box.queueEntries[0].requiresConfirmation===true&&/Activation outcome unknown/.test(h.state.queueActivationFeedback.held)&&/未能确认/.test(h.state.queueActivationFeedback.held));
  }
  {
    const h=harness();h.state.resumed=false;h.task.kind='unlinked';let resume;
    h.box.call=(method,params)=>{h.rpc.push({method,params});return method==='thread/resume'?new Promise(resolve=>{resume=resolve;}):Promise.resolve({});};
    const action=h.box.connectQueuedThread();h.state.thread={id:'other'};h.state.resuming=false;
    resume({thread:{id:'held',status:{type:'idle'}}});await action;
    check('switching conversations during connection never activates either queue',h.requests.length===0&&!h.state.queueActivating&&h.state.thread.id==='other');
    check('old activation feedback remains scoped to the source and current controls rerender',!!h.state.queueActivationFeedback.held&&!h.state.queueActivationFeedback.other&&h.messages.length===0&&h.renderCount()>1);
  }
  {
    const h=harness();h.state.resumed=false;h.task.kind='unlinked';await h.box.connectQueuedThread();
    check('the explicit unlinked connect-and-send path still resumes once then activates',h.rpc.filter(x=>x.method==='thread/resume').length===1&&h.requests.length===1&&h.requests[0].action==='activate'&&h.requests[0].threadId==='held');
  }
}

function testConflictChoices() {
  console.log('\n[6] Conflict offers safe phone work before desktop takeover');
  const calls = [], cards = [];
  function element(tag) {
    const el = {
      tag, children: [], className: '', id: '', innerHTML: '', textContent: '',
      appendChild(child) { this.children.push(child); return child; },
      querySelector(selector) {
        if (selector === '.btns') return this.buttons || (this.buttons = element('div'));
        return null;
      },
      remove() { this.removed = true; }
    };
    return el;
  }
  const body = {
    firstChild: null,
    insertBefore(card) { cards.push(card); this.firstChild = card; },
    appendChild(card) { cards.push(card); if (!this.firstChild) this.firstChild = card; }
  };
  const source = { id: 'desktop-owned', cwd: 'D:/fixture' };
  const box = loadFunctions({
    document: {
      createElement: element,
      getElementById(id) { return cards.find(x => x.id === id && !x.removed) || null; }
    },
    $: id => id === 'body' ? body : id === 'main' ? { scrollTop: 42 } : null,
    tr: text => text, toast() {}, scrollDown() {},
    forkCurrentThread(t) { calls.push({ action: 'fork', thread: t }); return Promise.resolve(); },
    newThread(cwd) { calls.push({ action: 'new', cwd }); },
    openThread(t) { calls.push({ action: 'open', thread: t }); },
    openLockPanel() { calls.push({ action: 'open-lock-panel' }); },
    releaseDesktopLock(t) { calls.push({ action: 'close-desktop', thread: t }); }
  }, ['showWriterConflict']);
  box.showWriterConflict(source, 'active writer');
  const card = cards[0];
  const buttons = card?.buttons?.children || [];
  const labels = buttons.map(x => x.textContent).join(' | ');
  check('conflict exposes a separate phone continuation or fork',
    buttons.some(x => /续聊|继续|独立|分支|fork/i.test(x.textContent)), labels);
  check('conflict exposes new conversation in the same project',
    buttons.some(x => /同项目|同一个项目|当前项目|same project/i.test(x.textContent)), labels);
  const closeAt = buttons.findIndex(x => /释放电脑|关闭电脑|接管|锁|控制|take over|lock|desktop|control/i.test(x.textContent));
  const firstSafeAt = buttons.findIndex(x => /续聊|继续|独立|分支|fork|同项目|同一个项目|当前项目|same project/i.test(x.textContent));
  check('lock-management action appears after the safe choices',
    closeAt >= 0 && firstSafeAt >= 0 && closeAt > firstSafeAt, labels);
  for (const button of buttons) {
    if (/续聊|继续|独立|分支|fork|同项目|同一个项目|当前项目|same project/i.test(button.textContent)) {
      button.onclick();
    }
  }
  check('safe choices do not invoke desktop-close',
    !calls.some(x => x.action === 'close-desktop'), JSON.stringify(calls));
  check('same-project new conversation receives the source project path',
    calls.some(x => x.action === 'new' && x.cwd === source.cwd), JSON.stringify(calls));
}

async function testFork() {
  console.log('\n[7] Fork keeps desktop work intact and opens an editable phone draft');
  function harness(failFork, delayedFork = false) {
    const source = { id: 'desktop-owned', name: 'Original', cwd: 'D:/fixture' };
    const attachment = { threadId: source.id, status: 'ready', label: 'file.txt' };
    const attachments = { [source.id]: [attachment] };
    const drafts = { [source.id]: 'review this' };
    const input = { value: 'review this' };
    const rpc = [], opened = [], notices = [], saved = [];
    let resolveFork;
    const state = { thread: source, view: 'thread', ready: true,
      resumed: false, forking: false };
    const box = loadFunctions({
      state, task: { kind: 'unlinked' }, textDrafts: drafts, attachmentDrafts: attachments, queueEntries: [],
      $: id => id === 'input' ? input : null,
      t: text => text,
      draftAttachments(tid) { return attachments[tid || state.thread.id] || []; },
      enqueueDraft(text) { saved.push(text); },
      renderFooter() {}, setConn() {}, scheduleRelease() {},
      toast(message) { notices.push(message); },
      call(method, params) {
        rpc.push({ method, params });
        if (method === 'thread/unsubscribe') return Promise.resolve({});
        if (method !== 'thread/fork') throw Error('Unexpected RPC: ' + method);
        if (failFork) return Promise.reject(Error('fork unavailable'));
        if (delayedFork) return new Promise(resolve => { resolveFork = resolve; });
        return Promise.resolve({ thread: { id: 'phone-child', cwd: source.cwd } });
      },
      openThread(t) {
        opened.push(t);
        state.thread = t;
        input.value = drafts[t.id] || '';
      },
      Promise, Error
    }, ['forkCurrentThread', 'send']);
    return { box, source, attachment, attachments, drafts, input, rpc, opened, notices, saved, state,
      completeFork() { resolveFork({ thread: { id: 'phone-child', cwd: source.cwd } }); } };
  }
  {
    const h = harness(false);
    const result = await h.box.forkCurrentThread(h.source);
    check('fork uses a metadata-only protocol call on the source',
      result === true && h.rpc.length === 1 && h.rpc[0].method === 'thread/fork' &&
      h.rpc[0].params.threadId === h.source.id && h.rpc[0].params.excludeTurns === true,
      JSON.stringify(h.rpc));
    check('fork never resumes the source or starts a turn',
      !h.rpc.some(x => ['thread/resume', 'turn/start', 'turn/steer'].includes(x.method)));
    check('new child opens in the same project with original draft text visible',
      h.opened.length === 1 && h.opened[0].id === 'phone-child' &&
      h.opened[0].cwd === h.source.cwd && h.input.value === 'review this',
      JSON.stringify(h.opened));
    check('ready attachments follow the draft into the new child',
      h.attachments['phone-child']?.[0] === h.attachment &&
      h.attachment.threadId === 'phone-child' && h.attachments[h.source.id].length === 0);
  }
  {
    const h = harness(false, true);
    const result = h.box.forkCurrentThread(h.source);
    h.state.thread = { id: 'other-thread', cwd: h.source.cwd };
    h.input.value = 'message in another conversation';
    h.box.send();
    check('pending fork does not block sending in a different conversation',
      h.saved.length === 1 && h.saved[0] === 'message in another conversation');
    const disabledExpr = extractFunction(PAGE, 'renderFooter').match(/\$\('send'\)\.disabled\s*=\s*(.+);/);
    check('pending fork disables only its source Send button',
      disabledExpr &&
      vm.runInNewContext(disabledExpr[1], { state: { sending: false, forking: h.source.id, thread: h.source }, draftAttachments: () => [] }) === true &&
      vm.runInNewContext(disabledExpr[1], { state: { sending: false, forking: h.source.id, thread: h.state.thread }, draftAttachments: () => [] }) === false);
    h.completeFork();
    await result;
    check('leaving during fork releases the unseen child writer, not the desktop source',
      h.rpc.filter(x => x.method === 'thread/unsubscribe').length === 1 &&
      h.rpc.find(x => x.method === 'thread/unsubscribe').params.threadId === 'phone-child' &&
      !h.rpc.some(x => x.method === 'thread/resume'));
  }
  {
    const h = harness(false, true);
    const result = h.box.forkCurrentThread(h.source);
    h.box.send();
    check('keyboard send cannot submit the original during an in-flight fork',
      h.rpc.length === 1 && h.rpc[0].method === 'thread/fork' &&
      h.notices.some(message => /正在创建独立会话/.test(message)));
    const laterAttachment = { threadId: h.source.id, status: 'ready', label: 'later.txt' };
    h.input.value = 'review this and the later change';
    h.attachments[h.source.id].push(laterAttachment);
    h.completeFork();
    await result;
    check('edits and uploads added during fork remain on the source',
      h.drafts[h.source.id] === 'review this and the later change' &&
      h.attachments[h.source.id].length === 1 &&
      h.attachments[h.source.id][0] === laterAttachment &&
      laterAttachment.threadId === h.source.id);
    check('child receives only the draft snapshot from when fork was tapped',
      h.input.value === 'review this' && h.attachments['phone-child'].length === 1 &&
      h.attachments['phone-child'][0] === h.attachment &&
      h.notices.some(message => /仍留在原会话/.test(message)));
  }
  {
    const h = harness(false, true);
    const result = h.box.forkCurrentThread(h.source);
    h.attachments[h.source.id].splice(0, 1);
    h.attachment.removed = true;
    h.completeFork();
    await result;
    check('attachment removed during fork is not restored in the child',
      h.attachments['phone-child'].length === 0 && h.attachment.threadId === h.source.id);
  }
  {
    const h = harness(true);
    const result = await h.box.forkCurrentThread(h.source);
    check('fork failure leaves source, text and attachments unchanged',
      result === false && h.state.thread === h.source &&
      h.input.value === 'review this' && h.attachments[h.source.id][0] === h.attachment &&
      h.attachment.threadId === h.source.id && h.opened.length === 0);
  }
}

(async () => {
  await testOwnership();
  await testDetachedHandback();
  await testQueue();
  testQueuePresentation();
  await testSavedQueueActivation();
  testConflictChoices();
  await testFork();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
