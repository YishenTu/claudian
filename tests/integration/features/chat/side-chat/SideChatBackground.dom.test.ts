/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { screen, waitFor } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { cancelSelectedDestinationTurn } from '@/features/chat/tabs/TabInputEvents';

const subagentAdapter = ProviderRegistry.getSubagentAdapter('claude')!;
const taskResultInterpreter = ProviderRegistry.getTaskResultInterpreter('claude');

beforeEach(() => {
  jest.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).textContent = markdown;
  });
});
afterEach(async () => { await releaseSideChatHarnesses(); jest.restoreAllMocks(); });

async function finishedSide() {
  const harness = createHarness();
  Object.assign(harness.tab.controllers, { sideChatController: harness.controller });
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('side-session');
  harness.backend.latest.emitText('Requested answer');
  harness.backend.latest.complete();
  await started;
  return harness;
}

it('shows late background results in side and queues follow-ups until settlement', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('working'));
  harness.controller.collapse();
  expect(await harness.controller.handleCommandSubmission('Follow up after background', [])).toBe(true);
  expect(harness.controller.runtime?.queuedCount).toBe(1);
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Late background answer' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'late-answer' });
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].conversationHistory).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', content: 'Late background answer', assistantMessageId: 'late-answer' }),
  ]));
  native.complete();
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('idle'));
  harness.controller.expand();
  expect(screen.getByText('Late background answer')).toBeDefined();
  expect(harness.tab.state.messages.map(message => message.content)).toEqual(['Remember A', 'Noted A']);
});

it('cancels only side background work and drops its queued follow-ups', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  await waitFor(() => expect(harness.controller.runtime?.isWorking).toBe(true));
  harness.controller.collapse();
  await harness.controller.handleCommandSubmission('Queued side prompt', []);
  harness.controller.expand();
  expect(cancelSelectedDestinationTurn(harness.tab)).toBe(true);
  expect(native.cancelCalls).toBe(1);
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('idle'));
  expect(native.requests).toHaveLength(1);
  expect(harness.controller.runtime?.queuedCount).toBe(0);
});

it('does not render late events after side disposal', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Discarded background answer' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
  await harness.controller.discard();
  expect(screen.queryByText('Discarded background answer')).toBeNull();
  expect(harness.controller.hasSideChat).toBe(false);
});

it('settles an async subagent from a session notification after the requested turn', async () => {
  const harness = createHarness({ subagentAdapter, taskResultInterpreter });
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  native.emitOutput({
    type: 'tool_started', toolCallId: 'task-1', toolScope: { kind: 'main' }, name: 'Agent',
    input: { description: 'Background research', prompt: 'Find details', run_in_background: true },
  });
  native.emitOutput({
    type: 'tool_completed', toolCallId: 'task-1', toolScope: { kind: 'main' }, content: 'Launched',
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent-1' },
  });
  native.complete();
  await started;
  expect(screen.getByRole('button', { name: /Background research.*Running/i })).toBeDefined();
  native.emitSessionEvent({
    type: 'async_subagent_completed', originatingTurnId: 'task-1', subagentId: 'agent-1',
    providerSessionId: 'side-session', status: 'completed', result: 'Background finding',
  });
  await waitFor(() => expect(screen.getByRole('button', { name: /Background research.*Completed/i })).toBeDefined());
  expect(screen.getByText('Background finding')).toBeDefined();
});

it('leaves the working state and drops queued input when background execution fails', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  harness.controller.collapse();
  await harness.controller.handleCommandSubmission('Queued side prompt', []);
  native.emitSessionEvent({ type: 'session_error', category: 'transport', message: 'Transport closed', recoverable: false });
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('error'));
  expect(harness.controller.runtime?.queuedCount).toBe(0);
  expect(native.requests).toHaveLength(1);
});

it('settles the requested response before background output arriving in the same native batch', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  harness.controller.collapse();
  await harness.controller.handleCommandSubmission('Continue after both answers', []);
  native.emitText('Requested response');
  native.complete('requested-answer');
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Automatic response' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'automatic-answer' });
  await started;
  await waitFor(() => expect(native.requests).toHaveLength(2));
  const answers = native.requests[1].conversationHistory?.filter(message => message.role === 'assistant');
  expect(answers?.slice(-2)).toEqual([
    expect.objectContaining({ content: 'Requested response', assistantMessageId: 'requested-answer' }),
    expect.objectContaining({ content: 'Automatic response', assistantMessageId: 'automatic-answer' }),
  ]);
  native.complete();
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('idle'));
});

it.each(['requested', 'idle', 'background'] as const)('shows task notifications without waiting for %s side work', async (phase) => {
  const harness = phase === 'requested' ? createHarness() : await finishedSide();
  const pending = phase === 'requested' ? (await startSideChat(harness)).started : Promise.resolve(true);
  const native = harness.backend.latest;
  if (phase !== 'idle') {
    // This earlier session event may wait for the requested response to settle.
    native.emitBackgroundEvent({ type: 'background_turn_started' });
  }
  try {
    native.emitSessionEvent({ type: 'task_notification', content: 'Independent task result' });
    expect(await screen.findByRole('button', { name: 'Task notification' })).toBeDefined();
    expect(harness.controller.runtime?.state.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentBlocks: [{ type: 'task_notification', content: 'Independent task result' }] }),
    ]));
  } finally {
    native.complete();
    if (phase !== 'idle') native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
    await pending;
  }
});

it('keeps background output before a later independent notification in the same native batch', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Earlier automatic response' });
  native.emitSessionEvent({ type: 'task_notification', content: 'Later task result' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
  const earlier = await screen.findByText('Earlier automatic response');
  const notification = screen.getByRole('button', { name: 'Task notification' });
  expect(earlier.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps a session notification before requested continuation text and preserves the final checkpoint', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  native.emitText('Before notification.');
  await screen.findByText('Before notification.');
  native.emitSessionEvent({ type: 'task_notification', content: 'Task finished.' });
  const notification = await screen.findByRole('button', { name: 'Task notification' });
  native.emitText('After notification.');
  native.complete('final-checkpoint');
  await started;
  const answer = screen.getByText(/After notification\./);
  expect(notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(harness.controller.runtime?.state.messages.at(-1)).toMatchObject({
    content: 'After notification.', assistantMessageId: 'final-checkpoint',
  });
});

it.each([false, true])('keeps queued requested output before a notification with native turn completed=%s', async completed => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  native.emitText('Earlier requested answer');
  if (completed) native.complete('requested-checkpoint');
  native.emitSessionEvent({ type: 'task_notification', content: 'Later task result' });
  if (!completed) native.complete('requested-checkpoint');
  await started;
  const earlier = screen.getByText('Earlier requested answer');
  const notification = screen.getByRole('button', { name: 'Task notification' });
  expect(earlier.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('preserves all requested text positions across two notifications in one batch', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  native.emitText('First segment.');
  native.emitSessionEvent({ type: 'task_notification', content: 'First task.' });
  native.emitText('Middle segment.');
  native.emitSessionEvent({ type: 'task_notification', content: 'Second task.' });
  native.emitText('Last segment.');
  native.complete('last-checkpoint');
  await started;
  const notifications = screen.getAllByRole('button', { name: 'Task notification' });
  const elements = [screen.getByText(/First segment\./), notifications[0], screen.getByText(/Middle segment\./), notifications[1], screen.getByText(/Last segment\./)];
  for (let index = 1; index < elements.length; index++) {
    expect(elements[index - 1].compareDocumentPosition(elements[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

it('preserves a notification between automatic work and its subsequent answer', async () => {
  const harness = createHarness({ taskResultInterpreter });
  const { started } = await startSideChat(harness);
  const native = harness.backend.latest;
  native.establishChild('side-session');
  native.emitText('Requested answer');
  native.complete();
  await started;
  native.emitSessionEvent({ type: 'task_notification', content: 'First task finished.' });
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  native.emitBackgroundEvent({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'task.output' } });
  native.emitBackgroundEvent({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'First task result' });
  native.emitSessionEvent({ type: 'task_notification', content: 'Second task finished.' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'After notification.' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
  await waitFor(() => expect(harness.controller.runtime?.status).toBe('idle'));
  const notification = screen.getAllByRole('button', { name: 'Task notification' })[1];
  const answer = await screen.findByText(/After notification\./);
  expect(notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});


it('preserves automatic text across multiple notifications in one native batch', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'First automatic segment.' });
  native.emitSessionEvent({ type: 'task_notification', content: 'First task.' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Middle automatic segment.' });
  native.emitSessionEvent({ type: 'task_notification', content: 'Second task.' });
  native.emitBackgroundEvent({ type: 'text_delta', text: 'Last automatic segment.' });
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'automatic-checkpoint' });
  const last = await screen.findByText('Last automatic segment.');
  const notifications = screen.getAllByRole('button', { name: 'Task notification' });
  const ordered = [screen.getByText('First automatic segment.'), notifications[0], screen.getByText('Middle automatic segment.'), notifications[1], last];
  for (let index = 1; index < ordered.length; index++) {
    expect(ordered[index - 1].compareDocumentPosition(ordered[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  await waitFor(() => expect(harness.controller.runtime?.state.messages.at(-1)).toMatchObject({ content: 'Last automatic segment.', assistantMessageId: 'automatic-checkpoint' }));
});

it('keeps completed automatic turns before a later notification while their rendering is queued', async () => {
  const harness = await finishedSide();
  const native = harness.backend.latest;
  for (const [id, text] of [['first', 'First completed response'], ['second', 'Second completed response']]) {
    native.emitBackgroundEvent({ type: 'background_turn_started' }, id);
    native.emitBackgroundEvent({ type: 'text_delta', text }, id);
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' }, id);
  }
  native.emitSessionEvent({ type: 'task_notification', content: 'Later notification.' });
  const second = await screen.findByText('Second completed response');
  const notification = screen.getByRole('button', { name: 'Task notification' });
  expect(screen.getByText('First completed response').compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(second.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
