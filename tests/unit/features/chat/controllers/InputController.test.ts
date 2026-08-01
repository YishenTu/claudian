import { createMockEl } from '@test/helpers/MockElement';
import { Notice } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ImageAttachment } from '@/core/types';
import {
  InputController,
  type InputControllerDeps,
} from '@/features/chat/controllers/InputController';
import {
  ChatExecutionPreHandoffError,
  type ChatTurnSubmission,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsTurnSteer: true,
    }),
  },
}));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    getProviderSettingsSnapshot: jest.fn().mockReturnValue({
      effortLevel: 'high',
      model: 'claude-model',
      permissionMode: 'normal',
      serviceTier: 'standard',
    }),
  },
}));

function createInput(): HTMLTextAreaElement {
  return {
    dispatchEvent: jest.fn().mockReturnValue(true),
    focus: jest.fn(),
    value: '',
  } as unknown as HTMLTextAreaElement;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length === 0; attempt++) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

function requestedUserMessageStarted(
  content: string,
  sequence: number,
  nativeUserMessageId?: string,
): ProviderExecutionEvent {
  return {
    content,
    ...(nativeUserMessageId ? { nativeUserMessageId } : {}),
    scope: {
      executionId: 'execution-1',
      kind: 'requested',
      sequence,
      sessionInstanceId: 'session-1',
      turnId: 'turn-1',
    },
    type: 'user_message_started',
  };
}

function createFixture(overrides: Record<string, unknown> = {}) {
  const state = new ChatState();
  state.currentConversationId = 'conversation-1';
  const input = createInput();
  const queueIndicator = createMockEl();
  state.queueIndicatorEl = queueIndicator as any;
  let id = 0;
  const coordinator = {
    acceptSteerFromProviderEvent: jest.fn().mockResolvedValue(true),
    cancel: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({
      accepted: true,
      planCompleted: false,
      status: 'completed',
    }),
    releaseSteerCorrelation: jest.fn(),
    state: 'idle',
    steer: jest.fn().mockResolvedValue(true),
  };
  const plugin = {
    createConversation: jest.fn(),
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSync: jest.fn().mockReturnValue({
      id: 'conversation-1',
      providerId: 'claude',
    }),
    renameConversation: jest.fn().mockResolvedValue(undefined),
    settings: {
      enableAutoTitleGeneration: false,
      permissionMode: 'normal',
    },
    updateConversation: jest.fn().mockResolvedValue(undefined),
  };
  const deps = {
    plugin,
    state,
    renderer: {
      addMessage: jest.fn().mockImplementation(() => {
        const el = createMockEl();
        el.querySelector = jest.fn().mockReturnValue(createMockEl());
        return el;
      }),
      appendInterruptIndicator: jest.fn(),
      refreshActionButtons: jest.fn(),
      removeMessage: jest.fn(),
      updateLiveUserMessage: jest.fn(),
    },
    streamController: {
      appendText: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      showThinkingIndicator: jest.fn(),
    },
    selectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    browserSelectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    canvasSelectionController: {
      getContext: jest.fn().mockReturnValue(null),
    },
    conversationController: {
      clearTerminalSubagentsFromMessages: jest.fn(),
      generateFallbackTitle: jest.fn().mockReturnValue('Fallback title'),
      save: jest.fn().mockResolvedValue(undefined),
      updateHistoryDropdown: jest.fn(),
    },
    getInputEl: () => input,
    getInputContainerEl: () => createMockEl() as any,
    getWelcomeEl: () => null,
    getMessagesEl: () => createMockEl() as any,
    getFileContextManager: () => ({
      getCurrentNotePath: jest.fn().mockReturnValue(null),
      markCurrentNoteSent: jest.fn(),
      shouldSendCurrentNote: jest.fn().mockReturnValue(false),
      startSession: jest.fn(),
      transformContextMentions: jest.fn((text: string) => text),
    }) as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
      getAttachedImages: jest.fn().mockReturnValue([]),
      hasImages: jest.fn().mockReturnValue(false),
      setImages: jest.fn(),
    }) as any,
    getMcpServerSelector: () => null,
    getExternalContextSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    generateId: () => `id-${++id}`,
    resetInputHeight: jest.fn(),
    getAuxiliaryModel: () => 'claude-model',
    getExecutionCoordinator: () => coordinator,
    getSubagentManager: () => ({
      resetSpawnedCount: jest.fn(),
      resetStreamingState: jest.fn(),
    }) as any,
    getTabProviderId: () => 'claude',
    ensureExecutionInitialized: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as InputControllerDeps;
  return {
    controller: new InputController(deps),
    coordinator,
    deps,
    input,
    plugin,
    state,
  };
}

describe('InputController coordinator execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsTurnSteer: true,
    } as any);
    jest.mocked(ProviderSettingsCoordinator.getProviderSettingsSnapshot).mockReturnValue({
      effortLevel: 'high',
      model: 'claude-model',
      permissionMode: 'normal',
      serviceTier: 'standard',
    });
  });

  it('submits first and continued turns through the coordinator', async () => {
    const fixture = createFixture();
    fixture.input.value = 'first';

    await fixture.controller.sendMessage();
    fixture.input.value = 'second';
    await fixture.controller.sendMessage();

    const first = fixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    const second = fixture.coordinator.execute.mock.calls[1][0] as ChatTurnSubmission;
    expect(first).toMatchObject({
      canonicalText: 'first',
      rawDisplayText: 'first',
      userTurnOrdinal: 1,
      toolPolicy: { kind: 'provider-default' },
    });
    expect(first.conversationHistory).toEqual([]);
    expect(second.userTurnOrdinal).toBe(2);
    expect(second.conversationHistory).toHaveLength(2);
    expect(fixture.deps.conversationController.save).toHaveBeenCalledTimes(2);
  });

  it('numbers canonical submissions without counting interrupt markers', async () => {
    const fixture = createFixture({
      getFileContextManager: () => ({
        getCurrentNotePath: () => 'note.md',
        markCurrentNoteSent: jest.fn(),
        shouldSendCurrentNote: () => true,
        startSession: jest.fn(),
        transformContextMentions: (text: string) => `canonical:${text}`,
      }),
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
      canonicalText: 'canonical:B',
      context: {
        browserSelection: browserContext,
        canvasSelection: canvasContext,
        currentNote: { path: 'note.md' },
        editorSelection: editorContext,
      },
      rawDisplayText: 'B',
      userTurnOrdinal: 2,
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
    const fixture = createFixture({
      getExternalContextSelector: () => ({
        addExternalContext: jest.fn(),
        getExternalContexts: () => ['/external/project'],
      }),
      getFileContextManager: () => ({
        getCurrentNotePath: () => 'note.md',
        markCurrentNoteSent: jest.fn(),
        shouldSendCurrentNote: () => true,
        startSession: jest.fn(),
        transformContextMentions: (text: string) => text,
      }),
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
        externalWorkspaceRoots: ['/external/project'],
        model: 'claude-model',
      }),
      context: expect.objectContaining({
        currentNote: { path: 'note.md' },
        externalContextPaths: ['/external/project'],
      }),
    }));
  });

  it('projects toolbar plan selection into provider mode only when plan mode is supported', async () => {
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'grok',
      supportsPlanMode: true,
    } as any);
    jest.mocked(ProviderSettingsCoordinator.getProviderSettingsSnapshot).mockReturnValue({
      effortLevel: 'high',
      model: 'grok/model',
      permissionMode: 'plan',
    });
    const grokFixture = createFixture({
      getAuxiliaryModel: () => 'grok/model',
      getTabProviderId: () => 'grok',
    });

    await grokFixture.controller.sendMessage({ content: 'make a plan' });

    expect(grokFixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        mode: 'plan',
        permissionMode: 'plan',
      }),
    }));

    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'pi',
      supportsPlanMode: false,
    } as any);
    const piFixture = createFixture({
      getAuxiliaryModel: () => 'pi/model',
      getTabProviderId: () => 'pi',
    });

    await piFixture.controller.sendMessage({ content: 'do not project a synthetic mode' });

    const piSubmission = piFixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    expect(piSubmission.configuration.permissionMode).toBe('plan');
    expect(piSubmission.configuration.mode).toBeUndefined();
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
    expect(fixture.deps.streamController.appendText).not.toHaveBeenCalled();
  });

  it('restores the unsent turn after an asynchronous unaccepted configuration rejection', async () => {
    const fixture = createFixture();
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
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.deps.renderer.removeMessage).toHaveBeenCalledTimes(2);
    expect(fixture.deps.conversationController.save).not.toHaveBeenCalled();
    expect(fixture.deps.streamController.appendText).not.toHaveBeenCalled();
  });

  it('does not restore input after an ambiguous post-handoff rejection', async () => {
    const fixture = createFixture();
    fixture.input.value = 'possibly sent';
    fixture.coordinator.execute.mockRejectedValueOnce(new Error('stream failed'));

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.messages).toHaveLength(2);
    expect(fixture.deps.conversationController.save).toHaveBeenCalledTimes(1);
    expect(fixture.deps.streamController.appendText).toHaveBeenCalledWith(
      '\n\n**Error:** stream failed',
    );
  });

  it('routes normalized requested output to StreamController', async () => {
    const fixture = createFixture();
    fixture.coordinator.execute.mockImplementationOnce(async () => {
      await fixture.controller.handleExecutionEvent({
        type: 'text_delta',
        text: 'world',
      } as ProviderExecutionEvent);
      return { accepted: true, planCompleted: false, status: 'completed' };
    });

    await fixture.controller.sendMessage({ content: 'hello' });

    expect(fixture.deps.streamController.handleStreamChunk).toHaveBeenCalledWith(
      { content: 'world', type: 'text' },
      expect.objectContaining({ role: 'assistant' }),
    );
  });

  it('cancels active execution through the coordinator', () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;

    fixture.controller.cancelStreaming();

    expect(fixture.coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.state.cancelRequested).toBe(true);
  });

  it('queues while streaming and steers through the coordinator', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'follow up';

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.coordinator.steer).toHaveBeenCalledWith(expect.objectContaining({
      canonicalText: 'follow up',
      rawDisplayText: 'follow up',
    }));
    expect(fixture.state.queuedMessage).toBeNull();
  });

  it('restores a queued message only after definite steer rejection', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'definitely unsent';
    fixture.coordinator.steer.mockResolvedValueOnce(false);

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.state.queuedMessage).toMatchObject({
      content: 'definitely unsent',
    });
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect((fixture.controller as any).pendingProviderUserMessages).toEqual([]);
  });

  it('restores a queued message after typed definite pre-handoff steer failure', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'staging failed';
    fixture.coordinator.steer.mockRejectedValueOnce(
      new ChatExecutionPreHandoffError(new Error('ledger unavailable')),
    );

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'staging failed' });
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect((fixture.controller as any).pendingProviderUserMessages).toEqual([]);
    expect(Notice).toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('does not requeue an ambiguously delivered steer and retains provider correlation', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'possibly delivered';
    fixture.coordinator.steer.mockRejectedValueOnce(new Error('transport closed'));

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        expectedProviderMessage: expect.objectContaining({ displayContent: 'possibly delivered' }),
        providerDisposition: 'ambiguous-awaiting-reconciliation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
    expect(Notice).toHaveBeenCalledWith(
      'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.',
    );
  });

  it('does not make a definitely accepted steer retryable while provider correlation is pending', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'accepted before binding changed';
    fixture.coordinator.steer.mockResolvedValueOnce(true);

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.state.queuedMessage).toBeNull();
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        expectedProviderMessage: expect.objectContaining({
          displayContent: 'accepted before binding changed',
        }),
        providerDisposition: 'accepted-awaiting-correlation',
      });
  });

  it('does not restore an awaiting steer when cancellation races definite acceptance', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'accepted while cancelling';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();

    nativeResult.resolve(true);
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('restores an awaiting steer exactly once when cancellation races definite rejection', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'rejected while cancelling';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.resolve(false);
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.input.value).toBe('rejected while cancelling');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('does not restore an awaiting steer when cancellation races ambiguous rejection', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'unknown while cancelling';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.reject(new Error('transport closed'));
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        correlationState: 'pending',
        providerDisposition: 'ambiguous-awaiting-reconciliation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
  });

  it('keeps stale definite acceptance non-retryable in its originating conversation', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    nativeResult.resolve(true);
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'accepted-awaiting-correlation',
        retryState: 'blocked',
        uiState: 'cleared',
      });
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-2'))
      .toBe(false);
  });

  it('parks stale definite rejection with conversation A until A is active again', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'conversation A retry';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    fixture.state.isStreaming = false;
    fixture.input.value = 'conversation B draft';
    nativeResult.resolve(false);
    await steer;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        providerDisposition: 'definitely-unsent',
        retryState: 'parked',
      });

    fixture.state.currentConversationId = 'conversation-1';
    fixture.input.value = '';
    fixture.controller.onConversationActivated();
    fixture.controller.onConversationActivated();

    expect(fixture.input.value).toBe('conversation A retry');
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('parks a definite rejection that settles inside the conversation switch window', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'conversation A retry';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.isSwitchingConversation = true;
    nativeResult.resolve(false);
    await steer;

    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.state.isSwitchingConversation = false;
    fixture.state.isStreaming = false;
    fixture.controller.onConversationActivated();
    fixture.controller.onConversationActivated();
    expect(fixture.input.value).toBe('conversation A retry');
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('keeps B queue independent while typed pre-handoff retry for A is parked', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'conversation A typed retry';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B queued';
    await fixture.controller.sendMessage();
    nativeResult.reject(new ChatExecutionPreHandoffError(new Error('A cleanup failed')));
    await steer;

    expect(fixture.state.queuedMessage).toMatchObject({ content: 'conversation B queued' });
    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.controller.cancelStreaming();
    expect(fixture.input.value).toBe('conversation B queued');
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({ retryState: 'parked' });

    fixture.state.currentConversationId = 'conversation-1';
    fixture.state.isStreaming = false;
    fixture.input.value = '';
    fixture.controller.onConversationActivated();
    expect(fixture.input.value).toBe('conversation A typed retry');
  });

  it('does not let stale accepted A mark conversation B file context as sent', async () => {
    const fileContextManager = {
      getCurrentNotePath: jest.fn().mockReturnValue(null),
      markCurrentNoteSent: jest.fn(),
      shouldSendCurrentNote: jest.fn().mockReturnValue(false),
      startSession: jest.fn(),
      transformContextMentions: jest.fn((text: string) => text),
    };
    const fixture = createFixture({
      getFileContextManager: () => fileContextManager,
    });
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'accepted A';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.state.currentConversationId = 'conversation-2';
    nativeResult.resolve(true);
    await steer;

    expect(fileContextManager.markCurrentNoteSent).not.toHaveBeenCalled();
    expect(fixture.input.value).toBe('');
  });

  it.each([
    ['accepted', true],
    ['ambiguous', new Error('steer response lost')],
  ])('does not schedule a retry when the main turn completes before a %s steer result', async (
    _label,
    steerOutcome,
  ) => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<boolean>();
    const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setTimeout>,
    );
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = `${_label} steer`;
    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;
    if (steerOutcome instanceof Error) {
      nativeResult.reject(steerOutcome);
    } else {
      nativeResult.resolve(steerOutcome);
    }
    await steer;

    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    timeoutSpy.mockRestore();
  });

  it('restores exactly once when turn completion races definite steer rejection', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<boolean>();
    const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setTimeout>,
    );
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'definitely rejected steer';
    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;
    nativeResult.resolve(false);
    await steer;

    expect(fixture.input.value).toBe('definitely rejected steer');
    expect(fixture.state.queuedMessage).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    timeoutSpy.mockRestore();
  });

  it('blocks queued steer B while ambiguous steer A still owns provider correlation', async () => {
    const fixture = createFixture();
    fixture.state.isStreaming = true;
    fixture.input.value = 'ambiguous A';
    fixture.coordinator.steer.mockRejectedValueOnce(new Error('A response lost'));

    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    fixture.input.value = 'queued B';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.state.queuedMessage).toMatchObject({ content: 'queued B' });
    expect((fixture.controller as any).pendingSteersByConversation.get('conversation-1'))
      .toMatchObject({
        expectedProviderMessage: expect.objectContaining({ displayContent: 'ambiguous A' }),
        providerDisposition: 'ambiguous-awaiting-reconciliation',
      });
  });

  it('releases an ambiguous steer lane to durable history at the fenced turn boundary', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockRejectedValueOnce(new Error('A response lost'));
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'ambiguous A';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();

    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(true);

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;

    expect(fixture.input.value).toBe('');
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    fixture.state.isStreaming = true;
    fixture.input.value = 'later steer B';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'keeps early live acceptance authoritative across delayed %s and cancellation',
    async (nativeAccepted) => {
      const fixture = createFixture();
      const mainResult = deferred<{
        accepted: boolean;
        planCompleted: boolean;
        status: 'completed';
      }>();
      const nativeResult = deferred<boolean>();
      fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
      fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
      fixture.input.value = 'main turn';
      const mainTurn = fixture.controller.sendMessage();
      await waitForCall(fixture.coordinator.execute);
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
      fixture.input.value = 'early accepted steer';

      await fixture.controller.sendMessage();
      const steer = (fixture.controller as any).steerQueuedMessage();
      await waitForCall(fixture.coordinator.steer);
      const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;
      await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
        'provider-formatted steer',
        2,
        'native-steer-user',
      ));
      fixture.controller.cancelStreaming();
      nativeResult.resolve(nativeAccepted);
      mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
      await steer;
      await mainTurn;

      expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledWith(
        submission.inputRecordId,
        'native-steer-user',
      );
      expect(fixture.state.messages.filter(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toHaveLength(1);
      expect(fixture.state.messages.find(message => (
        message.role === 'user' && message.displayContent === 'early accepted steer'
      ))).toMatchObject({ userMessageId: 'native-steer-user' });
      expect(fixture.input.value).toBe('');
      expect(fixture.state.queuedMessage).toBeNull();
      expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
        .toBe(false);
      expect(fixture.coordinator.releaseSteerCorrelation).toHaveBeenCalledWith(
        submission.inputRecordId,
      );
    },
  );

  it('enriches ack-before-live persistence and canonical message identity', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'acknowledged before live event';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;

    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-after-ack',
    ));

    expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledWith(
      submission.inputRecordId,
      'native-after-ack',
    );
    expect(fixture.state.messages.find(message => (
      message.role === 'user' && message.displayContent === 'acknowledged before live event'
    ))).toMatchObject({
      content: 'acknowledged before live event',
      userMessageId: 'native-after-ack',
    });
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;
  });

  it('releases ack-before-live correlation to history when no live event arrives', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    fixture.input.value = 'accepted without live event';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    const submission = fixture.coordinator.steer.mock.calls[0][0] as ChatTurnSubmission;

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;

    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect(fixture.coordinator.releaseSteerCorrelation).toHaveBeenCalledWith(
      submission.inputRecordId,
    );
  });

  it.each([
    ['raw acknowledgement loss', new Error('acknowledgement lost')],
    [
      'typed pre-handoff failure',
      new ChatExecutionPreHandoffError(new Error('late cleanup failed')),
    ],
  ])('does not let %s downgrade early acceptance after a stale binding', async (
    _label,
    nativeError,
  ) => {
    let activeCoordinator: ReturnType<typeof createFixture>['coordinator'];
    const fixture = createFixture({
      getExecutionCoordinator: () => activeCoordinator,
    });
    activeCoordinator = fixture.coordinator;
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'accepted before switch';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    const replacementCoordinator = {
      ...fixture.coordinator,
      acceptSteerFromProviderEvent: jest.fn().mockResolvedValue(true),
      releaseSteerCorrelation: jest.fn(),
    };
    activeCoordinator = replacementCoordinator;
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));
    fixture.state.currentConversationId = 'conversation-2';
    fixture.input.value = 'conversation B draft';
    nativeResult.reject(nativeError);
    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await steer;
    await mainTurn;

    expect(fixture.input.value).toBe('conversation B draft');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect(fixture.coordinator.acceptSteerFromProviderEvent).toHaveBeenCalledTimes(1);
    expect(replacementCoordinator.acceptSteerFromProviderEvent).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalledWith(
      'Failed to steer the queued message. It is still available.',
    );
  });

  it('admits a later steer after terminal cleanup when an early-accepted result never settles', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer
      .mockReturnValueOnce(nativeResult.promise)
      .mockResolvedValueOnce(true);
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'never-settling accepted steer';
    await fixture.controller.sendMessage();
    void (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
    ));

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    fixture.state.isStreaming = true;
    fixture.input.value = 'later steer';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(2);
  });

  it('renders accepted live input once and remains non-retryable when acceptance persistence fails', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.coordinator.acceptSteerFromProviderEvent.mockRejectedValueOnce(
      new Error('accept save failed'),
    );
    fixture.input.value = 'main turn';
    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent(requestedUserMessageStarted('main turn', 1));
    fixture.input.value = 'accepted despite save failure';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    await expect(fixture.controller.handleExecutionEvent(requestedUserMessageStarted(
      'provider-formatted steer',
      2,
      'native-steer-user',
    ))).rejects.toThrow('accept save failed');
    nativeResult.resolve(false);
    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await steer;
    await mainTurn;

    expect(fixture.state.messages.filter(message => (
      message.role === 'user' && message.displayContent === 'accepted despite save failure'
    ))).toHaveLength(1);
    expect(fixture.input.value).toBe('');
    expect(fixture.state.queuedMessage).toBeNull();
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
  });

  it('uses a matching live steer boundary before releasing its provider correlation', async () => {
    const fixture = createFixture();
    const mainResult = deferred<{
      accepted: boolean;
      planCompleted: boolean;
      status: 'completed';
    }>();
    fixture.coordinator.execute.mockReturnValueOnce(mainResult.promise);
    fixture.coordinator.steer.mockRejectedValueOnce(new Error('steer acknowledgement lost'));
    fixture.input.value = 'main turn';

    const mainTurn = fixture.controller.sendMessage();
    await waitForCall(fixture.coordinator.execute);
    await fixture.controller.handleExecutionEvent({
      content: 'main turn',
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sequence: 1,
        sessionInstanceId: 'session-1',
        turnId: 'turn-1',
      },
      type: 'user_message_started',
    });

    fixture.input.value = 'ambiguous live steer';
    await fixture.controller.sendMessage();
    await (fixture.controller as any).steerQueuedMessage();
    await fixture.controller.handleExecutionEvent({
      content: 'provider-formatted steer',
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sequence: 2,
        sessionInstanceId: 'session-1',
        turnId: 'turn-1',
      },
      type: 'user_message_started',
    });

    expect(fixture.state.messages.filter(message => message.role === 'user').at(-1))
      .toMatchObject({
        content: 'ambiguous live steer',
        displayContent: 'ambiguous live steer',
      });
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);

    mainResult.resolve({ accepted: true, planCompleted: false, status: 'completed' });
    await mainTurn;
  });

  it('restores once and removes impossible correlation after typed rejected-steer cleanup failure', async () => {
    const fixture = createFixture();
    const nativeResult = deferred<boolean>();
    fixture.coordinator.steer.mockReturnValueOnce(nativeResult.promise);
    fixture.state.isStreaming = true;
    fixture.input.value = 'retry after cleanup failure';

    await fixture.controller.sendMessage();
    const steer = (fixture.controller as any).steerQueuedMessage();
    await waitForCall(fixture.coordinator.steer);
    fixture.controller.cancelStreaming();
    nativeResult.reject(new ChatExecutionPreHandoffError(new Error('discard save failed')));
    await steer;
    fixture.controller.cancelStreaming();

    expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
    expect(fixture.input.value).toBe('retry after cleanup failure');
    expect((fixture.controller as any).pendingSteersByConversation.has('conversation-1'))
      .toBe(false);
    expect((fixture.controller as any).pendingProviderUserMessages).toEqual([]);
  });

  it('restores pending input when the coordinator reports a missing session', async () => {
    const fixture = createFixture();
    fixture.input.value = 'retry me';
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: false,
      missingSessionResolution: 'reset',
      planCompleted: false,
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
      planCompleted: false,
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
      planCompleted: false,
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

  it('preserves plan completion flow after coordinator execution', async () => {
    const restoreMode = jest.fn();
    const fixture = createFixture({
      restorePrePlanPermissionModeIfNeeded: restoreMode,
    });
    fixture.coordinator.execute.mockResolvedValueOnce({
      accepted: true,
      planCompleted: true,
      status: 'completed',
    });
    jest.spyOn(fixture.controller as any, 'showPlanApproval').mockResolvedValue({
      decision: { type: 'cancel' },
      invalidated: false,
    });

    await fixture.controller.sendMessage({ content: 'make a plan' });

    expect(restoreMode).toHaveBeenCalledTimes(1);
    expect(fixture.deps.conversationController.save).toHaveBeenCalled();
  });

  it('starts title generation independently of the execution session', async () => {
    const generateTitle = jest.fn().mockResolvedValue(undefined);
    const fixture = createFixture({
      getTitleGenerationService: () => ({ generateTitle }) as any,
    });
    fixture.plugin.settings.enableAutoTitleGeneration = true;

    await fixture.controller.sendMessage({ content: 'title this' });

    expect(generateTitle).toHaveBeenCalledWith(
      'conversation-1',
      'title this',
      expect.any(Function),
    );
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
  });
});
