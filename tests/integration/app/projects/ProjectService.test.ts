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
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { type Conversation, ProjectDocConflictError, ProjectDocMoveConflictError } from '@/core/types';

const DOC_FOLDER = '.claudian/projects';
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
  // Constructed first; the member port is reached only after the conversation service exists.
  const projects: ProjectService = new ProjectService(loaded.records, {
    store,
    docs: files,
    members: {
      setConversationsProject: (ids, projectId) => conversations.setConversationsProject(ids, projectId),
      clearProject: projectId => conversations.clearProjectMembership(projectId),
    },
  });
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
  const conversations: ConversationService = new ConversationService({
    repository,
    sessionMetadata: { ensureLoaded: async () => undefined },
    pinnedLinkedContentPaths: {} as never,
    nativeSessionArchives: { sync: async () => undefined },
    onConversationListChanged,
  });
  return { memory, settings, store, loaded, projects, repository, conversations, onConversationListChanged };
}

function readFile(memory: MemoryDataAdapter, path: string): string | undefined {
  const node = memory.nodes.get(path);
  return node?.type === 'file' ? node.content : undefined;
}

describe('ProjectService', () => {
  it('creates a persisted record with a template doc named from the slug and id prefix', async () => {
    const { memory, projects } = await fixture();
    const changed = jest.fn();
    projects.onChanged(changed);

    const record = await projects.create({ name: 'Q3 Launch: Plan!', instructions: 'Ship it.', docFolder: DOC_FOLDER });

    expect(record.docPath).toBe(`.claudian/projects/q3-launch-plan-${record.id.slice(0, 8)}.md`);
    expect(readFile(memory, record.docPath)).toBe(`# Q3 Launch: Plan!\n\n${TEMPLATE_SECTIONS}`);
    expect(JSON.parse(readFile(memory, `${PROJECTS_PATH}/${record.id}.json`)!)).toEqual({
      id: record.id,
      name: 'Q3 Launch: Plan!',
      instructions: 'Ship it.',
      docPath: record.docPath,
      isPinned: false,
      createdAt: record.createdAt,
    });
    expect(projects.get(record.id)).toEqual(record);
    expect(projects.list()).toEqual([record]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('creates each doc in the folder given at creation, including the vault root', async () => {
    const { memory, projects } = await fixture();

    const work = await projects.create({ name: 'Work Plan', instructions: '', docFolder: 'Work/Projects' });
    const root = await projects.create({ name: 'Root Plan', instructions: '', docFolder: '' });

    expect(work.docPath).toBe(`Work/Projects/work-plan-${work.id.slice(0, 8)}.md`);
    expect(readFile(memory, work.docPath)).toBe(`# Work Plan\n\n${TEMPLATE_SECTIONS}`);
    expect(root.docPath).toBe(`root-plan-${root.id.slice(0, 8)}.md`);
    expect(readFile(memory, root.docPath)).toBe(`# Root Plan\n\n${TEMPLATE_SECTIONS}`);
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(work.id)?.docPath).toBe(work.docPath);
    expect(reloaded.projects.get(root.id)?.docPath).toBe(root.docPath);
    const doc = await reloaded.projects.readDoc(root.id);
    if ('missing' in doc) throw new Error('Expected the root-level doc to load');
    await reloaded.projects.saveDoc(root.id, '# Root Plan\n\nUpdated\n', doc.revision);
    expect(readFile(memory, root.docPath)).toBe('# Root Plan\n\nUpdated\n');
  });

  it('rejects an invalid doc folder without creating a project', async () => {
    const { memory, projects } = await fixture();
    const before = new Map(memory.nodes);

    await expect(projects.create({ name: 'Escape', instructions: '', docFolder: '../outside' }))
      .rejects.toThrow('doc folder');
    await expect(projects.create({ name: 'Drive', instructions: '', docFolder: 'C:/Docs' }))
      .rejects.toThrow('doc folder');

    expect(projects.list()).toEqual([]);
    expect(memory.nodes).toEqual(before);
  });

  it.each([
    ['another folder', 'Work/Projects', 'Work/Projects/'],
    ['the vault root', '/', ''],
  ])('moves the existing doc with its edits into %s and persists the new path', async (_label, docFolder, prefix) => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Launch', instructions: '', docFolder: DOC_FOLDER });
    const read = await projects.readDoc(record.id);
    if ('missing' in read) throw new Error('doc should exist');
    await projects.saveDoc(record.id, '# Launch\n\nEdited\n', read.revision);
    const changed = jest.fn();
    projects.onChanged(changed);
    const fileName = record.docPath.slice(record.docPath.lastIndexOf('/') + 1);

    await projects.update(record.id, { name: 'Launch v2', docFolder });

    const docPath = `${prefix}${fileName}`;
    expect(projects.get(record.id)).toMatchObject({ name: 'Launch v2', docPath });
    expect(readFile(memory, docPath)).toBe('# Launch\n\nEdited\n');
    expect(memory.nodes.has(record.docPath)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(record.id)).toMatchObject({ name: 'Launch v2', docPath });
    await expect(reloaded.projects.readDoc(record.id)).resolves.toMatchObject({ content: '# Launch\n\nEdited\n' });
  });

  it('repoints a project whose doc is missing to the new folder without creating a doc', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Lost', instructions: '', docFolder: DOC_FOLDER });
    memory.nodes.delete(record.docPath);

    await projects.update(record.id, { docFolder: 'Elsewhere' });

    const docPath = `Elsewhere/${record.docPath.slice(record.docPath.lastIndexOf('/') + 1)}`;
    expect(projects.get(record.id)?.docPath).toBe(docPath);
    expect(memory.nodes.has(docPath)).toBe(false);
    await expect(projects.readDoc(record.id)).resolves.toEqual({ missing: true });
    const reloaded = await fixture({ memory });
    expect(reloaded.projects.get(record.id)?.docPath).toBe(docPath);
  });

  it('refuses to move onto an existing file and changes neither the record nor any file', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Taken', instructions: 'Keep.', docFolder: DOC_FOLDER });
    const target = `Work/${record.docPath.slice(record.docPath.lastIndexOf('/') + 1)}`;
    memory.addFolder('Work');
    memory.addFile(target, '# Someone else\n');
    const recordFile = readFile(memory, `${PROJECTS_PATH}/${record.id}.json`);
    const changed = jest.fn();
    projects.onChanged(changed);

    await expect(projects.update(record.id, { name: 'Renamed', instructions: 'New.', docFolder: 'Work' }))
      .rejects.toBeInstanceOf(ProjectDocMoveConflictError);

    expect(projects.get(record.id)).toEqual(record);
    expect(readFile(memory, `${PROJECTS_PATH}/${record.id}.json`)).toBe(recordFile);
    expect(readFile(memory, record.docPath)).toBe(`# Taken\n\n${TEMPLATE_SECTIONS}`);
    expect(readFile(memory, target)).toBe('# Someone else\n');
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps the doc in place when the folder is unchanged', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Stay', instructions: '', docFolder: DOC_FOLDER });
    const recordFile = readFile(memory, `${PROJECTS_PATH}/${record.id}.json`);
    const changed = jest.fn();
    projects.onChanged(changed);
    const rename = jest.spyOn(memory, 'rename');

    await projects.update(record.id, { docFolder: `/${DOC_FOLDER}/` });
    expect(changed).not.toHaveBeenCalled();
    expect(readFile(memory, `${PROJECTS_PATH}/${record.id}.json`)).toBe(recordFile);

    await projects.update(record.id, { name: 'Stay put', docFolder: DOC_FOLDER });
    expect(projects.get(record.id)).toMatchObject({ name: 'Stay put', docPath: record.docPath });
    expect(readFile(memory, record.docPath)).toContain('# Stay');
    expect(rename).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('skips an unparsable project file on load and never rewrites or deletes it', async () => {
    const memory = new MemoryDataAdapter();
    memory.addFolder('.claudian');
    memory.addFolder(PROJECTS_PATH);
    memory.addFile(`${PROJECTS_PATH}/broken.json`, '{"id": "broken", "name": ');
    memory.addFile(`${PROJECTS_PATH}/mismatch.json`, JSON.stringify({
      id: 'other', name: 'Mismatch', instructions: '', docPath: 'a.md', isPinned: false, createdAt: 1,
    }));
    memory.addFile(`${PROJECTS_PATH}/valid.json`, JSON.stringify({
      id: 'valid', name: 'Valid', instructions: 'Do', docPath: 'Docs/valid.md', isPinned: true, createdAt: 1,
    }));

    const { loaded, projects } = await fixture({ memory });
    const created = await projects.create({ name: 'New', instructions: '', docFolder: DOC_FOLDER });
    await projects.setPinned('valid', false);
    await projects.delete(created.id);

    expect(loaded.invalidCount).toBe(2);
    expect(projects.list().map(({ id }) => id)).toEqual(['valid']);
    expect(readFile(memory, `${PROJECTS_PATH}/broken.json`)).toBe('{"id": "broken", "name": ');
    expect(JSON.parse(readFile(memory, `${PROJECTS_PATH}/mismatch.json`)!).id).toBe('other');
  });

  it('detects a concurrent doc change, keeps it, and writes only with overwrite', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Doc', instructions: '', docFolder: DOC_FOLDER });
    const read = await projects.readDoc(record.id);
    if ('missing' in read) throw new Error('doc should exist');
    memory.addFile(record.docPath, '# Agent edit\n');

    await expect(projects.saveDoc(record.id, '# User edit\n', read.revision))
      .rejects.toBeInstanceOf(ProjectDocConflictError);
    expect(readFile(memory, record.docPath)).toBe('# Agent edit\n');

    const saved = await projects.saveDoc(record.id, '# User edit\n', read.revision, { overwrite: true });
    expect(readFile(memory, record.docPath)).toBe('# User edit\n');
    await expect(projects.readDoc(record.id)).resolves.toEqual(saved);
  });

  it('re-reads the doc inside the project queue so two saves from one revision cannot both win', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Doc', instructions: '', docFolder: DOC_FOLDER });
    const read = await projects.readDoc(record.id);
    if ('missing' in read) throw new Error('doc should exist');

    const results = await Promise.allSettled([
      projects.saveDoc(record.id, 'first', read.revision),
      projects.saveDoc(record.id, 'second', read.revision),
    ]);

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(readFile(memory, record.docPath)).toBe('first');
  });

  it('reports a missing doc and recreates it from the template at the recorded path', async () => {
    const { memory, projects } = await fixture();
    const record = await projects.create({ name: 'Recover', instructions: '', docFolder: DOC_FOLDER });
    await projects.update(record.id, { name: 'Recovered' });
    memory.nodes.delete(record.docPath);

    await expect(projects.readDoc(record.id)).resolves.toEqual({ missing: true });
    const recreated = await projects.recreateDoc(record.id);

    expect(recreated.content).toBe(`# Recovered\n\n${TEMPLATE_SECTIONS}`);
    expect(readFile(memory, record.docPath)).toBe(recreated.content);
    await expect(projects.readDoc(record.id)).resolves.toEqual(recreated);

    // A doc that reappeared after the missing read (sync, undo) is kept and returned instead of the template.
    memory.addFile(record.docPath, '# Restored by sync\n');
    const kept = await projects.recreateDoc(record.id);
    expect(readFile(memory, record.docPath)).toBe('# Restored by sync\n');
    expect(kept).toEqual(await projects.readDoc(record.id));
    expect(kept.content).toBe('# Restored by sync\n');
  });

  it('deletes the record first, keeps the doc, and clears only members still in the project', async () => {
    const { memory, projects, repository } = await fixture();
    const deleted = await projects.create({ name: 'Deleted', instructions: '', docFolder: DOC_FOLDER });
    const other = await projects.create({ name: 'Other', instructions: '', docFolder: DOC_FOLDER });
    repository.replaceAll([
      conversation('stays', deleted.id),
      conversation('moves', deleted.id),
      conversation('outsider', other.id),
    ]);
    const seenAtPublish: Array<string | undefined> = [];
    projects.onChanged(() => {
      seenAtPublish.push(repository.getSync('stays')?.projectId);
    });

    const move = projects.setConversationsProject(['moves'], other.id);
    const removal = projects.delete(deleted.id);
    await Promise.all([move, removal]);

    expect(projects.get(deleted.id)).toBeNull();
    // Published while the member still carried the raw id: readers resolve through the live record.
    expect(seenAtPublish).toEqual([deleted.id]);
    expect(readFile(memory, `${PROJECTS_PATH}/${deleted.id}.json`)).toBeUndefined();
    expect(readFile(memory, deleted.docPath)).toContain('# Deleted');
    expect(repository.getSync('stays')?.projectId).toBeUndefined();
    expect(repository.getSync('moves')?.projectId).toBe(other.id);
    expect(repository.getSync('outsider')?.projectId).toBe(other.id);
    await expect(projects.setConversationsProject(['stays'], deleted.id)).rejects.toThrow('project');
  });

  it('joins, moves, and leaves through the conversation owner and publishes the list change', async () => {
    const { projects, repository, onConversationListChanged } = await fixture({
      conversations: [conversation('member')],
    });
    const first = await projects.create({ name: 'First', instructions: '', docFolder: DOC_FOLDER });
    const second = await projects.create({ name: 'Second', instructions: '', docFolder: DOC_FOLDER });

    await projects.setConversationsProject(['member'], first.id);
    expect(repository.getSync('member')?.projectId).toBe(first.id);
    await projects.setConversationsProject(['member'], second.id);
    expect(repository.getSync('member')?.projectId).toBe(second.id);
    await projects.setConversationsProject(['member'], null);

    expect(repository.getSync('member')?.projectId).toBeUndefined();
    expect(onConversationListChanged).toHaveBeenCalledTimes(3);
  });

  it('moves several sessions with one list change, and publishes once when the move is refused', async () => {
    const { projects, repository, onConversationListChanged } = await fixture({
      conversations: [conversation('first'), conversation('second'), conversation('third')],
    });
    const target = await projects.create({ name: 'Target', instructions: '', docFolder: DOC_FOLDER });

    await projects.setConversationsProject(['first', 'second', 'third'], target.id);
    expect(['first', 'second', 'third'].map(id => repository.getSync(id)?.projectId)).toEqual([target.id, target.id, target.id]);
    expect(onConversationListChanged).toHaveBeenCalledTimes(1);

    await expect(projects.setConversationsProject(['first', 'second'], 'deleted-project')).rejects.toThrow('project');
    expect(repository.getSync('first')?.projectId).toBe(target.id);
    expect(onConversationListChanged).toHaveBeenCalledTimes(2);
  });
});
