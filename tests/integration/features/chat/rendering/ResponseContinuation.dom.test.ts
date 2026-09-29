/** @jest-environment jsdom */
import '@/providers';

import * as reviewFs from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';

import { testDate, testTime } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { continueResponseAfterNotification } from '@/features/chat/rendering/ResponseContinuation';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

jest.mock('node:fs/promises');
const originalStructuredClone = globalThis.structuredClone;
beforeAll(() => { globalThis.structuredClone = value => deserialize(serialize(value)); });
afterAll(() => { globalThis.structuredClone = originalStructuredClone; });

async function hydrateCachedMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const history = await new ClaudeConversationHistoryService().hydrateConversationHistory({
    sessionId: 'session', messages, providerState: {},
  }, null);
  return history.messages!;
}
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it.each(['early', 'late', 'none'])('matches live and JSONL notification order with tool result=%s', async resultTiming => {
  const hasTool = resultTiming !== 'none';
  const lateResult = resultTiming === 'late';
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  const order = () => {
    const worked = within(messagesEl).getByRole('button', { name: /^Worked(?: for \d+:\d+)?$/ });
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification', hidden: true });
    const answer = within(messagesEl).getByText('Requested answer.');
    const history = document.getElementById(worked.getAttribute('aria-controls')!);
    expect(history!.contains(notification)).toBe(true);
    expect(worked.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    return (notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  };
  try {
    state.addMessage(response);
    state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
    if (hasTool) await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, response);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const notificationElement = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const toolMessage = response;
    if (hasTool && !lateResult) await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, response);
    response = await continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, response, { type: 'text', content: 'Requested answer.' });
    await stream.handleStreamChunk({ type: 'text', content: 'Requested answer.' }, response);
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, response);
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_output', id: 'read', content: 'Partial output' }, response);
    expect(toolMessage.toolCalls?.[0].result).toBe(hasTool ? (lateResult ? 'Partial output' : 'The note.') : undefined);
    if (lateResult) await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'The note.' }, response);
    const completedTool = expect.objectContaining({ id: 'read', status: 'completed', result: 'The note.' });
    expect(toolMessage.toolCalls ?? []).toEqual(hasTool ? [completedTool] : []);
    await stream.finalizeCurrentTextBlock(response);
    expect(response.contentBlocks).toEqual([{ type: 'text', content: 'Requested answer.' }]);
    response.durationSeconds = 18;
    const toolElement = hasTool ? within(messagesEl).getByRole('button', { name: /Read.*note\.md/ }) : null;
    renderer.finalizeResponse(response, state.messages);
    const worked = within(messagesEl).getByRole('button', { name: 'Worked for 00:18' });
    const history = document.getElementById(worked.getAttribute('aria-controls')!);
    expect(history!.contains(toolElement)).toBe(hasTool);
    expect(history!.contains(notificationElement)).toBe(true);
    expect(notificationElement.closest('[hidden]')).not.toBeNull();
    expect(Boolean(toolElement?.closest('[hidden]'))).toBe(hasTool);
    fireEvent.click(worked);
    expect(toolElement?.closest('[hidden]') ?? null).toBeNull();
    expect(within(messagesEl).getByText('Requested answer.').closest('[hidden]')).toBeNull();
    const liveNotificationBeforeAnswer = order();
    renderer.finalizeResponse(response, state.messages);
    expect(within(messagesEl).getAllByRole('button', { name: 'Worked for 00:18' })).toEqual([worked]);
    expect((await axe(messagesEl)).violations).toEqual([]);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(order()).toBe(true);
    renderer.renderMessages(await hydrateCachedMessages(state.messages), () => 'Welcome');
    await Promise.resolve();
    expect(order()).toBe(true);
    const entries = [
      { type: 'user', uuid: 'u', timestamp: testTime({ seconds: 0 }), message: { content: 'Read a note' } },
      ...(hasTool ? [{ type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: testTime({ seconds: 1 }), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
      { type: 'user', uuid: 'result', parentUuid: 'tool', timestamp: testTime({ seconds: 2 }), toolUseResult: { content: 'The note.' }, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
      ] : []),
      { type: 'attachment', uuid: 'notification', parentUuid: hasTool ? 'result' : 'u', timestamp: testTime({ seconds: 3 }), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>task</task-id><status>completed</status><summary>Task finished.</summary></task-notification>' } },
      { type: 'assistant', uuid: 'answer', parentUuid: 'notification', timestamp: testTime({ seconds: 5 }), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Requested answer.' }] } },
    ];
    jest.mocked(reviewFs.readFile).mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));
    const replay = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');
    expect(replay.error).toBeUndefined();
    messagesEl.replaceChildren();
    replay.messages.forEach((message, index) => renderer.renderStoredMessage(message, replay.messages, index));
    await Promise.resolve();
    const replayNotificationBeforeAnswer = order();
    expect(replayNotificationBeforeAnswer).toBe(true);
    expect({ liveNotificationBeforeAnswer }).toEqual({ liveNotificationBeforeAnswer: replayNotificationBeforeAnswer });
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each(['between', 'during-second', 'after-second'])('groups an older task notification by consumption position: %s', async position => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const prefix = [
    { type: 'user', uuid: 'first-user', timestamp: testTime({ seconds: 0 }), message: { content: 'Start background research.' } },
    { type: 'assistant', uuid: 'launch', timestamp: testTime({ seconds: 1 }), message: { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'old-task', name: 'Agent', input: { description: 'First turn research', run_in_background: true } },
    ] } },
    { type: 'user', uuid: 'launched', timestamp: testTime({ seconds: 2 }), toolUseResult: { agentId: 'old-agent', isAsync: true }, message: { content: [
      { type: 'tool_result', tool_use_id: 'old-task', content: '{"agent_id":"old-agent"}' },
    ] } },
    { type: 'assistant', uuid: 'first-final', timestamp: testTime({ seconds: 3 }), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'First answer.' }] } },
  ];
  const notification = { type: 'attachment', uuid: 'notification', timestamp: testTime({ seconds: 2 }), attachment: {
    type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification><task-id>old-agent</task-id><tool-use-id>old-task</tool-use-id><status>completed</status><summary>Old research finished.</summary></task-notification>',
  } };
  const secondUser = { type: 'user', uuid: 'second-user', timestamp: testTime({ seconds: 10 }), message: { content: 'Next request.' } };
  const secondFinal = { type: 'assistant', uuid: 'second-final', timestamp: testTime({ seconds: 13 }), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second answer.' }] } };
  const nativeRows = [...prefix, ...(position === 'between' ? [notification] : []), secondUser,
    ...(position === 'during-second' ? [notification] : []), secondFinal,
    ...(position === 'after-second' ? [notification] : [])];
  const loadNative = async (rows: typeof nativeRows) => {
    jest.mocked(reviewFs.readFile).mockResolvedValue(rows.map((row, index) => JSON.stringify({
      ...row, parentUuid: rows[index - 1]?.uuid,
    })).join('\n'));
    return loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');
  };
  const notify = () => renderSessionTaskNotification({ state, renderer, isConnected: () => true,
    createMessageId: () => 'notification' }, 'Old research finished.');
  const assertPlacement = () => {
    const headers = within(messagesEl).getAllByRole('button', { name: /^Worked for/ });
    expect(headers).toHaveLength(2);
    const histories = headers.map(header => document.getElementById(header.getAttribute('aria-controls')!)!);
    const notice = within(messagesEl).getByRole('button', { name: 'Task notification', hidden: true });
    expect(histories[0].contains(notice)).toBe(false);
    expect(histories[1].contains(notice)).toBe(position === 'during-second');
    const originalTask = within(messagesEl).getByRole('button', { name: /Background task: First turn research/, hidden: true });
    expect(histories[0].contains(originalTask)).toBe(true);
    expect(histories[1].contains(originalTask)).toBe(false);
    const firstAnswer = within(messagesEl).getByText('First answer.');
    const secondAnswer = within(messagesEl).getByText('Second answer.');
    expect(firstAnswer.closest('[hidden]')).toBeNull();
    expect(secondAnswer.closest('[hidden]')).toBeNull();
    expect(firstAnswer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Boolean(notice.compareDocumentPosition(secondAnswer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(position !== 'after-second');
  };
  try {
    const firstTurn = await loadNative(prefix);
    expect(firstTurn.error).toBeUndefined();
    state.messages = firstTurn.messages;
    renderer.renderMessages(state.messages, () => 'Welcome');
    if (position === 'between') notify();
    const user: ChatMessage = { id: 'second-user', role: 'user', timestamp: testDate().getTime(), content: 'Next request.' };
    state.addMessage(user);
    renderer.addMessage(user);
    let response: ChatMessage = { id: 'second-response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
    state.addMessage(response);
    state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
    if (position === 'during-second') notify();
    const text = { type: 'text' as const, content: 'Second answer.' };
    response = await continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'second-continuation' }, response, text);
    await stream.handleStreamChunk(text, response);
    await stream.finalizeCurrentTextBlock(response);
    response.durationSeconds = 3;
    renderer.finalizeResponse(response, state.messages);
    if (position === 'after-second') notify();
    assertPlacement();
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    assertPlacement();
    const replay = await loadNative(nativeRows);
    expect(replay.error).toBeUndefined();
    renderer.renderMessages(replay.messages, () => 'Welcome');
    await Promise.resolve();
    assertPlacement();
    const locate = jest.spyOn(historyStore, 'locateSDKSessions').mockResolvedValue(new Map([
      ['session', { availability: 'relocated', sessionPath: '/session.jsonl' }],
    ]));
    try {
      const cachedOnly: ChatMessage = { id: 'cached-only', role: 'assistant', content: 'Cached commentary.',
        timestamp: testDate({ seconds: 11 }).getTime() };
      const cachedWithExtra = [...replay.messages];
      cachedWithExtra.splice(cachedWithExtra.findIndex(message => message.id === 'second-user') + 1, 0, cachedOnly);
      for (const cached of [[], replay.messages, cachedWithExtra]) {
        const hydrated = await new ClaudeConversationHistoryService().hydrateConversationHistory({
          sessionId: 'session', messages: cached, providerState: {},
        }, '/vault');
        expect(hydrated.messages!.filter(message => message.id !== cachedOnly.id).map(message => message.id))
          .toEqual(replay.messages.map(message => message.id));
        const secondUserIndex = hydrated.messages!.findIndex(message => message.id === 'second-user');
        expect(hydrated.messages!.findIndex(message => message.id === cachedOnly.id))
          .toBe(cached === cachedWithExtra ? secondUserIndex + 1 : -1);
        renderer.renderMessages(hydrated.messages!, () => 'Welcome');
        await Promise.resolve();
        assertPlacement();
      }
    } finally { locate.mockRestore(); }
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each(['child', 'result', 'snapshot'] as const)('keeps a pending Agent before a notification when resolved by %s', async resolution => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const original: ChatMessage = { id: 'original', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
  try {
    state.addMessage(original);
    state.currentContentEl = renderer.addMessage(original).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Research' } }, original);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const text = { type: 'text' as const, content: 'Continuation.' };
    const continuation = await continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, original, text);
    await stream.handleStreamChunk(text, continuation);
    if (resolution === 'child') {
      await stream.handleStreamChunk({ type: 'subagent_tool_use', subagentId: 'agent', id: 'child-read', name: 'Read', input: { file_path: 'note.md' } }, continuation);
    } else if (resolution === 'result') {
      await stream.handleStreamChunk({ type: 'tool_result', id: 'agent', content: 'Research answer.' }, continuation);
    } else {
      await stream.handleStreamChunk({ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Research', run_in_background: false } }, continuation);
    }
    await stream.finalizeCurrentTextBlock(continuation);
    expect(original.toolCalls).toEqual([expect.objectContaining({ id: 'agent', subagent: expect.objectContaining({ description: 'Research' }) })]);
    expect(continuation.toolCalls).toEqual([]);
    const card = within(messagesEl).getByRole('button', { name: /Subagent task: Research/ });
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    expect(card.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(continuation.contentBlocks).toEqual([{ type: 'text', content: 'Continuation.' }]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it('does not recreate a response after its conversation is cleared during finalization', async () => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const original: ChatMessage = { id: 'original', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
  try {
    state.addMessage(original);
    state.currentContentEl = renderer.addMessage(original).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'text', content: 'Earlier text.' }, original);
    renderSessionTaskNotification({ state, renderer, isConnected: () => true, createMessageId: () => 'notification' }, 'Task finished.');
    const pending = continueResponseAfterNotification({ state, renderer, stream, createMessageId: () => 'continuation' }, original, { type: 'text', content: 'Later text.' });
    state.clearMessages();
    messagesEl.replaceChildren();
    await pending;
    expect(state.messages).toEqual([]);
    expect(messagesEl.childElementCount).toBe(0);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it.each(['background', 'user'] as const)('groups only the requested response across notifications with intervening %s output', async intervening => {
  const { renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, isConnected: () => true, createMessageId: () => `part-${++nextId}` };
  let response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  try {
    state.addMessage(response);
    state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, response);
    renderSessionTaskNotification(host, 'First notification.');
    response = await continueResponseAfterNotification(host, response, { type: 'text', content: 'Still working.' });
    await stream.handleStreamChunk({ type: 'text', content: 'Still working.' }, response);
    await stream.handleStreamChunk({ type: 'tool_use', id: 'second-read', name: 'Read', input: { file_path: 'second.md' } }, response);
    const other: ChatMessage = { id: 'other', role: intervening === 'user' ? 'user' : 'assistant',
      isAutomaticResponse: intervening === 'background', timestamp: testDate().getTime(), content: 'Independent output.' };
    state.addMessage(other);
    renderer.renderStoredMessage(other);
    renderSessionTaskNotification(host, 'Second notification.');
    response = await continueResponseAfterNotification(host, response, { type: 'text', content: 'Final answer.' });
    await stream.handleStreamChunk({ type: 'text', content: 'Final answer.' }, response);
    await stream.finalizeCurrentTextBlock(response);
    response.durationSeconds = 18;
    renderer.finalizeResponse(response, state.messages);
    const header = within(messagesEl).getByRole('button', { name: 'Worked for 00:18' });
    const history = document.getElementById(header.getAttribute('aria-controls')!)!;
    const cards = within(messagesEl).getAllByRole('button', { name: /Read.*(?:note|second)\.md/, hidden: true });
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(history.contains(card)).toBe(intervening === 'background');
    const commentary = within(messagesEl).getByText('Still working.');
    const notifications = within(messagesEl).getAllByRole('button', { name: 'Task notification', hidden: true });
    expect(history.contains(commentary)).toBe(intervening === 'background');
    for (const notification of notifications) expect(history.contains(notification)).toBe(intervening === 'background');
    expect(notifications[0].compareDocumentPosition(commentary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commentary.compareDocumentPosition(notifications[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(history.contains(messagesEl.querySelector('[data-message-id="other"]'))).toBe(false);
    expect(notifications).toHaveLength(2);
    expect(within(messagesEl).getByText('Final answer.').closest('[hidden]')).toBeNull();
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});

it('keeps a notification consumed by an automatic response outside an admitted requested turn', async () => {
  const { renderAutoTriggeredTurn, renderSessionTaskNotification } = await import('@/features/chat/rendering/BackgroundTurnRenderer');
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const state = new ChatState();
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, isConnected: () => true, createMessageId: () => `part-${++nextId}` };
  let response: ChatMessage = { id: 'requested', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  const scope = { kind: 'background' as const, sessionInstanceId: 'session', turnId: 'automatic', sequence: 1 };
  const assertOwnership = () => {
    const worked = within(messagesEl).getByRole('button', { name: 'Worked for 00:18' });
    const history = document.getElementById(worked.getAttribute('aria-controls')!)!;
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const notificationHistory = document.getElementById(notification.getAttribute('aria-controls')!)!;
    const tool = within(messagesEl).getByRole('button', { name: /Read.*background\.md/, hidden: true });
    expect(history.contains(notification)).toBe(false);
    expect(history.contains(tool)).toBe(false);
    expect(notificationHistory.contains(tool)).toBe(true);
    expect(within(messagesEl).getByText('Automatic answer.').closest('[hidden]')).toBeNull();
    expect(within(messagesEl).getByText('Requested answer.').closest('[hidden]')).toBeNull();
  };
  try {
    state.addMessage(response);
    state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
    renderSessionTaskNotification(host, 'Background task finished.');
    await renderAutoTriggeredTurn(host, {
      metadata: {}, events: [
        { type: 'tool_started', scope, toolCallId: 'background-read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'background.md' } },
        { type: 'tool_completed', scope: { ...scope, sequence: 2 }, toolCallId: 'background-read', toolScope: { kind: 'main' }, content: 'Background content.' },
        { type: 'text_delta', scope: { ...scope, sequence: 3 }, text: 'Automatic answer.' },
      ],
    }, () => true);
    const text = { type: 'text' as const, content: 'Requested answer.' };
    response = await continueResponseAfterNotification(host, response, text);
    await stream.handleStreamChunk(text, response);
    await stream.finalizeCurrentTextBlock(response);
    response.durationSeconds = 18;
    renderer.finalizeResponse(response, state.messages);
    assertOwnership();
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    assertOwnership();
    renderer.renderMessages(await hydrateCachedMessages(state.messages), () => 'Welcome');
    await Promise.resolve();
    assertOwnership();
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    stream.dispose(); subagents.clear(); renderer.dispose();
  }
});
