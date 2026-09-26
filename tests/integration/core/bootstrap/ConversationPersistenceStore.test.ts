import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';
import { App, Notice, type Plugin } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { migrateSessionSidecars } from '@/core/bootstrap/migrateSessionSidecars';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, SessionMetadata } from '@/core/types';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';

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
    stat: async (file: string) => {
      const stat = await fs.stat(path.join(root, file));
      return { type: stat.isDirectory() ? 'folder' : 'file', mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size };
    },
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

test('writes compact metadata without changing its contents', async () => {
  const data = { ...metadata, providerState: { futureField: { values: ['one', 'two'], multiline: 'line one\nline two' } } };
  await store.saveMetadata(data);
  const content = await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`);
  expect(content).toBe(JSON.stringify(data));
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(data);
});

test('execution snapshots avoid history payload serialization while persistence retains subagent history', async () => {
  const subagent = {
    id: 'task-1', description: 'Research', isExpanded: false, status: 'completed' as const,
    result: 'Complete result', toolCalls: [{ id: 'read-1', name: 'Read', input: { file_path: 'note.md' },
      status: 'completed' as const, isExpanded: false, result: 'Full tool output' }],
  };
  const subagentData = { [subagent.id]: subagent };
  const serializeHistory = jest.fn(() => ({ [subagent.id]: subagent }));
  Object.defineProperty(subagentData, 'toJSON', { value: serializeHistory });
  const providerState = { providerSessionId: 'native-1', subagentData, futureField: { cursor: 'keep' } };
  const conversation: Conversation = {
    ...metadata, providerId: 'claude', sessionId: 'native-1', providerState,
    messages: [{ id: 'message-1', role: 'assistant', content: '', timestamp: testDate().getTime(),
      toolCalls: [{ id: subagent.id, name: 'Task', input: {}, status: 'completed', isExpanded: false, subagent }] }],
  };
  const session = new ClaudeExecutionBackend({ settings: {} } as ProviderHost).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: root,
    resumeSeed: { providerSessionId: 'native-1', providerState },
    interactionPort: { dismissInteraction() {}, requestApproval: async ({ interactionId }) => ({ interactionId, decision: 'deny' }),
      askUserQuestion: async ({ interactionId }) => ({ interactionId, answers: null }) },
  });
  const repository = createRepository();
  repository.replaceAll([conversation]);
  repository.registerExecutionBinding(conversation.id, 'binding', 0);
  try {
    for (let index = 0; index < 20; index++) session.getSnapshot();
    expect(serializeHistory).not.toHaveBeenCalled();
    const snapshot = session.getSnapshot();
    expect(snapshot.providerState).toEqual({ providerSessionId: 'native-1', futureField: { cursor: 'keep' } });
    expect(snapshot.providerStateDeletes ?? []).not.toContain('subagentData');
    await repository.persistExecutionSnapshot(conversation.id, 'binding', 0, snapshot);
    expect((await store.metadataReader.loadMetadata(conversation.id))?.providerState).toEqual(providerState);
    expect(conversation.messages[0].toolCalls?.[0].subagent).toBe(subagent);
  } finally {
    await session.dispose();
  }
});

test('initial metadata loading reads unchanged payloads once through the storage adapter', async () => {
  for (let index = 0; index < 25; index++) {
    await store.saveMetadata({ ...metadata, id: `saved-${index}` });
  }
  const read = jest.spyOn(adapter, 'read');
  const loader = new SessionMetadataLoader({
    sessions: store.metadataReader, conversations: createRepository(), runtimeSettings: {} as never,
    isUnloading: () => false, whenLayoutReady: callback => callback(), onConversationListChanged: () => undefined,
  });
  const result = await loader.readInitialMetadata();
  expect(result.records).toHaveLength(25);
  expect(result.complete).toBe(true);
  expect(result.records.every(record => record.source === 'device')).toBe(true);
  expect(read).toHaveBeenCalledTimes(25);
});

test('preserves higher-priority metadata authority when its stat is unavailable', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  const scanned = await store.metadataReader.scan();
  await store.saveMetadata({ ...metadata, title: 'Device owner' });
  const stat = app.vault.adapter.stat.bind(app.vault.adapter);
  jest.spyOn(app.vault.adapter, 'stat').mockImplementation(async file => {
    if (file === `${DEVICE_PATH}/${metadata.id}.meta.json`) throw new Error('Stat temporarily unavailable');
    return stat(file);
  });
  const resolved = await store.metadataReader.revalidate(scanned.records);
  expect(resolved).toEqual([expect.objectContaining({ source: 'device', metadata: expect.objectContaining({ title: 'Device owner' }) })]);
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

  const obsoleteInputs = await migrateSessionSidecars(adapter);
  expect(obsoleteInputs).toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);
  expect(await adapter.exists(obsoleteInputs[0])).toBe(true);
  for (const file of obsoleteInputs) await adapter.delete(file);
  expect(await migrateSessionSidecars(adapter)).toEqual([]);

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

  await expect(migrateSessionSidecars(adapter)).resolves.toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual([`${metadata.id}.inputs.json`, `${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

test('initialization loads settings while sidecar discovery is pending and waits for assignment recovery', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
  const list = app.vault.adapter.list.bind(app.vault.adapter);
  let entered!: () => void;
  const listingStarted = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const listingGate = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(app.vault.adapter, 'list').mockImplementation(async folder => {
    entered();
    await listingGate;
    return list(folder);
  });
  const exists = jest.spyOn(app.vault.adapter, 'exists');
  const storage = new SharedStorageService({ app } as Plugin);
  let finished = false;
  const initializing = storage.initialize().then(result => { finished = true; return result; });
  try {
    await listingStarted;
    expect(exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    expect(finished).toBe(false);
  } finally {
    release();
    await initializing;
  }
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.meta.json`)).toBe(false);
});

test('initialization joins recovery before reporting a settings failure', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, '{}');
  const failure = new Error('Settings unavailable');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  jest.spyOn(app.vault.adapter, 'read').mockImplementation(file => {
    if (file === CLAUDIAN_SETTINGS_PATH) return Promise.reject(failure);
    return read(file);
  });
  const storage = new SharedStorageService({ app } as Plugin);
  await expect(storage.initialize()).rejects.toBe(failure);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.assigned.json`)).toBe(false);
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
    const original = app.vault.adapter[operation].bind(app.vault.adapter) as (...args: string[]) => ReturnType<App['vault']['adapter'][typeof operation]>;
    let failed = false;
    jest.spyOn(app.vault.adapter, operation).mockImplementation((...args: string[]): ReturnType<App['vault']['adapter'][typeof operation]> => {
      if (!failed && args[0].startsWith(SESSIONS_PATH)) {
        failed = true;
        throw new Error('Storage unavailable');
      }
      return original(...args);
    });
    jest.mocked(Notice).mockClear();

    await expect(storage.initialize()).resolves.toMatchObject({ claudian: { userName: 'Example' } });
    expect(Notice).toHaveBeenCalledWith('Failed to clean up obsolete session files; will retry next launch');

    await storage.initialize();
    expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
    expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  },
);
