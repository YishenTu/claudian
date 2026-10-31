import '@/providers';

// @vitest-environment jsdom
import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ToolCallInfo } from '@/core/types';

const nativeCapabilities = ProviderRegistry.getCapabilities('claude');
beforeEach(() => {
  vi.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({ ...nativeCapabilities, supportsTurnSteer: true });
  vi.spyOn(ProviderRegistry, 'formatQuestionReply');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });


describe('mailbox input', () => {
  const message = { from: 'Sender', sessionId: 'sender', text: 'Please inspect this' };

  it('keeps the composer and unread state, and submits a sender envelope without captured context', async () => {
    const fixture = (await createFixture());
    fixture.input.value = 'My unsent draft';
    fixture.state.markReviewRequired();
    const attention = fixture.state.attention;
    const onUnsent = vi.fn();
    await fixture.controller.sendSessionMessage(message, { onUnsent, assertBeforeHandoff: () => undefined });
    const submission = fixture.native.requests[0];
    expect(decodeSessionMessage(submission.input.filter(part => part.type === 'text').map(part => part.text).join(''))).toEqual(message);
    expect(submission.context).toEqual({});
    expect(submission.input.filter(part => part.type === 'image')).toEqual([]);
    expect(fixture.state.messages[0]).toMatchObject({ displayContent: message.text, sessionMessage: { from: 'Sender', sessionId: 'sender' } });
    expect(fixture.input.value).toBe('My unsent draft');
    expect(fixture.state.attention).toEqual(attention);
    expect(onUnsent).not.toHaveBeenCalled();
  });

  it('reports terminal preparation failure without putting the envelope in the composer', async () => {
    const fixture = (await createFixture({ ensureExecutionInitialized: async () => false }));
    fixture.input.value = 'My draft';
    const onUnsent = vi.fn();
    await fixture.controller.sendSessionMessage(message, { onUnsent, assertBeforeHandoff: () => undefined });
    expect(onUnsent).toHaveBeenCalledWith('failed');
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.input.value).toBe('My draft');
  });

  it('reports Stop during preparation with the cancellation reason and never submits', async () => {
    const ready = deferred<boolean>();
    const fixture = (await createFixture({ ensureExecutionInitialized: () => ready.promise }));
    const onUnsent = vi.fn();
    const sending = fixture.controller.sendSessionMessage(message, { onUnsent, assertBeforeHandoff: () => undefined });
    await Promise.resolve();
    fixture.controller.cancelStreaming();
    ready.resolve(true);
    await sending;
    expect(onUnsent).toHaveBeenCalledWith('user');
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.input.value).toBe('');
  });

  it.each([true, false])('discards only an unaccepted error (accepted: %s)', async accepted => {
    const fixture = (await createFixture());
    fixture.native.respond.mockImplementationOnce(run => {
      run.emit({ type: 'turn_started', accepted });
      run.emit({ type: 'execution_error', category: 'provider', message: 'Provider failed', recoverable: false });
    });
    const onUnsent = vi.fn();
    await fixture.controller.sendSessionMessage(message, { onUnsent, assertBeforeHandoff: () => undefined });
    expect(onUnsent.mock.calls).toEqual(accepted ? [] : [['failed']]);
    expect(fixture.state.messages).toHaveLength(accepted ? 2 : 0);
    expect(fixture.native.requests).toHaveLength(1);
  });
});

describe('composer wikilinks', () => {
  it('sends exact aliased wikilinks and retains them in displayed messages', async () => {
    const fixture = (await createFixture());
    const content = 'Compare [[DEMO.md|DEMO]] and [[- Bases/DEMO.md|DEMO]]';
    fixture.input.value = content;

    await fixture.controller.sendMessage();

    expect(fixture.native.requests[0]).toEqual(expect.objectContaining({
      input: [{ type: 'text', text: content }],
    }));
    expect(fixture.state.messages.find(message => message.role === 'user')).toEqual(expect.objectContaining({
      content, displayContent: content,
    }));
  });

  it('restores the wikilink source after a definite failure before provider handoff', async () => {
    const fixture = (await createFixture());
    fixture.input.value = '[[Notes/A.md]]';
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('ledger unavailable'));
    await fixture.controller.sendMessage();
    expect(fixture.input.value).toBe('[[Notes/A.md]]');
    expect(fixture.state.messages).toEqual([]);
  });

  it('preserves wikilinks when queued messages are merged and returned to the draft', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();
    fixture.input.value = '  [[Notes/A.md]]  ';
    await fixture.controller.sendMessage();
    fixture.input.value = '[[Notes/B.md]]';
    await fixture.controller.sendMessage();
    fixture.controller.queue.withdrawToComposer();
    expect(fixture.input.value).toBe('[[Notes/A.md]]\n\n[[Notes/B.md]]');
  });

  it('preserves a non-empty unsent suffix when a queued message returns to the composer', async () => {
    const fixture = (await createFixture());
    const release = await fixture.holdResponse();
    try {
      fixture.input.value = 'Queued request';
      await fixture.controller.sendMessage();
      fixture.input.value = '    keepIndented()\n';
      fixture.controller.queue.withdrawToComposer();
      expect(fixture.input.value).toBe('Queued request\n\n    keepIndented()\n');
      expect(fixture.state.queuedMessage).toBeNull();
    } finally {
      await release();
    }
  });
});

describe('InputController admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      ...nativeCapabilities,
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    });

  });

  it('preserves input and blocks execution for an unresolved tab provider', async () => {
    const fixture = (await createFixture({ getTabProviderId: () => null }));
    fixture.state.currentConversationId = null;
    fixture.input.value = 'keep this draft';
    await fixture.controller.sendMessage();
    expect(fixture.input.value).toBe('keep this draft');
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.deps.ensureExecutionInitialized).not.toHaveBeenCalled();
    expect(fixture.state.messages).toEqual([]);
    expect(Notice).toHaveBeenCalledWith('Select an available model before sending.');
  });

  it('does not start a turn when its tab session has closed intent admission', async () => {
    const canStartTurn = vi.fn().mockReturnValue(false);
    const fixture = (await createFixture({ canStartTurn }));
    fixture.input.value = 'do not send';

    await fixture.controller.sendMessage();

    expect(canStartTurn).toHaveBeenCalledTimes(1);
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.input.value).toBe('do not send');
  });

  it('cancels active execution through the coordinator', async () => {
    const fixture = (await createFixture());
    await fixture.holdResponse();

    fixture.controller.cancelStreaming();

    expect(fixture.native.runs[0].cancelCalls).toBe(1);
    expect(fixture.state.cancelRequested).toBe(true);
  });

  it.each([
    { command: '/resume', notifications: 1 },
    { command: '/clear', notifications: 0 },
  ])('settles deferred review before built-in command $command', async ({ command, notifications }) => {
    vi.useFakeTimers();
    const onReviewableSettlement = vi.fn();
    const fixture = await createFixture({ onReviewableSettlement });
    const response = fixture.holdNextResponse();
    const sending = fixture.controller.sendMessage({ content: 'first turn' });
    const run = await response.started;
    await fixture.controller.sendMessage({ content: 'queued follow-up' });
    run.complete();
    await sending;
    expect(fixture.controller.queue.message?.content).toBe('queued follow-up');
    expect(onReviewableSettlement).not.toHaveBeenCalled();

    await fixture.controller.sendMessage({ content: command });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(notifications);
    expect(fixture.native.requests).toHaveLength(1);
  });

});

describe('async question answer submission', () => {
  const createQuestion = (): ToolCallInfo => ({
    id: 'ask', name: 'AskUserQuestion', status: 'completed', input: { replyMode: 'user-message', questions: [] },
  });

  beforeEach(() => {
    vi.mocked(ProviderRegistry.formatQuestionReply).mockReturnValue({ content: 'native reply payload', displayContent: '' });
  });

  it('uses the native payload for execution and friendly text for display without consuming the composer draft', async () => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.input.value = 'Keep my draft';
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.native.requests[0].input).toEqual([{ type: 'text', text: 'native reply payload' }]);
    expect(fixture.state.messages.find(message => message.role === 'user')?.displayContent).toBe('');
    expect(fixture.input.value).toBe('Keep my draft');
  });

  it('keeps an unaccepted answer out of the draft when its native session is missing', async () => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.input.value = 'Keep my draft';
    fixture.native.respond.mockImplementationOnce(run => run.emit({
      type: 'execution_error', category: 'provider-session-missing', message: 'Session missing', recoverable: true,
    }));
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1')).rejects.toThrow('not sent');
    expect(fixture.input.value).toBe('Keep my draft');
    expect(fixture.state.messages).toHaveLength(1);
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it.each(['clear', 'withdrawToComposer'] as const)('accepts a definitely rejected answer into the queue and permits %s', async action => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await fixture.holdResponse();
    fixture.nativeSteer.mockResolvedValueOnce(false);
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.state.queuedMessage).toMatchObject({ content: '', turnRequest: { text: 'native reply payload', draftContent: 'Answer' } });
    expect(fixture.native.requests).toHaveLength(0);
    fixture.controller.queue[action]();
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.native.steerRequests).toHaveLength(1);
    expect(fixture.input.value).toBe(action === 'withdrawToComposer' ? 'Answer' : '');
  });

  it.each(['/clear', '/new', '/side', '/compact'])('treats question text starting with %s as display text, never as a command', async command => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    vi.mocked(ProviderRegistry.formatQuestionReply).mockReturnValue({ content: 'native reply payload', displayContent: `${command}\nYes` });
    await fixture.controller.answerQuestion(tool, { '0': 'Yes' }, 'conversation-1');
    expect(fixture.native.requests[0].input).toEqual([{ type: 'text', text: 'native reply payload' }]);
    expect(fixture.state.messages.find(message => message.role === 'user')?.displayContent).toBe(`${command}\nYes`);
    expect(fixture.startNewConversation).not.toHaveBeenCalled();
  });

  it('delivers answers separately from ordinary queued messages', async () => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await fixture.holdResponse();
    await fixture.controller.sendMessage({ content: 'Also check rendering' });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.native.steerRequests[0].input).toEqual([{ type: 'text', text: 'native reply payload' }]);
    expect(fixture.coordinator.getSteerSubmission(fixture.native.steerRequests[0].inputId!)?.rawDisplayText).toBe('');
    expect(fixture.state.queuedMessage?.content).toBe('Also check rendering');
  });

  it('starts the answer in a new turn when the active turn ends before steering accepts it', async () => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    const releaseTurn = await fixture.holdResponse();
    fixture.nativeSteer.mockImplementationOnce(async () => {
      await releaseTurn();
      return false;
    });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.native.requests).toMatchObject([{ input: [{ type: 'text', text: 'native reply payload' }] }]);
    expect(fixture.state.messages.find(message => message.role === 'user')?.displayContent).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it.each(['declined', 'failed before handoff'] as const)('queues a definitely unsent answer without waiting for delivery (%s)', async outcome => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await fixture.holdResponse();
    if (outcome === 'declined') fixture.nativeSteer.mockResolvedValueOnce(false);
    else fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('Authority check failed'));
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.state.queuedMessage?.turnRequest?.text).toBe('native reply payload');
    expect(fixture.native.requests).toHaveLength(0);
  });

  it('settles ambiguous answer handoff without queuing or retrying it', async () => {
    const fixture = (await createFixture());
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await fixture.holdResponse();
    fixture.nativeSteer.mockRejectedValueOnce(new Error('Acknowledgement lost'));
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.native.steerRequests).toHaveLength(1);
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.state.queuedMessage).toBeNull();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed'));
  });

  it('does not send or queue an answer into a conversation selected during handoff', async () => {
    const handoff = deferred<boolean>();
    const fixture = (await createFixture());
    fixture.nativeSteer.mockReturnValueOnce(handoff.promise);
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await fixture.holdResponse();
    const answering = fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    await fixture.native.waitForSteer();
    expect(fixture.native.steerRequests).toHaveLength(1);
    fixture.state.currentConversationId = 'conversation-2';
    handoff.resolve(false);
    await expect(answering).rejects.toThrow('different conversation');
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it('rejects answers from another conversation or when admission is blocked', async () => {
    const fixture = (await createFixture({ canStartTurn: () => false }));
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'other-conversation')).rejects.toThrow('different conversation');
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1')).rejects.toThrow('not sent');
    expect(fixture.native.requests).toHaveLength(0);
    expect(fixture.state.queuedMessage).toBeNull();
  });
});
