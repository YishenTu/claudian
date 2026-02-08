import { createMockEl } from '@test/helpers/mockElement';

import type { ToolCallInfo, ToolDiffData } from '@/core/types';
import {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  updateWriteEditWithDiff,
} from '@/features/chat/rendering/WriteEditRenderer';

// Helper to create a basic tool call
function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tool-123',
    name: 'Write',
    input: { file_path: '/test/vault/notes/test.md', content: 'new content' },
    status: 'running',
    ...overrides,
  };
}

// Helper to create pre-computed diff data
function createDiffData(overrides: Partial<ToolDiffData> = {}): ToolDiffData {
  return {
    filePath: 'test.md',
    diffLines: [
      { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'old', oldLineNum: 2 },
      { type: 'insert', text: 'new', newLineNum: 2 },
    ],
    stats: { added: 1, removed: 1 },
    ...overrides,
  };
}

describe('WriteEditRenderer', () => {
  describe('createWriteEditBlock', () => {
    it('should create a block with correct structure', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.wrapperEl).toBeDefined();
      expect(state.headerEl).toBeDefined();
      expect(state.nameEl).toBeDefined();
      expect(state.summaryEl).toBeDefined();
      expect(state.statsEl).toBeDefined();
      expect(state.statusEl).toBeDefined();
      expect(state.contentEl).toBeDefined();
      expect(state.toolCall).toBe(toolCall);
    });

    it('should set data-tool-id on wrapper', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'my-tool-id' });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.wrapperEl.dataset.toolId).toBe('my-tool-id');
    });

    it('should display tool name and filename in two-part header', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'Edit',
        input: { file_path: 'notes/test.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.nameEl.textContent).toBe('Edit');
      expect(state.summaryEl.textContent).toBe('test.md');
    });

    it('should show spinner status while running', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.statusEl.hasClass('status-running')).toBe(true);
    });

    it('should show filename only in summary', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        input: { file_path: '/very/long/path/to/some/deeply/nested/file.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      // Summary should show just the filename
      expect(state.summaryEl.textContent).toBe('file.md');
    });

    it('should handle missing file_path gracefully', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ input: {} });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.summaryEl.textContent).toBe('file');
    });
  });

  describe('updateWriteEditWithDiff', () => {
    it('should render diff stats when diff data is provided', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData = createDiffData({
        stats: { added: 1, removed: 0 },
      });

      updateWriteEditWithDiff(state, diffData);

      // Should show +1 for added line
      expect((state.statsEl as any)._children.length).toBeGreaterThan(0);
    });

    it('should store diffLines in state', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData = createDiffData();

      updateWriteEditWithDiff(state, diffData);

      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.length).toBeGreaterThan(0);
    });

    it('should show both added and removed counts', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData = createDiffData({
        stats: { added: 3, removed: 2 },
      });

      updateWriteEditWithDiff(state, diffData);

      // Should have stats children
      expect((state.statsEl as any)._children.length).toBeGreaterThan(0);
    });

    it('should handle empty diffLines with zero stats', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData = createDiffData({
        diffLines: [],
        stats: { added: 0, removed: 0 },
      });

      updateWriteEditWithDiff(state, diffData);

      // Should not have stats children when no changes
      expect((state.statsEl as any)._children.length).toBe(0);
    });
  });

  describe('finalizeWriteEditBlock', () => {
    it('should update status to done on success', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      // Add diff data first
      updateWriteEditWithDiff(state, createDiffData());

      finalizeWriteEditBlock(state, false);

      expect(state.wrapperEl.hasClass('done')).toBe(true);
      expect(state.statusEl.hasClass('status-running')).toBe(false);
    });

    it('should update status to error on failure', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ result: 'Error: file not found' });
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, true);

      expect(state.wrapperEl.hasClass('error')).toBe(true);
      expect(state.statusEl.hasClass('status-error')).toBe(true);
    });

    it('should show error message in content when no diff', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ result: 'Permission denied' });
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, true);

      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('Permission denied');
    });

    it('should clear spinner status on finalize', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, false);

      expect(state.statusEl.hasClass('status-running')).toBe(false);
      expect((state.statusEl as any)._children.length).toBe(0);
    });
  });

  describe('renderStoredWriteEdit', () => {
    it('should show done state for completed status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('done')).toBe(true);
    });

    it('should show error state for error status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'error' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should show error state for blocked status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'blocked' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should render diff stats from stored diffData', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        diffData: createDiffData({
          stats: { added: 2, removed: 1 },
        }),
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      // Block should be created successfully with stats
      expect(block.dataset.toolId).toBe('tool-123');
    });

    it('should handle stored block with empty diffLines', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'completed',
        diffData: createDiffData({
          diffLines: [],
          stats: { added: 0, removed: 0 },
        }),
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block).toBeDefined();
    });

    it('should show error message when no diffData and error', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        status: 'error',
        result: 'File not found',
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should use correct icon for Edit tool', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ name: 'Edit' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      // Block should render for Edit tool
      expect(block).toBeDefined();
    });

  });

  describe('filename extraction', () => {
    it('should extract filename from path', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        input: { file_path: 'notes/test.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.summaryEl.textContent).toBe('test.md');
    });

    it('should extract filename from long path', () => {
      const parentEl = createMockEl();
      const longPath = 'src/components/features/auth/modals/confirmation/ConfirmationDialog.tsx';
      const toolCall = createToolCall({
        input: { file_path: longPath },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.summaryEl.textContent).toBe('ConfirmationDialog.tsx');
    });

    it('should handle paths with only filename', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        input: { file_path: 'README.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.summaryEl.textContent).toBe('README.md');
    });
  });

  describe('diff rendering', () => {
    it('should render new file correctly (all inserts)', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        diffLines: [
          { type: 'insert', text: 'new content', newLineNum: 1 },
          { type: 'insert', text: 'line 2', newLineNum: 2 },
        ],
        stats: { added: 2, removed: 0 },
      };

      updateWriteEditWithDiff(state, diffData);

      // Should show +2 for two new lines
      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.filter(l => l.type === 'insert').length).toBe(2);
    });

    it('should handle file deletion (all deletes)', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        diffLines: [
          { type: 'delete', text: 'content', oldLineNum: 1 },
        ],
        stats: { added: 0, removed: 1 },
      };

      updateWriteEditWithDiff(state, diffData);

      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.filter(l => l.type === 'delete').length).toBe(1);
    });

    it('should handle mixed changes', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        diffLines: [
          { type: 'equal', text: 'line1', oldLineNum: 1, newLineNum: 1 },
          { type: 'delete', text: 'old', oldLineNum: 2 },
          { type: 'insert', text: 'new1', newLineNum: 2 },
          { type: 'insert', text: 'new2', newLineNum: 3 },
          { type: 'equal', text: 'line3', oldLineNum: 3, newLineNum: 4 },
        ],
        stats: { added: 2, removed: 1 },
      };

      updateWriteEditWithDiff(state, diffData);

      expect(state.diffLines).toBeDefined();
      const types = state.diffLines!.reduce(
        (acc, l) => {
          acc[l.type] = (acc[l.type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      expect(types.delete).toBe(1);
      expect(types.insert).toBe(2);
      expect(types.equal).toBe(2);
    });
  });
});

// Helper to get text content recursively
function getTextContent(element: any): string {
  let text = element.textContent || '';
  if (element._children) {
    for (const child of element._children) {
      text += getTextContent(child);
    }
  }
  return text;
}
