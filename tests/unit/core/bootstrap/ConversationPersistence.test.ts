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
  DEVICE_SESSIONS_PATH,
  getDeviceSessionsPath,
  INPUT_LEDGER_SUFFIX,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
} from '@/core/bootstrap/storagePaths';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SessionMetadata } from '@/core/types';

function createAdapter(): jest.Mocked<VaultFileAdapter> {
  return {
    delete: jest.fn().mockResolvedValue(undefined),
    ensureFolder: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    listFiles: jest.fn().mockResolvedValue([]),
    read: jest.fn(),
    rename: jest.fn().mockResolvedValue(undefined),
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VaultFileAdapter>;
}

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
const DEVICE_PATH = `${DEVICE_SESSIONS_PATH}/${DEVICE_KEY}`;
const BETA_DEVICE_KEY = `device-${'b'.repeat(64)}`;
const BETA_DEVICE_PATH = getDeviceSessionsPath(BETA_DEVICE_KEY);
const ASSIGNMENT_PATH = `${SESSIONS_PATH}/conversation-1.assigned.json`;
const DEVICE_DELETION_PATH = `${DEVICE_PATH}/conversation-1${DELETION_MARKER_SUFFIX}`;

function createAssignment(
  conversationId: string,
  devicePath = DEVICE_PATH,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    conversationId,
    deviceKey: devicePath.split('/').at(-1),
  };
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
  it('uses the filesystem-safe opaque device key as the metadata namespace', () => {
    expect(getDeviceSessionsPath(DEVICE_KEY)).toBe(DEVICE_PATH);
  });

  it('isolates current metadata scans by device while retaining unscoped sessions', async () => {
    const adapter = createAdapter();
    const alphaStorage = new SessionStorage(adapter, DEVICE_KEY);
    const betaStorage = new SessionStorage(adapter, BETA_DEVICE_KEY);
    const betaPath = getDeviceSessionsPath(BETA_DEVICE_KEY);
    const alpha = createMetadata('alpha-only');
    const beta = createMetadata('beta-only');
    const unscoped = createMetadata('unscoped');
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === DEVICE_PATH) return [`${DEVICE_PATH}/alpha-only.meta.json`];
      if (path === betaPath) return [`${betaPath}/beta-only.meta.json`];
      if (path === SESSIONS_PATH) return [`${SESSIONS_PATH}/unscoped.meta.json`];
      return [];
    });
    adapter.read.mockImplementation(async (path) => {
      if (path.includes('alpha-only')) return JSON.stringify(alpha);
      if (path.includes('beta-only')) return JSON.stringify(beta);
      return JSON.stringify(unscoped);
    });

    await expect(alphaStorage.listMetadata()).resolves.toEqual([alpha, unscoped]);
    await expect(betaStorage.listMetadata()).resolves.toEqual([beta, unscoped]);
  });

  it('loads unscoped metadata without changing its writable authority', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const metadata = createMetadata('unscoped');
    adapter.exists.mockImplementation(async path => (
      path === `${SESSIONS_PATH}/unscoped.meta.json`
    ));
    adapter.read.mockResolvedValue(JSON.stringify(metadata));

    await expect(storage.load('unscoped')).resolves.toEqual({
      metadata,
      needsMigration: false,
      source: 'unscoped',
    });
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
  });

  it('retries resolution when assignment moves unscoped metadata between lookup and read', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const metadata = createMetadata('conversation-1');
    const unscopedPath = `${SESSIONS_PATH}/conversation-1.meta.json`;
    const currentPath = `${DEVICE_PATH}/conversation-1.meta.json`;
    let assigned = false;
    adapter.exists.mockImplementation(async (path) => {
      if (path === ASSIGNMENT_PATH) return assigned;
      if (path === currentPath) return assigned;
      if (path === unscopedPath) return !assigned;
      return false;
    });
    adapter.read.mockImplementation(async (path) => {
      if (path === unscopedPath) {
        assigned = true;
        throw Object.assign(new Error('source moved'), { code: 'ENOENT' });
      }
      if (path === ASSIGNMENT_PATH) {
        return JSON.stringify(createAssignment('conversation-1'));
      }
      if (path === currentPath) return JSON.stringify(metadata);
      throw new Error(`Unexpected read: ${path}`);
    });

    await expect(storage.load('conversation-1')).resolves.toEqual({
      metadata,
      needsMigration: false,
      source: 'device',
    });
    expect(adapter.read).toHaveBeenCalledWith(unscopedPath);
    expect(adapter.read).toHaveBeenCalledWith(currentPath);
  });

  it('retries resolution when assignment moves metadata between source probes', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const metadata = createMetadata('conversation-1');
    const unscopedPath = `${SESSIONS_PATH}/conversation-1.meta.json`;
    const currentPath = `${DEVICE_PATH}/conversation-1.meta.json`;
    let assigned = false;
    adapter.exists.mockImplementation(async (path) => {
      if (path === ASSIGNMENT_PATH) return assigned;
      if (path === currentPath) return assigned;
      if (path === unscopedPath) {
        assigned = true;
        return false;
      }
      return false;
    });
    adapter.read.mockImplementation(async (path) => {
      if (path === ASSIGNMENT_PATH) {
        return JSON.stringify(createAssignment('conversation-1'));
      }
      if (path === currentPath) return JSON.stringify(metadata);
      throw new Error(`Unexpected read: ${path}`);
    });

    await expect(storage.load('conversation-1')).resolves.toEqual({
      metadata,
      needsMigration: false,
      source: 'device',
    });
    expect(adapter.read).toHaveBeenCalledWith(currentPath);
  });

  it('treats an assignment fence as authority when stale unscoped metadata also exists', async () => {
    const adapter = createAdapter();
    const alphaStorage = new SessionStorage(adapter, DEVICE_KEY);
    const betaStorage = new SessionStorage(adapter, BETA_DEVICE_KEY);
    const metadata = createMetadata('conversation-1');
    const currentPath = `${DEVICE_PATH}/conversation-1.meta.json`;
    const unscopedPath = `${SESSIONS_PATH}/conversation-1.meta.json`;
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === DEVICE_PATH) return [currentPath];
      if (path === BETA_DEVICE_PATH) return [];
      if (path === SESSIONS_PATH) {
        return [
          ASSIGNMENT_PATH,
          unscopedPath,
          `${SESSIONS_PATH}/conversation-1${DELETION_MARKER_SUFFIX}`,
        ];
      }
      return [];
    });
    adapter.read.mockImplementation(async (path) => (
      path === ASSIGNMENT_PATH
        ? JSON.stringify(createAssignment('conversation-1'))
        : JSON.stringify(metadata)
    ));

    await expect(alphaStorage.listMetadata()).resolves.toEqual([metadata]);
    await expect(betaStorage.listMetadata()).resolves.toEqual([]);
  });

  it('uses the same authority fallback for direct loads and scans', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const metadata = createMetadata('conversation-1');
    const deviceMetadataPath = `${DEVICE_PATH}/conversation-1.meta.json`;
    const unscopedMetadataPath = `${SESSIONS_PATH}/conversation-1.meta.json`;
    adapter.exists.mockImplementation(async path => (
      path === deviceMetadataPath
      || path === DEVICE_DELETION_PATH
      || path === unscopedMetadataPath
    ));
    adapter.listFiles.mockImplementation(async path => {
      if (path === DEVICE_PATH) {
        return [deviceMetadataPath, DEVICE_DELETION_PATH];
      }
      if (path === SESSIONS_PATH) return [unscopedMetadataPath];
      return [];
    });
    adapter.read.mockResolvedValue(JSON.stringify(metadata));

    const expected = {
      metadata,
      needsMigration: false,
      source: 'unscoped' as const,
    };
    await expect(storage.load('conversation-1')).resolves.toEqual(expected);
    await expect(storage.scan()).resolves.toEqual({
      records: [expected],
      complete: true,
      invalidMetadataCount: 0,
    });
  });

  it('loads current and legacy records with source information and performs no migration writes', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const current = createMetadata('current');
    const legacy = createMetadata('legacy');
    adapter.exists.mockImplementation(async (path) => (
      path === `${DEVICE_PATH}/current.meta.json`
      || path === `${LEGACY_SESSIONS_PATH}/legacy.meta.json`
    ));
    adapter.read.mockImplementation(async (path) => (
      path.includes('current') ? JSON.stringify(current) : JSON.stringify(legacy)
    ));

    await expect(storage.load('current')).resolves.toEqual({
      metadata: current,
      needsMigration: false,
      source: 'device',
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
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    const current = createMetadata('duplicate');
    const legacyOnly = createMetadata('legacy-only');
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === DEVICE_PATH) {
        return [`${DEVICE_PATH}/duplicate.meta.json`];
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
      { metadata: current, needsMigration: false, source: 'device' },
      { metadata: legacyOnly, needsMigration: false, source: 'legacy' },
    ]);
    expect(result.complete).toBe(true);
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('lists deletion markers first and suppresses matching current and legacy metadata', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === DEVICE_PATH) {
        return [
          `${DEVICE_PATH}/deleted${DELETION_MARKER_SUFFIX}`,
          `${DEVICE_PATH}/deleted.meta.json`,
          `${DEVICE_PATH}/visible.meta.json`,
        ];
      }
      if (path === SESSIONS_PATH) {
        return [
          `${SESSIONS_PATH}/deleted${DELETION_MARKER_SUFFIX}`,
          `${SESSIONS_PATH}/deleted.meta.json`,
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
        source: 'device',
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
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.listFiles.mockImplementation(async (path) => {
      if (path === SESSIONS_PATH) throw new Error('listing failed');
      if (path === LEGACY_SESSIONS_PATH) {
        return [`${LEGACY_SESSIONS_PATH}/possibly-deleted.meta.json`];
      }
      return [];
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
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.exists.mockImplementation(async (path) => (
      path === `${SESSIONS_PATH}/deleted${DELETION_MARKER_SUFFIX}`
      || path === `${SESSIONS_PATH}/deleted.meta.json`
    ));

    await expect(storage.load('deleted')).resolves.toBeNull();
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it('normalizes legacy currentNote to canonical Linked content metadata', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.exists.mockImplementation(async (path) => (
      path === `${DEVICE_PATH}/legacy-content.meta.json`
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
      source: 'device',
    });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('prefers canonical metadata and removes the legacy field', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.exists.mockImplementation(async (path) => (
      path === `${DEVICE_PATH}/canonical-content.meta.json`
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
      source: 'device',
    });
  });

  it('fails closed when canonical metadata is invalid', async () => {
    const adapter = createAdapter();
    const storage = new SessionStorage(adapter, DEVICE_KEY);
    adapter.exists.mockImplementation(async (path) => (
      path === `${DEVICE_PATH}/invalid-content.meta.json`
    ));
    adapter.read.mockResolvedValue(JSON.stringify({
      ...createMetadata('invalid-content'),
      linkedContentPath: '../escape',
      currentNote: 'Notes/Legacy.md',
    }));

    await expect(storage.load('invalid-content')).resolves.toEqual({
      metadata: createMetadata('invalid-content'),
      needsMigration: true,
      source: 'device',
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
  it('writes device and unscoped metadata to their authoritative namespaces', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    const deviceMetadata = createMetadata('device-owned');
    const unscopedMetadata = createMetadata('unscoped-owned');

    await store.saveMetadata(deviceMetadata, 'device');
    await store.saveMetadata(unscopedMetadata, 'unscoped');

    expect(adapter.write.mock.calls).toEqual([
      [
        `${DEVICE_PATH}/device-owned.meta.json`,
        JSON.stringify(deviceMetadata, null, 2),
      ],
      [
        `${SESSIONS_PATH}/unscoped-owned.meta.json`,
        JSON.stringify(unscopedMetadata, null, 2),
      ],
    ]);
  });

  it('fences unscoped writers before assigning metadata with one exclusive rename', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    const source = `${SESSIONS_PATH}/conversation-1.meta.json`;
    const operations: string[] = [];
    adapter.exists.mockImplementation(async path => path === source);
    adapter.write.mockImplementation(async path => {
      operations.push(`write:${path}`);
    });
    adapter.rename.mockImplementation(async (from, to) => {
      operations.push(`rename:${from}->${to}`);
    });

    await store.assignMetadataToDevice('conversation-1');

    expect(adapter.ensureFolder).toHaveBeenCalledWith(DEVICE_PATH);
    expect(operations).toEqual([
      `write:${ASSIGNMENT_PATH}`,
      `rename:${source}->${DEVICE_PATH}/conversation-1.meta.json`,
    ]);
    expect(adapter.write).toHaveBeenCalledWith(
      ASSIGNMENT_PATH,
      JSON.stringify(createAssignment('conversation-1'), null, 2),
    );
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('removes the assignment fence when the exclusive metadata move fails', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    const source = `${SESSIONS_PATH}/conversation-1.meta.json`;
    adapter.exists.mockImplementation(async path => path === source);
    adapter.rename.mockRejectedValue(new Error('move failed'));

    await expect(store.assignMetadataToDevice('conversation-1')).rejects.toThrow(
      'move failed',
    );

    expect(adapter.write).toHaveBeenCalledWith(
      ASSIGNMENT_PATH,
      JSON.stringify(createAssignment('conversation-1'), null, 2),
    );
    expect(adapter.delete).toHaveBeenCalledWith(ASSIGNMENT_PATH);
  });

  it('rejects a stale device write after another device assigns unscoped metadata', async () => {
    const adapter = createAdapter();
    const alphaStore = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    const betaStore = new ConversationPersistenceStore(adapter, BETA_DEVICE_KEY);
    const metadata = createMetadata('conversation-1');
    const source = `${SESSIONS_PATH}/conversation-1.meta.json`;
    const target = `${DEVICE_PATH}/conversation-1.meta.json`;
    const files = new Map<string, string>([
      [source, JSON.stringify(metadata)],
    ]);
    adapter.exists.mockImplementation(async path => files.has(path));
    adapter.read.mockImplementation(async path => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return content;
    });
    adapter.write.mockImplementation(async (path, content) => {
      files.set(path, content);
    });
    adapter.delete.mockImplementation(async path => {
      files.delete(path);
    });
    adapter.rename.mockImplementation(async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error('missing source');
      files.delete(from);
      files.set(to, content);
    });

    await alphaStore.assignMetadataToDevice('conversation-1');

    await expect(betaStore.saveMetadata(metadata, 'unscoped')).rejects.toThrow(
      'assigned to another device',
    );
    expect(files.has(source)).toBe(false);
    expect(files.has(target)).toBe(true);
    expect(files.has(ASSIGNMENT_PATH)).toBe(true);
  });

  it('rejects a stale input-ledger write after another device assigns metadata', async () => {
    const adapter = createAdapter();
    const betaStore = new ConversationPersistenceStore(adapter, BETA_DEVICE_KEY);
    const ledgerPath = `${SESSIONS_PATH}/conversation-1${INPUT_LEDGER_SUFFIX}`;
    adapter.exists.mockImplementation(async path => path === ASSIGNMENT_PATH);
    adapter.read.mockImplementation(async path => {
      if (path === ASSIGNMENT_PATH) {
        return JSON.stringify(createAssignment('conversation-1'));
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    await expect(betaStore.saveInputLedger(
      'conversation-1',
      createLedger('conversation-1'),
      'unscoped',
    )).rejects.toThrow('assigned to another device');
    expect(adapter.write).not.toHaveBeenCalledWith(
      ledgerPath,
      expect.any(String),
    );
  });

  it('rejects a stale unscoped deletion marker after another device assigns metadata', async () => {
    const adapter = createAdapter();
    const betaStore = new ConversationPersistenceStore(adapter, BETA_DEVICE_KEY);
    const deletionPath = `${SESSIONS_PATH}/conversation-1${DELETION_MARKER_SUFFIX}`;
    adapter.exists.mockImplementation(async path => path === ASSIGNMENT_PATH);
    adapter.read.mockImplementation(async path => {
      if (path === ASSIGNMENT_PATH) {
        return JSON.stringify(createAssignment('conversation-1'));
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    await expect(betaStore.markDeleted(
      'conversation-1',
      123,
      'unscoped',
    )).rejects.toThrow('assigned to another device');
    expect(adapter.write).not.toHaveBeenCalledWith(
      deletionPath,
      expect.any(String),
    );
  });

  it('refuses to overwrite existing device metadata during assignment', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    adapter.exists.mockImplementation(async path => (
      path === `${DEVICE_PATH}/conversation-1.meta.json`
    ));

    await expect(store.assignMetadataToDevice('conversation-1')).rejects.toThrow(
      'device metadata already exists',
    );
    expect(adapter.rename).not.toHaveBeenCalled();
  });

  it('serializes metadata only through the repository persistence boundary', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
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
      `${DEVICE_PATH}/conversation-1.meta.json`,
      JSON.stringify(metadata, null, 2),
    );
  });

  it('writes deletion markers inside their authoritative namespace', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);

    await store.markDeleted('conversation-1', 123);
    await store.markDeleted('legacy-conversation', 456, 'unscoped');

    expect(adapter.write.mock.calls).toEqual([
      [
        DEVICE_DELETION_PATH,
        JSON.stringify({
          schemaVersion: 1,
          conversationId: 'conversation-1',
          deletedAt: 123,
        }, null, 2),
      ],
      [
        `${SESSIONS_PATH}/legacy-conversation${DELETION_MARKER_SUFFIX}`,
        JSON.stringify({
          schemaVersion: 1,
          conversationId: 'legacy-conversation',
          deletedAt: 456,
        }, null, 2),
      ],
    ]);
    expect(adapter.delete).not.toHaveBeenCalledWith(
      DEVICE_DELETION_PATH,
    );
  });

  it('deletes current metadata, legacy metadata, and ledger through separate ordered operations', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);

    await store.deleteCurrentMetadata('conversation-1');
    await store.deleteLegacyMetadata('conversation-1');
    await store.deleteInputLedger('conversation-1');

    expect(adapter.delete.mock.calls.map(([path]) => path)).toEqual([
      `${DEVICE_PATH}/conversation-1.meta.json`,
      `${LEGACY_SESSIONS_PATH}/conversation-1.meta.json`,
      `${SESSIONS_PATH}/conversation-1${INPUT_LEDGER_SUFFIX}`,
    ]);
  });
});
