import type { DiffLine, DiffStats, StructuredPatchHunk } from '../core/types/diff';
import type { ToolCallInfo, ToolDiffData } from '../core/types/tools';

export interface ApplyPatchFileDiff extends ToolDiffData {
  operation: 'add' | 'update' | 'delete';
  movedTo?: string;
}

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

export function countLineChanges(diffLines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;

  for (const line of diffLines) {
    if (line.type === 'insert') added++;
    else if (line.type === 'delete') removed++;
  }

  return { added, removed };
}

export function parseApplyPatchDiffs(patchText: string): ApplyPatchFileDiff[] {
  if (!patchText.trim()) return [];

  const fileDiffs: ApplyPatchFileDiff[] = [];
  const lines = patchText.split(/\r?\n/);
  let current:
    | {
        filePath: string;
        operation: ApplyPatchFileDiff['operation'];
        movedTo?: string;
        rawLines: string[];
      }
    | null = null;

  const flushCurrent = () => {
    if (!current) return;
    fileDiffs.push(buildApplyPatchFileDiff(current));
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      flushCurrent();
      current = {
        filePath: line.slice('*** Add File: '.length).trim(),
        operation: 'add',
        rawLines: [],
      };
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      flushCurrent();
      current = {
        filePath: line.slice('*** Update File: '.length).trim(),
        operation: 'update',
        rawLines: [],
      };
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      flushCurrent();
      fileDiffs.push({
        filePath: line.slice('*** Delete File: '.length).trim(),
        operation: 'delete',
        diffLines: [],
        stats: { added: 0, removed: 0 },
      });
      continue;
    }

    if (!current) continue;

    if (line.startsWith('*** Move to: ')) {
      current.movedTo = line.slice('*** Move to: '.length).trim();
      continue;
    }

    if (line === '*** End of File' || line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    const prefix = line[0];
    if (prefix === '+' || prefix === '-' || prefix === ' ') {
      current.rawLines.push(line);
    }
  }

  flushCurrent();
  return fileDiffs;
}

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

function buildApplyPatchFileDiff(current: {
  filePath: string;
  operation: ApplyPatchFileDiff['operation'];
  movedTo?: string;
  rawLines: string[];
}): ApplyPatchFileDiff {
  const diffLines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of current.rawLines) {
    const prefix = line[0];
    const text = line.slice(1);

    if (prefix === '+') {
      diffLines.push({ type: 'insert', text, newLineNum: newLineNum++ });
      continue;
    }

    if (prefix === '-') {
      diffLines.push({ type: 'delete', text, oldLineNum: oldLineNum++ });
      continue;
    }

    diffLines.push({ type: 'equal', text, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
  }

  const result: ApplyPatchFileDiff = {
    filePath: current.filePath,
    operation: current.operation,
    diffLines,
    stats: countLineChanges(diffLines),
  };
  if (current.movedTo) result.movedTo = current.movedTo;
  return result;
}
