import {
  isBackslashEscaped,
  transformMarkdownSegments,
} from './markdownSegments';

function trimInlineBoundarySpaces(
  text: string,
  contentStart: number,
  contentEnd: number,
  removals: Set<number>,
): void {
  const isOrdinaryBoundarySpace = (position: number): boolean =>
    (text[position] === ' ' || text[position] === '\t')
    && !isBackslashEscaped(text, position);

  let start = contentStart;
  let end = contentEnd;
  while (start < end && isOrdinaryBoundarySpace(start)) start += 1;
  while (end > start && isOrdinaryBoundarySpace(end - 1)) end -= 1;

  // Empty or genuinely whitespace-only expressions keep their original padding.
  if (start >= end || /^\s*$/.test(text.slice(start, end))) return;

  for (let position = contentStart; position < start; position += 1) {
    removals.add(position);
  }
  for (let position = end; position < contentEnd; position += 1) {
    removals.add(position);
  }
}

function normalizeLatexMathInText(text: string): string {
  const openers = new Map<'inline' | 'display', number>();
  const replacements = new Map<number, string>();
  const removals = new Set<number>();

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
        if (kind === 'inline') {
          trimInlineBoundarySpaces(text, opener + 2, index, removals);
        }
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
    } else if (!removals.has(index)) {
      normalized += text[index];
    }
  }
  return normalized;
}

/** Converts matched LaTeX math delimiters to Obsidian's dollar delimiters. */
export function normalizeLatexMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) {
    return markdown;
  }

  return transformMarkdownSegments(markdown, { text: normalizeLatexMathInText });
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

  return transformMarkdownSegments(markdown, { text: escapeMathDelimitersInText });
}

export function hasStreamingMathDelimiters(markdown: string): boolean {
  if (!markdown.includes('$') && !markdown.includes('\\')) {
    return false;
  }

  const normalized = normalizeLatexMathDelimiters(markdown);
  return escapeMathDelimitersForStreaming(normalized) !== normalized;
}
