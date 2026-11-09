'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getImagePathContext, getImagePathAtPosition } = require('../src/context');

const cases = [
  ['CSS quoted url', 'css', '.hero { background-image: url("./images/"); }'],
  ['CSS unquoted url', 'css', '.hero { background-image: url(./images/); }'],
  ['CSS single-quoted url', 'css', ".hero { background-image: url('./images/'); }"],
  ['CSS shorthand', 'css', '.logo { background: url("./images/") center / cover; }'],
  ['HTML src', 'html', '<img src="./images/" alt="A">'],
  ['HTML inline style', 'html', '<div style="background-image: url(\'./images/\');">'],
  ['JS import', 'javascript', 'import banner from "./images/";'],
  ['JS require', 'javascript', 'const bg = require("./images/");'],
  ['JS dynamic import', 'javascript', 'const bg = import("./images/");'],
  ['TS array', 'typescript', 'const images: string[] = ["./images/"];'],
  ['SCSS variable', 'scss', '$banner: "./images/";'],
  ['LESS variable', 'less', '@banner: "./images/";'],
  ['JSX plain src', 'javascriptreact', '<img src="./images/" />'],
  ['JSX expression src', 'javascriptreact', '<img src={"./images/"} />'],
  ['TSX expression', 'typescriptreact', '<img src={"./images/"} />'],
  ['root public path', 'css', '.hero { background: url("/images/"); }'],
  ['explicit public', 'typescript', 'const banner = "/public/images/";'],
  ['quoted space', 'css', '.hero { background: url("./images/a space"); }'],
];

for (const [name, lang, line] of cases) {
  test(`recognizes ${name}`, () => {
    const imageStart = line.includes('./images/') ? './images/' : line.includes('/public/images/') ? '/public/images/' : '/images/';
    const start = line.indexOf(imageStart);
    const position = start + imageStart.length;
    const result = getImagePathContext(line, position, lang);
    assert.ok(result, JSON.stringify({ name, lang, line }));
    assert.equal(result.start, start);
    assert.equal(result.prefix, imageStart);
    assert.equal(result.end, line.includes('a space') ? line.indexOf('"', start + imageStart.length) : position);
  });
}

test('replaces existing suffix when navigating suggestions', () => {
  const line = '.hero { background-image: url("./images/banner-blue.png"); }';
  const position = line.indexOf('./images/') + './images/'.length;
  const result = getImagePathContext(line, position, 'css');
  assert.equal(line.slice(result.start, result.end), './images/banner-blue.png');
});

test('avoids markup prose, comments and non-image URLs', () => {
  for (const [line, lang] of [
    ['<p>"./images/', 'html'],
    ['// "./images/', 'javascript'],
    ['/* "./images/', 'css'],
    ['const url = "https://example.org/', 'javascript'],
    ['const value = "hello', 'typescript'],
    ['<img alt="./images/', 'html'],
    ['const code = "some url(\'./images/', 'javascript'],
  ]) assert.equal(getImagePathContext(line, line.length, lang), undefined, line);
});

test('does not suggest for template expressions or query-string paths', () => {
  const template = 'const image = "./images/${name}';
  assert.equal(getImagePathContext(template, template.length, 'javascript'), undefined);
  const url = 'const image = "./images/foo.png?version=1';
  assert.equal(getImagePathContext(url, url.length, 'javascript'), undefined);
});


test('hover path detector returns correct range even in multiple image strings', () => {
  const line = '<img src="./images/banner-blue.png" alt="a"> <img src="./images/banner-green.png">';
  for (const expected of ['./images/banner-blue.png','./images/banner-green.png']) {
    const pos = line.indexOf(expected) + 12;
    const result = getImagePathAtPosition(line, pos, 'html');
    assert.ok(result);
    assert.equal(result.path, expected);
    assert.equal(line.slice(result.start,result.end), expected);
  }
});

test('hover ignores a path when pointer is outside the image string', () => {
  const line = '<img src="./images/banner-blue.png" alt="x">';
  assert.equal(getImagePathAtPosition(line, line.indexOf('alt'), 'html'), undefined);
  assert.equal(getImagePathAtPosition(line, line.indexOf('banner-blue.png') - 2, 'html')?.path, './images/banner-blue.png');
});

test('hover ignores remote URLs, comments, and unrecognized extensions', () => {
  for (const [line, language] of [
    ['const image = "https://example.com/cat.png";', 'javascript'],
    ['// const image = "./images/cat.png";', 'javascript'],
    ['<img alt="./images/cat.png">', 'html'],
    ['const image = "./images/cat.txt";', 'javascript'],
    ['const image = "./images/cat.png?v=1";', 'javascript'],
  ]) {
    assert.equal(getImagePathAtPosition(line, line.indexOf('cat.')+2, language), undefined, line);
  }
});
