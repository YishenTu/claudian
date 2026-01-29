import { createMockEl } from '@test/helpers/mockElement';
import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import {
  areAllTodosCompleted,
  formatToolInput,
  getCurrentTask,
  getToolLabel,
  isBlockedToolResult,
  renderReadResult,
  renderResultLines,
  renderStoredToolCall,
  renderTodoWriteResult,
  renderToolCall,
  renderWebSearchResult,
  setToolIcon,
  truncateResult,
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
    it('should start collapsed by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(toolCall.isExpanded).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      const header = (toolEl as any)._children[0];
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      const content = (toolEl as any)._children[1];
      expect(content.style.display).toBe('none');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);

      const header = (toolEl as any)._children[0];
      expect(header.getAttribute('role')).toBe('button');
      expect(header.getAttribute('tabindex')).toBe('0');
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should toggle expand/collapse on header click', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      const header = (toolEl as any)._children[0];
      const content = (toolEl as any)._children[1];

      // Initially collapsed
      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');
      expect(toolCall.isExpanded).toBe(false);

      // Trigger click
      const clickHandlers = header._eventListeners.get('click') || [];
      expect(clickHandlers.length).toBeGreaterThan(0);
      clickHandlers[0]();

      // Should be expanded
      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content.style.display).toBe('block');
      expect(toolCall.isExpanded).toBe(true);

      // Click again to collapse
      clickHandlers[0]();
      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');
      expect(toolCall.isExpanded).toBe(false);
    });

    it('should update aria-expanded on toggle', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      const header = (toolEl as any)._children[0];

      // Initially collapsed
      expect(header.getAttribute('aria-expanded')).toBe('false');

      // Expand
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Collapse
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

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
  });

  describe('renderStoredToolCall', () => {
    it('should start collapsed by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const toolEl = renderStoredToolCall(parentEl, toolCall);

      expect(toolEl.hasClass('expanded')).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const toolEl = renderStoredToolCall(parentEl, toolCall);

      const header = (toolEl as any)._children[0];
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const toolEl = renderStoredToolCall(parentEl, toolCall);

      const content = (toolEl as any)._children[1];
      expect(content.style.display).toBe('none');
    });

    it('should toggle expand/collapse on click', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = (toolEl as any)._children[0];
      const content = (toolEl as any)._children[1];

      // Initially collapsed
      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');

      // Click to expand
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();

      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content.style.display).toBe('block');
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Click to collapse
      clickHandlers[0]();
      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

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
  });

  describe('keyboard navigation', () => {
    it('should support keyboard navigation (Enter/Space) on renderToolCall', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      const header = (toolEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      expect(keydownHandlers.length).toBeGreaterThan(0);

      // Simulate Enter key
      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](enterEvent);

      expect(enterEvent.preventDefault).toHaveBeenCalled();
      expect(toolEl.hasClass('expanded')).toBe(true);

      // Simulate Space key to collapse
      const spaceEvent = { key: ' ', preventDefault: jest.fn() };
      keydownHandlers[0](spaceEvent);

      expect(spaceEvent.preventDefault).toHaveBeenCalled();
      expect(toolEl.hasClass('expanded')).toBe(false);
    });

    it('should support keyboard navigation (Enter/Space) on renderStoredToolCall', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({ status: 'completed' });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = (toolEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      expect(keydownHandlers.length).toBeGreaterThan(0);

      // Simulate Enter key
      const enterEvent = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](enterEvent);

      expect(enterEvent.preventDefault).toHaveBeenCalled();
      expect(toolEl.hasClass('expanded')).toBe(true);
    });

    it('should ignore other keys', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall();
      const toolCallElements = new Map<string, HTMLElement>();

      const toolEl = renderToolCall(parentEl, toolCall, toolCallElements);
      const header = (toolEl as any)._children[0];

      const keydownHandlers = header._eventListeners.get('keydown') || [];

      // Simulate Tab key (should not toggle)
      const tabEvent = { key: 'Tab', preventDefault: jest.fn() };
      keydownHandlers[0](tabEvent);

      expect(tabEvent.preventDefault).not.toHaveBeenCalled();
      expect(toolEl.hasClass('expanded')).toBe(false);
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

  describe('formatToolInput', () => {
    it('should return file_path for Read/Write/Edit', () => {
      expect(formatToolInput('Read', { file_path: '/test.ts' })).toBe('/test.ts');
      expect(formatToolInput('Write', { file_path: '/out.ts' })).toBe('/out.ts');
      expect(formatToolInput('Edit', { file_path: '/edit.ts' })).toBe('/edit.ts');
    });

    it('should return command for Bash', () => {
      expect(formatToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
    });

    it('should return pattern for Glob/Grep', () => {
      expect(formatToolInput('Glob', { pattern: '*.ts' })).toBe('*.ts');
      expect(formatToolInput('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should return query for WebSearch', () => {
      expect(formatToolInput('WebSearch', { query: 'test' })).toBe('test');
    });

    it('should return url for WebFetch', () => {
      expect(formatToolInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
    });

    it('should return JSON for unknown tools', () => {
      const input = { key: 'value' };
      expect(formatToolInput('Unknown', input)).toBe(JSON.stringify(input, null, 2));
    });

    it('should fallback to JSON when expected field is missing', () => {
      const input = { other: 'data' };
      expect(formatToolInput('Bash', input)).toBe(JSON.stringify(input, null, 2));
    });
  });

  describe('renderResultLines', () => {
    it('should render up to maxLines lines', () => {
      const container = createMockEl();
      renderResultLines(container as unknown as HTMLElement, 'line1\nline2\nline3\nline4\nline5', 3);
      // 3 lines + 1 "more" indicator
      expect(container._children.length).toBe(4);
      expect(container._children[3].textContent).toBe('2 more lines');
    });

    it('should strip line number prefixes', () => {
      const container = createMockEl();
      renderResultLines(container as unknown as HTMLElement, '  1\u2192const x = 1;', 3);
      expect(container._children[0].textContent).toBe('const x = 1;');
    });

    it('should render all lines when within limit', () => {
      const container = createMockEl();
      renderResultLines(container as unknown as HTMLElement, 'a\nb', 5);
      expect(container._children.length).toBe(2);
    });
  });

  describe('truncateResult', () => {
    it('should truncate by length', () => {
      const long = 'x'.repeat(3000);
      const result = truncateResult(long, 20, 2000);
      expect(result.length).toBeLessThanOrEqual(2001); // 2000 chars + possible newline content
    });

    it('should truncate by line count', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
      const result = truncateResult(lines, 5, 100000);
      expect(result).toContain('more lines');
    });

    it('should return original when within limits', () => {
      const short = 'hello\nworld';
      expect(truncateResult(short)).toBe(short);
    });
  });

  describe('isBlockedToolResult', () => {
    it('should detect "blocked by blocklist"', () => {
      expect(isBlockedToolResult('Blocked by blocklist: /etc/passwd')).toBe(true);
    });

    it('should detect "outside the vault"', () => {
      expect(isBlockedToolResult('Path is outside the vault')).toBe(true);
    });

    it('should detect "access denied"', () => {
      expect(isBlockedToolResult('Access Denied for this file')).toBe(true);
    });

    it('should detect "user denied"', () => {
      expect(isBlockedToolResult('User denied the action')).toBe(true);
    });

    it('should detect "approval"', () => {
      expect(isBlockedToolResult('Requires approval from user')).toBe(true);
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

  describe('renderWebSearchResult', () => {
    it('should render links from web search result', () => {
      const container = createMockEl();
      const result = 'Links: [{"title":"Result 1","url":"https://example.com"},{"title":"Result 2","url":"https://test.com"}]';
      const rendered = renderWebSearchResult(container as unknown as HTMLElement, result, 3);
      expect(rendered).toBe(true);
      expect(container._children.length).toBe(2);
    });

    it('should show "more results" when exceeding maxItems', () => {
      const container = createMockEl();
      const links = Array.from({ length: 5 }, (_, i) => ({ title: `R${i}`, url: `https://${i}.com` }));
      const result = `Links: ${JSON.stringify(links)}`;
      renderWebSearchResult(container as unknown as HTMLElement, result, 2);
      expect(container._children.length).toBe(3); // 2 items + 1 "more"
      expect(container._children[2].textContent).toBe('3 more results');
    });

    it('should return false for non-web-search results', () => {
      const container = createMockEl();
      expect(renderWebSearchResult(container as unknown as HTMLElement, 'plain text')).toBe(false);
    });

    it('should return false for empty links array', () => {
      const container = createMockEl();
      expect(renderWebSearchResult(container as unknown as HTMLElement, 'Links: []')).toBe(false);
    });

    it('should return false for malformed JSON', () => {
      const container = createMockEl();
      expect(renderWebSearchResult(container as unknown as HTMLElement, 'Links: not-json')).toBe(false);
    });
  });

  describe('renderReadResult', () => {
    it('should show line count', () => {
      const container = createMockEl();
      renderReadResult(container as unknown as HTMLElement, 'line1\nline2\nline3');
      expect(container._children[0].textContent).toBe('3 lines read');
    });

    it('should filter empty lines', () => {
      const container = createMockEl();
      renderReadResult(container as unknown as HTMLElement, 'line1\n\n\nline2');
      expect(container._children[0].textContent).toBe('2 lines read');
    });
  });

  describe('getCurrentTask', () => {
    it('should return in_progress todo', () => {
      const input = {
        todos: [
          { status: 'completed', content: 'done', activeForm: 'Done' },
          { status: 'in_progress', content: 'working', activeForm: 'Working on it' },
        ],
      };
      expect(getCurrentTask(input)?.activeForm).toBe('Working on it');
    });

    it('should return undefined when no in_progress todo', () => {
      expect(getCurrentTask({ todos: [{ status: 'completed', content: 'a', activeForm: 'A' }] })).toBeUndefined();
    });

    it('should return undefined when no todos', () => {
      expect(getCurrentTask({})).toBeUndefined();
    });

    it('should return undefined for non-array todos', () => {
      expect(getCurrentTask({ todos: 'not an array' })).toBeUndefined();
    });
  });

  describe('areAllTodosCompleted', () => {
    it('should return true when all completed', () => {
      const input = {
        todos: [
          { status: 'completed', content: 'a', activeForm: 'A' },
          { status: 'completed', content: 'b', activeForm: 'B' },
        ],
      };
      expect(areAllTodosCompleted(input)).toBe(true);
    });

    it('should return false when some not completed', () => {
      const input = {
        todos: [
          { status: 'completed', content: 'a', activeForm: 'A' },
          { status: 'pending', content: 'b', activeForm: 'B' },
        ],
      };
      expect(areAllTodosCompleted(input)).toBe(false);
    });

    it('should return false when empty', () => {
      expect(areAllTodosCompleted({ todos: [] })).toBe(false);
    });

    it('should return false when no todos', () => {
      expect(areAllTodosCompleted({})).toBe(false);
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
