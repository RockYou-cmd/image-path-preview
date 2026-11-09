'use strict';

const path = require('node:path');

// Only make suggestions in local image paths. In particular, avoid changing
// ordinary IntelliSense for package names, web URLs or unrelated strings.
const PATH_PREFIX = String.raw`(?:\.{1,2}\/|\/)`;
const PATH_CHARS_QUOTED = String.raw`[^"'\x60\\<>?#]*`;
const PATH_CHARS_UNQUOTED = String.raw`[^\s"'\x60\\()<>?#]*`;
const CSS_URL = new RegExp(
  String.raw`(?<![\w-])url\(\s*(?:(['"])(` + PATH_PREFIX + PATH_CHARS_QUOTED + String.raw`)|(` + PATH_PREFIX + PATH_CHARS_UNQUOTED + String.raw`))$`,
  'i'
);
const QUOTED_PATH = new RegExp(String.raw`(['"])(` + PATH_PREFIX + PATH_CHARS_QUOTED + String.raw`)$`);
const HTML_IMAGE_ATTR = /(?:^|[\s<])(?:src|data-src|poster)\s*=\s*(?:\{\s*)?["'](?:\.{1,2}\/|\/)[^"'\x60\\<>?#]*$/i;

function isCodeAt(line, end, css) {
  let quote;
  let commentEnd;
  for (let index = 0; index < end; index++) {
    const character = line[index];
    if (commentEnd) {
      if (line.startsWith(commentEnd, index)) {
        index += commentEnd.length - 1;
        commentEnd = undefined;
      }
    } else if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
    } else if (line.startsWith('/*', index)) {
      commentEnd = '*/';
      index++;
    } else if (line.startsWith('<!--', index)) {
      commentEnd = '-->';
      index += 3;
    } else if (line.startsWith('//', index)) {
      if (!css || !/[:(]/.test(line[index - 1] || '')) return false;
      index++;
    } else if (character === '"' || character === "'" || character === '\x60') {
      quote = character;
    }
  }
  return !quote && !commentEnd;
}

// A url(...) nested in the *quoted* HTML style attribute is valid CSS, even
// though a standard string scanner considers it to be inside an HTML quote.
function isInsideStyleAttribute(line, at) {
  const before = line.slice(0, at);
  const match = /(?:^|[\s<])style\s*=\s*(['"])/gi;
  let candidate;
  for (const m of before.matchAll(match)) candidate = m;
  if (!candidate) return false;
  const quote = candidate[1];
  const start = candidate.index + candidate[0].length;
  let escaped = false;
  for (let i = start; i < at; i++) {
    if (escaped) { escaped = false; continue; }
    if (before[i] === '\\') { escaped = true; continue; }
    if (before[i] === quote) return false;
  }
  // Ignore unrelated prose containing style="...".
  return /<[a-z][\w:.-]*/i.test(before.slice(0, candidate.index));
}

function buildContext(line, character, prefix, quote, unquoted = false) {
  let suffix;
  if (quote) {
    const closing = line.indexOf(quote, character);
    suffix = closing >= 0 ? line.slice(character, closing) : /^[^\s"'\x60\\()<>?#]*/.exec(line.slice(character))[0];
  } else {
    suffix = /^[^\s"'\x60\\()<>?#]*/.exec(line.slice(character))[0];
  }
  if (/[\\\x60<>?#]/.test(suffix) || (prefix + suffix).includes('${')) return;
  return { prefix, start: character - prefix.length, end: character + suffix.length, quote: quote || null, unquoted };
}

/** Find the image path being typed, preserving the replacement range. */
function getImagePathContext(line, character, language = 'javascript') {
  const before = line.slice(0, character);

  const css = CSS_URL.exec(before);
  if (css && (isCodeAt(line, css.index, true) ||
    (language === 'html' && isInsideStyleAttribute(line, css.index)))) {
    return buildContext(line, character, css[2] ?? css[3], css[1], !css[1]);
  }

  const quoted = QUOTED_PATH.exec(before);
  if (!quoted || !isCodeAt(line, quoted.index)) return;

  if (language === 'html') {
    const attr = HTML_IMAGE_ATTR.exec(before);
    if (!attr || !/<[a-z][\w:.-]*/i.test(before.slice(0, attr.index))) return;
  }

  return buildContext(line, character, quoted[2], quoted[1]);
}


const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
// For existing paths, find the *entire* string rather than the unfinished
// prefix used for completion. Confirm each match with the completion parser
// to avoid hovering image-like text in comments or unrelated HTML attributes.
const QUOTED_IMAGE_PATH = /(["'])((?:\.{1,2}\/|\/)[^"'\x60\\<>?#]*)\1/g;
const UNQUOTED_IMAGE_URL = /(?<![\w-])url\(\s*((?:\.{1,2}\/|\/)[^\s"'\x60\\()<>?#]*)/gi;

function getImagePathAtPosition(line, character, language = 'javascript') {
  const candidates = [];
  for (const match of line.matchAll(QUOTED_IMAGE_PATH)) {
    candidates.push({
      value: match[2],
      start: match.index + 1,
      quote: match[1],
      unquoted: false
    });
  }
  if (['css', 'scss', 'less', 'html'].includes(language)) {
    for (const match of line.matchAll(UNQUOTED_IMAGE_URL)) {
      candidates.push({
        value: match[1],
        start: match.index + match[0].length - match[1].length,
        quote: null,
        unquoted: true
      });
    }
  }
  for (const candidate of candidates) {
    const end = candidate.start + candidate.value.length;
    if (character < candidate.start || character >= end ||
        !IMAGE_EXTENSIONS.has(path.extname(candidate.value).toLowerCase())) continue;
    const parsed = getImagePathContext(line, end, language);
    if (parsed?.start === candidate.start && parsed.prefix === candidate.value) {
      return { path: candidate.value, start: candidate.start, end,
        quote: candidate.quote, unquoted: candidate.unquoted };
    }
  }
}

module.exports = { getImagePathContext, getImagePathAtPosition };

