interface FenceState {
  marker: '`' | '~';
  length: number;
}

interface MarkdownSegment {
  text: string;
  transformable: boolean;
  sealed?: boolean;
}

const RAW_HTML_TAG_PATTERN = /^ {0,3}<(pre|script|style|textarea)(?=[\t >]|$)/i;

function getFenceRun(line: string): string | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const run = match?.[1] ?? null;
  if (!run || (run[0] === '`' && match?.[2].includes('`'))) {
    return null;
  }
  return run;
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  const run = match?.[1];
  return !!run && run[0] === fence.marker && run.length >= fence.length;
}

function readBacktickRun(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === '`') {
    length += 1;
  }
  return length;
}

function isBackslashEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function appendSegment(
  segments: MarkdownSegment[],
  text: string,
  transformable: boolean,
): void {
  if (!text) {
    return;
  }

  const previous = segments[segments.length - 1];
  if (previous?.transformable === transformable && !previous.sealed) {
    previous.text += text;
  } else {
    segments.push({ text, transformable });
  }
}

function sealLastSegment(segments: MarkdownSegment[]): void {
  const previous = segments[segments.length - 1];
  if (previous) {
    previous.sealed = true;
  }
}

function findMatchingBacktickRun(line: string, start: number, runLength: number): number | null {
  for (let index = start + runLength; index < line.length; index += 1) {
    if (line[index] !== '`') {
      continue;
    }

    const candidateLength = readBacktickRun(line, index);
    if (candidateLength === runLength) {
      return index + runLength - 1;
    }
    index += candidateLength - 1;
  }
  return null;
}

function findWikilinkEnd(line: string, start: number): number | null {
  if (!line.startsWith('[[', start) || isBackslashEscaped(line, start)) {
    return null;
  }

  const closingStart = line.indexOf(']]', start + 2);
  return closingStart === -1 ? null : closingStart + 1;
}

function findLinkDestinationEnd(line: string, start: number): number | null {
  if (line[start] !== '(') {
    return null;
  }

  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && line[index + 1]) {
      index += 1;
    } else if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    } else if (char === '\n') {
      return null;
    }
  }
  return null;
}

function findAutolinkEnd(line: string, start: number): number | null {
  const end = line.indexOf('>', start + 1);
  if (end === -1) {
    return null;
  }

  const destination = line.slice(start + 1, end);
  if (!destination || /[\s<>\\()[\]]/.test(destination)) {
    return null;
  }

  const uri = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(destination);
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(destination);
  return uri || email ? end : null;
}

function findHtmlEnd(line: string, start: number): number | null {
  const specialTerminators: Array<[string, string]> = [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
  ];
  for (const [opener, closer] of specialTerminators) {
    if (line.startsWith(opener, start)) {
      const end = line.indexOf(closer, start + opener.length);
      return end === -1 ? null : end + closer.length - 1;
    }
  }

  let index = start + 1;
  if (line[index] === '/') {
    index += 1;
  }
  if (!/[A-Za-z]/.test(line[index] ?? '')) {
    return null;
  }

  let quote: '"' | "'" | null = null;
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return null;
}

function splitInlineMarkdown(line: string, segments: MarkdownSegment[]): void {
  let segmentStart = 0;
  let bracketDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '`') {
      const runLength = readBacktickRun(line, index);
      const end = findMatchingBacktickRun(line, index, runLength);
      if (end !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendSegment(segments, line.slice(index, end + 1), false);
        segmentStart = end + 1;
        index = end;
      } else {
        index += runLength - 1;
      }
      continue;
    }

    if (char === '[') {
      const wikilinkEnd = findWikilinkEnd(line, index);
      if (wikilinkEnd !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendSegment(segments, line.slice(index, wikilinkEnd + 1), false);
        segmentStart = wikilinkEnd + 1;
        index = wikilinkEnd;
      } else if (!isBackslashEscaped(line, index)) {
        bracketDepth += 1;
      }
      continue;
    }

    if (char === ']' && !isBackslashEscaped(line, index) && bracketDepth > 0) {
      bracketDepth -= 1;
      if (line[index + 1] === '(') {
        const destinationEnd = findLinkDestinationEnd(line, index + 1);
        if (destinationEnd !== null) {
          appendSegment(segments, line.slice(segmentStart, index + 1), true);
          appendSegment(segments, line.slice(index + 1, destinationEnd + 1), false);
          segmentStart = destinationEnd + 1;
          index = destinationEnd;
        }
      }
      continue;
    }

    if (char === '<') {
      const end = findAutolinkEnd(line, index) ?? findHtmlEnd(line, index);
      if (end !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendSegment(segments, line.slice(index, end + 1), false);
        segmentStart = end + 1;
        index = end;
      }
    }
  }

  appendSegment(segments, line.slice(segmentStart), true);
}

function splitMarkdown(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let fence: FenceState | null = null;
  let rawHtmlTag: string | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const lineWithoutNewline = line.replace(/\r?\n$/, '');

    if (fence) {
      appendSegment(segments, line, false);
      if (isClosingFence(lineWithoutNewline, fence)) {
        fence = null;
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    if (rawHtmlTag) {
      appendSegment(segments, line, false);
      if (new RegExp(`<\\/${rawHtmlTag}>`, 'i').test(lineWithoutNewline)) {
        rawHtmlTag = null;
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    if (/^[ \t]*$/.test(lineWithoutNewline)) {
      appendSegment(segments, line, true);
      sealLastSegment(segments);
      lineStart = lineEnd;
      continue;
    }

    if (/^(?: {4}|\t)/.test(lineWithoutNewline)) {
      appendSegment(segments, line, false);
      sealLastSegment(segments);
      lineStart = lineEnd;
      continue;
    }

    const fenceRun = getFenceRun(lineWithoutNewline);
    if (fenceRun) {
      appendSegment(segments, line, false);
      fence = {
        marker: fenceRun[0] as '`' | '~',
        length: fenceRun.length,
      };
      lineStart = lineEnd;
      continue;
    }

    const rawHtmlMatch = lineWithoutNewline.match(RAW_HTML_TAG_PATTERN);
    if (rawHtmlMatch) {
      appendSegment(segments, line, false);
      const tag = rawHtmlMatch[1].toLowerCase();
      if (!new RegExp(`<\\/${tag}>`, 'i').test(lineWithoutNewline)) {
        rawHtmlTag = tag;
      } else {
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    splitInlineMarkdown(line, segments);
    lineStart = lineEnd;
  }

  return segments;
}

function normalizeLatexMathInText(text: string): string {
  const openers = new Map<'inline' | 'display', number>();
  const replacements = new Map<number, string>();

  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== '\\' || isBackslashEscaped(text, index)) {
      continue;
    }

    const delimiter = text[index + 1];
    const kind = delimiter === '(' || delimiter === ')'
      ? 'inline'
      : delimiter === '[' || delimiter === ']'
        ? 'display'
        : null;
    if (!kind) {
      continue;
    }

    if (delimiter === '(' || delimiter === '[') {
      if (!openers.has(kind)) {
        openers.set(kind, index);
      }
    } else {
      const opener = openers.get(kind);
      if (opener !== undefined) {
        const replacement = kind === 'display' ? '$$' : '$';
        replacements.set(opener, replacement);
        replacements.set(index, replacement);
        openers.delete(kind);
      }
    }
    index += 1;
  }

  if (replacements.size === 0) {
    return text;
  }

  let normalized = '';
  for (let index = 0; index < text.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement) {
      normalized += replacement;
      index += 1;
    } else {
      normalized += text[index];
    }
  }
  return normalized;
}

/** Converts matched LaTeX math delimiters to Obsidian's dollar delimiters. */
export function normalizeLatexMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\')) {
    return markdown;
  }

  return splitMarkdown(markdown)
    .map(segment => segment.transformable ? normalizeLatexMathInText(segment.text) : segment.text)
    .join('');
}

function escapeMathDelimitersInText(text: string): string {
  let escaped = '';
  let precedingBackslashes = 0;

  for (const char of text) {
    if (char === '\\') {
      escaped += char;
      precedingBackslashes += 1;
      continue;
    }

    escaped += char === '$' && precedingBackslashes % 2 === 0 ? '\\$' : char;
    precedingBackslashes = 0;
  }
  return escaped;
}

/** Escapes visible dollar math during transient streaming renders. */
export function escapeMathDelimitersForStreaming(markdown: string): string {
  if (!markdown.includes('$')) {
    return markdown;
  }

  return splitMarkdown(markdown)
    .map(segment => segment.transformable ? escapeMathDelimitersInText(segment.text) : segment.text)
    .join('');
}

export function hasStreamingMathDelimiters(markdown: string): boolean {
  if (!markdown.includes('$') && !markdown.includes('\\')) {
    return false;
  }

  const normalized = normalizeLatexMathDelimiters(markdown);
  return escapeMathDelimitersForStreaming(normalized) !== normalized;
}
