// @vitest-environment jsdom
import '@/providers';

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';
const { Menu } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');

import {
  TOOL_AGENT_OUTPUT,
  TOOL_SPAWN_AGENT,
  TOOL_SUBAGENT,
  TOOL_WAIT_AGENT,
  TOOL_WRITE_STDIN,
} from '@/core/tools/toolNames';
import type { ClaudianSettings } from '@/core/types';
import type { ChatMessage, ImageAttachment, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

let plugin: Awaited<ReturnType<typeof createChatFeatureHost>>;
const renderers: MessageRenderer[] = [];
const components: Component[] = [];
const contentRenders: Promise<void>[] = [];
function trackRenderer(renderer: MessageRenderer) {
  renderers.push(renderer);
  const render = renderer.renderContent.bind(renderer);
  vi.spyOn(renderer, 'renderContent').mockImplementation((...args) => {
    const pending = render(...args);
    contentRenders.push(pending);
    return pending;
  });
  return renderer;
}

function storedToolCard(messagesEl: HTMLElement, id: string, name: RegExp): HTMLElement {
  const cards = messagesEl.querySelectorAll<HTMLElement>(`[data-tool-id="${id}"]`);
  expect(cards).toHaveLength(1);
  expect(within(cards[0]).getByRole('button', { name, expanded: false })).toBeDefined();
  return cards[0];
}

function expandStoredTool(messagesEl: HTMLElement, id: string, name: RegExp): HTMLElement {
  const card = storedToolCard(messagesEl, id, name);
  fireEvent.click(within(card).getByRole('button', { name, expanded: false }));
  expect(within(card).getByRole('button', { name, expanded: true })).toBeDefined();
  return card;
}

function createMockComponent() {
  const component = new Component();
  components.push(component);
  return component;
}

function mockCapabilities(providerId: 'claude' | 'codex' | 'grok' = 'claude') {
  return () => ({
    providerId,
    supportsEphemeralSessions: false,
    supportsNativeHistory: providerId === 'claude',
    supportsRewind: true,
    supportsFork: true,
    supportsProviderCommands: true,
    supportsImageAttachments: true,
    reasoningControl: 'effort' as const,
  });
}

function createRenderer(
  messagesEl?: HTMLElement,
  providerId: 'claude' | 'codex' | 'grok' = 'claude',
  settings: Partial<ClaudianSettings> = {},
) {
  const el = messagesEl ?? document.body.createDiv();
  const comp = createMockComponent();
  Object.assign(plugin.settings, settings);
  return {
    renderer: trackRenderer(new MessageRenderer(
      plugin,
      comp,
      el,
      undefined,
      undefined,
      mockCapabilities(providerId),
    )),
    messagesEl: el,
  };
}

describe('MessageRenderer', () => {
  beforeEach(async () => {
    plugin = await createChatFeatureHost({ app: new App(), settings: { showMessageTimestamps: false } });
    vi.clearAllMocks();
    Menu.instances.length = 0;
  });

  afterEach(async () => {
    await Promise.all(contentRenders.splice(0));
    renderers.splice(0).forEach(renderer => renderer.dispose());
    components.splice(0).forEach(component => component.unload());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  // ============================================
  // renderStoredMessage
  // ============================================

  it('renders interrupt messages with interrupt styling instead of user bubble', async () => {
    const messagesEl = document.body.createDiv();
    const mockComponent = createMockComponent();
    const renderer = trackRenderer(new MessageRenderer(plugin, mockComponent, messagesEl));

    const interruptMsg: ChatMessage = {
      id: 'interrupt-1',
      role: 'user',
      content: '[Request interrupted by user]',
      timestamp: Date.now(),
      isInterrupt: true,
    };

    renderer.renderStoredMessage(interruptMsg);

    // Should create assistant-style message with interrupt content
    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
    // Check the content contains interrupt styling
    const contentEl = msgEl.children[0];
    const textEl = contentEl.children[0];
    const interruptedEl = textEl.children[0];
    expect(interruptedEl.hasClass('claudian-interrupted')).toBe(true);
    expect(interruptedEl.textContent).toBe('Interrupted');
  });

  it('renders timestamps when the setting is enabled', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl, 'claude', { showMessageTimestamps: true });
    const timestamp = testDate().getTime();

    renderer.renderStoredMessage({
      id: 'timed-user',
      role: 'user',
      content: 'Hello',
      timestamp,
    });

    const msgEl = messagesEl.children[0];
    const timestampEl = msgEl.querySelector('.claudian-message-timestamp');
    expect(timestampEl).toBeTruthy();
    expect(timestampEl!.textContent).toBe(new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }));
    expect(timestampEl!.getAttribute('aria-label')).toBe(new Date(timestamp).toLocaleString(undefined, { hourCycle: 'h23' }));
  });

  it('does not render timestamps when the setting is disabled', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl, 'claude', { showMessageTimestamps: false });

    renderer.renderStoredMessage({
      id: 'untimed-user',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    });

    const msgEl = messagesEl.children[0];
    expect(msgEl.querySelector('.claudian-message-timestamp')).toBeNull();
  });

  it('renders persisted citation content blocks', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl, 'codex');
    const citations = {
      kind: 'memory' as const,
      entries: [{
        path: 'MEMORY.md',
        lineStart: 10,
        lineEnd: 12,
        note: 'Used project conventions',
      }],
    };

    renderer.renderStoredMessage({
      id: 'assistant-citations',
      role: 'assistant',
      content: 'Answer',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: 'Answer' },
        { type: 'citations', citations },
      ],
    });

    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("MEMORY.md:10–12");
    expect(messagesEl.textContent).toContain("Used project conventions");
});

  it('renders bare interrupt marker for empty interrupted assistant message', async () => {
    const messagesEl = document.body.createDiv();
    const mockComponent = createMockComponent();
    const renderer = trackRenderer(new MessageRenderer(plugin, mockComponent, messagesEl));

    const interruptMsg: ChatMessage = {
      id: 'interrupt-codex-2',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isInterrupt: true,
    };

    renderer.renderStoredMessage(interruptMsg);

    // Should create a bare interrupt marker (same as Claude-style)
    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
    const contentEl = msgEl.children[0];
    const textEl = contentEl.children[0];
    expect(textEl.children[0].hasClass('claudian-interrupted')).toBe(true);
  });

  it('skips rebuilt context messages', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'rebuilt-1',
      role: 'user',
      content: 'rebuilt context',
      timestamp: Date.now(),
      isRebuiltContext: true,
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.children.length).toBe(0);
  });

  it('renders user message with text content', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-user')).toBe(true);
  });

  it('renders user message with displayContent instead of content', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'full prompt with context',
      displayContent: 'user input only',
      timestamp: Date.now(),
    };

    renderer.renderStoredMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'user input only');
  });

  it('renders extracted user display content when stored message has hidden XML context', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Explain this\n\n<current_note>\nnotes/test.md\n</current_note>',
      timestamp: Date.now(),
    };

    renderer.renderStoredMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Explain this');
  });

  it('skips empty user message bubble (image-only)', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '',
      timestamp: Date.now(),
      images: [{ id: 'img-1', name: 'img.png', mediaType: 'image/png', data: 'abc', size: 100, source: 'paste' as const }],
    };

    renderer.renderStoredMessage(msg);

    // Images should still be rendered, but no message bubble
    expect(messagesEl.querySelector('.claudian-message-image')?.children[0]).not.toBeNull();
    // Only the images container, no message bubble
    const bubbles = Array.from(messagesEl.children).filter(
      c => c.hasClass('claudian-message')
    );
    expect(bubbles.length).toBe(0);
  });

  it('renders user message with images above bubble', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file' },
    ];

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Check this image',
      timestamp: Date.now(),
      images,
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.querySelector('.claudian-message-image')?.children[0]?.getAttribute('src')).toBe('data:image/png;base64,base64data');
  });

  it('adds rewind but not fork for a completed first user message', async () => {
    const messagesEl = document.body.createDiv();
    const rewindCallback = vi.fn().mockResolvedValue(undefined);
    const forkCallback = vi.fn().mockResolvedValue(undefined);
    const renderer = trackRenderer(new MessageRenderer(
      plugin,
      createMockComponent(),
      messagesEl,
      rewindCallback,
      forkCallback,
      mockCapabilities(),
    ));

    const allMessages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1, userMessageId: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'response', timestamp: 2, assistantMessageId: 'resp-a' },
    ];

    renderer.renderStoredMessage(allMessages[0], allMessages, 0);

    expect(messagesEl.querySelector('.claudian-message-rewind-btn')).not.toBeNull();
    expect(messagesEl.querySelector('.claudian-message-fork-btn')).toBeNull();
  });

  it('does not add a rewind button when stored render is called without context', async () => {
    const messagesEl = document.body.createDiv();
    const rewindCallback = vi.fn().mockResolvedValue(undefined);
    const renderer = trackRenderer(new MessageRenderer(plugin, createMockComponent(), messagesEl, rewindCallback, undefined, mockCapabilities()));

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      userMessageId: 'user-u',
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.querySelector('.claudian-message-rewind-btn')).toBeNull();
  });

  it('positions the rewind menu for pointer and keyboard activation', async () => {
    const messagesEl = document.body.createDiv();
    const rewindCallback = vi.fn().mockResolvedValue(undefined);
    const renderer = trackRenderer(new MessageRenderer(plugin, createMockComponent(), messagesEl, rewindCallback, undefined, mockCapabilities()));

    const userMsg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 2,
      userMessageId: 'user-u',
    };
    renderer.addMessage(userMsg);

    const allMessages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      userMsg,
      { id: 'a2', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    renderer.refreshActionButtons(userMsg, allMessages, 1);

    const btn = messagesEl.querySelector('.claudian-message-rewind-btn');
    expect(btn).not.toBeNull();

    const pointerEvent = new MouseEvent('click', { detail: 1, bubbles: true });
    btn!.dispatchEvent(pointerEvent);
    const menu = Menu.instances[0];
    expect(menu.showAtMouseEvent).toHaveBeenCalledWith(pointerEvent);
    expect(menu.items.map(item => item.title)).toEqual([
      'Rewind conversation only',
      'Rewind code + conversation',
    ]);

    menu.items[0].clickHandler?.();
    await Promise.resolve();

    expect(rewindCallback).toHaveBeenCalledWith('u1', 'conversation');

    btn!.getBoundingClientRect = vi.fn().mockReturnValue({ bottom: 48, left: 24 });
    fireEvent.click(btn!, { detail: 0 });

    const keyboardMenu = Menu.instances[1];
    expect(keyboardMenu.showAtPosition).toHaveBeenCalledWith(
      { x: 24, y: 48 },
      btn!.ownerDocument,
    );
    expect(keyboardMenu.showAtMouseEvent).not.toHaveBeenCalled();
  });

  it('refreshes rewind but not fork for a streamed first user message', async () => {
    const messagesEl = document.body.createDiv();
    const rewindCallback = vi.fn().mockResolvedValue(undefined);
    const forkCallback = vi.fn().mockResolvedValue(undefined);
    const renderer = trackRenderer(new MessageRenderer(
      plugin,
      createMockComponent(),
      messagesEl,
      rewindCallback,
      forkCallback,
      mockCapabilities(),
    ));

    const userMsg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      userMessageId: 'user-u',
    };
    renderer.addMessage(userMsg);

    renderer.refreshActionButtons(userMsg, [
      userMsg,
      { id: 'a1', role: 'assistant', content: 'response', timestamp: 2, assistantMessageId: 'resp-a' },
    ], 0);

    expect(messagesEl.querySelector('.claudian-message-rewind-btn')).not.toBeNull();
    expect(messagesEl.querySelector('.claudian-message-fork-btn')).toBeNull();
  });

  // ============================================
  // renderAssistantContent
  // ============================================

  it('renders assistant content blocks using specialized renderers', async () => {
    const messagesEl = document.body.createDiv();
    const mockComponent = createMockComponent();
    const renderer = trackRenderer(new MessageRenderer(plugin, mockComponent, messagesEl));
    const renderContentSpy = vi.mocked(renderer.renderContent);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'todo', name: 'TodoWrite', input: { todos: [
          { content: 'Verify restored task history', activeForm: 'Verifying restored task history', status: 'pending' },
        ] }, status: 'completed' },
        { id: 'edit', name: 'Edit', input: { file_path: 'notes/edited.md' }, status: 'completed' },
        { id: 'read', name: 'Read', input: { file_path: 'notes/read.md' }, result: 'Stored note contents', status: 'completed' },
        {
          id: 'sub-1',
          name: TOOL_SUBAGENT,
          input: { description: 'Async subagent' },
          status: 'running',
          subagent: { id: 'sub-1', description: 'Async subagent', mode: 'async', status: 'running', toolCalls: [], isExpanded: false },
        },
        {
          id: 'sub-2',
          name: TOOL_SUBAGENT,
          input: { description: 'Sync subagent' },
          status: 'running',
          subagent: { id: 'sub-2', description: 'Sync subagent', mode: 'sync', status: 'running', toolCalls: [], isExpanded: false },
        },
      ],
      contentBlocks: [
        { type: 'thinking', content: 'thinking', durationSeconds: 2 },
        { type: 'text', content: 'Text block' },
        { type: 'tool_use', toolId: 'todo' },
        { type: 'tool_use', toolId: 'edit' },
        { type: 'tool_use', toolId: 'read' },
        { type: 'subagent', subagentId: 'sub-1', mode: 'async' },
        { type: 'subagent', subagentId: 'sub-2' },
      ],
    };

    renderer.renderStoredMessage(msg);


    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Text block');

    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Text block");
    const thinking = within(messagesEl).getByRole('button', { name: 'Thought for 2s', expanded: false });
    fireEvent.click(thinking);
    await Promise.all(contentRenders);
    expect(thinking.parentElement?.textContent).toContain('thinking');
    const todo = expandStoredTool(messagesEl, 'todo', /^Tasks \(0\/1\)/);
    expect(within(todo).getByText('Verify restored task history')).toBeDefined();
    const edit = expandStoredTool(messagesEl, 'edit', /^Edit: notes\/edited.md/);
    expect(within(edit).getByText('DONE')).toBeDefined();
    const read = expandStoredTool(messagesEl, 'read', /^Read: notes\/read.md/);
    expect(within(read).getByText('Stored note contents')).toBeDefined();
    expect(within(messagesEl).getByRole('button', { name: /^Background task: Async subagent - Running in background/ })).toBeDefined();
    expect(within(messagesEl).getByRole('button', { name: /^Subagent task: Sync subagent - Status: running/ })).toBeDefined();
});

  it('skips empty or whitespace-only text blocks', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: '' },
        { type: 'text', content: '   ' },
        { type: 'text', content: 'Real content' },
      ],
    };

    renderer.renderStoredMessage(msg);

    // Only the non-empty text block should trigger renderContent
    expect(renderContentSpy).toHaveBeenCalledTimes(1);
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Real content');
  });

  it('does not render stored Codex write_stdin transport tools', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl, 'codex');

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'stdin-1',
          name: TOOL_WRITE_STDIN,
          input: { session_id: '2404', chars: '' },
          status: 'completed',
          result: 'poll output',
        },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'stdin-1' },
      ],
    };

    renderer.renderStoredMessage(msg);


    expect(messagesEl.children).toHaveLength(0);
  });

  it('renders stored Codex write_stdin tools when they send real input', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl, 'codex');

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'stdin-1',
          name: TOOL_WRITE_STDIN,
          input: { session_id: '2404', chars: 'y\n' },
          status: 'completed',
          result: 'Input sent.',
        },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'stdin-1' },
      ],
    };

    renderer.renderStoredMessage(msg);


    expect(messagesEl.children).toHaveLength(1);

    await Promise.all(contentRenders);
    const card = expandStoredTool(messagesEl, 'stdin-1', /^write_stdin:/);
    expect(within(card).getByText('Input sent.')).toBeDefined();
});

  it('renders fallback content for old conversations without contentBlocks', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);
    const addCopySpy = vi.spyOn(renderer, 'addTextCopyButton');

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Legacy response text',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, status: 'completed' },
      ],
    };

    renderer.renderStoredMessage(msg);

    // Should render content text
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Legacy response text');
    // Should add copy button for fallback text
    expect(addCopySpy).toHaveBeenCalledWith(expect.anything(), 'Legacy response text');
    // Should render tool call


    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Legacy response text");
    fireEvent.click(within(messagesEl).getByRole('button', { name: /^Worked/, expanded: false }));
    storedToolCard(messagesEl, 'read-1', /^Read: test.md/);
});

  it('renders unreferenced tool calls when contentBlocks miss tool_use blocks', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);


    const msg: ChatMessage = {
      id: 'm-unreferenced-tool',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'a.md' }, status: 'completed' },
      ],
      contentBlocks: [
        { type: 'text', content: 'Only text block persisted' },
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Only text block persisted');


    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Only text block persisted");
    fireEvent.click(within(messagesEl).getByRole('button', { name: /^Worked/, expanded: false }));
    storedToolCard(messagesEl, 'read-1', /^Read: a.md/);
});

  it('renders Task tool calls as subagents for backward compatibility', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);


    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'Run tests' },
          status: 'completed',
          result: 'All passed',
        },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'task-1' },
      ],
    };

    renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    const card = messagesEl.querySelector<HTMLElement>('[data-subagent-id="task-1"]')!;
    expect(within(card).getByRole('button', { name: /^Subagent task: Run tests - Status: completed/ })).toBeDefined();
    expect(within(card).getByText('All passed')).toBeDefined();
});

  it('renders Task tool as async subagent when linked subagent mode is async', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'm-task-async',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-async-1',
          name: TOOL_SUBAGENT,
          input: { description: 'Background task', run_in_background: true },
          status: 'completed',
          result: 'Task running',
          subagent: {
            id: 'task-async-1',
            description: 'Background task',
            mode: 'async',
            asyncStatus: 'running',
            status: 'running',
            toolCalls: [],
            isExpanded: false,
          },
        },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'task-async-1' },
      ],
    };

    renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Background task");
    expect(within(messagesEl).getByRole('button', { name: /Background task: .*Running in background/ })).toBeDefined();
});

  it('uses subagent block mode hint when linked subagent mode is missing', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'm-task-mode-hint',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-hint-1',
          name: TOOL_SUBAGENT,
          input: { description: 'Background task from block hint' },
          status: 'running',
          subagent: {
            id: 'task-hint-1',
            description: 'Background task from block hint',
            status: 'running',
            toolCalls: [],
            isExpanded: false,
          },
        },
      ],
      contentBlocks: [
        { type: 'subagent', subagentId: 'task-hint-1', mode: 'async' },
      ],
    };

    renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Background task from block hint");
    expect(within(messagesEl).getByRole('button', { name: /Background task: .*Running in background/ })).toBeDefined();
});

  // ============================================
  // TaskOutput skipping
  // ============================================

  it('should skip TaskOutput tool calls (internal async subagent communication)', async () => {
    const messagesEl = document.body.createDiv();
    const mockComponent = createMockComponent();
    const renderer = trackRenderer(new MessageRenderer(plugin, mockComponent, messagesEl));


    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'agent-output-1', name: TOOL_AGENT_OUTPUT, input: { task_id: 'abc', block: true }, status: 'running' },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'agent-output-1' },
      ],
    };

    renderer.renderStoredMessage(msg);


      expect(messagesEl.querySelector('[data-tool-id="agent-output-1"]')).toBeNull();
});

  it('should render other tool calls but skip TaskOutput when mixed', async () => {
    const messagesEl = document.body.createDiv();
    const mockComponent = createMockComponent();
    const renderer = trackRenderer(new MessageRenderer(plugin, mockComponent, messagesEl));


    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, status: 'completed' },
        { id: 'agent-output-1', name: TOOL_AGENT_OUTPUT, input: { task_id: 'abc' }, status: 'running' },
        { id: 'grep-1', name: 'Grep', input: { pattern: 'test' }, status: 'completed' },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'read-1' },
        { type: 'tool_use', toolId: 'agent-output-1' },
        { type: 'tool_use', toolId: 'grep-1' },
      ],
    };

    renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    storedToolCard(messagesEl, 'read-1', /^Read: test.md/);
    storedToolCard(messagesEl, 'grep-1', /^Grep:/);
    expect(messagesEl.querySelector('[data-tool-id="agent-output-1"]')).toBeNull();
});

  // ============================================
  // addMessage (streaming)
  // ============================================

  it('addMessage creates user message bubble with text', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };

    const msgEl = renderer.addMessage(msg);

    expect(msgEl.hasClass('claudian-message-user')).toBe(true);
  });

  it('addMessage stores a truncated first-line table-of-contents title for user messages', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: `${'x'.repeat(90)}\nsecond line`,
      timestamp: Date.now(),
    };

    const msgEl = renderer.addMessage(msg);

    expect(msgEl.getAttribute('data-toc-title')).toBe(`${'x'.repeat(77)}...`);
  });

  it('addMessage renders images for user messages', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file' },
    ];

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Look at this',
      timestamp: Date.now(),
      images,
    };

    renderer.addMessage(msg);

    expect(messagesEl.querySelector('.claudian-message-image')?.children[0]?.getAttribute('src')).toBe('data:image/png;base64,base64data');
  });

  it('addMessage skips empty bubble for image-only user messages', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const scrollSpy = vi.spyOn(renderer, 'scrollToBottom').mockImplementation(() => {});

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '',
      timestamp: Date.now(),
      images: [{ id: 'img-1', name: 'img.png', mediaType: 'image/png', data: 'abc', size: 100, source: 'paste' as const }],
    };

    const result = renderer.addMessage(msg);

    // Should still return an element (last child or messagesEl)
    expect(result).toBeDefined();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('addMessage creates assistant message element without user-specific rendering', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    const msgEl = renderer.addMessage(msg);

    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
  });

  // ============================================
  // Image rendering
  // ============================================

  it('renders every image attachment', async () => {
    const containerEl = document.body.createDiv();
    const { renderer } = createRenderer(containerEl);

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data1', size: 200, source: 'file' },
      { id: 'img-2', name: 'avatar.jpg', mediaType: 'image/jpeg', data: 'base64data2', size: 300, source: 'file' },
    ];

    renderer.addMessage({ id: 'image-message', role: 'user', content: '', timestamp: Date.now(), images });

    // Should create images container with 2 image wrappers
    expect(containerEl.children.length).toBe(1);
    const imagesContainer = containerEl.children[0];
    expect(imagesContainer.hasClass('claudian-message-images')).toBe(true);
    expect(Array.from(imagesContainer.children).filter(child => child.hasClass('claudian-message-image'))).toHaveLength(2);
  });

  it('renders the attachment data URI', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const image: ImageAttachment = {
      id: 'img-1',
      name: 'test.png',
      mediaType: 'image/png',
      data: 'abc123',
      size: 100,
      source: 'file',
    };

    renderer.addMessage({ id: 'image-message', role: 'user', content: '', timestamp: Date.now(), images: [image] });
    const imgEl = messagesEl.querySelector('.claudian-message-image')!.children[0];

    expect(imgEl.getAttribute('src')).toBe('data:image/png;base64,abc123');
  });

  // ============================================
  // Scroll utilities
  // ============================================

  it('scrollToBottom sets scrollTop to scrollHeight', async () => {
    const messagesEl = document.body.createDiv();
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
    const { renderer } = createRenderer(messagesEl);

    renderer.scrollToBottom();

    expect(messagesEl.scrollTop).toBe(1000);
  });

  it('scrollToBottomIfNeeded scrolls when near bottom', async () => {
    const messagesEl = document.body.createDiv();
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
    messagesEl.scrollTop = 950;
    Object.defineProperty(messagesEl, 'clientHeight', { value: 0, configurable: true });
    const { renderer } = createRenderer(messagesEl);

    // Mock requestAnimationFrame
    const origRAF = globalThis.requestAnimationFrame;
    (globalThis).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };

    try {
      renderer.scrollToBottomIfNeeded();
      // Near bottom (1000 - 950 - 0 = 50, < 100 threshold) → scrolls
      expect(messagesEl.scrollTop).toBe(1000);
    } finally {
      (globalThis).requestAnimationFrame = origRAF;
    }
  });

  it('scrollToBottomIfNeeded does not scroll when far from bottom', async () => {
    const messagesEl = document.body.createDiv();
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 1000, configurable: true });
    messagesEl.scrollTop = 100;
    Object.defineProperty(messagesEl, 'clientHeight', { value: 0, configurable: true });
    const { renderer } = createRenderer(messagesEl);

    const originalScrollTop = messagesEl.scrollTop;
    renderer.scrollToBottomIfNeeded();

    // scrollTop should not change (900 > 100 threshold)
    expect(messagesEl.scrollTop).toBe(originalScrollTop);
  });

  // ============================================
  // renderMessages (entry point)
  // ============================================

  it('renderMessages should store table-of-contents title from displayContent before content', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);

    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'Expanded prompt that should not appear',
        displayContent: 'Visible slash command\nwith details',
        timestamp: Date.now(),
      },
    ];

    renderer.renderMessages(messages, () => 'Hello');

    const msgEl = messagesEl.querySelector('.claudian-message-user');
    expect(msgEl?.getAttribute('data-toc-title')).toBe('Visible slash command');
  });

  // ============================================
  // Agent tool rendering - error and running status
  // ============================================

  describe('Agent tool rendering - error and running status', () => {
    it('renders Codex spawn_agent with the same prompt and result recovered on reload', async () => {
      const messagesEl = document.body.createDiv();
      const { renderer } = createRenderer(messagesEl, 'codex');


      const msg: ChatMessage = {
        id: 'm-codex-subagent',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'spawn-1',
            name: TOOL_SPAWN_AGENT,
            input: {
              message: 'Inspect utils.ts and return the final patch summary.',
              model: 'gpt-5.4-mini',
            },
            status: 'completed',
            result: '{"agent_id":"agent-1","nickname":"Zeno"}',
          },
          {
            id: 'wait-1',
            name: TOOL_WAIT_AGENT,
            input: { targets: ['agent-1'], timeout_ms: 30000 },
            status: 'completed',
            result: '{"status":{"agent-1":{"completed":"Patched utils.ts and verified imports."}},"timed_out":false}',
          },
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'spawn-1' },
        ],
      };

      renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    expect(within(messagesEl).getByRole('button', { name: /^Subagent task: Zeno \(gpt-5.4-mini\) - Status: completed/ })).toBeDefined();
    expect(messagesEl.textContent).toContain("Inspect utils.ts and return the final patch summary.");
    expect(messagesEl.textContent).toContain("Patched utils.ts and verified imports.");
});

    it('renders a stored Grok background task with the async subagent renderer', async () => {
      const messagesEl = document.body.createDiv();
      const { renderer } = createRenderer(messagesEl, 'grok');

      const msg: ChatMessage = {
        id: 'm-grok-subagent',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'spawn-1',
            name: 'spawn_subagent',
            input: {
              description: 'Inspect tools',
              prompt: 'Inspect every mapping.',
              run_in_background: true,
              task_id: 'task-1',
            },
            status: 'completed',
            result: 'Spawned task-1',
          },
          {
            id: 'output-1',
            name: 'get_command_or_subagent_output',
            input: { task_ids: ['task-1'] },
            providerPayload: {
              rawName: 'get_command_or_subagent_output',
              rawOutput: {
                Result: [{ output: 'All mappings verified.', status: 'completed', task_id: 'task-1' }],
                type: 'task_output',
              },
            },
            status: 'completed',
            result: 'All mappings verified.',
          },
        ],
        contentBlocks: [{ type: 'tool_use', toolId: 'spawn-1' }],
      };

      renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    expect(messagesEl.textContent).toContain("Inspect tools");
    expect(messagesEl.textContent).toContain("All mappings verified.");
    expect(within(messagesEl).getByRole('button', { name: /Background task: .*Completed/ })).toBeDefined();
});

    it('renders Grok output calls that target background commands', async () => {
      const messagesEl = document.body.createDiv();
      const { renderer } = createRenderer(messagesEl, 'grok');
      const outputToolCall: ToolCallInfo = {
        id: 'output-command',
        name: 'get_command_or_subagent_output',
        input: { task_id: 'command-1' },
        status: 'completed',
        result: 'Command finished.',
      };
      const msg: ChatMessage = {
        id: 'm-grok-command-output',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [outputToolCall],
        contentBlocks: [{ type: 'tool_use', toolId: 'output-command' }],
      };

      renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    const card = expandStoredTool(messagesEl, 'output-command', /get_command_or_subagent_output/);
    expect(within(card).getByText('Command finished.')).toBeDefined();
});

    it('renders stored Grok output calls with mixed command and subagent targets', async () => {
      const messagesEl = document.body.createDiv();
      const { renderer } = createRenderer(messagesEl, 'grok');
      const outputToolCall: ToolCallInfo = {
        id: 'output-mixed',
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-1', 'command-1'] },
        status: 'completed',
        result: 'Subagent and command finished.',
      };
      const msg: ChatMessage = {
        id: 'm-grok-mixed-output',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'spawn-1',
            name: 'spawn_subagent',
            input: {
              description: 'Inspect tools',
              run_in_background: true,
              task_id: 'task-1',
            },
            status: 'completed',
            result: 'Spawned task-1',
          },
          outputToolCall,
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'spawn-1' },
          { type: 'tool_use', toolId: 'output-mixed' },
        ],
      };

      renderer.renderStoredMessage(msg);

    await Promise.all(contentRenders);
    expect(within(messagesEl).getByRole('button', { name: /^Background task: Inspect tools/ })).toBeDefined();
    const card = expandStoredTool(messagesEl, 'output-mixed', /get_command_or_subagent_output/);
    expect(within(card).getByText('Subagent and command finished.')).toBeDefined();
});
  });

  // ============================================
  // Image previews
  // ============================================

  describe('message image previews', () => {
    it('opens the preview from a native named button and closes it on disposal', async () => {
      const messagesEl = document.body.createDiv();
      const { renderer } = createRenderer(messagesEl);
      const image: ImageAttachment = {
        id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file',
      };
      renderer.addMessage({ id: 'u1', role: 'user', content: '', timestamp: Date.now(), images: [image] });

      const previewButton = messagesEl.querySelector('.claudian-message-image')!;
      const imgEl = previewButton.children[0];
      expect(previewButton.tagName).toBe('BUTTON');
      expect(previewButton.getAttribute('type')).toBe('button');
      expect(previewButton.getAttribute('aria-label')).toBe('Preview photo.png');
      expect(imgEl.tagName).toBe('IMG');
      expect(imgEl.getAttribute('alt')).toBe('photo.png');
      expect(imgEl.getAttribute('src')).toBe('data:image/png;base64,base64data');

      fireEvent.click(within(messagesEl).getByRole('button', { name: 'Preview photo.png' }));
      expect(within(document.body).getByRole('dialog', { name: 'Image preview: photo.png' })).toBeDefined();
      renderer.dispose();
      fireEvent.click(previewButton);
      expect(within(document.body).queryByRole('dialog')).toBeNull();
    });
  });

  // ============================================
  // addMessage - displayContent for user messages
  // ============================================

  it('addMessage renders displayContent instead of content when available', async () => {
    const messagesEl = document.body.createDiv();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = vi.mocked(renderer.renderContent);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'full prompt with context',
      displayContent: 'user input only',
      timestamp: Date.now(),
    };

    renderer.addMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'user input only');
  });

});
