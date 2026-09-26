// 从页面源码里把一整段代码**按括号配对**抠出来。
//
// 为什么不能用正则：字典里有嵌套的大括号、函数体里也有 —— 非贪婪正则会从
// 第一个 `}` 就收手，切出一段语法错误的片段，然后调用方报一个**自己造出来的**
// 假错误。这种假错误比没有检查更糟：它会让人去改本来没坏的代码。
//
// 两个用途（都是测试在用，不进运行时）：
//   extractRegisterArg  DshI18n.register({…}) 里的字典 —— test-i18n / test-release-lock
//   extractFunction     `function name(){…}` 整个函数 —— 在假 DOM 里真跑一遍
//                       （只看源码里有没有某句话是不够的：它可能挂在永远不会
//                        执行的分支里；这种错只有真跑才看得见）
'use strict';

/**
 * 通用：从 src 的 open 位置起，按配对找到与之匹配的那个收尾字符。
 *
 * ★ 三类「不是代码」的东西都要跳过，少一类就会切坏：
 *   · 字符串（'…' "…" `…`，带转义）
 *   · 注释（// 和 /* … *\/）
 *   · **正则字面量** —— 2026-09-26 实测踩到：codex.html 里
 *     `/:codex-file-citation\{([^}]*)\}/` 的花括号被当成代码里的括号，
 *     函数从中间被截断，调用方拿到一段语法错误的片段并报出一个**假错误**。
 */
function sliceBalanced(src, openIdx, open, close) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  let prevSig = '';                    // 上一个有意义的字符（判断 / 是除号还是正则）
  const REGEX_OK_BEFORE = '(,=:[!&|?{};+-*%~^<>';
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; prevSig = 'x'; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && (prevSig === '' || REGEX_OK_BEFORE.indexOf(prevSig) >= 0)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        else if (d === '\n') break;              // 正则不跨行 —— 认错就退回
        j++;
      }
      if (closed) { i = j; prevSig = ')'; continue; }
    }
    if (!/\s/.test(c)) prevSig = c;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `DshI18n.register({…})` → 那段对象字面量的源码（含外层大括号） */
function extractRegisterArg(src) {
  const at = src.search(/DshI18n\s*\.?\s*register\s*\(/);
  if (at < 0) return null;
  const open = src.indexOf('(', at);
  const close = sliceBalanced(src, open, '(', ')');
  return close < 0 ? null : src.slice(open + 1, close);
}

/** `function name(…){…}` → 整段函数源码（含结尾大括号） */
function extractFunction(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  const close = sliceBalanced(src, open, '{', '}');
  return close < 0 ? null : src.slice(at, close + 1);
}

module.exports = { extractRegisterArg, extractFunction, sliceBalanced };
