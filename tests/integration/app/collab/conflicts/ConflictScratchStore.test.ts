import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  type ConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';
import { ConflictScratchStore } from '@/app/collab/conflicts/ConflictScratchStore';

describe('ConflictScratchStore', () => {
  let vaultRoot = '';

  afterEach(async () => {
    if (vaultRoot) await rm(vaultRoot, { force: true, recursive: true });
  });

  it('persists resumable state without serializing an absolute scratch path', async () => {
    const { record, store } = await createSubject();

    await store.save(record);
    const repositoryPath = await store.recreateRepository(record.operationId);
    await writeFile(path.join(repositoryPath, 'transient'), 'scratch');
    const resumed = new ConflictScratchStore(
      vaultRoot,
      new CollabLocalProjectRepository(vaultRoot),
    );

    await expect(resumed.load(record.operationId)).resolves.toEqual(record);
    await expect(resumed.list()).resolves.toEqual([record]);
    const stateText = await readFile(
      path.join(path.dirname(repositoryPath), 'state.json'),
      'utf8',
    );
    expect(stateText).not.toContain(vaultRoot);
    expect(stateText).not.toContain('scratchPath');
  });

  it('recreates only the derived repository child and cleans the exact operation', async () => {
    const { record, store } = await createSubject();
    await store.save(record);
    const repositoryPath = await store.recreateRepository(record.operationId);
    await writeFile(path.join(repositoryPath, 'old'), 'old');

    const recreated = await store.recreateRepository(record.operationId);

    await expect(lstat(path.join(recreated, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.load(record.operationId)).resolves.toEqual(record);
    await expect(store.remove(record.operationId)).resolves.toBe(true);
    await expect(store.load(record.operationId)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.remove(record.operationId)).resolves.toBe(false);
  });

  it('rejects symlinked operation boundaries without exposing the target path', async () => {
    const { record, store } = await createSubject();
    const outside = await mkdtemp(path.join(tmpdir(), 'claudian-conflict-outside-'));
    await store.ensureContainer();
    const operationPath = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'conflicts',
      record.operationId,
    );
    await symlink(outside, operationPath);

    let failure: unknown;
    try {
      await store.save(record);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'workspace-boundary-invalid' });
    expect(JSON.stringify(failure)).not.toContain(outside);
    await rm(outside, { force: true, recursive: true });
  });

  async function createSubject() {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-conflict-store-'));
    const projects = new CollabLocalProjectRepository(vaultRoot);
    const store = new ConflictScratchStore(vaultRoot, projects);
    const record: ConflictResolutionRecord = {
      createdAt: '2026-08-08T00:00:00.000Z',
      descriptor: {
        conflicts: [{ kind: 'text', path: 'note.md' }],
        mergeBaseOid: '1'.repeat(40),
        operationId: 'operation-a',
        projectId: 'project-a',
        startingMainOid: '2'.repeat(40),
        startingPersonalOid: '3'.repeat(40),
      },
      operationId: 'operation-a',
      phase: 'planned',
      projectId: 'project-a',
      resultCommitOid: null,
      schemaVersion: COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    return { record, store };
  }
});
