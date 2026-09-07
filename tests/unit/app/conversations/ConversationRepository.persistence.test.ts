import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import {
  computeConversationInputDigest,
  CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
  type ConversationInputLedger,
  type ConversationInputLedgerReadResult,
  type ConversationInputRecord,
} from '@/core/bootstrap/ConversationInputLedgerStorage';
import type { ConversationPersistence } from '@/core/bootstrap/ConversationPersistenceStore';
import type { SessionMetadataReader } from '@/core/bootstrap/SessionStorage';
import type { ProviderSessionSnapshot } from '@/core/execution';
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

function createInputRecord(
  overrides: Partial<ConversationInputRecord> = {},
): ConversationInputRecord {
  const rawDisplayText = overrides.rawDisplayText ?? 'Hello';
  const images = overrides.images ?? [];
  return {
    schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
    id: 'input-1',
    userTurnOrdinal: 1,
    state: 'staged',
    timestamp: 10,
    rawDisplayText,
    canonicalText: overrides.canonicalText ?? rawDisplayText,
    images,
    contentDigest: computeConversationInputDigest({
      visibleText: rawDisplayText,
      images,
    }),
    ...overrides,
  };
}

function createLedger(
  conversationId: string,
  records: ConversationInputRecord[] = [],
): ConversationInputLedger {
  return {
    schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
    conversationId,
    records,
  };
}

interface MockPersistence extends ConversationPersistence {
  loadInputLedger: jest.MockedFunction<ConversationPersistence['loadInputLedger']>;
  saveInputLedger: jest.MockedFunction<ConversationPersistence['saveInputLedger']>;
  saveMetadata: jest.MockedFunction<ConversationPersistence['saveMetadata']>;
  deleteCurrentMetadata: jest.MockedFunction<
    ConversationPersistence['deleteCurrentMetadata']
  >;
  deleteLegacyMetadata: jest.MockedFunction<
    ConversationPersistence['deleteLegacyMetadata']
  >;
  deleteInputLedger: jest.MockedFunction<
    ConversationPersistence['deleteInputLedger']
  >;
  assignMetadataToDevice: jest.MockedFunction<
    ConversationPersistence['assignMetadataToDevice']
  >;
  isDeleted: jest.MockedFunction<ConversationPersistence['isDeleted']>;
  assertMetadataWriteAuthority: jest.MockedFunction<
    ConversationPersistence['assertMetadataWriteAuthority']
  >;
  markDeleted: jest.MockedFunction<ConversationPersistence['markDeleted']>;
}

function createPersistence(
  ledgerResult: ConversationInputLedgerReadResult = { status: 'missing' },
): MockPersistence {
  const metadataReader: SessionMetadataReader = {
    load: jest.fn(),
    scan: jest.fn(),
    loadMetadata: jest.fn(),
    scanMetadata: jest.fn(),
    listMetadata: jest.fn(),
  };
  return {
    metadataReader,
    loadInputLedger: jest.fn().mockResolvedValue(ledgerResult),
    saveInputLedger: jest.fn().mockResolvedValue(undefined),
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    deleteLegacyMetadata: jest.fn().mockResolvedValue(undefined),
    deleteInputLedger: jest.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
    isDeleted: jest.fn().mockResolvedValue(false),
    assertMetadataWriteAuthority: jest.fn().mockResolvedValue(undefined),
    markDeleted: jest.fn().mockResolvedValue(undefined),
  };
}

function createRepository(
  conversation = createConversation(),
  persistence = createPersistence(),
) {
  const onConversationDeleted = jest.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
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

describe('ConversationRepository input ledger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the ledger only after native history hydration and correlates canonical input', async () => {
    const conversation = createConversation();
    const image = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png' as const,
      data: 'aW1hZ2U=',
      size: 5,
      source: 'paste' as const,
    };
    const record = createInputRecord({
      state: 'accepted',
      providerUserMessageId: 'native-user-1',
      canonicalText: 'Canonical input',
      rawDisplayText: '/command',
      context: {
        linkedContent: { path: 'Notes/current.md' },
      },
      images: [image],
      contentDigest: computeConversationInputDigest({
        visibleText: '/command',
        images: [image],
      }),
    });
    const persistence = createPersistence({
      status: 'loaded',
      ledger: createLedger(conversation.id, [record]),
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [{
          id: 'history-user',
          role: 'user',
          content: 'Provider-formatted prompt',
          timestamp: 10,
          userMessageId: 'native-user-1',
        }];
      },
    } as any);

    expect(persistence.loadInputLedger).not.toHaveBeenCalled();
    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(persistence.loadInputLedger).not.toHaveBeenCalled();

    await repository.ensureHydrated(conversation.id);

    expect(persistence.loadInputLedger).toHaveBeenCalledTimes(1);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Provider-formatted prompt',
      displayContent: '/command',
      images: [image],
      executionInput: {
        schemaVersion: 1,
        canonicalText: 'Canonical input',
        context: {
          linkedContent: { path: 'Notes/current.md' },
        },
      },
    });
  });

  it('defers legacy ledger writeback until the next ordered ledger mutation', async () => {
    const conversation = createConversation('legacy-ledger');
    const migratedRecord = createInputRecord({
      id: 'migrated-input',
      state: 'accepted',
      context: {
        linkedContent: { path: 'Notes/Legacy.md' },
      },
    });
    const persistence = createPersistence({
      status: 'loaded',
      ledger: createLedger(conversation.id, [migratedRecord]),
      needsMigration: true,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn().mockResolvedValue(undefined),
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(persistence.saveInputLedger).not.toHaveBeenCalled();

    await repository.stageConversationInput(
      conversation.id,
      createInputRecord({ id: 'next-input' }),
    );

    expect(persistence.saveInputLedger).toHaveBeenCalledTimes(1);
    const persistedLedger = persistence.saveInputLedger.mock.calls[0][1];
    expect(persistedLedger.records[0].context).toEqual({
      linkedContent: { path: 'Notes/Legacy.md' },
    });
    expect(JSON.stringify(persistedLedger)).not.toContain('currentNote');
  });

  it('prefers a unique provider user-message ID, then requires ordinal and digest together', async () => {
    const conversation = createConversation();
    const records = [
      createInputRecord({
        id: 'by-provider-id',
        state: 'accepted',
        providerUserMessageId: 'native-1',
        rawDisplayText: 'Stored first',
        canonicalText: 'Canonical first',
        contentDigest: computeConversationInputDigest({
          visibleText: 'different digest is ignored for provider identity',
          images: [],
        }),
      }),
      createInputRecord({
        id: 'by-ordinal-digest',
        userTurnOrdinal: 2,
        state: 'accepted',
        rawDisplayText: 'Second',
        canonicalText: 'Canonical second',
        contentDigest: computeConversationInputDigest({
          visibleText: 'Second',
          images: [],
        }),
      }),
      createInputRecord({
        id: 'ordinal-only-mismatch',
        userTurnOrdinal: 3,
        state: 'accepted',
        rawDisplayText: 'Not third',
        canonicalText: 'Must not apply',
        contentDigest: computeConversationInputDigest({
          visibleText: 'Not third',
          images: [],
        }),
      }),
    ];
    const persistence = createPersistence({
      status: 'loaded',
      ledger: createLedger(conversation.id, records),
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [
          {
            id: 'message-1',
            role: 'user',
            content: 'Provider first',
            timestamp: 1,
            userMessageId: 'native-1',
          },
          {
            id: 'message-2',
            role: 'user',
            content: 'Second',
            timestamp: 2,
          },
          {
            id: 'message-3',
            role: 'user',
            content: 'Third',
            timestamp: 3,
          },
        ];
      },
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(conversation.messages[0].executionInput?.canonicalText).toBe(
      'Canonical first',
    );
    expect(conversation.messages[1].executionInput?.canonicalText).toBe(
      'Canonical second',
    );
    expect(conversation.messages[2].executionInput).toBeUndefined();
  });

  it('does not apply ambiguous provider identities', async () => {
    const conversation = createConversation();
    const records = [
      createInputRecord({
        id: 'duplicate-1',
        state: 'accepted',
        providerUserMessageId: 'native-1',
      }),
      createInputRecord({
        id: 'duplicate-2',
        state: 'accepted',
        providerUserMessageId: 'native-1',
      }),
    ];
    const persistence = createPersistence({
      status: 'loaded',
      ledger: createLedger(conversation.id, records),
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [{
          id: 'message-1',
          role: 'user',
          content: 'Hello',
          timestamp: 1,
          userMessageId: 'native-1',
        }];
      },
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(conversation.messages[0].executionInput).toBeUndefined();
  });

  it('promotes a matched staged record and retains an unmatched staged record', async () => {
    const conversation = createConversation();
    const matched = createInputRecord({
      id: 'matched',
      state: 'staged',
      providerUserMessageId: 'native-1',
    });
    const unmatched = createInputRecord({
      id: 'unmatched',
      userTurnOrdinal: 2,
      state: 'staged',
      rawDisplayText: 'Never confirmed',
      contentDigest: computeConversationInputDigest({
        visibleText: 'Never confirmed',
        images: [],
      }),
    });
    const ledger = createLedger(conversation.id, [matched, unmatched]);
    const persistence = createPersistence({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [{
          id: 'message-1',
          role: 'user',
          content: 'Hello',
          timestamp: 1,
          userMessageId: 'native-1',
        }];
      },
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(ledger.records.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'matched', state: 'accepted' },
      { id: 'unmatched', state: 'staged' },
    ]);
    expect(persistence.saveInputLedger).toHaveBeenCalledWith(
      conversation.id,
      ledger,
    );
    expect(conversation.lastActivityAt).toBe(matched.timestamp);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      lastActivityAt: matched.timestamp,
    }));
  });

  it('repairs activity from a matched accepted record during hydration', async () => {
    const conversation = createConversation();
    const accepted = createInputRecord({
      id: 'accepted',
      state: 'accepted',
      providerUserMessageId: 'native-1',
      timestamp: 50,
    });
    const ledger = createLedger(conversation.id, [accepted]);
    const persistence = createPersistence({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [{
          id: 'message-1',
          role: 'user',
          content: 'Hello',
          timestamp: 50,
          userMessageId: 'native-1',
        }];
      },
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(conversation.lastActivityAt).toBe(accepted.timestamp);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      lastActivityAt: accepted.timestamp,
    }));
  });

  it('keeps checkpoint correlation within canonical user-turn boundaries', async () => {
    const conversation = createConversation();
    const records = [
      createInputRecord({
        id: 'input-a',
        state: 'accepted',
        rawDisplayText: 'Turn A',
        canonicalText: 'Turn A',
        contentDigest: computeConversationInputDigest({
          visibleText: 'Turn A',
          images: [],
        }),
      }),
      createInputRecord({
        id: 'input-b',
        state: 'accepted',
        userTurnOrdinal: 2,
        rawDisplayText: 'Turn B',
        canonicalText: 'Turn B',
        contentDigest: computeConversationInputDigest({
          visibleText: 'Turn B',
          images: [],
        }),
      }),
    ];
    const ledger = createLedger(conversation.id, records);
    const persistence = createPersistence({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [
          {
            id: 'user-a',
            role: 'user',
            content: 'Turn A',
            timestamp: 1,
          },
          {
            id: 'interrupt',
            role: 'user',
            content: 'Interrupted',
            isInterrupt: true,
            timestamp: 2,
          },
          {
            id: 'rebuilt',
            role: 'user',
            content: 'Rebuilt context',
            isRebuiltContext: true,
            timestamp: 3,
          },
          {
            id: 'user-b',
            role: 'user',
            content: 'Turn B',
            timestamp: 4,
          },
          {
            assistantMessageId: 'checkpoint-b',
            content: 'Response B',
            id: 'assistant-b',
            role: 'assistant',
            timestamp: 5,
          },
        ];
      },
    } as any);

    await repository.ensureHydrated(conversation.id);

    expect(records[0].providerAssistantMessageId).toBeUndefined();
    expect(records[1].providerAssistantMessageId).toBe('checkpoint-b');
    expect(conversation.messages[0].executionInput?.canonicalText).toBe('Turn A');
    expect(conversation.messages[3].executionInput?.canonicalText).toBe('Turn B');
  });

  it('keeps malformed ledger state unavailable while metadata persistence continues', async () => {
    const conversation = createConversation();
    conversation.messages = [{
      id: 'existing',
      role: 'user',
      content: 'Existing',
      timestamp: 1,
    }];
    const persistence = createPersistence({
      status: 'unavailable',
      reason: 'malformed',
    });
    const { repository } = createRepository(conversation, persistence);

    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(
      conversation,
    );
    await expect(
      repository.stageConversationInput(
        conversation.id,
        createInputRecord(),
      ),
    ).rejects.toThrow('Conversation input ledger is unavailable');
    await repository.rename(conversation.id, 'Still saved');
    expect(persistence.saveInputLedger).not.toHaveBeenCalled();
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Still saved' }),
    );
  });

  it.each([
    ['grok', { sessionDirectory: '/tmp/grok-session' }],
    ['opencode', { databasePath: '/tmp/opencode.db' }],
    ['pi', { sessionFile: '/tmp/pi-session.jsonl', sessionId: 'pi-session' }],
  ] as const)(
    'preserves unknown %s provider state during ordinary metadata saves',
    async (providerId, providerState) => {
      const conversation = createConversation();
      conversation.providerId = providerId;
      conversation.providerState = {
        ...providerState,
        futureResumeCursor: { token: `${providerId}-cursor` },
      };
      const { repository, persistence } = createRepository(conversation);

      await repository.rename(conversation.id, 'Renamed');

      expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerState: expect.objectContaining({
            futureResumeCursor: { token: `${providerId}-cursor` },
          }),
        }),
      );
    },
  );

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

  it('durably stages, accepts, and discards inputs without duplicate records', async () => {
    const conversation = createConversation();
    const { repository, persistence } = createRepository(conversation);
    const record = createInputRecord({ localMessageId: 'local-1' });

    await repository.stageConversationInput(conversation.id, record);
    await repository.stageConversationInput(conversation.id, record);
    await repository.acceptConversationInput(conversation.id, record.id, {
      providerUserMessageId: 'native-user',
      providerAssistantMessageId: 'native-assistant',
    });
    let ledger = await repository.getConversationInputLedger(conversation.id);

    expect(ledger?.records).toEqual([
      expect.objectContaining({
        id: record.id,
        state: 'accepted',
        providerUserMessageId: 'native-user',
        providerAssistantMessageId: 'native-assistant',
      }),
    ]);
    expect(conversation.lastActivityAt).toBe(record.timestamp);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      lastActivityAt: record.timestamp,
    }));
    expect(persistence.saveInputLedger).toHaveBeenCalledTimes(3);

    const second = createInputRecord({ id: 'input-2', userTurnOrdinal: 2 });
    await repository.stageConversationInput(conversation.id, second);
    await repository.discardStagedConversationInput(conversation.id, second.id);
    ledger = await repository.getConversationInputLedger(conversation.id);
    expect(ledger?.records.map(({ id }) => id)).toEqual([record.id]);
  });

  it('rolls back only a newly inserted record when its initial stage write fails', async () => {
    const conversation = createConversation();
    const existing = createInputRecord({
      id: 'existing-input',
      state: 'staged',
      localMessageId: 'existing-local',
    });
    const ledger = createLedger(conversation.id, [existing]);
    const persistence = createPersistence({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);

    persistence.saveInputLedger.mockRejectedValueOnce(
      new Error('acceptance write failed'),
    );
    await expect(repository.acceptConversationInput(
      conversation.id,
      existing.id,
    )).rejects.toThrow('acceptance write failed');

    const unsent = createInputRecord({
      id: 'unsent-input',
      localMessageId: 'unsent-local',
    });
    persistence.saveInputLedger.mockRejectedValueOnce(
      new Error('initial stage failed'),
    );
    await expect(repository.stageConversationInput(
      conversation.id,
      unsent,
    )).rejects.toThrow('initial stage failed');

    expect(await repository.getConversationInputLedger(conversation.id)).toEqual(
      expect.objectContaining({
        records: [expect.objectContaining({
          id: existing.id,
          state: 'accepted',
        })],
      }),
    );

    await repository.acceptConversationInput(conversation.id, existing.id);
    expect(persistence.saveInputLedger).toHaveBeenLastCalledWith(
      conversation.id,
      expect.objectContaining({
        records: [expect.objectContaining({
          id: existing.id,
          state: 'accepted',
        })],
      }),
    );
  });

  it('re-evaluates a concurrent idempotent stage after the first insertion rolls back', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    const record = createInputRecord({ localMessageId: 'local-1' });
    persistence.saveInputLedger.mockRejectedValueOnce(
      new Error('first stage failed'),
    );

    const firstStage = repository.stageConversationInput(
      conversation.id,
      record,
    );
    const secondStage = repository.stageConversationInput(
      conversation.id,
      record,
    );

    await expect(firstStage).rejects.toThrow('first stage failed');
    await expect(secondStage).resolves.toBeUndefined();
    expect(persistence.saveInputLedger).toHaveBeenCalledTimes(2);
    expect((await repository.getConversationInputLedger(conversation.id))?.records)
      .toEqual([expect.objectContaining({
        id: record.id,
        localMessageId: record.localMessageId,
        state: 'staged',
      })]);
  });

  it('rejects initial staging when a durable deletion wins while ledger loading is held', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const ledgerLoad = deferred<ConversationInputLedgerReadResult>();
    persistence.loadInputLedger.mockReturnValue(ledgerLoad.promise);
    const { repository } = createRepository(conversation, persistence);
    const stage = repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    const stageResult = stage.then(
      () => null,
      (error: unknown) => error,
    );

    await repository.delete(conversation.id);
    ledgerLoad.resolve({ status: 'missing' });

    expect(await stageResult).toMatchObject({
      name: 'ConversationInputStageRejectedError',
      conversationId: conversation.id,
    });
    expect(persistence.saveInputLedger).not.toHaveBeenCalled();
    expect(persistence.deleteInputLedger).toHaveBeenCalledWith(conversation.id);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('durably stages after a held ledger load when deletion-marker creation rolls back', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const ledgerLoad = deferred<ConversationInputLedgerReadResult>();
    const marker = deferred<void>();
    persistence.loadInputLedger.mockReturnValue(ledgerLoad.promise);
    persistence.markDeleted.mockReturnValue(marker.promise);
    const { repository } = createRepository(conversation, persistence);
    const record = createInputRecord({ localMessageId: 'restored-local' });

    const stage = repository.stageConversationInput(conversation.id, record);
    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.markDeleted).toHaveBeenCalledTimes(1);

    ledgerLoad.resolve({ status: 'missing' });
    marker.reject(new Error('marker failed'));

    await expect(deletion).rejects.toThrow('marker failed');
    await expect(stage).resolves.toBeUndefined();
    expect(persistence.saveInputLedger).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({
        records: [expect.objectContaining({ id: record.id })],
      }),
    );
  });

  it('rejects staging when deletion begins during the durable-marker check', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const deletionCheckStarted = deferred<void>();
    const deletionCheck = deferred<boolean>();
    persistence.isDeleted.mockImplementationOnce(async () => {
      deletionCheckStarted.resolve();
      return deletionCheck.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    const stage = repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    const stageResult = stage.then(
      () => null,
      (error: unknown) => error,
    );
    await deletionCheckStarted.promise;

    const deletion = repository.delete(conversation.id);
    deletionCheck.resolve(false);

    expect(await stageResult).toMatchObject({
      name: 'ConversationInputStageRejectedError',
      conversationId: conversation.id,
    });
    await deletion;
    expect(persistence.saveInputLedger).not.toHaveBeenCalled();
  });

  it('rejects staging when its loaded ledger is stale at queued commit time', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const metadataWriteStarted = deferred<void>();
    const metadataWrite = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      metadataWriteStarted.resolve();
      return metadataWrite.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    const blockingSave = repository.rename(conversation.id, 'Blocking save');
    await metadataWriteStarted.promise;

    const stage = repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    const stageResult = stage.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    await Promise.resolve();
    repository.replaceAll([conversation]);
    metadataWrite.resolve();

    await blockingSave;
    expect(await stageResult).toMatchObject({
      name: 'ConversationInputStageRejectedError',
      conversationId: conversation.id,
    });
    expect(persistence.saveInputLedger).not.toHaveBeenCalled();
  });

  it('keeps a stage that owns the FIFO durable before later deletion cleanup', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const ledgerWriteStarted = deferred<void>();
    const ledgerWrite = deferred<void>();
    const calls: string[] = [];
    persistence.saveInputLedger.mockImplementationOnce(async () => {
      calls.push('ledger');
      ledgerWriteStarted.resolve();
      await ledgerWrite.promise;
    });
    persistence.markDeleted.mockImplementation(async () => {
      calls.push('marker');
    });
    const { repository } = createRepository(conversation, persistence);

    const stage = repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    await ledgerWriteStarted.promise;
    const deletion = repository.delete(conversation.id);
    ledgerWrite.resolve();

    await expect(stage).resolves.toBeUndefined();
    await deletion;
    expect(calls).toEqual(['ledger', 'marker']);
  });

  it('keeps a failed first stage out of retry correlation and fork copies', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    let durableLedger = createLedger(conversation.id);
    persistence.saveInputLedger.mockImplementation(async (_id, ledger) => {
      durableLedger = JSON.parse(JSON.stringify(ledger)) as ConversationInputLedger;
    });
    persistence.saveInputLedger.mockRejectedValueOnce(
      new Error('initial stage failed'),
    );
    const { repository } = createRepository(conversation, persistence);
    const image = {
      id: 'retry-image',
      name: 'retry.png',
      mediaType: 'image/png' as const,
      data: 'cmV0cnk=',
      size: 5,
      source: 'paste' as const,
    };
    const failedInput = createInputRecord({
      id: 'failed-input',
      localMessageId: 'failed-local-message',
      rawDisplayText: '/retry',
      canonicalText: 'Failed canonical input',
      context: { linkedContent: { path: 'Notes/failed.md' } },
      images: [image],
      contentDigest: computeConversationInputDigest({
        visibleText: '/retry',
        images: [image],
      }),
    });
    const retryInput = createInputRecord({
      id: 'retry-input',
      localMessageId: 'retry-local-message',
      rawDisplayText: '/retry',
      canonicalText: 'Retry canonical input',
      context: { linkedContent: { path: 'Notes/retry.md' } },
      images: [image],
      contentDigest: failedInput.contentDigest,
    });

    await expect(repository.stageConversationInput(
      conversation.id,
      failedInput,
    )).rejects.toThrow('initial stage failed');
    await repository.stageConversationInput(conversation.id, retryInput);
    await repository.acceptConversationInput(conversation.id, retryInput.id, {
      providerAssistantMessageId: 'retry-checkpoint',
    });

    expect(durableLedger?.records).toEqual([
      expect.objectContaining({
        id: retryInput.id,
        localMessageId: retryInput.localMessageId,
        state: 'accepted',
      }),
    ]);
    expect(durableLedger?.records[0].providerUserMessageId).toBeUndefined();

    const coldConversation = createConversation(conversation.id);
    const coldPersistence = createPersistence({
      status: 'loaded',
      ledger: JSON.parse(JSON.stringify(durableLedger)) as ConversationInputLedger,
      needsMigration: false,
    });
    const { repository: coldRepository } = createRepository(
      coldConversation,
      coldPersistence,
    );
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: async (target: Conversation) => {
        target.messages = [
          {
            id: 'native-user-without-id',
            role: 'user',
            content: '/retry',
            timestamp: 20,
            images: [image],
          },
          {
            id: 'native-assistant',
            role: 'assistant',
            content: 'Done',
            timestamp: 21,
            assistantMessageId: 'retry-checkpoint',
          },
        ];
      },
    } as any);

    await coldRepository.ensureHydrated(coldConversation.id);

    expect(coldConversation.messages[0]).toMatchObject({
      displayContent: '/retry',
      images: [image],
      executionInput: {
        schemaVersion: 1,
        canonicalText: 'Retry canonical input',
        context: { linkedContent: { path: 'Notes/retry.md' } },
      },
    });

    const fork = createConversation('fork');
    coldRepository.mergeMetadataConversations([fork]);
    await coldRepository.copyConversationInputsForFork(
      coldConversation.id,
      fork.id,
      'retry-checkpoint',
    );
    expect((await coldRepository.getConversationInputLedger(fork.id))?.records)
      .toEqual([
        expect.objectContaining({
          id: retryInput.id,
          localMessageId: retryInput.localMessageId,
          state: 'accepted',
        }),
      ]);
  });

  it('writes ledger before metadata and leaves a failed ledger mutation dirty for retry', async () => {
    const conversation = createConversation();
    const { repository, persistence } = createRepository(conversation);
    const record = createInputRecord({ localMessageId: 'local-1' });
    await repository.stageConversationInput(conversation.id, record);
    persistence.saveInputLedger.mockClear();
    persistence.saveMetadata.mockClear();
    persistence.saveInputLedger.mockRejectedValueOnce(new Error('ledger full'));

    await expect(
      repository.acceptConversationInput(conversation.id, record.id),
    ).rejects.toThrow('ledger full');
    expect(persistence.saveMetadata).not.toHaveBeenCalled();
    expect(
      (await repository.getConversationInputLedger(conversation.id))
        ?.records[0].state,
    ).toBe('accepted');

    await repository.acceptConversationInput(conversation.id, record.id);
    expect(persistence.saveInputLedger).toHaveBeenCalledTimes(2);
    expect(persistence.saveMetadata).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted ledger durable when metadata fails and permits a later metadata-only save', async () => {
    const conversation = createConversation();
    const { repository, persistence } = createRepository(conversation);
    const record = createInputRecord();
    await repository.stageConversationInput(conversation.id, record);
    persistence.saveMetadata.mockRejectedValueOnce(new Error('metadata full'));

    await expect(
      repository.acceptConversationInput(conversation.id, record.id),
    ).rejects.toThrow('metadata full');
    expect(persistence.saveInputLedger).toHaveBeenLastCalledWith(
      conversation.id,
      expect.objectContaining({
        records: [expect.objectContaining({ state: 'accepted' })],
      }),
    );

    await repository.rename(conversation.id, 'Metadata retry');
    expect(persistence.saveMetadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Metadata retry' }),
    );
  });
});

describe('ConversationRepository persistence queue and binding fences', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
    expect(conversation.providerState).toEqual({
      retainedFutureField: 'preserve-me',
      cursor: 2,
    });
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
    expect(conversation.providerState).toEqual({
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
    expect(conversation).toMatchObject({
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

    expect(conversation.providerState).toBeUndefined();
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
    repository.registerExecutionBinding(conversation.id, 'new-binding', 2);
    barrier.resolve();

    await Promise.all([blockingSave, stale]);

    expect(persistence.saveMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'stale-native' }),
    );
  });

  it('migrates very old metadata into the unscoped namespace', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const calls: string[] = [];
    persistence.saveMetadata.mockImplementation(async (_metadata, target) => {
      calls.push(`save:${target}`);
    });
    persistence.deleteLegacyMetadata.mockImplementation(async () => {
      calls.push('delete-legacy');
    });
    const { repository } = createRepository(conversation, persistence);

    await repository.adoptMetadataConversations([
      { conversation, needsMigration: false, source: 'legacy' },
    ]);

    expect(calls).toEqual(['save:unscoped', 'delete-legacy']);
  });

  it('keeps unscoped metadata writable without assigning it to the device', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);

    await repository.adoptMetadataConversations([
      { conversation, needsMigration: false, source: 'unscoped' },
    ]);
    persistence.saveMetadata.mockClear();

    await repository.rename(conversation.id, 'Still unscoped');

    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversation.id, title: 'Still unscoped' }),
      'unscoped',
    );
    expect(persistence.assignMetadataToDevice).not.toHaveBeenCalled();
    expect(repository.getMetadata(conversation.id)).toMatchObject({
      isLegacySession: true,
    });

    persistence.saveInputLedger.mockClear();
    await repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    expect(persistence.saveInputLedger).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ conversationId: conversation.id }),
      'unscoped',
    );
  });

  it('exclusively assigns unscoped metadata before routing later writes to the device', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    await repository.adoptMetadataConversations([
      { conversation, needsMigration: false, source: 'unscoped' },
    ]);
    persistence.saveMetadata.mockClear();

    await expect(repository.assignToCurrentDevice(conversation.id)).resolves.toBe(true);

    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversation.id }),
      'unscoped',
    );
    expect(persistence.assignMetadataToDevice).toHaveBeenCalledWith(conversation.id);
    expect(repository.getMetadata(conversation.id)).toMatchObject({
      isLegacySession: false,
    });

    persistence.saveMetadata.mockClear();
    await repository.rename(conversation.id, 'Device owned');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversation.id, title: 'Device owned' }),
    );

    persistence.saveInputLedger.mockClear();
    await repository.stageConversationInput(
      conversation.id,
      createInputRecord(),
    );
    expect(persistence.saveInputLedger).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ conversationId: conversation.id }),
    );
  });

  it('retains unscoped ownership when exclusive assignment fails', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    persistence.assignMetadataToDevice.mockRejectedValue(new Error('rename failed'));
    const { repository } = createRepository(conversation, persistence);
    await repository.adoptMetadataConversations([
      { conversation, needsMigration: false, source: 'unscoped' },
    ]);

    await expect(repository.assignToCurrentDevice(conversation.id)).rejects.toThrow(
      'rename failed',
    );

    expect(repository.getMetadata(conversation.id)).toMatchObject({
      isLegacySession: true,
    });
    persistence.saveMetadata.mockClear();
    await repository.rename(conversation.id, 'Legacy remains authoritative');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Legacy remains authoritative' }),
      'unscoped',
    );
  });

  it('rewrites current metadata after timestamp schema migration', async () => {
    const conversation: Conversation = {
      ...createConversation(),
      linkedContentPath: 'Notes/Architecture.md',
    };
    conversation.lastActivityAt = 42;
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);

    await repository.adoptMetadataConversations([
      { conversation, needsMigration: true, source: 'device' },
    ]);

    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      lastActivityAt: 42,
      linkedContentPath: 'Notes/Architecture.md',
    }));
    expect(persistence.saveMetadata.mock.calls[0][0]).not.toHaveProperty('updatedAt');
    expect(persistence.saveMetadata.mock.calls[0][0]).not.toHaveProperty('lastResponseAt');
    expect(persistence.saveMetadata.mock.calls[0][0]).not.toHaveProperty('currentNote');
    expect(persistence.deleteLegacyMetadata).not.toHaveBeenCalled();
  });

  it('preserves provider state while migrating an unhydrated metadata shell', async () => {
    const conversation = createConversation();
    conversation.providerState = {
      providerSessionId: 'native-session',
      subagentData: {
        'task-1': {
          id: 'task-1',
          description: 'Completed background task',
          status: 'completed',
          result: 'Recovered result',
          toolCalls: [],
          isExpanded: false,
        },
      },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);

    await repository.adoptMetadataConversations([
      { conversation, needsMigration: true, source: 'device' },
    ]);

    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: conversation.id,
      providerState: conversation.providerState,
    }));
  });

  it('applies Linked content renames to metadata adopted after the rename event', async () => {
    const existing = createConversation('existing');
    const persistence = createPersistence();
    const { repository } = createRepository(existing, persistence);
    await repository.rewriteLinkedContentPaths('Notes/Old.md', 'Notes/New.md');
    persistence.saveMetadata.mockClear();

    const deferredConversation: Conversation = {
      ...createConversation('deferred'),
      linkedContentPath: 'Notes/Old.md',
    };
    repository.mergeMetadataConversations([deferredConversation]);
    await repository.adoptMetadataConversations([
      { conversation: deferredConversation, needsMigration: false, source: 'device' },
    ]);

    expect(deferredConversation.linkedContentPath).toBe('Notes/New.md');
    expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'deferred',
      linkedContentPath: 'Notes/New.md',
    }));
  });
});

describe('ConversationRepository deletion, fork, and rewind persistence', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks deletion durably before ordered cleanup and never invokes provider-native deletion', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const calls: string[] = [];
    persistence.markDeleted.mockImplementation(async () => {
      calls.push('marker');
    });
    persistence.deleteCurrentMetadata.mockImplementation(async () => {
      calls.push('current');
    });
    persistence.deleteLegacyMetadata.mockImplementation(async () => {
      calls.push('legacy');
    });
    persistence.deleteInputLedger.mockImplementation(async () => {
      calls.push('ledger');
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory: jest.fn(),
    } as any);
    const { repository, onConversationDeleted } = createRepository(
      conversation,
      persistence,
    );

    await repository.delete(conversation.id);

    expect(calls).toEqual(['marker', 'current', 'legacy', 'ledger']);
    expect(onConversationDeleted).toHaveBeenCalledWith(conversation.id);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });

  it('rolls back in-memory deletion when marker creation fails without removing durable data', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    persistence.markDeleted.mockRejectedValue(new Error('marker failed'));
    const { repository, onConversationDeleted } = createRepository(
      conversation,
      persistence,
    );

    await expect(repository.delete(conversation.id)).rejects.toThrow(
      'marker failed',
    );

    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(persistence.deleteCurrentMetadata).not.toHaveBeenCalled();
    expect(persistence.deleteLegacyMetadata).not.toHaveBeenCalled();
    expect(persistence.deleteInputLedger).not.toHaveBeenCalled();
    expect(onConversationDeleted).not.toHaveBeenCalled();
  });

  it('restores the exact live binding and replays the newest snapshot after marker failure', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const marker = deferred<void>();
    persistence.markDeleted.mockReturnValue(marker.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.markDeleted).toHaveBeenCalledTimes(1);

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
    marker.reject(new Error('marker failed'));

    await expect(deletion).rejects.toThrow('marker failed');
    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
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
    const marker = deferred<void>();
    const replayCheckStarted = deferred<void>();
    const replayDeletionCheck = deferred<boolean>();
    persistence.markDeleted.mockReturnValue(marker.promise);
    persistence.isDeleted
      .mockImplementationOnce(async () => {
        replayCheckStarted.resolve();
        return replayDeletionCheck.promise;
      })
      .mockResolvedValue(false);
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
    marker.reject(new Error('marker failed'));
    await replayCheckStarted.promise;

    repository.registerExecutionBinding(conversation.id, 'new-binding', 5);
    replayDeletionCheck.resolve(false);

    await expect(deletion).rejects.toThrow('marker failed');
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
    const marker = deferred<void>();
    persistence.markDeleted.mockReturnValue(marker.promise);
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
    marker.reject(new Error('marker failed'));

    await expect(deletion).rejects.toThrow('marker failed');
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

  it('keeps a racing snapshot fenced when the deletion marker succeeds', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const marker = deferred<void>();
    persistence.markDeleted.mockReturnValue(marker.promise);
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
    marker.resolve();

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

  it('retries the UI association callback and cleanup after a post-marker callback failure', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const calls: string[] = [];
    persistence.markDeleted.mockImplementation(async () => {
      calls.push('marker');
    });
    persistence.deleteCurrentMetadata.mockImplementation(async () => {
      calls.push('current');
    });
    persistence.deleteLegacyMetadata.mockImplementation(async () => {
      calls.push('legacy');
    });
    persistence.deleteInputLedger.mockImplementation(async () => {
      calls.push('ledger');
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

    expect(calls).toEqual([
      'marker',
      'callback',
      'current',
      'legacy',
      'ledger',
    ]);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ])).toEqual([]);

    await repository.retryDeletedConversationCleanup(conversation.id);

    expect(calls).toEqual([
      'marker',
      'callback',
      'current',
      'legacy',
      'ledger',
      'callback',
      'current',
      'legacy',
      'ledger',
    ]);
    expect(persistence.markDeleted).toHaveBeenCalledTimes(1);
    expect(onConversationDeleted).toHaveBeenCalledTimes(2);
  });

  it('keeps a tombstoned conversation invisible after cleanup failure and allows retry', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    persistence.deleteLegacyMetadata.mockRejectedValueOnce(
      new Error('legacy cleanup failed'),
    );
    const { repository, onConversationDeleted } = createRepository(
      conversation,
      persistence,
    );

    await expect(repository.delete(conversation.id)).rejects.toThrow(
      'legacy cleanup failed',
    );
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ])).toEqual([]);

    await repository.retryDeletedConversationCleanup(conversation.id);
    expect(onConversationDeleted).toHaveBeenCalledTimes(2);
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledTimes(2);
    expect(persistence.deleteLegacyMetadata).toHaveBeenCalledTimes(2);
    expect(persistence.deleteInputLedger).toHaveBeenCalledTimes(1);
    expect(onConversationDeleted.mock.invocationCallOrder[1]).toBeLessThan(
      persistence.deleteCurrentMetadata.mock.invocationCallOrder[1],
    );
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

    const markerCall = persistence.markDeleted.mock.invocationCallOrder[0];
    const laterMetadataWrite = persistence.saveMetadata.mock.invocationCallOrder
      .find((order) => order > markerCall);
    expect(laterMetadataWrite).toBeUndefined();
  });

  it('fences legacy migration before writing the deletion marker', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);

    const migration = repository.adoptMetadataConversations([
      { conversation, needsMigration: false, source: 'legacy' },
    ]);
    const deletion = repository.delete(conversation.id);
    await Promise.all([migration, deletion]);

    const markerOrder = persistence.markDeleted.mock.invocationCallOrder[0];
    expect(
      persistence.saveMetadata.mock.invocationCallOrder.some(
        (order) => order > markerOrder,
      ),
    ).toBe(false);
    expect(
      persistence.deleteLegacyMetadata.mock.invocationCallOrder.some(
        (order) => order > markerOrder,
      ),
    ).toBe(true);
  });

  it.each([
    ['current metadata', 'deleteCurrentMetadata'],
    ['input ledger', 'deleteInputLedger'],
  ] as const)(
    'keeps deletion semantic and retryable when %s cleanup fails',
    async (_label, method) => {
      const conversation = createConversation();
      const persistence = createPersistence();
      persistence[method].mockRejectedValueOnce(new Error(`${method} failed`));
      const { repository } = createRepository(conversation, persistence);

      await expect(repository.delete(conversation.id)).rejects.toThrow(
        `${method} failed`,
      );
      expect(repository.getCachedConversation(conversation.id)).toBeNull();

      await repository.retryDeletedConversationCleanup(conversation.id);
      expect(persistence[method]).toHaveBeenCalledTimes(2);
      expect(persistence.deleteInputLedger).toHaveBeenCalled();
    },
  );

  it('copies fork inputs through a checkpoint without sharing mutable records', async () => {
    const source = createConversation('source');
    const target = createConversation('target');
    const sourceLedger = createLedger(source.id, [
      createInputRecord({
        id: 'source-1',
        providerAssistantMessageId: 'checkpoint-1',
      }),
      createInputRecord({
        id: 'source-2',
        userTurnOrdinal: 2,
        providerAssistantMessageId: 'checkpoint-2',
      }),
    ]);
    const persistence = createPersistence();
    persistence.loadInputLedger.mockImplementation(async (id) => (
      id === source.id
        ? { status: 'loaded', ledger: sourceLedger, needsMigration: false }
        : { status: 'missing' }
    ));
    const { repository } = createRepository(source, persistence);
    repository.mergeMetadataConversations([target]);

    await repository.copyConversationInputsForFork(
      source.id,
      target.id,
      'checkpoint-1',
    );
    const targetLedger = await repository.getConversationInputLedger(target.id);

    expect(targetLedger?.records.map(({ id }) => id)).toEqual(['source-1']);
    expect(targetLedger?.records[0]).not.toBe(sourceLedger.records[0]);
    targetLedger!.records[0].canonicalText = 'Changed target';
    expect(sourceLedger.records[0].canonicalText).toBe('Hello');
  });

  it('rewind truncation removes the selected input and every later record', async () => {
    const conversation = createConversation();
    const ledger = createLedger(conversation.id, [
      createInputRecord({ id: 'input-1' }),
      createInputRecord({ id: 'input-2', userTurnOrdinal: 2 }),
      createInputRecord({ id: 'input-3', userTurnOrdinal: 3 }),
    ]);
    const persistence = createPersistence({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
    const { repository } = createRepository(conversation, persistence);

    await repository.truncateConversationInputsFrom(
      conversation.id,
      'input-2',
    );

    expect(ledger.records.map(({ id }) => id)).toEqual(['input-1']);
    expect(persistence.saveInputLedger).toHaveBeenCalledWith(
      conversation.id,
      ledger,
    );
  });

  it('never reuses a durable tombstoned conversation ID', async () => {
    const persistence = createPersistence();
    persistence.isDeleted.mockResolvedValue(true);
    const { repository } = createRepository(
      createConversation('existing'),
      persistence,
    );

    await expect(repository.create({
      providerId: 'claude',
      sessionId: 'tombstoned',
    })).rejects.toThrow('Conversation ID is permanently deleted');
  });
});
