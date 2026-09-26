import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { App, Notice, type Plugin } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { migrateSessionSidecars } from '@/core/bootstrap/migrateSessionSidecars';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, SessionMetadata } from '@/core/types';

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
const DEVICE_PATH = getDeviceSessionsPath(DEVICE_KEY);
const metadata: SessionMetadata = {
  id: 'conversation-1', providerId: 'claude', title: 'Example', createdAt: 1, lastActivityAt: 2,
};

let root: string;
let app: App;
let adapter: VaultFileAdapter;
let store: ConversationPersistenceStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-metadata-'));
  app = new App();
  app.vault.adapter = {
    exists: async (file: string) => fs.access(path.join(root, file)).then(() => true, () => false),
    read: (file: string) => fs.readFile(path.join(root, file), 'utf8'),
    write: (file: string, data: string) => fs.writeFile(path.join(root, file), data),
    mkdir: (file: string) => fs.mkdir(path.join(root, file), { recursive: true }),
    remove: (file: string) => fs.unlink(path.join(root, file)),
    rename: (source: string, target: string) => fs.rename(path.join(root, source), path.join(root, target)),
    list: async (folder: string) => {
      const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${folder}/${entry.name}`),
      };
    },
  } as unknown as App['vault']['adapter'];
  adapter = new VaultFileAdapter(app);
  store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

test('assignment moves the metadata to its device and the shared folder contains only the device directory', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await store.assignMetadataToDevice(metadata.id);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

function createRepository() {
  return new ConversationRepository({
    persistence: store, getSettings: () => ({}), getVaultPath: () => root,
    onConversationDeleted: async () => undefined,
  });
}

test('deleting a conversation removes its metadata while leaving provider history intact', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  const nativePath = 'provider/session.jsonl';
  await adapter.write(nativePath, 'native history');

  await repository.delete(conversation.id);

  expect(await adapter.listFiles(DEVICE_PATH)).toEqual([]);
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
  expect(await adapter.read(nativePath)).toBe('native history');
});

test('reopening uses provider messages as the authoritative history', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'claude', sessionId: 'native-session', messages: [] };
  repository.replaceAll([conversation]);
  const nativeMessage = {
    id: 'native-message', userMessageId: 'native-user', role: 'user' as const,
    content: 'Provider text', displayContent: 'Provider text', timestamp: 2,
  };
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async (target: Conversation) => { target.messages = [nativeMessage]; },
  } as unknown as ReturnType<typeof ProviderRegistry.getConversationHistoryService>);
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, records: [{
      schemaVersion: 1, id: 'old-input', state: 'accepted', userTurnOrdinal: 1,
      providerUserMessageId: 'native-user', timestamp: 2,
      rawDisplayText: 'Old overlay', canonicalText: 'Old overlay', images: [], contentDigest: 'a'.repeat(64),
    }],
  }));

  const reopened = await repository.ensureHydrated(metadata.id);

  expect(reopened?.messages[0]?.displayContent).toBe('Provider text');
});

test('migration completes old assignments and deletions before removing their sidecars', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  const removed = { ...metadata, id: 'removed' };
  await store.saveMetadata(removed);
  await adapter.write(`${DEVICE_PATH}/removed.deleted.json`, JSON.stringify({
    schemaVersion: 1, conversationId: removed.id, deletedAt: 3,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');

  await migrateSessionSidecars(adapter);
  await migrateSessionSidecars(adapter);

  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(removed.id)).toBeNull();
});

test('migration retains assigned metadata and respects the scope of old deletion markers', async () => {
  const otherKey = `device-${'b'.repeat(64)}`;
  const otherPath = getDeviceSessionsPath(otherKey);
  await store.saveMetadata({ ...metadata, title: 'Stale shared copy' }, 'unscoped');
  await adapter.write(`${otherPath}/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: otherKey,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.deleted.json`, '{}');
  await adapter.write(`.claude/sessions/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await store.saveMetadata({ ...metadata, id: 'device-deleted' });
  await store.saveMetadata({ ...metadata, id: 'device-deleted', title: 'Shared' }, 'unscoped');
  await adapter.write(`${DEVICE_PATH}/device-deleted.deleted.json`, '{}');

  await migrateSessionSidecars(adapter);

  const otherStore = new ConversationPersistenceStore(adapter, otherKey);
  expect(await otherStore.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
  expect(await store.metadataReader.loadMetadata('device-deleted')).toEqual({
    ...metadata, id: 'device-deleted', title: 'Shared',
  });
});

test.each(['{', JSON.stringify({ schemaVersion: 1, conversationId: metadata.id, deviceKey: '../invalid' })])(
  'migration retains unassigned metadata when its obsolete assignment is invalid: %s', async (content) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, content);

    await migrateSessionSidecars(adapter);

    expect(await store.metadataReader.load(metadata.id)).toEqual({ metadata, source: 'unscoped', needsMigration: false });
    expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${SESSIONS_PATH}/${metadata.id}.meta.json`]);
  },
);

test('a deletion started during an execution authority check rejects the handoff', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  repository.registerExecutionBinding(conversation.id, 'binding', 0);
  const authority = repository.assertConversationExecutionAuthority(conversation.id, 'binding', 0);
  const deletion = repository.delete(conversation.id);

  await expect(authority).rejects.toThrow('no longer available');
  await deletion;
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
});

test('a delayed scan cannot undo a local assignment or redirect later writes and deletion', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'claude', sessionId: null, messages: [] };
  await store.saveMetadata(metadata, 'unscoped');
  const entry = { conversation, source: 'unscoped' as const, needsMigration: false };
  await repository.adoptMetadataConversations([entry]);
  const scanned = await store.metadataReader.load(metadata.id);

  await repository.assignToCurrentDevice(metadata.id);
  await repository.adoptMetadataConversations([{ ...entry, ...scanned!, conversation }]);
  await repository.rename(metadata.id, 'Assigned title');

  expect(await store.metadataReader.load(metadata.id)).toMatchObject({ source: 'device', metadata: { title: 'Assigned title' } });
  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  await repository.delete(metadata.id);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
});


test('migration continues when a listed assignment disappears before it is read', async () => {
  const assignmentPath = `${SESSIONS_PATH}/${metadata.id}.assigned.json`;
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(assignmentPath, '{}');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  jest.spyOn(app.vault.adapter, 'read').mockImplementation(async (file) => {
    if (file === assignmentPath) await fs.unlink(path.join(root, file));
    return read(file);
  });

  await expect(migrateSessionSidecars(adapter)).resolves.toBeUndefined();

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual([`${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

test.each(['list', 'read', 'rename'] as const)(
  'initialization loads settings after a cleanup %s failure and retries next time',
  async (operation) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
      schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
    }));
    await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
    const storage = new SharedStorageService({ app } as Plugin);
    jest.spyOn(app.vault.adapter, operation).mockRejectedValueOnce(new Error('Storage unavailable'));
    jest.mocked(Notice).mockClear();

    await expect(storage.initialize()).resolves.toMatchObject({ claudian: { userName: 'Example' } });
    expect(Notice).toHaveBeenCalledWith('Failed to clean up obsolete session files; will retry next launch');

    await storage.initialize();
    expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
    expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  },
);
