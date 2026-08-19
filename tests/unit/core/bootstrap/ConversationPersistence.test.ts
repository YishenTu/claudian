import {
  computeConversationInputDigest,
  CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
  type ConversationInputLedger,
  ConversationInputLedgerStorage,
} from '@/core/bootstrap/ConversationInputLedgerStorage';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import {
  type SessionMetadataReadResult,
  SessionStorage,
} from '@/core/bootstrap/SessionStorage';
import {
  DELETION_MARKER_SUFFIX,
  INPUT_LEDGER_SUFFIX,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
} from '@/core/bootstrap/storagePaths';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SessionMetadata } from '@/core/types';

function createAdapter(): jest.Mocked<VaultFileAdapter> {
  return {
    delete: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    listFiles: jest.fn().mockResolvedValue([]),
    read: jest.fn(),
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VaultFileAdapter>;
}

function createMetadata(id: string): SessionMetadata {
  return {
    id,
    providerId: 'claude',
    title: `Conversation ${id}`,
    createdAt: 1,
    lastActivityAt: 2,
  };
}

function createLedger(conversationId = 'conversation-1'): ConversationInputLedger {
  return {
    schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
    conversationId,
    records: [
      {
        schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
        id: 'input-1',
        userTurnOrdinal: 1,
        state: 'staged',
        timestamp: 10,
        rawDisplayText: 'Hello',
        canonicalText: 'Hello',
        images: [],
        contentDigest: computeConversationInputDigest({
          visibleText: 'Hello',
          images: [],
        }),
      },
    ],
  };
}

describe('SessionStorage read boundary', () => {
  it('loads current and legacy records with source information and performs no migration writes', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    const current = createMetadata('current');
    const legacy = createMetadata('legacy');
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/current.meta.json`
      || path === `${LEGACY_SESSIONS_PATH}/legacy.meta.json`
    ));
    adapter.read.mockImplementation(async (path) => (
      path.includes('current') ? JSON.stringify(current) : JSON.stringify(legacy)
    ));

    await expect(storage.load('current')).resolves.toEqual({
      metadata: current,
      needsMigration: false,
      source: 'current',
    } satisfies SessionMetadataReadResult);
    await expect(storage.load('legacy')).resolves.toEqual({
      metadata: legacy,
      needsMigration: false,
      source: 'legacy',
    } satisfies SessionMetadataReadResult);
    await expect(storage.loadMetadata('legacy')).resolves.toEqual(legacy);

    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('scans current and legacy metadata read-only while preferring current duplicates', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    const current = createMetadata('duplicate');
    const legacyOnly = createMetadata('legacy-only');
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === SESSIONS_PATH) {
        return [`${SESSIONS_PATH}/duplicate.meta.json`];
      }
      if (path === LEGACY_SESSIONS_PATH) {
        return [
          `${LEGACY_SESSIONS_PATH}/duplicate.meta.json`,
          `${LEGACY_SESSIONS_PATH}/legacy-only.meta.json`,
        ];
      }
      return [];
    });
    adapter.read.mockImplementation(async (path) => (
      path.endsWith('legacy-only.meta.json')
        ? JSON.stringify(legacyOnly)
        : JSON.stringify(current)
    ));

    const result = await storage.scan();

    expect(result.records).toEqual([
      { metadata: current, needsMigration: false, source: 'current' },
      { metadata: legacyOnly, needsMigration: false, source: 'legacy' },
    ]);
    expect(result.complete).toBe(true);
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('lists deletion markers first and suppresses matching current and legacy metadata', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === SESSIONS_PATH) {
        return [
          `${SESSIONS_PATH}/deleted${DELETION_MARKER_SUFFIX}`,
          `${SESSIONS_PATH}/deleted.meta.json`,
          `${SESSIONS_PATH}/visible.meta.json`,
        ];
      }
      if (path === LEGACY_SESSIONS_PATH) {
        return [`${LEGACY_SESSIONS_PATH}/deleted.meta.json`];
      }
      return [];
    });
    adapter.read.mockImplementation(async (path) => {
      const id = path.includes('visible') ? 'visible' : 'deleted';
      return JSON.stringify(createMetadata(id));
    });

    const result = await storage.scan();

    expect(result.records).toEqual([
      {
        metadata: createMetadata('visible'),
        needsMigration: false,
        source: 'current',
      },
    ]);
    expect(adapter.read).not.toHaveBeenCalledWith(
      `${SESSIONS_PATH}/deleted.meta.json`,
    );
    expect(adapter.read).not.toHaveBeenCalledWith(
      `${LEGACY_SESSIONS_PATH}/deleted.meta.json`,
    );
  });

  it('fails closed when deletion markers cannot be listed', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === SESSIONS_PATH) throw new Error('listing failed');
      return [`${LEGACY_SESSIONS_PATH}/possibly-deleted.meta.json`];
    });

    await expect(storage.scan()).resolves.toEqual({
      records: [],
      complete: false,
      invalidMetadataCount: 0,
    });
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it('suppresses an explicit load when a durable deletion marker exists', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/deleted${DELETION_MARKER_SUFFIX}`
      || path === `${SESSIONS_PATH}/deleted.meta.json`
    ));

    await expect(storage.load('deleted')).resolves.toBeNull();
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it('normalizes legacy currentNote to canonical Linked content metadata', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/legacy-content.meta.json`
    ));
    adapter.read.mockResolvedValue(JSON.stringify({
      ...createMetadata('legacy-content'),
      currentNote: 'Notes\\Legacy.md',
    }));

    await expect(storage.load('legacy-content')).resolves.toEqual({
      metadata: {
        ...createMetadata('legacy-content'),
        linkedContentPath: 'Notes/Legacy.md',
      },
      needsMigration: true,
      source: 'current',
    });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('prefers canonical metadata and removes the legacy field', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/canonical-content.meta.json`
    ));
    adapter.read.mockResolvedValue(JSON.stringify({
      ...createMetadata('canonical-content'),
      linkedContentPath: './Projects//Current',
      currentNote: 'Notes/Legacy.md',
    }));

    await expect(storage.load('canonical-content')).resolves.toEqual({
      metadata: {
        ...createMetadata('canonical-content'),
        linkedContentPath: 'Projects/Current',
      },
      needsMigration: true,
      source: 'current',
    });
  });

  it('fails closed when canonical metadata is invalid', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter);
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/invalid-content.meta.json`
    ));
    adapter.read.mockResolvedValue(JSON.stringify({
      ...createMetadata('invalid-content'),
      linkedContentPath: '../escape',
      currentNote: 'Notes/Legacy.md',
    }));

    await expect(storage.load('invalid-content')).resolves.toEqual({
      metadata: createMetadata('invalid-content'),
      needsMigration: true,
      source: 'current',
    });
  });
});

describe('ConversationInputLedgerStorage', () => {
  it('saves and lazily loads a versioned ledger sidecar', async () => {
    const adapter = createAdapter();
    const storage = new ConversationInputLedgerStorage(adapter);
    const ledger = createLedger();
    adapter.exists.mockResolvedValueOnce(false);

    await expect(storage.load(ledger.conversationId)).resolves.toEqual({
      status: 'missing',
    });
    expect(adapter.read).not.toHaveBeenCalled();

    await storage.save(ledger.conversationId, ledger);
    expect(adapter.write).toHaveBeenCalledWith(
      `${SESSIONS_PATH}/${ledger.conversationId}${INPUT_LEDGER_SUFFIX}`,
      expect.any(String),
    );

    const persisted = adapter.write.mock.calls[0][1];
    adapter.exists.mockResolvedValue(true);
    adapter.read.mockResolvedValue(persisted);
    await expect(storage.load(ledger.conversationId)).resolves.toEqual({
      status: 'loaded',
      ledger,
      needsMigration: false,
    });
  });

  it('normalizes legacy Linked content context without rewriting the ledger', async () => {
    const adapter = createAdapter();
    const storage = new ConversationInputLedgerStorage(adapter);
    const legacy = createLedger();
    const raw = {
      ...legacy,
      records: [{
        ...legacy.records[0],
        context: {
          currentNote: { path: 'Notes\\Legacy.md', content: 'body' },
        },
      }],
    };
    adapter.exists.mockResolvedValue(true);
    adapter.read.mockResolvedValue(JSON.stringify(raw));

    const result = await storage.load(legacy.conversationId);

    expect(result).toEqual({
      status: 'loaded',
      ledger: {
        ...legacy,
        records: [{
          ...legacy.records[0],
          context: {
            linkedContent: { path: 'Notes/Legacy.md', content: 'body' },
          },
        }],
      },
      needsMigration: true,
    });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('fails closed for invalid canonical context without falling back to legacy', async () => {
    const adapter = createAdapter();
    const storage = new ConversationInputLedgerStorage(adapter);
    const ledger = createLedger();
    const raw = {
      ...ledger,
      records: [{
        ...ledger.records[0],
        context: {
          linkedContent: { path: '../escape' },
          currentNote: { path: 'Notes/Legacy.md' },
          editorSelection: null,
        },
      }],
    };
    adapter.exists.mockResolvedValue(true);
    adapter.read.mockResolvedValue(JSON.stringify(raw));

    const result = await storage.load(ledger.conversationId);

    expect(result).toEqual({
      status: 'loaded',
      ledger: {
        ...ledger,
        records: [{
          ...ledger.records[0],
          context: { editorSelection: null },
        }],
      },
      needsMigration: true,
    });
  });

  it('reports malformed and unsupported ledgers without overwriting them', async () => {
    const adapter = createAdapter();
    const storage = new ConversationInputLedgerStorage(adapter);
    adapter.exists.mockResolvedValue(true);
    adapter.read
      .mockResolvedValueOnce('{not-json')
      .mockResolvedValueOnce(JSON.stringify({
        ...createLedger(),
        schemaVersion: 99,
      }));

    await expect(storage.load('conversation-1')).resolves.toEqual({
      status: 'unavailable',
      reason: 'malformed',
    });
    await expect(storage.load('conversation-1')).resolves.toEqual({
      status: 'unavailable',
      reason: 'unsupported-version',
    });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '.',
    '..',
    '../escape',
    'nested/id',
    'nested\\id',
    '/absolute',
    '%2Fescape',
  ])('rejects unsafe conversation ID %p before ledger I/O', async (id) => {
    const adapter = createAdapter();
    const storage = new ConversationInputLedgerStorage(adapter);

    await expect(storage.load(id)).rejects.toThrow('Invalid session metadata id');
    await expect(storage.save(id, createLedger(id))).rejects.toThrow(
      'Invalid session metadata id',
    );
    await expect(storage.delete(id)).rejects.toThrow('Invalid session metadata id');
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('builds a stable versioned digest from normalized text and ordered attachment hashes', () => {
    const image = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png' as const,
      data: 'aW1hZ2U=',
      size: 5,
      source: 'paste' as const,
    };

    expect(computeConversationInputDigest({
      visibleText: 'line 1\r\nline 2',
      images: [image],
    })).toBe(computeConversationInputDigest({
      visibleText: 'line 1\nline 2',
      images: [{ ...image, id: 'different-local-id', name: 'renamed.png' }],
    }));
    expect(computeConversationInputDigest({
      visibleText: 'line 1\nline 2',
      images: [image],
    })).not.toBe(computeConversationInputDigest({
      visibleText: 'line 1\nline 2 changed',
      images: [image],
    }));
  });
});

describe('ConversationPersistenceStore', () => {
  it('serializes metadata only through the repository persistence boundary', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter);
    const metadata = {
      id: 'conversation-1',
      providerId: 'claude' as const,
      title: 'Persisted conversation',
      createdAt: 1,
      lastActivityAt: 2,
      linkedContentPath: 'Notes/current.md',
    };

    await store.saveMetadata(metadata);

    expect(adapter.write).toHaveBeenCalledWith(
      `${SESSIONS_PATH}/conversation-1.meta.json`,
      JSON.stringify(metadata, null, 2),
    );
  });

  it('writes a durable deletion marker without deleting it', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter);

    await store.markDeleted('conversation-1', 123);

    expect(adapter.write).toHaveBeenCalledWith(
      `${SESSIONS_PATH}/conversation-1${DELETION_MARKER_SUFFIX}`,
      JSON.stringify({
        schemaVersion: 1,
        conversationId: 'conversation-1',
        deletedAt: 123,
      }, null, 2),
    );
    expect(adapter.delete).not.toHaveBeenCalledWith(
      `${SESSIONS_PATH}/conversation-1${DELETION_MARKER_SUFFIX}`,
    );
  });

  it('deletes current metadata, legacy metadata, and ledger through separate ordered operations', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter);

    await store.deleteCurrentMetadata('conversation-1');
    await store.deleteLegacyMetadata('conversation-1');
    await store.deleteInputLedger('conversation-1');

    expect(adapter.delete.mock.calls.map(([path]) => path)).toEqual([
      `${SESSIONS_PATH}/conversation-1.meta.json`,
      `${LEGACY_SESSIONS_PATH}/conversation-1.meta.json`,
      `${SESSIONS_PATH}/conversation-1${INPUT_LEDGER_SUFFIX}`,
    ]);
  });
});
