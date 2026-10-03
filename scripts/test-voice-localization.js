// Exercise the real shared voice module and the DSH voice UI with a fake DOM.
// English and Spanish must not expose Chinese-only help, tooltips, or errors.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction, sliceBalanced } = require('./page-source.js');

const BASE = path.resolve(__dirname, '..');
const voiceSource = fs.readFileSync(path.join(BASE, 'pwa', 'voice.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(BASE, 'pwa', 'boot.js'), 'utf8');
let failures = 0;

function check(label, passed, actual) {
  if (passed) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ ${label}: ${String(actual || '').slice(0, 180)}`);
}

function matchesLanguage(lang, value) {
  const text = String(value || '');
  if (!text || /\bundefined\b/.test(text)) return false;
  return lang === 'zh' ? /[\u3400-\u9fff]/.test(text) : !/[\u3400-\u9fff]/.test(text);
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), style: {}, listeners: {},
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        remove() { if (this.id) nodes.delete(this.id); }
      };
    },
    getElementById(id) { return nodes.get(id) || null; },
    body: {
      appendChild(node) { if (node.id) nodes.set(node.id, node); return node; }
    },
    head: { appendChild(node) { if (node.id) nodes.set(node.id, node); return node; } }
  };
  const dock = doc.createElement('div');
  dock.id = 'dsh-gw-dock';
  dock.appendChild = doc.body.appendChild;
  dock.insertBefore = doc.body.appendChild;
  nodes.set(dock.id, dock);
  for (const id of ['dsh-voice-help-x', 'dsh-voice-hint-x', 'dsh-voice-hint-more']) {
    const button = doc.createElement('button'); button.id = id; nodes.set(id, button);
  }
  return doc;
}

function sandbox(lang, supported, ua) {
  const doc = fakeDocument();
  const instances = [];
  function Recognition() { instances.push(this); this.start = () => {}; }
  const win = {
    document: doc,
    navigator: { userAgent: ua || 'Mozilla/5.0 (iPhone)', languages: [`${lang}-XX`], language: lang },
    DshI18n: { lang: () => lang },
    localStorage: { getItem: () => null, setItem() {} },
    SpeechRecognition: supported ? Recognition : undefined
  };
  const alerts = [];
  const box = { window: win, document: doc, navigator: win.navigator,
    localStorage: win.localStorage, setTimeout: (fn) => { fn(); return 1; },
    findInput: () => null, alert: (message) => alerts.push(message), console };
  win.window = win;
  vm.createContext(box);
  return { box, win, doc, instances, alerts };
}

function bootFunctions(env) {
  const marker = 'var NOTE_TEXT = ';
  const start = bootSource.indexOf(marker);
  if (start < 0) throw new Error('NOTE_TEXT is missing');
  const brace = bootSource.indexOf('{', start + marker.length);
  const end = sliceBalanced(bootSource, brace, '{', '}');
  if (end < 0) throw new Error('NOTE_TEXT is incomplete');
  vm.runInContext(`var NOTE_TEXT = ${bootSource.slice(brace, end + 1)};`, env.box);
  vm.runInContext("var NOTE_LANGS = ['zh', 'en', 'es'];", env.box);
  for (const name of ['noteLang', 'T', 'mountVoiceHelpButton', 'showVoiceButton']) {
    const source = extractFunction(bootSource, name);
    if (!source) throw new Error(`${name} is missing`);
    vm.runInContext(source, env.box);
  }
}

for (const lang of ['en', 'es', 'zh']) {
  console.log(`\n${lang} — shared voice module`);
  const unavailable = sandbox(lang, false);
  vm.runInContext(voiceSource, unavailable.box);
  const reason = unavailable.win.DshVoice.whyNot();
  unavailable.win.DshVoice.explain();
  const help = unavailable.doc.getElementById('dsh-voice-help').innerHTML;
  check(`${lang}: unsupported-browser explanation uses the chosen language`,
    matchesLanguage(lang, reason + help),
    `${reason} ${help}`);

  const available = sandbox(lang, true);
  vm.runInContext(voiceSource, available.box);
  available.win.DshVoice.explain();
  const availableHelp = available.doc.getElementById('dsh-voice-help').innerHTML;
  check(`${lang}: microphone help uses the chosen language`,
    matchesLanguage(lang, availableHelp), availableHelp);
  const errors = [];
  available.win.DshVoice.start({ onError: (message) => errors.push(message) });
  const recognition = available.instances[0];
  for (const error of ['not-allowed', 'no-speech', 'network']) recognition.onerror({ error });
  check(`${lang}: recognition errors use the chosen language`,
    matchesLanguage(lang, errors.join(' ')),
    errors.join(' | '));

  console.log(`${lang} — DSH voice controls`);
  bootFunctions(unavailable);
  vm.runInContext('showVoiceButton()', unavailable.box);
  const hint = unavailable.doc.getElementById('dsh-voice-hint');
  const hintButton = unavailable.doc.getElementById('dsh-gw-voice-help');
  const unavailableText = [hint && hint.innerHTML, hintButton && hintButton.title,
    hintButton && hintButton['aria-label']].join(' ');
  check(`${lang}: unsupported voice hint and control use the chosen language`,
    matchesLanguage(lang, unavailableText),
    unavailableText);
  bootFunctions(available);
  vm.runInContext('showVoiceButton()', available.box);
  const mic = available.doc.getElementById('dsh-gw-voice');
  mic.listeners.click();
  const availableText = [mic.title, ...available.alerts].join(' ');
  check(`${lang}: microphone tooltip and focus error use the chosen language`,
    matchesLanguage(lang, availableText),
    availableText);
}

const android = sandbox('es', false, 'Mozilla/5.0 (Linux; Android 15)');
vm.runInContext(voiceSource, android.box);
android.win.DshVoice.explain();
const androidCopy = android.win.DshVoice.whyNot() + ' ' + android.doc.getElementById('dsh-voice-help').innerHTML;
check('Spanish Android: unsupported explanation is localized and does not mention iPhone',
  matchesLanguage('es', androidCopy) && !/iPhone/.test(androidCopy), androidCopy);

android.win.DshI18n.lang = () => 'en';
const changedCopy = android.win.DshVoice.whyNot();
check('Changing the interface language updates the existing voice module without reload',
  /This browser/.test(changedCopy) && matchesLanguage('en', changedCopy), changedCopy);

// A stuck mobile recognizer must really stop; late callbacks must not refill
// an input after its owner has moved on to a new recording.
function controlledVoice() {
  const env = sandbox('en', true), calls = [], timers = [], partials = [], finals = [];
  env.win.SpeechRecognition = function () {
    env.instances.push(this);
    this.start = () => calls.push('start');
    this.stop = () => calls.push('stop');
    this.abort = () => calls.push('abort');
  };
  env.box.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  vm.runInContext(voiceSource, env.box);
  const controller = env.win.DshVoice.start({ onPartial: text => partials.push(text), onFinal: text => finals.push(text) });
  const recognition = env.instances[0];
  return { controller, recognition, calls, timers, partials, finals };
}
function result(text, final) { return { resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] }; }
const normalStop = controlledVoice();
normalStop.recognition.onresult(result('Kept final text.', true));
normalStop.controller.stop();
normalStop.recognition.onend();
normalStop.timers.forEach(timer => timer.fn());
check('Normal voice completion keeps its final words and cancels the hard abort path',
  normalStop.calls.join(',') === 'start,stop' && normalStop.finals.join('') === 'Kept final text.', normalStop.calls);
const stuckStop = controlledVoice();
stuckStop.recognition.onresult(result('Already displayed text.', false));
stuckStop.controller.stop();
check('Stuck voice first requests final results and schedules only a 200ms abort fallback',
  stuckStop.calls.join(',') === 'start,stop' && stuckStop.timers.length === 1 && stuckStop.timers[0].delay === 200, stuckStop.calls);
stuckStop.timers[0].fn(); stuckStop.controller.abort();
stuckStop.recognition.onresult(result('Late stale text.', true)); stuckStop.recognition.onend();
check('The abort fallback runs once and ignores late text while preserving text already shown',
  stuckStop.calls.join(',') === 'start,stop,abort' && stuckStop.partials.join('') === 'Already displayed text.' && !stuckStop.finals.length,
  stuckStop.calls);

console.log(`\nVoice localization: ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
