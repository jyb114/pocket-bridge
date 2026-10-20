'use strict';

// Actual HTML/CSS/UI and an isolated Chromium, with deliberately controlled
// adapter replies. No live DSH, gateway, tunnel, credentials or model traffic.
// The browser helper is isolated so this regression never sweeps other tasks'
// browser processes. UI actions below use hit-tested pointer/keyboard input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module);
isolated.filename = browserFile; isolated.paths = module.paths;
const browserSource = fs.readFileSync(browserFile, 'utf8');
assert.equal(browserSource.split('    sweepOrphanBrowsers();').length, 2, 'browser isolation must remove the one orphan-sweep call or fail before launching');
isolated._compile(browserSource.replace('    sweepOrphanBrowsers();',
  '    // This isolated control regression never sweeps another browser.'), browserFile);
const { Browser } = isolated.exports;

const controlledAdapter = `
window.__controls={calls:[],goal:null,goalWriteMode:'normal',goalSequence:0,holdList:false,listWaiters:[],holdPlan:false,
 selection:{agentPreset:'fixture-tools',modelSelection:{provider:'fixture-provider',model:'plain',reasoningEffort:''},plan:null,blank:false}};
window.DshLiteAdapter={
 capabilities:{interactiveReplies:true},
 async connect(fn){__controls.event=fn;fn({type:'status',state:'connected'});},
 async disconnect(){__controls.calls.push(['disconnect']);},
 async listProjects(){return[{id:'p1',name:'Control fixture',path:'D:/control-fixture'}];},
 async listSessions(){return[{id:'s1',title:'First control fixture'},{id:'s2',title:'Second control fixture'}];},
 async loadSession(id){return{records:[{id:'history-'+id,role:'assistant',text:'Isolated fixture history '+id}],hasMore:false};},
 async listQueued(){return[];},
 async sendMessage(value){__controls.calls.push(['send',value.sessionId,value.text]);},
 async readSelection(id){__controls.calls.push(['selectionRead',id]);return structuredClone(__controls.selection);},
 async listModels(id){__controls.calls.push(['models',id]);return[
  {id:'reasoning',provider:'fixture-provider',name:'Reasoning fixture',efforts:[{id:'low',name:'Low fixture'},{id:'high',name:'High fixture'}],defaultEffort:'low'},
  {id:'plain',provider:'fixture-provider',name:'Plain fixture'}];},
 async selectModel(id,model,effort,provider){__controls.calls.push(['selectModel',id,model,effort,provider]);__controls.selection.modelSelection={provider,model,reasoningEffort:effort};},
 async listModes(){return[{id:'fixture-tools',name:'Fixture tools'}];},
 async selectMode(){},
 async readGoal(id){__controls.calls.push(['goalRead',id]);return __controls.goal?structuredClone(__controls.goal):null;},
 async goalAction(id,kind,payload){__controls.calls.push(['goalWrite',id,kind,structuredClone(payload)]);
  if(__controls.goalWriteMode==='unchanged')return{accepted:true};
  __controls.goal={id:kind==='create'?'new-goal-'+(++__controls.goalSequence):payload.id,revision:kind==='create'?1:(payload.revision+1),objective:payload.objective,phase:'active'};
  return{accepted:true,goal:structuredClone(__controls.goal)};},
 async listCommands(id){__controls.calls.push(['listCommands',id]);if(__controls.holdList)return new Promise(resolve=>__controls.listWaiters.push(resolve));return[{name:'plan'},{name:'compact'}];},
 async runCommand(id,line){__controls.calls.push(['command',id,line]);
  if(__controls.holdPlan&&line.startsWith('/plan'))await new Promise(resolve=>{__controls.finishPlan=resolve;});
  if(line.startsWith('/plan'))__controls.selection.plan={active:line!=='/plan off',pending:false};
  return{result:{kind:'message',text:'Controlled command accepted'}};}
};
`;

async function run() {
  process.env.TEMP = 'D:/bridge-dsh-control-test-temp';
  process.env.TMP = process.env.TEMP; process.env.TMPDIR = process.env.TEMP;
  fs.mkdirSync(process.env.TEMP, { recursive: true });
  const assets = new Map([
    ['/dsh-lite.html', 'text/html'], ['/dsh-lite-ui.js', 'text/javascript'],
    ['/dsh-lite-lang.js', 'text/javascript'], ['/i18n.js', 'text/javascript'],
    ['/dsh-lite.css', 'text/css'], ['/pocket-bridge.svg', 'image/svg+xml']
  ]);
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (route === '/dsh-lite-adapter.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(controlledAdapter); return;
    }
    if (assets.has(route)) {
      res.writeHead(200, { 'content-type': assets.get(route) + '; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(root, 'pwa', route.slice(1)))); return;
    }
    // Optional runtime bundles have no effect in the controlled adapter fixture.
    if (route.endsWith('.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(''); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, checks = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    browser = await Browser.launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.goto('http://127.0.0.1:' + server.address().port + '/dsh-lite.html', 250);
    async function wait(expression) {
      const deadline = Date.now() + 7000;
      do { if (await page.eval(expression)) return; await sleep(25); } while (Date.now() < deadline);
      throw Error('Timed out waiting for controlled UI: ' + expression);
    }
    function find(selector, text) {
      return text === undefined ? 'document.querySelector(' + JSON.stringify(selector) + ')' :
        '[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.includes(' + JSON.stringify(text) + '))';
    }
    async function pointer(selector, text) {
      const expression = find(selector, text);
      const reveal = await page.eval(`(()=>{const node=${expression};if(!node)throw Error('Fixture control missing');const toggle=document.getElementById('composer-options-toggle');return{menu:!!node.closest('#settings-menu[hidden]'),options:!!node.closest('#composer-picks')&&toggle?.getAttribute('aria-expanded')!=='true',sidebar:!!node.closest('#sidebar')&&document.body.classList.contains('sidebar-hidden')};})()`);
      if (reveal.menu) await pointer('#rail-settings');
      if (reveal.options) await pointer('#composer-options-toggle');
      if (reveal.sidebar) await pointer('#projects-toggle');
      const point = await page.eval(`(()=>{const node=${expression};if(!node||node.disabled)throw Error('Fixture control disabled or missing');node.scrollIntoView({block:'center',inline:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||x<0||x>innerWidth||y<0||y>innerHeight||!node.contains(document.elementFromPoint(x,y)))throw Error('Fixture control not reachable: '+${JSON.stringify(selector)});return{x,y};})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    async function type(selector, value) {
      await pointer(selector);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await page.send('Input.insertText', { text: value });
    }
    const close = () => pointer('.screen-overlay .screen-bar .screen-action');
    async function select(title) {
      await pointer('#session-list button', title);
      await wait(`document.getElementById('session-title').textContent===${JSON.stringify(title)}&&!document.getElementById('message-input').disabled`);
    }
    await wait(`window.DshLiteUI&&document.querySelectorAll('#session-list button').length===2`);
    await page.eval(`window.DshI18n.setLang('zh');window.__controls.controller=window.DshLiteUI.mount(window.DshLiteAdapter)`);
    await wait(`document.querySelectorAll('#session-list button').length===2`);
    await select('First control fixture');
    const messageDraft = 'Message draft stays separate from controls.';
    await type('#message-input', messageDraft);

    // Reasoning effort is a child view in the same small card, and Back does
    // not select a model or remove the independent conversation draft.
    await pointer('[data-kind="model"]');
    await wait(`document.querySelectorAll('.control-card .pick-row').length===2`);
    await page.eval(`__controls.firstCard=document.querySelector('.control-card')`);
    check(await page.eval(`document.querySelectorAll('.screen-overlay').length`), 1, 'model opens exactly one small card');
    check(await page.eval(`document.querySelector('.control-card').getBoundingClientRect().height<innerHeight*.8`), true, 'model card leaves conversation space visible');
    await pointer('.control-card .pick-row', 'Reasoning fixture');
    await wait(`!!document.querySelector('.picker-back')`);
    check(await page.eval(`document.querySelector('.picker-back').getBoundingClientRect().height>=44`), true, 'Back retains a phone-sized touch target');
    check(await page.eval(`__controls.firstCard===document.querySelector('.control-card')`), true, 'reasoning efforts stay in the same card');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='selectModel').length`), 0, 'opening efforts has no mutation');
    await pointer('.picker-back');
    await wait(`!document.querySelector('.picker-back')&&document.querySelectorAll('.control-card .pick-row').length===2`);
    check(await page.eval(`__controls.firstCard===document.querySelector('.control-card')`), true, 'Back returns within the same card');
    await pointer('.control-card .pick-row', 'Reasoning fixture');
    await pointer('.control-card .pick-row', 'High fixture');
    await wait(`!document.querySelector('.screen-overlay')`);
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='selectModel')`), [['selectModel', 's1', 'reasoning', 'high', 'fixture-provider']], 'one explicit effort selects its captured model/provider/conversation');
    check(await page.eval(`document.getElementById('message-input').value`), messageDraft, 'model selection preserves message draft');

    // Goal, plan, and compression are separate tabs. Simply opening Goal or
    // switching to Compression must not eagerly list or run commands.
    const beforeLists = await page.eval(`__controls.calls.filter(row=>row[0]==='listCommands').length`);
    await page.eval(`__controls.holdList=true`);
    await pointer('[data-kind="goal"]');
    check(await page.eval(`Array.from(document.querySelectorAll('.control-tabs button')).every(button=>button.getBoundingClientRect().height>=44)`), true, 'conversation tabs retain phone-sized touch targets');
    check(await page.eval(`parseFloat(getComputedStyle(document.querySelector('.goal-form textarea')).fontSize)>=16`), true, 'goal input retains a readable mobile input size');
    const goalDraft = 'Independent goal draft, not a message.';
    await type('[data-control-pane="goal"] .goal-input', goalDraft);
    await pointer('[data-control-tab="compact"]');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='listCommands').length`), beforeLists, 'goal and compression views do not eagerly load plan commands');
    await pointer('[data-control-tab="goal"]');
    check(await page.eval(`document.querySelector('.goal-form textarea').value`), goalDraft, 'tab switch preserves independent goal text');
    await pointer('[data-control-tab="plan"]');
    await wait(`__controls.listWaiters.length===1`);
    await pointer('[data-control-tab="goal"]');
    await pointer('[data-control-tab="plan"]');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='listCommands').length`), beforeLists + 1, 'plan list loads once per panel despite tab switches');
    await close();
    await page.eval(`__controls.holdList=false;__controls.listWaiters.splice(0).forEach(resolve=>resolve([{name:'plan'}]))`);
    await sleep(40);
    check(await page.eval(`document.querySelectorAll('.screen-overlay').length`), 0, 'late plan listing cannot restore a closed card');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='command').length`), 0, 'reading plan choices never runs a command');
    check(await page.eval(`document.getElementById('message-input').value`), messageDraft, 'goal and plan views preserve the message draft');

    // A completed old goal with identical text is not a successful new goal.
    // Explicit read-only recovery keeps the submitted text before a retry.
    await page.eval(`__controls.goal={id:'old-completed',revision:3,phase:'complete',objective:'Repeat completed objective'};__controls.goalWriteMode='unchanged'`);
    await select('Second control fixture'); await select('First control fixture');
    await pointer('[data-kind="goal"]');
    check(await page.eval(`document.querySelector('.goal-form textarea').value`), '', 'completed goal starts with an empty new-goal editor');
    await type('.goal-form textarea', 'Repeat completed objective');
    await pointer('.goal-form button', '设定目标');
    await wait(`document.querySelector('.goal-form .files-status').textContent.includes('未确认')`);
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='goalWrite').map(row=>row[2])`), ['create'], 'completed goal submits Create, never Edit');
    check(await page.eval(`document.querySelector('.goal-form .files-status').textContent.includes('目标已保存')`), false, 'unchanged completed readback cannot falsely confirm Save');
    check(await page.eval(`document.querySelector('.goal-form button').disabled`), true, 'unconfirmed write cannot silently be repeated');
    await pointer('.goal-form button', '重新读取目标');
    await wait(`document.querySelector('.goal-form button').disabled===false`);
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='goalWrite').length`), 1, 'goal recovery is read-only');
    check(await page.eval(`document.querySelector('.goal-form textarea').value`), 'Repeat completed objective', 'uncertain goal recovery preserves the independent goal draft');
    await page.eval(`__controls.goalWriteMode='normal'`);
    await pointer('.goal-form button', '设定目标');
    await wait(`document.querySelector('.goal-form .files-status').textContent.includes('目标已保存')`);
    check(await page.eval(`__controls.goal.id==='old-completed'||__controls.goal.phase==='complete'`), false, 'confirmed Create reads back a distinct unfinished goal');
    check(await page.eval(`document.getElementById('message-input').value`), messageDraft, 'goal submit preserves message draft');
    await close();

    // Unknown plan status offers explicit opposite actions. While one action
    // is admitted, both are disabled and a second click cannot race it.
    await page.eval(`__controls.selection.plan=null;__controls.holdPlan=true`);
    await pointer('[data-kind="goal"]'); await pointer('[data-control-tab="plan"]');
    await wait(`document.querySelectorAll('.plan-controls > button').length===2`);
    await pointer('.plan-controls button', '进入计划模式');
    await wait(`typeof __controls.finishPlan==='function'`);
    check(await page.eval(`[...document.querySelectorAll('.plan-controls > button')].every(node=>node.disabled)`), true, 'one pending plan mutation disables both opposite controls');
    await page.eval(`[...document.querySelectorAll('.plan-controls > button')].find(node=>node.textContent.includes('退出')).click()`);
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='command')`), [['command', 's1', '/plan']], 'disabled opposite action admits no concurrent command');
    await pointer('[data-control-tab="goal"]'); await pointer('[data-control-tab="plan"]');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='command').length`), 1, 'tab switching cannot repeat a pending command');
    // The operation belongs to the conversation, not to the first card. A
    // closed/reopened plan view must subscribe to it instead of admitting a
    // second command or abandoning the lock when the old DOM is gone.
    const pendingLists = await page.eval(`__controls.calls.filter(row=>row[0]==='listCommands').length`);
    await page.eval(`__controls.closedPendingPanel=document.querySelector('.screen-overlay');__controls.closedPendingText=__controls.closedPendingPanel.textContent`);
    await close();
    check(await page.eval(`__controls.closedPendingPanel.isConnected`), false, 'closing a pending plan card removes its DOM');
    await pointer('[data-kind="goal"]'); await pointer('[data-control-tab="plan"]');
    await wait(`document.querySelector('.plan-controls').textContent.includes('正在切换')`);
    check(await page.eval(`[...document.querySelectorAll('.plan-controls button')].filter(node=>!node.disabled).length`), 0, 'reopened pending plan has no writable action');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='command').length`), 1, 'reopening cannot duplicate the conversation operation');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='listCommands').length`), pendingLists, 'reopened pending view waits for settlement before reading choices');
    await page.eval(`__controls.holdPlan=false;__controls.finishPlan()`);
    await wait(`document.querySelector('.plan-controls').textContent.includes('计划模式已启用')`);
    check(await page.eval(`[...document.querySelectorAll('.plan-controls button')].filter(node=>!node.disabled).length`), 1, 'confirmed plan readback exposes its one next action');
    check(await page.eval(`__controls.closedPendingPanel.isConnected||__controls.closedPendingPanel.textContent!==__controls.closedPendingText`), false, 'settlement neither revives nor updates the closed card');
    check(await page.eval(`document.querySelectorAll('.screen-overlay').length`), 1, 'only the reopened plan card remains after settlement');
    await pointer('.plan-controls button', '退出计划模式');
    await wait(`document.querySelector('.plan-controls').textContent.includes('计划模式未启用')`);
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='command')`), [['command', 's1', '/plan'], ['command', 's1', '/plan off']], 'settled operation releases its conversation lock for one explicit next action');
    await close();

    // Disposing an open card releases inert and closes its resources before a
    // delayed plan-list response arrives. Only this fixture is manipulated.
    await page.eval(`__controls.holdList=true`);
    await pointer('[data-kind="goal"]'); await pointer('[data-control-tab="plan"]');
    await wait(`__controls.listWaiters.length===1`);
    check(await page.eval(`document.getElementById('app').inert`), true, 'an open card isolates the background');
    await page.eval(`__controls.controller.dispose()`);
    check(await page.eval(`document.getElementById('app').inert`), false, 'dispose restores the background interaction state');
    check(await page.eval(`document.querySelectorAll('.screen-overlay').length`), 0, 'dispose removes all open card DOM');
    await page.eval(`__controls.listWaiters.splice(0).forEach(resolve=>resolve([{name:'plan'}]));window.dispatchEvent(new Event('resize'));if(window.visualViewport)window.visualViewport.dispatchEvent(new Event('resize'))`);
    await sleep(40);
    check(await page.eval(`document.querySelectorAll('.screen-overlay').length`), 0, 'late async results and viewport events cannot revive disposed cards');
    check(await page.eval(`__controls.calls.filter(row=>row[0]==='send').length`), 0, 'control operations never submit the conversation draft');
    check(page.exceptions, [], 'the actual browser reports no uncaught exception');
    console.log('Compact controls: ' + checks + ' actual-browser checks passed (controlled adapter only; zero live DSH messages).');
  } finally {
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} try { browser.ws.close(); } catch (_) {} }
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
