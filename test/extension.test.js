'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let provider;
let hoverProvider;
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class CompletionList { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } }
class Range { constructor(startLine, startChar, endLine, endChar) { Object.assign(this, {startLine, startChar, endLine, endChar}); } }
class MarkdownString { constructor(value) { this.value = value; } }
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
const vscode = {
  CompletionItem,
  CompletionList,
  CompletionItemKind: {File: 1},
  Range,
  MarkdownString,
  Hover,
  Uri: {file: (p) => ({toString: () => 'file://' + encodeURI(p)})},
  workspace: { getWorkspaceFolder: () => undefined },
  languages: {
    registerCompletionItemProvider: (...args) => { provider = args[1]; return {dispose(){}}; },
    registerHoverProvider: (...args) => { hoverProvider = args[1]; return {dispose(){}}; }
  }
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
const { activate } = require('../src/extension');
Module._load = load;
activate({subscriptions: []});
const token = {isCancellationRequested: false};

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ipp-'));
  const images = path.join(root, 'images');
  const pub = path.join(root, 'public', 'images');
  await fs.mkdir(images, { recursive: true });
  await fs.mkdir(pub, { recursive: true });
  for (const dir of [images, pub]) {
    for (const file of ['banner-blue.png', 'banner-green.png', 'banner-orange.png', 'banner with spaces.png', 'badge.svg', 'ignore.js']) {
      await fs.writeFile(path.join(dir, file), 'image');
    }
  }
  return root;
}

function documentAt(root, text, languageId='css') {
  const position = text.indexOf('./images/') !== -1
    ? text.indexOf('./images/') + './images/'.length
    : text.indexOf('/images/') + '/images/'.length;
  const document = {
    uri: {fsPath: path.join(root, `demo.${languageId}`)},
    languageId,
    lineAt: () => ({text})
  };
  vscode.workspace.getWorkspaceFolder = () => ({uri: {fsPath: root}});
  return [document, {line: 0, character: position}];
}

let root;
test.before(async () => { root = await makeFixture(); });
test.after(async () => { await fs.rm(root, {recursive: true, force: true}); });

test('provides one image-preview item per file and resolves thumbnail on selection', async () => {
  const [doc, pos] = documentAt(root, '.hero { background: url("./images/"); }');
  const completions = await provider.provideCompletionItems(doc, pos, token);
  assert.equal(completions.items.length, 5);
  assert.equal(new Set(completions.items.map(x=>x.label.label)).size, 5);
  assert.equal(completions.items[0].label.description, 'Image preview');
  assert.equal(completions.items[0].insertText.startsWith('./images/'), true);
  assert.equal(completions.items[0].filterText, completions.items[0].insertText);
  const selected = completions.items.find(x=>x.label.label === 'banner-blue.png');
  await provider.resolveCompletionItem(selected, token);
  assert.match(selected.documentation.value, /Image preview/);
  assert.match(selected.documentation.value, /banner-blue\.png/);
});

test('works for JSX expressions and TypeScript strings', async () => {
  for (const [text, lang] of [
    ['<img src={"./images/"} />', 'javascriptreact'],
    ['const images: string[] = ["./images/"];', 'typescript'],
    ['<div style="background-image: url(\'./images/\');">', 'html'],
  ]) {
    const [doc, pos] = documentAt(root, text, lang);
    const result = await provider.provideCompletionItems(doc, pos, token);
    assert.ok(result.items.some(x => x.label.label === 'banner-blue.png'), text);
  }
});

test('includes spaces in quoted filenames and SVG but not unquoted CSS', async () => {
  const [doc, pos] = documentAt(root, '.hero { background: url("./images/"); }');
  const result = await provider.provideCompletionItems(doc, pos, token);
  assert.ok(result.items.some(x => x.label.label === 'banner with spaces.png'));
  assert.ok(result.items.some(x => x.label.label === 'badge.svg'));
  const [rawDoc, rawPos] = documentAt(root, '.hero { background: url(./images/); }');
  const raw = await provider.provideCompletionItems(rawDoc, rawPos, token);
  assert.ok(!raw.items.some(x=>x.label.label === 'banner with spaces.png'));
});

test('resolves root-style paths through public folder', async () => {
  const [doc, pos] = documentAt(root, '.hero { background: url("/images/"); }');
  const result = await provider.provideCompletionItems(doc, pos, token);
  const selected = result.items.find(x=>x.label.label === 'badge.svg');
  assert.ok(selected);
  assert.equal(selected.insertText, '/images/badge.svg');
  await provider.resolveCompletionItem(selected, token);
  assert.match(selected.documentation.value, /\/public\/images\/badge\.svg/);
});

test('blocks traversal outside workspace', async () => {
  const [doc, pos] = documentAt(root, 'const picture = "../../images/";', 'typescript');
  const result = await provider.provideCompletionItems(doc, pos, token);
  assert.equal(result, undefined);
});


test('supports explicit /public/images paths', async () => {
  const text = 'const banner = "/public/images/";';
  const cursor = text.indexOf('/public/images/') + '/public/images/'.length;
  vscode.workspace.getWorkspaceFolder = () => ({uri: {fsPath: root}});
  const document = {uri: {fsPath: path.join(root, 'demo.ts')}, languageId:'typescript', lineAt: () => ({text})};
  const result = await provider.provideCompletionItems(document, {line:0, character:cursor}, token);
  assert.ok(result.items.some(item=>item.insertText === '/public/images/banner-blue.png'));
});


function hoverDocument(root, text, languageId = 'css') {
  vscode.workspace.getWorkspaceFolder = () => ({uri: {fsPath: root}});
  return { uri: {fsPath: path.join(root, `demo.${languageId}`)}, languageId, lineAt: () => ({text}) };
}

function hoverAt(text, piece) {
  const index = text.indexOf(piece);
  assert.ok(index >= 0);
  return {line: 0, character: index + Math.floor(piece.length / 2)};
}

test('hover previews completed image paths in CSS, HTML, JS/TS, and JSX', async () => {
  for (const [text, lang] of [
    ['.hero { background: url("./images/banner-blue.png"); }', 'css'],
    ['.hero { background: url(./images/banner-blue.png); }', 'css'],
    ['<div style="background-image:url(\'./images/banner-blue.png\');">', 'html'],
    ['<img src="./images/banner-blue.png" alt="Banner">', 'html'],
    ['import banner from "./images/banner-blue.png";', 'javascript'],
    ['const banner = "./images/banner-blue.png";', 'typescript'],
    ['<img src={"./images/banner-blue.png"} />', 'javascriptreact'],
    ['<img src="./images/banner-blue.png" />', 'typescriptreact'],
    ['$banner: "./images/banner-blue.png";', 'scss'],
    ['@banner: "./images/banner-blue.png";', 'less'],
  ]) {
    const doc = hoverDocument(root, text, lang);
    const result = await hoverProvider.provideHover(doc, hoverAt(text, 'banner-blue.png'), token);
    assert.ok(result, text);
    assert.match(result.contents.value, /Image preview/);
    assert.match(result.contents.value, /banner-blue\.png/);
    assert.equal(result.range.endLine, 0);
    assert.equal(text.slice(result.range.startChar, result.range.endChar), './images/banner-blue.png');
  }
});

test('hover supports an SVG image and /public/ workspace asset paths', async () => {
  for (const text of ['<img src="/images/badge.svg" />', '<img src="/public/images/badge.svg" />']) {
    const doc = hoverDocument(root, text, 'html');
    const result = await hoverProvider.provideHover(doc, hoverAt(text, 'badge.svg'), token);
    assert.ok(result);
    assert.match(result.contents.value, /public\/images\/badge\.svg/);
  }
});

test('hover supports quoted filenames containing spaces', async () => {
  const text = 'const banner = "./images/banner with spaces.png";';
  const doc = hoverDocument(root, text, 'typescript');
  const result = await hoverProvider.provideHover(doc, hoverAt(text, 'spaces.png'), token);
  assert.ok(result);
  assert.match(result.contents.value, /banner%20with%20spaces\.png/);
});

test('hover ignores unsupported contexts, missing image paths, remote URLs, and comments', async () => {
  for (const [text, lang, search] of [
    ['// const img = "./images/banner-blue.png"', 'javascript', 'banner-blue.png'],
    ['/* url("./images/banner-blue.png") */', 'css', 'banner-blue.png'],
    ['<img alt="./images/banner-blue.png" />', 'html', 'banner-blue.png'],
    ['const remote = "https://server.com/banner-blue.png"', 'javascript', 'banner-blue.png'],
    ['const missing = "./images/nonexistent.png"', 'javascript', 'nonexistent.png'],
    ['const ordinary = "./images/ignore.js";', 'javascript', 'ignore.js'],
    ['const image = "./images/";', 'javascript', './images/'],
    ['const banner = "../../outside/banner-blue.png";', 'typescript', 'banner-blue.png'],
  ]) {
    const doc = hoverDocument(root, text, lang);
    assert.equal(await hoverProvider.provideHover(doc, hoverAt(text, search), token), undefined, text);
  }
});

test('hover is suppressed on cancellation and image symlinks escaping the workspace', async (t) => {
  const text = 'const banner = "./images/banner-blue.png";';
  const doc = hoverDocument(root, text, 'javascript');
  assert.equal(await hoverProvider.provideHover(doc, hoverAt(text, 'banner-blue.png'), {isCancellationRequested: true}), undefined);
  const target = path.join(root, 'images', 'external.png');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ipp-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'external.png'), 'secret');
    try { await fs.symlink(path.join(outside, 'external.png'), target); }
    catch(e) { if (e.code === 'EPERM') { t.diagnostic('symlinks unavailable'); return; } else throw e; }
    const unsafe = 'const banner = "./images/external.png";';
    const doc2 = hoverDocument(root, unsafe, 'javascript');
    assert.equal(await hoverProvider.provideHover(doc2, hoverAt(unsafe, 'external.png'), token), undefined);
  } finally {
    await fs.rm(target, {force: true});
    await fs.rm(outside, {recursive: true, force: true});
  }
});

test('oversized images report limit without embedding a preview', async () => {
  const large = path.join(root, 'images', 'large.png');
  await fs.writeFile(large, Buffer.alloc(5*1024*1024 + 1));
  try {
    const text = 'const banner = "./images/large.png";';
    const doc = hoverDocument(root, text, 'javascript');
    const result = await hoverProvider.provideHover(doc, hoverAt(text, 'large.png'), token);
    assert.ok(result);
    assert.match(result.contents.value, /too large/i);
    assert.doesNotMatch(result.contents.value, /!\[/);
  } finally { await fs.rm(large); }
});
