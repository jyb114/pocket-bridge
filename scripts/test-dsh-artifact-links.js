'use strict';

// Pure parser fixtures. No browser profile, filesystem content, network, runtime
// or credentials are read; the UI and authenticated file route are tested apart.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scan } = require('../pwa/dsh-artifact-links.js');
let checks = 0;
function check(name, run) { run(); checks++; console.log('PASS ' + name); }
function one(source) { const links = scan(source); assert.equal(links.length, 1); return links[0]; }

check('the exact screenshot angle-bracket Windows link keeps UTF-16 offsets', () => {
  const source = '这是最终结果：\n[最终主图](<D:/my_games/AshenCovenant3D_Rebuild/Reports/EnvironmentCollab/FINAL/court_hero8_final.png>)\n请查看。';
  const link = one(source);
  assert.deepEqual(link, { start: source.indexOf('['), end: source.indexOf(')') + 1,
    label: '最终主图', rawTarget: 'D:/my_games/AshenCovenant3D_Rebuild/Reports/EnvironmentCollab/FINAL/court_hero8_final.png',
    path: 'D:/my_games/AshenCovenant3D_Rebuild/Reports/EnvironmentCollab/FINAL/court_hero8_final.png',
    kind: 'image', extension: 'png', imageSyntax: false });
  assert.equal(source.slice(link.start, link.end), '[最终主图](<' + link.rawTarget + '>)');
});

check('angle destinations keep spaces, Unicode, parentheses and exact casing', () => {
  const link = one('😀 [总图](<D:/Project files/渲染 (最终)/Hero 😀.PNG>)');
  assert.equal(link.start, 3);
  assert.equal(link.path, 'D:/Project files/渲染 (最终)/Hero 😀.PNG');
  assert.equal(link.extension, 'png');
  assert.equal(link.kind, 'image');
});

check('Windows backslashes normalize without decoding or changing case', () => {
  const link = one(String.raw`[photo](D:\Work\render\Hero.JPG)`);
  assert.equal(link.path, 'D:/Work/render/Hero.JPG');
  assert.equal(link.rawTarget, String.raw`D:\Work\render\Hero.JPG`);
  assert.equal(link.kind, 'image');
});

check('relative paths remove only one conventional leading dot segment', () => {
  assert.equal(one('[image](./images/scene.webp)').path, 'images/scene.webp');
  assert.equal(one(String.raw`[image](.\images\scene.webp)`).path, 'images/scene.webp');
  assert.equal(one('[file](README.md)').kind, 'file');
  assert.equal(one('[file](assets/README)').extension, '');
});

check('raster allowlist is exact and SVG remains an ordinary file', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    assert.equal(one('[image](images/a.' + extension.toUpperCase() + ')').kind, 'image');
  }
  for (const extension of ['svg', 'svgz', 'html', 'pdf', 'png.exe', 'avif', 'bmp']) {
    assert.equal(one('[file](images/a.' + extension + ')').kind, 'file');
  }
});

check('ordinary Markdown image syntax has exact bounds and safe metadata', () => {
  const source = 'Before ![图像](<D:/My files/preview.png>) after';
  const link = one(source);
  assert.equal(link.imageSyntax, true);
  assert.equal(source.slice(link.start, link.end), '![图像](<D:/My files/preview.png>)');
  assert.equal(one('![](preview.gif)').label, '');
  assert.equal(one('\\![plain link](preview.gif)').imageSyntax, false);
});

check('balanced bare parentheses work and ambiguous bare whitespace is rejected', () => {
  assert.equal(one('[photo](images/hero(2).png)').path, 'images/hero(2).png');
  assert.equal(one('[photo](<images/hero(2).png>)').path, 'images/hero(2).png');
  assert.deepEqual(scan('[photo](D:/My files/photo.png)'), []);
  assert.deepEqual(scan('[photo](images/hero(2.png)'), []);
  assert.deepEqual(scan('[photo](images/a.png "title")'), []);
  assert.deepEqual(scan(String.raw`[photo](images/a\(2\).png)`), []);
  assert.equal(one(String.raw`[photo](<D:\images\(final)\a.png>)`).path, 'D:/images/(final)/a.png');
});

check('HTML-like labels remain text metadata and escaped brackets decode once', () => {
  assert.equal(one('[<img src=x onerror=alert(1)>](preview.png)').label, '<img src=x onerror=alert(1)>');
  assert.equal(one(String.raw`[view \[final\]](preview.png)`).label, 'view [final]');
  assert.equal(one('[&lt;script&gt;](preview.png)').label, '&lt;script&gt;');
});

check('HTTP and HTTPS anchors and external Markdown images remain untouched', () => {
  const source = '[normal](https://example.test/a.png) ![external](https://example.test/b.gif) [http](http://example.test/x)';
  assert.deepEqual(scan(source), []);
  assert.deepEqual(scan('<https://example.test/[sample](a.png)>'), []);
  assert.deepEqual(scan('<a title="[sample](a.png)">'), []);
  assert.equal(one('<https://example.test/[sample](a.png)> [real](b.png)').path, 'b.png');
});

check('URI, network, rooted and traversal destinations never become local metadata', () => {
  const paths = ['//host/share/a.png', String.raw`\\host\share\a.png`, '/etc/a.png',
    String.raw`\root\a.png`, 'file:///D:/a.png', 'data:image/png;base64,AAAA',
    'javascript:alert(1)', 'https:evil.png', 'D:a.png', '../a.png', 'images/../a.png',
    'images/./a.png', '././a.png', './D:/a.png', 'D:/../a.png', 'D:/images//a.png',
    'images/%2e%2e/a.png', 'images/%252e%252e/a.png', 'images/%2f/a.png',
    'image.png?x=1', 'image.png#fragment', 'D:/image.png:stream', 'D:/a.png/',
    'D:/NUL.png', 'D:/con/a.png', 'D:/dir./a.png', 'D:/dir /a.png'];
  for (const target of paths) assert.deepEqual(scan('[bad](<' + target + '>)'), [], target);
});

check('controls, bidirectional escapes and invalid Unicode are rejected', () => {
  for (const ch of ['\x00', '\x1f', '\x7f', '\x85', '\u061c', '\u200e', '\u200f', '\u202e', '\u2066', '\ud800', '\udfff']) {
    assert.deepEqual(scan('[image](<D:/a' + ch + '.png>)'), []);
    assert.deepEqual(scan('[a' + ch + '](image.png)'), []);
  }
  assert.deepEqual(scan('[image](<D:/a\nimage.png>)'), []);
  assert.deepEqual(scan('[image](<D:/a\rimage.png>)'), []);
});

check('inline code including multi-tick and multiline spans is ignored', () => {
  const source = '`[one](a.png)` ``![two](b.png) `more` ``\n`line\n[three](c.png)` [real](d.png)';
  assert.deepEqual(scan(source).map(link => link.path), ['d.png']);
  assert.equal(one('`unclosed [real](a.png)').path, 'a.png');
  assert.equal(one('\\`literal [real](a.png)').path, 'a.png');
});

check('backtick and tilde fences with variable length ignore all sample links', () => {
  const source = '```md\n[one](a.png)\n```\n~~~\n![two](b.png)\n~~~\n' +
    '   ````md\n```\n[three](c.png)\n````\n[real](d.png)';
  assert.deepEqual(scan(source).map(link => link.path), ['d.png']);
  assert.deepEqual(scan('~~~md\n[unclosed](a.png)'), []);
  assert.deepEqual(scan('```md\n[one](a.png)\n``` extra\n[two](b.png)'), []);
});

check('space and tab indented code examples never create previews', () => {
  for (const indent of ['    ', '\t', ' \t', '   \t']) {
    assert.deepEqual(scan(indent + '[sample](D:/private/sample.png)\n' + indent + '![sample](secret.png)'), []);
  }
  assert.equal(one('    [sample](a.png)\n[real](b.png)').path, 'b.png');
  assert.equal(one('   [three spaces](c.png)').path, 'c.png');
});

check('escaping links and fenced samples does not consume real later links', () => {
  const source = '\\[escaped](a.png) [real](b.png)\n\\```\n[also real](c.png)';
  assert.deepEqual(scan(source).map(link => link.path), ['b.png', 'c.png']);
});

check('every returned range is non-overlapping and reconstructs unchanged source', () => {
  const source = '😀 ![第一](a.png), [second](./notes.md) & [external](https://example.test/image.png)\n![third](<D:/a b.gif>)';
  const links = scan(source);
  assert.equal(links.length, 3);
  let cursor = 0; let rebuilt = '';
  for (const link of links) {
    assert.ok(link.start >= cursor && link.end > link.start);
    rebuilt += source.slice(cursor, link.start) + source.slice(link.start, link.end);
    cursor = link.end;
  }
  assert.equal(rebuilt + source.slice(cursor), source);
});

check('result and candidate counts have hard caps even with unsafe options', () => {
  const source = Array.from({ length: 150 }, (_, i) => '[image](a' + i + '.png)').join(' ');
  assert.equal(scan(source).length, 20);
  assert.equal(scan(source, { maxLinks: 2 }).length, 2);
  assert.equal(scan(source, { maxLinks: 9999, maxCandidates: 9999 }).length, 20);
  assert.equal(scan(source, { maxLinks: 0 }).length, 0);
  assert.equal(scan(source, { maxCandidates: 0 }).length, 0);
  assert.equal(scan('[a](https://x.test) '.repeat(100) + '[b](b.png)').length, 0);
  assert.equal(scan('[a](https://x.test) '.repeat(99) + '[b](b.png)').length, 1);
  assert.equal(scan('[bad](<../x>) [real](a.png)', { maxCandidates: 1 }).length, 0);
});

check('scan length is bounded without cutting a Unicode pair or incomplete link', () => {
  assert.deepEqual(scan('text [image](a.png)', { maxInputLength: 12 }), []);
  assert.deepEqual(scan('😀[image](a.png)', { maxInputLength: 1 }), []);
  assert.equal(scan('x'.repeat(262144) + '[image](a.png)').length, 0);
  assert.equal(scan('x'.repeat(262143) + '😀[image](a.png)', { maxInputLength: 999999 }).length, 0);
  assert.equal(scan('[image](a.png)' + 'x'.repeat(300000)).length, 1);
  assert.deepEqual(scan(null), []);
  assert.deepEqual(scan({ toString() { throw new Error('must not coerce arbitrary objects'); } }), []);
});

check('long malformed markup remains bounded without losing later real links', () => {
  assert.deepEqual(scan('<'.repeat(262144)), []);
  assert.deepEqual(scan('['.repeat(262144)), []);
  assert.deepEqual(scan('`'.repeat(262144)), []);
  assert.equal(one('<'.repeat(15000) + '> [real](a.png)').path, 'a.png');
  const unmatched = Array.from({ length: 200 }, (_, i) => '`'.repeat(i + 1) + ' text ').join('');
  assert.equal(one(unmatched + '[real](b.png)').path, 'b.png');
});

check('label and target maxima reject oversized values and malformed wrappers', () => {
  assert.equal(scan('[' + 'a'.repeat(201) + '](a.png)').length, 0);
  assert.equal(scan('[image](<' + 'a'.repeat(2049) + '.png>)').length, 0);
  for (const source of ['[image](<a.png)', '[image](<a.png>garbage)', '[image](<> )',
    '[nested [label]](a.png)', '[code `label`](a.png)', '[image](a(((((((((1))))))))).png)']) {
    assert.deepEqual(scan(source), [], source);
  }
});

check('browser export loads in a network-free, DOM-free sandbox', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pwa/dsh-artifact-links.js'), 'utf8'), context);
  const result = context.window.DshArtifactLinks.scan('[browser](./a.png)');
  assert.equal(result[0].path, 'a.png');
  assert.equal(result[0].kind, 'image');
  assert.deepEqual(Object.keys(context.window), ['DshArtifactLinks']);
});

console.log('Artifact links: ' + checks + ' pure bounded-parser checks passed; no file reads or network actions.');
