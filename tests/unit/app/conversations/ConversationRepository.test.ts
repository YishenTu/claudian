import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/core/bootstrap/ConversationPersistenceStore';
import { resolveConversationModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

function createConversation(id = 'conversation-1'): Conversation {
  return {
    id,
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: 'session-1',
    messages: [],
  };
}

function createRepository(conversation = createConversation()) {
  const persistence: jest.Mocked<ConversationPersistence> = {
    metadataReader: {
      load: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue({
        records: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      loadMetadata: jest.fn().mockResolvedValue(null),
      scanMetadata: jest.fn().mockResolvedValue({
        metadata: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      listMetadata: jest.fn().mockResolvedValue([]),
    },
    loadInputLedger: jest.fn().mockResolvedValue({ status: 'missing' }),
    saveInputLedger: jest.fn().mockResolvedValue(undefined),
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    deleteLegacyMetadata: jest.fn().mockResolvedValue(undefined),
    deleteInputLedger: jest.fn().mockResolvedValue(undefined),
    isDeleted: jest.fn().mockResolvedValue(false),
    markDeleted: jest.fn().mockResolvedValue(undefined),
  };
  const repository = new ConversationRepository({
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  repository.replaceAll([conversation]);
  return { repository, persistence };
}

describe('ConversationRepository hydration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns cached metadata without hydrating provider history', () => {
    const hydrateConversationHistory = jest.fn();
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(hydrateConversationHistory).not.toHaveBeenCalled();
  });

  it('projects the linked note path into lightweight conversation metadata', () => {
    const conversation = createConversation();
    conversation.currentNote = 'Notes/Architecture.md';
    conversation.selectedModel = 'claude-sonnet-4-5';
    const { repository } = createRepository(conversation);

    expect(repository.getMetadata(conversation.id)).toMatchObject({
      currentNote: 'Notes/Architecture.md',
      selectedModel: 'claude-sonnet-4-5',
    });
    expect(repository.list()[0]).toMatchObject({
      currentNote: 'Notes/Architecture.md',
      selectedModel: 'claude-sonnet-4-5',
    });
  });

  it('recovers and persists only missing historical model selections', async () => {
    const missing = createConversation('missing-model');
    const existing = createConversation('existing-model');
    existing.selectedModel = 'claude-code/current-model';
    const recoverConversationModelSelection = jest.fn(async (conversation: Conversation) => (
      conversation.id === missing.id ? 'claude-code/historical-model' : null
    ));
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn(),
      recoverConversationModelSelection,
    } as any);
    const { repository, persistence } = createRepository(missing);
    repository.replaceAll([missing, existing]);

    await expect(repository.recoverMissingSelectedModels()).resolves.toEqual([missing]);

    expect(recoverConversationModelSelection).toHaveBeenCalledTimes(1);
    expect(recoverConversationModelSelection).toHaveBeenCalledWith(
      missing,
      '/vault',
      expect.any(Object),
    );
    expect(missing.selectedModel).toBe('claude-code/historical-model');
    expect(existing.selectedModel).toBe('claude-code/current-model');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: missing.id,
      selectedModel: 'claude-code/historical-model',
    }));
  });

  it('continues recovery when historical metadata references an unavailable provider', async () => {
    const unavailable = createConversation('unavailable-provider');
    unavailable.providerId = 'removed-provider';
    const recoverable = createConversation('recoverable-provider');
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
      .mockImplementation((providerId) => {
        if (providerId === unavailable.providerId) {
          throw new Error('Provider is no longer registered');
        }
        return {
          recoverConversationModelSelection: jest.fn()
            .mockResolvedValue('claude-code/recovered-model'),
        } as any;
      });
    const { repository } = createRepository(unavailable);
    repository.replaceAll([unavailable, recoverable]);

    await expect(repository.recoverMissingSelectedModels())
      .resolves.toEqual([recoverable]);
    expect(unavailable.selectedModel).toBeUndefined();
    expect(recoverable.selectedModel).toBe('claude-code/recovered-model');
  });

  it('isolates malformed persisted model metadata during recovery', async () => {
    const malformed = createConversation('malformed-model');
    (malformed as unknown as { selectedModel: unknown }).selectedModel = 42;
    const recoverable = createConversation('valid-missing-model');
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      recoverConversationModelSelection: jest.fn(async (conversation: Conversation) => (
        `claude-code/recovered-${conversation.id}`
      )),
    } as any);
    const { repository } = createRepository(malformed);
    repository.replaceAll([malformed, recoverable]);

    await expect(repository.recoverMissingSelectedModels())
      .resolves.toEqual([malformed, recoverable]);
    expect(malformed.selectedModel).toBe('claude-code/recovered-malformed-model');
    expect(recoverable.selectedModel).toBe('claude-code/recovered-valid-missing-model');
  });

  it('recovers from preserved metadata after live session state is invalidated', async () => {
    const recoverySource = createConversation('invalidated-session');
    recoverySource.providerId = 'codex';
    recoverySource.providerState = { threadId: 'thread-before-invalidation' };
    recoverySource.sessionId = 'thread-before-invalidation';
    const invalidated = {
      ...recoverySource,
      providerState: undefined,
      sessionId: null,
    };
    const recoverConversationModelSelection = jest.fn().mockResolvedValue(
      'openai-codex/gpt-5.5',
    );
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hasConversationModelRecoverySource: (conversation: Conversation) => (
        conversation.sessionId === 'thread-before-invalidation'
      ),
      recoverConversationModelSelection,
    } as any);
    const { repository } = createRepository(invalidated);

    (repository as any).registerHistoricalModelRecoverySources([recoverySource]);

    await expect(repository.recoverMissingSelectedModels()).resolves.toEqual([invalidated]);
    expect(recoverConversationModelSelection).toHaveBeenCalledWith(
      recoverySource,
      '/vault',
      expect.any(Object),
    );
    expect(invalidated.selectedModel).toBe('openai-codex/gpt-5.5');
  });

  it('persists unresolved recovery locators for retry after restart', async () => {
    const recoverySource = createConversation('retry-after-restart');
    recoverySource.providerId = 'codex';
    recoverySource.sessionId = 'thread-before-invalidation';
    recoverySource.providerState = { threadId: 'thread-before-invalidation' };
    const invalidated: Conversation = {
      ...recoverySource,
      sessionId: null,
      providerState: undefined,
    };
    const recoverConversationModelSelection = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('openai-codex/gpt-5.5');
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hasConversationModelRecoverySource: (conversation: Conversation) => (
        conversation.sessionId === 'thread-before-invalidation'
      ),
      recoverConversationModelSelection,
    } as any);
    const firstRun = createRepository(invalidated);

    firstRun.repository.registerHistoricalModelRecoverySources([recoverySource]);
    await expect(firstRun.repository.recoverMissingSelectedModels()).resolves.toEqual([]);
    await firstRun.repository.persistConversations([invalidated]);

    const persisted = firstRun.persistence.saveMetadata.mock.calls.at(-1)?.[0];
    expect(persisted).toMatchObject({
      id: invalidated.id,
      sessionId: null,
      modelRecoverySource: {
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      },
    });

    const restartedConversation: Conversation = {
      ...invalidated,
      modelRecoverySource: persisted?.modelRecoverySource,
    };
    const restarted = createRepository(restartedConversation);

    await expect(restarted.repository.recoverMissingSelectedModels())
      .resolves.toEqual([restartedConversation]);
    expect(recoverConversationModelSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      }),
      '/vault',
      expect.any(Object),
    );
    expect(restartedConversation.modelRecoverySource).toBeUndefined();
    expect(restarted.persistence.saveMetadata).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelRecoverySource: expect.anything() }),
    );
  });

  it('retires an unresolved recovery locator when a fresh provider session is accepted', async () => {
    const recoverySource = createConversation('fresh-session-supersedes-recovery');
    recoverySource.providerId = 'codex';
    recoverySource.sessionId = 'old-thread';
    recoverySource.providerState = { threadId: 'old-thread' };
    const invalidated: Conversation = {
      ...recoverySource,
      sessionId: null,
      providerState: undefined,
    };
    const recoverConversationModelSelection = jest.fn(async (conversation: Conversation) => (
      conversation.sessionId === 'fresh-thread'
        ? 'openai-codex/gpt-5.6'
        : null
    ));
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hasConversationModelRecoverySource: (conversation: Conversation) => (
        typeof conversation.sessionId === 'string'
      ),
      recoverConversationModelSelection,
    } as any);
    const firstRun = createRepository(invalidated);

    firstRun.repository.registerHistoricalModelRecoverySources([recoverySource]);
    await expect(firstRun.repository.recoverMissingSelectedModels()).resolves.toEqual([]);
    firstRun.repository.registerExecutionBinding(invalidated.id, 'binding-1', 1);
    await expect(firstRun.repository.persistExecutionSnapshot(
      invalidated.id,
      'binding-1',
      1,
      {
        providerId: 'codex',
        revision: 1,
        status: 'idle',
        providerSessionId: 'fresh-thread',
        providerState: { threadId: 'fresh-thread' },
      },
    )).resolves.toBe(true);

    const persisted = firstRun.persistence.saveMetadata.mock.calls.at(-1)?.[0];
    expect(invalidated.modelRecoverySource).toBeUndefined();
    expect(persisted).toMatchObject({
      sessionId: 'fresh-thread',
      providerState: { threadId: 'fresh-thread' },
    });
    expect(persisted).not.toHaveProperty('modelRecoverySource');

    const restartedConversation: Conversation = {
      ...invalidated,
      sessionId: persisted?.sessionId ?? null,
      providerState: persisted?.providerState,
    };
    const restarted = createRepository(restartedConversation);

    await expect(restarted.repository.recoverMissingSelectedModels())
      .resolves.toEqual([restartedConversation]);
    expect(recoverConversationModelSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'fresh-thread',
        providerState: { threadId: 'fresh-thread' },
      }),
      '/vault',
      expect.any(Object),
    );
  });

  it('coalesces lazy and background recovery before usage metadata can win', async () => {
    const conversation = createConversation('recovery-race');
    conversation.usage = {
      contextTokens: 1,
      contextWindow: 200_000,
      inputTokens: 1,
      model: 'opus',
      percentage: 1,
    };
    let finishRecovery: (model: string | null) => void = () => undefined;
    const recoverConversationModelSelection = jest.fn(() => new Promise<string | null>(
      resolve => { finishRecovery = resolve; },
    ));
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      recoverConversationModelSelection,
    } as any);
    const { repository } = createRepository(conversation);

    const backgroundRecovery = repository.recoverMissingSelectedModels();
    const lazyInitialization = (repository as any).ensureSelectedModel(conversation);
    finishRecovery('claude-code/retired-native-model');

    await expect(Promise.all([backgroundRecovery, lazyInitialization]))
      .resolves.toEqual([[conversation], undefined]);
    expect(recoverConversationModelSelection).toHaveBeenCalledTimes(1);
    expect(conversation.selectedModel).toBe('claude-code/retired-native-model');
  });

  it('leaves usage fallback unpersisted when native model recovery is unresolved', async () => {
    const conversation = createConversation('unresolved-model');
    conversation.usage = {
      contextTokens: 1,
      contextWindow: 200_000,
      inputTokens: 1,
      model: 'opus',
      percentage: 1,
    };
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      recoverConversationModelSelection: jest.fn().mockResolvedValue(null),
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await (repository as any).ensureSelectedModel(conversation);

    expect(conversation.selectedModel).toBeUndefined();
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('retains usage migration when the provider has no native recovery source', async () => {
    const conversation = createConversation('usage-only-model');
    conversation.usage = {
      contextTokens: 1,
      contextWindow: 200_000,
      inputTokens: 1,
      model: 'opus',
      percentage: 1,
    };
    const recoverConversationModelSelection = jest.fn().mockResolvedValue(null);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hasConversationModelRecoverySource: jest.fn().mockReturnValue(false),
      recoverConversationModelSelection,
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await (repository as any).ensureSelectedModel(conversation);

    expect(recoverConversationModelSelection).not.toHaveBeenCalled();
    expect(conversation.selectedModel).toBe('opus');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      selectedModel: 'opus',
    }));
  });

  it('preserves an unavailable historical selection while runtime resolution falls back', async () => {
    const conversation = createConversation('retired-model');
    conversation.selectedModel = 'claude-code/retired-native-model';
    conversation.usage = {
      contextTokens: 1,
      contextWindow: 200_000,
      inputTokens: 1,
      model: 'opus',
      percentage: 1,
    };
    const { repository, persistence } = createRepository(conversation);

    await (repository as any).ensureSelectedModel(conversation);

    expect(conversation.selectedModel).toBe('claude-code/retired-native-model');
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
    expect(resolveConversationModel({}, 'claude', conversation)).toMatchObject({
      model: 'opus',
      source: 'usage',
    });
  });

  it('persists and projects pinned session metadata', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    const { repository, persistence } = createRepository(conversation);

    await repository.setPinned(conversation.id, true);

    expect(repository.getMetadata(conversation.id)?.isPinned).toBe(true);
    expect(repository.list()[0].isPinned).toBe(true);
    expect(conversation.lastActivityAt).toBe(42);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      isPinned: true,
    }));
  });

  it('does not treat metadata edits or provider snapshots as session activity', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    const { repository } = createRepository(conversation);

    await repository.rename(conversation.id, 'Renamed');
    repository.registerExecutionBinding(conversation.id, 'binding-1', 1);
    await repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      1,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'native-session',
        status: 'idle',
      },
    );

    expect(conversation.lastActivityAt).toBe(42);
  });

  it('persists archive state without changing activity and clears pin state', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    conversation.isPinned = true;
    const { repository, persistence } = createRepository(conversation);

    await repository.setArchived(conversation.id, true);

    expect(repository.getMetadata(conversation.id)).toMatchObject({
      isArchived: true,
      isPinned: false,
      lastActivityAt: 42,
    });
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      isArchived: true,
      isPinned: false,
    }));

    await repository.setPinned(conversation.id, true);
    expect(conversation.isPinned).toBe(false);

    await repository.setArchived(conversation.id, false);
    expect(conversation).toMatchObject({ isArchived: false, isPinned: false });
  });

  it('rewrites linked note paths without changing session activity timestamps', async () => {
    const fileConversation = createConversation('file');
    fileConversation.currentNote = 'Notes/Old.md';
    fileConversation.lastActivityAt = 20;
    const folderConversation = createConversation('folder');
    folderConversation.currentNote = 'Projects/Old/Plan.md';
    folderConversation.lastActivityAt = 40;
    const unrelatedConversation = createConversation('unrelated');
    unrelatedConversation.currentNote = 'Notes/Other.md';
    const { repository, persistence } = createRepository(fileConversation);
    repository.mergeMetadataConversations([folderConversation, unrelatedConversation]);

    await repository.rewriteCurrentNotePaths('Notes/Old.md', 'Notes/New.md');
    await repository.rewriteCurrentNotePaths('Projects/Old', 'Projects/New', {
      includeDescendants: true,
    });

    expect(fileConversation).toMatchObject({
      currentNote: 'Notes/New.md',
      lastActivityAt: 20,
    });
    expect(folderConversation).toMatchObject({
      currentNote: 'Projects/New/Plan.md',
      lastActivityAt: 40,
    });
    expect(unrelatedConversation.currentNote).toBe('Notes/Other.md');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file',
      currentNote: 'Notes/New.md',
      lastActivityAt: 20,
    }));
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'folder',
      currentNote: 'Projects/New/Plan.md',
      lastActivityAt: 40,
    }));
  });

  it('persists read-only state synchronization without changing session activity', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    const { repository, persistence } = createRepository(conversation);

    await repository.update(
      conversation.id,
      { currentNote: 'Notes/Current.md' },
    );

    expect(conversation.lastActivityAt).toBe(42);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      currentNote: 'Notes/Current.md',
      lastActivityAt: 42,
    }));
  });

  it('does not apply an earlier rename to a new session that reuses the old path', async () => {
    const originalConversation = createConversation('original');
    originalConversation.currentNote = 'Notes/Old.md';
    const { repository } = createRepository(originalConversation);

    await repository.rewriteCurrentNotePaths('Notes/Old.md', 'Notes/Renamed.md');
    const newConversation = await repository.create();
    await repository.update(newConversation.id, { currentNote: 'Notes/Old.md' });
    await repository.rewriteCurrentNotePaths('Notes/Renamed.md', 'Notes/Final.md');

    expect(originalConversation.currentNote).toBe('Notes/Final.md');
    expect(newConversation.currentNote).toBe('Notes/Old.md');
  });

  it('deduplicates concurrent hydration and does not reread an empty transcript', async () => {
    let release!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    const first = repository.ensureHydrated(conversation.id);
    const second = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([conversation, conversation]);
    await repository.ensureHydrated(conversation.id);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);
  });

  it('durably saves a provider-recovered session reference before hydrating history', async () => {
    const conversation = createConversation();
    conversation.sessionId = null;
    conversation.providerState = undefined;
    conversation.lastActivityAt = 42;
    const recoverConversationSessionReference = jest.fn(async (target: Conversation) => {
      target.sessionId = 'recovered-session';
      target.providerState = { providerSessionId: 'recovered-session' };
      return true;
    });
    const getConversationSessionAvailability = jest.fn().mockResolvedValue('available');
    const hydrateConversationHistory = jest.fn().mockImplementation(async (target: Conversation) => {
      target.messages.push({ id: 'message-1', role: 'user', content: 'Recovered', timestamp: 1 });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      recoverConversationSessionReference,
      getConversationSessionAvailability,
      hydrateConversationHistory,
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);

    expect(recoverConversationSessionReference).toHaveBeenCalledWith(
      conversation,
      '/vault',
      expect.any(Object),
    );
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      sessionId: 'recovered-session',
      providerState: { providerSessionId: 'recovered-session' },
      lastActivityAt: 42,
    }));
    expect(hydrateConversationHistory).toHaveBeenCalledWith(
      conversation,
      '/vault',
      expect.any(Object),
    );
  });

  it('allows hydration to retry after a provider history failure', async () => {
    const hydrateConversationHistory = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    await expect(repository.ensureHydrated(conversation.id)).rejects.toThrow('temporary failure');
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('does not return a conversation deleted while hydration is in flight', async () => {
    let releaseHydration!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository, persistence } = createRepository(conversation);

    const hydration = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    const deletion = repository.delete(conversation.id);

    releaseHydration();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('does not return an already hydrated conversation deleted while model reconciliation is in flight', async () => {
    let markReconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const reconciliationStarted = new Promise<void>((resolve) => {
      markReconciliationStarted = resolve;
    });
    const reconciliationRelease = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const conversation = createConversation();
    conversation.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository, persistence } = createRepository(conversation);
    jest.spyOn(repository as any, 'ensureSelectedModel').mockImplementation(async () => {
      markReconciliationStarted();
      await reconciliationRelease;
    });

    const hydration = repository.ensureHydrated(conversation.id);
    await reconciliationStarted;
    const deletion = repository.delete(conversation.id);
    releaseReconciliation();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('restarts hydration when provider session identity changes in flight', async () => {
    let markFirstHydrationStarted!: () => void;
    let releaseFirstHydration!: () => void;
    const firstHydrationStarted = new Promise<void>((resolve) => {
      markFirstHydrationStarted = resolve;
    });
    const firstHydrationRelease = new Promise<void>((resolve) => {
      releaseFirstHydration = resolve;
    });
    const hydrateConversationHistory = jest.fn()
      .mockImplementationOnce(async () => {
        markFirstHydrationStarted();
        await firstHydrationRelease;
      })
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    const staleHydration = repository.ensureHydrated(conversation.id);
    await firstHydrationStarted;
    await repository.update(conversation.id, { sessionId: 'session-2' });
    releaseFirstHydration();

    await expect(staleHydration).resolves.toBeNull();
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('merges background metadata without replacing an already hydrated conversation', () => {
    const existing = createConversation('existing');
    existing.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository } = createRepository(existing);
    const duplicate = createConversation('existing');
    const added = createConversation('added');
    added.lastActivityAt = 2;

    const merged = repository.mergeMetadataConversations([duplicate, added]);

    expect(merged).toEqual([added]);
    expect(repository.getCachedConversation('existing')).toBe(existing);
    expect(repository.getCachedConversation('existing')?.messages).toHaveLength(1);
    expect(repository.getAll().map(conversation => conversation.id)).toEqual(['added', 'existing']);
  });

  it('does not resurrect a deleted conversation from a late background metadata batch', async () => {
    const conversation = createConversation('deleted');
    const { repository } = createRepository(conversation);
    await repository.delete(conversation.id);

    const merged = repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ]);

    expect(merged).toEqual([]);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('discards an exact unresolved metadata shell and invalidates its in-flight hydration', async () => {
    let markHydrationStarted!: () => void;
    let releaseHydration!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      markHydrationStarted = resolve;
    });
    const hydrationRelease = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async () => {
        markHydrationStarted();
        await hydrationRelease;
      },
    } as any);
    const shell = createConversation('unresolved');
    const { repository, persistence } = createRepository(shell);
    repository.registerExecutionBinding(shell.id, 'binding-1', 1);

    const hydration = repository.ensureHydrated(shell.id);
    await hydrationStarted;
    repository.discardUnresolvedMetadataShells([shell]);
    releaseHydration();

    await expect(hydration).resolves.toBeNull();
    await expect(repository.persistExecutionSnapshot(
      shell.id,
      'binding-1',
      1,
      {
        providerId: 'claude',
        revision: 1,
        status: 'idle',
        providerSessionId: 'provider-session-1',
      },
    )).resolves.toBe(false);
    expect(repository.getCachedConversation(shell.id)).toBeNull();
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
    expect(persistence.markDeleted).not.toHaveBeenCalled();
    expect(persistence.deleteCurrentMetadata).not.toHaveBeenCalled();
    expect(persistence.deleteLegacyMetadata).not.toHaveBeenCalled();
    expect(persistence.deleteInputLedger).not.toHaveBeenCalled();
  });

  it('allows a discarded unresolved shell ID to be published again', () => {
    const shell = createConversation('temporarily-unresolved');
    const { repository, persistence } = createRepository(shell);

    repository.discardUnresolvedMetadataShells([shell]);
    const replacement = createConversation(shell.id);
    const merged = repository.mergeMetadataConversations([replacement]);

    expect(merged).toEqual([replacement]);
    expect(repository.getCachedConversation(shell.id)).toBe(replacement);
    expect(persistence.isDeleted).not.toHaveBeenCalled();
    expect(persistence.markDeleted).not.toHaveBeenCalled();
  });

  it('does not discard or invalidate a replacement object with the same conversation ID', async () => {
    const unresolvedShell = createConversation('replaced');
    const { repository, persistence } = createRepository(unresolvedShell);
    const replacement = createConversation(unresolvedShell.id);
    repository.replaceAll([replacement]);
    repository.registerExecutionBinding(replacement.id, 'replacement-binding', 2);

    repository.discardUnresolvedMetadataShells([unresolvedShell]);

    expect(repository.getCachedConversation(replacement.id)).toBe(replacement);
    await expect(repository.persistExecutionSnapshot(
      replacement.id,
      'replacement-binding',
      2,
      {
        providerId: 'claude',
        revision: 1,
        status: 'idle',
        providerSessionId: 'replacement-provider-session',
      },
    )).resolves.toBe(true);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: replacement.id,
      sessionId: 'replacement-provider-session',
    }));
  });
});
