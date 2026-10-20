/** @jest-environment jsdom */
import '@/providers';

import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import { StreamController } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

jest.mock('node:fs/promises');
const writeSession = useClaudeSessionFiles();
HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
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
});

const INTERRUPTED = 'Interrupted · What should Claudian do instead?';
/** Native turn steps after its first output: a reply cut off by `max_tokens` and resumed work continue the same turn. */
type Boundary = 'notification' | 'compaction' | 'max-tokens' | 'tool' | 'text';
interface Turn {
  readonly automatic: boolean;
  readonly boundaries: readonly Boundary[];
  readonly afterTool: boolean;
  readonly output: boolean;
}

function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden]') && node.textContent?.trim()) parts.push(node.textContent.trim());
  }
  return parts.join(' ');
}

/** What a reader sees: the transcript collapsed, and the interrupted body expanded. */
function inspect(root: HTMLElement) {
  const headers = within(root).queryAllByRole('button', { name: INTERRUPTED });
  const collapsed = Array.from(root.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
  const header = headers[0];
  if (!header) return { headers: 0, collapsed, body: null };
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  fireEvent.click(header);
  const body = visibleText(history);
  fireEvent.click(header);
  return { headers: headers.length, collapsed, body };
}

/**
 * The spec, independent of the implementation: everything a stopped turn did after its
 * prompt folds under one header, except an automatic turn's notifications before its
 * first other output, which read like its prompt.
 */
function expected(turn: Turn) {
  const items = [
    ...(turn.afterTool ? ['Before.', 'Read'] : []),
    ...turn.boundaries.map(boundary => ({
      notification: 'Task notification', compaction: 'Conversation compacted', 'max-tokens': 'Truncated.', tool: 'Read', text: 'Resumed.',
    })[boundary]),
    ...(turn.output ? ['After.'] : []),
  ];
  const leading = turn.automatic ? items.findIndex(item => item !== 'Task notification') : 0;
  const outside = items.slice(0, leading);
  const inside = items.slice(leading);
  const escape = (item: string) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    headers: 1,
    collapsed: [turn.automatic ? 'Task notification' : 'Do the work', ...outside, INTERRUPTED].join(' '),
    body: expect.stringMatching(new RegExp(`^${inside.map(escape).join('.*')}`)),
  };
}

async function renderLive(turn: Turn): Promise<HTMLElement> {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const turns = new TurnCoordinator();
  const state = new ChatState({}, undefined, turns);
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, turns, createMessageId: () => `message-${++nextId}` };
  cleanups.push(() => { stream.dispose(); subagents.clear(); renderer.dispose(); });

  if (turn.automatic) {
    const background = new BackgroundResponses(host);
    const scope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'automatic', sequence: 0 };
    const next = () => ({ ...scope, sequence: ++scope.sequence });
    const handle = (event: Record<string, unknown>) => background.handle('binding', { ...event, scope: next() } as any, () => true);
    renderSessionTaskNotification(host, 'Trigger finished.', undefined, next());
    background.reserve('binding', 'automatic');
    if (turn.afterTool) {
      await handle({ type: 'text_delta', text: 'Before.' });
      await handle({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } });
      await handle({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'The note.' });
    }
    for (const boundary of turn.boundaries) {
      if (boundary === 'notification') renderSessionTaskNotification(host, 'Job finished.', undefined, next());
      else if (boundary === 'compaction') await handle({ type: 'context_compacted' });
      else if (boundary === 'max-tokens') await handle({ type: 'text_delta', text: 'Truncated.' });
      else if (boundary === 'text') await handle({ type: 'text_delta', text: 'Resumed.' });
      else {
        await handle({ type: 'tool_started', toolCallId: 'more', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'more.md' } });
        await handle({ type: 'tool_completed', toolCallId: 'more', toolScope: { kind: 'main' }, content: 'More.' });
      }
    }
    if (turn.output) await handle({ type: 'text_delta', text: 'After.' });
    await handle({ type: 'background_turn_completed', reason: 'interrupted' });
  } else {
    const response = new ResponseStream(host);
    const prompt = { id: 'prompt', role: 'user' as const, content: 'Do the work', timestamp: testDate().getTime() };
    state.addMessage(prompt);
    renderer.addMessage(prompt);
    response.start();
    // Provider events carry the run's scope; a notification records the event it followed.
    let scope = { kind: 'requested' as const, sessionInstanceId: 'native', executionId: 'execution', turnId: 'turn', sequence: 0 };
    const emit = (event: Record<string, unknown>) => {
      scope = { ...scope, sequence: scope.sequence + 1 };
      return response.handleEvent({ ...event, scope } as ProviderExecutionEvent);
    };
    if (turn.afterTool) {
      await emit({ type: 'text_delta', text: 'Before.' });
      await emit({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } });
      await emit({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'The note.' });
    }
    for (const boundary of turn.boundaries) {
      if (boundary === 'notification') renderSessionTaskNotification(host, 'Job finished.', scope);
      else if (boundary === 'compaction') await emit({ type: 'context_compacted' });
      else if (boundary === 'max-tokens') await emit({ type: 'text_delta', text: 'Truncated.' });
      else if (boundary === 'text') await emit({ type: 'text_delta', text: 'Resumed.' });
      else {
        await emit({ type: 'tool_started', toolCallId: 'more', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'more.md' } });
        await emit({ type: 'tool_completed', toolCallId: 'more', toolScope: { kind: 'main' }, content: 'More.' });
      }
    }
    if (turn.output) await emit({ type: 'text_delta', text: 'After.' });
    await response.finish(response.active!, { interrupted: true, failed: false });
  }
  await Promise.resolve();
  return messagesEl;
}

/**
 * The same turn as Claude Code records it, stopped with `[Request interrupted by user]`.
 * Since 2.1.274 every user-type record of a native turn carries its `promptId`, and a
 * notification consumed mid-turn is a `queued_command` attachment without one;
 * earlier transcripts have neither.
 */
async function renderClaudeReload(turn: Turn, promptIds = false): Promise<HTMLElement> {
  let seconds = 0;
  const at = () => new Date(testDate().getTime() + ++seconds * 1_000).toISOString();
  const promptId = promptIds ? { promptId: 'native-turn' } : {};
  const notification = (summary: string) => `<task-notification><task-id>${summary}</task-id><status>completed</status><summary>${summary}</summary></task-notification>`;
  const records: unknown[] = [turn.automatic
    ? { type: 'user', uuid: 'start', timestamp: at(), ...promptId, message: { content: notification('Trigger finished.') } }
    : { type: 'user', uuid: 'start', timestamp: at(), ...promptId, message: { content: 'Do the work' } }];
  if (turn.afterTool) {
    records.push(
      { type: 'assistant', uuid: 'tool', timestamp: at(), message: { stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Before.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
      { type: 'user', uuid: 'result', timestamp: at(), ...promptId, toolUseResult: { content: 'The note.' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
    );
  }
  turn.boundaries.forEach((boundary, index) => records.push(...{
    notification: [promptIds
      ? { type: 'attachment', uuid: `boundary-${index}`, timestamp: at(),
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notification('Job finished.') } }
      : { type: 'user', uuid: `boundary-${index}`, timestamp: at(), message: { content: notification('Job finished.') } }],
    compaction: [{ type: 'system', subtype: 'compact_boundary', uuid: `boundary-${index}`, timestamp: at(),
      content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }],
    'max-tokens': [{ type: 'assistant', uuid: `boundary-${index}`, timestamp: at(), message: { stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Truncated.' }] } }],
    text: [{ type: 'assistant', uuid: `boundary-${index}`, timestamp: at(), message: { content: [{ type: 'text', text: 'Resumed.' }] } }],
    tool: [
      { type: 'assistant', uuid: `boundary-${index}`, timestamp: at(), message: { stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'more', name: 'Read', input: { file_path: 'more.md' } }] } },
      { type: 'user', uuid: `boundary-${index}-result`, timestamp: at(), ...promptId, toolUseResult: { content: 'More.' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'more', content: 'More.' }] } },
    ],
  }[boundary]));
  if (turn.output) records.push({ type: 'assistant', uuid: 'after', timestamp: at(), message: { content: [{ type: 'text', text: 'After.' }] } });
  records.push({ type: 'user', uuid: 'interrupt', timestamp: at(), ...promptId, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession(records));
  expect(replay.error).toBeUndefined();
  // Every segment of the stopped turn keeps the provenance the turn opened with.
  const assistants = replay.messages.filter(message => message.role === 'assistant');
  expect(assistants.map(message => message.isAutomaticResponse === true)).toEqual(assistants.map(() => turn.automatic));
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any,
    new Component(), messagesEl);
  cleanups.push(() => renderer.dispose());
  renderer.renderMessages(replay.messages, () => 'Welcome');
  await Promise.resolve();
  return messagesEl;
}

const turns: Turn[] = [false, true].flatMap(automatic => [
  ...[['notification', 'compaction'], ['compaction', 'notification']].flatMap(boundaries => [false, true].flatMap(afterTool =>
    [true, false].map(output => ({ automatic, boundaries: boundaries as Boundary[], afterTool, output })))),
  // A reply cut off by `max_tokens` is not the end of its turn: resumed work and later notifications still belong to it.
  ...[['compaction', 'max-tokens', 'tool', 'notification'], ['compaction', 'max-tokens', 'text', 'notification']].map(boundaries =>
    ({ automatic, boundaries: boundaries as Boundary[], afterTool: true, output: true })),
]);

it.each(turns.map(turn => [
  `${turn.automatic ? 'automatic' : 'requested'}: ${turn.afterTool ? 'tool call' : 'start'} → ${turn.boundaries.join(' → ')}${turn.output ? ' → output' : ''} → Stop`,
  turn,
] as const))('folds a stopped Claude turn identically live and on reload (%s)', async (_name, turn) => {
  const live = inspect(await renderLive(turn));
  expect(live).toEqual(expected(turn));
  for (const promptIds of [false, true]) {
    const reload = inspect(await renderClaudeReload(turn, promptIds));
    expect(reload).toEqual(expected(turn));
    // Tool cards may word a result differently on reload; the transcript a reader sees is the same.
    expect(reload.collapsed).toBe(live.collapsed);
  }
});

// Claude Code 2.1.303 records a blocking Stop hook as an `end_turn` reply, a meta user
// `Stop hook feedback` record and a `stop_hook_summary`; the same native turn then continues.
it.each([true, false])('folds a turn a Stop hook continued after end_turn identically live and on reload (compaction: %s)', async compaction => {
  const turn: Turn = { automatic: false, boundaries: compaction ? ['notification', 'compaction'] : ['notification'], afterTool: true, output: true };
  const live = inspect(await renderLive(turn));
  const expectedTurn = { ...expected(turn), body: expect.stringMatching(compaction
    ? /^Before\..*Read.*Task notification.*Conversation compacted.*After\./ : /^Before\..*Read.*Task notification.*After\./) };
  expect(live).toEqual(expectedTurn);

  let seconds = 0;
  const at = () => new Date(testDate().getTime() + ++seconds * 1_000).toISOString();
  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession([
    { type: 'user', uuid: 'start', timestamp: at(), message: { content: 'Do the work' } },
    { type: 'assistant', uuid: 'tool', timestamp: at(), message: { stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Before.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
    { type: 'user', uuid: 'result', timestamp: at(), toolUseResult: { content: 'The note.' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
    { type: 'user', uuid: 'notification', timestamp: at(), message: { content:
      '<task-notification><task-id>job</task-id><status>completed</status><summary>Job finished.</summary></task-notification>' } },
    ...(compaction ? [{ type: 'system', subtype: 'compact_boundary', uuid: 'compact', timestamp: at(),
      content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }] : []),
    { type: 'assistant', uuid: 'stopped', timestamp: at(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'After.' }] } },
    { type: 'user', uuid: 'feedback', isMeta: true, timestamp: at(), message: { content: 'Stop hook feedback:\nKeep going.' } },
    { type: 'system', subtype: 'stop_hook_summary', uuid: 'hooks', timestamp: at(), hookCount: 1, hookInfos: [],
      hookErrors: ['Keep going.'], preventedContinuation: false, stopReason: '', hasOutput: true, level: 'suggestion' },
    { type: 'assistant', uuid: 'continued', timestamp: at(), message: { content: [{ type: 'thinking', thinking: 'More.' }] } },
    { type: 'user', uuid: 'interrupt', timestamp: at(), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]));
  expect(replay.error).toBeUndefined();
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any,
    new Component(), messagesEl);
  cleanups.push(() => renderer.dispose());
  renderer.renderMessages(replay.messages, () => 'Welcome');
  await Promise.resolve();
  const reload = inspect(messagesEl);
  expect(reload).toEqual(expectedTurn);
  expect(reload.collapsed).toBe(live.collapsed);
});

async function renderTranscript(records: unknown[]): Promise<HTMLElement> {
  const replay = await loadSDKSessionMessages('/vault', 'session', undefined, writeSession(records));
  expect(replay.error).toBeUndefined();
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any,
    new Component(), messagesEl);
  cleanups.push(() => renderer.dispose());
  renderer.renderMessages(replay.messages, () => 'Welcome');
  await Promise.resolve();
  return messagesEl;
}

const notificationContent = '<task-notification><task-id>job</task-id><status>completed</status><summary>Job finished.</summary></task-notification>';

// A notification after a finished turn starts the next, automatic turn: a new `promptId` alone
// tells, whatever the previous reply recorded; older transcripts show it by the finished reply.
it.each([
  ['promptId, no stop reason', true, undefined],
  ['promptId, end_turn', true, 'end_turn'],
  ['no promptId, end_turn', false, 'end_turn'],
] as const)('starts a new automatic turn at a notification after a finished reply (%s)', async (_name, promptIds, stopReason) => {
  let seconds = 0;
  const at = () => new Date(testDate().getTime() + ++seconds * 1_000).toISOString();
  const first = promptIds ? { promptId: 'first' } : {};
  const second = promptIds ? { promptId: 'second' } : {};
  const messagesEl = await renderTranscript([
    { type: 'user', uuid: 'prompt', ...first, timestamp: at(), message: { content: 'Do the work' } },
    { type: 'assistant', uuid: 'reply', timestamp: at(), message: { ...(stopReason ? { stop_reason: stopReason } : {}),
      content: [{ type: 'text', text: 'Requested reply.' }] } },
    { type: 'user', uuid: 'notification', ...second, timestamp: at(), message: { content: notificationContent } },
    { type: 'assistant', uuid: 'automatic', timestamp: at(), message: { content: [{ type: 'text', text: 'Automatic reply.' }] } },
    { type: 'user', uuid: 'interrupt', ...second, timestamp: at(), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]);
  // The first turn completed: it renders as any completed reply does.
  expect(inspect(messagesEl)).toEqual({ headers: 1, collapsed: `Do the work Worked for 00:01 Requested reply. Task notification ${INTERRUPTED}`,
    body: 'Automatic reply.' });
});

// Claude records an interrupt as a user-role marker; it ends the stopped turn and prompts nothing,
// so the automatic turn after it keeps its trigger outside its own fold.
it.each([true, false])('keeps an automatic turn\'s trigger visible after an interrupted turn (promptIds: %s)', async promptIds => {
  let seconds = 0;
  const at = () => new Date(testDate().getTime() + ++seconds * 1_000).toISOString();
  const first = promptIds ? { promptId: 'first' } : {};
  const second = promptIds ? { promptId: 'second' } : {};
  const interrupt = { message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  const messagesEl = await renderTranscript([
    { type: 'user', uuid: 'prompt', ...first, timestamp: at(), message: { content: 'Do the work' } },
    { type: 'assistant', uuid: 'requested', timestamp: at(), message: { content: [{ type: 'text', text: 'Requested partial.' }] } },
    { type: 'user', uuid: 'first-interrupt', ...first, timestamp: at(), ...interrupt },
    { type: 'user', uuid: 'notification', ...second, timestamp: at(), message: { content: notificationContent } },
    { type: 'assistant', uuid: 'automatic', timestamp: at(), message: { content: [{ type: 'text', text: 'Automatic partial.' }] } },
    { type: 'user', uuid: 'second-interrupt', ...second, timestamp: at(), ...interrupt },
  ]);
  const headers = within(messagesEl).getAllByRole('button', { name: INTERRUPTED });
  expect(inspect(messagesEl).collapsed).toBe(`Do the work ${INTERRUPTED} Task notification ${INTERRUPTED}`);
  expect(headers.map(header => {
    fireEvent.click(header);
    return visibleText(document.getElementById(header.getAttribute('aria-controls')!)!);
  })).toEqual(['Requested partial.', 'Automatic partial.']);
});
