/**
 * Tests for MessageRenderer - Stored Message Rendering
 */

import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import {
  renderStoredAsyncSubagent,
  renderStoredSubagent,
  renderStoredThinkingBlock,
  renderStoredTodoList,
  renderStoredToolCall,
  renderStoredWriteEdit,
} from '@/ui';

jest.mock('@/ui', () => ({
  renderStoredAsyncSubagent: jest.fn(),
  renderStoredSubagent: jest.fn(),
  renderStoredThinkingBlock: jest.fn(),
  renderStoredTodoList: jest.fn(),
  renderStoredToolCall: jest.fn(),
  renderStoredWriteEdit: jest.fn(),
}));

function createMockElement() {
  const children: any[] = [];
  const classList = new Set<string>();

  const element: any = {
    children,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    addClass: (cls: string) => classList.add(cls),
    removeClass: (cls: string) => classList.delete(cls),
    hasClass: (cls: string) => classList.has(cls),
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    textContent: '',
    empty: jest.fn(() => { children.length = 0; }),
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createEl: (tag: string, opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      child.tagName = tag.toUpperCase();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    appendChild: (child: any) => { children.push(child); return child; },
    querySelector: jest.fn().mockReturnValue(null),
    querySelectorAll: jest.fn().mockReturnValue([]),
    setText: jest.fn((text: string) => { element.textContent = text; }),
  };

  return element;
}

describe('MessageRenderer', () => {
  it('renders welcome element and calls renderStoredMessage for each message', () => {
    const messagesEl = createMockElement();
    const renderer = new MessageRenderer({} as any, {} as any, messagesEl, {
      getShowToolUse: () => false,
    });
    const renderStoredSpy = jest.spyOn(renderer, 'renderStoredMessage').mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], contentBlocks: [] },
    ];

    const welcomeEl = renderer.renderMessages(messages, () => 'Hello');

    expect(messagesEl.empty).toHaveBeenCalled();
    expect(renderStoredSpy).toHaveBeenCalledTimes(1);
    expect(welcomeEl.hasClass('claudian-welcome')).toBe(true);
    expect(welcomeEl.children[0].textContent).toBe('Hello');
  });

  it('renders assistant content blocks using specialized renderers', () => {
    const messagesEl = createMockElement();
    const renderer = new MessageRenderer({} as any, {} as any, messagesEl, {
      getShowToolUse: () => true,
    });
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'todo', name: 'TodoWrite', input: { items: [] } } as any,
        { id: 'edit', name: 'Edit', input: { file_path: 'notes/test.md' } } as any,
        { id: 'read', name: 'Read', input: { file_path: 'notes/test.md' } } as any,
      ],
      contentBlocks: [
        { type: 'thinking', content: 'thinking', durationSeconds: 2 } as any,
        { type: 'text', content: 'Text block' } as any,
        { type: 'tool_use', toolId: 'todo' } as any,
        { type: 'tool_use', toolId: 'edit' } as any,
        { type: 'tool_use', toolId: 'read' } as any,
        { type: 'subagent', subagentId: 'sub-1', mode: 'async' } as any,
        { type: 'subagent', subagentId: 'sub-2' } as any,
      ],
      subagents: [
        { id: 'sub-1', mode: 'async' } as any,
        { id: 'sub-2', mode: 'sync' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredThinkingBlock).toHaveBeenCalled();
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Text block');
    expect(renderStoredTodoList).toHaveBeenCalled();
    expect(renderStoredWriteEdit).toHaveBeenCalled();
    expect(renderStoredToolCall).toHaveBeenCalled();
    expect(renderStoredAsyncSubagent).toHaveBeenCalled();
    expect(renderStoredSubagent).toHaveBeenCalled();
  });
});
