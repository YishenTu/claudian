interface FenceState {
  marker: '`' | '~';
  length: number;
}

function getFenceRun(line: string): string | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match?.[1] ?? null;
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const run = getFenceRun(line);
  return !!run && run[0] === fence.marker && run.length >= fence.length;
}

function isHtmlTagStart(line: string, index: number): boolean {
  const next = line[index + 1];
  return !!next && /[A-Za-z/!?]/.test(next);
}

function readBacktickRun(line: string, index: number): number {
  let length = 0;
  while (line[index + length] === '`') {
    length += 1;
  }
  return length;
}

function escapeMathDelimitersInLine(line: string): string {
  let escaped = '';
  let inlineCodeRunLength = 0;
  let inHtmlTag = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '`') {
      const runLength = readBacktickRun(line, index);
      escaped += line.slice(index, index + runLength);
      index += runLength - 1;
      if (inlineCodeRunLength === 0) {
        inlineCodeRunLength = runLength;
      } else if (runLength === inlineCodeRunLength) {
        inlineCodeRunLength = 0;
      }
      continue;
    }

    if (inlineCodeRunLength > 0) {
      escaped += char;
      continue;
    }

    if (inHtmlTag) {
      escaped += char;
      if (char === '>') {
        inHtmlTag = false;
      }
      continue;
    }

    if (char === '<' && isHtmlTagStart(line, index)) {
      inHtmlTag = true;
      escaped += char;
      continue;
    }

    if (char === '\\' && line[index + 1] === '$') {
      escaped += '\\$';
      index += 1;
      continue;
    }

    escaped += char === '$' ? '\\$' : char;
  }

  return escaped;
}

/**
 * Escapes dollar math delimiters outside code spans and fenced code blocks.
 * Used only for transient streaming renders so MarkdownRenderer does not hand
 * incomplete math to Obsidian's math renderer on every frame.
 */
export function escapeMathDelimitersForStreaming(markdown: string): string {
  if (!markdown.includes('$')) {
    return markdown;
  }

  let result = '';
  let fence: FenceState | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const lineWithoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;

    if (fence) {
      result += line;
      if (isClosingFence(lineWithoutNewline, fence)) {
        fence = null;
      }
    } else {
      const fenceRun = getFenceRun(lineWithoutNewline);
      if (fenceRun) {
        result += line;
        fence = {
          marker: fenceRun[0] as '`' | '~',
          length: fenceRun.length,
        };
      } else {
        result += escapeMathDelimitersInLine(line);
      }
    }

    lineStart = lineEnd;
  }

  return result;
}

export function hasStreamingMathDelimiters(markdown: string): boolean {
  if (!markdown.includes('$')) {
    return false;
  }

  return escapeMathDelimitersForStreaming(markdown) !== markdown;
}
