import { createFixture, deferred, waitForCall } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import type { ProviderExecutionErrorEvent, ProviderExecutionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ImageAttachment } from '@/core/types';
import { ChatExecutionPreHandoffError, type ChatTurnSubmission } from '@/features/chat/execution/ChatExecutionCoordinator';

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

describe('MainTurnExecution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    } as any);

  });

  it.each(['claude', 'codex', 'grok', 'opencode', 'pi'])('uses the toolbar model and reasoning snapshot as the only submission input for %s', async providerId => {
    const toolbar = { model: 'toolbar-model', reasoning: 'low', permissionMode: 'normal', serviceTier: 'default' };
    const fixture = createFixture({
      getSettings: () => toolbar,
      getTabProviderId: () => providerId,
    });
    await fixture.controller.sendMessage({ content: 'use toolbar settings' });
    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining(toolbar),
    }), expect.any(AbortSignal));
  });

  it('submits first and continued turns through the coordinator', async () => {
    const fixture = createFixture({
      getLinkedContentController: () => ({
        getSnapshot: () => ({ mode: 'locked', path: 'Projects' }),
      }),
    });
    fixture.input.value = 'first';

    await fixture.controller.sendMessage();
    fixture.input.value = 'second';
    await fixture.controller.sendMessage();

    const first = fixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    const second = fixture.coordinator.execute.mock.calls[1][0] as ChatTurnSubmission;
    expect(first).toMatchObject({
      canonicalText: 'first',
      context: { linkedContent: { path: 'Projects' } },
      rawDisplayText: 'first',
      toolPolicy: { kind: 'provider-default' },
    });
    expect(first.conversationHistory).toEqual([]);
    expect(second.context).not.toHaveProperty('linkedContent');
    expect(second.conversationHistory).toHaveLength(2);
    expect(fixture.deps.conversationController.save).toHaveBeenCalledTimes(2);
  });

  it('starts the stream controller response once per run', async () => {
    const fixture = createFixture();

    await fixture.controller.sendMessage({ content: 'first' });
    expect(fixture.deps.streamController.beginResponse).toHaveBeenCalledTimes(1);

    await fixture.controller.sendMessage({ content: 'second' });
    expect(fixture.deps.streamController.beginResponse).toHaveBeenCalledTimes(2);
  });

  it('does not launch execution when close overlaps execution initialization', async () => {
    let closing = false;
    const fixture = createFixture({
      isClosing: () => closing,
      ensureExecutionInitialized: async () => {
        closing = true;
        fixture.session.cancelTurn('shutdown');
        return true;
      },
    });
    await fixture.controller.sendMessage({ content: 'Keep the admitted input' });
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.state.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Keep the admitted input' }),
    ]);
  });

  it('submits provider-default system instructions without changing input', async () => {
    const fixture = createFixture();

    await fixture.controller.sendMessage({ content: 'list my projects' });

    const submission = fixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    expect(submission).toMatchObject({
      canonicalText: 'list my projects',
      configuration: { systemInstructions: { kind: 'provider-default' } },
      rawDisplayText: 'list my projects',
    });
    expect(fixture.state.messages[0]?.content).toBe('list my projects');
  });

  it('numbers canonical submissions without counting interrupt markers', async () => {
    const linkedContentController = {
      getSnapshot: () => ({ mode: 'locked', path: 'note.md' }),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });
    const editorContext = {
      mode: 'selection' as const,
      notePath: 'note.md',
      selectedText: 'selected text',
      startLine: 4,
    };
    const browserContext = {
      selectedText: 'browser text',
      source: 'browser',
      url: 'https://example.com',
    };
    const canvasContext = {
      canvasPath: 'map.canvas',
      nodeIds: ['node-1'],
    };
    const image: ImageAttachment = {
      data: 'aGVsbG8=',
      id: 'image-b',
      mediaType: 'image/png',
      name: 'b.png',
      size: 5,
      source: 'paste',
    };
    const priorMessages = [
      { id: 'user-a', role: 'user' as const, content: 'A', timestamp: 1 },
      { id: 'assistant-a', role: 'assistant' as const, content: 'reply', timestamp: 2 },
      {
        id: 'interrupt-a',
        role: 'user' as const,
        content: 'interrupted',
        isInterrupt: true,
        timestamp: 3,
      },
    ];
    priorMessages.forEach(message => fixture.state.addMessage(message));

    await fixture.controller.sendMessage({
      browserContextOverride: browserContext,
      canvasContextOverride: canvasContext,
      content: 'B',
      editorContextOverride: editorContext,
      images: [image],
    });

    const submission = fixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    expect(submission).toMatchObject({
      canonicalText: 'B',
      context: {
        browserSelection: browserContext,
        canvasSelection: canvasContext,
        editorSelection: editorContext,
      },
      rawDisplayText: 'B',
    });
    expect(submission.conversationHistory?.map(message => message.id)).toEqual([
      'user-a',
      'assistant-a',
      'interrupt-a',
    ]);
    expect(submission.images).toEqual([image]);
    expect(submission.images[0]).toBe(image);
  });

  it('keeps context feature-owned in the normalized submission', async () => {
    const linkedContentController = {
      getSnapshot: () => ({ mode: 'locked', path: 'note.md' }),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });

    await fixture.controller.sendMessage({
      content: 'use context',
      editorContextOverride: {
        mode: 'selection',
        notePath: 'note.md',
        selectedText: 'selection',
        startLine: 1,
      },
    });

    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      canonicalText: 'use context',
      configuration: expect.objectContaining({
        model: 'claude-model',
      }),
      context: expect.objectContaining({
        linkedContent: { path: 'note.md' },
      }),
    }), expect.any(AbortSignal));
  });

  it('restores composer input and rolls back the local turn on definite pre-handoff failure', async () => {
    const image: ImageAttachment = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
      size: 5,
      source: 'paste',
    };
    let attachedImages: ImageAttachment[] = [image];
    const imageContextManager = {
      clearImages: jest.fn(() => {
        attachedImages = [];
      }),
      getAttachedImages: jest.fn(() => attachedImages),
      hasImages: jest.fn(() => attachedImages.length > 0),
      setImages: jest.fn((images: ImageAttachment[]) => {
        attachedImages = images;
      }),
    };
    const fixture = createFixture({
      getImageContextManager: () => imageContextManager,
    });
    fixture.input.value = 'retry this';
    fixture.coordinator.execute.mockRejectedValueOnce(
      new ChatExecutionPreHandoffError(new Error('ledger unavailable')),
    );

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('retry this');
    expect(imageContextManager.setImages).toHaveBeenCalledWith([image]);
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.deps.renderer.removeMessage).toHaveBeenCalledTimes(2);
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
    expect(fixture.deps.streamController.appendError).not.toHaveBeenCalled();
  });

  it('keeps unsent input in the closing transcript when preparation fails before handoff', async () => {
    let closing = false;
    const fixture = createFixture({ isClosing: () => closing });
    fixture.coordinator.execute.mockImplementation(async () => {
      closing = true;
      fixture.session.cancelTurn('shutdown');
      throw new ChatExecutionPreHandoffError('closed during preparation');
    });
    await fixture.controller.sendMessage({ content: 'Keep the admitted input' });
    expect(fixture.state.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Keep the admitted input' }),
    ]);
    expect(fixture.input.value).toBe('');
  });

  it('restores the unsent turn after an asynchronous unaccepted configuration rejection', async () => {
    const image: ImageAttachment = { id: 'retry-image', name: 'retry.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste' };
    let attachedImages = [image];
    const imageContextManager = {
      clearImages: () => { attachedImages = []; },
      getAttachedImages: () => attachedImages,
      hasImages: () => attachedImages.length > 0,
      setImages: (images: ImageAttachment[]) => { attachedImages = images; },
    };
    const fixture = createFixture({ getImageContextManager: () => imageContextManager });
    const rejection: ProviderExecutionEvent = {
      type: 'execution_error',
      category: 'configuration',
      message: 'No enabled model is available.',
      recoverable: false,
      scope: {
        kind: 'requested',
        sessionInstanceId: 'session-1',
        executionId: 'execution-1',
        turnId: 'turn-1',
        sequence: 2,
      },
    };
    fixture.input.value = 'retry after configuration';
    fixture.coordinator.execute.mockRejectedValueOnce(
      new ChatExecutionPreHandoffError(rejection),
    );

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('retry after configuration');
    expect(attachedImages).toEqual([image]);
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.deps.renderer.removeMessage).toHaveBeenCalledTimes(2);
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
    expect(fixture.deps.streamController.appendError).not.toHaveBeenCalled();
  });

  it('does not restore input after an ambiguous post-handoff rejection', async () => {
    const fixture = createFixture();
    fixture.input.value = 'possibly sent';
    fixture.coordinator.execute.mockRejectedValueOnce(new Error('stream failed'));

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.messages).toHaveLength(2);
    expect(fixture.deps.conversationController.save).toHaveBeenCalledTimes(1);
    expect(fixture.deps.streamController.appendError).toHaveBeenCalledWith('stream failed');
  });

  it('puts the completed turn checkpoint and statistics on the final assistant projection after message boundaries', async () => {
    const fixture = createFixture();
    fixture.coordinator.execute.mockImplementationOnce(async (submission: ChatTurnSubmission) => {
      for (const sequence of [1, 2]) {
        await fixture.controller.handleExecutionEvent({
          type: 'assistant_message_started',
          scope: { kind: 'requested', executionId: 'execution-1', turnId: 'turn-1',
            sessionInstanceId: 'session-1', sequence },
        });
      }
      await fixture.controller.handleExecutionEvent({
        type: 'turn_completed',
        scope: { kind: 'requested', executionId: 'execution-1', turnId: 'turn-1',
          sessionInstanceId: 'session-1', sequence: 3 },
        reason: 'completed',
        turnStats: { outputTokens: 125, durationMs: 2500 },
      });
      // The execution binding still identifies the original assistant projection.
      submission.messages!.assistant.assistantMessageId = 'completed-checkpoint';
      return { accepted: true, status: 'completed', nativeCheckpointId: 'completed-checkpoint' };
    });

    await fixture.controller.sendMessage({ content: 'Inspect the code' });

    const assistants = fixture.state.messages.filter(message => message.role === 'assistant');
    expect(assistants.length).toBeGreaterThan(1);
    expect(assistants.at(-1)?.assistantMessageId).toBe('completed-checkpoint');
    expect(assistants[0].assistantMessageId).toBeUndefined();
    expect(assistants.at(-1)?.turnStats).toEqual({ outputTokens: 125, durationMs: 2500 });
  });

  it('timestamps the final response at execution completion instead of streaming start', async () => {
    const startedAt = new Date('2026-09-07T10:00:00Z').getTime();
    const finishedAt = new Date('2026-09-07T10:01:05Z').getTime();
    let now = startedAt;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fixture = createFixture();
      fixture.coordinator.execute.mockImplementationOnce(async () => {
        now = finishedAt;
        return { accepted: true, status: 'completed' };
      });
      await fixture.controller.sendMessage({ content: 'Inspect' });
      expect(fixture.state.messages[0].timestamp).toBe(startedAt);
      expect(fixture.state.messages.at(-1)?.timestamp).toBe(startedAt);
      expect(fixture.state.messages.at(-1)?.completedAt).toBe(finishedAt);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([false, true])('stores response duration without a completion flavor on success (compaction: %s)', async compaction => {
    let currentTime = 1000;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => currentTime);
    try {
      const fixture = createFixture();
      fixture.coordinator.execute.mockImplementationOnce(async () => {
        fixture.state.messages[1].contentBlocks = compaction ? [{ type: 'context_compacted' }] : [];
        currentTime += 1500;
        return { accepted: true, status: 'completed' };
      });

      await fixture.controller.sendMessage({ content: 'test request' });

      const assistantMessage = fixture.state.messages[1];
      expect(assistantMessage.durationSeconds).toBe(1);
      expect(assistantMessage.durationFlavorWord).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('suppresses response duration on normalized execution errors when elapsed time exceeds one second', async () => {
    let currentTime = 1000;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => currentTime);
    try {
      const fixture = createFixture();
      const errorEvent: ProviderExecutionErrorEvent = {
        category: 'provider',
        message: 'Model overloaded',
        recoverable: false,
        scope: {
          executionId: 'execution-1',
          kind: 'requested',
          sequence: 0,
          sessionInstanceId: 'session-instance-1',
          turnId: 'turn-1',
        },
        type: 'execution_error',
      };
      fixture.coordinator.execute.mockImplementationOnce(async () => {
        currentTime += 1500;
        return {
          accepted: true,
          error: errorEvent,
          status: 'error',
        };
      });

      await fixture.controller.sendMessage({ content: 'test request' });

      expect(fixture.deps.streamController.appendError).toHaveBeenCalledWith('Model overloaded');
      const assistantMessage = fixture.state.messages[1];
      expect(assistantMessage.durationSeconds).toBeUndefined();
      expect(assistantMessage.durationFlavorWord).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('suppresses response duration on catch-path rejections when elapsed time exceeds one second', async () => {
    let currentTime = 1000;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => currentTime);
    try {
      const fixture = createFixture();
      fixture.coordinator.execute.mockImplementationOnce(async () => {
        currentTime += 1500;
        throw new Error('stream failed');
      });

      await fixture.controller.sendMessage({ content: 'test request' });

      expect(fixture.deps.streamController.appendError).toHaveBeenCalledWith('stream failed');
      const assistantMessage = fixture.state.messages[1];
      expect(assistantMessage.durationSeconds).toBeUndefined();
      expect(assistantMessage.durationFlavorWord).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('routes normalized requested output to StreamController', async () => {
    const fixture = createFixture();
    fixture.coordinator.execute.mockImplementationOnce(async () => {
      await fixture.controller.handleExecutionEvent({
        type: 'text_delta',
        text: 'world',
      } as ProviderExecutionEvent);
      return { accepted: true, status: 'completed' };
    });

    await fixture.controller.sendMessage({ content: 'hello' });

    expect(fixture.deps.streamController.handleStreamChunk).toHaveBeenCalledWith(
      { content: 'world', type: 'text' },
      expect.objectContaining({ role: 'assistant' }),
    );
  });

  it('restores pending input when the coordinator reports a missing session', async () => {
    const fixture = createFixture();
    fixture.input.value = 'retry me';
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: false,
      missingSessionResolution: 'reset',
      status: 'missing-session',
    });

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('retry me');
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
  });

  it('keeps an accepted missing-session turn non-retryable while resetting recovery state', async () => {
    const fixture = createFixture();
    fixture.input.value = 'already handed off';
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: true,
      missingSessionResolution: 'reset',
      status: 'missing-session',
    });

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.messages).toHaveLength(2);
    expect(fixture.state.isStreaming).toBe(false);
    expect(fixture.deps.renderer.removeMessage).not.toHaveBeenCalled();
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      'The provider session no longer exists. Claudian preserved the recoverable history; send again to rebuild the session.',
    );
  });

  it('does not restore accepted input after missing-session deletion recovery', async () => {
    const fixture = createFixture();
    fixture.input.value = 'accepted before deletion';
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: true,
      missingSessionResolution: 'deleted',
      status: 'missing-session',
    });

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('');
    expect(fixture.deps.renderer.removeMessage).not.toHaveBeenCalled();
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      'The provider session no longer exists. Its Claudian record was removed; send again to start a new session.',
    );
  });

  it('keeps pending input intact when execution preparation fails', async () => {
    const fixture = createFixture({
      ensureExecutionInitialized: jest.fn().mockResolvedValue(false),
    });
    fixture.input.value = 'not sent';

    await fixture.controller.sendMessage();

    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    expect(fixture.input.value).toBe('not sent');
    expect(fixture.state.messages).toEqual([]);
  });

  it('reports a terminal completed turn as reviewable', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });

    await fixture.controller.sendMessage({ content: 'finish this' });

    expect(fixture.deps.captureReviewableSettlement).toHaveBeenCalledWith('completed');
    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('reports a terminal accepted error as reviewable', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: true,
      error: new Error('provider failed'),
      status: 'error',
    });

    await fixture.controller.sendMessage({ content: 'finish this' });

    expect(fixture.deps.captureReviewableSettlement).toHaveBeenCalledWith('error');
    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'invalidated', 'missing-session'] as const)(
    'does not report a %s turn as reviewable',
    async (status) => {
      const onReviewableSettlement = jest.fn();
      const fixture = createFixture({ onReviewableSettlement });
      fixture.coordinator.execute.mockResolvedValueOnce({
        accepted: status !== 'missing-session',
        missingSessionResolution: status === 'missing-session' ? 'reset' : undefined,
        status,
      });

      await fixture.controller.sendMessage({ content: 'finish this' });

      expect(onReviewableSettlement).not.toHaveBeenCalled();
    },
  );

  it('does not report a definite pre-handoff failure as reviewable', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    fixture.coordinator.execute.mockRejectedValueOnce(
      new ChatExecutionPreHandoffError('not handed off'),
    );

    await fixture.controller.sendMessage({ content: 'finish this' });

    expect(onReviewableSettlement).not.toHaveBeenCalled();
  });

  it('reports completed work when terminal persistence fails', async () => {
    const onReviewableSettlement = jest.fn();
    const fixture = createFixture({ onReviewableSettlement });
    jest.mocked(fixture.deps.conversationController.save).mockRejectedValueOnce(
      new Error('save failed'),
    );

    await expect(fixture.controller.sendMessage({ content: 'finish this' }))
      .rejects.toThrow('save failed');

    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('acknowledges stale review when a new provider turn starts', async () => {
    const fixture = createFixture();
    fixture.state.markReviewRequired();

    await fixture.controller.sendMessage({ content: 'continue working' });

    expect(fixture.state.attention).toBeNull();
  });
});

it('keeps a completed answer when cancellation loses to native completion', async () => {
  const fixture = createFixture();
  fixture.coordinator.execute.mockImplementationOnce(async () => {
    fixture.controller.cancelStreaming();
    await fixture.controller.handleExecutionEvent({
      type: 'turn_completed', reason: 'completed',
      scope: { kind: 'requested', executionId: 'e', turnId: 't', sessionInstanceId: 's', sequence: 1 },
    });
    return { accepted: true, status: 'completed' };
  });
  await fixture.controller.sendMessage({ content: 'Work' });
  expect(fixture.state.messages.at(-1)?.isInterrupt).not.toBe(true);
});

const requestedTurnCompleted: ProviderExecutionEvent = {
  type: 'turn_completed', reason: 'completed',
  scope: { kind: 'requested', executionId: 'e', turnId: 't', sessionInstanceId: 's', sequence: 1 },
};

it.each(['before', 'after'] as const)(
  'keeps one completion outcome when cancellation arrives %s native completion', async order => {
    const fixture = createFixture();
    fixture.coordinator.execute.mockImplementationOnce(async () => {
      if (order === 'before') fixture.controller.cancelStreaming();
      await fixture.controller.handleExecutionEvent(requestedTurnCompleted);
      if (order === 'after') fixture.controller.cancelStreaming();
      return { accepted: true, status: 'completed' };
    });
    await fixture.controller.sendMessage({ content: 'Work' });
    expect(fixture.state.messages.at(-1)?.isInterrupt).not.toBe(true);
  },
);

it('cancels a turn while it commits a branch draft before provider handoff', async () => {
  const fixture = createFixture();
  const commit = deferred<{ status: 'committed'; messages: [] }>();
  const conversation = fixture.deps.conversationController;
  Object.defineProperty(conversation, 'hasBranchDraft', { configurable: true, get: () => true });
  Object.defineProperty(conversation, 'commitBranchDraft', { configurable: true, value: jest.fn(() => commit.promise) });
  fixture.input.value = 'branch prompt';
  const sending = fixture.controller.sendMessage();
  await waitForCall(conversation.commitBranchDraft as jest.Mock);
  expect(fixture.state.isStreaming).toBe(true);

  fixture.controller.cancelStreaming();
  commit.resolve({ status: 'committed', messages: [] });
  await sending;

  expect(fixture.coordinator.execute).not.toHaveBeenCalled();
  expect(fixture.input.value).toBe('branch prompt');
  expect(fixture.state.isStreaming).toBe(false);
});

describe('branch draft submission', () => {
  it.each([false, true])('waits for native branch navigation before sending and preserves cancelled drafts (%s)', async cancelled => {
    const fixture = createFixture();
    const first = { id: 'first', role: 'user' as const, content: 'First', timestamp: Date.now(), userMessageId: 'native-first' };
    const prompt = { id: 'second', role: 'user' as const, content: 'Original', timestamp: Date.now(), userMessageId: 'native-second' };
    fixture.state.messages = [first, prompt];
    const navigation = deferred<{ status: string; messages?: typeof first[] }>();
    const navigateConversationBranch = jest.fn().mockReturnValue(navigation.promise);
    Object.assign(fixture.coordinator, { navigateConversationBranch });
    Object.assign(fixture.deps.renderer, { renderMessages: jest.fn(), refreshBranchButtonState: jest.fn() });
    // The harness conversation owner is real; turn admission is wired to it at construction.
    const conversation = fixture.deps.conversationController;
    await conversation.navigateBranch('second');
    fixture.input.value = 'Edited';
    const sending = fixture.controller.sendMessage();
    await waitForCall(navigateConversationBranch);
    expect(fixture.coordinator.execute).not.toHaveBeenCalled();
    conversation.cancelBranchDraft(); // Focus changes during admitted submission must not undo it.
    expect(fixture.input.value).toBe('');
    navigation.resolve(cancelled ? { status: 'cancelled' } : { status: 'committed', messages: [first] });
    await sending;
    expect(fixture.coordinator.execute.mock.calls.map(([request]) => request.canonicalText)).toEqual(cancelled ? [] : ['Edited']);
    expect(fixture.input.value).toBe(cancelled ? 'Edited' : '');
    expect(fixture.state.messages.some(message => message.id === 'second')).toBe(cancelled);
    conversation.cancelBranchDraft();
    expect(fixture.state.messages.some(message => message.content === 'Edited')).toBe(!cancelled);
  });
});
