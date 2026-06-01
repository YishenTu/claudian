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

export function parseFileUpdateChangeDiffs(changes: unknown): ApplyPatchFileDiff[] {
  if (!Array.isArray(changes)) return [];

  return changes
    .map(parseFileUpdateChangeDiff)
    .filter((diff): diff is ApplyPatchFileDiff => diff !== null);
}

export function extractDiffData(toolUseResult: unknown, toolCall: ToolCallInfo): ToolDiffData | undefined {
  const filePath = getNonEmptyStringValue(toolCall.input.file_path)
    ?? getNonEmptyStringValue(toolCall.input.path)
    ?? 'file';

  if (toolUseResult && typeof toolUseResult === 'object') {
    const result = toolUseResult as Record<string, unknown>;
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
      const resultFilePath = (typeof result.filePath === 'string' ? result.filePath : null) || filePath;
      const hunks = result.structuredPatch as StructuredPatchHunk[];
      const diffLines = structuredPatchToDiffLines(hunks);
      const stats = countLineChanges(diffLines);
      return { filePath: resultFilePath, diffLines, stats };
    }

    const unifiedDiff = getUnifiedDiffText(result);
    if (unifiedDiff) {
      const diffLines = parseUnifiedDiffLines(unifiedDiff);
      if (diffLines.length > 0) {
        const resultFilePath = (typeof result.filePath === 'string' ? result.filePath : null)
          || (typeof result.path === 'string' ? result.path : null)
          || filePath;
        return { filePath: resultFilePath, diffLines, stats: countLineChanges(diffLines) };
      }
    }
  }

  return diffFromToolInput(toolCall, filePath);
}

export function diffFromToolInput(toolCall: ToolCallInfo, filePath: string): ToolDiffData | undefined {
  if (toolCall.name === 'Edit') {
    const oldStr = toolCall.input.old_string;
    const newStr = toolCall.input.new_string;
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      const diffLines = buildReplacementDiffLines([{ oldText: oldStr, newText: newStr }]);
      return { filePath, diffLines, stats: countLineChanges(diffLines) };
    }

    const editPairs = getEditPairs(toolCall.input);
    if (editPairs.length > 0) {
      const diffLines = buildReplacementDiffLines(editPairs);
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

function getUnifiedDiffText(result: Record<string, unknown>): string | null {
  if (typeof result.diff === 'string' && result.diff.trim()) {
    return result.diff;
  }

  const details = result.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const diff = (details as Record<string, unknown>).diff;
    if (typeof diff === 'string' && diff.trim()) {
      return diff;
    }
  }

  return null;
}

interface ReplacementPair {
  oldText: string;
  newText: string;
}

function getEditPairs(input: Record<string, unknown>): ReplacementPair[] {
  const topLevelPair = getReplacementPair(input);
  if (topLevelPair) {
    return [topLevelPair];
  }

  const edits = input.edits;
  if (!Array.isArray(edits)) {
    return [];
  }

  return edits
    .map(getReplacementPair)
    .filter((pair): pair is ReplacementPair => pair !== null);
}

function getReplacementPair(value: unknown): ReplacementPair | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const oldText = getStringValue(record.oldText ?? record.old_text ?? record.old_string);
  const newText = getStringValue(record.newText ?? record.new_text ?? record.new_string);
  return oldText !== null && newText !== null ? { oldText, newText } : null;
}

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNonEmptyStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function buildReplacementDiffLines(pairs: ReplacementPair[]): DiffLine[] {
  const diffLines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const pair of pairs) {
    for (const line of pair.oldText.split('\n')) {
      diffLines.push({ type: 'delete', text: line, oldLineNum: oldLineNum++ });
    }
    for (const line of pair.newText.split('\n')) {
      diffLines.push({ type: 'insert', text: line, newLineNum: newLineNum++ });
    }
  }

  return diffLines;
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

function parseFileUpdateChangeDiff(change: unknown): ApplyPatchFileDiff | null {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    return null;
  }

  const record = change as Record<string, unknown>;
  const filePath = typeof record.path === 'string' ? record.path : '';
  const diff = typeof record.diff === 'string' ? record.diff : '';
  if (!filePath || !diff.trim()) {
    return null;
  }

  const kindInfo = parseFileUpdateKind(record.kind ?? record.type);
  const diffLines = parseUnifiedDiffLines(diff);
  return {
    filePath,
    operation: kindInfo.operation,
    ...(kindInfo.movedTo ? { movedTo: kindInfo.movedTo } : {}),
    diffLines,
    stats: countLineChanges(diffLines),
  };
}

function parseFileUpdateKind(value: unknown): {
  operation: ApplyPatchFileDiff['operation'];
  movedTo?: string;
} {
  if (typeof value === 'string') {
    return { operation: normalizePatchOperation(value) };
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const movedTo = typeof record.move_path === 'string' ? record.move_path : undefined;
    return {
      operation: normalizePatchOperation(type),
      ...(movedTo ? { movedTo } : {}),
    };
  }

  return { operation: 'update' };
}

function normalizePatchOperation(value: string): ApplyPatchFileDiff['operation'] {
  if (value === 'add' || value === 'delete' || value === 'update') {
    return value;
  }

  return 'update';
}

function parseUnifiedDiffLines(diffText: string): DiffLine[] {
  const diffLines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of diffText.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    if (line.startsWith('@@')) {
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (match) {
        oldLineNum = Number(match[1]);
        newLineNum = Number(match[2]);
      }
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === '+') {
      diffLines.push({ type: 'insert', text, newLineNum: newLineNum++ });
    } else if (prefix === '-') {
      diffLines.push({ type: 'delete', text, oldLineNum: oldLineNum++ });
    } else if (prefix === ' ') {
      diffLines.push({ type: 'equal', text, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
    }
  }

  return diffLines;
}
