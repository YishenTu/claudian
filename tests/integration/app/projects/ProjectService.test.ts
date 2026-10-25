import '@/providers';

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createFixture as createDraftFixture, deferred } from '@test/helpers/ChatInputHarness';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationService } from '@/app/conversations/ConversationService';
import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { defaultProjectMemoryPath, projectMemoryFolderOf } from '@/core/path/ProjectMemoryPath';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { type Conversation, ProjectMemoryConflictError, ProjectMemoryPathTakenError } from '@/core/types';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fs>('node:fs/promises');
  return { ...actual, link: jest.fn(actual.link), rename: jest.fn(actual.rename), writeFile: jest.fn(actual.writeFile) };
});
const actualFs = jest.requireActual<typeof fs>('node:fs/promises');

const vaults: DesktopVault[] = [];
afterEach(async () => {
  allowWrites();
  jest.mocked(fs.rename).mockClear();
  await Promise.all(vaults.splice(0).map(vault => vault.dispose()));
});

async function createVault(): Promise<DesktopVault> {
  const vault = await DesktopVault.create();
  vaults.push(vault);
  return vault;
}

/** Fails every file write into a vault folder until `allowWrites`. */
function failWritesInto(vault: DesktopVault, folder: string): void {
  jest.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
    if (path.dirname(String(file)) === vault.resolve(folder)) throw new Error('disk full');
    return actualFs.writeFile(file, data, options);
  });
}

function allowWrites(): void {
  jest.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
}

const TEMPLATE_SECTIONS = '## Goal\n\n## Requirements\n\n## Decisions\n\n## State\n\n## Open questions\n\n## Dead ends\n';

function conversation(id: string, projectId?: string): Conversation {
  return {
    id, providerId: 'claude', title: id, sessionId: null,
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), messages: [],
    ...(projectId ? { projectId } : {}),
  };
}

async function fixture(options: { vault?: DesktopVault; conversations?: Conversation[] } = {}) {
  const vault = options.vault ?? await createVault();
  const files = vault.files;
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const store = new ProjectStore(files);
  const loaded = await store.load();
  const persistence = {
    metadataReader: {} as never,
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
  };
  const onConversationListChanged = jest.fn();
  const projects = new ProjectService(loaded.records, { store, memory: files });
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings,
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted: async () => undefined,
    projects,
  });
  repository.replaceAll(options.conversations ?? []);
  const conversations = new ConversationService({
    repository,
    projects,
    sessionMetadata: { ensureLoaded: async () => undefined },
    pinnedLinkedContentPaths: {} as never,
    nativeSessionArchives: { sync: async () => undefined },
    onConversationListChanged,
  });
  return { vault, settings, store, loaded, projects, repository, conversations, persistence, onConversationListChanged };
}

function readFile(vault: DesktopVault, relativePath: string): Promise<string | undefined> {
  return vault.read(relativePath).catch(() => undefined);
}

describe('ProjectService', () => {
  it('creates a persisted record and a template memory file at the given path, creating its folders', async () => {
    const { vault, projects } = await fixture();
    const changed = jest.fn();
    projects.onChanged(changed);

    const record = await projects.create({
      name: 'Q3 Launch: Plan!', instructions: 'Ship it.', memoryPath: '.claudian/projects/q3-launch-plan/MEMORY.md',
    });

    expect(record.memoryPath).toBe('.claudian/projects/q3-launch-plan/MEMORY.md');
    expect(await vault.isFolder('.claudian/projects/q3-launch-plan')).toBe(true);
    expect(await readFile(vault, record.memoryPath)).toBe(`# Q3 Launch: Plan!\n\n${TEMPLATE_SECTIONS}`);
    expect(JSON.parse((await readFile(vault, `${PROJECTS_PATH}/${record.id}.json`))!)).toEqual({
      id: record.id,
      name: 'Q3 Launch: Plan!',
      instructions: 'Ship it.',
      memoryPath: record.memoryPath,
      isPinned: false,
      isArchived: false,
      createdAt: record.createdAt,
    });
    expect(projects.get(record.id)).toEqual(record);
    expect(projects.list()).toEqual([record]);
    expect(changed).toHaveBeenCalledTimes(1);
    // Only the memory file itself is left behind; the write leaves no temporary sibling.
    expect([...(await vault.snapshot()).keys()].filter(path => path.startsWith('.claudian/projects/q3-launch-plan/')))
      .toEqual([record.memoryPath]);
  });

  it('creates memory files at custom paths, including nested new folders and the vault root', async () => {
    const { vault, projects } = await fixture();

    const work = await projects.create({ name: 'Work Plan', instructions: '', memoryPath: ' /Work//Plans/Launch ' });
    const root = await projects.create({ name: 'Root Plan', instructions: '', memoryPath: 'Root.md' });

    expect(work.memoryPath).toBe('Work/Plans/Launch.md');
    expect(await vault.isFolder('Work')).toBe(true);
    expect(await vault.isFolder('Work/Plans')).toBe(true);
    expect(await readFile(vault, 'Work/Plans/Launch.md')).toBe(`# Work Plan\n\n${TEMPLATE_SECTIONS}`);
    expect(root.memoryPath).toBe('Root.md');
    expect(await readFile(vault, 'Root.md')).toBe(`# Root Plan\n\n${TEMPLATE_SECTIONS}`);
    const reloaded = await fixture({ vault });
    expect(reloaded.projects.get(work.id)?.memoryPath).toBe('Work/Plans/Launch.md');
    expect(reloaded.projects.get(root.id)?.memoryPath).toBe('Root.md');
    const read = await reloaded.projects.readMemory(root.id);
    if ('missing' in read) throw new Error('Expected the root-level memory file to load');
    await reloaded.projects.saveMemory(root.id, '# Root Plan\n\nUpdated\n', read.revision);
    expect(await readFile(vault, 'Root.md')).toBe('# Root Plan\n\nUpdated\n');
  });

  it.each(['../outside.md', 'C:/Docs/MEMORY.md', 'Work/', ''])(
    'rejects the invalid memory path %p without creating a project',
    async (memoryPath) => {
      const { vault, projects } = await fixture();
      const before = await vault.snapshot();

      await expect(projects.create({ name: 'Escape', instructions: '', memoryPath })).rejects.toThrow('memory path');

      expect(projects.list()).toEqual([]);
      expect(await vault.snapshot()).toEqual(before);
    },
  );

  it('refuses to create a project over an existing file and leaves that file untouched', async () => {
    const vault = await createVault();
    await vault.write('Work/MEMORY.md', '# Someone else\n');
    const { projects } = await fixture({ vault });
    const before = await vault.snapshot();
    const changed = jest.fn();
    projects.onChanged(changed);

    const attempt = projects.create({ name: 'Taken', instructions: '', memoryPath: 'Work/MEMORY.md' });

    await expect(attempt).rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    await expect(attempt).rejects.toMatchObject({ path: 'Work/MEMORY.md' });
    expect(await vault.snapshot()).toEqual(before);
    expect(projects.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(['ENOTSUP', 'EPERM'])('creates and relocates memory on a vault without hard links (%s)', async code => {
    const vault = await DesktopVault.create();
    const link = jest.mocked(fs.link).mockRejectedValue(Object.assign(new Error('hard links unsupported'), { code }));
    try {
      const store = new ProjectStore(vault.files);
      const projects = new ProjectService([], { store, memory: vault.files });

      const record = await projects.create({ name: 'Portable', instructions: '', memoryPath: 'Work/MEMORY.md' });
      expect(await vault.read('Work/MEMORY.md')).toBe(`# Portable\n\n${TEMPLATE_SECTIONS}`);

      await projects.update(record.id, { memoryPath: 'Moved/MEMORY.md' });
      expect(await vault.read('Moved/MEMORY.md')).toBe(`# Portable\n\n${TEMPLATE_SECTIONS}`);
      expect(await vault.exists('Work/MEMORY.md')).toBe(false);
      expect((await store.load()).records).toEqual([{ ...record, memoryPath: 'Moved/MEMORY.md' }]);
    } finally {
      link.mockReset().mockImplementation(jest.requireActual<typeof fs>('node:fs/promises').link);
      await vault.dispose();
    }
  });

  it('removes the new memory file when the record cannot be saved, so a retry can create it', async () => {
    const { vault, projects } = await fixture();
    failWritesInto(vault, PROJECTS_PATH);

    await expect(projects.create({ name: 'Retry', instructions: '', memoryPath: 'Retry.md' })).rejects.toThrow();
    expect(await vault.exists('Retry.md')).toBe(false);
    expect(projects.list()).toEqual([]);

    allowWrites();
    const record = await projects.create({ name: 'Retry', instructions: '', memoryPath: 'Retry.md' });
    expect(await readFile(vault, record.memoryPath)).toBe(`# Retry\n\n${TEMPLATE_SECTIONS}`);
  });

  it.each([
    ['renames it within its folder', '.claudian/projects/launch/PLAN.md'],
    ['moves it into another, new folder', 'Work/Plans/Launch.md'],
    ['moves it into the vault root', '/Launch'],
  ])('%s with its edits and persists the new path', async (_label, memoryPath) => {
    const { vault, projects } = await fixture();
    const record = await projects.create({
      name: 'Launch', instructions: '', memoryPath: '.claudian/projects/launch/MEMORY.md',
    });
    const read = await projects.readMemory(record.id);
    if ('missing' in read) throw new Error('memory file should exist');
    await projects.saveMemory(record.id, '# Launch\n\nEdited\n', read.revision);
    const changed = jest.fn();
    projects.onChanged(changed);

    await projects.update(record.id, { name: 'Launch v2', memoryPath });

    const expected = memoryPath === '/Launch' ? 'Launch.md' : memoryPath;
    expect(projects.get(record.id)).toMatchObject({ name: 'Launch v2', memoryPath: expected });
    expect(await readFile(vault, expected)).toBe('# Launch\n\nEdited\n');
    expect(await vault.exists(record.memoryPath)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const reloaded = await fixture({ vault });
    expect(reloaded.projects.get(record.id)).toMatchObject({ name: 'Launch v2', memoryPath: expected });
    await expect(reloaded.projects.readMemory(record.id)).resolves.toMatchObject({ content: '# Launch\n\nEdited\n' });
  });

  it('repoints a project whose memory file is missing without creating one', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Lost', instructions: '', memoryPath: 'Lost/MEMORY.md' });
    await vault.remove(record.memoryPath);

    await projects.update(record.id, { memoryPath: 'Elsewhere/Lost.md' });

    expect(projects.get(record.id)?.memoryPath).toBe('Elsewhere/Lost.md');
    expect(await vault.exists('Elsewhere/Lost.md')).toBe(false);
    await expect(projects.readMemory(record.id)).resolves.toEqual({ missing: true });
    const reloaded = await fixture({ vault });
    expect(reloaded.projects.get(record.id)?.memoryPath).toBe('Elsewhere/Lost.md');
  });

  it('refuses to move onto an existing file and changes neither the record nor any file', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Taken', instructions: 'Keep.', memoryPath: 'Taken/MEMORY.md' });
    await vault.write('Work/Notes.md', '# Someone else\n');
    const before = await vault.snapshot();
    const changed = jest.fn();
    projects.onChanged(changed);

    const attempt = projects.update(record.id, { name: 'Renamed', instructions: 'New.', memoryPath: 'Work/Notes.md' });

    await expect(attempt).rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    await expect(attempt).rejects.toMatchObject({ path: 'Work/Notes.md' });
    expect(projects.get(record.id)).toEqual(record);
    expect(await vault.snapshot()).toEqual(before);
    expect(await readFile(vault, record.memoryPath)).toBe(`# Taken\n\n${TEMPLATE_SECTIONS}`);
    expect(changed).not.toHaveBeenCalled();
  });

  it('treats a path another live project records as taken, even while its file is missing', async () => {
    const { vault, projects } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    await vault.remove(first.memoryPath);

    // Case differences name the same file on case-insensitive vaults.
    await expect(projects.create({ name: 'Second', instructions: '', memoryPath: 'shared/memory.md' }))
      .rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second/MEMORY.md' });
    await expect(projects.update(second.id, { memoryPath: 'Shared/MEMORY.md' }))
      .rejects.toMatchObject({ path: 'Shared/MEMORY.md' });
    expect(projects.get(second.id)?.memoryPath).toBe('Second/MEMORY.md');
    expect(await readFile(vault, second.memoryPath)).toBe(`# Second\n\n${TEMPLATE_SECTIONS}`);

    // Deleting the claim frees the path.
    await projects.delete(first.id);
    await projects.update(second.id, { memoryPath: 'Shared/MEMORY.md' });
    expect(await readFile(vault, 'Shared/MEMORY.md')).toBe(`# Second\n\n${TEMPLATE_SECTIONS}`);
  });

  it('lets only one of two concurrent moves claim the same missing-file path', async () => {
    const { vault, projects } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'First.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
    await vault.remove(first.memoryPath);
    await vault.remove(second.memoryPath);

    const results = await Promise.allSettled([
      projects.update(first.id, { memoryPath: 'Shared.md' }),
      projects.update(second.id, { memoryPath: 'Shared.md' }),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ProjectMemoryPathTakenError);
    expect(projects.list().map(record => record.memoryPath)).toEqual(['Shared.md', 'Second.md']);
  });

  it('never trashes a memory file another live project still records', async () => {
    const { vault, projects, store } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second/MEMORY.md' });
    // Overlapping records can come from an earlier version or another synced device.
    await store.save({ ...second, memoryPath: first.memoryPath });
    const reloaded = await fixture({ vault });

    await reloaded.projects.delete(first.id);

    expect(reloaded.projects.list().map(({ id }) => id)).toEqual([second.id]);
    expect(vault.trashed).toEqual([]);
    expect(await readFile(vault, first.memoryPath)).toBe(`# First\n\n${TEMPLATE_SECTIONS}`);
  });

  it('preserves another project’s shared memory when moving one project to a separate file', async () => {
    const { vault, projects, store } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
    await store.save({ ...second, memoryPath: first.memoryPath });
    const reloaded = await fixture({ vault });

    await reloaded.projects.update(second.id, { memoryPath: 'Split/MEMORY.md' });

    const sharedContent = `# First\n\n${TEMPLATE_SECTIONS}`;
    await expect(reloaded.projects.readMemory(first.id)).resolves.toMatchObject({ content: sharedContent });
    const split = await reloaded.projects.readMemory(second.id);
    if ('missing' in split) throw new Error('Expected the separate memory file');
    expect(split.content).toBe(sharedContent);
    await reloaded.projects.saveMemory(second.id, '# Separate edits\n', split.revision);
    await expect(reloaded.projects.readMemory(first.id)).resolves.toMatchObject({ content: sharedContent });
    await expect(reloaded.projects.readMemory(second.id)).resolves.toMatchObject({ content: '# Separate edits\n' });
    const persisted = await fixture({ vault });
    expect(persisted.projects.get(first.id)?.memoryPath).toBe(first.memoryPath);
    expect(persisted.projects.get(second.id)?.memoryPath).toBe('Split/MEMORY.md');
  });

  it('keeps shared memory and both records when saving a separated project fails', async () => {
    const { vault, projects, store } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
    await store.save({ ...second, memoryPath: first.memoryPath });
    const reloaded = await fixture({ vault });
    // The only record this update writes is the separated project's.
    failWritesInto(vault, PROJECTS_PATH);

    await expect(reloaded.projects.update(second.id, { memoryPath: 'Split/MEMORY.md' })).rejects.toThrow('Could not write managed resource');

    expect(await readFile(vault, 'Split/MEMORY.md')).toBeUndefined();
    for (const id of [first.id, second.id]) {
      expect(reloaded.projects.get(id)?.memoryPath).toBe(first.memoryPath);
      await expect(reloaded.projects.readMemory(id)).resolves.toMatchObject({ content: `# First\n\n${TEMPLATE_SECTIONS}` });
    }
    const persisted = await fixture({ vault });
    expect(persisted.projects.list().map(record => record.memoryPath)).toEqual([first.memoryPath, first.memoryPath]);
  });

  it('never replaces an existing destination while separating shared memory', async () => {
    const { vault, projects, store } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });
    await store.save({ ...second, memoryPath: first.memoryPath });
    const reloaded = await fixture({ vault });
    await vault.write('Split/MEMORY.md', '# Other writer\n');

    await expect(reloaded.projects.update(second.id, { memoryPath: 'Split/MEMORY.md' }))
      .rejects.toBeInstanceOf(ProjectMemoryPathTakenError);

    expect(await readFile(vault, 'Split/MEMORY.md')).toBe('# Other writer\n');
    expect([...(await vault.snapshot()).keys()].filter(path => path.startsWith('Split/'))).toEqual(['Split/MEMORY.md']);
    for (const id of [first.id, second.id]) {
      expect(reloaded.projects.get(id)?.memoryPath).toBe(first.memoryPath);
      await expect(reloaded.projects.readMemory(id)).resolves.toMatchObject({ content: `# First\n\n${TEMPLATE_SECTIONS}` });
    }
  });

  it('rejects an invalid memory path on update without changing anything', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Keep', instructions: '', memoryPath: 'Keep.md' });
    const before = await vault.snapshot();

    await expect(projects.update(record.id, { name: 'Renamed', memoryPath: '../Keep.md' })).rejects.toThrow('memory path');

    expect(projects.get(record.id)).toEqual(record);
    expect(await vault.snapshot()).toEqual(before);
  });

  it('keeps the memory file in place when the path is unchanged', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Stay', instructions: '', memoryPath: 'Stay/MEMORY.md' });
    const recordFile = await readFile(vault, `${PROJECTS_PATH}/${record.id}.json`);
    const changed = jest.fn();
    projects.onChanged(changed);
    const memoryMoves = () => jest.mocked(fs.rename).mock.calls.filter(([from]) => from === vault.resolve('Stay/MEMORY.md'));

    await projects.update(record.id, { memoryPath: '/Stay/./MEMORY' });
    expect(changed).not.toHaveBeenCalled();
    expect(await readFile(vault, `${PROJECTS_PATH}/${record.id}.json`)).toBe(recordFile);

    await projects.update(record.id, { name: 'Stay put', memoryPath: 'Stay/MEMORY.md' });
    expect(projects.get(record.id)).toMatchObject({ name: 'Stay put', memoryPath: 'Stay/MEMORY.md' });
    expect(await readFile(vault, 'Stay/MEMORY.md')).toContain('# Stay');
    expect(memoryMoves()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('archives a project, unpinning it, persists the state, and restores it', async () => {
    const memory = new MemoryDataAdapter();
    memory.addFolder('.claudian');
    memory.addFolder(PROJECTS_PATH);
    memory.addFile(`${PROJECTS_PATH}/kept.json`, JSON.stringify({
      id: 'kept', name: 'Kept', instructions: '', memoryPath: 'kept.md', isPinned: true, createdAt: 1,
    }));
    const { projects, store } = await fixture({ memory });
    const changed = jest.fn();
    projects.onChanged(changed);
    expect(projects.get('kept')?.isArchived).toBe(false);

    await projects.setArchived('kept', true);
    await projects.setArchived('kept', true);

    expect(projects.get('kept')).toMatchObject({ isArchived: true, isPinned: false });
    expect(JSON.parse(readFile(memory, `${PROJECTS_PATH}/kept.json`)!)).toMatchObject({ isArchived: true, isPinned: false });
    expect((await store.load()).records[0]).toMatchObject({ id: 'kept', isArchived: true, isPinned: false });
    expect(changed).toHaveBeenCalledTimes(1);

    await projects.setArchived('kept', false);
    expect(projects.get('kept')).toMatchObject({ isArchived: false, isPinned: false });
    // An archived project cannot be pinned.
    await projects.setArchived('kept', true);
    await projects.setPinned('kept', true);
    expect(projects.get('kept')?.isPinned).toBe(false);
  });

  it('skips an unparsable project file on load and never rewrites or deletes it', async () => {
    const vault = await createVault();
    await vault.write(`${PROJECTS_PATH}/broken.json`, '{"id": "broken", "name": ');
    await vault.write(`${PROJECTS_PATH}/mismatch.json`, JSON.stringify({
      id: 'other', name: 'Mismatch', instructions: '', memoryPath: 'a.md', isPinned: false, createdAt: 1,
    }));
    await vault.write(`${PROJECTS_PATH}/valid.json`, JSON.stringify({
      id: 'valid', name: 'Valid', instructions: 'Do', memoryPath: 'Docs/valid.md', isPinned: true, createdAt: 1,
    }));

    const { loaded, projects } = await fixture({ vault });
    const created = await projects.create({ name: 'New', instructions: '', memoryPath: 'New.md' });
    await projects.setPinned('valid', false);
    await projects.delete(created.id);

    expect(loaded.invalidCount).toBe(2);
    expect(projects.list().map(({ id }) => id)).toEqual(['valid']);
    expect(await readFile(vault, `${PROJECTS_PATH}/broken.json`)).toBe('{"id": "broken", "name": ');
    expect(JSON.parse((await readFile(vault, `${PROJECTS_PATH}/mismatch.json`))!).id).toBe('other');
  });

  it('detects a concurrent memory change, keeps it, and writes only with overwrite', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Memo', instructions: '', memoryPath: 'Memo.md' });
    const read = await projects.readMemory(record.id);
    if ('missing' in read) throw new Error('memory file should exist');
    await vault.write(record.memoryPath, '# Agent edit\n');

    await expect(projects.saveMemory(record.id, '# User edit\n', read.revision))
      .rejects.toBeInstanceOf(ProjectMemoryConflictError);
    expect(await readFile(vault, record.memoryPath)).toBe('# Agent edit\n');

    const saved = await projects.saveMemory(record.id, '# User edit\n', read.revision, { overwrite: true });
    expect(await readFile(vault, record.memoryPath)).toBe('# User edit\n');
    await expect(projects.readMemory(record.id)).resolves.toEqual(saved);
  });

  it('re-reads the memory file inside the write queue so two saves from one revision cannot both win', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Memo', instructions: '', memoryPath: 'Memo.md' });
    const read = await projects.readMemory(record.id);
    if ('missing' in read) throw new Error('memory file should exist');

    const results = await Promise.allSettled([
      projects.saveMemory(record.id, 'first', read.revision),
      projects.saveMemory(record.id, 'second', read.revision),
    ]);

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(await readFile(vault, record.memoryPath)).toBe('first');
  });

  it('reports a missing memory file and recreates it from the template at the recorded path', async () => {
    const { vault, projects } = await fixture();
    const record = await projects.create({ name: 'Recover', instructions: '', memoryPath: 'Recover.md' });
    await projects.update(record.id, { name: 'Recovered' });
    await vault.remove(record.memoryPath);

    await expect(projects.readMemory(record.id)).resolves.toEqual({ missing: true });
    const recreated = await projects.recreateMemory(record.id);

    expect(recreated.content).toBe(`# Recovered\n\n${TEMPLATE_SECTIONS}`);
    expect(await readFile(vault, record.memoryPath)).toBe(recreated.content);
    await expect(projects.readMemory(record.id)).resolves.toEqual(recreated);

    // A memory file that reappeared after the missing read (sync, undo) is kept and returned instead of the template.
    await vault.write(record.memoryPath, '# Restored by sync\n');
    const kept = await projects.recreateMemory(record.id);
    expect(await readFile(vault, record.memoryPath)).toBe('# Restored by sync\n');
    expect(kept).toEqual(await projects.readMemory(record.id));
    expect(kept.content).toBe('# Restored by sync\n');
  });

  it('deletes the record first, trashes the memory file and its emptied default folder, and blocks new joins', async () => {
    const { vault, projects, repository, conversations } = await fixture();
    const deleted = await projects.create({ name: 'Deleted', instructions: '', memoryPath: defaultProjectMemoryPath('Deleted') });
    const custom = await projects.create({ name: 'Custom', instructions: '', memoryPath: 'Notes/Custom.md' });
    const other = await projects.create({ name: 'Other', instructions: '', memoryPath: 'Other.md' });
    repository.replaceAll([conversation('outsider', other.id)]);
    const seenAtPublish: Array<boolean> = [];
    projects.onChanged(() => { seenAtPublish.push(!existsSync(vault.resolve(`${PROJECTS_PATH}/${deleted.id}.json`))); });

    await projects.delete(deleted.id);
    await projects.delete(custom.id);

    expect(projects.list()).toEqual([other]);
    expect(seenAtPublish).toEqual([true, true]);
    expect(await readFile(vault, `${PROJECTS_PATH}/${deleted.id}.json`)).toBeUndefined();
    expect(vault.trashed).toEqual([deleted.memoryPath, custom.memoryPath]);
    // Only a folder inside the projects folder is removed, and only once empty.
    expect(await vault.exists(projectMemoryFolderOf(deleted.memoryPath))).toBe(false);
    expect(await vault.exists('Notes')).toBe(true);
    expect(await readFile(vault, other.memoryPath)).toContain('# Other');
    await expect(conversations.setConversationsPlacement(['outsider'], { projectId: deleted.id }))
      .rejects.toThrow(`Unknown project: ${deleted.id}`);
    expect(repository.getSync('outsider')?.projectId).toBe(other.id);
  });

  it('drops a retained draft seed when its project is archived before first submission', async () => {
    const { projects, repository, conversations, persistence } = await fixture();
    const project = await projects.create({ name: 'Draft', instructions: '', memoryPath: 'Draft.md' });
    const draft = createDraftFixture();
    draft.state.currentConversationId = null;
    draft.deps.conversationController.seedDraftProject(project.id);
    draft.plugin.createConversation.mockImplementation(options => conversations.createConversation(options));
    draft.plugin.getConversationSync.mockImplementation(id => repository.getSync(id));
    await projects.setArchived(project.id, true);

    await draft.controller.sendMessage({ content: 'Submit the retained draft' });

    expect(draft.plugin.createConversation).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id }));
    expect(draft.state.currentConversationId).not.toBeNull();
    expect(repository.getSync(draft.state.currentConversationId!)?.projectId).toBeUndefined();
    expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].projectId).toBeUndefined();
    expect(projects.get(project.id)?.isArchived).toBe(true);
  });

  it('rejects placement into an archived project without changing membership or pinning', async () => {
    const { projects, repository, conversations } = await fixture({
      conversations: [{ ...conversation('outside'), isPinned: true }],
    });
    const project = await projects.create({ name: 'Archived', instructions: '', memoryPath: 'Archived.md' });
    await projects.setArchived(project.id, true);

    await expect(conversations.setConversationsPlacement(['outside'], { projectId: project.id, isPinned: false }))
      .rejects.toThrow(`Unknown project: ${project.id}`);

    expect(repository.getSync('outside')).toMatchObject({ isPinned: true });
    expect(repository.getSync('outside')?.projectId).toBeUndefined();
  });

  it.each(['move', 'restore', 'restore one', 'create'] as const)(
    'keeps a project active when a member arrives via %s during archive persistence',
    async (mutation) => {
      const { projects, repository, conversations, persistence } = await fixture();
      const project = await projects.create({ name: 'Race', instructions: '', memoryPath: 'Race.md' });
      repository.replaceAll([
        conversation('member', project.id),
        { ...conversation('arriving', mutation === 'move' ? undefined : project.id), isArchived: mutation !== 'move' },
      ]);
      const lifecycle = new ConversationLifecycle({
        conversations, projects,
        sessions: { get: () => null, isRunning: () => false, retire: async () => undefined, whenSettled: async () => true },
        views: { getAllViews: () => [] },
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      persistence.saveMetadata.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      const archiving = lifecycle.archiveProject(project.id);
      await entered.promise;
      if (mutation === 'move') await lifecycle.setPlacement(['arriving'], { projectId: project.id });
      else if (mutation === 'restore') await lifecycle.restore(['arriving']);
      else if (mutation === 'restore one') await lifecycle.setArchived('arriving', false);
      else await conversations.createConversation({ projectId: project.id });
      release.resolve();
      await archiving;

      expect(projects.get(project.id)?.isArchived).toBe(false);
      expect(conversations.getConversationList().some(record => record.projectId === project.id && !record.isArchived)).toBe(true);
    },
  );

  it.each(['move', 'restore', 'restore one', 'restore project', 'create'] as const)(
    'orders %s against the final project archive write',
    async (mutation) => {
      const { projects, repository, conversations, store, persistence } = await fixture();
      const project = await projects.create({ name: 'Final', instructions: '', memoryPath: 'Final.md' });
      repository.replaceAll([
        { ...conversation('arriving', mutation === 'move' ? undefined : project.id), isArchived: mutation !== 'move' },
      ]);
      const lifecycle = new ConversationLifecycle({
        conversations, projects,
        sessions: { get: () => null, isRunning: () => false, retire: async () => undefined, whenSettled: async () => true },
        views: { getAllViews: () => [] },
      });
      // Session restoration must not be persisted while its project is still archived.
      persistence.saveMetadata.mockImplementation(async metadata => {
        expect(metadata.projectId === project.id && !metadata.isArchived && projects.get(project.id)?.isArchived)
          .toBe(false);
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      const save = store.save.bind(store);
      jest.spyOn(store, 'save').mockImplementationOnce(async record => {
        entered.resolve();
        await release.promise;
        await save(record);
      });
      const archiving = lifecycle.archiveProject(project.id);
      await entered.promise;
      const arriving = mutation === 'move' ? lifecycle.setPlacement(['arriving'], { projectId: project.id })
        : mutation === 'restore' ? lifecycle.restore(['arriving'])
        : mutation === 'restore one' ? lifecycle.setArchived('arriving', false)
        : mutation === 'restore project' ? lifecycle.restoreProject(project.id)
        : conversations.createConversation({ projectId: project.id });
      const settled = Promise.allSettled([archiving, arriving]);
      release.resolve();
      const results = await settled;

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe(mutation === 'move' ? 'rejected' : 'fulfilled');
      expect(projects.get(project.id)?.isArchived).toBe(!mutation.startsWith('restore'));
      expect(conversations.getConversationList().filter(record => record.projectId === project.id && !record.isArchived))
        .toHaveLength(mutation.startsWith('restore') ? 1 : 0);
      expect(conversations.getConversationList()).toHaveLength(mutation === 'create' ? 2 : 1);
      expect(projects.get(project.id)?.isArchived && conversations.getConversationList()
        .some(record => record.projectId === project.id && !record.isArchived)).toBe(false);
    },
  );

  it('releases membership writes after final project archive persistence fails', async () => {
    const { projects, repository, conversations, store } = await fixture();
    const project = await projects.create({ name: 'Retry', instructions: '', memoryPath: 'Retry.md' });
    const lifecycle = new ConversationLifecycle({
      conversations, projects,
      sessions: { get: () => null, isRunning: () => false, retire: async () => undefined, whenSettled: async () => true },
      views: { getAllViews: () => [] },
    });
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(lifecycle.archiveProject(project.id)).rejects.toThrow('disk unavailable');
    const created = await conversations.createConversation({ projectId: project.id });

    expect(projects.get(project.id)?.isArchived).toBe(false);
    expect(repository.getSync(created.id)?.projectId).toBe(project.id);
    await lifecycle.archiveProject(project.id);
    expect(projects.get(project.id)?.isArchived).toBe(true);
    expect(repository.getSync(created.id)?.isArchived).toBe(true);
  });

  it('joins, moves, and leaves through the conversation owner and publishes the list change', async () => {
    const { projects, repository, conversations, onConversationListChanged } = await fixture({
      conversations: [conversation('member')],
    });
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'First.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second.md' });

    await conversations.setConversationsPlacement(['member'], { projectId: first.id });
    expect(repository.getSync('member')?.projectId).toBe(first.id);
    await conversations.setConversationsPlacement(['member'], { projectId: second.id });
    expect(repository.getSync('member')?.projectId).toBe(second.id);
    await conversations.setConversationsPlacement(['member'], { projectId: null });

    expect(repository.getSync('member')?.projectId).toBeUndefined();
    expect(onConversationListChanged).toHaveBeenCalledTimes(3);
  });

  it('moves and unpins several sessions with one write each and one list change, and publishes once when refused', async () => {
    const { projects, repository, conversations, persistence, onConversationListChanged } = await fixture({
      conversations: ['first', 'second', 'third'].map(id => ({ ...conversation(id), isPinned: true })),
    });
    const target = await projects.create({ name: 'Target', instructions: '', memoryPath: 'Target.md' });

    await conversations.setConversationsPlacement(['first', 'second', 'third'], { projectId: target.id, isPinned: false });
    expect(['first', 'second', 'third'].map(id => repository.getSync(id))).toEqual([
      expect.objectContaining({ projectId: target.id, isPinned: false }),
      expect.objectContaining({ projectId: target.id, isPinned: false }),
      expect.objectContaining({ projectId: target.id, isPinned: false }),
    ]);
    expect(persistence.saveMetadata).toHaveBeenCalledTimes(3);
    expect(onConversationListChanged).toHaveBeenCalledTimes(1);

    await expect(conversations.setConversationsPlacement(['first', 'second'], { projectId: 'deleted-project' }))
      .rejects.toThrow('Unknown project: deleted-project');
    expect(repository.getSync('first')?.projectId).toBe(target.id);
    expect(onConversationListChanged).toHaveBeenCalledTimes(2);
  });
});
