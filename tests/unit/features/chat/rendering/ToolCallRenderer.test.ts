import { createMockEl } from '@test/helpers/mockElement';
import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import {
  getToolLabel,
  getToolName,
  getToolSummary,
  isBlockedToolResult,
  renderStoredToolCall,
  renderTodoWriteResult,
  renderToolCall,
  setToolIcon,
  updateToolCallResult,
} from '@/features/chat/rendering/ToolCallRenderer';

// Mock obsidian
jest.mock('obsidian', () => ({
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
    it('should store element in toolCallElements map', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'test-id' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolCallElements.get('test-id')).toBe(toolEl);
    });

    it('should set data-tool-id on element', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'my-tool-id' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolEl.dataset.toolId).toBe('my-tool-id');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      const header = (toolEl as any)._children[0];
      expect(header.getAttribute('role')).toBe('button');
      expect(header.getAttribute('tabindex')).toBe('0');
    });

    it('should track isExpanded on toolCall object', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolCall.isExpanded).toBe(false);
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
  });

  describe('updateToolCallResult', () => {
    it('should update status indicator', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ id: 'tool-1' });
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      // Update with completed result
      toolCall.status = 'completed';
      toolCall.result = 'Success';
      updateToolCallResult('tool-1', toolCall, toolCallElements);

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
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      toolCall.status = 'completed';
      toolCall.result = 'Answer submitted successfully.';

      updateToolCallResult('ask-1', toolCall, toolCallElements);

      const resultText = toolEl.querySelector('.claudian-tool-result-text');
      expect(resultText?.textContent).toBe('Answer submitted successfully.');
    });
  });

  describe('setToolIcon', () => {
    it('should call setIcon with the resolved icon name', () => {
      const el = createMockEl() as unknown as HTMLElement;
      setToolIcon(el, 'Read');
      expect(setIcon).toHaveBeenCalledWith(el, expect.any(String));
    });

    it('should set MCP SVG for MCP tools', () => {
      const el = createMockEl();
      setToolIcon(el as unknown as HTMLElement, 'mcp__server__tool');
      // MCP tools get innerHTML set with the SVG
      expect(el.innerHTML).toContain('svg');
    });
  });

  describe('getToolLabel', () => {
    it('should label Read tool with shortened path', () => {
      expect(getToolLabel('Read', { file_path: '/a/b/c/d/e.ts' })).toBe('Read: .../d/e.ts');
    });

    it('should label Read with fallback for missing path', () => {
      expect(getToolLabel('Read', {})).toBe('Read: file');
    });

    it('should label Write tool with path', () => {
      expect(getToolLabel('Write', { file_path: 'short.ts' })).toBe('Write: short.ts');
    });

    it('should label Edit tool with path', () => {
      expect(getToolLabel('Edit', { file_path: 'file.ts' })).toBe('Edit: file.ts');
    });

    it('should label Bash tool and truncate long commands', () => {
      const shortCmd = 'npm test';
      expect(getToolLabel('Bash', { command: shortCmd })).toBe('Bash: npm test');

      const longCmd = 'a'.repeat(50);
      expect(getToolLabel('Bash', { command: longCmd })).toBe(`Bash: ${'a'.repeat(40)}...`);
    });

    it('should label Bash with fallback for missing command', () => {
      expect(getToolLabel('Bash', {})).toBe('Bash: command');
    });

    it('should label Glob tool', () => {
      expect(getToolLabel('Glob', { pattern: '**/*.ts' })).toBe('Glob: **/*.ts');
    });

    it('should label Glob with fallback', () => {
      expect(getToolLabel('Glob', {})).toBe('Glob: files');
    });

    it('should label Grep tool', () => {
      expect(getToolLabel('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
    });

    it('should label WebSearch and truncate long queries', () => {
      expect(getToolLabel('WebSearch', { query: 'short' })).toBe('WebSearch: short');

      const longQuery = 'q'.repeat(50);
      expect(getToolLabel('WebSearch', { query: longQuery })).toBe(`WebSearch: ${'q'.repeat(40)}...`);
    });

    it('should label WebFetch and truncate long URLs', () => {
      expect(getToolLabel('WebFetch', { url: 'https://x.com' })).toBe('WebFetch: https://x.com');

      const longUrl = 'https://' + 'x'.repeat(50);
      expect(getToolLabel('WebFetch', { url: longUrl })).toBe(`WebFetch: ${longUrl.substring(0, 40)}...`);
    });

    it('should label LS tool with path', () => {
      expect(getToolLabel('LS', { path: '/src' })).toBe('LS: /src');
    });

    it('should label LS with fallback', () => {
      expect(getToolLabel('LS', {})).toBe('LS: .');
    });

    it('should label TodoWrite with completion count', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolLabel('TodoWrite', { todos })).toBe('Tasks (2/3)');
    });

    it('should label TodoWrite without array', () => {
      expect(getToolLabel('TodoWrite', {})).toBe('Tasks');
    });

    it('should label Skill tool', () => {
      expect(getToolLabel('Skill', { skill: 'commit' })).toBe('Skill: commit');
    });

    it('should label Skill with fallback', () => {
      expect(getToolLabel('Skill', {})).toBe('Skill: skill');
    });

    it('should return raw name for unknown tools', () => {
      expect(getToolLabel('CustomTool', {})).toBe('CustomTool');
    });
  });

  describe('getToolName', () => {
    it('should return tool name for standard tools', () => {
      expect(getToolName('Read', {})).toBe('Read');
      expect(getToolName('Write', {})).toBe('Write');
      expect(getToolName('Bash', {})).toBe('Bash');
      expect(getToolName('Glob', {})).toBe('Glob');
    });

    it('should return Tasks with count for TodoWrite', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolName('TodoWrite', { todos })).toBe('Tasks 2/3');
      expect(getToolName('TodoWrite', {})).toBe('Tasks');
    });

    it('should return plan mode labels', () => {
      expect(getToolName('EnterPlanMode', {})).toBe('Entering plan mode');
      expect(getToolName('ExitPlanMode', {})).toBe('Plan complete');
    });
  });

  describe('getToolSummary', () => {
    it('should return filename-only for file tools', () => {
      expect(getToolSummary('Read', { file_path: '/a/b/c/file.ts' })).toBe('file.ts');
      expect(getToolSummary('Write', { file_path: '/src/index.ts' })).toBe('index.ts');
      expect(getToolSummary('Edit', { file_path: 'simple.md' })).toBe('simple.md');
    });

    it('should return empty for file tools with no path', () => {
      expect(getToolSummary('Read', {})).toBe('');
    });

    it('should return command for Bash', () => {
      expect(getToolSummary('Bash', { command: 'npm test' })).toBe('npm test');
    });

    it('should truncate long Bash commands', () => {
      const longCmd = 'a'.repeat(70);
      expect(getToolSummary('Bash', { command: longCmd })).toBe('a'.repeat(60) + '...');
    });

    it('should return pattern for Glob/Grep', () => {
      expect(getToolSummary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
      expect(getToolSummary('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should return query for WebSearch', () => {
      expect(getToolSummary('WebSearch', { query: 'test query' })).toBe('test query');
    });

    it('should return url for WebFetch', () => {
      expect(getToolSummary('WebFetch', { url: 'https://x.com' })).toBe('https://x.com');
    });

    it('should return filename for LS', () => {
      expect(getToolSummary('LS', { path: '/src/components' })).toBe('components');
    });

    it('should return skill name for Skill', () => {
      expect(getToolSummary('Skill', { skill: 'commit' })).toBe('commit');
    });

    it('should return empty for TodoWrite', () => {
      const todos = [
        { status: 'completed', activeForm: 'Done' },
        { status: 'in_progress', activeForm: 'Working on it' },
      ];
      expect(getToolSummary('TodoWrite', { todos })).toBe('');
      expect(getToolSummary('TodoWrite', {})).toBe('');
    });

    it('should return empty for AskUserQuestion', () => {
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }] })).toBe('');
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }] })).toBe('');
    });

    it('should return empty for unknown tools', () => {
      expect(getToolSummary('CustomTool', {})).toBe('');
    });
  });

  describe('isBlockedToolResult', () => {
    it.each([
      'Blocked by blocklist: /etc/passwd',
      'Path is outside the vault',
      'Access Denied for this file',
      'User denied the action',
      'Requires approval from user',
    ])('should detect blocked result: %s', (result) => {
      expect(isBlockedToolResult(result)).toBe(true);
    });

    it('should detect "deny" only when isError is true', () => {
      expect(isBlockedToolResult('deny permission', true)).toBe(true);
      expect(isBlockedToolResult('deny permission', false)).toBe(false);
      expect(isBlockedToolResult('deny permission')).toBe(false);
    });

    it('should return false for normal results', () => {
      expect(isBlockedToolResult('File content here')).toBe(false);
    });
  });

  describe('renderTodoWriteResult', () => {
    it('should render todo items', () => {
      const container = createMockEl();
      const input = {
        todos: [
          { status: 'completed', content: 'Task 1', activeForm: 'Task 1' },
          { status: 'pending', content: 'Task 2', activeForm: 'Task 2' },
        ],
      };
      renderTodoWriteResult(container as unknown as HTMLElement, input);
      expect(container.hasClass('claudian-todo-panel-content')).toBe(true);
      expect(container.hasClass('claudian-todo-list-container')).toBe(true);
    });

    it('should show fallback text when no todos array', () => {
      const container = createMockEl();
      renderTodoWriteResult(container as unknown as HTMLElement, {});
      expect(container._children[0].textContent).toBe('Tasks updated');
    });

    it('should show fallback text for non-array todos', () => {
      const container = createMockEl();
      renderTodoWriteResult(container as unknown as HTMLElement, { todos: 'invalid' });
      expect(container._children[0].textContent).toBe('Tasks updated');
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
      const toolCallElements = new Map<string, HTMLElement>();

      renderToolCall(parentEl, toolCall, toolCallElements);

      // Update with all completed
      toolCall.input = {
        todos: [
          { status: 'completed', content: 'Task 1', activeForm: 'Done' },
        ],
      };
      updateToolCallResult('todo-1', toolCall, toolCallElements);

      const statusEl = parentEl.querySelector('.claudian-tool-status');
      expect(statusEl?.hasClass('status-completed')).toBe(true);
    });

    it('should do nothing for non-existent tool id', () => {
      const toolCallElements = new Map<string, HTMLElement>();
      updateToolCallResult('nonexistent', createToolCall(), toolCallElements);
      expect(toolCallElements.size).toBe(0);
    });
  });

  describe('renderStoredToolCall for TodoWrite', () => {
    it('should render stored TodoWrite with status', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'TodoWrite',
        status: 'completed',
        input: {
          todos: [
            { status: 'completed', content: 'Task 1', activeForm: 'Done' },
          ],
        },
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      expect(toolEl).toBeDefined();
    });
  });
});
