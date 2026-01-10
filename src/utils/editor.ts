/**
 * Claudian - Editor Context Utilities
 *
 * Editor cursor and selection context for inline editing.
 */

import type { EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';

/**
 * Gets the CodeMirror EditorView from an Obsidian Editor.
 * Obsidian's Editor type doesn't expose the internal `.cm` property.
 */
export function getEditorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

export interface CursorContext {
  beforeCursor: string;
  afterCursor: string;
  isInbetween: boolean;
  line: number;
  column: number;
}

export interface EditorSelectionContext {
  notePath: string;
  mode: 'selection' | 'cursor' | 'none';
  selectedText?: string;
  cursorContext?: CursorContext;
  lineCount?: number; // Number of lines in selection (for UI indicator)
  startLine?: number; // 1-indexed starting line number
}

/** Helper to find nearest non-empty line in a direction. */
export function findNearestNonEmptyLine(
  getLine: (line: number) => string,
  lineCount: number,
  startLine: number,
  direction: 'before' | 'after'
): string {
  const step = direction === 'before' ? -1 : 1;
  for (let i = startLine + step; i >= 0 && i < lineCount; i += step) {
    const content = getLine(i);
    if (content.trim().length > 0) {
      return content;
    }
  }
  return '';
}

/**
 * Builds cursor context for inline edit cursor mode.
 * @param getLine Function to get line content by index (0-indexed)
 * @param lineCount Total number of lines in document
 * @param line Cursor line (0-indexed)
 * @param column Cursor column
 */
export function buildCursorContext(
  getLine: (line: number) => string,
  lineCount: number,
  line: number,
  column: number
): CursorContext {
  const lineContent = getLine(line);
  const beforeCursor = lineContent.substring(0, column);
  const afterCursor = lineContent.substring(column);

  const lineIsEmpty = lineContent.trim().length === 0;
  const nothingBefore = beforeCursor.trim().length === 0;
  const nothingAfter = afterCursor.trim().length === 0;
  const isInbetween = lineIsEmpty || (nothingBefore && nothingAfter);

  let contextBefore = beforeCursor;
  let contextAfter = afterCursor;

  if (isInbetween) {
    // Find nearest non-empty line before cursor
    contextBefore = findNearestNonEmptyLine(getLine, lineCount, line, 'before');
    // Find nearest non-empty line after cursor
    contextAfter = findNearestNonEmptyLine(getLine, lineCount, line, 'after');
  }

  return { beforeCursor: contextBefore, afterCursor: contextAfter, isInbetween, line, column };
}

/** Formats editor context in XML format. */
export function formatEditorContext(context: EditorSelectionContext): string {
  if (context.mode === 'selection' && context.selectedText) {
    const lineAttr = context.startLine && context.lineCount
      ? ` lines="${context.startLine}-${context.startLine + context.lineCount - 1}"`
      : '';
    return `<editor_selection path="${context.notePath}"${lineAttr}>\n${context.selectedText}\n</editor_selection>`;
  } else if (context.mode === 'cursor' && context.cursorContext) {
    const ctx = context.cursorContext;
    let content: string;
    if (ctx.isInbetween) {
      const parts = [];
      if (ctx.beforeCursor) parts.push(ctx.beforeCursor);
      parts.push('| #inbetween');
      if (ctx.afterCursor) parts.push(ctx.afterCursor);
      content = parts.join('\n');
    } else {
      content = `${ctx.beforeCursor}|${ctx.afterCursor} #inline`;
    }
    return `<editor_cursor path="${context.notePath}">\n${content}\n</editor_cursor>`;
  }
  return '';
}

/** Prepends editor context to a prompt. */
export function prependEditorContext(prompt: string, context: EditorSelectionContext): string {
  const formatted = formatEditorContext(context);
  return formatted ? `${formatted}\n\n${prompt}` : prompt;
}
