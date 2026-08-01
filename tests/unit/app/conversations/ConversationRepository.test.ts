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
    updatedAt: 1,
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
    added.updatedAt = 2;

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
