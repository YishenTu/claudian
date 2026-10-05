import { createMockEl, type MockElement } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import {
  createAsyncSubagentBlock,
  createSubagentBlock,
  renderStoredAsyncSubagent,
  renderStoredSubagent,
  updateAsyncSubagentBlock,
  updateSubagentBlock,
} from '@/features/chat/subagents/SubagentRenderer';

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
    it('should toggle expand/collapse on header click', () => {
      const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

      // Initially collapsed
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');

      expect(state.headerEl.getAttribute('role')).toBe('button');
      expect(state.headerEl.getAttribute('tabindex')).toBe('0');
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
      expect(state.headerEl.getAttribute('aria-label')).toContain('click to expand');

      // Trigger click
      (state.headerEl as any).click();

      // Should be expanded
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);
      expect((state.contentEl as any).hasClass('claudian-hidden')).toBe(false);
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');

      // Click again to collapse
      (state.headerEl as any).click();
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect((state.contentEl as any).style.display).toBe('none');
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
    });

    it('should show description in label', () => {
      const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'My task description' } });

      expect(state.labelEl.textContent).toBe('My task description');
    });

    it('should not show a tool count badge in the header', () => {
      const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

      expect(getTextByClass(state.wrapperEl as any, 'claudian-subagent-count')).toEqual([]);
    });
  });

  describe('renderStoredSubagent', () => {
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

      expect(headerEl.getAttribute('aria-expanded')).toBe('false');

      // Click to expand
      headerEl.click();
      expect((wrapperEl as any).hasClass('expanded')).toBe(true);
      expect(contentEl.hasClass('claudian-hidden')).toBe(false);
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
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    // Enter expands the registered header.
    const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
    (state.headerEl as any).dispatchEvent({ type: 'keydown', ...enterEvent });

    // The handler should have been called and expanded
    expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
    expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);

    // Space to collapse
    const spaceEvent = { key: ' ', preventDefault: jest.fn() };
    (state.headerEl as any).dispatchEvent({ type: 'keydown', ...spaceEvent });

    expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
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
    it('should toggle expansion on repeated clicks', () => {
      const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Test task' } });

      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(false);
      expect(state.headerEl.getAttribute('aria-label')).toContain('click to expand');

      // Click to expand
      (state.headerEl as any).click();
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
      expect((state.wrapperEl as any).hasClass('expanded')).toBe(true);

      // Click to collapse
      (state.headerEl as any).click();
      expect(state.headerEl.getAttribute('aria-expanded')).toBe('false');
    });

    it('should expand when Enter key is pressed', () => {
      const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Test' } });

      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      (state.headerEl as any).dispatchEvent({ type: 'keydown', ...enterEvent });

      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
    });

    it('should expand when Space key is pressed', () => {
      const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Test' } });

      const spaceEvent = { key: ' ', preventDefault: jest.fn() };
      (state.headerEl as any).dispatchEvent({ type: 'keydown', ...spaceEvent });

      expect(state.headerEl.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('shows label immediately and initializing status text', () => {
    const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Background job' } });

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Initializing');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['async', 'pending']));
  });

  it('shows prompt in content and keeps label visible while running', () => {
    const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-2', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Background job', prompt: 'Do the work' } });

    updateAsyncSubagentBlock(state, { ...state.info, agentId: 'agent-xyz', asyncStatus: 'running' });

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Running in background');
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-prompt-text')[0];
    expect(contentText).toContain('Do the work');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['running', 'async']));
  });

  it('finalizes to completed and reveals description', () => {
    const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-3', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Background job' } });
    state.info.toolCalls.push(
      {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'a.md' },
        status: 'completed',
        result: 'A',
        isExpanded: false,
      },
      {
        id: 'tool-2',
        name: 'Grep',
        input: { pattern: 'x' },
        status: 'completed',
        result: 'B',
        isExpanded: false,
      }
    );
    updateAsyncSubagentBlock(state, { ...state.info, agentId: 'agent-complete', asyncStatus: 'running' });

    (setIcon as jest.Mock).mockClear();
    updateAsyncSubagentBlock(state, { ...state.info, result: 'all done', status: 'completed', asyncStatus: 'completed' });

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('');
    expect((state.wrapperEl as any).hasClass('done')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-result-output')[0];
    expect(contentText).toBe('all done');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('check');
  });

  it('finalizes to error and displays result text', () => {
    const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-4', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Background job' } });
    updateAsyncSubagentBlock(state, { ...state.info, agentId: 'agent-error', asyncStatus: 'running' });

    (setIcon as jest.Mock).mockClear();
    updateAsyncSubagentBlock(state, { ...state.info, result: 'failure happened', status: 'error', asyncStatus: 'error' });

    expect(state.statusTextEl.textContent).toBe('Error');
    expect((state.wrapperEl as any).hasClass('error')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-result-output')[0];
    expect(contentText).toBe('failure happened');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('x');
  });

  it('marks async subagent as orphaned', () => {
    const state = createAsyncSubagentBlock(parentEl as any, { id: 'task-5', status: 'running', toolCalls: [], isExpanded: false, mode: 'async', asyncStatus: 'pending', ...{ description: 'Background job' } });

    updateAsyncSubagentBlock(state, { ...state.info, status: 'error', asyncStatus: 'orphaned' });

    expect(state.statusTextEl.textContent).toBe('Orphaned');
    expect((state.wrapperEl as any).hasClass('orphaned')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-result-output')[0];
    expect(contentText).toContain('Conversation ended before task completed');
  });

  describe('renderStoredAsyncSubagent', () => {
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
      expect(wrapperEl).toBeDefined();
      expect((wrapperEl as any).hasClass('claudian-subagent-list')).toBe(true);
      const headerEl = (wrapperEl as any).children[0];
      expect(headerEl.getAttribute('aria-label')).toContain('click to expand');

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
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-result-output')[0];
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
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-result-output')[0];
      expect(contentText).toContain('Conversation ended before task completed');
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
      const contentText = getTextByClass(wrapperEl as any, 'claudian-subagent-prompt-text')[0];
      expect(contentText).toContain('Do some work');
    });

    it('renders pending status consistently with live cards', () => {
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

      // Pending cards retain their initializing state.
      expect((wrapperEl as any).hasClass('pending')).toBe(true);
    });
  });
});

describe('tool snapshots', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('retains distinct tool calls without rendering a header count', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    const toolCall1: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, toolCall1] });
    expect(state.info.toolCalls).toHaveLength(1);
    expect(getTextByClass(state.wrapperEl as any, 'claudian-subagent-count')).toEqual([]);

    const toolCall2: ToolCallInfo = {
      id: 'tool-2',
      name: 'Grep',
      input: { pattern: 'test' },
      status: 'running',
      isExpanded: false,
    };
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, toolCall2] });

    expect(state.info.toolCalls).toHaveLength(2);
    expect(getTextByClass(state.wrapperEl as any, 'claudian-subagent-count')).toEqual([]);
  });

  it('updates the same tool row from successive snapshots', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, {
      id: 'tool-1',
      name: 'Write',
      input: {},
      status: 'running',
      isExpanded: false,
    }] });

    updateSubagentBlock(state, { ...state.info, toolCalls: [{
      id: 'tool-1',
      name: 'Write',
      input: { file_path: 'notes.md' },
      status: 'running',
      isExpanded: false,
    }] });

    expect(state.info.toolCalls).toHaveLength(1);
    expect(state.info.toolCalls[0]).toEqual(
      expect.objectContaining({
        id: 'tool-1',
        input: { file_path: 'notes.md' },
      })
    );
    expect(getTextByClass(state.wrapperEl as any, 'claudian-subagent-count')).toEqual([]);
    expect(getTextByClass(state.toolsContainerEl as any, 'claudian-subagent-tool-name')).toEqual(['Write']);
    expect(getTextByClass(state.toolsContainerEl as any, 'claudian-subagent-tool-summary')).toEqual(['notes.md']);
  });
});

describe('tool result snapshots', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('updates tool call status in state', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, toolCall] });

    const updatedToolCall: ToolCallInfo = {
      ...toolCall,
      status: 'completed',
      result: 'File contents here',
    };
    updateSubagentBlock(state, { ...state.info, toolCalls: [updatedToolCall] });

    expect(state.info.toolCalls[0].status).toBe('completed');
  });

  it('removes tool rows absent from the next snapshot', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    const toolCall: ToolCallInfo = {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    };
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, toolCall] });

    updateSubagentBlock(state, { ...state.info, toolCalls: [] });

    expect(state.toolElements.size).toBe(0);
  });
});

describe('terminal snapshots', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl('div');
  });

  it('sets status to completed and adds done class', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    (setIcon as jest.Mock).mockClear();
    updateSubagentBlock(state, { ...state.info, result: 'All done', status: 'completed' });

    expect(state.info.status).toBe('completed');
    expect(state.info.result).toBe('All done');
    expect((state.wrapperEl as any).hasClass('done')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');
  });

  it('sets status to error and adds error class', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    (setIcon as jest.Mock).mockClear();
    updateSubagentBlock(state, { ...state.info, result: 'Something failed', status: 'error' });

    expect(state.info.status).toBe('error');
    expect(state.info.result).toBe('Something failed');
    expect((state.wrapperEl as any).hasClass('error')).toBe(true);
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    const errorText = getTextByClass(state.contentEl as any, 'claudian-subagent-result-output')[0];
    expect(errorText).toBe('Something failed');
  });

  it('shows result section text after a task with tools', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    // Add a tool call first to populate content
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: 'test.md' },
      status: 'running',
      isExpanded: false,
    }] });

    updateSubagentBlock(state, { ...state.info, result: 'Done', status: 'completed' });

    const doneText = getTextByClass(state.contentEl as any, 'claudian-subagent-result-output')[0];
    expect(doneText).toBe('Done');
  });

  it('does not restore a tool count badge after finalization', () => {
    const state = createSubagentBlock(parentEl as any, { id: 'task-1', status: 'running', toolCalls: [], isExpanded: false, ...{ description: 'Test task' } });

    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, {
      id: 'tool-1',
      name: 'Read',
      input: {},
      status: 'running',
      isExpanded: false,
    }] });
    updateSubagentBlock(state, { ...state.info, toolCalls: [...state.info.toolCalls, {
      id: 'tool-2',
      name: 'Grep',
      input: {},
      status: 'running',
      isExpanded: false,
    }] });

    updateSubagentBlock(state, { ...state.info, result: 'Done', status: 'completed' });

    expect(getTextByClass(state.wrapperEl as any, 'claudian-subagent-count')).toEqual([]);
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
    const doneText = getTextByClass(wrapperEl as any, 'claudian-subagent-result-output')[0];
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
    const errorText = getTextByClass(wrapperEl as any, 'claudian-subagent-result-output')[0];
    expect(errorText).toBe('ERROR');
  });

  it('keeps running stored subagents free of terminal classes', () => {
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

  it('renders running subagent tool call with expanded-style result', () => {
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
    const resultTexts = getTextByClass(contentEl, 'claudian-tool-line');
    expect(resultTexts.length).toBe(1);
    expect(resultTexts[0]).toContain('File contents here');
  });

  it('does not render a tool count badge for stored subagents', () => {
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

    expect(getTextByClass(wrapperEl as any, 'claudian-subagent-count')).toEqual([]);
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
