'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { getImagePathContext, getImagePathAtPosition } = require('./context');

const languages = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'css', 'scss', 'less', 'html'];
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const maxSuggestions = 100;
const maxPreviewBytes = 5 * 1024 * 1024;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Absolute web asset paths often refer to a project's public/ directory.
// Also support /public/images/... and a direct workspace-root /images/ path.
async function resolveImageDirectory(document, workspace, directoryPrefix) {
  const base = workspace.uri.fsPath;
  if (!directoryPrefix.startsWith('/')) {
    return path.resolve(path.dirname(document.uri.fsPath), directoryPrefix);
  }
  const rooted = directoryPrefix.replace(/^\/+/, '');
  const candidates = rooted.startsWith('public/')
    ? [path.join(base, rooted)]
    : [path.join(base, 'public', rooted), path.join(base, rooted)];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch { /* Use another candidate. */ }
  }
  return candidates[0];
}

function safeImageName(filename, quote, unquoted) {
  if (/[\x00-\x1f\\/?#<>]/u.test(filename)) return false;
  // Unquoted CSS urls with spaces or brackets would require escaping/quoting.
  if (unquoted && /[\s'"`()]/u.test(filename)) return false;
  if (quote && filename.includes(quote)) return false;
  return true;
}

async function resolveHoverImage(document, workspace, imagePath, token) {
  const lastSlash = imagePath.path.lastIndexOf('/') + 1;
  const directoryPrefix = imagePath.path.slice(0, lastSlash);
  const filename = imagePath.path.slice(lastSlash);
  if (!filename || !safeImageName(filename, imagePath.quote, imagePath.unquoted) ||
      !imageExtensions.has(path.extname(filename).toLowerCase())) return;
  const directory = await resolveImageDirectory(document, workspace, directoryPrefix);
  if (!isWithin(workspace.uri.fsPath, directory) || token.isCancellationRequested) return;
  try {
    const root = await fs.realpath(workspace.uri.fsPath);
    const realDirectory = await fs.realpath(directory);
    if (!isWithin(root, realDirectory) || token.isCancellationRequested) return;
    const file = await fs.realpath(path.join(realDirectory, filename));
    if (!isWithin(root, file) || !imageExtensions.has(path.extname(file).toLowerCase())) return;
    const stat = await fs.stat(file);
    if (!stat.isFile() || token.isCancellationRequested) return;
    return { file, size: stat.size };
  } catch {
    // Paths can be deleted or replaced between hovering and reading them.
  }
}

function imageMarkdown(file, width = 200) {
  const uri = vscode.Uri.file(file).toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
  return new vscode.MarkdownString(`![Image preview](${uri}|width=${width})`);
}

function activate(context) {
  const images = new WeakMap();
  const selectors = languages.map(language => ({ language, scheme: 'file' }));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selectors, {
    async provideCompletionItems(document, position, token) {
      const imagePath = getImagePathContext(
        document.lineAt(position.line).text, position.character, document.languageId
      );
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!imagePath || !workspace || token.isCancellationRequested) return;

      const split = imagePath.prefix.lastIndexOf('/') + 1;
      const directoryPrefix = imagePath.prefix.slice(0, split);
      const namePrefix = imagePath.prefix.slice(split).toLowerCase();
      const directory = await resolveImageDirectory(document, workspace, directoryPrefix);
      if (!isWithin(workspace.uri.fsPath, directory)) return;

      let root, actualDirectory, entries;
      try {
        root = await fs.realpath(workspace.uri.fsPath);
        actualDirectory = await fs.realpath(directory);
        if (!isWithin(root, actualDirectory) || token.isCancellationRequested) return;
        entries = await fs.readdir(actualDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      if (token.isCancellationRequested) return;

      const range = new vscode.Range(position.line, imagePath.start, position.line, imagePath.end);
      const matches = entries.filter(entry =>
        entry.isFile() && safeImageName(entry.name, imagePath.quote, imagePath.unquoted) &&
        entry.name.toLowerCase().startsWith(namePrefix) &&
        imageExtensions.has(path.extname(entry.name).toLowerCase())
      ).sort((a, b) => a.name.localeCompare(b.name));

      // A provider cannot remove VS Code's built-in file suggestions. Give our
      // entries distinct labels instead of presenting visually identical rows.
      const items = matches.slice(0, maxSuggestions).map(entry => {
        const label = directoryPrefix + entry.name;
        const item = new vscode.CompletionItem(
          { label: entry.name, description: 'Image preview' }, vscode.CompletionItemKind.File
        );
        item.detail = label;
        item.insertText = label;
        item.filterText = label;
        item.sortText = `0_${entry.name.toLowerCase()}`;
        item.range = range;
        images.set(item, { root, filename: path.join(actualDirectory, entry.name) });
        return item;
      });
      if (items.length) return new vscode.CompletionList(items, matches.length > maxSuggestions);
    },

    async resolveCompletionItem(item, token) {
      const image = images.get(item);
      if (!image || token.isCancellationRequested) return item;
      try {
        const file = await fs.realpath(image.filename);
        if (!isWithin(image.root, file) || !imageExtensions.has(path.extname(file).toLowerCase())) return item;
        const stat = await fs.stat(file);
        if (token.isCancellationRequested || !stat.isFile()) return item;
        if (stat.size > maxPreviewBytes) {
          item.documentation = 'Preview available for images up to 5 MB.';
          return item;
        }
        item.documentation = imageMarkdown(file);
      } catch {
        // A file can disappear while the suggestion list is open.
      }
      return item;
    }
  }, '/'));

  context.subscriptions.push(vscode.languages.registerHoverProvider(selectors, {
    async provideHover(document, position, token) {
      if (token.isCancellationRequested) return;
      const imagePath = getImagePathAtPosition(
        document.lineAt(position.line).text, position.character, document.languageId
      );
      if (!imagePath) return;
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspace) return;
      const resolved = await resolveHoverImage(document, workspace, imagePath, token);
      if (!resolved || token.isCancellationRequested) return;
      const contents = resolved.size > maxPreviewBytes
        ? new vscode.MarkdownString('Image Path Preview: file is too large to preview (5 MB limit).')
        : imageMarkdown(resolved.file, 240);
      return new vscode.Hover(contents, new vscode.Range(
        position.line, imagePath.start, position.line, imagePath.end
      ));
    }
  }));
}

module.exports = { activate };
