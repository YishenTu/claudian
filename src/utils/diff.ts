/**
 * Diff utilities for structured patch conversion and diff extraction.
 */

import type { DiffLine, DiffStats, StructuredPatchHunk } from '../core/types/diff';
import type { ToolCallInfo, ToolDiffData } from '../core/types/tools';

/**
 * Convert SDK structuredPatch hunks to DiffLine[].
 * Each line in the hunk is prefixed with '+' (insert), '-' (delete), or ' ' (context).
 */
export function structuredPatchToDiffLines(hunks: StructuredPatchHunk[]): DiffLine[] {
  const result: DiffLine[] = [];

  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      const prefix = line[0];
      const text = line.slice(1);

      if (prefix === '+') {
        result.push({ type: 'insert', text, newLineNum: newLineNum++ });
      } else if (prefix === '-') {
        result.push({ type: 'delete', text, oldLineNum: oldLineNum++ });
      } else {
        result.push({ type: 'equal', text, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
      }
    }
  }

  return result;
}

/** Count lines added and removed. */
export function countLineChanges(diffLines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;

  for (const line of diffLines) {
    if (line.type === 'insert') added++;
    else if (line.type === 'delete') removed++;
  }

  return { added, removed };
}

/**
 * Extracts ToolDiffData from an SDK toolUseResult object.
 *
 * Primary: Use structuredPatch hunks from the SDK result.
 * Fallback: Compute diff from tool input (Edit: old/new string, Write: content as inserts).
 */
export function extractDiffData(toolUseResult: unknown, toolCall: ToolCallInfo): ToolDiffData | undefined {
  const filePath = (toolCall.input.file_path as string) || 'file';

  if (toolUseResult && typeof toolUseResult === 'object') {
    const result = toolUseResult as Record<string, unknown>;
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
      const resultFilePath = (typeof result.filePath === 'string' ? result.filePath : null) || filePath;
      const hunks = result.structuredPatch as StructuredPatchHunk[];
      const diffLines = structuredPatchToDiffLines(hunks);
      const stats = countLineChanges(diffLines);
      return { filePath: resultFilePath, diffLines, stats };
    }
  }

  return diffFromToolInput(toolCall, filePath);
}

/**
 * Computes diff data from tool input when structuredPatch is unavailable or empty.
 * Edit: old_string lines as deletes, new_string lines as inserts.
 * Write: all content lines as inserts (file create/full rewrite).
 */
export function diffFromToolInput(toolCall: ToolCallInfo, filePath: string): ToolDiffData | undefined {
  if (toolCall.name === 'Edit') {
    const oldStr = toolCall.input.old_string;
    const newStr = toolCall.input.new_string;
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      const diffLines: DiffLine[] = [];
      const oldLines = oldStr.split('\n');
      const newLines = newStr.split('\n');
      let oldLineNum = 1;
      for (const line of oldLines) {
        diffLines.push({ type: 'delete', text: line, oldLineNum: oldLineNum++ });
      }
      let newLineNum = 1;
      for (const line of newLines) {
        diffLines.push({ type: 'insert', text: line, newLineNum: newLineNum++ });
      }
      return { filePath, diffLines, stats: countLineChanges(diffLines) };
    }
  }

  if (toolCall.name === 'Write') {
    const content = toolCall.input.content;
    if (typeof content === 'string') {
      const newLines = content.split('\n');
      const diffLines: DiffLine[] = newLines.map((text, i) => ({
        type: 'insert',
        text,
        newLineNum: i + 1,
      }));
      return { filePath, diffLines, stats: { added: newLines.length, removed: 0 } };
    }
  }

  return undefined;
}
