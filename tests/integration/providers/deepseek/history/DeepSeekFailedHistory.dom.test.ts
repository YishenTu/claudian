/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"customExportConditions":["node","node-addons"]}
 */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { NativePeer, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ProviderExecutionEvent, ProviderExecutionSession } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import { DeepSeekConversationHistoryService } from '@/providers/deepseek/history/DeepSeekConversationHistoryService';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

const time = testDate().getTime();
const host = { settings: { locale: 'en', providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [
  { encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model' },
] } } } } as unknown as ProviderHost;
let peer: NativePeer;
let deepseek: DeepSeekHost;
let session: ProviderExecutionSession;
let renderer: MessageRenderer;

beforeEach(async () => {
  document.body.replaceChildren();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
  peer = new NativePeer();
  const native = nativeDefaults({ seq: () => 3, roster: () => ['root'] });
  peer.onCall = (method, args) => method === 'session/create'
    ? { sessionId: 'root', agentPreset: 'claudian' } : native.call(method, args);
  peer.onOpen = native.open;
  await peer.open();
  ({ deepseek } = peer.host());
  session = new DeepSeekExecutionBackend(runtimeHostFor(host, 'deepseek'), () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: '/vault',
    interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() },
  });
});

afterEach(async () => {
  renderer?.dispose();
  await session.dispose(); await deepseek.dispose(); await peer.close();
});

it.each([
  { kind: 'error', terminal: 'execution_error', completed: false, interrupted: false },
  { kind: 'blocked', terminal: 'execution_error', completed: false, interrupted: false },
  { kind: 'completed', terminal: 'turn_completed', completed: true, interrupted: false },
  { kind: 'max-tokens', terminal: 'turn_completed', completed: true, interrupted: false },
  { kind: 'aborted', terminal: 'cancelled', completed: false, interrupted: true },
])('keeps a $kind reply consistent with live completion and fork availability after reopening', async ({ kind, terminal, completed, interrupted }) => {
  const run = session.execute({
    input: [{ type: 'text', text: 'Please continue' }], signal: new AbortController().signal,
    configuration: { systemInstructions: { kind: 'explicit', instructions: 'Review' }, permissionMode: 'normal' },
    toolPolicy: { kind: 'provider-default' },
  });
  const events: ProviderExecutionEvent[] = [];
  const done = (async () => { for await (const event of run.events) events.push(event); })();
  await waitFor(() => expect(peer.calls.some(call => call.method === 'session/prompt')).toBe(true));
  const reason = kind === 'error' ? { kind, error: { message: 'Model request failed', code: 'NETWORK' } }
    : kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind };
  const records = [
    { seq: 4, time, type: 'turn/start', data: { turn: 1 } },
    { seq: 5, time, type: 'user/message', data: { id: 'user', source: { kind: 'user', rpcId: run.executionId }, content: [{ type: 'text', text: 'Please continue' }] } },
    { seq: 6, time: time + 1_000, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Committed partial reply' }] }, usage: { outputTokens: 7 } } },
    { seq: 7, time: time + 9_000, type: 'turn/end', data: { turn: 1, reason } },
  ].map(event => ({ type: 'event', event: { ...event, surfaceOp: 'append' } }));
  for (const record of records) peer.send('session/follow', record, rootFollow('root'));
  await done;
  expect(events.at(-1)).toMatchObject({ type: terminal });
  expect(events.filter(event => event.type === 'text_delta')).toEqual([
    expect.objectContaining({ type: 'text_delta', text: 'Committed partial reply' }),
  ]);
  expect(events.filter(event => event.type === 'turn_completed').map(event => ({ checkpoint: event.nativeCheckpointId, tokens: event.turnStats?.outputTokens })))
    .toEqual(completed ? [{ checkpoint: 'deepseek:seq:7', tokens: 7 }] : []);

  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/projections') return { asOfSeq: 7, values: { agentPreset: 'claudian' } };
    if (method === 'session/page') return { records, hasMore: false };
    return ordinary(method, args);
  };
  const history = new DeepSeekConversationHistoryService(async () => deepseek);
  const result = await history.hydrateConversationHistory({ sessionId: 'root', providerState: session.getSnapshot().providerState, messages: [] }, '/vault');
  const messages = result.messages!;
  expect(messages.map(message => [message.role, message.content])).toEqual([
    ['user', 'Please continue'], ['assistant', 'Committed partial reply'],
  ]);
  const messagesEl = document.body.createDiv();
  const fork = vi.fn().mockResolvedValue(undefined);
  renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: true } } as any,
    new Component() as any, messagesEl, undefined, fork, () => ProviderRegistry.getCapabilities('deepseek'));
  renderer.renderMessages(messages, () => 'Hello');
  await waitFor(() => expect(within(messagesEl).getByText('Committed partial reply')).toBeDefined());
  const view = within(messagesEl);
  expect(view.queryByRole('button', { name: /^Worked/ })?.textContent ?? null).toBe(completed ? 'Worked for 00:09' : null);
  const forkButton = view.queryByRole('button', { name: 'Fork conversation' });
  expect(forkButton !== null).toBe(completed);
  if (forkButton) fireEvent.click(forkButton);
  expect(fork.mock.calls).toEqual(completed ? [[messages[1].id]] : []);
  expect(view.getByText('Committed partial reply').closest('[hidden]') !== null).toBe(interrupted);
  expect(view.queryByRole('button', { name: /^Interrupted/ }) !== null).toBe(interrupted);
  // Stop retains its native history checkpoint, but offers no final answer to fork.
  expect(messages[1].assistantMessageId ?? null)
    .toBe(completed || interrupted ? 'deepseek:seq:7' : null);
  expect(messages[1].completedAt).toBe(completed ? time + 9_000 : undefined);
  expect(messages[1].turnStats).toEqual(completed ? { outputTokens: 7, durationMs: 9_000 } : undefined);
  expect((await axe(messagesEl)).violations).toEqual([]);
});
