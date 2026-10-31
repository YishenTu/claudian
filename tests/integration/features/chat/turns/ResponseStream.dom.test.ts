/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { parseGrokHistoryContent } from '@test/helpers/providers/grokHistory';
import { testDate, testTime } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { getSessionCapabilities } from '@/features/chat/sessions/sessionSettings';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { continueResponseAfterNotification } from '@/features/chat/turns/ResponseContinuation';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import { StreamController } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { parseCodexSessionTurns } from '@/providers/codex/history/CodexHistoryStore';
import { mapOpencodeNativeMessages } from '@/providers/opencode/history/OpencodeHistoryStore';
import { parsePiSessionContent } from '@/providers/pi/history/PiHistoryStore';

vi.mock('node:fs/promises');
const writeSession = useClaudeSessionFiles();

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

async function createSession(providerId?: ProviderId, promptText = 'Read the note') {
  const messagesEl = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '', showMessageTimestamps: false } });
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl, undefined, undefined,
    providerId ? () => ProviderRegistry.getCapabilities(providerId) : undefined);
  const turns = new TurnCoordinator();
  const state = new ChatState({}, undefined, turns);
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined, getProviderId: () => providerId ?? 'claude' });
  let nextId = 0;
  const host = { state, renderer, stream, turns, createMessageId: () => `message-${++nextId}` };
  const response = new ResponseStream(host);
  const prompt: ChatMessage = { id: 'prompt', role: 'user', content: promptText, timestamp: testDate().getTime() };
  state.addMessage(prompt);
  renderer.addMessage(prompt);
  cleanups.push(() => { stream.dispose(); subagents.clear(); renderer.dispose(); });
  return { messagesEl, renderer, state, stream, host, response, plugin };
}

/** Text a reader sees in an element, skipping collapsed disclosure content. */
function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden]') && node.textContent?.trim()) parts.push(node.textContent.trim());
  }
  return parts.join(' ');
}

const INTERRUPTED = 'Interrupted · What should Claudian do instead?';

/** The interrupted turn as a reader sees it, collapsed and then expanded. */
function inspectInterruptedTurn(root: HTMLElement, folded: RegExp[]) {
  const header = within(root).getByRole('button', { name: INTERRUPTED });
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  const turn = Array.from(root.querySelectorAll<HTMLElement>('.claudian-message-assistant'))
    .filter(message => visibleText(message.querySelector<HTMLElement>('.claudian-message-content')!));
  const collapsed = { expanded: header.getAttribute('aria-expanded'), visible: turn.map(message =>
    visibleText(message.querySelector<HTMLElement>('.claudian-message-content')!)),
  actions: turn.flatMap(message => within(message).queryAllByRole('button', { name: /^(Copy message|Fork conversation)$/ })).length,
  header: [header.querySelector('.claudian-interrupted')?.textContent, header.querySelector('.claudian-interrupted-hint')?.textContent] };
  fireEvent.click(header);
  const items = folded.map(pattern => within(history).getByText(pattern));
  const ordered = items.every((item, index) => index === 0
    || (items[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const expanded = { expanded: header.getAttribute('aria-expanded'), ordered, hidden: history.hidden,
    // The header carries the indicator; the body never repeats it.
    indicatorInBody: history.querySelector('.claudian-interrupted, .claudian-interrupted-hint') !== null,
    worked: within(root).queryAllByRole('button', { name: /^Worked/ }).length };
  fireEvent.click(header);
  return { collapsed, expanded };
}

const expectedTurn = {
  collapsed: { expanded: 'false', visible: [INTERRUPTED], actions: 0, header: ['Interrupted', '· What should Claudian do instead?'] },
  expanded: { expanded: 'true', ordered: true, hidden: false, indicatorInBody: false, worked: 0 },
};

it('collapses a stopped turn under Interrupted and renders it identically on rerender and every provider reload', async () => {
  const session = (await createSession());
  const { response, stream, messagesEl, renderer, state } = session;
  const live = response.start();
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, live);
  await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, live);
  await stream.handleStreamChunk({ type: 'text', content: 'Partial answer' }, live);
  await response.finish(live, { interrupted: true, failed: false });
  await Promise.resolve();

  const folded = [/^Partial answer$/];
  const tool = () => within(messagesEl).getByRole('button', { name: /Read.*note\.md/, hidden: true });
  const liveResult = inspectInterruptedTurn(messagesEl, folded);
  expect(liveResult).toEqual(expectedTurn);
  expect(live.durationSeconds).toBeUndefined();
  expect(tool().closest('[hidden]')).not.toBeNull();
  expect((await axe(messagesEl)).violations).toEqual([]);

  renderer.renderMessages(state.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);
  expect(tool().closest('[hidden]')).not.toBeNull();

  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
    { type: 'user', uuid: 'u', timestamp: testTime({ seconds: 0 }), message: { content: 'Read the note' } },
    { type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: testTime({ seconds: 1 }), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: testTime({ seconds: 2 }), toolUseResult: { content: 'The note.' }, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
    { type: 'assistant', uuid: 'partial', parentUuid: 'result', timestamp: testTime({ seconds: 3 }), message: { content: [{ type: 'text', text: 'Partial answer' }] } },
    { type: 'user', uuid: 'interrupt', parentUuid: 'partial', timestamp: testTime({ seconds: 4 }), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]));
  expect(replay.error).toBeUndefined();
  renderer.renderMessages(replay.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);
  expect(tool().closest('[hidden]')).not.toBeNull();

  // Grok records the Stop as `stop_reason: cancelled` on the turn's completion.
  const grok = parseGrokHistoryContent([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Read the note' } },
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', kind: 'read', status: 'completed',
      rawInput: { path: 'note.md' }, content: [{ type: 'content', content: { type: 'text', text: 'The note.' } }] },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial answer' } },
    { sessionUpdate: 'turn_completed', prompt_id: 'prompt', stop_reason: 'cancelled' },
  ].map((update, seconds) => JSON.stringify({ timestamp: testTime({ seconds }), method: 'session/update',
    params: { sessionId: 'grok', update } })).join('\n'), 'grok');
  // Pi records it as `stopReason: aborted` on the stopped assistant entry.
  const pi = parsePiSessionContent([
    { type: 'message', id: 'u', timestamp: testTime({ seconds: 0 }), message: { role: 'user', content: 'Read the note' } },
    { type: 'message', id: 'tool', parentId: 'u', timestamp: testTime({ seconds: 1 }), message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'note.md' } }] } },
    { type: 'message', id: 'result', parentId: 'tool', timestamp: testTime({ seconds: 2 }), message: { role: 'toolResult', toolCallId: 'read',
      content: [{ type: 'text', text: 'The note.' }] } },
    { type: 'message', id: 'partial', parentId: 'result', timestamp: testTime({ seconds: 3 }), message: { role: 'assistant',
      stopReason: 'aborted', errorMessage: 'Operation aborted', content: [{ type: 'text', text: 'Partial answer' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  // OpenCode v2 records it as the turn's `idle` outcome.
  const created = testDate().getTime();
  const opencode = mapOpencodeNativeMessages([
    { id: 'u', type: 'user', time: { created }, text: 'Read the note' },
    { id: 'partial', type: 'assistant', time: { created: created + 1_000, completed: created + 3_000 }, finish: 'error',
      error: { type: 'aborted', message: 'Step interrupted' }, content: [
        { type: 'tool', id: 'read', name: 'read', state: { status: 'completed', input: { filePath: 'note.md' }, content: [{ type: 'text', text: 'The note.' }] } },
        { type: 'text', text: 'Partial answer' },
      ] },
    { id: 'idle', type: 'idle', time: { created: created + 3_500 }, outcome: 'interrupted' },
  ]);
  for (const reloaded of [grok.messages, pi, opencode]) {
    renderer.renderMessages(reloaded, () => 'Welcome');
    await Promise.resolve();
    expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);
    expect(tool().closest('[hidden]')).not.toBeNull();
  }
});

it.each([true, false])('folds a turn stopped across compaction live and on Claude and OpenCode v2 reload (output after compaction: %s)', async after => {
  const { response, stream, messagesEl, renderer } = (await createSession());
  const live = response.start();
  await stream.handleStreamChunk({ type: 'text', content: 'Before compaction.' }, live);
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, live);
  await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, live);
  await stream.handleStreamChunk({ type: 'context_compacted' }, live);
  if (after) await stream.handleStreamChunk({ type: 'text', content: 'After compaction.' }, live);
  await response.finish(live, { interrupted: true, failed: false });
  await Promise.resolve();
  const folded = [/^Before compaction\.$/, /^Conversation compacted$/, ...(after ? [/^After compaction\.$/] : [])];
  const liveResult = inspectInterruptedTurn(messagesEl, folded);
  expect(liveResult).toEqual(expectedTurn);

  const created = testDate().getTime();
  renderer.renderMessages(mapOpencodeNativeMessages([
    { id: 'u', type: 'user', time: { created }, text: 'Read the note' },
    { id: 'a1', type: 'assistant', time: { created: created + 1_000, completed: created + 2_000 }, content: [{ type: 'text', text: 'Before compaction.' }] },
    { id: 'compact', type: 'compaction', time: { created: created + 3_000 }, status: 'completed', summary: 'Internal summary' },
    ...(after ? [{ id: 'a2', type: 'assistant', time: { created: created + 4_000, completed: created + 5_000 }, content: [{ type: 'text', text: 'After compaction.' }] }] : []),
    { id: 'idle', type: 'idle', time: { created: created + 6_000 }, outcome: 'interrupted' },
  ]), () => 'Welcome');
  await Promise.resolve();
  expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);

  // Claude auto-compacts between a tool result and the next model call.
  const claude = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
    { type: 'user', uuid: 'u', timestamp: testTime({ seconds: 0 }), message: { content: 'Read the note' } },
    { type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: testTime({ seconds: 1 }), message: { stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Before compaction.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: testTime({ seconds: 2 }), toolUseResult: { content: 'The note.' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'result', timestamp: testTime({ seconds: 3 }),
      content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } },
    ...(after ? [{ type: 'assistant', uuid: 'after', parentUuid: 'compact', timestamp: testTime({ seconds: 4 }),
      message: { content: [{ type: 'text', text: 'After compaction.' }] } }] : []),
    { type: 'user', uuid: 'interrupt', parentUuid: after ? 'after' : 'compact', timestamp: testTime({ seconds: 5 }),
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]));
  expect(claude.error).toBeUndefined();
  renderer.renderMessages(claude.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);
});

it('folds every segment of a stopped turn continued after a notification, live and on rerender', async () => {
  const session = (await createSession());
  const { response, stream, messagesEl, renderer, state, host } = session;
  const first = response.start();
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, first);
  await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, first);
  renderSessionTaskNotification(host, 'Task finished.');
  const chunk = { type: 'text' as const, content: 'Partial answer' };
  const continuation = await continueResponseAfterNotification(host, first, chunk);
  expect(continuation).not.toBe(first);
  await stream.handleStreamChunk(chunk, continuation);
  await response.finish(continuation, { interrupted: true, failed: false });
  await Promise.resolve();

  const folded = [/^Task notification$/, /^Partial answer$/];
  const liveResult = inspectInterruptedTurn(messagesEl, folded);
  expect(liveResult).toEqual(expectedTurn);
  const header = within(messagesEl).getByRole('button', { name: INTERRUPTED });
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(history.contains(within(messagesEl).getByRole('button', { name: /Read.*note\.md/, hidden: true }))).toBe(true);
  expect((await axe(messagesEl)).violations).toEqual([]);

  renderer.renderMessages(state.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspectInterruptedTurn(messagesEl, folded)).toEqual(liveResult);
});

it('keeps a notification that followed the stopped run\'s terminal event out of its fold', async () => {
  const { response, messagesEl, host, state } = (await createSession());
  response.start();
  const scope = (sequence: number) => ({ kind: 'requested' as const, sessionInstanceId: 'native', executionId: 'execution', turnId: 'turn', sequence });
  await response.handleEvent({ type: 'text_delta', text: 'Partial answer', scope: scope(1) });
  renderSessionTaskNotification(host, 'During the run.', scope(1));
  // The run's terminal event (sequence 2) never reaches the response; this notification followed it.
  renderSessionTaskNotification(host, 'After the run.', scope(2));
  await response.finish(response.active!, { interrupted: true, failed: false });
  await Promise.resolve();
  const after = state.messages.find(message => message.contentBlocks?.some(block => block.type === 'task_notification' && block.content === 'After the run.'))!;
  expect(after.isInterrupt).toBeUndefined();
  const header = within(messagesEl).getByRole('button', { name: INTERRUPTED });
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(within(messagesEl).getAllByRole('button', { name: 'Task notification', hidden: true })
    .map(button => history.contains(button))).toEqual([true, false]);
});

it('keeps a failed turn expanded', async () => {
  const { response, stream, messagesEl } = (await createSession());
  const live = response.start();
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, live);
  await stream.handleStreamChunk({ type: 'text', content: 'Partial answer' }, live);
  await response.finish(live, { interrupted: false, failed: true });
  expect(within(messagesEl).getByRole('button', { name: /Read.*note\.md/ })).toBeDefined();
  expect(within(messagesEl).getByText('Partial answer').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).queryByRole('button', { name: /^(Interrupted|Worked)/ })).toBeNull();
  const reply = messagesEl.querySelector<HTMLElement>(`[data-message-id="${live.id}"]`)!;
  expect(within(reply).getByRole('button', { name: 'Copy message' })).toBeDefined();
});

it.each([
  ':codex-file-citation{path="/vault/note.md" purpose="source"}',
  ':codex-file-citation[codex-file-citation]{line_range_start=3 path="/vault/note.md"}',
])('hides native file annotations live and after reload, while user text stays literal: %s', async directive => {
  const { response, stream, renderer, state, messagesEl } = (await createSession('codex', `Explain ${directive}`));
  const live = response.start();
  await stream.handleStreamChunk({ type: 'text', content: `The answer.${directive}` }, live);
  await response.finish(live, { interrupted: false, failed: false });
  await waitFor(() => expect(within(messagesEl).queryByText('The answer.')).not.toBeNull());
  expect(within(messagesEl).queryByText(`Explain ${directive}`)).not.toBeNull();
  const assistant = state.messages.find(message => message.role === 'assistant')!;
  expect(assistant.content).toBe(`The answer.${directive}`);
  expect(assistant.contentBlocks?.find(block => block.type === 'text')).toMatchObject({ content: `The answer.${directive}` });
  const native = [
    { type: 'event_msg', payload: { type: 'user_message', message: `Explain ${directive}` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `The answer.${directive}` }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((record, seconds) => JSON.stringify({ timestamp: testTime({ seconds }), ...record })).join('\n');
  const replay = parseCodexSessionTurns(native).flatMap(turn => turn.messages);
  expect(replay.find(message => message.role === 'assistant')?.content).toBe(`The answer.${directive}`);
  renderer.renderMessages(replay, () => 'Welcome');
  await waitFor(() => expect(within(messagesEl).queryByText('The answer.')).not.toBeNull());
  expect(within(messagesEl).queryByText(`Explain ${directive}`)).not.toBeNull();
  renderer.renderMessages(replay.map(message => ({ ...message, contentBlocks: undefined })), () => 'Welcome');
  await waitFor(() => expect(within(messagesEl).queryByText('The answer.')).not.toBeNull());
});

it('leaves file-annotation-like assistant text from other providers unchanged', async () => {
  const literal = 'Example :codex-file-citation{path="note.md"}';
  const { response, stream, renderer, state, messagesEl } = (await createSession('claude'));
  const live = response.start();
  await stream.handleStreamChunk({ type: 'text', content: literal }, live);
  await response.finish(live, { interrupted: false, failed: false });
  await waitFor(() => expect(within(messagesEl).queryByText(literal)).not.toBeNull());
  renderer.renderMessages(state.messages, () => 'Welcome');
  await waitFor(() => expect(within(messagesEl).queryByText(literal)).not.toBeNull());
});

it.each(['retired-provider', '', 'constructor'])('keeps cached historical presentation readable without a registered formatter (%s)', async providerId => {
  const messagesEl = document.body.createDiv();
  const plugin = await createChatFeatureHost({
    settings: { mediaFolder: '', showMessageTimestamps: false },
    getConversationSummary: () => ({ id: 'cached-session', title: 'Cached', providerId, createdAt: 1, lastActivityAt: 1 }),
  });
  const identity = { conversationId: 'cached-session', providerId, draftModel: null };
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl, undefined, undefined,
    () => getSessionCapabilities(identity, plugin));
  cleanups.push(() => renderer.dispose());
  const literal = 'Historical :codex-file-citation{path="note.md"}';
  renderer.renderMessages([{ id: 'cached-prompt', role: 'user', content: 'Earlier prompt', timestamp: testDate().getTime() },
    { id: 'cached-answer', role: 'assistant', content: literal,
    timestamp: testDate().getTime() }], () => 'Welcome');
  await waitFor(() => expect(within(messagesEl).queryByText(literal)).not.toBeNull());
});


it.each([true, false].flatMap(defer => [
  {
    defer, markdown: 'Attribute <span title="$x$">value</span>.',
    live: 'Attribute &lt;span title=&quot;\\$x\\$&quot;&gt;value&lt;/span&gt;.',
    final: 'Attribute &lt;span title=&quot;$x$&quot;&gt;value&lt;/span&gt;.',
  },
  {
    defer, markdown: '<script>\n$x$\n</script>',
    live: '&lt;script&gt;\n\\$x\\$\n&lt;/script&gt;',
    final: '&lt;script&gt;\n$x$\n&lt;/script&gt;',
  },
  {
    defer, markdown: 'Code `<span title="$code$">` and <span title="$x$">value</span> [Price](https://host/$price). Math $visible$.',
    live: 'Code `<span title="$code$">` and &lt;span title=&quot;\\$x\\$&quot;&gt;value&lt;/span&gt; [Price](https://host/$price). Math \\$visible\\$.',
    final: 'Code `<span title="$code$">` and &lt;span title=&quot;$x$&quot;&gt;value&lt;/span&gt; [Price](https://host/$price). Math $visible$.',
  },
  {
    defer, markdown: 'Math $x <span>y$ and \\(z\\).',
    live: 'Math \\$x &lt;span&gt;y\\$ and \\$z\\$.',
    final: 'Math $x <span>y$ and $z$.',
  },
  {
    defer, markdown: 'Literal <span title="\\(raw\\)">value</span>.',
    live: 'Literal &lt;span title=&quot;\\(raw\\)&quot;&gt;value&lt;/span&gt;.',
    final: 'Literal &lt;span title=&quot;\\(raw\\)&quot;&gt;value&lt;/span&gt;.',
  },
]))('defers math exposed by literal HTML through the real stream (enabled: $defer, $markdown)', async ({ defer, markdown, live: streaming, final }) => {
  const { response, stream, plugin } = (await createSession());
  plugin.settings.deferMathRenderingDuringStreaming = defer;
  const message = response.start();
  vi.mocked(MarkdownRenderer.render).mockClear();
  await stream.handleStreamChunk({ type: 'text', content: markdown }, message);
  await waitFor(() => expect(vi.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).toBe(defer ? streaming : final));
  await response.finish(message, { interrupted: false, failed: false });
  expect(vi.mocked(MarkdownRenderer.render).mock.calls.at(-1)?.[1]).toBe(final);
});
