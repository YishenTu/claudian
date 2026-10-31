import '@/providers';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { clearWriteFaults, failWritesUnder } from '@test/helpers/core/fsWriteFaults';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { SessionMetadata } from '@/core/types';

vi.mock('node:fs/promises', async () => {
  const { createFsPromisesWithWriteFaults } = await vi.importActual<typeof import('@test/helpers/core/fsWriteFaults')>('@test/helpers/core/fsWriteFaults');
  return createFsPromisesWithWriteFaults();
});

const devicePath = getDeviceSessionsPath(`device-${'a'.repeat(64)}`);
let vault: DesktopVault;
let store: ConversationPersistenceStore;
let projects: ProjectService;
let repository: ConversationRepository;

function createRepository(): ConversationRepository {
  return new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}),
    getVaultPath: () => vault.root,
    persistence: store,
    onConversationDeleted: async () => undefined,
    projects,
  });
}

async function adoptStored(target = repository): Promise<void> {
  const { records, complete } = await store.metadataReader.scan();
  expect(complete).toBe(true);
  await target.adoptMetadataConversations(records.map(({ metadata, ...record }) => ({
    ...record, conversation: { ...metadata, providerId: metadata.providerId!, sessionId: null, messages: [] },
  })));
}

function readMetadata(id: string, folder = devicePath): Promise<SessionMetadata> {
  return vault.read(`${folder}/${id}.meta.json`).then(content => JSON.parse(content));
}

beforeEach(async () => {
  vault = await DesktopVault.create();
  store = new ConversationPersistenceStore(vault.files, `device-${'a'.repeat(64)}`);
  projects = new ProjectService([], { store: new ProjectStore(vault.files), memory: vault.files });
  repository = createRepository();
});

afterEach(async () => {
  clearWriteFaults();
  vi.restoreAllMocks();
  await vault.dispose();
});

test('creates normalized Linked content that survives storage and repository reload', async () => {
  const conversation = await repository.create({
    sessionId: 'linked-content-session', selectedModel: 'sonnet',
    linkedContentPath: 'Projects\\Research//Plan.md',
  });
  expect(await readMetadata(conversation.id)).toMatchObject({ id: conversation.id, linkedContentPath: 'Projects/Research/Plan.md' });
  expect(await readMetadata(conversation.id)).not.toHaveProperty('currentNote');
  const reloaded = createRepository();
  await adoptStored(reloaded);
  expect(reloaded.getSync(conversation.id)!.linkedContentPath).toBe('Projects/Research/Plan.md');
  expect(reloaded.list()[0]).toMatchObject({ linkedContentPath: 'Projects/Research/Plan.md', selectedModel: 'sonnet' });
});

test('rejects invalid creation before writing and removes a failed creation before retry', async () => {
  await expect(repository.create({ linkedContentPath: '../outside' })).rejects.toThrow('Invalid Linked content path');
  expect(repository.getAll()).toEqual([]);
  expect(await vault.snapshot()).toEqual(new Map());

  failWritesUnder(vault.resolve(devicePath));
  const input = { sessionId: 'retry', linkedContentPath: 'Projects/Plan.md' };
  await expect(repository.create(input)).rejects.toThrow('ENOSPC');
  expect(repository.getAll()).toEqual([]);
  expect(repository.list()).toEqual([]);
  expect(await vault.exists(`${devicePath}/retry.meta.json`)).toBe(false);
  clearWriteFaults();
  await expect(repository.create(input)).resolves.toMatchObject({ id: 'retry', linkedContentPath: 'Projects/Plan.md' });
  expect(repository.getAll().filter(({ id }) => id === 'retry')).toHaveLength(1);
  expect(await readMetadata('retry')).toMatchObject({ linkedContentPath: 'Projects/Plan.md' });
});

test('persists pin and archive changes without treating metadata or snapshots as activity', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(testDate({ minutes: -10 }).getTime());
  const conversation = await repository.create({ selectedModel: 'sonnet' });
  now.mockRestore();
  const { id, lastActivityAt } = conversation;
  await repository.setPlacement(id, { isPinned: true });
  expect(repository.list()[0]).toMatchObject({ isPinned: true, lastActivityAt });
  expect(await readMetadata(id)).toMatchObject({ isPinned: true, lastActivityAt });
  await repository.rename(id, 'Renamed');
  repository.registerExecutionBinding(id, 'binding-1', 1);
  await repository.persistExecutionSnapshot(id, 'binding-1', 1, {
    providerId: 'claude', revision: 1, providerSessionId: 'native-session', status: 'idle',
  });
  expect(await readMetadata(id)).toMatchObject({ title: 'Renamed', lastActivityAt });
  expect(repository.getSync(id)!.lastActivityAt).toBe(lastActivityAt);
  await repository.setArchived(id, true);
  expect(repository.list()[0]).toMatchObject({ isArchived: true, isPinned: false, lastActivityAt });
  expect(await readMetadata(id)).toMatchObject({ isArchived: true, isPinned: false, lastActivityAt });
  await repository.setPlacement(id, { isPinned: true });
  expect(repository.getSync(id)!.isPinned).toBe(false);
  expect((await readMetadata(id)).isPinned).toBe(false);
  await repository.setArchived(id, false);
  const reloaded = createRepository();
  await adoptStored(reloaded);
  expect(reloaded.getSync(id)).toMatchObject({ isArchived: false, isPinned: false, lastActivityAt });
});

test('keeps Linked content immutable through patches and detached snapshots', async () => {
  const { id, lastActivityAt } = await repository.create({ linkedContentPath: 'Projects/Authoritative' });
  const write = vi.spyOn(vault.files, 'write');
  const update = repository.update.bind(repository) as (id: string, patch: Record<string, unknown>) => Promise<void>;
  for (const patch of [{ linkedContentPath: 'Other' }, { linkedContentPath: undefined }, { projectId: 'project-a' }, { projectId: undefined }]) {
    await expect(update(id, patch)).rejects.toThrow('immutable');
  }
  expect(write).not.toHaveBeenCalled();
  expect(repository.getSync(id)).toMatchObject({ linkedContentPath: 'Projects/Authoritative', lastActivityAt });
  const snapshot = repository.getSync(id)! as { linkedContentPath?: string };
  snapshot.linkedContentPath = 'Projects/Leaked';
  await repository.persistConversations(repository.getAll());
  expect(await readMetadata(id)).toMatchObject({ linkedContentPath: 'Projects/Authoritative', lastActivityAt });
  snapshot.linkedContentPath = undefined;
  expect(repository.list()[0].linkedContentPath).toBe('Projects/Authoritative');
  expect(repository.getSync(id)!.linkedContentPath).toBe('Projects/Authoritative');
});

test('persists exact and descendant renames, including late metadata, without renaming a new reuse', async () => {
  const file = await repository.create({ linkedContentPath: 'Notes/Old.md' });
  const folder = await repository.create({ linkedContentPath: 'Projects/Old/Plan.md' });
  const unrelated = await repository.create({ linkedContentPath: 'Notes/Other.md' });
  await store.saveMetadata({
    id: 'late', providerId: 'claude', title: 'Late', selectedModel: 'sonnet',
    linkedContentPath: 'Notes/Old.md', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  });
  await store.saveMetadata({
    id: 'late-direct', providerId: 'claude', title: 'Direct adoption', selectedModel: 'sonnet',
    linkedContentPath: 'Notes/Old.md', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  });
  await repository.rewriteLinkedContentPaths('Notes/Old.md', 'Notes/New.md');
  await repository.rewriteLinkedContentPaths('Projects/Old', 'Projects/New', { includeDescendants: true });
  const published = (await store.metadataReader.load('late'))!;
  // SessionMetadataLoader publishes each scan batch before the final durable adoption.
  repository.mergeMetadataConversations([{
    ...published.metadata, providerId: 'claude', sessionId: null, messages: [],
  }]);
  expect(repository.getSync('late')!.linkedContentPath).toBe('Notes/New.md');
  expect((await readMetadata('late')).linkedContentPath).toBe('Notes/Old.md');
  await adoptStored();
  expect(repository.getSync('late-direct')!.linkedContentPath).toBe('Notes/New.md');
  expect((await readMetadata('late-direct')).linkedContentPath).toBe('Notes/New.md');
  expect(repository.getSync('late')!.linkedContentPath).toBe('Notes/New.md');
  expect((await readMetadata('late')).linkedContentPath).toBe('Notes/New.md');
  const reused = await repository.create({ linkedContentPath: 'Notes/Old.md' });
  await repository.rewriteLinkedContentPaths('Notes/New.md', 'Notes/Final.md');
  for (const [conversation, linkedContentPath] of [
    [file, 'Notes/Final.md'], [folder, 'Projects/New/Plan.md'],
    [unrelated, 'Notes/Other.md'], [reused, 'Notes/Old.md'],
  ] as const) {
    expect(repository.getSync(conversation.id)).toMatchObject({ linkedContentPath, lastActivityAt: conversation.lastActivityAt });
    expect(await readMetadata(conversation.id)).toMatchObject({ linkedContentPath, lastActivityAt: conversation.lastActivityAt });
  }
});

test('retains unscoped write authority after a failed assignment and switches only after a durable move', async () => {
  const id = 'unscoped';
  await store.saveMetadata({ id, providerId: 'claude', title: 'Original', selectedModel: 'sonnet',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime() }, 'unscoped');
  await adoptStored();
  const rename = vi.spyOn(vault.app.vault.adapter, 'rename').mockRejectedValueOnce(new Error('rename failed'));
  await repository.rename(id, 'Still unscoped');
  expect((await readMetadata(id, SESSIONS_PATH)).title).toBe('Still unscoped');
  expect(await vault.exists(`${devicePath}/${id}.meta.json`)).toBe(false);
  expect(rename).not.toHaveBeenCalled();
  await expect(repository.assignToCurrentDevice(id)).rejects.toThrow('rename failed');
  expect(repository.list()[0].isLegacySession).toBe(true);
  await repository.rename(id, 'Legacy remains authoritative');
  expect((await readMetadata(id, SESSIONS_PATH)).title).toBe('Legacy remains authoritative');
  expect(await vault.exists(`${devicePath}/${id}.meta.json`)).toBe(false);
  await expect(repository.assignToCurrentDevice(id)).resolves.toBe(true);
  expect(await vault.exists(`${SESSIONS_PATH}/${id}.meta.json`)).toBe(false);
  expect(repository.list()[0].isLegacySession).toBe(false);
  expect((await readMetadata(id)).title).toBe('Legacy remains authoritative');
  await repository.rename(id, 'Device owned');
  expect((await readMetadata(id)).title).toBe('Device owned');
  const reloaded = createRepository();
  await adoptStored(reloaded);
  expect(reloaded.list()[0]).toMatchObject({ title: 'Device owned', isLegacySession: false });
});

test('migrates timestamps and Linked content without losing unhydrated provider history', async () => {
  const providerState = { providerSessionId: 'native-session', subagentData: {
    'task-1': { id: 'task-1', description: 'Completed background task', status: 'completed',
      result: 'Recovered result', toolCalls: [], isExpanded: false },
  } };
  const lastActivityAt = testDate({ minutes: -1 }).getTime();
  await vault.write(`${devicePath}/legacy.meta.json`, JSON.stringify({
    id: 'legacy', providerId: 'claude', title: 'Legacy', selectedModel: 'sonnet',
    createdAt: testDate({ minutes: -2 }).getTime(), lastResponseAt: lastActivityAt,
    currentNote: 'Notes\\Architecture.md', providerState,
  }));
  await adoptStored();
  const written = await readMetadata('legacy');
  expect(written).toMatchObject({ lastActivityAt, linkedContentPath: 'Notes/Architecture.md', providerState });
  for (const field of ['updatedAt', 'lastResponseAt', 'currentNote']) expect(written).not.toHaveProperty(field);
  expect((await store.metadataReader.load('legacy'))!.needsMigration).toBe(false);
});

test('persists live project membership across create, join, move and leave', async () => {
  const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'First.md' });
  const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
  const member = await repository.create({ projectId: first.id });
  const stray = await repository.create({ projectId: 'project-deleted' });
  expect(repository.getSync(member.id)!.projectId).toBe(first.id);
  expect((await readMetadata(member.id)).projectId).toBe(first.id);
  expect(repository.getSync(stray.id)).not.toHaveProperty('projectId');
  expect((await readMetadata(stray.id)).projectId).toBeUndefined();
  for (const projectId of [first.id, second.id, null]) {
    await repository.setPlacement(stray.id, { projectId });
    expect((await readMetadata(stray.id)).projectId).toBe(projectId ?? undefined);
    expect(repository.list().find(({ id }) => id === stray.id)!.projectId).toBe(projectId ?? undefined);
    expect(repository.getSync(stray.id)!.projectId).toBe(projectId ?? undefined);
  }
});

test('commits placement atomically, preserves omitted fields and rejects invalid projects before writing', async () => {
  const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'First.md' });
  const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
  const { id } = await repository.create({ projectId: first.id });
  await repository.setPlacement(id, { isPinned: true });
  const write = vi.spyOn(vault.files, 'write');
  await expect(repository.setPlacement(id, { projectId: 'project-deleted', isPinned: false })).rejects.toThrow('Unknown project: project-deleted');
  expect(repository.getSync(id)).toMatchObject({ projectId: first.id, isPinned: true });
  expect(await readMetadata(id)).toMatchObject({ projectId: first.id, isPinned: true });
  expect(write).not.toHaveBeenCalled();
  await repository.setPlacement(id, { projectId: second.id });
  expect(repository.getSync(id)).toMatchObject({ projectId: second.id, isPinned: true });
  await repository.setPlacement(id, { isPinned: false });
  expect(repository.getSync(id)).toMatchObject({ projectId: second.id, isPinned: false });
  await repository.setPlacement(id, { isPinned: true });
  write.mockClear();
  await repository.setPlacement(id, { projectId: first.id, isPinned: false });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await readMetadata(id)).toMatchObject({ projectId: first.id, isPinned: false });
  expect(repository.list().find(conversation => conversation.id === id)).toMatchObject({ projectId: first.id, isPinned: false });
  write.mockClear();
  await repository.setPlacement(id, { projectId: first.id, isPinned: false });
  await repository.setPlacement(id, {});
  expect(write).not.toHaveBeenCalled();
});
