/** @jest-environment jsdom */
import '@/providers';

import { testClock } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ProviderExecutionEvent, ProviderRequestedEventScope } from '@/core/execution';
import type { ProviderCapabilities } from '@/core/providers/types';
import { TOOL_SPAWN_AGENT, TOOL_SUBAGENT, TOOL_WAIT_AGENT } from '@/core/tools/toolNames';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SessionTranscript } from '@/features/chat/sessions/SessionTranscript';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import { StreamController } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

const cleanups: Array<() => void> = [];
beforeEach(() => {
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

function createSession(providerId?: ProviderCapabilities['providerId']) {
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const turns = new TurnCoordinator();
  const state = new ChatState({}, undefined, turns);
  const subagents = new SubagentManager(info => stream.subagents.onAsyncSubagentStateChange(info), new ClaudeTaskResultInterpreter());
  const stream: StreamController = new StreamController({ plugin, state, subagentManager: subagents,
    get renderer() { return transcript.renderer; }, getMessagesEl: () => transcript.messagesEl,
    getProviderId: () => 'claude', updateQueueIndicator: () => undefined });
  const transcript: SessionTranscript = new SessionTranscript(state, stream, subagents);
  let nextId = 0;
  const host = { state, stream, turns, get renderer() { return transcript.renderer; }, createMessageId: () => `message-${++nextId}` };
  const response = new ResponseStream(host);
  const background = new BackgroundResponses(host);
  let sequence = 0;
  const scope = (): ProviderRequestedEventScope => ({ kind: 'requested', sessionInstanceId: 'native', executionId: 'execution', turnId: 'turn', sequence: ++sequence });
  const emit = (event: Omit<ProviderExecutionEvent, 'scope'>) => response.handleEvent({ ...event, scope: scope() } as ProviderExecutionEvent);
  const createRenderer = (root: HTMLElement) => new MessageRenderer(plugin, new Component(), root, undefined, undefined,
    providerId ? () => ({ providerId } as ProviderCapabilities) : undefined);
  const attach = () => {
    const root = document.body.createDiv();
    const renderer = createRenderer(root);
    transcript.attach(renderer, root, () => 'Welcome');
    return root;
  };
  const finish = () => response.finish(response.active!, { interrupted: false, failed: false });
  cleanups.push(() => { transcript.detach(); stream.dispose(); subagents.clear(); });
  return { state, stream, transcript, response, background, host, emit, attach, finish, createRenderer };
}

it.each(['text', 'thinking'] as const)('reattaches during %s without losing open blocks, child output, or live tools', async openKind => {
  const clock = testClock();
  jest.spyOn(Date, 'now').mockImplementation(() => clock().getTime());
  const control = createSession();
  const moved = createSession();
  control.attach();
  const oldRoot = moved.attach();
  for (const session of [control, moved]) {
    session.response.start();
    await session.emit({ type: `${openKind}_delta`, text: 'Before ' } as Omit<ProviderExecutionEvent, 'scope'>);
  }
  moved.transcript.detach();
  oldRoot.remove();
  clock.advance({ seconds: 2 });
  for (const session of [control, moved]) {
    await session.emit({ type: `${openKind}_delta`, text: 'detached.' } as Omit<ProviderExecutionEvent, 'scope'>);
  }
  const root = moved.attach();
  for (const session of [control, moved]) {
    await session.emit({ type: `${openKind}_delta`, text: ' Reattached.' } as Omit<ProviderExecutionEvent, 'scope'>);
    await session.stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, session.response.active!);
    await session.stream.handleStreamChunk({ type: 'tool_use', id: 'task', name: TOOL_SUBAGENT, input: { description: 'Research', run_in_background: false } }, session.response.active!);
  }
  // Detach with live tool cards; their later results must update a new view.
  moved.transcript.detach();
  root.remove();
  for (const session of [control, moved]) {
    await session.stream.handleStreamChunk({ type: 'subagent_tool_use', subagentId: 'task', id: 'child-read', name: 'Read', input: { file_path: 'child.md' } }, session.response.active!);
  }
  const finalRoot = moved.attach();
  for (const session of [control, moved]) {
    await session.stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'Parent note.' }, session.response.active!);
    await session.stream.handleStreamChunk({ type: 'subagent_tool_result', subagentId: 'task', id: 'child-read', content: 'Child note.' }, session.response.active!);
    await session.stream.handleStreamChunk({ type: 'tool_result', id: 'task', content: 'Research finished.' }, session.response.active!);
    await session.emit({ type: 'text_delta', text: 'Final answer.' } as Omit<ProviderExecutionEvent, 'scope'>);
    await session.finish();
  }
  const projection = (session: ReturnType<typeof createSession>) => session.state.messages.map(({ content, contentBlocks, toolCalls }) => ({ content, contentBlocks, toolCalls }));
  expect(projection(moved)).toEqual(projection(control));
  expect(moved.state.messages[0].contentBlocks).toEqual([
    { type: openKind, content: 'Before detached. Reattached.', ...(openKind === 'thinking' ? { durationSeconds: 2 } : {}) },
    { type: 'tool_use', toolId: 'read' },
    { type: 'subagent', subagentId: 'task' },
    { type: 'text', content: 'Final answer.' },
  ]);
  expect(within(finalRoot).getByText('Final answer.')).toBeTruthy();
  fireEvent.click(within(finalRoot).getByRole('button', { name: 'Worked' }));
  expect(within(finalRoot).getByRole('button', { name: /Read.*note.md/ })).toBeTruthy();
  fireEvent.click(within(finalRoot).getByRole('button', { name: /Subagent task: Research.*completed/ }));
  expect(finalRoot.textContent).toContain('Research finished.');
  expect(finalRoot.textContent).toContain('Child note.');
});

it('reattaches a reserved background response before its buffered output completes', async () => {
  const session = createSession();
  session.attach();
  const scope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'background', sequence: 1 };
  session.background.reserve('binding', 'background');
  await session.background.handle('binding', { type: 'text_delta', text: 'Before.', scope }, () => true);
  session.transcript.detach();
  renderSessionTaskNotification(session.host, 'Task finished.', undefined, scope);
  const root = session.attach();
  await session.background.handle('binding', { type: 'text_delta', text: 'After.', scope: { ...scope, sequence: 2 } }, () => true);
  await session.background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } }, () => true);
  expect(session.state.messages.map(message => message.contentBlocks)).toEqual([
    [{ type: 'text', content: 'Before.' }], [{ type: 'task_notification', content: 'Task finished.' }], [{ type: 'text', content: 'After.' }],
  ]);
  expect(within(root).getByText('Before.')).toBeTruthy();
  expect(within(root).getByText('Task finished.')).toBeTruthy();
  expect(within(root).getByText('After.')).toBeTruthy();
});

it('keeps one live card when a buffered subagent resolves after reattachment', async () => {
  const session = createSession();
  const previous = session.attach();
  session.response.start();
  await session.stream.handleStreamChunk({ type: 'tool_use', id: 'task', name: TOOL_SUBAGENT, input: { description: 'Research' } }, session.response.active!);
  session.transcript.detach();
  previous.remove();
  const root = session.attach();
  await session.stream.handleStreamChunk({ type: 'subagent_tool_use', subagentId: 'task', id: 'child-read', name: 'Read', input: { file_path: 'child.md' } }, session.response.active!);
  await session.stream.handleStreamChunk({ type: 'subagent_tool_result', subagentId: 'task', id: 'child-read', content: 'Child note.' }, session.response.active!);
  await session.stream.handleStreamChunk({ type: 'tool_result', id: 'task', content: 'Research finished.' }, session.response.active!);
  expect(within(root).getAllByRole('button', { name: /Subagent task: Research/ })).toHaveLength(1);
  fireEvent.click(within(root).getByRole('button', { name: /Subagent task: Research.*completed/ }));
  expect(root.textContent).toContain('Child note.');
  expect(root.textContent).toContain('Research finished.');
  await session.finish();
});

it.each<[string, ProviderCapabilities['providerId'], Pick<ChatMessage, 'toolCalls' | 'contentBlocks'>]>([
  ['a managed-agent task whose block hint makes it async', 'claude', {
    toolCalls: [{ id: 'task', name: TOOL_SUBAGENT, input: { description: 'Research' }, status: 'completed', result: 'Launched.',
      subagent: { id: 'task', description: 'Research', prompt: '', mode: 'sync', status: 'completed', toolCalls: [], isExpanded: false } }],
    contentBlocks: [{ type: 'subagent', subagentId: 'task', mode: 'async' }],
  }],
  ['a finished Codex spawn whose result arrives through wait', 'codex', {
    toolCalls: [
      { id: 'spawn', name: TOOL_SPAWN_AGENT, input: { message: 'Inspect utils.ts.', model: 'gpt-5.4-mini' }, status: 'completed',
        result: '{"agent_id":"agent-1","nickname":"Zeno"}',
        subagent: { id: 'spawn', description: 'Zeno', prompt: 'Inspect utils.ts.', status: 'running', toolCalls: [], isExpanded: false } },
      { id: 'wait', name: TOOL_WAIT_AGENT, input: { targets: ['agent-1'] }, status: 'completed',
        result: '{"status":{"agent-1":{"completed":"Patched utils.ts."}},"timed_out":false}' },
    ],
    contentBlocks: [{ type: 'tool_use', toolId: 'spawn' }, { type: 'tool_use', toolId: 'wait' }],
  }],
])('renders %s the same on reattach as on first hydration', (_name, providerId, response) => {
  const clock = testClock();
  const session = createSession(providerId);
  session.state.messages = [
    { id: 'prompt', role: 'user', content: 'Go.', timestamp: clock().getTime() },
    { id: 'answer', role: 'assistant', content: '', timestamp: clock().getTime(), durationSeconds: 1,
      ...structuredClone(response) },
  ];
  // First hydration renders the restored conversation without live hooks.
  const hydrated = document.body.createDiv();
  session.createRenderer(hydrated).renderMessages(session.state.messages, () => 'Welcome');
  const reattached = session.attach();

  const transcript = (root: HTMLElement) => [...root.querySelectorAll('.claudian-message')].map(el => el.outerHTML);
  expect(transcript(reattached)).toEqual(transcript(hydrated));
  expect(within(reattached).getAllByRole('button', { name: /Zeno|Research/ })).toHaveLength(1);
});

it('keeps a background task from a settled response connected across reattachment', async () => {
  const session = createSession();
  const previous = session.attach();
  session.response.start();
  await session.stream.handleStreamChunk({ type: 'tool_use', id: 'task', name: TOOL_SUBAGENT,
    input: { description: 'Survey', prompt: 'Survey the vault.', run_in_background: true } }, session.response.active!);
  await session.stream.handleStreamChunk({ type: 'tool_result', id: 'task', content: 'agentId: child-1' }, session.response.active!);
  await session.emit({ type: 'text_delta', text: 'Started.' } as Omit<ProviderExecutionEvent, 'scope'>);
  await session.finish();
  session.transcript.detach();
  previous.remove();

  const root = session.attach();
  fireEvent.click(within(root).getByRole('button', { name: 'Worked' }));
  expect(within(root).getByRole('button', { name: /Background task: Survey.*Running/ })).toBeTruthy();
  await session.stream.subagents.handleAsyncSubagentCompletion({ type: 'async_subagent_completion', providerSessionId: 'native',
    taskId: 'child-1', status: 'completed', result: 'Survey complete.' });
  expect(within(root).getAllByRole('button', { name: /Background task: Survey/ })).toHaveLength(1);
  expect(within(root).queryByRole('button', { name: /Background task: Survey.*Running/ })).toBeNull();
  expect(root.textContent).toContain('Survey complete.');
});
