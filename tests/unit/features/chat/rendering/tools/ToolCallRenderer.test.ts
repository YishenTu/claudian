import { createMockEl } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import {
  renderStoredToolCall,
  renderToolCall,
  updateToolCallResult,
} from '@/features/chat/rendering/tools/ToolCallRenderer';

jest.mock('obsidian', () => ({
  Platform: { resourcePathPrefix: 'app://local/' },
  setIcon: jest.fn(),
}));

// Helper to create a basic tool call
function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tool-123',
    name: 'Read',
    input: { file_path: '/test/file.md' },
    status: 'running',
    ...overrides,
  };
}

describe('ToolCallRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('renderToolCall', () => {
    it('should start expanded when requested', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();


      const toolEl = renderToolCall(parentEl, toolCall, { initiallyExpanded: true });
      const header = toolEl.querySelector('.claudian-tool-header');
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(toolCall.isExpanded).toBe(true);
      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content?.hasClass('claudian-hidden')).toBe(false);
      expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    it('builds Bash-specific classes, icon, command content, and toggle state', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'Bash',
        input: { command: 'npm test' },
      });
      const toolEl = renderToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.claudian-tool-header');
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(toolEl.hasClass('claudian-tool-call-bash')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'terminal');

      (header as HTMLElement | null)?.click();
      expect(toolCall.isExpanded).toBe(true);
      expect(toolEl.querySelector('.claudian-tool-bash-command')?.textContent).toBe('$ npm test');
      expect(content?.hasClass('claudian-hidden')).toBe(false);
    });

    it('builds TodoWrite preview, content, icon, and toggle handlers', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Task', status: 'in_progress', activeForm: 'Working' }],
        },
      });
      const toolEl = renderToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.claudian-tool-header');
      const currentTask = toolEl.querySelector('.claudian-tool-current');
      const status = toolEl.querySelector('.claudian-tool-status');
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(currentTask?.textContent).toBe('Working');
      expect(content?.hasClass('claudian-tool-content-todo')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'list-checks');

      (header as HTMLElement | null)?.click();
      expect(toolCall.isExpanded).toBe(true);
      expect(currentTask?.hasClass('claudian-hidden')).toBe(true);
      expect(status?.hasClass('claudian-hidden')).toBe(true);
    });

    it('builds AskUserQuestion content and renders resolved answers through its dedicated updater', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        input: { questions: [{ id: 'color', question: 'Color?' }] },
        resolvedAnswers: { color: 'Blue' },
      });

      const toolEl = renderToolCall(parentEl, toolCall);
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(content?.hasClass('claudian-tool-content-ask')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'help-circle');

      toolCall.status = 'completed';
      toolCall.result = 'answered';
      updateToolCallResult(toolEl, toolCall);
      expect(toolEl.querySelector('.claudian-ask-review-a-text')?.textContent).toBe('Blue');
    });
  });

  describe('renderStoredToolCall', () => {
    it('should show completed status icon', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      renderStoredToolCall(parentEl, toolCall);

      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');
    });

    it('should show error status icon', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'error' });

      renderStoredToolCall(parentEl, toolCall);

      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    });

    it('renders AskUserQuestion answers from result text when resolvedAnswers is missing', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'completed',
        input: { questions: [{ question: 'Color?' }] },
        result: '"Color?"="Blue"',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const answerEls = toolEl.querySelectorAll('.claudian-ask-review-a-text');

      expect(answerEls).toHaveLength(1);
      expect(answerEls[0].textContent).toBe('Blue');
    });

    it('renders AskUserQuestion answers by stable question id', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'completed',
        input: { questions: [{ id: 'q1', question: 'Color?' }] },
        result: '{"answers":{"q1":{"answers":["Blue"]}}}',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const answerEls = toolEl.querySelectorAll('.claudian-ask-review-a-text');

      expect(answerEls).toHaveLength(1);
      expect(answerEls[0].textContent).toBe('Blue');
    });

    it('renders AskUserQuestion options during fallback state', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'AskUserQuestion',
        status: 'running',
        input: {
          questions: [{
            question: 'Title timing?',
            options: [
              { label: 'Non-blocking', description: 'Generate title later.' },
              { label: 'Blocking', description: 'Wait for title first.' },
            ],
            multiSelect: true,
          }],
        },
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const labelEls = toolEl.querySelectorAll('.claudian-ask-item-label');
      const descEls = toolEl.querySelectorAll('.claudian-ask-item-desc');
      const checkEls = toolEl.querySelectorAll('.claudian-ask-check');

      expect(Array.from(labelEls, el => el.textContent)).toEqual(['Non-blocking', 'Blocking']);
      expect(Array.from(descEls, el => el.textContent)).toEqual(['Generate title later.', 'Wait for title first.']);
      expect(checkEls).toHaveLength(2);
    });
  });

  describe('updateToolCallResult', () => {
    it('should update status indicator', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'tool-1' });


      const toolEl = renderToolCall(parentEl, toolCall);
      expect(toolEl.dataset.toolId).toBe('tool-1');
      const header = toolEl.querySelector('.claudian-tool-header');
      expect(header?.getAttribute('role')).toBe('button');
      expect(header?.getAttribute('tabindex')).toBe('0');
      expect(toolCall.isExpanded).toBe(false);

      // Update with completed result
      toolCall.status = 'completed';
      toolCall.result = 'Success';
      updateToolCallResult(toolEl, toolCall);

      const statusEl = toolEl.querySelector('.claudian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('shows raw AskUserQuestion result when answers cannot be parsed', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Color?' }] },
      });


      const toolEl = renderToolCall(parentEl, toolCall);
      toolCall.status = 'completed';
      toolCall.result = 'Answer submitted successfully.';

      updateToolCallResult(toolEl, toolCall);

      const promptEl = toolEl.querySelector('.claudian-ask-review-prompt');
      expect(promptEl?.textContent).toBe('Answer submitted successfully.');
    });
  });


  describe('updateToolCallResult for TodoWrite', () => {
    it('should update todo status and content', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'todo-1',
        name: 'TodoWrite',
        input: {
          todos: [
            { status: 'in_progress', content: 'Task 1', activeForm: 'Working' },
          ],
        },
      });


      const toolEl = renderToolCall(parentEl, toolCall);

      // Update with all completed
      toolCall.input = {
        todos: [
          { status: 'completed', content: 'Task 1', activeForm: 'Done' },
        ],
      };
      updateToolCallResult(toolEl, toolCall);

      const statusEl = parentEl.querySelector('.claudian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('should mark an explicit empty todo snapshot as completed', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'todo-empty',
        name: 'TodoWrite',
        input: { todos: [] },
        status: 'completed',
      });


      const toolEl = renderToolCall(parentEl, toolCall);
      updateToolCallResult(toolEl, toolCall);

      const statusEl = parentEl.querySelector('.claudian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('should do nothing for non-existent tool id', () => {

      updateToolCallResult(undefined, createToolCall());
      expect(() => updateToolCallResult(undefined, createToolCall())).not.toThrow();
    });
  });

  describe('renderStoredToolCall for TodoWrite', () => {
    it.each([
      {
        label: 'todo items',
        input: {
          todos: [
            { status: 'completed', content: 'Task 1', activeForm: 'Task 1' },
            { status: 'pending', content: 'Task 2', activeForm: 'Task 2' },
          ],
        },
        expectedTasks: ['Task 1', 'Task 2'],
        expectedFallback: null,
      },
      { label: 'missing todos', input: {}, expectedTasks: [], expectedFallback: 'Tasks updated' },
      { label: 'invalid todos', input: { todos: 'invalid' }, expectedTasks: [], expectedFallback: 'Tasks updated' },
    ])('renders $label through the stored tool boundary', ({ input, expectedTasks, expectedFallback }) => {
      const toolEl = renderStoredToolCall(createMockEl(), createToolCall({
        name: 'TodoWrite',
        status: 'completed',
        input,
      }));
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(toolEl).toBeDefined();
      expect(content?.hasClass('claudian-todo-list-container')).toBe(true);
      expect(Array.from(content!.querySelectorAll('.claudian-todo-text'), el => el.textContent))
        .toEqual(expectedTasks);
      expect(content?.querySelector('.claudian-tool-result-item')?.textContent ?? null).toBe(expectedFallback);
    });
  });
});
