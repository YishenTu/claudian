import { escapeHtml } from './html';

interface FenceState {
  marker: '`' | '~';
  length: number;
  containers: ContainerToken[];
}

interface FenceRun {
  run: string;
  containers: ContainerToken[];
}

type ContainerToken =
  | { type: 'blockquote' }
  | { type: 'list'; indent: number };

interface ParagraphContext {
  blockquoteDepth: number;
  listIndents: number[];
  containers: ContainerToken[];
}

type ActiveListContext = Pick<ParagraphContext, 'blockquoteDepth' | 'listIndents'>;

interface MarkdownSegment {
  text: string;
  transformable: boolean;
  rawHtml?: boolean;
  sealed?: boolean;
}

interface InlineContinuation {
  codeRunLength?: number;
  htmlEnd?: number;
  mathRunLength?: number;
}

const RAW_HTML_TAG_PATTERN = /^ {0,3}<(pre|script|style|textarea)(?=[\t >]|$)/i;
const HTML_BLOCK_TAG_PATTERN = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\t />]|$)/i;

function parseContainerPrefix(line: string): {
  content: string;
  containers: ContainerToken[];
} {
  let content = line;
  const containers: ContainerToken[] = [];
  while (content) {
    const quoteMatch = content.match(/^ {0,3}>[ \t]?/);
    if (quoteMatch) {
      content = content.slice(quoteMatch[0].length);
      containers.push({ type: 'blockquote' });
      continue;
    }

    const listMatch = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/);
    if (listMatch) {
      content = content.slice(listMatch[0].length);
      containers.push({ type: 'list', indent: listMatch[0].length });
      continue;
    }

    break;
  }
  return { content, containers };
}

function parseBlockQuotePrefix(line: string): {
  content: string;
  depth: number;
} {
  let content = line;
  let depth = 0;
  let quoteMatch = content.match(/^ {0,3}>[ \t]?/);
  while (quoteMatch) {
    content = content.slice(quoteMatch[0].length);
    depth += 1;
    quoteMatch = content.match(/^ {0,3}>[ \t]?/);
  }
  return { content, depth };
}

function parseListPrefix(line: string): {
  content: string;
  indents: number[];
} {
  let content = line;
  const indents: number[] = [];
  let listMatch = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/);
  while (listMatch) {
    content = content.slice(listMatch[0].length);
    indents.push(listMatch[0].length);
    listMatch = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/);
  }
  return { content, indents };
}

function consumeListContinuation(line: string, indents: number[]): string | null {
  let content = line;
  for (const indent of indents) {
    const leadingSpaces = content.match(/^ */)?.[0].length ?? 0;
    if (leadingSpaces < indent) {
      return null;
    }
    content = content.slice(indent);
  }
  return content;
}

function hasSameParagraphContext(
  current: ParagraphContext | null,
  candidate: ParagraphContext,
): boolean {
  return current?.blockquoteDepth === candidate.blockquoteDepth
    && current.listIndents.length === candidate.listIndents.length
    && current.listIndents.every((indent, index) => indent === candidate.listIndents[index]);
}

function getFenceRun(line: string): FenceRun | null {
  const { content, containers } = parseContainerPrefix(line);
  return getFenceRunFromContent(content, containers);
}

function getFenceRunFromContent(
  content: string,
  containers: ContainerToken[],
): FenceRun | null {
  const match = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const run = match?.[1] ?? null;
  if (!run || (run[0] === '`' && match?.[2].includes('`'))) {
    return null;
  }
  return { run, containers };
}

function getContextContainers(context: ParagraphContext): ContainerToken[] {
  return [
    ...Array.from(
      { length: context.blockquoteDepth },
      (): ContainerToken => ({ type: 'blockquote' }),
    ),
    ...context.listIndents.map(
      (indent): ContainerToken => ({ type: 'list', indent }),
    ),
  ];
}

function startsNonParagraphBlock(content: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(content)
    || /^ {0,3}(?:=+|-+)[ \t]*$/.test(content)
    || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(content);
}

function startsInterruptingHtmlBlock(content: string): boolean {
  return RAW_HTML_TAG_PATTERN.test(content)
    || HTML_BLOCK_TAG_PATTERN.test(content)
    || /^ {0,3}(?:<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/.test(content);
}

function isClosingFence(line: string, fence: FenceState): boolean {
  let content = line;
  for (const container of fence.containers) {
    if (container.type === 'blockquote') {
      const quoteMatch = content.match(/^ {0,3}>[ \t]?/);
      if (!quoteMatch) {
        return false;
      }
      content = content.slice(quoteMatch[0].length);
    } else {
      const indentation = content.match(/^ */)?.[0].length ?? 0;
      if (indentation < container.indent) {
        return false;
      }
      content = content.slice(container.indent);
    }
  }

  const match = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
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

function readDollarRun(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === '$') {
    length += 1;
  }
  return length;
}

function canOpenInlineMath(text: string, index: number): boolean {
  return !!text[index + 1] && !/\s/.test(text[index + 1]);
}

function canCloseInlineMath(text: string, index: number): boolean {
  return !!text[index - 1]
    && !/\s/.test(text[index - 1])
    && (!text[index + 1] || !/\d/.test(text[index + 1]));
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
  rawHtml = false,
): void {
  if (!text) {
    return;
  }

  const previous = segments[segments.length - 1];
  if (
    previous?.transformable === transformable
    && previous.rawHtml === rawHtml
    && !previous.sealed
  ) {
    previous.text += text;
  } else {
    segments.push({ text, transformable, rawHtml });
  }
}

function sealLastSegment(segments: MarkdownSegment[]): void {
  const previous = segments[segments.length - 1];
  if (previous) {
    previous.sealed = true;
  }
}

function findMatchingBacktickRun(
  line: string,
  start: number,
  runLength: number,
  end = line.length,
): number | null {
  for (let index = start + runLength; index < end; index += 1) {
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

function findMatchingDollarRun(
  text: string,
  start: number,
  runLength: number,
  end = text.length,
): number | null {
  if (
    runLength === 1
    && start >= 0
    && !canOpenInlineMath(text, start)
  ) {
    return null;
  }

  for (let index = start + runLength; index < end; index += 1) {
    if (text[index] !== '$' || isBackslashEscaped(text, index)) {
      continue;
    }

    const candidateLength = readDollarRun(text, index);
    const hasValidInlineBoundary = runLength !== 1 || canCloseInlineMath(text, index);
    if (candidateLength === runLength && hasValidInlineBoundary) {
      return index + runLength - 1;
    }
    index += candidateLength - 1;
  }
  return null;
}

function getParagraphContinuationContent(
  line: string,
  context: ParagraphContext,
): string | null {
  let content = line;
  for (const container of context.containers) {
    if (container.type === 'blockquote') {
      const quoteMatch = content.match(/^ {0,3}>[ \t]?/);
      if (!quoteMatch) {
        return null;
      }
      content = content.slice(quoteMatch[0].length);
      continue;
    }

    const indentation = content.match(/^ */)?.[0].length ?? 0;
    if (indentation < container.indent) {
      return null;
    }
    content = content.slice(container.indent);
  }

  return parseContainerPrefix(content).containers.length > 0 ? null : content;
}

function findInlineBlockEnd(
  markdown: string,
  start: number,
  context: ParagraphContext,
): number {
  let lineEnd = markdown.indexOf('\n', start);
  while (lineEnd !== -1) {
    const nextLineStart = lineEnd + 1;
    const nextLineEnd = markdown.indexOf('\n', nextLineStart);
    const nextLine = markdown.slice(
      nextLineStart,
      nextLineEnd === -1 ? markdown.length : nextLineEnd,
    );
    const blockContent = getParagraphContinuationContent(nextLine, context);
    if (
      blockContent === null
      || /^[ \t\r]*$/.test(blockContent)
      || getFenceRun(nextLine) !== null
      || startsNonParagraphBlock(blockContent)
      || startsInterruptingHtmlBlock(blockContent)
    ) {
      return lineEnd;
    }
    lineEnd = nextLineEnd;
  }
  return markdown.length;
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

function isAtHtmlBlockStart(markdown: string, start: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', start - 1) + 1;
  return /^[ \t]*$/.test(parseContainerPrefix(markdown.slice(lineStart, start)).content);
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
      if (end !== -1) {
        return end + closer.length - 1;
      }
      return isAtHtmlBlockStart(line, start) ? line.length - 1 : null;
    }
  }

  if (line.startsWith('<!', start) && /[A-Za-z]/.test(line[start + 2] ?? '')) {
    const end = line.indexOf('>', start + 3);
    if (end !== -1) {
      return end;
    }
    return isAtHtmlBlockStart(line, start) ? line.length - 1 : null;
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

function splitInlineMarkdown(
  markdown: string,
  line: string,
  lineStart: number,
  context: ParagraphContext,
  segments: MarkdownSegment[],
): InlineContinuation {
  let segmentStart = 0;
  let bracketDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '`' && !isBackslashEscaped(line, index)) {
      const runLength = readBacktickRun(line, index);
      const end = findMatchingBacktickRun(line, index, runLength);
      if (end !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendSegment(segments, line.slice(index, end + 1), false);
        segmentStart = end + 1;
        index = end;
      } else {
        const inlineBlockEnd = findInlineBlockEnd(markdown, lineStart + index, context);
        const sourceEnd = findMatchingBacktickRun(
          markdown,
          lineStart + index,
          runLength,
          inlineBlockEnd,
        );
        if (sourceEnd !== null && sourceEnd >= lineStart + line.length) {
          appendSegment(segments, line.slice(segmentStart, index), true);
          appendSegment(segments, line.slice(index), false);
          return { codeRunLength: runLength };
        }
        index += runLength - 1;
      }
      continue;
    }

    if (char === '$' && !isBackslashEscaped(line, index)) {
      const runLength = readDollarRun(line, index);
      if (runLength <= 2) {
        const end = findMatchingDollarRun(line, index, runLength);
        if (end !== null) {
          appendSegment(segments, line.slice(segmentStart, index), true);
          appendSegment(segments, line.slice(index, end + 1), true);
          segmentStart = end + 1;
          index = end;
        } else {
          const mathEnd = runLength === 1
            ? findInlineBlockEnd(markdown, lineStart + index, context)
            : markdown.length;
          const sourceEnd = findMatchingDollarRun(
            markdown,
            lineStart + index,
            runLength,
            mathEnd,
          );
          if (sourceEnd !== null && sourceEnd >= lineStart + line.length) {
            appendSegment(segments, line.slice(segmentStart, index), true);
            appendSegment(segments, line.slice(index), true);
            return { mathRunLength: runLength };
          }
          index += runLength - 1;
        }
        continue;
      }
      index += runLength - 1;
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

    if (char === '<' && !isBackslashEscaped(line, index)) {
      const autolinkEnd = findAutolinkEnd(line, index);
      if (autolinkEnd !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendSegment(segments, line.slice(index, autolinkEnd + 1), false);
        segmentStart = autolinkEnd + 1;
        index = autolinkEnd;
        continue;
      }

      const sourceHtmlEnd = findHtmlEnd(markdown, lineStart + index);
      const htmlEnd = sourceHtmlEnd === null ? null : sourceHtmlEnd - lineStart;
      if (htmlEnd !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        if (htmlEnd >= line.length) {
          appendSegment(segments, line.slice(index), false, true);
          return { htmlEnd: sourceHtmlEnd ?? undefined };
        }
        appendSegment(segments, line.slice(index, htmlEnd + 1), false, true);
        segmentStart = htmlEnd + 1;
        index = htmlEnd;
      }
    }
  }

  appendSegment(segments, line.slice(segmentStart), true);
  return {};
}

function splitMarkdown(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let fence: FenceState | null = null;
  let rawHtmlTag: string | null = null;
  let inlineCodeRunLength: number | null = null;
  let inlineHtmlEnd: number | null = null;
  let inlineMathRunLength: number | null = null;
  let paragraphContext: ParagraphContext | null = null;
  let activeListContext: ActiveListContext | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const lineWithoutNewline = line.replace(/\r?\n$/, '');

    if (inlineCodeRunLength !== null) {
      const codeEnd = findMatchingBacktickRun(line, -inlineCodeRunLength, inlineCodeRunLength);
      if (codeEnd === null) {
        appendSegment(segments, line, false);
      } else {
        appendSegment(segments, line.slice(0, codeEnd + 1), false);
        const remainder = line.slice(codeEnd + 1);
        const continuation = splitInlineMarkdown(
          markdown,
          remainder,
          lineStart + codeEnd + 1,
          paragraphContext ?? { blockquoteDepth: 0, listIndents: [], containers: [] },
          segments,
        );
        inlineCodeRunLength = continuation.codeRunLength ?? null;
        inlineHtmlEnd = continuation.htmlEnd ?? null;
        inlineMathRunLength = continuation.mathRunLength ?? null;
      }
      lineStart = lineEnd;
      continue;
    }

    if (inlineMathRunLength !== null) {
      const mathEnd = findMatchingDollarRun(line, -inlineMathRunLength, inlineMathRunLength);
      if (mathEnd === null) {
        appendSegment(segments, line, true);
      } else {
        appendSegment(segments, line.slice(0, mathEnd + 1), true);
        const remainder = line.slice(mathEnd + 1);
        const continuation = splitInlineMarkdown(
          markdown,
          remainder,
          lineStart + mathEnd + 1,
          paragraphContext ?? { blockquoteDepth: 0, listIndents: [], containers: [] },
          segments,
        );
        inlineCodeRunLength = continuation.codeRunLength ?? null;
        inlineHtmlEnd = continuation.htmlEnd ?? null;
        inlineMathRunLength = continuation.mathRunLength ?? null;
      }
      lineStart = lineEnd;
      continue;
    }

    if (inlineHtmlEnd !== null) {
      if (inlineHtmlEnd >= lineEnd) {
        appendSegment(segments, line, false, true);
      } else {
        const localEnd = inlineHtmlEnd - lineStart;
        appendSegment(segments, line.slice(0, localEnd + 1), false, true);
        const remainder = line.slice(localEnd + 1);
        const continuation = splitInlineMarkdown(
          markdown,
          remainder,
          lineStart + localEnd + 1,
          paragraphContext ?? { blockquoteDepth: 0, listIndents: [], containers: [] },
          segments,
        );
        inlineCodeRunLength = continuation.codeRunLength ?? null;
        inlineHtmlEnd = continuation.htmlEnd ?? null;
        inlineMathRunLength = continuation.mathRunLength ?? null;
      }
      lineStart = lineEnd;
      continue;
    }

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
      appendSegment(segments, line, false, true);
      if (new RegExp(`<\\/${rawHtmlTag}>`, 'i').test(lineWithoutNewline)) {
        rawHtmlTag = null;
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    const blockQuote = parseBlockQuotePrefix(lineWithoutNewline);
    const listPrefix = parseListPrefix(blockQuote.content);
    let blockContent = listPrefix.content;
    let listIndents = listPrefix.indents;

    if (listIndents.length > 0) {
      activeListContext = {
        blockquoteDepth: blockQuote.depth,
        listIndents,
      };
    } else if (activeListContext?.blockquoteDepth === blockQuote.depth) {
      const continuation = consumeListContinuation(
        blockQuote.content,
        activeListContext.listIndents,
      );
      if (continuation !== null) {
        blockContent = continuation;
        listIndents = activeListContext.listIndents;
      } else if (!/^[ \t]*$/.test(blockQuote.content)) {
        activeListContext = null;
      }
    } else if (!/^[ \t]*$/.test(blockQuote.content)) {
      activeListContext = null;
    }

    const currentContext: ParagraphContext = {
      blockquoteDepth: blockQuote.depth,
      listIndents,
      containers: listIndents.length > 0 && listPrefix.indents.length === 0
        ? [
          ...Array.from(
            { length: blockQuote.depth },
            (): ContainerToken => ({ type: 'blockquote' }),
          ),
          ...listIndents.map(
            (indent): ContainerToken => ({ type: 'list', indent }),
          ),
        ]
        : parseContainerPrefix(lineWithoutNewline).containers,
    };

    if (/^[ \t]*$/.test(blockContent)) {
      paragraphContext = null;
      appendSegment(segments, line, true);
      sealLastSegment(segments);
      lineStart = lineEnd;
      continue;
    }

    const contextualFenceRun = listIndents.length > 0 && listPrefix.indents.length === 0
      ? getFenceRunFromContent(blockContent, getContextContainers(currentContext))
      : null;
    const fenceRun = contextualFenceRun ?? getFenceRun(lineWithoutNewline);
    if (fenceRun) {
      paragraphContext = null;
      appendSegment(segments, line, false);
      fence = {
        marker: fenceRun.run[0] as '`' | '~',
        length: fenceRun.run.length,
        containers: fenceRun.containers,
      };
      lineStart = lineEnd;
      continue;
    }

    if (/^(?: {4}|\t)/.test(blockContent)) {
      if (hasSameParagraphContext(paragraphContext, currentContext)) {
        const continuation = splitInlineMarkdown(
          markdown,
          line,
          lineStart,
          currentContext,
          segments,
        );
        inlineCodeRunLength = continuation.codeRunLength ?? null;
        inlineHtmlEnd = continuation.htmlEnd ?? null;
        inlineMathRunLength = continuation.mathRunLength ?? null;
      } else {
        appendSegment(segments, line, false);
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    const rawHtmlMatch = lineWithoutNewline.match(RAW_HTML_TAG_PATTERN);
    if (rawHtmlMatch) {
      paragraphContext = null;
      appendSegment(segments, line, false, true);
      const tag = rawHtmlMatch[1].toLowerCase();
      if (!new RegExp(`<\\/${tag}>`, 'i').test(lineWithoutNewline)) {
        rawHtmlTag = tag;
      } else {
        sealLastSegment(segments);
      }
      lineStart = lineEnd;
      continue;
    }

    const continuation = splitInlineMarkdown(
      markdown,
      line,
      lineStart,
      currentContext,
      segments,
    );
    inlineCodeRunLength = continuation.codeRunLength ?? null;
    inlineHtmlEnd = continuation.htmlEnd ?? null;
    inlineMathRunLength = continuation.mathRunLength ?? null;
    paragraphContext = startsNonParagraphBlock(blockContent)
      || startsInterruptingHtmlBlock(blockContent)
      ? null
      : currentContext;
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

/** Escapes raw HTML while preserving Markdown code spans, code blocks, and autolinks. */
export function escapeRawHtmlTags(markdown: string): string {
  if (!markdown.includes('<')) {
    return markdown;
  }

  return splitMarkdown(markdown)
    .map(segment => segment.rawHtml ? escapeHtml(segment.text) : segment.text)
    .join('');
}

export function hasStreamingMathDelimiters(markdown: string): boolean {
  if (!markdown.includes('$') && !markdown.includes('\\')) {
    return false;
  }

  const normalized = normalizeLatexMathDelimiters(markdown);
  return escapeMathDelimitersForStreaming(normalized) !== normalized;
}
