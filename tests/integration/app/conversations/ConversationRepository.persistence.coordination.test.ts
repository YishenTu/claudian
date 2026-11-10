import '@/providers';

import type { MockedFunction } from 'vitest';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import type { SessionMetadataReader } from '@/app/storage/SessionStorage';
import type { ProviderSessionSnapshot } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ChatMessage, Conversation } from '@/core/types';

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

interface MockPersistence extends ConversationPersistence {
  saveMetadata: MockedFunction<ConversationPersistence['saveMetadata']>;
  deleteCurrentMetadata: MockedFunction<ConversationPersistence['deleteCurrentMetadata']>;
  assignMetadataToDevice: MockedFunction<ConversationPersistence['assignMetadataToDevice']>;
}

function createPersistence(): MockPersistence {
  const metadataReader: SessionMetadataReader = {
    revalidate: vi.fn().mockResolvedValue([]),
    load: vi.fn(),
    scan: vi.fn(),
    loadMetadata: vi.fn(),
    scanMetadata: vi.fn(),
    listMetadata: vi.fn(),
  };
  return {
    metadataReader,
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
  };
}

function createRepository(
  conversation = createConversation(),
  persistence = createPersistence(),
) {
  const onConversationDeleted = vi.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted,
  });
  repository.replaceAll([conversation]);
  return { repository, persistence, onConversationDeleted };
}

function deferred<T = void>(): {
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
  return { promise, resolve, reject };
}

describe('ConversationRepository provider state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops malformed OpenCode-owned state without clobbering opaque fields', async () => {
    const conversation = createConversation();
    conversation.providerId = 'opencode';
    conversation.providerState = {
      databasePath: { malformed: true },
      futureResumeCursor: { token: 'opencode-cursor' },
    };
    const { repository, persistence } = createRepository(conversation);

    await repository.rename(conversation.id, 'Renamed');

    expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerState: {
          futureResumeCursor: { token: 'opencode-cursor' },
        },
      }),
    );
  });
});

describe('ConversationRepository persistence queue and binding fences', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists only the latest eligible snapshot revision at queued commit time', async () => {
    const conversation = {
      ...createConversation(),
      providerState: { retainedFutureField: 'preserve-me' },
    };
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);
    const revision1: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 1,
      providerSessionId: 'native-1',
      providerState: { cursor: 1 },
      status: 'executing',
    };
    const revision2: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 2,
      providerSessionId: 'native-2',
      providerState: { cursor: 2 },
      status: 'idle',
    };

    const blockingSave = repository.rename(conversation.id, 'Queued title');
    const first = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      revision1,
    );
    const second = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      revision2,
    );
    await Promise.resolve();
    barrier.resolve();

    await Promise.all([blockingSave, first, second]);

    const snapshots = persistence.saveMetadata.mock.calls
      .map(([metadata]) => metadata)
      .filter(({ sessionId }) => sessionId === 'native-2');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].providerState).toEqual({
      retainedFutureField: 'preserve-me',
      cursor: 2,
    });
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        ...revision1,
        providerStateDeletes: ['retainedFutureField'],
      },
    )).resolves.toBe(false);
    expect(repository.getSync(conversation.id)!.providerState).toEqual({
      retainedFutureField: 'preserve-me',
      cursor: 2,
    });
  });

  it('copies saved history once while isolating queued, persisted, and committed state', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: 'Delegate', timestamp: 1 },
      {
        id: 'assistant', role: 'assistant', content: '', timestamp: 2,
        toolCalls: [{
          id: 'agent', name: 'Agent', input: { description: 'Helper' }, status: 'completed',
          subagent: {
            id: 'agent', description: 'Helper', status: 'completed', result: 'Done',
            isExpanded: false, toolCalls: [],
          },
        }],
      },
    ];
    const blockingSave = repository.rename(conversation.id, 'Queued title');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const saving = repository.update(conversation.id, { messages });
    // The caller keeps mutating live chat state while the save waits in the queue.
    messages[1].toolCalls![0].subagent!.result = 'Changed while queued';
    messages.push({ id: 'late', role: 'user', content: 'Late', timestamp: 3 });
    barrier.resolve();
    await Promise.all([blockingSave, saving]);
    const historyCopies = clone.mock.calls.filter(([value]) => (
      (value as { messages?: unknown[] } | null)?.messages?.length
    ));
    clone.mockRestore();

    expect(historyCopies).toHaveLength(1);
    const saved = persistence.saveMetadata.mock.calls.at(-1)![0];
    expect(saved.providerState).toEqual({
      subagentData: { agent: expect.objectContaining({ status: 'completed', result: 'Done' }) },
    });
    messages[1].toolCalls![0].subagent!.result = 'Changed after commit';
    expect(saved.providerState).toMatchObject({ subagentData: { agent: { result: 'Done' } } });
    const committed = repository.getSync(conversation.id)!;
    expect(committed.messages.map(message => message.id)).toEqual(['user', 'assistant']);
    expect(committed.messages[1].toolCalls![0].subagent!.result).toBe('Done');

    // A later save replaces committed history without reaching the earlier persisted projection.
    await repository.update(conversation.id, { messages: [committed.messages[0]] });
    expect(saved.providerState).toMatchObject({ subagentData: { agent: { result: 'Done' } } });
    expect(persistence.saveMetadata.mock.calls.at(-1)![0].providerState).toBeUndefined();
  });

  it('rejects the wrong binding or generation and lets a released binding drain', async () => {
    const conversation = {
      ...createConversation(),
      providerState: { retainedFutureField: 'preserve-me' },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 3);
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 1,
      providerSessionId: 'native-1',
      status: 'idle',
    };
    const staleStateSnapshot: ProviderSessionSnapshot = {
      ...snapshot,
      providerStateDeletes: ['retainedFutureField'],
    };

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'other-binding',
      3,
      staleStateSnapshot,
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      2,
      staleStateSnapshot,
    )).resolves.toBe(false);

    const accepted = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      snapshot,
    );
    repository.releaseExecutionBinding(conversation.id, 'binding-1');
    await expect(accepted).resolves.toBe(true);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        ...snapshot,
        revision: 2,
        providerStateDeletes: ['retainedFutureField'],
      },
    )).resolves.toBe(false);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'native-1',
        providerState: { retainedFutureField: 'preserve-me' },
      }),
    );
  });

  it('applies duplicate and absent state deletions before updates while preserving unknown fields', async () => {
    const conversation = {
      ...createConversation(),
      providerState: {
        consumedSeed: 'pending-fork',
        replaced: 'old-value',
        retainedFutureField: { nested: true },
      },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 3);

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        providerId: 'claude',
        revision: 1,
        providerStateDeletes: [
          'consumedSeed',
          'absentKey',
          'consumedSeed',
          'replaced',
        ],
        providerState: {
          cursor: 2,
          replaced: 'new-value',
        },
        status: 'idle',
      },
    )).resolves.toBe(true);

    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        providerState: {
          retainedFutureField: { nested: true },
          cursor: 2,
          replaced: 'new-value',
        },
      }),
    );
    expect(repository.getSync(conversation.id)!.providerState).toEqual({
      retainedFutureField: { nested: true },
      cursor: 2,
      replaced: 'new-value',
    });
  });

  it('persists consumed seed deletion before later invalidation clears session state', async () => {
    const conversation = {
      ...createConversation(),
      providerState: {
        consumedSeed: { source: 'checkpoint' },
        retainedFutureField: 'preserve-me',
      },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 3);

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'native-after-seed',
        providerStateDeletes: ['consumedSeed'],
        providerState: { activeCursor: 'cursor-1' },
        status: 'idle',
      },
    )).resolves.toBe(true);

    expect(persistence.saveMetadata).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'native-after-seed',
        providerState: {
          retainedFutureField: 'preserve-me',
          activeCursor: 'cursor-1',
        },
      }),
    );

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        providerId: 'claude',
        revision: 2,
        providerStateDeletes: ['activeCursor'],
        status: 'invalidated',
        invalidation: {
          reason: 'provider-session-missing',
          recoverable: true,
        },
      },
    )).resolves.toBe(true);

    expect(persistence.saveMetadata).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: null,
        providerState: {
          retainedFutureField: 'preserve-me',
        },
      }),
    );
    expect(repository.getSync(conversation.id)).toMatchObject({
      sessionId: null,
      providerState: {
        retainedFutureField: 'preserve-me',
      },
    });
  });

  it('canonicalizes provider state to absent when a snapshot consumes its final key', async () => {
    const conversation = {
      ...createConversation(),
      providerState: { consumedSeed: 'pending-fork' },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 3);

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        providerId: 'claude',
        revision: 1,
        providerStateDeletes: ['consumedSeed'],
        status: 'idle',
      },
    )).resolves.toBe(true);

    expect(repository.getSync(conversation.id)!.providerState).toBeUndefined();
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.not.objectContaining({ providerState: expect.anything() }),
    );
  });

  it('supersedes queued snapshots when a newer binding is registered', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'old-binding', 1);
    const blockingSave = repository.rename(conversation.id, 'Block');
    const stale = repository.persistExecutionSnapshot(
      conversation.id,
      'old-binding',
      1,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'stale-native',
        status: 'idle',
      },
    );
    repository.releaseExecutionBinding(conversation.id, 'old-binding');
    repository.registerExecutionBinding(conversation.id, 'new-binding', 2);
    barrier.resolve();

    await Promise.all([blockingSave, stale]);

    expect(persistence.saveMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'stale-native' }),
    );
  });

});

describe('ConversationRepository deletion persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the exact live binding and replays the newest snapshot after removal failure', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const removal = deferred<void>();
    persistence.deleteCurrentMetadata.mockReturnValue(removal.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledTimes(1);

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'superseded-during-delete',
        status: 'executing',
      },
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 2,
        providerSessionId: 'native-during-delete',
        providerState: { cursor: 2 },
        status: 'idle',
      },
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      5,
      {
        providerId: 'claude',
        revision: 3,
        providerSessionId: 'wrong-generation-during-delete',
        status: 'idle',
      },
    )).resolves.toBe(false);
    removal.reject(new Error('removal failed'));

    await expect(deletion).rejects.toThrow('removal failed');
    expect(repository.getCachedConversation(conversation.id)).toMatchObject({ id: conversation.id });
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'native-during-delete',
        providerState: { cursor: 2 },
      }),
    );
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 3,
        providerSessionId: 'native-after-rollback',
        status: 'idle',
      },
    )).resolves.toBe(true);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      5,
      {
        providerId: 'claude',
        revision: 4,
        providerSessionId: 'wrong-generation',
        status: 'idle',
      },
    )).resolves.toBe(false);
  });

  it('does not replay a transient-deletion snapshot over a replacement binding', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const removal = deferred<void>();
    persistence.deleteCurrentMetadata.mockReturnValue(removal.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'old-binding', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    await repository.persistExecutionSnapshot(
      conversation.id,
      'old-binding',
      4,
      {
        providerId: 'claude',
        revision: 2,
        providerSessionId: 'obsolete-native',
        status: 'idle',
      },
    );
    const failedDeletion = deletion.catch((error: unknown) => error);
    removal.reject(new Error('removal failed'));
    for (let attempt = 0; attempt < 20 && !repository.getCachedConversation(conversation.id); attempt++) {
      await Promise.resolve();
    }
    repository.releaseExecutionBinding(conversation.id, 'old-binding');
    repository.registerExecutionBinding(conversation.id, 'new-binding', 5);

    expect(await failedDeletion).toEqual(new Error('removal failed'));
    expect(persistence.saveMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'obsolete-native' }),
    );
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'new-binding',
      5,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'replacement-native',
        status: 'idle',
      },
    )).resolves.toBe(true);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'replacement-native' }),
    );
  });

  it('does not replay a transient-deletion snapshot after its binding is released', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const removal = deferred<void>();
    persistence.deleteCurrentMetadata.mockReturnValue(removal.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    await repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 2,
        providerSessionId: 'released-native',
        status: 'idle',
      },
    );
    repository.releaseExecutionBinding(conversation.id, 'binding-1');
    removal.reject(new Error('removal failed'));

    await expect(deletion).rejects.toThrow('removal failed');
    expect(persistence.saveMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'released-native' }),
    );
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 3,
        providerSessionId: 'released-native-later',
        status: 'idle',
      },
    )).resolves.toBe(false);
  });

  it('keeps a racing snapshot fenced when the deletion removal succeeds', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const removal = deferred<void>();
    persistence.deleteCurrentMetadata.mockReturnValue(removal.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 2,
        providerSessionId: 'must-stay-deleted',
        status: 'idle',
      },
    )).resolves.toBe(false);
    removal.resolve();

    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(persistence.saveMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'must-stay-deleted' }),
    );
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'claude',
        revision: 3,
        providerSessionId: 'must-stay-deleted-later',
        status: 'idle',
      },
    )).resolves.toBe(false);
  });

  it('retries the UI association callback and cleanup after a post-removal callback failure', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const calls: string[] = [];
    persistence.deleteCurrentMetadata.mockImplementation(async () => {
      calls.push('current');
    });
    const { repository, onConversationDeleted } = createRepository(
      conversation,
      persistence,
    );
    onConversationDeleted
      .mockImplementationOnce(async () => {
        calls.push('callback');
        throw new Error('tab cleanup failed');
      })
      .mockImplementation(async () => {
        calls.push('callback');
      });

    await expect(repository.delete(conversation.id)).rejects.toThrow(
      'tab cleanup failed',
    );

    expect(calls).toEqual(['current', 'callback']);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ])).toEqual([]);

    await repository.retryDeletedConversationCleanup(conversation.id);

    expect(calls).toEqual(['current', 'callback', 'callback']);
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledTimes(1);
    expect(onConversationDeleted).toHaveBeenCalledTimes(2);
  });

  it('fences a late snapshot and queued save so deletion cannot recreate metadata', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding', 1);
    const firstSave = repository.rename(conversation.id, 'In flight');
    const snapshot = repository.persistExecutionSnapshot(
      conversation.id,
      'binding',
      1,
      {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'late-native',
        status: 'idle',
      },
    );
    const deletion = repository.delete(conversation.id);
    barrier.resolve();

    await Promise.all([firstSave, snapshot, deletion]);

    const removalCall = persistence.deleteCurrentMetadata.mock.invocationCallOrder[0];
    const laterMetadataWrite = persistence.saveMetadata.mock.invocationCallOrder
      .find((order) => order > removalCall);
    expect(laterMetadataWrite).toBeUndefined();
  });

  it('fences metadata normalization before removing metadata', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);

    const started = deferred<void>();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      started.resolve();
      await barrier.promise;
    });
    const migration = repository.adoptMetadataConversations([
      { conversation, needsMigration: true, source: 'unscoped' },
    ]);
    await started.promise;
    const deletion = repository.delete(conversation.id);
    barrier.resolve();
    await Promise.all([migration, deletion]);

    const removalOrder = persistence.deleteCurrentMetadata.mock.invocationCallOrder[0];
    expect(
      persistence.saveMetadata.mock.invocationCallOrder.some(
        (order) => order > removalOrder,
      ),
    ).toBe(false);
    expect(
      persistence.saveMetadata.mock.invocationCallOrder.some(
        (order) => order < removalOrder,
      ),
    ).toBe(true);
  });

  it('restores the conversation for retry when current metadata removal fails', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    persistence.deleteCurrentMetadata.mockRejectedValueOnce(new Error('deleteCurrentMetadata failed'));
    const { repository, onConversationDeleted } = createRepository(conversation, persistence);

    await expect(repository.delete(conversation.id)).rejects.toThrow(
      'deleteCurrentMetadata failed',
    );
    expect(repository.getCachedConversation(conversation.id)).toMatchObject({ id: conversation.id });
    expect(onConversationDeleted).not.toHaveBeenCalled();

    await repository.delete(conversation.id);
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledTimes(2);
  });
});
