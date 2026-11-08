import { testDate } from '@test/helpers/testClock';
import type { Mocked } from 'vitest';

import { SessionStorage } from '@/app/storage/SessionStorage';
import { getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';



const DEVICE_KEY = `device-${'a'.repeat(64)}`;

describe('SessionStorage', () => {
  let mockAdapter: Mocked<VaultFileAdapter>;
  let storage: SessionStorage;

  beforeEach(() => {
    mockAdapter = {
      exists: vi.fn(),
      stat: vi.fn().mockResolvedValue(null),
      read: vi.fn(),
      write: vi.fn(),
      delete: vi.fn(),
      listFiles: vi.fn(),
    } as unknown as Mocked<VaultFileAdapter>;

    storage = new SessionStorage(mockAdapter, DEVICE_KEY);
  });

  it('reuses unchanged scan content and reloads only changed authority or file versions', async () => {
    const now = testDate().getTime();
    const paths = ['same', 'edited', 'moved', 'gone'].map(id => storage.getUnscopedMetadataPath(id));
    const contents = new Map(paths.map((path, index) => [path, JSON.stringify({
      id: ['same', 'edited', 'moved', 'gone'][index], title: 'Original', lastActivityAt: now,
    })]));
    const versions = new Map(paths.map(path => [path, now]));
    mockAdapter.listFiles.mockImplementation(async folder => paths.filter(path => path.slice(0, path.lastIndexOf('/')) === folder));
    mockAdapter.exists.mockImplementation(async path => contents.has(path));
    mockAdapter.read.mockImplementation(async path => contents.get(path)!);
    mockAdapter.stat = vi.fn(async path => contents.has(path) ? { mtime: versions.get(path) ?? now, size: contents.get(path)!.length } : null);
    const scan = await storage.scan();
    contents.set(paths[1], JSON.stringify({ id: 'edited', title: 'Changed', lastActivityAt: now }));
    versions.set(paths[1], now + 1);
    contents.set(storage.getMetadataPath('moved'), JSON.stringify({ id: 'moved', title: 'Device', lastActivityAt: now }));
    contents.delete(paths[3]);

    const records = await storage.revalidate(scan.records);

    expect(records.map(({ metadata, source }) => [metadata.id, metadata.title, source])).toEqual([
      ['same', 'Original', 'unscoped'], ['edited', 'Changed', 'unscoped'], ['moved', 'Device', 'device'],
    ]);
    expect(mockAdapter.read).toHaveBeenCalledTimes(6);
  });

  describe('getMetadataPath', () => {
    it('returns correct file path for session id', () => {
      const path = storage.getMetadataPath('session-abc');
      expect(path).toBe(`${getDeviceSessionsPath(DEVICE_KEY)}/session-abc.meta.json`);
    });

    it.each(['', '.', '..', '../escape', 'nested/id', 'nested\\id', '/absolute', '%2Fescape', '%5cescape'])(
      'rejects unsafe metadata id %o before path construction',
      (id) => {
        expect(() => storage.getMetadataPath(id)).toThrow('Invalid session metadata id');
      },
    );
  });

  describe('loadMetadata', () => {
    it('migrates saved directory selections while preserving conversation identity and provider state', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-directories.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-directories',
        title: 'Saved conversation',
        createdAt: 100,
        lastActivityAt: 200,
        externalContextPaths: ['/old/project'],
        providerState: { providerSessionId: 'native-session' },
      }));

      expect(await storage.load('session-directories')).toEqual({
        metadata: {
          id: 'session-directories',
          title: 'Saved conversation',
          createdAt: 100,
          lastActivityAt: 200,
          providerState: { providerSessionId: 'native-session' },
        },
        needsMigration: true,
        source: 'unscoped',
      });
    });

    it('normalizes legacy timestamps to a single activity timestamp', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-legacy-time.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-legacy-time',
        title: 'Legacy Session',
        createdAt: 100,
        updatedAt: 900,
        lastResponseAt: 700,
      }));

      const result = await storage.load('session-legacy-time');

      expect(result).toEqual({
        metadata: {
          id: 'session-legacy-time',
          title: 'Legacy Session',
          createdAt: 100,
          lastActivityAt: 700,
        },
        needsMigration: true,
        source: 'unscoped',
      });
    });

    it('removes malformed model metadata and marks the record for migration', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-malformed-model.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-malformed-model',
        title: 'Malformed model',
        createdAt: 100,
        lastActivityAt: 200,
        selectedModel: 42,
      }));

      const result = await storage.load('session-malformed-model');

      expect(result).toEqual({
        metadata: {
          id: 'session-malformed-model',
          title: 'Malformed model',
          createdAt: 100,
          lastActivityAt: 200,
        },
        needsMigration: true,
        source: 'unscoped',
      });
    });

    it.each([
      ['project-a', 'project-a', false],
      [42, undefined, true],
      ['../outside', undefined, true],
    ])('keeps only a safe project id %o and migrates malformed ones', async (stored, expected, needsMigration) => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-project.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-project',
        title: 'Project member',
        createdAt: 100,
        lastActivityAt: 200,
        projectId: stored,
      }));

      const result = await storage.load('session-project');

      expect('projectId' in result!.metadata ? result!.metadata.projectId : 'absent').toBe(expected ?? 'absent');
      expect(result?.needsMigration).toBe(needsMigration);
    });

    it.each([
      [{ kind: 'fork', conversationId: 'parent-a' }, { kind: 'fork', conversationId: 'parent-a' }, false],
      [{ kind: 'session-tool', conversationId: 'parent-a' }, { kind: 'session-tool', conversationId: 'parent-a' }, false],
      [{ kind: 'subagent', conversationId: 'parent-a' }, undefined, true],
      [{ kind: 'fork', conversationId: '../outside' }, undefined, true],
      [{ kind: 'fork' }, undefined, true],
      ['parent-a', undefined, true],
    ])('keeps only a well-formed origin %o and migrates malformed ones', async (stored, expected, needsMigration) => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-origin.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-origin',
        title: 'Started elsewhere',
        createdAt: 100,
        lastActivityAt: 200,
        origin: stored,
      }));

      const result = await storage.load('session-origin');

      expect('origin' in result!.metadata ? result!.metadata.origin : 'absent').toEqual(expected ?? 'absent');
      expect(result?.needsMigration).toBe(needsMigration);
    });

    it('loads a durable model recovery locator without making it active session state', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-model-retry.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-model-retry',
        title: 'Model retry',
        createdAt: 100,
        lastActivityAt: 200,
        sessionId: null,
        modelRecoverySource: {
          sessionId: 'native-session-before-invalidation',
          providerState: { threadId: 'native-session-before-invalidation' },
          resumeAtMessageId: 'checkpoint-1',
        },
      }));

      const result = await storage.load('session-model-retry');

      expect(result).toEqual({
        metadata: {
          id: 'session-model-retry',
          title: 'Model retry',
          createdAt: 100,
          lastActivityAt: 200,
          sessionId: null,
          modelRecoverySource: {
            sessionId: 'native-session-before-invalidation',
            providerState: { threadId: 'native-session-before-invalidation' },
            resumeAtMessageId: 'checkpoint-1',
          },
        },
        needsMigration: false,
        source: 'unscoped',
      });
    });

    it('drops a malformed model recovery locator and marks the record for migration', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${SESSIONS_PATH}/session-malformed-model-retry.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        id: 'session-malformed-model-retry',
        title: 'Malformed model retry',
        createdAt: 100,
        lastActivityAt: 200,
        modelRecoverySource: {
          sessionId: ['not', 'a', 'session'],
        },
      }));

      const result = await storage.load('session-malformed-model-retry');

      expect(result).toEqual({
        metadata: {
          id: 'session-malformed-model-retry',
          title: 'Malformed model retry',
          createdAt: 100,
          lastActivityAt: 200,
        },
        needsMigration: true,
        source: 'unscoped',
      });
    });

    it('returns null if file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.loadMetadata('session-123');

      expect(result).toBeNull();
    });

    it('ignores retired .claude session metadata', async () => {
      mockAdapter.exists.mockImplementation(async path => path === '.claude/sessions/session-retired.meta.json');
      mockAdapter.read.mockResolvedValue(JSON.stringify({ id: 'session-retired', title: 'Retired' }));
      expect(await storage.loadMetadata('session-retired')).toBeNull();
      expect(mockAdapter.read).not.toHaveBeenCalled();
      expect(mockAdapter.write).not.toHaveBeenCalled();
      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('loads and parses metadata from JSON file', async () => {
      const metadata = {
        id: 'session-abc',
        title: 'Loaded Session',
        createdAt: 1700000000,
        lastActivityAt: 1700001000,
        titleGenerationStatus: 'pending',
      };

      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${getDeviceSessionsPath(DEVICE_KEY)}/session-abc.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify(metadata));

      const result = await storage.loadMetadata('session-abc');

      expect(result).toEqual(metadata);
    });

    it('preserves explicit providerId on load', async () => {
      const metadata = {
        id: 'session-codex',
        providerId: 'codex',
        title: 'Codex Session',
        createdAt: 1700000000,
        lastActivityAt: 1700001000,
      };

      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${getDeviceSessionsPath(DEVICE_KEY)}/session-codex.meta.json`
      ));
      mockAdapter.read.mockResolvedValue(JSON.stringify(metadata));

      const result = await storage.loadMetadata('session-codex');

      expect(result!.providerId).toBe('codex');
    });

    it('returns null on parse error', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${getDeviceSessionsPath(DEVICE_KEY)}/session-bad.meta.json`
      ));
      mockAdapter.read.mockResolvedValue('invalid json');

      const result = await storage.loadMetadata('session-bad');

      expect(result).toBeNull();
    });

    it('returns null on read error', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === `${getDeviceSessionsPath(DEVICE_KEY)}/session-error.meta.json`
      ));
      mockAdapter.read.mockRejectedValue(new Error('Read error'));

      const result = await storage.loadMetadata('session-error');

      expect(result).toBeNull();
    });
  });

  describe('listMetadata', () => {
    it('returns metadata for .meta.json files', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claudian/sessions/native-1.meta.json',
        '.claudian/sessions/native-2.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('native-1')) {
          return Promise.resolve(JSON.stringify({
            id: 'native-1',
            title: 'Native One',
            createdAt: 1700000000,
            lastActivityAt: 1700002000,
          }));
        }
        if (path.includes('native-2')) {
          return Promise.resolve(JSON.stringify({
            id: 'native-2',
            title: 'Native Two',
            createdAt: 1700000000,
            lastActivityAt: 1700001000,
          }));
        }
        return Promise.resolve('{}');
      });

      const metas = await storage.listMetadata();

      expect(metas).toHaveLength(2);
      expect(metas.map(m => m.id)).toContain('native-1');
      expect(metas.map(m => m.id)).toContain('native-2');
    });

    it('handles empty sessions directory', async () => {
      mockAdapter.listFiles.mockResolvedValue([]);

      const metas = await storage.listMetadata();

      expect(metas).toEqual([]);
    });

    it('handles listFiles error gracefully', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('List error'));

      const metas = await storage.listMetadata();

      expect(metas).toEqual([]);
    });

    it('reports an incomplete scan when a metadata directory cannot be listed', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('List error'));

      await expect(storage.scanMetadata()).resolves.toEqual({
        metadata: [],
        complete: false,
        invalidMetadataCount: 0,
      });
    });

    it('skips files that fail to load', async () => {
      mockAdapter.listFiles.mockResolvedValue([
        '.claudian/sessions/good.meta.json',
        '.claudian/sessions/bad.meta.json',
      ]);

      mockAdapter.read.mockImplementation((path: string) => {
        if (path.includes('good')) {
          return Promise.resolve(JSON.stringify({
            id: 'good',
            title: 'Good',
            createdAt: 1700000000,
            lastActivityAt: 1700001000,
          }));
        }
        return Promise.reject(new Error('Read error'));
      });

      const metas = await storage.listMetadata();

      expect(metas).toHaveLength(1);
      expect(metas[0].id).toBe('good');
    });

    it('reports an incomplete scan when a metadata file cannot be read', async () => {
      mockAdapter.listFiles.mockImplementation(async (path: string) => (
        path === SESSIONS_PATH
          ? [
            `${SESSIONS_PATH}/good.meta.json`,
            `${SESSIONS_PATH}/bad.meta.json`,
          ]
          : []
      ));
      mockAdapter.read.mockImplementation(async (path: string) => {
        if (path.endsWith('/bad.meta.json')) {
          throw new Error('Read error');
        }
        return JSON.stringify({
          id: 'good',
          title: 'Good',
          createdAt: 1,
          lastActivityAt: 2,
        });
      });

      await expect(storage.scanMetadata()).resolves.toEqual({
        metadata: [expect.objectContaining({ id: 'good' })],
        complete: false,
        invalidMetadataCount: 0,
      });
    });

    it('reports malformed metadata without making the I/O scan incomplete', async () => {
      mockAdapter.listFiles.mockImplementation(async (path: string) => (
        path === SESSIONS_PATH
          ? [`${SESSIONS_PATH}/malformed.meta.json`]
          : []
      ));
      mockAdapter.read.mockResolvedValue('{"id":');

      await expect(storage.scanMetadata()).resolves.toEqual({
        metadata: [],
        complete: true,
        invalidMetadataCount: 1,
      });
    });

    it('does not scan the retired metadata namespace', async () => {
      mockAdapter.listFiles.mockImplementation(async path => path === '.claude/sessions' ? ['.claude/sessions/retired.meta.json'] : []);
      expect(await storage.listMetadata()).toEqual([]);
      expect(mockAdapter.listFiles).not.toHaveBeenCalledWith('.claude/sessions');
      expect(mockAdapter.read).not.toHaveBeenCalled();
      expect(mockAdapter.write).not.toHaveBeenCalled();
      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('skips metadata whose JSON id does not match the filename without modifying it', async () => {
      const original = JSON.stringify({
        id: 'different-id',
        title: 'Mismatch',
        createdAt: 1,
        lastActivityAt: 1,
      });
      mockAdapter.listFiles.mockResolvedValue([
        '.claudian/sessions/filename-id.meta.json',
        '.claudian/sessions/%2Funsafe.meta.json',
      ]);
      mockAdapter.read.mockResolvedValue(original);

      await expect(storage.listMetadata()).resolves.toEqual([]);
      expect(mockAdapter.read).toHaveBeenCalledTimes(1);
      expect(mockAdapter.write).not.toHaveBeenCalled();
      expect(mockAdapter.delete).not.toHaveBeenCalled();
    });

    it('reads metadata with bounded concurrency while preserving file order', async () => {
      const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`);
      let activeReads = 0;
      let maxActiveReads = 0;

      mockAdapter.listFiles.mockImplementation(async (path: string) => (
        path === SESSIONS_PATH
          ? ids.map(id => `${SESSIONS_PATH}/${id}.meta.json`)
          : []
      ));
      mockAdapter.read.mockImplementation(async (path: string) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise(resolve => setTimeout(resolve, 1));
        activeReads -= 1;
        const id = path.split('/').pop()!.replace('.meta.json', '');
        return JSON.stringify({ id, title: id, createdAt: 1, lastActivityAt: 1 });
      });

      const metas = await storage.listMetadata();

      expect(maxActiveReads).toBeGreaterThan(1);
      expect(maxActiveReads).toBeLessThanOrEqual(8);
      expect(metas.map(meta => meta.id)).toEqual(ids);
    });

    it('publishes completed metadata batches before the full scan settles', async () => {
      const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`);
      const blockedIds = new Set(ids.slice(4));
      let releaseBlockedReads!: () => void;
      const blockedReads = new Promise<void>(resolve => {
        releaseBlockedReads = resolve;
      });
      const onBatch = vi.fn();
      mockAdapter.listFiles.mockImplementation(async (path: string) => (
        path === SESSIONS_PATH
          ? ids.map(id => `${SESSIONS_PATH}/${id}.meta.json`)
          : []
      ));
      mockAdapter.read.mockImplementation(async (path: string) => {
        const id = path.split('/').pop()!.replace('.meta.json', '');
        if (blockedIds.has(id)) {
          await blockedReads;
        }
        return JSON.stringify({ id, title: id, createdAt: 1, lastActivityAt: 1 });
      });

      const scan = storage.listMetadata({ onBatch, batchSize: 4 });
      for (let attempt = 0; attempt < 10 && onBatch.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(onBatch).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: 'session-0' }),
      ]));

      releaseBlockedReads();
      await expect(scan).resolves.toHaveLength(ids.length);
    });
  });

});
