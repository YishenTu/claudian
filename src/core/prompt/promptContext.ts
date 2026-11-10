/**
 * Claudian - Context Utilities
 *
 * Note and context file formatting for prompts.
 */

import { parser } from '@lezer/markdown';

import type { ProviderExecutionContext, ProviderSessionReference } from '@/core/execution/ProviderExecutionRequest';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';

import { appendBrowserContext } from './browserContext';
import { appendCanvasContext } from './canvasContext';
import { appendEditorContext } from './editorContext';
import { escapePromptXMLAttribute } from './promptXML';

const LINKED_CONTENT_TAG = 'linked_content';

/**
 * Pattern to match XML context tags appended to prompts.
 * These tags are always preceded by \n\n separator.
 * Matches: linked_note/current_note, editor_selection (with attributes), editor_cursor (with attributes),
 * context_files, canvas_selection, browser_selection
 */
const XML_CONTEXT_PATTERN = /\n\n<(?:linked_content|linked_note|current_note|editor_selection|editor_cursor|context_files|context_sessions|canvas_selection|browser_selection)[\s>]/;
const BRACKET_CONTEXT_PATTERN = /\n\[(?:Current note|Editor selection from|Browser selection from|Canvas selection from)\b/;

/** Indented code and closed inline/fenced literals protect examples; unclosed fences stay unchanged. */
function getCodeLiteralRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  parser.parse(text).iterate({
    enter(node) {
      if (node.name !== 'InlineCode' && node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
      if (node.name === 'CodeBlock' || node.node.getChildren('CodeMark').length === 2) ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return ranges;
}

function findContextBoundary(text: string, pattern: RegExp): number {
  let ranges: ReturnType<typeof getCodeLiteralRanges> | undefined;
  for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
    ranges ??= getCodeLiteralRanges(text);
    if (!ranges.some(range => match.index < range.to && match.index + match[0].length > range.from)) return match.index;
  }
  return -1;
}

/** Keep literal openers searchable without hiding a later real context match. */
function stripContextOutsideCode(text: string, pattern: RegExp): string {
  let match = pattern.exec(text);
  if (!match) return text;
  const ranges = getCodeLiteralRanges(text);
  let result = '';
  let cursor = 0;
  while (match) {
    const index = match.index;
    if (ranges.some(range => index >= range.from && index < range.to)) {
      // A literal opener's match may include a real outside closer; retry from the next character.
      pattern.lastIndex = match.index + 1;
    } else {
      result += text.slice(cursor, match.index);
      cursor = pattern.lastIndex;
    }
    match = pattern.exec(text);
  }
  return result + text.slice(cursor);
}

export function formatLinkedContent(contentPath: string): string {
  return `<${LINKED_CONTENT_TAG} path="${escapePromptXMLAttribute(contentPath)}" />`;
}

/** Captured context suffix of a native prompt, using the same boundary as its user text. */
export function extractUserPromptContext(text: string): string {
  const boundary = findContextBoundary(text, XML_CONTEXT_PATTERN);
  return boundary < 0 ? '' : text.slice(boundary).trim();
}

/**
 * Extracts user content that appears before XML context tags.
 * User content comes first, with context XML appended after.
 */
function extractContentBeforeXMLContext(text: string): string | undefined {
  if (!text) return undefined;

  // Current format: user content before any XML context tags
  // Context tags are always appended with \n\n separator
  const boundary = findContextBoundary(text, XML_CONTEXT_PATTERN);
  if (boundary >= 0) return text.substring(0, boundary).trim();

  return undefined;
}

/** The text a user message shows: its display text, else its content without injected context. */
export function getUserDisplayText(message: { content: string; displayContent?: string }): string {
  return message.displayContent ?? extractUserDisplayContent(message.content) ?? message.content;
}

export function extractUserDisplayContent(text: string): string | undefined {
  if (!text) return undefined;

  const sessionMessage = decodeSessionMessage(text);
  if (sessionMessage) return sessionMessage.text;

  const xmlDisplayContent = extractContentBeforeXMLContext(text);
  if (xmlDisplayContent !== undefined) {
    return xmlDisplayContent;
  }

  const boundary = findContextBoundary(text, BRACKET_CONTEXT_PATTERN);
  if (boundary >= 0) return text.substring(0, boundary).trim();

  return undefined;
}

/**
 * Extracts the actual user query from an XML-wrapped prompt.
 * Used for comparing prompts during history deduplication.
 *
 * Always returns a string - falls back to stripping all XML tags if no
 * structured context is found.
 */
export function extractUserQuery(prompt: string): string {
  if (!prompt) return '';

  // Match the live display body, which is compared against this native form.
  const sessionMessage = decodeSessionMessage(prompt);
  if (sessionMessage) return extractUserQuery(sessionMessage.text);

  // Try to extract content before XML context
  const extracted = extractContentBeforeXMLContext(prompt);
  if (extracted !== undefined) {
    return extracted;
  }

  // No XML context - return the whole prompt stripped of any remaining tags
  let query = prompt;
  for (const pattern of [
    /<(?:linked_content|linked_note|current_note)(?:\s[^>]*)?\s*\/>\s*/g,
    /<(linked_content|linked_note|current_note)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/g,
    /<editor_selection[\s\S]*?<\/editor_selection>\s*/g,
    /<editor_cursor[\s\S]*?<\/editor_cursor>\s*/g,
    /<context_sessions>[\s\S]*?<\/context_sessions>\s*/g,
    /<context_files>[\s\S]*?<\/context_files>\s*/g,
    /<canvas_selection[\s\S]*?<\/canvas_selection>\s*/g,
    /<browser_selection[\s\S]*?<\/browser_selection>\s*/g,
  ]) query = stripContextOutsideCode(query, pattern);
  return query.trim();
}

function formatContextFilesLine(files: string[]): string {
  const entries = files
    .map(file => `<context_file path="${escapePromptXMLAttribute(file)}" />`)
    .join('\n');
  return `<context_files>\n${entries}\n</context_files>`;
}

export function appendContextFiles(prompt: string, files: string[]): string {
  return `${prompt}\n\n${formatContextFilesLine(files)}`;
}

function appendSessionReferences(
  prompt: string,
  references?: readonly ProviderSessionReference[],
): string {
  if (!references?.length) return prompt;
  const entries = references.map(reference => {
    const attributes = {
      title: reference.title, id: reference.id, provider: reference.providerId,
      updated: reference.updatedAt,
    };
    return `<context_session ${Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapePromptXMLAttribute(value)}"`).join(' ')} />`;
  });
  return `${prompt}\n\n<context_sessions>\n${entries.join('\n')}\n</context_sessions>`;
}

function appendSelectionContexts(prompt: string, context?: ProviderExecutionContext): string {
  for (const snapshot of context?.selections ?? []) {
    switch (snapshot.kind) {
      case 'editor':
        prompt = appendEditorContext(prompt, snapshot.selection);
        break;
      case 'browser':
        prompt = appendBrowserContext(prompt, snapshot.selection);
        break;
      case 'canvas':
        prompt = appendCanvasContext(prompt, snapshot.selection);
        break;
    }
  }
  return prompt;
}

/**
 * Appends a request's captured context in the order every provider sends it:
 * Linked content, selections, then session references.
 */
export function appendExecutionContext(prompt: string, context?: ProviderExecutionContext): string {
  if (context?.linkedContent) {
    prompt = `${prompt}\n\n${formatLinkedContent(context.linkedContent.path)}`;
  }
  return appendSessionReferences(appendSelectionContexts(prompt, context), context?.sessionReferences);
}
