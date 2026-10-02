/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';
import { formatCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';

const taskResultInterpreter = ProviderRegistry.getTaskResultInterpreter('claude');

afterEach(releaseSideChatHarnesses);

it.each(['approval', 'question'] as const)('dismisses only the named overlapping %s', async kind => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => {
    const common = { interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId };
    return kind === 'approval'
      ? port.requestApproval({ ...common, kind, toolName: interactionId, description: `${interactionId} details`, input: {} }, new AbortController().signal)
      : port.askUserQuestion({ ...common, kind, input: { questions: [{ question: `${interactionId} question`, options: [{ label: 'Yes', description: '' }] }] } }, new AbortController().signal);
  };
  const first = request('first').catch(() => null);
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy());
  port.dismissInteraction('first', 'native-rejected');
  expect(screen.queryByText(kind === 'approval' ? 'first details' : 'first question')).toBeNull();
  expect(screen.getByText(kind === 'approval' ? 'second details' : 'second question')).toBeTruthy();
  port.dismissInteraction('second', 'native-rejected');
  await Promise.all([first, second]);
  expect(screen.queryByText(kind === 'approval' ? 'second details' : 'second question')).toBeNull();
  native.complete();
  await started;
});

it('completing one approval leaves the other reachable for cancellation', async () => {
  const harness = createHarness();
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  const port = native.config.interactionPort;
  const request = (interactionId: string) => port.requestApproval({
    interactionId, sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
    kind: 'approval', toolName: interactionId, description: `${interactionId} details`, input: {},
  }, new AbortController().signal);
  const first = request('first');
  const second = request('second').catch(() => null);
  await waitFor(() => expect(screen.getAllByText('Allow once', { exact: true })).toHaveLength(2));
  const prompt = screen.getByRole('region', { name: 'first approval details' }).closest<HTMLElement>('.claudian-ask-question-inline')!;
  expect(await axe(prompt)).toHaveNoViolations();
  fireEvent.click(screen.getAllByText('Allow once', { exact: true })[0]);
  await expect(first).resolves.toMatchObject({ decision: 'allow', interactionId: 'first' });
  port.dismissInteraction('second', 'cancelled');
  expect(screen.queryByRole('region', { name: 'second approval details' })).toBeNull();
  await second;
  native.complete();
  await started;
});


async function queueQuestionReply() {
  const harness = createHarness({ formatQuestionReply: formatCodexQuestionReply, taskResultInterpreter });
  const { started } = await startSideChat(harness);
  harness.controller.expand();
  const native = harness.backend.latest;
  native.emitOutput({ type: 'tool_started', toolCallId: 'ask', toolScope: { kind: 'main' }, name: 'AskUserQuestion', input: {
    replyMode: 'user-message', questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
  } });
  native.emitOutput({ type: 'tool_completed', toolCallId: 'ask', toolScope: { kind: 'main' }, content: 'Question sent. Awaiting your reply.' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'History' })).toBeTruthy());
  const question = screen.getByRole('region', { name: 'Question' });
  expect(question.closest('.claudian-side-chat-prompts')).not.toBeNull();
  expect(question.closest('.claudian-tool-call')).toBeNull();
  expect(document.querySelector('.claudian-input-composer')?.classList.contains('claudian-side-chat-prompt')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sending...' })).toBeTruthy());
  expect(native.requests).toHaveLength(1);
  return { harness, native, started };
}

it('restores answer controls when a queued reply is cancelled before delivery', async () => {
  const { harness, native, started } = await queueQuestionReply();
  harness.controller.cancelSide();
  await started;
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not sent'));
  expect(screen.getByRole('button', { name: 'Submit answers' }).hasAttribute('disabled')).toBe(false);
  expect(native.requests).toHaveLength(1);
});

it('resolves a queued answer on provider acceptance and keeps it resolved after a response error', async () => {
  const { harness, native, started } = await queueQuestionReply();
  harness.controller.collapse();
  expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false);
  harness.controller.expand();
  expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(true);
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(native.requests[1].input).toEqual([{ type: 'text', text: expect.stringContaining('<send_user_message_question_reply>') }]);
  const text = (native.requests[1].input[0] as { text: string }).text;
  expect(JSON.parse(text.split('\n')[1])).toEqual([{ questionItemId: '["request_user_input_async","ask",0]', question: 'Which check?', answer: 'History' }]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Sending...' })).toBeNull());
  await waitFor(() => expect(harness.composerEl.classList.contains('claudian-side-chat-prompt')).toBe(false));
  native.fail('Response failed after acceptance');
  await started;
  expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull();
  expect(native.requests).toHaveLength(2);
  expect(document.querySelectorAll('.claudian-side-chat-messages .claudian-message-user')).toHaveLength(1);
});


it('keeps a pending main question out of the side destination and restores its answers on return', async () => {
  const harness = createHarness({ onDestinationChanged: () => main.setPromptActive(harness.controller.destination === 'main') });
  const state = new ChatState();
  const main = new InputController({
    state, getInputContainerEl: () => harness.inputContainerEl,
    streamController: { hideThinkingIndicator: jest.fn(), resumeThinkingIndicator: jest.fn() },
    renderer: { updateQuestionTool: jest.fn() },
  } as unknown as InputControllerDeps);
  try {
    const { started } = await startSideChat(harness);
    harness.backend.latest.complete();
    await started;
    harness.controller.collapse();
    main.updateAsyncQuestion({ id: 'main-question', name: 'AskUserQuestion', status: 'completed', input: {
      replyMode: 'user-message', questions: [{ question: 'Main question?', options: [{ label: 'Main answer' }] }],
    } });
    fireEvent.click(screen.getByRole('button', { name: 'Main answer' }));
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(true);
    harness.controller.expand();
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(false);
    expect(screen.queryByRole('region', { name: 'Question' })).toBeNull();
    expect(state.requiresAction).toBe(true);
    harness.controller.collapse();
    expect(harness.inputContainerEl.classList.contains('claudian-hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDefined();
    expect(screen.getByText('Main answer')).toBeDefined();
  } finally {
    main.dismissPendingApproval();
  }
});
