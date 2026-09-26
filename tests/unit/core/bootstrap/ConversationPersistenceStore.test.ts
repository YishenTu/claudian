
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import {
  type SessionMetadataReadResult,
  SessionStorage,
} from '@/core/bootstrap/SessionStorage';
import {
  DEVICE_SESSIONS_PATH,
  getDeviceSessionsPath,
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

function createMetadata(id: string): SessionMetadata {
  return {
    id,
    providerId: 'claude',
    title: `Conversation ${id}`,
    createdAt: 1,
    lastActivityAt: 2,
  };
}

describe('SessionStorage read boundary', () => {

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

describe('ConversationPersistenceStore', () => {
  it('writes device and unscoped metadata to their authoritative namespaces', async () => {
    const adapter = createAdapter();
    const store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
    const deviceMetadata = {
      ...createMetadata('device-owned'),
      linkedContentPath: 'Notes/current.md',
    };
    const unscopedMetadata = createMetadata('unscoped-owned');

    await store.saveMetadata(deviceMetadata);
    await store.saveMetadata(unscopedMetadata, 'unscoped');

    expect(adapter.write.mock.calls).toEqual([
      [
        `${DEVICE_PATH}/device-owned.meta.json`,
        JSON.stringify(deviceMetadata),
      ],
      [
        `${SESSIONS_PATH}/unscoped-owned.meta.json`,
        JSON.stringify(unscopedMetadata),
      ],
    ]);
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
});
