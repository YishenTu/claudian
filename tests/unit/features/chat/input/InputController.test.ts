import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ToolCallInfo } from '@/core/types';
import type { ChatSteerOutcome } from '@/features/chat/execution/ChatExecutionCoordinator';
import { ChatExecutionPreHandoffError } from '@/features/chat/execution/ChatExecutionCoordinator';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    formatQuestionReply: jest.fn(),
    resolveTitleGenerationSelection: jest.fn().mockReturnValue(null),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    }),
  },
}));

describe('composer wikilinks', () => {
  it('sends exact aliased wikilinks and retains them in displayed messages', async () => {
    const fixture = createFixture();
    const content = 'Compare [[DEMO.md|DEMO]] and [[- Bases/DEMO.md|DEMO]]';
    fixture.input.value = content;

    await fixture.controller.sendMessage();

    expect(fixture.coordinator.execute.mock.calls[0][0]).toEqual(expect.objectContaining({
      canonicalText: content,
    }));
    expect(fixture.state.messages.find(message => message.role === 'user')).toEqual(expect.objectContaining({
      content, displayContent: content,
    }));
  });

  it('restores the wikilink source after a definite failure before provider handoff', async () => {
    const fixture = createFixture();
    fixture.input.value = '[[Notes/A.md]]';
    fixture.coordinator.execute.mockRejectedValue(new ChatExecutionPreHandoffError('ledger unavailable'));
    await fixture.controller.sendMessage();
    expect(fixture.input.value).toBe('[[Notes/A.md]]');
    expect(fixture.state.messages).toEqual([]);
  });

  it('preserves wikilinks when queued messages are merged and returned to the draft', async () => {
    const fixture = createFixture();
    fixture.holdResponse();
    fixture.input.value = '  [[Notes/A.md]]  ';
    await fixture.controller.sendMessage();
    fixture.input.value = '[[Notes/B.md]]';
    await fixture.controller.sendMessage();
    fixture.controller.queue.withdrawToComposer();
    expect(fixture.input.value).toBe('[[Notes/A.md]]\n\n[[Notes/B.md]]');
  });
});

describe('InputController admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    } as any);

  });

  it('preserves input and blocks execution for an unresolved tab provider', async () => {
    const fixture = createFixture({ getTabProviderId: () => null });
    fixture.state.currentConversationId = null;
    fixture.input.value = 'keep this draft';
    await fixture.controller.sendMessage();
    expect(fixture.input.value).toBe('keep this draft');
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.deps.ensureExecutionInitialized).not.toHaveBeenCalled();
    expect(fixture.state.messages).toEqual([]);
    expect(Notice).toHaveBeenCalledWith('Select an available model before sending.');
  });

  it('does not start a turn when its tab session has closed intent admission', async () => {
    const canStartTurn = jest.fn().mockReturnValue(false);
    const fixture = createFixture({ canStartTurn });
    fixture.input.value = 'do not send';

    await fixture.controller.sendMessage();

    expect(canStartTurn).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.input.value).toBe('do not send');
  });

  it('cancels active execution through the coordinator', () => {
    const fixture = createFixture();
    fixture.holdResponse();

    fixture.controller.cancelStreaming();

    expect(fixture.coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.state.cancelRequested).toBe(true);
  });

  it('reports deferred review before a non-replacing built-in command', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    // The first turn settles while a continuation owns queued work.
    jest.spyOn(fixture.controller.queue, 'scheduleContinuation').mockReturnValueOnce(true);

    await fixture.controller.sendMessage({ content: 'first turn' });
    await fixture.controller.sendMessage({ content: '/resume' });

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('discards deferred review when clear replaces the conversation', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    // The first turn settles while a continuation owns queued work.
    jest.spyOn(fixture.controller.queue, 'scheduleContinuation').mockReturnValueOnce(true);

    await fixture.controller.sendMessage({ content: 'first turn' });
    await fixture.controller.sendMessage({ content: '/clear' });

    expect(onReviewableSettlement).not.toHaveBeenCalled();
  });
});

describe('async question answer submission', () => {
  const createQuestion = (): ToolCallInfo => ({
    id: 'ask', name: 'AskUserQuestion', status: 'completed', input: { replyMode: 'user-message', questions: [] },
  });

  beforeEach(() => {
    jest.mocked(ProviderRegistry.formatQuestionReply).mockReturnValue({ content: 'native reply payload', displayContent: '' });
  });

  it('uses the native payload for execution and friendly text for display without consuming the composer draft', async () => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.input.value = 'Keep my draft';
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.coordinator.execute.mock.calls[0][0]).toMatchObject({ canonicalText: 'native reply payload', rawDisplayText: '' });
    expect(fixture.input.value).toBe('Keep my draft');
  });

  it('keeps an unaccepted answer out of the draft when its native session is missing', async () => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.input.value = 'Keep my draft';
    fixture.coordinator.execute.mockResolvedValueOnce({ accepted: false, status: 'missing-session', missingSessionResolution: 'reset' });
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1')).rejects.toThrow('not sent');
    expect(fixture.input.value).toBe('Keep my draft');
    expect(fixture.state.messages).toHaveLength(1);
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it.each(['clear', 'withdrawToComposer'] as const)('accepts a definitely rejected answer into the queue and permits %s', async action => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.holdResponse();
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'not-sent' });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.state.queuedMessage).toMatchObject({ content: '', turnRequest: { text: 'native reply payload', draftContent: 'Answer' } });
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    fixture.controller.queue[action]();
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.input.value).toBe(action === 'withdrawToComposer' ? 'Answer' : '');
  });

  it.each(['/clear', '/new', '/side', '/compact'])('treats question text starting with %s as display text, never as a command', async command => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    jest.mocked(ProviderRegistry.formatQuestionReply).mockReturnValue({ content: 'native reply payload', displayContent: `${command}\nYes` });
    await fixture.controller.answerQuestion(tool, { '0': 'Yes' }, 'conversation-1');
    expect(fixture.coordinator.execute.mock.calls[0][0]).toMatchObject({ canonicalText: 'native reply payload', rawDisplayText: `${command}\nYes` });
    expect(fixture.deps.conversationController.createNew).not.toHaveBeenCalled();
  });

  it('delivers answers separately from ordinary queued messages', async () => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.holdResponse();
    await fixture.controller.sendMessage({ content: 'Also check rendering' });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.coordinator.steer.mock.calls[0][0]).toMatchObject({ canonicalText: 'native reply payload', rawDisplayText: '' });
    expect(fixture.state.queuedMessage?.content).toBe('Also check rendering');
  });

  it('starts the answer in a new turn when the active turn ends before steering accepts it', async () => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    const releaseTurn = fixture.holdResponse();
    fixture.coordinator.steer.mockImplementationOnce(async () => {
      await releaseTurn();
      return { delivery: 'not-sent' };
    });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({ canonicalText: 'native reply payload', rawDisplayText: '' }), expect.any(AbortSignal));
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it.each([
    ['declined', { delivery: 'not-sent' }],
    ['failed before handoff', { delivery: 'not-sent', error: new ChatExecutionPreHandoffError('Authority check failed') }],
  ] as const)('queues a definitely unsent answer without waiting for delivery (%s)', async (_label, outcome) => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.holdResponse();
    fixture.coordinator.steer.mockResolvedValueOnce(outcome);
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.state.queuedMessage?.turnRequest?.text).toBe('native reply payload');
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
  });

  it('settles ambiguous answer handoff without queuing or retrying it', async () => {
    const fixture = createFixture();
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.holdResponse();
    fixture.coordinator.steer.mockResolvedValueOnce({ delivery: 'uncertain', error: new Error('Acknowledgement lost') });
    await fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.state.queuedMessage).toBeNull();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed'));
  });

  it('does not send or queue an answer into a conversation selected during handoff', async () => {
    const handoff = deferred<ChatSteerOutcome>();
    const fixture = createFixture();
    fixture.coordinator.steer.mockReturnValueOnce(handoff.promise);
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    fixture.holdResponse();
    const answering = fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1');
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    fixture.state.currentConversationId = 'conversation-2';
    handoff.resolve({ delivery: 'not-sent' });
    await expect(answering).rejects.toThrow('different conversation');
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it('rejects answers from another conversation or when admission is blocked', async () => {
    const fixture = createFixture({ canStartTurn: () => false });
    const tool = createQuestion();
    fixture.state.addMessage({ id: 'assistant', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [tool] });
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'other-conversation')).rejects.toThrow('different conversation');
    await expect(fixture.controller.answerQuestion(tool, { '0': 'Answer' }, 'conversation-1')).rejects.toThrow('not sent');
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.state.queuedMessage).toBeNull();
  });
});
