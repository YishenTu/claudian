/** @jest-environment jsdom */
import '@/providers';

import { screen, waitFor } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { cancelSelectedDestinationTurn } from '@/features/chat/tabs/TabInputEvents';

import { createHarness, releaseSideChatHarnesses, startSideChat } from './SideChatDomHarness';

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
