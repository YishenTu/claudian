/**
 * Shared Obsidian-flavored Markdown segmentation for targeted source transforms.
 * Code, math, links, and raw HTML boundaries are owned here so consumers do not
 * maintain competing parsers or depend on internal segment state.
 */

import { parser } from '@lezer/markdown';

interface ProtectedBlock {
  end: number;
  infoStart?: number;
}

/** The block parser owns code and reference-definition boundaries, including container endings. */
function getProtectedBlocks(markdown: string, literalLinks: Array<{ from: number; to: number }>, preserveLiterals: boolean): Map<number, ProtectedBlock> {
  const blocks = new Map<number, ProtectedBlock>();
  parser.parse(markdown).iterate({
    enter(node) {
      if (node.name === 'Link' || node.name === 'Image') {
        if (preserveLiterals) {
          literalLinks.push({ from: node.from, to: node.to });
        } else {
          for (const name of ['URL', 'LinkTitle']) {
            const part = node.node.getChild(name);
            if (part) literalLinks.push({ from: part.from, to: part.to });
          }
        }
        return false;
      }
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock' && node.name !== 'LinkReference') return;
      const marker = node.name === 'FencedCode' ? node.node.getChild('CodeMark') : null;
      const lineStart = markdown.lastIndexOf('\n', node.from) + 1;
      let end = node.to;
      if (markdown.startsWith('\r\n', end)) end += 2;
      else if (markdown[end] === '\n') end += 1;
      blocks.set(lineStart, { end, infoStart: marker ? marker.to - lineStart : undefined });
      return false;
    },
  });
  return blocks;
}

type ContainerToken =
  | { type: 'blockquote' }
  | { type: 'list'; indent: number };

interface ParagraphContext {
  blockquoteDepth: number;
  listIndents: number[];
  containers: ContainerToken[];
}

interface InlineScan {
  codeBlocks: ReadonlyMap<number, ProtectedBlock>;
  dollarClosers?: Map<number, number[]>;
  paragraphEnds: Map<string, { start: number; end: number }>;
}

type ActiveListContext = Pick<ParagraphContext, 'blockquoteDepth' | 'listIndents'>;

interface MarkdownSegment {
  text: string;
  transformable: boolean;
  fence?: MarkdownFenceOpening;
  rawHtml?: boolean;
  sealed?: boolean;
  wikilink?: MarkdownWikilink;
}

export interface MarkdownFenceOpening {
  info: string;
  infoStart: number;
}

export interface MarkdownWikilink {
  embedded: boolean;
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

function startsNonParagraphBlock(content: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(content)
    || /^ {0,3}(?:=+|-+)[ \t]*$/.test(content)
    || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(content);
}

function startsInterruptingHTMLBlock(content: string): boolean {
  return RAW_HTML_TAG_PATTERN.test(content)
    || HTML_BLOCK_TAG_PATTERN.test(content)
    || /^ {0,3}(?:<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/.test(content);
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

export function isBackslashEscaped(text: string, index: number): boolean {
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

function appendFenceOpeningSegment(
  segments: MarkdownSegment[],
  line: string,
  lineWithoutNewline: string,
  infoStart: number,
): void {
  segments.push({
    text: line,
    transformable: false,
    fence: {
      info: lineWithoutNewline.slice(infoStart),
      infoStart,
    },
    sealed: true,
  });
}

function appendWikilinkSegment(
  segments: MarkdownSegment[],
  text: string,
  embedded: boolean,
): void {
  segments.push({
    text,
    transformable: false,
    wikilink: { embedded },
  });
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

/** Index closing runs once, so unmatched currency dollars do not rescan the suffix. */
function findIndexedDollarEnd(markdown: string, start: number, runLength: number, scan: InlineScan): number | null {
  if (runLength === 1 && !canOpenInlineMath(markdown, start)) return null;
  if (!scan.dollarClosers) {
    scan.dollarClosers = new Map([[1, []], [2, []]]);
    for (let index = markdown.indexOf('$'); index !== -1;) {
      if (isBackslashEscaped(markdown, index)) {
        index = markdown.indexOf('$', index + 1);
        continue;
      }
      const length = readDollarRun(markdown, index);
      if (length === 2 || length === 1 && canCloseInlineMath(markdown, index)) {
        scan.dollarClosers.get(length)!.push(index);
      }
      index = markdown.indexOf('$', index + length);
    }
  }
  const closers = scan.dollarClosers.get(runLength)!;
  let low = 0;
  let high = closers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (closers[middle] < start + runLength) low = middle + 1;
    else high = middle;
  }
  return low < closers.length ? closers[low] + runLength - 1 : null;
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
  scan: InlineScan,
): number {
  const key = context.containers.map(container => container.type === 'blockquote' ? '>' : container.indent).join(',');
  const cached = scan.paragraphEnds.get(key);
  if (cached && cached.start <= start && start <= cached.end) return cached.end;
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
      || scan.codeBlocks.has(nextLineStart)
      || startsNonParagraphBlock(blockContent)
      || startsInterruptingHTMLBlock(blockContent)
    ) {
      scan.paragraphEnds.set(key, { start, end: lineEnd });
      return lineEnd;
    }
    lineEnd = nextLineEnd;
  }
  scan.paragraphEnds.set(key, { start, end: markdown.length });
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
  let inAngleDestination = false;
  const destinationStart = start + 1 + (line.slice(start + 1).match(/^[ \t]*/)?.[0].length ?? 0);
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && line[index + 1]) {
      index += 1;
    } else if (inAngleDestination) {
      if (char === '>') inAngleDestination = false;
    } else if (index === destinationStart && char === '<') {
      inAngleDestination = true;
    } else if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if ((char === '"' || char === "'") && /\s/.test(line[index - 1] ?? '')) {
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
  if (!destination || /[\s<>]/.test(destination)) {
    return null;
  }

  const uri = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(destination);
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(destination);
  return uri || email ? end : null;
}

function isAtHTMLBlockStart(markdown: string, start: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', start - 1) + 1;
  return /^[ \t]*$/.test(parseContainerPrefix(markdown.slice(lineStart, start)).content);
}

function findHTMLEnd(line: string, start: number): number | null {
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
      return isAtHTMLBlockStart(line, start) ? line.length - 1 : null;
    }
  }

  if (line.startsWith('<!', start) && /[A-Za-z]/.test(line[start + 2] ?? '')) {
    const end = line.indexOf('>', start + 3);
    if (end !== -1) {
      return end;
    }
    return isAtHTMLBlockStart(line, start) ? line.length - 1 : null;
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
  scan: InlineScan,
  preserveLiterals: boolean,
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
        const inlineBlockEnd = findInlineBlockEnd(markdown, lineStart + index, context, scan);
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
        const sourceEnd = findIndexedDollarEnd(markdown, lineStart + index, runLength, scan);
        if (sourceEnd !== null && sourceEnd < lineStart + line.length) {
          const end = sourceEnd - lineStart;
          appendSegment(segments, line.slice(segmentStart, index), true);
          appendSegment(segments, line.slice(index, end + 1), !preserveLiterals);
          segmentStart = end + 1;
          index = end;
        } else {
          const mathEnd = runLength === 1
            ? findInlineBlockEnd(markdown, lineStart + index, context, scan)
            : markdown.length;
          if (sourceEnd !== null && sourceEnd - runLength + 1 < mathEnd) {
            appendSegment(segments, line.slice(segmentStart, index), true);
            appendSegment(segments, line.slice(index), !preserveLiterals);
            return { mathRunLength: runLength };
          }
          index += runLength - 1;
        }
        continue;
      }
      index += runLength - 1;
      continue;
    }

    const embeddedWikilink = char === '!' && !isBackslashEscaped(line, index) && line.startsWith('![[', index);
    if (embeddedWikilink || char === '[') {
      const wikilinkStart = embeddedWikilink ? index + 1 : index;
      const wikilinkEnd = findWikilinkEnd(line, wikilinkStart);
      if (wikilinkEnd !== null) {
        appendSegment(segments, line.slice(segmentStart, index), true);
        appendWikilinkSegment(
          segments,
          line.slice(index, wikilinkEnd + 1),
          embeddedWikilink,
        );
        segmentStart = wikilinkEnd + 1;
        index = wikilinkEnd;
      } else if (char === '[' && !isBackslashEscaped(line, index)) {
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

      const sourceHtmlEnd = findHTMLEnd(markdown, lineStart + index);
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

function splitMarkdown(markdown: string, literalLinks: Array<{ from: number; to: number }>, preserveLiterals: boolean): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const codeBlocks = getProtectedBlocks(markdown, literalLinks, preserveLiterals);
  const scan: InlineScan = { codeBlocks, paragraphEnds: new Map() };
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
    const codeBlock = codeBlocks.get(lineStart);
    // HTML continuation guesses cannot absorb blocks recognized by the parser.
    if (codeBlock) {
      inlineHtmlEnd = null;
      rawHtmlTag = null;
    }

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
          scan,
          preserveLiterals,
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
        appendSegment(segments, line, !preserveLiterals);
      } else {
        appendSegment(segments, line.slice(0, mathEnd + 1), !preserveLiterals);
        const remainder = line.slice(mathEnd + 1);
        const continuation = splitInlineMarkdown(
          markdown,
          remainder,
          lineStart + mathEnd + 1,
          paragraphContext ?? { blockquoteDepth: 0, listIndents: [], containers: [] },
          segments,
          scan,
          preserveLiterals,
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
          scan,
          preserveLiterals,
        );
        inlineCodeRunLength = continuation.codeRunLength ?? null;
        inlineHtmlEnd = continuation.htmlEnd ?? null;
        inlineMathRunLength = continuation.mathRunLength ?? null;
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

    if (codeBlock) {
      paragraphContext = null;
      if (codeBlock.infoStart === undefined) {
        appendSegment(segments, line, false);
      } else {
        appendFenceOpeningSegment(segments, line, lineWithoutNewline, codeBlock.infoStart);
      }
      appendSegment(segments, markdown.slice(lineEnd, codeBlock.end), false);
      sealLastSegment(segments);
      lineStart = codeBlock.end;
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
      scan,
      preserveLiterals,
    );
    inlineCodeRunLength = continuation.codeRunLength ?? null;
    inlineHtmlEnd = continuation.htmlEnd ?? null;
    inlineMathRunLength = continuation.mathRunLength ?? null;
    paragraphContext = startsNonParagraphBlock(blockContent)
      || startsInterruptingHTMLBlock(blockContent)
      ? null
      : currentContext;
    lineStart = lineEnd;
  }

  return segments;
}

interface MarkdownTransforms {
  /** Keep recognized math and complete links literal while transforming surrounding prose. */
  preserveLiterals?: boolean;
  fence?: (opener: string, fence: MarkdownFenceOpening) => string;
  text?: (text: string) => string;
  rawHtml?: (text: string) => string;
  wikilink?: (wikilink: string, metadata: MarkdownWikilink) => string;
}

/** Applies targeted transforms while preserving protected Markdown syntax. */
export function transformMarkdownSegments(
  markdown: string,
  transforms: MarkdownTransforms,
): string {
  const literalLinks: Array<{ from: number; to: number }> = [];
  let offset = 0;
  let nextLink = 0;
  return splitMarkdown(markdown, literalLinks, transforms.preserveLiterals === true)
    .map(segment => {
      const start = offset;
      offset += segment.text.length;
      const { fence, wikilink, rawHtml, transformable } = segment;
      const transform = fence
        ? (text: string) => transforms.fence?.(text, fence) ?? text
        : wikilink
          ? (text: string) => transforms.wikilink?.(text, wikilink) ?? text
          : rawHtml ? transforms.rawHtml : transformable ? transforms.text : undefined;
      if (transform) {
        if (literalLinks.length === 0) return transform(segment.text);
        while (nextLink < literalLinks.length && literalLinks[nextLink].to <= start) nextLink++;
        let cursor = start;
        const parts: string[] = [];
        while (nextLink < literalLinks.length && literalLinks[nextLink].from < offset) {
          const link = literalLinks[nextLink];
          const before = markdown.slice(cursor, Math.max(cursor, link.from));
          parts.push(transform(before));
          const end = Math.min(offset, link.to);
          parts.push(markdown.slice(Math.max(cursor, link.from), end));
          cursor = end;
          if (link.to > offset) break;
          nextLink++;
        }
        const tail = markdown.slice(cursor, offset);
        parts.push(transform(tail));
        return parts.join('');
      }
      return segment.text;
    })
    .join('');
}
