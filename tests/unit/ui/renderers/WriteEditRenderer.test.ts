/**
 * Tests for WriteEditRenderer - Write/Edit tool UI with diff view
 */

import type { ToolCallInfo, ToolDiffData } from '@/core/types';
import {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  renderStoredWriteEdit,
  updateWriteEditWithDiff,
} from '@/ui/renderers/WriteEditRenderer';

// Create mock HTML element with Obsidian-like methods
function createMockElement(tag = 'div'): any {
  const children: any[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const dataset: Record<string, string> = {};

  const element: any = {
    tagName: tag.toUpperCase(),
    children,
    dataset,
    style: {},
    textContent: '',
    innerHTML: '',
    // Track className assignment for direct class replacement
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value: string) {
      classes.clear();
      if (value) {
        value.split(' ').filter(Boolean).forEach(c => classes.add(c));
      }
    },
    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      contains: (cls: string) => classes.has(cls),
    },
    addClass: (cls: string) => {
      classes.add(cls);
      return element;
    },
    removeClass: (cls: string) => {
      classes.delete(cls);
      return element;
    },
    hasClass: (cls: string) => classes.has(cls),
    empty: () => {
      children.length = 0;
      element.innerHTML = '';
      element.textContent = '';
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(handler);
    },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('div');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('span');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createEl: (tagName: string, opts?: { cls?: string; text?: string }) => {
      const child = createMockElement(tagName);
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    setText: (text: string) => {
      element.textContent = text;
    },
    // Test helpers
    _classes: classes,
    _attributes: attributes,
    _eventListeners: eventListeners,
    _children: children,
  };

  return element;
}

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

describe('WriteEditRenderer', () => {
  describe('createWriteEditBlock', () => {
    it('should create a block with correct structure', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.wrapperEl).toBeDefined();
      expect(state.headerEl).toBeDefined();
      expect(state.labelEl).toBeDefined();
      expect(state.statsEl).toBeDefined();
      expect(state.statusEl).toBeDefined();
      expect(state.contentEl).toBeDefined();
      expect(state.toolCall).toBe(toolCall);
    });

    it('should start expanded by default', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.isExpanded).toBe(true);
      expect(state.wrapperEl.hasClass('expanded')).toBe(true);
    });

    it('should set data-tool-id on wrapper', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ id: 'my-tool-id' });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.wrapperEl.dataset.toolId).toBe('my-tool-id');
    });

    it('should display tool name and file path in label', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        name: 'Edit',
        input: { file_path: 'notes/test.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.labelEl.textContent).toContain('Edit');
      expect(state.labelEl.textContent).toContain('notes/test.md');
    });

    it('should show spinner status while running', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.statusEl.hasClass('status-running')).toBe(true);
    });

    it('should toggle expand/collapse on header click', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      // Initially expanded
      expect(state.isExpanded).toBe(true);
      expect(state.wrapperEl.hasClass('expanded')).toBe(true);

      // Trigger click
      const clickHandlers = (state.headerEl as any)._eventListeners.get('click') || [];
      expect(clickHandlers.length).toBeGreaterThan(0);
      clickHandlers[0]();

      // Should be collapsed
      expect(state.isExpanded).toBe(false);
      expect(state.wrapperEl.hasClass('expanded')).toBe(false);

      // Click again to expand
      clickHandlers[0]();
      expect(state.isExpanded).toBe(true);
    });

    it('should set ARIA attributes for accessibility', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.headerEl.getAttribute('role')).toBe('button');
      expect(state.headerEl.getAttribute('tabindex')).toBe('0');
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
    });

    it('should shorten long file paths', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        input: { file_path: '/very/long/path/to/some/deeply/nested/file.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      // Should be shortened, not the full path
      expect(state.labelEl.textContent.length).toBeLessThan(
        'Write: /very/long/path/to/some/deeply/nested/file.md'.length + 10
      );
    });

    it('should handle missing file_path gracefully', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ input: {} });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.labelEl.textContent).toContain('file');
    });
  });

  describe('updateWriteEditWithDiff', () => {
    it('should render diff stats when diff is available', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'line1\nline2',
        newContent: 'line1\nline2\nline3',
      };

      updateWriteEditWithDiff(state, diffData);

      // Should show +1 for added line
      expect((state.statsEl as any)._children.length).toBeGreaterThan(0);
    });

    it('should display "Diff skipped: file too large" for too_large', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        skippedReason: 'too_large',
      };

      updateWriteEditWithDiff(state, diffData);

      // Check content shows skip message
      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('file too large');
    });

    it('should display "Diff unavailable" for unavailable reason', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        skippedReason: 'unavailable',
      };

      updateWriteEditWithDiff(state, diffData);

      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('Diff unavailable');
    });

    it('should display "Diff unavailable" for undefined content', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: undefined,
        newContent: undefined,
      };

      updateWriteEditWithDiff(state, diffData);

      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('Diff unavailable');
    });

    it('should display "Binary file" for binary content', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'normal text',
        newContent: 'binary\x00content',
      };

      updateWriteEditWithDiff(state, diffData);

      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('Binary file');
    });

    it('should store diffLines in state', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'old',
        newContent: 'new',
      };

      updateWriteEditWithDiff(state, diffData);

      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.length).toBeGreaterThan(0);
    });

    it('should show both added and removed counts', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'old1\nold2',
        newContent: 'new1',
      };

      updateWriteEditWithDiff(state, diffData);

      // Should have stats children
      expect((state.statsEl as any)._children.length).toBeGreaterThan(0);
    });
  });

  describe('finalizeWriteEditBlock', () => {
    it('should update status to done on success', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      // Add diff data first
      updateWriteEditWithDiff(state, {
        filePath: 'test.md',
        originalContent: 'old',
        newContent: 'new',
      });

      finalizeWriteEditBlock(state, false);

      expect(state.wrapperEl.hasClass('done')).toBe(true);
      expect(state.statusEl.hasClass('status-running')).toBe(false);
    });

    it('should update status to error on failure', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ result: 'Error: file not found' });
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, true);

      expect(state.wrapperEl.hasClass('error')).toBe(true);
      expect(state.statusEl.hasClass('status-error')).toBe(true);
    });

    it('should show error message in content when no diff', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ result: 'Permission denied' });
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, true);

      const contentText = getTextContent(state.contentEl);
      expect(contentText).toContain('Permission denied');
    });

    it('should clear spinner status on finalize', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      finalizeWriteEditBlock(state, false);

      expect(state.statusEl.hasClass('status-running')).toBe(false);
      expect((state.statusEl as any)._children.length).toBe(0);
    });
  });

  describe('renderStoredWriteEdit', () => {
    it('should create collapsed block by default', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'completed' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('expanded')).toBe(false);
    });

    it('should show done state for completed status', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'completed' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('done')).toBe(true);
    });

    it('should show error state for error status', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'error' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should show error state for blocked status', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'blocked' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should render diff stats from stored diffData', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        status: 'completed',
        diffData: {
          filePath: 'test.md',
          originalContent: 'old line',
          newContent: 'new line\nanother line',
        },
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      // Block should be created successfully with stats
      expect(block.dataset.toolId).toBe('tool-123');
    });

    it('should handle stored block with skipped diff', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        status: 'completed',
        diffData: { filePath: 'test.md', skippedReason: 'too_large' },
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block).toBeDefined();
    });

    it('should show error message when no diffData and error', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        status: 'error',
        result: 'File not found',
      });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      expect(block.hasClass('error')).toBe(true);
    });

    it('should toggle expand on click', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'completed' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      // Initially collapsed
      expect(block.hasClass('expanded')).toBe(false);

      // Find header and trigger click
      const header = (block as any)._children.find((c: any) =>
        c.hasClass('claudian-write-edit-header')
      );
      expect(header).toBeDefined();

      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();

      expect(block.hasClass('expanded')).toBe(true);
    });

    it('should use correct icon for Edit tool', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ name: 'Edit' });

      const block = renderStoredWriteEdit(parentEl, toolCall);

      // Block should render for Edit tool
      expect(block).toBeDefined();
    });

    it('should support keyboard navigation (Enter/Space)', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({ status: 'completed' });

      const block = renderStoredWriteEdit(parentEl, toolCall);
      const header = (block as any)._children.find((c: any) =>
        c.hasClass('claudian-write-edit-header')
      );

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      expect(keydownHandlers.length).toBeGreaterThan(0);

      // Simulate Enter key
      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](enterEvent);

      expect(enterEvent.preventDefault).toHaveBeenCalled();
      expect(block.hasClass('expanded')).toBe(true);
    });
  });

  describe('path shortening', () => {
    it('should not shorten short paths', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        input: { file_path: 'notes/test.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.labelEl.textContent).toContain('notes/test.md');
    });

    it('should shorten very long paths', () => {
      const parentEl = createMockElement();
      const longPath = 'src/components/features/auth/modals/confirmation/ConfirmationDialog.tsx';
      const toolCall = createToolCall({
        input: { file_path: longPath },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      // Should contain ellipsis
      expect(state.labelEl.textContent).toContain('...');
      // Should contain filename
      expect(state.labelEl.textContent).toContain('ConfirmationDialog.tsx');
    });

    it('should handle paths with only filename', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall({
        input: { file_path: 'README.md' },
      });

      const state = createWriteEditBlock(parentEl, toolCall);

      expect(state.labelEl.textContent).toContain('README.md');
    });
  });

  describe('diff rendering', () => {
    it('should render new file correctly', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: '',
        newContent: 'new content\nline 2',
      };

      updateWriteEditWithDiff(state, diffData);

      // Should show +2 for two new lines
      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.filter(l => l.type === 'insert').length).toBe(2);
    });

    it('should handle empty file being written', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'content',
        newContent: '',
      };

      updateWriteEditWithDiff(state, diffData);

      // Should show -1 for deleted line
      expect(state.diffLines).toBeDefined();
      expect(state.diffLines!.filter(l => l.type === 'delete').length).toBe(1);
    });

    it('should handle mixed changes', () => {
      const parentEl = createMockElement();
      const toolCall = createToolCall();
      const state = createWriteEditBlock(parentEl, toolCall);

      const diffData: ToolDiffData = {
        filePath: 'test.md',
        originalContent: 'line1\nold\nline3',
        newContent: 'line1\nnew1\nnew2\nline3',
      };

      updateWriteEditWithDiff(state, diffData);

      expect(state.diffLines).toBeDefined();
      // 1 delete, 2 inserts, 2 equal
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
