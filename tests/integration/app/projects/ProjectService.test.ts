import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import { testDate } from '@test/helpers/testClock';
import type { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationService } from '@/app/conversations/ConversationService';
import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { defaultProjectMemoryPath, projectMemoryFolderOf } from '@/core/path/ProjectMemoryPath';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { type Conversation, ProjectMemoryConflictError, ProjectMemoryPathTakenError } from '@/core/types';

const TEMPLATE_SECTIONS = '## Goal\n\n## Requirements\n\n## Decisions\n\n## State\n\n## Open questions\n\n## Dead ends\n';

function conversation(id: string, projectId?: string): Conversation {
  return {
    id, providerId: 'claude', title: id, sessionId: null,
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), messages: [],
    ...(projectId ? { projectId } : {}),
  };
}

async function fixture(options: { memory?: MemoryDataAdapter; conversations?: Conversation[] } = {}) {
  const memory = options.memory ?? new MemoryDataAdapter();
  const files = new VaultFileAdapter({ vault: { adapter: memory } } as unknown as App);
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
    sessionMetadata: { ensureLoaded: async () => undefined },
    pinnedLinkedContentPaths: {} as never,
    nativeSessionArchives: { sync: async () => undefined },
    onConversationListChanged,
  });
  return { memory, settings, store, loaded, projects, repository, conversations, persistence, onConversationListChanged };
}

function readFile(memory: MemoryDataAdapter, path: string): string | undefined {
  const node = memory.nodes.get(path);
  return node?.type === 'file' ? node.content : undefined;
}

describe('ProjectService', () => {
  it('creates a persisted record and a template memory file at the given path, creating its folders', async () => {
    const { memory, projects } = await fixture();
    const changed = jest.fn();
    projects.onChanged(changed);

    const record = await projects.create({
      name: 'Q3 Launch: Plan!', instructions: 'Ship it.', memoryPath: '.claudian/projects/q3-launch-plan/MEMORY.md',
    });

    expect(record.memoryPath).toBe('.claudian/projects/q3-launch-plan/MEMORY.md');
    expect(memory.nodes.get('.claudian/projects/q3-launch-plan')).toEqual({ type: 'folder' });
    expect(readFile(memory, record.memoryPath)).toBe(`# Q3 Launch: Plan!\n\n${TEMPLATE_SECTIONS}`);
    expect(JSON.parse(readFile(memory, `${PROJECTS_PATH}/${record.id}.json`)!)).toEqual({
      id: record.id,
      name: 'Q3 Launch: Plan!',
      instructions: 'Ship it.',
      memoryPath: record.memoryPath,
      isPinned: false,
      createdAt: record.createdAt,
    });
    expect(projects.get(record.id)).toEqual(record);
    expect(projects.list()).toEqual([record]);
    expect(changed).toHaveBeenCalledTimes(1);
    // Only the memory file itself is left behind; the write leaves no temporary sibling.
    expect([...memory.nodes.keys()].filter(path => path.startsWith('.claudian/projects/q3-launch-plan/')))
      .toEqual([record.memoryPath]);
  });

  it('creates memory files at custom paths, including nested new folders and the vault root', async () => {
    const { memory, projects } = await fixture();

    const work = await projects.create({ name: 'Work Plan', instructions: '', memoryPath: ' /Work//Plans/Launch ' });
    const root = await projects.create({ name: 'Root Plan', instructions: '', memoryPath: 'Root.md' });

    expect(work.memoryPath).toBe('Work/Plans/Launch.md');
    expect(memory.nodes.get('Work')).toEqual({ type: 'folder' });
    expect(memory.nodes.get('Work/Plans')).toEqual({ type: 'folder' });
    expect(readFile(memory, 'Work/Plans/Launch.md')).toBe(`# Work Plan\n\n${TEMPLATE_SECTIONS}`);
    expect(root.memoryPath).toBe('Root.md');
    expect(readFile(memory, 'Root.md')).toBe(`# Root Plan\n\n${TEMPLATE_SECTIONS}`);
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(work.id)?.memoryPath).toBe('Work/Plans/Launch.md');
    expect(reloaded.projects.get(root.id)?.memoryPath).toBe('Root.md');
    const read = await reloaded.projects.readMemory(root.id);
    if ('missing' in read) throw new Error('Expected the root-level memory file to load');
    await reloaded.projects.saveMemory(root.id, '# Root Plan\n\nUpdated\n', read.revision);
    expect(readFile(memory, 'Root.md')).toBe('# Root Plan\n\nUpdated\n');
  });

  it.each(['../outside.md', 'C:/Docs/MEMORY.md', 'Work/', ''])(
    'rejects the invalid memory path %p without creating a project',
    async (memoryPath) => {
      const { memory, projects } = await fixture();
      const before = new Map(memory.nodes);

      await expect(projects.create({ name: 'Escape', instructions: '', memoryPath })).rejects.toThrow('memory path');

      expect(projects.list()).toEqual([]);
      expect(memory.nodes).toEqual(before);
    },
  );

  it('refuses to create a project over an existing file and leaves that file untouched', async () => {
    const memory = new MemoryDataAdapter();
    memory.addFolder('Work');
    memory.addFile('Work/MEMORY.md', '# Someone else\n');
    const { projects } = await fixture({ memory });
    const before = new Map(memory.nodes);
    const changed = jest.fn();
    projects.onChanged(changed);

    const attempt = projects.create({ name: 'Taken', instructions: '', memoryPath: 'Work/MEMORY.md' });

    await expect(attempt).rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    await expect(attempt).rejects.toMatchObject({ path: 'Work/MEMORY.md' });
    expect(memory.nodes).toEqual(before);
    expect(projects.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('never replaces a file that appears at the path while the template is being written', async () => {
    const { memory, projects } = await fixture();
    memory.beforeWrite = (path) => {
      // A synced or concurrent writer claims the target after the existence check.
      if (path.startsWith('Work/') && path !== 'Work/MEMORY.md') memory.addFile('Work/MEMORY.md', '# Synced\n');
    };

    await expect(projects.create({ name: 'Race', instructions: '', memoryPath: 'Work/MEMORY.md' }))
      .rejects.toBeInstanceOf(ProjectMemoryPathTakenError);

    expect(readFile(memory, 'Work/MEMORY.md')).toBe('# Synced\n');
    expect([...memory.nodes.keys()].filter(path => path.startsWith('Work/'))).toEqual(['Work/MEMORY.md']);
    expect(projects.list()).toEqual([]);
  });

  it('removes the new memory file when the record cannot be saved, so a retry can create it', async () => {
    const { memory, projects } = await fixture();
    memory.beforeWrite = (path) => {
      if (path.startsWith(`${PROJECTS_PATH}/`) && path.endsWith('.json')) throw new Error('disk full');
    };

    await expect(projects.create({ name: 'Retry', instructions: '', memoryPath: 'Retry.md' })).rejects.toThrow();
    expect(memory.nodes.has('Retry.md')).toBe(false);
    expect(projects.list()).toEqual([]);

    memory.beforeWrite = undefined;
    const record = await projects.create({ name: 'Retry', instructions: '', memoryPath: 'Retry.md' });
    expect(readFile(memory, record.memoryPath)).toBe(`# Retry\n\n${TEMPLATE_SECTIONS}`);
  });

  it.each([
    ['renames it within its folder', '.claudian/projects/launch/PLAN.md'],
    ['moves it into another, new folder', 'Work/Plans/Launch.md'],
    ['moves it into the vault root', '/Launch'],
  ])('%s with its edits and persists the new path', async (_label, memoryPath) => {
    const { memory, projects } = await fixture();
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
    expect(readFile(memory, expected)).toBe('# Launch\n\nEdited\n');
    expect(memory.nodes.has(record.memoryPath)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(record.id)).toMatchObject({ name: 'Launch v2', memoryPath: expected });
    await expect(reloaded.projects.readMemory(record.id)).resolves.toMatchObject({ content: '# Launch\n\nEdited\n' });
  });

  it('repoints a project whose memory file is missing without creating one', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Lost', instructions: '', memoryPath: 'Lost/MEMORY.md' });
    memory.nodes.delete(record.memoryPath);

    await projects.update(record.id, { memoryPath: 'Elsewhere/Lost.md' });

    expect(projects.get(record.id)?.memoryPath).toBe('Elsewhere/Lost.md');
    expect(memory.nodes.has('Elsewhere/Lost.md')).toBe(false);
    await expect(projects.readMemory(record.id)).resolves.toEqual({ missing: true });
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(record.id)?.memoryPath).toBe('Elsewhere/Lost.md');
  });

  it('refuses to move onto an existing file and changes neither the record nor any file', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Taken', instructions: 'Keep.', memoryPath: 'Taken/MEMORY.md' });
    memory.addFolder('Work');
    memory.addFile('Work/Notes.md', '# Someone else\n');
    const before = new Map(memory.nodes);
    const changed = jest.fn();
    projects.onChanged(changed);

    const attempt = projects.update(record.id, { name: 'Renamed', instructions: 'New.', memoryPath: 'Work/Notes.md' });

    await expect(attempt).rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    await expect(attempt).rejects.toMatchObject({ path: 'Work/Notes.md' });
    expect(projects.get(record.id)).toEqual(record);
    expect(memory.nodes).toEqual(before);
    expect(readFile(memory, record.memoryPath)).toBe(`# Taken\n\n${TEMPLATE_SECTIONS}`);
    expect(changed).not.toHaveBeenCalled();
  });

  it('treats a path another live project records as taken, even while its file is missing', async () => {
    const { memory, projects } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    memory.nodes.delete(first.memoryPath);

    // Case differences name the same file on case-insensitive vaults.
    await expect(projects.create({ name: 'Second', instructions: '', memoryPath: 'shared/memory.md' }))
      .rejects.toBeInstanceOf(ProjectMemoryPathTakenError);
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second/MEMORY.md' });
    await expect(projects.update(second.id, { memoryPath: 'Shared/MEMORY.md' }))
      .rejects.toMatchObject({ path: 'Shared/MEMORY.md' });
    expect(projects.get(second.id)?.memoryPath).toBe('Second/MEMORY.md');
    expect(readFile(memory, second.memoryPath)).toBe(`# Second\n\n${TEMPLATE_SECTIONS}`);

    // Deleting the claim frees the path.
    await projects.delete(first.id);
    await projects.update(second.id, { memoryPath: 'Shared/MEMORY.md' });
    expect(readFile(memory, 'Shared/MEMORY.md')).toBe(`# Second\n\n${TEMPLATE_SECTIONS}`);
  });

  it('never trashes a memory file another live project still records', async () => {
    const { memory, projects, store } = await fixture();
    const first = await projects.create({ name: 'First', instructions: '', memoryPath: 'Shared/MEMORY.md' });
    const second = await projects.create({ name: 'Second', instructions: '', memoryPath: 'Second/MEMORY.md' });
    // Overlapping records can come from an earlier version or another synced device.
    await store.save({ ...second, memoryPath: first.memoryPath });
    const reloaded = await fixture({ memory });

    await reloaded.projects.delete(first.id);

    expect(reloaded.projects.list().map(({ id }) => id)).toEqual([second.id]);
    expect(memory.trashed).toEqual([]);
    expect(readFile(memory, first.memoryPath)).toBe(`# First\n\n${TEMPLATE_SECTIONS}`);
  });

  it('rejects an invalid memory path on update without changing anything', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Keep', instructions: '', memoryPath: 'Keep.md' });
    const before = new Map(memory.nodes);

    await expect(projects.update(record.id, { name: 'Renamed', memoryPath: '../Keep.md' })).rejects.toThrow('memory path');

    expect(projects.get(record.id)).toEqual(record);
    expect(memory.nodes).toEqual(before);
  });

  it('keeps the memory file in place when the path is unchanged', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Stay', instructions: '', memoryPath: 'Stay/MEMORY.md' });
    const recordFile = readFile(memory, `${PROJECTS_PATH}/${record.id}.json`);
    const changed = jest.fn();
    projects.onChanged(changed);
    const rename = jest.spyOn(memory, 'rename');

    await projects.update(record.id, { memoryPath: '/Stay/./MEMORY' });
    expect(changed).not.toHaveBeenCalled();
    expect(readFile(memory, `${PROJECTS_PATH}/${record.id}.json`)).toBe(recordFile);

    await projects.update(record.id, { name: 'Stay put', memoryPath: 'Stay/MEMORY.md' });
    expect(projects.get(record.id)).toMatchObject({ name: 'Stay put', memoryPath: 'Stay/MEMORY.md' });
    expect(readFile(memory, 'Stay/MEMORY.md')).toContain('# Stay');
    expect(rename).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('skips an unparsable project file on load and never rewrites or deletes it', async () => {
    const memory = new MemoryDataAdapter();
    memory.addFolder('.claudian');
    memory.addFolder(PROJECTS_PATH);
    memory.addFile(`${PROJECTS_PATH}/broken.json`, '{"id": "broken", "name": ');
    memory.addFile(`${PROJECTS_PATH}/mismatch.json`, JSON.stringify({
      id: 'other', name: 'Mismatch', instructions: '', memoryPath: 'a.md', isPinned: false, createdAt: 1,
    }));
    memory.addFile(`${PROJECTS_PATH}/valid.json`, JSON.stringify({
      id: 'valid', name: 'Valid', instructions: 'Do', memoryPath: 'Docs/valid.md', isPinned: true, createdAt: 1,
    }));

    const { loaded, projects } = await fixture({ memory });
    const created = await projects.create({ name: 'New', instructions: '', memoryPath: 'New.md' });
    await projects.setPinned('valid', false);
    await projects.delete(created.id);

    expect(loaded.invalidCount).toBe(2);
    expect(projects.list().map(({ id }) => id)).toEqual(['valid']);
    expect(readFile(memory, `${PROJECTS_PATH}/broken.json`)).toBe('{"id": "broken", "name": ');
    expect(JSON.parse(readFile(memory, `${PROJECTS_PATH}/mismatch.json`)!).id).toBe('other');
  });

  it('detects a concurrent memory change, keeps it, and writes only with overwrite', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Memo', instructions: '', memoryPath: 'Memo.md' });
    const read = await projects.readMemory(record.id);
    if ('missing' in read) throw new Error('memory file should exist');
    memory.addFile(record.memoryPath, '# Agent edit\n');

    await expect(projects.saveMemory(record.id, '# User edit\n', read.revision))
      .rejects.toBeInstanceOf(ProjectMemoryConflictError);
    expect(readFile(memory, record.memoryPath)).toBe('# Agent edit\n');

    const saved = await projects.saveMemory(record.id, '# User edit\n', read.revision, { overwrite: true });
    expect(readFile(memory, record.memoryPath)).toBe('# User edit\n');
    await expect(projects.readMemory(record.id)).resolves.toEqual(saved);
  });

  it('re-reads the memory file inside the project queue so two saves from one revision cannot both win', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Memo', instructions: '', memoryPath: 'Memo.md' });
    const read = await projects.readMemory(record.id);
    if ('missing' in read) throw new Error('memory file should exist');

    const results = await Promise.allSettled([
      projects.saveMemory(record.id, 'first', read.revision),
      projects.saveMemory(record.id, 'second', read.revision),
    ]);

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(readFile(memory, record.memoryPath)).toBe('first');
  });

  it('reports a missing memory file and recreates it from the template at the recorded path', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Recover', instructions: '', memoryPath: 'Recover.md' });
    await projects.update(record.id, { name: 'Recovered' });
    memory.nodes.delete(record.memoryPath);

    await expect(projects.readMemory(record.id)).resolves.toEqual({ missing: true });
    const recreated = await projects.recreateMemory(record.id);

    expect(recreated.content).toBe(`# Recovered\n\n${TEMPLATE_SECTIONS}`);
    expect(readFile(memory, record.memoryPath)).toBe(recreated.content);
    await expect(projects.readMemory(record.id)).resolves.toEqual(recreated);

    // A memory file that reappeared after the missing read (sync, undo) is kept and returned instead of the template.
    memory.addFile(record.memoryPath, '# Restored by sync\n');
    const kept = await projects.recreateMemory(record.id);
    expect(readFile(memory, record.memoryPath)).toBe('# Restored by sync\n');
    expect(kept).toEqual(await projects.readMemory(record.id));
    expect(kept.content).toBe('# Restored by sync\n');
  });

  it('deletes the record first, trashes the memory file and its emptied default folder, and blocks new joins', async () => {
    const { memory, projects, repository, conversations } = await fixture();
    const deleted = await projects.create({ name: 'Deleted', instructions: '', memoryPath: defaultProjectMemoryPath('Deleted') });
    const custom = await projects.create({ name: 'Custom', instructions: '', memoryPath: 'Notes/Custom.md' });
    const other = await projects.create({ name: 'Other', instructions: '', memoryPath: 'Other.md' });
    repository.replaceAll([conversation('outsider', other.id)]);
    const seenAtPublish: Array<boolean> = [];
    projects.onChanged(() => { seenAtPublish.push(readFile(memory, `${PROJECTS_PATH}/${deleted.id}.json`) === undefined); });

    await projects.delete(deleted.id);
    await projects.delete(custom.id);

    expect(projects.list()).toEqual([other]);
    expect(seenAtPublish).toEqual([true, true]);
    expect(readFile(memory, `${PROJECTS_PATH}/${deleted.id}.json`)).toBeUndefined();
    expect(memory.trashed).toEqual([deleted.memoryPath, custom.memoryPath]);
    // Only a folder inside the projects folder is removed, and only once empty.
    expect(memory.nodes.has(projectMemoryFolderOf(deleted.memoryPath))).toBe(false);
    expect(memory.nodes.has('Notes')).toBe(true);
    expect(readFile(memory, other.memoryPath)).toContain('# Other');
    await expect(conversations.setConversationsPlacement(['outsider'], { projectId: deleted.id }))
      .rejects.toThrow(`Unknown project: ${deleted.id}`);
    expect(repository.getSync('outsider')?.projectId).toBe(other.id);
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
