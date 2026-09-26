import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/core/bootstrap/ConversationPersistenceStore';
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
      revalidate: jest.fn().mockResolvedValue([]),
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
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
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
  it.each([false, true])('does not copy unrelated history when invalidating providers (Claude: %s)', (invalidateClaude) => {
    const affected = createConversation();
    const unrelated = { ...createConversation('other'), providerId: 'codex' as const };
    const serializeUnrelated = jest.fn(() => []);
    Object.defineProperty(unrelated.messages, 'toJSON', { value: serializeUnrelated });
    const { repository } = createRepository(affected);
    repository.replaceAll([affected, unrelated]);

    const result = repository.invalidateProviderSessions(invalidateClaude ? ['claude'] : []);

    expect(result).toEqual(invalidateClaude ? [repository.getSync(affected.id)] : []);
    expect(repository.getSync(affected.id)!.sessionId).toBe(invalidateClaude ? null : 'session-1');
    expect(repository.getSync(unrelated.id)!.sessionId).toBe('session-1');
    expect(serializeUnrelated).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    // Exercise repository fallback persistence against a provider that opts into fallback.
    // Claude's preservation policy has a separate regression below.
    const getConfig = ProviderRegistry.getModelPolicy.bind(ProviderRegistry);
    jest.spyOn(ProviderRegistry, 'getModelPolicy').mockImplementation(id => {
      const config = getConfig(id);
      return id === 'claude' ? {
        ...config,
        preserveUnavailableModelSelection: false,
        getModelOptions: () => ['haiku', 'sonnet', 'opus', 'fable'].map(value => ({ value, label: value })),
        getDefaultModel: () => 'opus',
      } : config;
    });
  });

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

    expect(repository.getCachedConversation(conversation.id)).toEqual(conversation);
    expect(hydrateConversationHistory).not.toHaveBeenCalled();
  });

  it('projects Linked content into lightweight conversation metadata', () => {
    const conversation: Conversation = {
      ...createConversation(),
      linkedContentPath: 'Notes/Architecture.md',
    };
    conversation.selectedModel = 'claude-sonnet-4-5';
    const { repository } = createRepository(conversation);

    expect(repository.list()[0]).toMatchObject({
      linkedContentPath: 'Notes/Architecture.md',
      selectedModel: 'claude-sonnet-4-5',
    });
  });

  it('creates normalized Linked content metadata without a legacy path field', async () => {
    const { repository, persistence } = createRepository();

    const conversation = await repository.create({
      sessionId: 'linked-content-session',
      linkedContentPath: 'Projects\\Research//Plan.md',
    });

    expect(repository.getSync(conversation.id)!.linkedContentPath).toBe('Projects/Research/Plan.md');
    expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: conversation.id,
        linkedContentPath: 'Projects/Research/Plan.md',
      }),
    );
    expect(persistence.saveMetadata.mock.calls.at(-1)?.[0])
      .not.toHaveProperty('currentNote');
  });

  it('removes a new Conversation shell when its initial metadata write fails', async () => {
    const { repository, persistence } = createRepository();
    persistence.saveMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(repository.create({
      sessionId: 'failed-linked-content-session',
      linkedContentPath: 'Projects/Plan.md',
    })).rejects.toThrow('metadata unavailable');

    expect(repository.getAll().map(({ id }) => id))
      .not.toContain('failed-linked-content-session');
    expect(repository.list().map(({ id }) => id))
      .not.toContain('failed-linked-content-session');

    await expect(repository.create({
      sessionId: 'failed-linked-content-session',
      linkedContentPath: 'Projects/Plan.md',
    })).resolves.toMatchObject({
      id: 'failed-linked-content-session',
      linkedContentPath: 'Projects/Plan.md',
    });
    expect(repository.getAll().filter(({ id }) => id === 'failed-linked-content-session'))
      .toHaveLength(1);
  });

  it('rejects invalid Linked content at the conversation creation boundary', async () => {
    const { repository, persistence } = createRepository();

    await expect(repository.create({
      linkedContentPath: '../outside',
    })).rejects.toThrow('Invalid Linked content path');

    expect(repository.getAll()).toHaveLength(1);
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('recovers and persists only missing historical model selections', async () => {
    const missing = createConversation('missing-model');
    const existing = createConversation('existing-model');
    existing.selectedModel = 'claude-code/current-model';
    const recoverConversationModelSelection = jest.fn(async (conversation: Conversation) => (
      conversation.id === missing.id ? 'opus' : null
    ));
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn(),
      recoverConversationModelSelection,
    } as any);
    const { repository, persistence } = createRepository(missing);
    repository.replaceAll([missing, existing]);

    await expect(repository.recoverMissingSelectedModels()).resolves.toMatchObject([{ id: missing.id }]);

    expect(recoverConversationModelSelection).toHaveBeenCalledTimes(1);
    expect(recoverConversationModelSelection).toHaveBeenCalledWith(
      missing,
      '/vault',
      expect.any(Object),
    );
    expect(repository.getSync(missing.id)!.selectedModel).toBe('opus');
    expect(repository.getSync(existing.id)!.selectedModel).toBe('claude-code/current-model');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: missing.id,
      selectedModel: 'opus',
    }));
  });

  it('persists the historically recovered model even when unavailable', async () => {
    const conversation = createConversation('retired-recovered-model');
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      recoverConversationModelSelection: jest.fn()
        .mockResolvedValue('claude-code/retired-native-model'),
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await expect(repository.recoverMissingSelectedModels()).resolves.toMatchObject([{ id: conversation.id }]);

    expect(repository.getSync(conversation.id)!.selectedModel).toBe('claude-code/retired-native-model');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      selectedModel: 'claude-code/retired-native-model',
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
            .mockResolvedValue('opus'),
        } as any;
      });
    const { repository } = createRepository(unavailable);
    repository.replaceAll([unavailable, recoverable]);

    await expect(repository.recoverMissingSelectedModels())
      .resolves.toMatchObject([{ id: recoverable.id }]);
    expect(repository.getSync(unavailable.id)!.selectedModel).toBeUndefined();
    expect(repository.getSync(recoverable.id)!.selectedModel).toBe('opus');
  });

  it('isolates malformed persisted model metadata during recovery', async () => {
    const malformed = createConversation('malformed-model');
    (malformed as unknown as { selectedModel: unknown }).selectedModel = 42;
    const recoverable = createConversation('valid-missing-model');
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      recoverConversationModelSelection: jest.fn().mockResolvedValue('opus'),
    } as any);
    const { repository } = createRepository(malformed);
    repository.replaceAll([malformed, recoverable]);

    await expect(repository.recoverMissingSelectedModels())
      .resolves.toMatchObject([{ id: malformed.id }, { id: recoverable.id }]);
    expect(repository.getSync(malformed.id)!.selectedModel).toBe('opus');
    expect(repository.getSync(recoverable.id)!.selectedModel).toBe('opus');
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      hasConversationModelRecoverySource: (conversation: Conversation) => (
        conversation.sessionId === 'thread-before-invalidation'
      ),
      recoverConversationModelSelection,
    } as any);
    const { repository } = createRepository(invalidated);

    (repository as any).registerHistoricalModelRecoverySources([recoverySource]);

    await expect(repository.recoverMissingSelectedModels()).resolves.toMatchObject([{ id: invalidated.id }]);
    expect(recoverConversationModelSelection).toHaveBeenCalledWith(
      recoverySource,
      '/vault',
      expect.any(Object),
    );
    expect(repository.getSync(invalidated.id)!.selectedModel).toBe('openai-codex/gpt-5.5');
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      hasConversationModelRecoverySource: (conversation: Conversation) => (
        conversation.sessionId === 'thread-before-invalidation'
      ),
      recoverConversationModelSelection,
    } as any);
    const firstRun = createRepository(invalidated);

    firstRun.repository.registerHistoricalModelRecoverySources([recoverySource]);
    await expect(firstRun.repository.recoverMissingSelectedModels()).resolves.toEqual([]);
    await firstRun.repository.persistConversations(firstRun.repository.getAll());

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
      .resolves.toMatchObject([{ id: restartedConversation.id }]);
    expect(recoverConversationModelSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'thread-before-invalidation',
        providerState: { threadId: 'thread-before-invalidation' },
      }),
      '/vault',
      expect.any(Object),
    );
    expect(restarted.repository.getSync(restartedConversation.id)?.modelRecoverySource).toBeUndefined();
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
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
    expect(firstRun.repository.getSync(invalidated.id)!.modelRecoverySource).toBeUndefined();
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
      .resolves.toMatchObject([{ id: restartedConversation.id }]);
    expect(recoverConversationModelSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'fresh-thread',
        providerState: { threadId: 'fresh-thread' },
      }),
      '/vault',
      expect.any(Object),
    );
  });

  it('coalesces lazy and background recovery without replacing the recovered model', async () => {
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      recoverConversationModelSelection,
    } as any);
    const { repository } = createRepository(conversation);

    const backgroundRecovery = repository.recoverMissingSelectedModels();
    const lazyInitialization = repository.ensureHydrated(conversation.id);
    finishRecovery('claude-code/retired-native-model');

    await expect(Promise.all([backgroundRecovery, lazyInitialization]))
      .resolves.toEqual([[expect.objectContaining({ id: conversation.id, selectedModel: 'claude-code/retired-native-model' })], expect.objectContaining({ id: conversation.id })]);
    expect(recoverConversationModelSelection).toHaveBeenCalledTimes(1);
    expect(repository.getSync(conversation.id)!.selectedModel).toBe('claude-code/retired-native-model');
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      recoverConversationModelSelection: jest.fn().mockResolvedValue(null),
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await repository.ensureHydrated(conversation.id);

    expect(repository.getSync(conversation.id)!.selectedModel).toBeUndefined();
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
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      hasConversationModelRecoverySource: jest.fn().mockReturnValue(false),
      recoverConversationModelSelection,
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await repository.ensureHydrated(conversation.id);

    expect(recoverConversationModelSelection).not.toHaveBeenCalled();
    expect(repository.getSync(conversation.id)!.selectedModel).toBe('opus');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      selectedModel: 'opus',
    }));
  });

  it('persists the provider default when an unsupported legacy usage model is unavailable', async () => {
    const conversation = createConversation('usage-unavailable-model');
    conversation.usage = {
      contextTokens: 1,
      contextWindow: 200_000,
      inputTokens: 1,
      model: 'claude-code/retired-native-model',
      percentage: 1,
    };
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
      hasConversationModelRecoverySource: jest.fn().mockReturnValue(false),
      recoverConversationModelSelection: jest.fn().mockResolvedValue(null),
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await repository.ensureHydrated(conversation.id);

    expect(repository.getSync(conversation.id)!.selectedModel).toBe('opus');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      selectedModel: 'opus',
    }));
  });

  it('preserves an unavailable stored selection while provider options are empty', async () => {
    const conversation = createConversation('temporarily-empty-catalog');
    conversation.selectedModel = 'claude-code/historical-model';
    jest.spyOn(ProviderRegistry, 'getModelPolicy').mockReturnValue({
      getModelOptions: () => [],
      getDefaultModel: () => null,
      normalizeModelVariant: (model: string) => model,
    } as any);
    const { repository, persistence } = createRepository(conversation);

    await repository.ensureHydrated(conversation.id);

    expect(repository.getSync(conversation.id)!.selectedModel).toBe('claude-code/historical-model');
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('preserves unavailable models during provider reconciliation', async () => {
    const affected = createConversation('affected-model');
    affected.selectedModel = 'claude-code/retired-model';
    const unaffected = createConversation('unaffected-model');
    unaffected.providerId = 'codex';
    unaffected.selectedModel = 'openai-codex/retired-model';
    const { repository, persistence } = createRepository(affected);
    repository.replaceAll([affected, unaffected]);

    await expect(repository.reconcileSelectedModels('claude'))
      .resolves.toEqual([]);

    expect(repository.getSync(affected.id)!.selectedModel).toBe('claude-code/retired-model');
    expect(unaffected.selectedModel).toBe('openai-codex/retired-model');
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('reports whether selected-model metadata is safe for incremental publication', () => {
    const conversation = createConversation('publication-safety');
    const { repository } = createRepository(conversation);

    conversation.selectedModel = 'claude-code/retired-model';
    expect(repository.isSelectedModelPublicationSafe(conversation)).toBe(true);

    conversation.selectedModel = 'opus';
    expect(repository.isSelectedModelPublicationSafe(conversation)).toBe(true);

    conversation.selectedModel = undefined;
    expect(repository.isSelectedModelPublicationSafe(conversation)).toBe(true);

    conversation.providerId = 'unregistered';
    conversation.selectedModel = 'retired-model';
    expect(repository.isSelectedModelPublicationSafe(conversation)).toBe(true);
  });

  it('adopts unavailable model metadata without replacing it', async () => {
    const { repository, persistence } = createRepository(createConversation('existing'));
    const deferred = createConversation('deferred-retired-model');
    deferred.selectedModel = 'claude-code/retired-model';

    await repository.adoptMetadataConversations([{
      conversation: deferred,
      needsMigration: false,
      source: 'device',
    }]);

    expect(repository.getCachedConversation(deferred.id)).toEqual(deferred);
    expect(repository.getSync(deferred.id)!.selectedModel).toBe('claude-code/retired-model');
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('persists and projects pinned session metadata', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    const { repository, persistence } = createRepository(conversation);

    await repository.setPinned(conversation.id, true);

    expect(repository.list()[0].isPinned).toBe(true);
    expect(repository.getSync(conversation.id)!.lastActivityAt).toBe(42);
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

    expect(repository.getSync(conversation.id)!.lastActivityAt).toBe(42);
  });

  it('persists archive state without changing activity and clears pin state', async () => {
    const conversation = createConversation();
    conversation.lastActivityAt = 42;
    conversation.isPinned = true;
    const { repository, persistence } = createRepository(conversation);

    await repository.setArchived(conversation.id, true);

    expect(repository.list().find(({ id }) => id === conversation.id)).toMatchObject({
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
    expect(repository.getSync(conversation.id)!.isPinned).toBe(false);

    await repository.setArchived(conversation.id, false);
    expect(repository.getSync(conversation.id)).toMatchObject({ isArchived: false, isPinned: false });
  });

  it('rewrites exact and descendant Linked content paths without changing activity', async () => {
    const fileConversation: Conversation = {
      ...createConversation('file'),
      linkedContentPath: 'Notes/Old.md',
    };
    fileConversation.lastActivityAt = 20;
    const folderConversation: Conversation = {
      ...createConversation('folder'),
      linkedContentPath: 'Projects/Old/Plan.md',
    };
    folderConversation.lastActivityAt = 40;
    const unrelatedConversation: Conversation = {
      ...createConversation('unrelated'),
      linkedContentPath: 'Notes/Other.md',
    };
    const { repository, persistence } = createRepository(fileConversation);
    repository.mergeMetadataConversations([folderConversation, unrelatedConversation]);

    await repository.rewriteLinkedContentPaths('Notes/Old.md', 'Notes/New.md');
    await repository.rewriteLinkedContentPaths('Projects/Old', 'Projects/New', {
      includeDescendants: true,
    });

    expect(repository.getSync(fileConversation.id)).toMatchObject({
      linkedContentPath: 'Notes/New.md',
      lastActivityAt: 20,
    });
    expect(repository.getSync(folderConversation.id)).toMatchObject({
      linkedContentPath: 'Projects/New/Plan.md',
      lastActivityAt: 40,
    });
    expect(repository.getSync(unrelatedConversation.id)!.linkedContentPath).toBe('Notes/Other.md');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'file',
      linkedContentPath: 'Notes/New.md',
      lastActivityAt: 20,
    }));
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'folder',
      linkedContentPath: 'Projects/New/Plan.md',
      lastActivityAt: 40,
    }));
  });

  it('rejects untyped attempts to set or clear immutable conversation identity', async () => {
    const conversation: Conversation = {
      ...createConversation(),
      linkedContentPath: 'Notes/Current.md',
    };
    conversation.lastActivityAt = 42;
    const { repository, persistence } = createRepository(conversation);
    const untypedUpdate = repository.update.bind(repository) as (
      id: string,
      updates: Record<string, unknown>,
    ) => Promise<void>;

    await expect(untypedUpdate(conversation.id, {
      linkedContentPath: 'Notes/Other.md',
    })).rejects.toThrow('immutable');
    await expect(untypedUpdate(conversation.id, {
      linkedContentPath: undefined,
    })).rejects.toThrow('immutable');

    expect(repository.getSync(conversation.id)!.linkedContentPath).toBe('Notes/Current.md');
    expect(repository.getSync(conversation.id)!.lastActivityAt).toBe(42);
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
  });

  it('repairs leaked Linked content mutations at read and persistence boundaries', async () => {
    const conversation: Conversation = {
      ...createConversation(),
      linkedContentPath: 'Projects/Authoritative',
    };
    const { repository, persistence } = createRepository(conversation);
    const leaked = repository.getSync(conversation.id)! as { linkedContentPath?: string };

    leaked.linkedContentPath = 'Projects/Leaked';
    await repository.persistConversations(repository.getAll());

    expect(repository.getSync(conversation.id)!.linkedContentPath).toBe('Projects/Authoritative');
    expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        linkedContentPath: 'Projects/Authoritative',
      }),
    );

    leaked.linkedContentPath = undefined;
    expect(repository.list().find(({ id }) => id === conversation.id)).toMatchObject({
      linkedContentPath: 'Projects/Authoritative',
    });
    expect(repository.getSync(conversation.id)!.linkedContentPath).toBe('Projects/Authoritative');
  });

  it('repairs a leaked Linked content mutation before a queued save serializes', async () => {
    const conversation: Conversation = {
      ...createConversation(),
      linkedContentPath: 'Projects/Authoritative',
    };
    const { repository, persistence } = createRepository(conversation);
    let releaseFirstSave!: () => void;
    let signalFirstSaveStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSaveStarted = resolve;
    });
    persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>((resolve) => {
      signalFirstSaveStarted();
      releaseFirstSave = resolve;
    }));

    const firstSave = repository.rename(conversation.id, 'First');
    await firstSaveStarted;
    const secondSave = repository.setPinned(conversation.id, true);
    (conversation as { linkedContentPath?: string }).linkedContentPath = 'Projects/Leaked';
    releaseFirstSave();

    await Promise.all([firstSave, secondSave]);

    expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        linkedContentPath: 'Projects/Authoritative',
        isPinned: true,
      }),
    );
    expect(repository.getSync(conversation.id)!.linkedContentPath).toBe('Projects/Authoritative');
  });

  it('does not apply an earlier rename to a new session that reuses the old path', async () => {
    const originalConversation: Conversation = {
      ...createConversation('original'),
      linkedContentPath: 'Notes/Old.md',
    };
    const { repository } = createRepository(originalConversation);

    await repository.rewriteLinkedContentPaths('Notes/Old.md', 'Notes/Renamed.md');
    const newConversation = await repository.create({
      linkedContentPath: 'Notes/Old.md',
    });
    await repository.rewriteLinkedContentPaths('Notes/Renamed.md', 'Notes/Final.md');

    expect(repository.getSync(originalConversation.id)!.linkedContentPath).toBe('Notes/Final.md');
    expect(repository.getSync(newConversation.id)!.linkedContentPath).toBe('Notes/Old.md');
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

    await expect(repository.ensureHydrated(conversation.id)).resolves.toMatchObject({ id: conversation.id });

    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      sessionId: 'recovered-session',
      providerState: { providerSessionId: 'recovered-session' },
      lastActivityAt: 42,
    }));
    expect(repository.getSync(conversation.id)!.messages.map(message => message.content)).toEqual(['Recovered']);

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
    await expect(repository.ensureHydrated(conversation.id)).resolves.toMatchObject({ id: conversation.id });

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
      .mockImplementationOnce(async (draft: Conversation) => {
        markFirstHydrationStarted();
        await firstHydrationRelease;
        draft.messages = [{ id: 'old-message', role: 'assistant', content: 'Old session', timestamp: 1 }];
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
    expect(repository.getCachedConversation(conversation.id)?.messages).toEqual([]);
    await expect(repository.ensureHydrated(conversation.id)).resolves.toMatchObject({ id: conversation.id });
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('merges mixed metadata authority once in stable order and admits duplicate IDs once', async () => {
    const { repository, persistence } = createRepository();
    repository.replaceAll([]);
    const first = createConversation('first');
    const second = createConversation('second');
    const third = createConversation('third');
    const targets = new Map<string, 'device' | 'unscoped'>([
      ['first', 'unscoped'], ['second', 'device'], ['third', 'unscoped'],
    ]);
    const added = repository.mergeMetadataConversations([first, second, third, { ...first }], targets);
    expect(added).toEqual([first, second, third]);
    expect(repository.getAll().map(({ id }) => id)).toEqual(['first', 'second', 'third']);
    await repository.persistConversations(added);
    expect(persistence.saveMetadata.mock.calls.map(([, target]) => target)).toEqual(['unscoped', undefined, 'unscoped']);
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
    expect(repository.getCachedConversation('existing')).toEqual(existing);
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
    repository.discardUnresolvedMetadataShells([repository.getSync(shell.id)!]);
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
    expect(persistence.deleteCurrentMetadata).not.toHaveBeenCalled();
  });

  it('allows a discarded unresolved shell ID to be published again', () => {
    const shell = createConversation('temporarily-unresolved');
    const { repository } = createRepository(shell);

    repository.discardUnresolvedMetadataShells([repository.getSync(shell.id)!]);
    const replacement = createConversation(shell.id);
    const merged = repository.mergeMetadataConversations([replacement]);

    expect(merged).toEqual([replacement]);
    expect(repository.getCachedConversation(shell.id)).toEqual(replacement);
  });

  it('does not discard or invalidate a replacement object with the same conversation ID', async () => {
    const unresolvedShell = createConversation('replaced');
    const { repository, persistence } = createRepository(unresolvedShell);
    const staleSnapshot = repository.getSync(unresolvedShell.id)!;
    const replacement = createConversation(unresolvedShell.id);
    repository.replaceAll([replacement]);
    repository.registerExecutionBinding(replacement.id, 'replacement-binding', 2);

    repository.discardUnresolvedMetadataShells([staleSnapshot]);

    expect(repository.getCachedConversation(replacement.id)).toEqual(replacement);
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

it('does not require a metadata write to keep an unavailable selection', async () => {
  const conversation = createConversation('unavailable');
  conversation.selectedModel = 'claude-code/retired-model';
  conversation.providerState = {
    providerSessionId: 'provider-session-1',
    subagentData: {
      'agent-1': {
        id: 'agent-1',
        description: 'Preserved agent',
        isExpanded: false,
        status: 'completed',
        toolCalls: [],
      },
    },
  };
  const { repository, persistence } = createRepository(conversation);
  persistence.saveMetadata.mockRejectedValue(new Error('disk full'));
  await expect(repository.reconcileSelectedModels('claude')).resolves.toEqual([]);
  expect(repository.getSync(conversation.id)!.selectedModel).toBe('claude-code/retired-model');
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
  expect(repository.getSync(conversation.id)!.providerState).toEqual({
    providerSessionId: 'provider-session-1',
    subagentData: {
      'agent-1': {
        id: 'agent-1',
        description: 'Preserved agent',
        isExpanded: false,
        status: 'completed',
        toolCalls: [],
      },
    },
  });
});
