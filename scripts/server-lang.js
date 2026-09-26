// 服务端文案的语言工具 —— 给那些「服务端拼好再发给手机」的字符串用。
//
// 为什么需要：页面的 `t()` 只管页面自己写死的文案。而有些话是**服务端拼**的
// （接口名、识别结果、建议、目标状态、操作结果提示），它们按各自的请求上下文
// 拼好之后直接发给手机 —— 英文手机上就会出现整段中文。
// 计划 H 的验收「各语言不混排」针对的就是这一类。
//
// 为什么不做成「模板 + 变量拼接」：这些句子里夹着网卡名、IP、端口、前缀，
// 而不同语言的语序不一样（"端口 8080 上" vs "on port 8080"）。
// 拼接出来的必然是某一种语言的语序。所以只能**整句成表、变量后填**。
'use strict';

const LANGS = ['zh', 'en', 'es'];

/** 不认识的语种一律退回中文 —— 和前端 i18n 的兜底保持一致 */
function norm(lang) {
  return LANGS.indexOf(lang) >= 0 ? lang : 'zh';
}

/** 从一张 {zh:{...},en:{...},es:{...}} 表里取某个语言的文案 */
function pick(table, lang) {
  return table[norm(lang)];
}

/** 把 {name} 换成实参。表里用 {port} 这种占位符，这里填。 */
function fill(tpl, args) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (args && k in args ? String(args[k]) : m));
}

module.exports = { LANGS, norm, pick, fill };
