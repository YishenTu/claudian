/**
 * Claudian - Context Utilities
 *
 * Note and context file formatting for prompts.
 */

import type { ProviderExecutionContext, ProviderSelectionSnapshot, ProviderSessionReference } from '@/core/execution/ProviderExecutionRequest';

import { appendBrowserContext } from './browserContext';
import { appendCanvasContext } from './canvasContext';
import { appendEditorContext } from './editorContext';
import { escapePromptXMLAttribute, formatPromptXMLCdata } from './promptXML';

const LINKED_CONTENT_TAG = 'linked_content';

/**
 * Pattern to match XML context tags appended to prompts.
 * These tags are always preceded by \n\n separator.
 * Matches: linked_note/current_note, editor_selection (with attributes), editor_cursor (with attributes),
 * context_files, canvas_selection, browser_selection
 */
const XML_CONTEXT_PATTERN = /\n\n<(?:linked_content|linked_note|current_note|editor_selection|editor_cursor|context_files|context_sessions|canvas_selection|browser_selection)[\s>]/;
const BRACKET_CONTEXT_PATTERN = /\n\[(?:Current note|Editor selection from|Browser selection from|Canvas selection from)\b/;

export function formatLinkedContent(contentPath: string): string {
  return `<${LINKED_CONTENT_TAG} path="${escapePromptXMLAttribute(contentPath)}" />`;
}

export function appendLinkedContent(prompt: string, contentPath: string): string {
  return `${prompt}\n\n${formatLinkedContent(contentPath)}`;
}

export function formatLinkedContentBody(contentPath: string, content: string): string {
  return `<${LINKED_CONTENT_TAG} path="${escapePromptXMLAttribute(contentPath)}">\n${formatPromptXMLCdata(
    content,
  )}\n</${LINKED_CONTENT_TAG}>`;
}

export function appendLinkedContentBody(
  prompt: string,
  contentPath: string,
  content: string,
): string {
  return `${prompt}\n\n${formatLinkedContentBody(contentPath, content)}`;
}

/**
 * Extracts user content that appears before XML context tags.
 * User content comes first, with context XML appended after.
 */
function extractContentBeforeXMLContext(text: string): string | undefined {
  if (!text) return undefined;

  // Current format: user content before any XML context tags
  // Context tags are always appended with \n\n separator
  const xmlMatch = text.match(XML_CONTEXT_PATTERN);
  if (xmlMatch?.index !== undefined) {
    return text.substring(0, xmlMatch.index).trim();
  }

  return undefined;
}

export function extractUserDisplayContent(text: string): string | undefined {
  if (!text) return undefined;

  const xmlDisplayContent = extractContentBeforeXMLContext(text);
  if (xmlDisplayContent !== undefined) {
    return xmlDisplayContent;
  }

  const bracketMatch = text.match(BRACKET_CONTEXT_PATTERN);
  if (bracketMatch?.index !== undefined) {
    return text.substring(0, bracketMatch.index).trim();
  }

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

  // Try to extract content before XML context
  const extracted = extractContentBeforeXMLContext(prompt);
  if (extracted !== undefined) {
    return extracted;
  }

  // No XML context - return the whole prompt stripped of any remaining tags
  return prompt
    .replace(/<(?:linked_content|linked_note|current_note)(?:\s[^>]*)?\s*\/>\s*/g, '')
    .replace(/<(linked_content|linked_note|current_note)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/g, '')
    .replace(/<editor_selection[\s\S]*?<\/editor_selection>\s*/g, '')
    .replace(/<editor_cursor[\s\S]*?<\/editor_cursor>\s*/g, '')
    .replace(/<context_sessions>[\s\S]*?<\/context_sessions>\s*/g, '')
    .replace(/<context_files>[\s\S]*?<\/context_files>\s*/g, '')
    .replace(/<canvas_selection[\s\S]*?<\/canvas_selection>\s*/g, '')
    .replace(/<browser_selection[\s\S]*?<\/browser_selection>\s*/g, '')
    .trim();
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


export function appendSessionReferences(
  prompt: string,
  references?: readonly ProviderSessionReference[],
  mapPath: (path: string) => string = path => path,
): string {
  if (!references?.length) return prompt;
  const entries = references.map(reference => {
    const attributes = {
      title: reference.title, id: reference.id, provider: reference.providerId,
      updated: reference.updatedAt, path: mapPath(reference.snapshotPath),
    };
    return `<context_session ${Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapePromptXMLAttribute(value)}"`).join(' ')} />`;
  });
  return `${prompt}\n\n<context_sessions>\n${entries.join('\n')}\n</context_sessions>`;
}

/** Normalize legacy single selections only when an ordered capture is absent. */
function getSelectionSnapshots(context?: ProviderExecutionContext): readonly ProviderSelectionSnapshot[] {
  if (context?.selections !== undefined) return context.selections;
  const selections: ProviderSelectionSnapshot[] = [];
  if (context?.editorSelection) selections.push({ kind: 'editor', selection: context.editorSelection });
  if (context?.browserSelection) selections.push({ kind: 'browser', selection: context.browserSelection });
  if (context?.canvasSelection) selections.push({ kind: 'canvas', selection: context.canvasSelection });
  return selections;
}

export function captureSelectionSnapshots(context?: ProviderExecutionContext): ProviderSelectionSnapshot[] {
  return getSelectionSnapshots(context).map(snapshot => {
    switch (snapshot.kind) {
      case 'editor':
        return { kind: 'editor', selection: {
          ...snapshot.selection,
          ...(snapshot.selection.cursorContext ? { cursorContext: { ...snapshot.selection.cursorContext } } : {}),
        } };
      case 'browser':
        return { kind: 'browser', selection: { ...snapshot.selection } };
      case 'canvas':
        return { kind: 'canvas', selection: { ...snapshot.selection, nodeIds: [...snapshot.selection.nodeIds] } };
    }
  });
}

export function appendSelectionContexts(prompt: string, context?: ProviderExecutionContext): string {
  for (const snapshot of getSelectionSnapshots(context)) {
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
