/**
 * Unit tests for diff utilities (extractDiffData and diffFromToolInput).
 */

import type { ToolCallInfo } from '../../../src/core/types/tools';
import { diffFromToolInput,extractDiffData } from '../../../src/utils/diff';

/** Helper to create a ToolCallInfo for testing. */
function makeToolCall(name: string, input: Record<string, unknown>): ToolCallInfo {
  return { id: 'test-id', name, input, status: 'completed', isExpanded: false };
}

describe('extractDiffData', () => {
  it('returns ToolDiffData from valid toolUseResult with structuredPatch', () => {
    const toolCall = makeToolCall('Edit', { file_path: 'src/foo.ts' });
    const toolUseResult = {
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
      ],
    };

    const result = extractDiffData(toolUseResult, toolCall);

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('src/foo.ts');
    expect(result!.diffLines).toHaveLength(2);
    expect(result!.diffLines[0]).toEqual({ type: 'delete', text: 'old', oldLineNum: 1 });
    expect(result!.diffLines[1]).toEqual({ type: 'insert', text: 'new', newLineNum: 1 });
    expect(result!.stats).toEqual({ added: 1, removed: 1 });
  });

  it('uses SDK filePath when present in toolUseResult', () => {
    const toolCall = makeToolCall('Write', { file_path: 'input/path.ts' });
    const toolUseResult = {
      filePath: 'sdk/override.ts',
      structuredPatch: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] },
      ],
    };

    const result = extractDiffData(toolUseResult, toolCall);

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('sdk/override.ts');
  });

  it('falls back to diffFromToolInput when toolUseResult is undefined', () => {
    const toolCall = makeToolCall('Edit', {
      file_path: 'src/bar.ts',
      old_string: 'a',
      new_string: 'b',
    });

    const result = extractDiffData(undefined, toolCall);

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('src/bar.ts');
    expect(result!.diffLines).toHaveLength(2);
  });

  it('falls back to diffFromToolInput when toolUseResult is empty object', () => {
    const toolCall = makeToolCall('Write', {
      file_path: 'src/new.ts',
      content: 'line1\nline2',
    });

    const result = extractDiffData({}, toolCall);

    // {} has no structuredPatch → falls back to diffFromToolInput for Write
    expect(result).toBeDefined();
    expect(result!.diffLines).toHaveLength(2);
    expect(result!.stats).toEqual({ added: 2, removed: 0 });
  });

  it('falls back to diffFromToolInput when structuredPatch is empty array', () => {
    const toolCall = makeToolCall('Edit', {
      file_path: 'src/x.ts',
      old_string: 'old',
      new_string: 'new',
    });

    const result = extractDiffData({ structuredPatch: [] }, toolCall);

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('src/x.ts');
    expect(result!.diffLines).toHaveLength(2);
  });

  it('falls back to diffFromToolInput when toolUseResult is a string', () => {
    const toolCall = makeToolCall('Edit', {
      file_path: 'src/y.ts',
      old_string: 'foo',
      new_string: 'bar',
    });

    const result = extractDiffData('some string result', toolCall);

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('src/y.ts');
  });

  it('returns undefined for unknown tool with no structuredPatch', () => {
    const toolCall = makeToolCall('Bash', { command: 'echo hi' });

    const result = extractDiffData(undefined, toolCall);

    expect(result).toBeUndefined();
  });
});

describe('diffFromToolInput', () => {
  it('returns delete + insert lines for Edit with valid old_string/new_string', () => {
    const toolCall = makeToolCall('Edit', {
      file_path: 'src/a.ts',
      old_string: 'line1\nline2',
      new_string: 'newline1\nnewline2\nnewline3',
    });

    const result = diffFromToolInput(toolCall, 'src/a.ts');

    expect(result).toBeDefined();
    expect(result!.filePath).toBe('src/a.ts');
    // 2 delete lines + 3 insert lines
    expect(result!.diffLines).toHaveLength(5);
    expect(result!.diffLines.filter(l => l.type === 'delete')).toHaveLength(2);
    expect(result!.diffLines.filter(l => l.type === 'insert')).toHaveLength(3);
    expect(result!.stats).toEqual({ added: 3, removed: 2 });
  });

  it('returns all insert lines for Write with valid content', () => {
    const toolCall = makeToolCall('Write', {
      file_path: 'src/b.ts',
      content: 'a\nb\nc',
    });

    const result = diffFromToolInput(toolCall, 'src/b.ts');

    expect(result).toBeDefined();
    expect(result!.diffLines).toHaveLength(3);
    expect(result!.diffLines.every(l => l.type === 'insert')).toBe(true);
    expect(result!.stats).toEqual({ added: 3, removed: 0 });
  });

  it('returns undefined for Edit with non-string inputs', () => {
    const toolCall = makeToolCall('Edit', {
      file_path: 'src/c.ts',
      old_string: 123,
      new_string: null,
    });

    const result = diffFromToolInput(toolCall, 'src/c.ts');

    expect(result).toBeUndefined();
  });

  it('returns undefined for Write with non-string content', () => {
    const toolCall = makeToolCall('Write', {
      file_path: 'src/d.ts',
      content: { data: 'not a string' },
    });

    const result = diffFromToolInput(toolCall, 'src/d.ts');

    expect(result).toBeUndefined();
  });

  it('returns undefined for unknown tool name', () => {
    const toolCall = makeToolCall('Bash', { command: 'ls' });

    const result = diffFromToolInput(toolCall, 'some/path');

    expect(result).toBeUndefined();
  });
});
