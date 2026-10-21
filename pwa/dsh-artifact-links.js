(function (global) {
  'use strict';

  // This parser returns metadata only. It neither reads a file nor grants access
  // to one; the authenticated workspace-file route must admit every later read.
  var MAX_INPUT = 262144;
  var MAX_LINKS = 20;
  var MAX_CANDIDATES = 100;
  var MAX_LABEL = 200;
  var MAX_PATH = 2048;
  var RASTER = /^(png|jpe?g|webp|gif)$/i;
  var CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  var PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

  function bound(value, fallback, maximum) {
    return typeof value === 'number' && isFinite(value) && value >= 0
      ? Math.min(maximum, Math.floor(value)) : fallback;
  }

  function validUnicode(value) {
    for (var i = 0; i < value.length; i++) {
      var unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        var next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }

  function localPath(raw) {
    if (!raw || raw.length > MAX_PATH || CONTROL.test(raw) || !validUnicode(raw) ||
        /[%<>|"?*#]/.test(raw)) return null;
    var value = raw.replace(/\\/g, '/');
    var absolute = /^[a-z]:\//i.test(value);
    // A single leading ./ is conventional Markdown, not a directory traversal.
    if (!absolute && value.slice(0, 2) === './') value = value.slice(2);
    var rest = absolute ? value.slice(3) : value;
    if (!rest || value.charAt(0) === '/' || /:/.test(rest) || /\/\//.test(value)) return null;
    var parts = rest.split('/');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      // Win32 aliases (trailing spaces/dots, devices and alternate streams) are
      // ambiguous even when this helper is run on a non-Windows test machine.
      if (!part || part === '.' || part === '..' || /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
    }
    var leaf = parts[parts.length - 1];
    var match = /\.([^.]+)$/.exec(leaf);
    var extension = match ? match[1].toLowerCase() : '';
    return { path: value, kind: RASTER.test(extension) ? 'image' : 'file', extension: extension };
  }

  function escaped(text, index) {
    var slashes = 0;
    while (index > 0 && text.charAt(--index) === '\\') slashes++;
    return slashes % 2 === 1;
  }

  function readLink(text, start, limit) {
    var i = start + 1;
    var label = '';
    while (i < limit && i - start <= MAX_LABEL + 1) {
      var ch = text.charAt(i);
      if (ch === ']') break;
      if (ch === '[' || ch === '`' || CONTROL.test(ch)) return null;
      if (ch === '\\' && i + 1 < limit && PUNCTUATION.test(text.charAt(i + 1))) {
        label += text.charAt(i + 1); i += 2;
      } else { label += ch; i++; }
    }
    if (text.charAt(i) !== ']' || text.charAt(i + 1) !== '(' || label.length > MAX_LABEL) return null;
    i += 2;
    var targetStart = i;
    var raw;
    if (text.charAt(i) === '<') {
      targetStart = ++i;
      while (i < limit && i - targetStart <= MAX_PATH && text.charAt(i) !== '>') {
        if (CONTROL.test(text.charAt(i)) || text.charAt(i) === '<') return null;
        i++;
      }
      if (text.charAt(i) !== '>') return null;
      raw = text.slice(targetStart, i++);
      // Optional Markdown title strings are deliberately outside this contract.
      while (text.charAt(i) === ' ' || text.charAt(i) === '\t') i++;
      if (i >= limit || text.charAt(i) !== ')') return null;
    } else {
      var depth = 0;
      while (i < limit && i - targetStart <= MAX_PATH) {
        var next = text.charAt(i);
        if (/\s/.test(next) || next === '<' || next === '>') return null;
        if (next === '(') { if (++depth > 8) return null; }
        if (next === ')') { if (!depth) break; depth--; }
        i++;
      }
      if (i >= limit || text.charAt(i) !== ')' || depth) return null;
      raw = text.slice(targetStart, i);
      // A backslash before parentheses could mean a Markdown escape or a
      // Windows separator. Do not silently choose the wrong file. Angle
      // destinations remain literal and support both unambiguously.
      if (/\\[()]/.test(raw)) return null;
    }
    if (!validUnicode(label)) return null;
    return { end: i + 1, label: label, rawTarget: raw };
  }

  function fenceAt(text, start, end) {
    var i = start;
    while (i < end && i - start < 3 && text.charAt(i) === ' ') i++;
    var ch = text.charAt(i);
    if (ch !== '`' && ch !== '~') return null;
    var runStart = i;
    while (i < end && text.charAt(i) === ch) i++;
    if (i - runStart < 3) return null;
    return { char: ch, size: i - runStart, tail: text.slice(i, end) };
  }

  function tickRuns(text, limit) {
    var groups = Object.create(null);
    var i = 0;
    while (i < limit) {
      if (text.charAt(i) !== '`') { i++; continue; }
      var start = i;
      while (i < limit && text.charAt(i) === '`') i++;
      var size = i - start;
      if (!groups[size]) groups[size] = { positions: [], next: 0 };
      groups[size].positions.push(start);
    }
    return groups;
  }

  function indentedCode(text, start, end) {
    var columns = 0;
    for (var i = start; i < end; i++) {
      var ch = text.charAt(i);
      if (ch === ' ') columns++;
      else if (ch === '\t') columns += 4 - columns % 4;
      else break;
      if (columns >= 4) return true;
    }
    return false;
  }

  function scan(text, options) {
    if (typeof text !== 'string') return [];
    options = options || {};
    var limit = Math.min(text.length, bound(options.maxInputLength, MAX_INPUT, MAX_INPUT));
    // Never expose a target or offset truncated in the middle of a UTF-16 pair.
    if (limit < text.length && limit > 0 && /[\ud800-\udbff]/.test(text.charAt(limit - 1))) limit--;
    text = text.slice(0, limit);
    var maxLinks = bound(options.maxLinks, MAX_LINKS, MAX_LINKS);
    var maxCandidates = bound(options.maxCandidates, MAX_CANDIDATES, MAX_CANDIDATES);
    if (!maxLinks || !maxCandidates || text.indexOf('](') < 0) return [];
    var links = [];
    var candidates = 0;
    var i = 0;
    var lineStart = true;
    var fence = null;
    var nextAngleEnd = -1;
    // Index runs once: unmatched literal backticks must not hide later links,
    // and repeatedly searching an unmatched delimiter must not become quadratic.
    var runs = tickRuns(text, limit);
    while (i < limit && links.length < maxLinks && candidates < maxCandidates) {
      if (lineStart) {
        var lineEnd = text.indexOf('\n', i);
        if (lineEnd < 0 || lineEnd > limit) lineEnd = limit;
        var marker = fenceAt(text, i, lineEnd);
        if (fence) {
          if (marker && marker.char === fence.char && marker.size >= fence.size && /^\s*$/.test(marker.tail)) fence = null;
          i = lineEnd < limit ? lineEnd + 1 : lineEnd;
          continue;
        }
        if (marker && (marker.char !== '`' || marker.tail.indexOf('`') < 0)) {
          fence = marker;
          i = lineEnd < limit ? lineEnd + 1 : lineEnd;
          continue;
        }
        if (indentedCode(text, i, lineEnd)) {
          i = lineEnd < limit ? lineEnd + 1 : lineEnd;
          continue;
        }
        lineStart = false;
      }
      var ch = text.charAt(i);
      if (ch === '\n') { lineStart = true; i++; continue; }
      if (ch === '`') {
        var run = 1;
        while (i + run < limit && text.charAt(i + run) === '`') run++;
        var group = runs[run] || { positions: [], next: 0 };
        while (group.next < group.positions.length && group.positions[group.next] <= i) group.next++;
        if (group.next < group.positions.length) {
          i = group.positions[group.next++] + run;
          lineStart = false;
          continue;
        }
        i += run; continue;
      }
      if (ch === '\\' && i + 1 < limit && PUNCTUATION.test(text.charAt(i + 1))) { i += 2; continue; }
      if (ch === '<') {
        // Reuse the next closing marker, including the no-marker sentinel, so
        // many malformed '<' characters cannot cause quadratic rescanning.
        if (nextAngleEnd <= i) {
          nextAngleEnd = text.indexOf('>', i + 1);
          if (nextAngleEnd < 0) nextAngleEnd = limit;
        }
        var angleEnd = nextAngleEnd;
        // Standalone angle spans include autolinks and HTML source. Never
        // extract a local link from their interior. Link destinations wrapped
        // in <...> were already consumed atomically by readLink instead.
        if (angleEnd >= 0 && angleEnd < limit && angleEnd - i <= MAX_PATH + MAX_LABEL &&
            !/[\r\n]/.test(text.slice(i + 1, angleEnd))) { i = angleEnd + 1; continue; }
      }
      if (ch === '[') {
        candidates++;
        var link = readLink(text, i, limit);
        if (link) {
          var local = localPath(link.rawTarget);
          if (local) {
            var imageSyntax = i > 0 && text.charAt(i - 1) === '!' && !escaped(text, i - 1);
            links.push({ start: imageSyntax ? i - 1 : i, end: link.end, label: link.label,
              rawTarget: link.rawTarget, path: local.path, kind: local.kind,
              extension: local.extension, imageSyntax: imageSyntax });
          }
          i = link.end; continue;
        }
      }
      i++;
    }
    return links;
  }

  var api = { scan: scan };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DshArtifactLinks = api;
})(typeof window === 'object' ? window : this);
