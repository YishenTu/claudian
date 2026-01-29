import { createMockEl, type MockElement } from '@test/helpers/mockElement';
import { setIcon } from 'obsidian';

import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import {
  addSubagentToolCall,
  createAsyncSubagentBlock,
  createSubagentBlock,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  markAsyncSubagentOrphaned,
  renderStoredAsyncSubagent,
  renderStoredSubagent,
  updateAsyncSubagentRunning,
  updateSubagentToolResult,
} from '@/features/chat/rendering/SubagentRenderer';

const getTextByClass = (el: MockElement, cls: string): string[] => {
  const results: string[] = [];
  const visit = (node: MockElement) => {
    if (node.hasClass(cls)) {
      results.push(node.textContent);
    }
    node.children.forEach(visit);
  };
  visit(el);
  return results;
};

describe('Sync Subagent Renderer', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  describe('createSubagentBlock', () => {
    it('should start collapsed by default', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.info.isExpanded).toBe(false);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect((state.contentEl as any).style.display).toBe('none');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.headerEl.getAttribute('role')).toBe('button');
      expect(state.headerEl.getAttribute('tabindex')).toBe('0');
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
      expect(state.headerEl.getAttribute('aria-label')).toContain('click to expand');
    });

    it('should toggle expand/collapse on header click', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      // Initially collapsed
      expect(state.info.isExpanded).toBe(false);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');

      // Trigger click
      (state.headerEl as any).click();

      // Should be expanded
      expect(state.info.isExpanded).toBe(true);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
      expect((state.contentEl as any).style.display).toBe('block');

      // Click again to collapse
      (state.headerEl as any).click();
      expect(state.info.isExpanded).toBe(false);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');
    });

    it('should update aria-expanded on toggle', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      // Initially collapsed
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');

      // Expand
      (state.headerEl as any).click();
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');

      // Collapse
      (state.headerEl as any).click();
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
    });

    it('should show description in label', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'My task description' });

      expect(state.labelEl.textContent).toBe('My task description');
    });

    it('should show tool count badge', () => {
      const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.countEl.textContent).toBe('0 tool uses');
    });
  });

  describe('renderStoredSubagent', () => {
    it('should start collapsed by default', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
      };

      const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
      };

      const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

      const headerEl = (wrapperEl as any).children[0];
      expect(headerEl.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
      };

      const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

      const contentEl = (wrapperEl as any).children[1];
      expect(contentEl.style.display).toBe('none');
    });

    it('should toggle expand/collapse on click', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
      };

      const wrapperEl = renderStoredSubagent(parentEl as any, subagent);
      const headerEl = (wrapperEl as any).children[0];
      const contentEl = (wrapperEl as any).children[1];

      // Initially collapsed
      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
      expect(contentEl.style.display).toBe('none');

      // Click to expand
      headerEl.click();
      expect((wrapperEl as any).hasClass('expanded')).toBe(true);
      expect(contentEl.style.display).toBe('block');
      expect(headerEl.getAttribute('aria-expanded')).toBe('true');

      // Click to collapse
      headerEl.click();
      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
      expect(contentEl.style.display).toBe('none');
      expect(headerEl.getAttribute('aria-expanded')).toBe('false');
    });
  });
});

describe('keyboard navigation', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('should support keyboard navigation (Enter/Space) on createSubagentBlock', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    // Simulate keydown event
    const keydownHandlers: Array<(e: any) => void> = [];
    const originalAddEventListener = state.headerEl.addEventListener;
    state.headerEl.addEventListener = (event: string, handler: (e: any) => void) => {
      if (event === 'keydown') {
        keydownHandlers.push(handler);
      }
      originalAddEventListener.call(state.headerEl, event, handler);
    };

    // Re-check - the handler should already be registered
    // We need to dispatch a keydown event
    const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
    (state.headerEl as any).dispatchEvent({ type: 'keydown', ...enterEvent });

    // The handler should have been called and expanded
    expect(state.info.isExpanded).toBe(true);
    expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);

    // Space to collapse
    const spaceEvent = { key: ' ', preventDefault: jest.fn() };
    (state.headerEl as any).dispatchEvent({ type: 'keydown', ...spaceEvent });

    expect(state.info.isExpanded).toBe(false);
    expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
  });

  it('should support keyboard navigation (Enter/Space) on renderStoredSubagent', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Test task',
      status: 'completed',
      toolCalls: [],
      isExpanded: false,
    };

    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);
    const headerEl = (wrapperEl as any).children[0];

    // Simulate Enter key
    const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
    headerEl.dispatchEvent({ type: 'keydown', ...enterEvent });

    expect((wrapperEl as any).hasClass('expanded')).toBe(true);

    // Simulate Space key to collapse
    const spaceEvent = { key: ' ', preventDefault: jest.fn() };
    headerEl.dispatchEvent({ type: 'keydown', ...spaceEvent });

    expect((wrapperEl as any).hasClass('expanded')).toBe(false);
  });
});

describe('Async Subagent Renderer', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  describe('inline display behavior', () => {
    it('should start collapsed', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.info.isExpanded).toBe(false);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
    });

    it('should have aria-label indicating expand action', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      expect(state.headerEl.getAttribute('aria-label')).toContain('click to expand');
    });

    it('should expand content when header is clicked', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      // Initially collapsed
      expect(state.info.isExpanded).toBe(false);

      // Trigger click to expand
      (state.headerEl as any).click();

      expect(state.info.isExpanded).toBe(true);
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
    });

    it('should toggle expansion on repeated clicks', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

      // Click to expand
      (state.headerEl as any).click();
      expect(state.info.isExpanded).toBe(true);

      // Click to collapse
      (state.headerEl as any).click();
      expect(state.info.isExpanded).toBe(false);
    });

    it('should expand when Enter key is pressed', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test' });

      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      (state.headerEl as any).dispatchEvent({ type: 'keydown', ...enterEvent });

      expect(state.info.isExpanded).toBe(true);
    });

    it('should expand when Space key is pressed', () => {
      const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Test' });

      const spaceEvent = { key: ' ', preventDefault: jest.fn() };
      (state.headerEl as any).dispatchEvent({ type: 'keydown', ...spaceEvent });

      expect(state.info.isExpanded).toBe(true);
    });
  });

  it('shows label immediately and initializing status text', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Background job' });

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Initializing');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['async', 'pending']));
  });

  it('shows prompt in content and keeps label visible while running', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-2', { description: 'Background job', prompt: 'Do the work' });

    updateAsyncSubagentRunning(state, 'agent-xyz');

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Running in background');
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('Do the work');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['running', 'async']));
  });

  it('finalizes to completed and reveals description', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-3', { description: 'Background job' });
    updateAsyncSubagentRunning(state, 'agent-complete');

    (setIcon as jest.Mock).mockClear();
    finalizeAsyncSubagent(state, 'all done', false);

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('');
    expect((state.wrapperEl as any).hasClass('done')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toBe('DONE');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('check');
  });

  it('finalizes to error and truncates error message', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-4', { description: 'Background job' });
    updateAsyncSubagentRunning(state, 'agent-error');

    (setIcon as jest.Mock).mockClear();
    finalizeAsyncSubagent(state, 'failure happened', true);

    expect(state.statusTextEl.textContent).toBe('Error');
    expect((state.wrapperEl as any).hasClass('error')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('ERROR');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('x');
  });

  it('marks async subagent as orphaned', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-5', { description: 'Background job' });

    markAsyncSubagentOrphaned(state);

    expect(state.statusTextEl.textContent).toBe('Orphaned');
    expect((state.wrapperEl as any).hasClass('orphaned')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('Task orphaned');
  });

  describe('renderStoredAsyncSubagent', () => {
    it('should return wrapper element', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'completed',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);

      expect(wrapperEl).toBeDefined();
      expect((wrapperEl as any).hasClass('claudian-subagent-list')).toBe(true);
    });

    it('should expand content when header is clicked', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'completed',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);
      const headerEl = (wrapperEl as any).children[0];

      // Click to expand
      headerEl.click();

      expect((wrapperEl as any).hasClass('expanded')).toBe(true);
    });

    it('should expand on Enter key', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'completed',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);
      const headerEl = (wrapperEl as any).children[0];

      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      headerEl.dispatchEvent({ type: 'keydown', ...enterEvent });

      expect((wrapperEl as any).hasClass('expanded')).toBe(true);
    });

    it('should have aria-label indicating expand action', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'completed',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);
      const headerEl = (wrapperEl as any).children[0];

      expect(headerEl.getAttribute('aria-label')).toContain('click to expand');
    });

    it('should toggle expansion on repeated clicks', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Test task',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'completed',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);
      const headerEl = (wrapperEl as any).children[0];

      // Click to expand
      headerEl.click();
      expect((wrapperEl as any).hasClass('expanded')).toBe(true);

      // Click to collapse
      headerEl.click();
      expect((wrapperEl as any).hasClass('expanded')).toBe(false);
    });

    it('renders error status correctly', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Failed task',
        status: 'error',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'error',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);

      expect((wrapperEl as any).hasClass('error')).toBe(true);
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-done-text')[0];
      expect(contentText).toBe('ERROR');
    });

    it('renders orphaned status correctly', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Lost task',
        status: 'error',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'orphaned',
      };

      (setIcon as jest.Mock).mockClear();
      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);

      expect((wrapperEl as any).hasClass('error')).toBe(true);
      expect((wrapperEl as any).hasClass('orphaned')).toBe(true);
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-done-text')[0];
      expect(contentText).toContain('Task orphaned');
      // Should use alert-circle icon
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'alert-circle');
    });

    it('renders running status with prompt', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Running task',
        status: 'running',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'running',
        prompt: 'Do some work',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);

      expect((wrapperEl as any).hasClass('running')).toBe(true);
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-done-text')[0];
      expect(contentText).toContain('Do some work');
    });

    it('renders pending status as running', () => {
      const subagent: SubagentInfo = {
        id: 'task-1',
        description: 'Pending task',
        status: 'running',
        toolCalls: [],
        isExpanded: false,
        mode: 'async',
        asyncStatus: 'pending',
      };

      const wrapperEl = renderStoredAsyncSubagent(parentEl as any, subagent);

      // pending maps to running display status
      expect((wrapperEl as any).hasClass('running')).toBe(true);
    });
  });
});

describe('addSubagentToolCall', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('adds tool call to state and updates count', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };

    addSubagentToolCall(state, toolCall);

    expect(state.info.toolCalls).toHaveLength(1);
    expect(state.countEl.textContent).toBe('1 tool uses');
  });

  it('clears previous content and renders new tool item', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall1: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall1);

    const toolCall2: ToolCallInfo = {
      id: 'tool-2',
      name: 'Grep',
      input: { pattern: 'test' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall2);

    expect(state.info.toolCalls).toHaveLength(2);
    expect(state.countEl.textContent).toBe('2 tool uses');
    // currentResultEl should be cleared when new tool is added
    expect(state.currentResultEl).toBeNull();
  });

  it('sets currentToolEl with tool id dataset', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-abc',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall);

    expect(state.currentToolEl).not.toBeNull();
    expect((state.currentToolEl as any).dataset.toolId).toBe('tool-abc');
  });
});

describe('updateSubagentToolResult', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('updates tool call status in state', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall);

    const updatedToolCall: ToolCallInfo = {
      ...toolCall,
      status: 'completed',
      result: 'File contents here',
    };
    updateSubagentToolResult(state, 'tool-1', updatedToolCall);

    expect(state.info.toolCalls[0].status).toBe('completed');
  });

  it('creates result element when tool has result', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall);

    const updatedToolCall: ToolCallInfo = {
      ...toolCall,
      status: 'completed',
      result: 'File contents',
    };
    updateSubagentToolResult(state, 'tool-1', updatedToolCall);

    expect(state.currentResultEl).not.toBeNull();
  });

  it('updates existing result element on subsequent calls', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall);

    // First result
    updateSubagentToolResult(state, 'tool-1', { ...toolCall, status: 'completed', result: 'First result' });
    const firstResultEl = state.currentResultEl;

    // Update result
    updateSubagentToolResult(state, 'tool-1', { ...toolCall, status: 'completed', result: 'Updated result' });

    // Should reuse the same result element
    expect(state.currentResultEl).toBe(firstResultEl);
  });

  it('ignores update for non-matching tool ID', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    addSubagentToolCall(state, toolCall);

    // Update with different ID - should not crash
    updateSubagentToolResult(state, 'tool-999', { ...toolCall, id: 'tool-999', status: 'completed' });

    // State should remain unchanged for the rendered tool
    expect(state.currentResultEl).toBeNull();
  });
});

describe('finalizeSubagentBlock', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('sets status to completed and adds done class', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    (setIcon as jest.Mock).mockClear();
    finalizeSubagentBlock(state, 'All done', false);

    expect(state.info.status).toBe('completed');
    expect(state.info.result).toBe('All done');
    expect((state.wrapperEl as any).hasClass('done')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');
  });

  it('sets status to error and adds error class', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    (setIcon as jest.Mock).mockClear();
    finalizeSubagentBlock(state, 'Something failed', true);

    expect(state.info.status).toBe('error');
    expect(state.info.result).toBe('Something failed');
    expect((state.wrapperEl as any).hasClass('error')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
  });

  it('clears content and shows DONE text', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    // Add a tool call first to populate content
    addSubagentToolCall(state, {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    });

    finalizeSubagentBlock(state, 'Done', false);

    expect(state.currentToolEl).toBeNull();
    expect(state.currentResultEl).toBeNull();
    const doneText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(doneText).toBe('DONE');
  });

  it('shows ERROR text when isError is true', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    finalizeSubagentBlock(state, 'Error occurred', true);

    const errorText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(errorText).toBe('ERROR');
  });

  it('updates tool count badge after finalization', () => {
    const state = createSubagentBlock(parentEl as any, 'task-1', { description: 'Test task' });

    addSubagentToolCall(state, {
      id: 'tool-1',
      name: 'Read',
      input: {},
      status: 'running',
      isExpanded: false,
    });
    addSubagentToolCall(state, {
      id: 'tool-2',
      name: 'Grep',
      input: {},
      status: 'running',
      isExpanded: false,
    });

    finalizeSubagentBlock(state, 'Done', false);

    expect(state.countEl.textContent).toBe('2 tool uses');
  });
});

describe('renderStoredSubagent status variants', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('renders completed subagent with done class and check icon', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Completed task',
      status: 'completed',
      toolCalls: [],
      isExpanded: false,
    };

    (setIcon as jest.Mock).mockClear();
    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

    expect((wrapperEl as any).hasClass('done')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');
    const doneText = getTextByClass(wrapperEl as any, 'claudian-subagent-done-text')[0];
    expect(doneText).toBe('DONE');
  });

  it('renders error subagent with error class and x icon', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Failed task',
      status: 'error',
      toolCalls: [],
      isExpanded: false,
    };

    (setIcon as jest.Mock).mockClear();
    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

    expect((wrapperEl as any).hasClass('error')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    const errorText = getTextByClass(wrapperEl as any, 'claudian-subagent-done-text')[0];
    expect(errorText).toBe('ERROR');
  });

  it('renders running subagent with last tool call', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Running task',
      status: 'running',
      toolCalls: [
        { id: 'tool-1', name: 'Read', input: { file_path: 'test.md' }, status: 'completed', isExpanded: false },
        { id: 'tool-2', name: 'Grep', input: { pattern: 'test' }, status: 'running', isExpanded: false },
      ],
      isExpanded: false,
    };

    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

    // Should not have done or error class
    expect((wrapperEl as any).hasClass('done')).toBe(false);
    expect((wrapperEl as any).hasClass('error')).toBe(false);
  });

  it('renders running subagent tool call with result', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Running task',
      status: 'running',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: 'test.md' },
          status: 'completed',
          result: 'File contents here',
          isExpanded: false,
        },
      ],
      isExpanded: false,
    };

    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);
    const contentEl = (wrapperEl as any).children[1]; // content area

    // Should show result text
    const resultTexts = getTextByClass(contentEl, 'claudian-subagent-result-text');
    expect(resultTexts.length).toBe(1);
    expect(resultTexts[0]).toContain('File contents here');
  });

  it('shows correct tool count in badge', () => {
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: 'Task with tools',
      status: 'completed',
      toolCalls: [
        { id: 'tool-1', name: 'Read', input: {}, status: 'completed', isExpanded: false },
        { id: 'tool-2', name: 'Grep', input: {}, status: 'completed', isExpanded: false },
        { id: 'tool-3', name: 'Edit', input: {}, status: 'completed', isExpanded: false },
      ],
      isExpanded: false,
    };

    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

    const countTexts = getTextByClass(wrapperEl as any, 'claudian-subagent-count');
    expect(countTexts[0]).toBe('3 tool uses');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(50);
    const subagent: SubagentInfo = {
      id: 'task-1',
      description: longDesc,
      status: 'completed',
      toolCalls: [],
      isExpanded: false,
    };

    const wrapperEl = renderStoredSubagent(parentEl as any, subagent);

    const labelTexts = getTextByClass(wrapperEl as any, 'claudian-subagent-label');
    expect(labelTexts[0]).toBe('A'.repeat(40) + '...');
  });
});
