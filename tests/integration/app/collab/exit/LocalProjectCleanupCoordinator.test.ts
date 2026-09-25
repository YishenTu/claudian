import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { testClock, testTime } from '@test/helpers/testClock';

import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { decodeLocalCleanupRecord, type LocalCleanupRecord } from '@/app/collab/exit/LocalCleanupRecord';
import {
  type LocalCleanupGitIdentityPort,
  type LocalCleanupRecordPort,
  LocalProjectCleanupCoordinator,
} from '@/app/collab/exit/LocalProjectCleanupCoordinator';

class MemoryRecordStore implements LocalCleanupRecordPort {
  readonly records = new Map<string, LocalCleanupRecord>();

  async load(projectId: string): Promise<LocalCleanupRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async save(record: LocalCleanupRecord): Promise<void> {
    this.records.set(record.projectId, record);
  }

  async remove(projectId: string): Promise<boolean> {
    return this.records.delete(projectId);
  }
}

describe('LocalProjectCleanupCoordinator', () => {
  let vaultRoot: string;
  let workspace: CollabWorkspaceService;
  let records: MemoryRecordStore;
  let git: jest.Mocked<LocalCleanupGitIdentityPort>;
  let subject: LocalProjectCleanupCoordinator;

  const intent = (overrides: Partial<Parameters<LocalProjectCleanupCoordinator['cleanup']>[0]> = {}) => ({
    choice: 'keep-files' as const,
    memberId: 'member-alpha',
    operationId: 'cleanup-alpha',
    personalRef: 'refs/heads/members/member-alpha',
    projectId: 'project-alpha',
    purpose: 'leave' as const,
    workspacePath: 'workspace/project-alpha',
    ...overrides,
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cleanup-'));
    workspace = new CollabWorkspaceService(vaultRoot);
    await workspace.claimProjectsFolder('workspace');
    await mkdir(path.join(vaultRoot, 'workspace', 'project-alpha', '.git'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'visible\n');
    records = new MemoryRecordStore();
    git = {
      assertLocalRepositoryIdentity: jest.fn(
        async (_repositoryPath: string, _expected: {
          readonly memberId: string;
          readonly personalRef: string;
          readonly projectId: string;
        }) => undefined,
      ),
    };
    subject = new LocalProjectCleanupCoordinator(workspace, git, records, {
      nonce: () => 'a'.repeat(43),
      now: testClock({ days: -14 }),
    });
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('keeps visible files while removing only verified Git data', async () => {
    await expect(subject.cleanup(intent())).resolves.toEqual({
      filesPreserved: true,
      gitDataRemoved: true,
      markerRetained: false,
      status: 'complete',
    });

    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.git')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(git.assertLocalRepositoryIdentity).toHaveBeenCalledWith(
      path.join(vaultRoot, 'workspace', 'project-alpha'),
      {
        memberId: 'member-alpha',
        personalRef: 'refs/heads/members/member-alpha',
        projectId: 'project-alpha',
      },
    );
  });

  it('keeps files when leaving a Project in a user-renamed directory', async () => {
    const workspacePath = 'workspace/我的 Demo';
    await rename(path.join(vaultRoot, 'workspace/project-alpha'), path.join(vaultRoot, workspacePath));
    await expect(subject.cleanup(intent({ workspacePath }))).resolves.toMatchObject({ status: 'complete', filesPreserved: true });
    const retained = records.records.get('project-alpha');
    expect(decodeLocalCleanupRecord(retained)).toMatchObject({ workspacePath, phase: 'complete' });
    expect(await readFile(path.join(vaultRoot, workspacePath, 'note.md'), 'utf8')).toBe('visible\n');
    await expect(lstat(path.join(vaultRoot, workspacePath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a Project with a long Unicode directory name without exceeding the filesystem component limit', async () => {
    const workspacePath = `workspace/${'项'.repeat(80)}`;
    await rename(path.join(vaultRoot, 'workspace/project-alpha'), path.join(vaultRoot, workspacePath));
    const paths = await workspace.resolveCleanupPaths(workspacePath, 'cleanup-alpha');
    expect(Buffer.byteLength(path.basename(paths.detachedProjectPath), 'utf8')).toBeLessThanOrEqual(255);
    await expect(subject.cleanup(intent({ workspacePath, choice: 'delete-files' }))).resolves.toMatchObject({ status: 'complete', filesPreserved: false });
    await expect(lstat(path.join(vaultRoot, workspacePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes a legacy detached Project without recreating its source directory', async () => {
    const controller = new AbortController();
    await subject.cleanup(intent({ choice: 'delete-files' }), {
      onProgress: progress => { if (progress.phase === 'marked') controller.abort(); },
      signal: controller.signal,
    });
    const legacyPath = path.join(vaultRoot, 'workspace/.claudian-collab-project-cleanup-alpha-project-alpha');
    await rename(path.join(vaultRoot, 'workspace/project-alpha'), legacyPath);
    await records.save({ ...records.records.get('project-alpha')!, phase: 'deleting' });

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete', filesPreserved: false });
    await expect(lstat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(vaultRoot, 'workspace/project-alpha'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves both detached copies when legacy and current cleanup locations coexist', async () => {
    const controller = new AbortController();
    await subject.cleanup(intent({ choice: 'delete-files' }), {
      onProgress: progress => { if (progress.phase === 'marked') controller.abort(); },
      signal: controller.signal,
    });
    const paths = await workspace.resolveCleanupPaths('workspace/project-alpha', 'cleanup-alpha');
    const legacyPath = path.join(vaultRoot, 'workspace/.claudian-collab-project-cleanup-alpha-project-alpha');
    await rename(paths.projectPath, legacyPath);
    await mkdir(paths.detachedProjectPath);
    await writeFile(path.join(paths.detachedProjectPath, 'keep.md'), 'Other work');
    await records.save({ ...records.records.get('project-alpha')!, phase: 'deleting' });

    await expect(subject.resume('project-alpha')).rejects.toMatchObject({
      code: 'workspace-boundary-invalid', safeContext: { reason: 'detached-project-location-ambiguous' },
    });
    expect(await readFile(path.join(legacyPath, 'note.md'), 'utf8')).toBe('visible\n');
    expect(await readFile(path.join(paths.detachedProjectPath, 'keep.md'), 'utf8')).toBe('Other work');
  });

  it('deletes only the exact verified Project root and preserves siblings', async () => {
    await mkdir(path.join(vaultRoot, 'workspace', 'unrelated'));
    await writeFile(path.join(vaultRoot, 'workspace', 'unrelated', 'keep.md'), 'keep\n');

    await subject.cleanup(intent({ choice: 'delete-files' }));

    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'unrelated', 'keep.md'), 'utf8'))
      .resolves.toBe('keep\n');
  });

  it('fails closed before writing a marker when Git identity does not match', async () => {
    git.assertLocalRepositoryIdentity.mockRejectedValueOnce(new Error('identity mismatch'));

    await expect(subject.cleanup(intent())).rejects.toThrow('identity mismatch');
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
  });

  it('rejects a symlinked Git directory without removing its target', async () => {
    const outside = path.join(vaultRoot, 'outside-git');
    await rm(path.join(vaultRoot, 'workspace', 'project-alpha', '.git'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'outside\n');
    await symlink(outside, path.join(vaultRoot, 'workspace', 'project-alpha', '.git'));

    await expect(subject.cleanup(intent())).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'project-git-invalid' },
    });
    await expect(readFile(path.join(outside, 'keep'), 'utf8')).resolves.toBe('outside\n');
  });

  it('never follows a pre-existing detached-marker symlink', async () => {
    const outsideMarker = path.join(vaultRoot, 'outside-marker.json');
    await writeFile(outsideMarker, 'outside\n');
    await symlink(
      outsideMarker,
      path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json'),
    );

    await expect(subject.cleanup(intent())).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'symbolic-link-boundary' },
    });
    await expect(readFile(outsideMarker, 'utf8')).resolves.toBe('outside\n');
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.git')))
      .resolves.toBeDefined();
  });

  it('resumes after cancellation at a durable phase', async () => {
    const controller = new AbortController();
    const first = await subject.cleanup(intent(), {
      onProgress: progress => {
        if (progress.phase === 'marked') controller.abort();
      },
      signal: controller.signal,
    });
    expect(first).toEqual({ phase: 'marked', status: 'cancelled' });
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.git')))
      .resolves.toBeDefined();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete' });
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.git')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes a Windows-style lock failure after Git was detached', async () => {
    const remove = jest.spyOn(workspace, 'removeDetachedProjectGit')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }));

    await expect(subject.cleanup(intent())).rejects.toMatchObject({ code: 'EPERM' });
    expect(records.records.get('project-alpha')?.phase).toBe('detached');
    remove.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete' });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
  });

  it('resumes when the process stops after Git is renamed but before the checkpoint advances', async () => {
    const originalDetach = workspace.detachProjectGit.bind(workspace);
    const detach = jest.spyOn(workspace, 'detachProjectGit')
      .mockImplementationOnce(async (...args) => {
        await originalDetach(...args);
        throw Object.assign(new Error('crash after Git rename'), { code: 'EIO' });
      });

    await expect(subject.cleanup(intent())).rejects.toMatchObject({ code: 'EIO' });
    expect(records.records.get('project-alpha')?.phase).toBe('git-detaching');
    detach.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete' });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
  });

  it('resumes when the process stops after the Leave marker is removed', async () => {
    const originalRemove = workspace.removeDetachedProjectMarker.bind(workspace);
    const remove = jest.spyOn(workspace, 'removeDetachedProjectMarker')
      .mockImplementationOnce(async (...args) => {
        await originalRemove(...args);
        throw Object.assign(new Error('crash after marker removal'), { code: 'EIO' });
      });

    await expect(subject.cleanup(intent())).rejects.toMatchObject({ code: 'EIO' });
    expect(records.records.get('project-alpha')?.phase).toBe('marker-removing');
    remove.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete' });
  });

  it('resumes partial whole-Project deletion without touching unrelated files', async () => {
    const remove = jest.spyOn(workspace, 'removeDetachedProjectRoot')
      .mockRejectedValueOnce(Object.assign(new Error('partial'), { code: 'EPERM' }));
    await writeFile(path.join(vaultRoot, 'workspace', 'unrelated.md'), 'keep\n');

    await expect(subject.cleanup(intent({ choice: 'delete-files' }))).rejects.toMatchObject({ code: 'EPERM' });
    expect(records.records.get('project-alpha')?.phase).toBe('deleting');
    remove.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({ status: 'complete' });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'unrelated.md'), 'utf8'))
      .resolves.toBe('keep\n');
  });

  it('checkpoints completed deletion when a crash follows exact root removal', async () => {
    const originalRemove = workspace.removeDetachedProjectRoot.bind(workspace);
    const remove = jest.spyOn(workspace, 'removeDetachedProjectRoot')
      .mockImplementationOnce(async (...args) => {
        await originalRemove(...args);
        throw Object.assign(new Error('crash after removal'), { code: 'EIO' });
      });

    await expect(subject.cleanup(intent({ choice: 'delete-files' })))
      .rejects.toMatchObject({ code: 'EIO' });
    expect(records.records.get('project-alpha')?.phase).toBe('deleting');
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    remove.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({
      filesPreserved: false,
      status: 'complete',
    });
    expect(records.records.get('project-alpha')?.phase).toBe('complete');
  });

  it('retains an exact marker after automatic Retire detach and finalizes Keep', async () => {
    await expect(subject.cleanup(intent({ purpose: 'retire' }))).resolves.toMatchObject({
      markerRetained: true,
      status: 'complete',
    });
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json')))
      .resolves.toBeDefined();

    await expect(subject.finalizeRetiredChoice({
      choice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toEqual({
      filesPreserved: true,
      gitDataRemoved: true,
      markerRetained: false,
      status: 'complete',
    });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
    expect(records.records.get('project-alpha')?.phase).toBe('choice-applied');
    await subject.completeRetiredFinalization('project-alpha');
    expect(records.records.has('project-alpha')).toBe(false);
  });

  it('resumes Retired Keep finalization after the marker was removed', async () => {
    await subject.cleanup(intent({ purpose: 'retire' }));
    const originalRemove = workspace.removeDetachedProjectMarker.bind(workspace);
    const remove = jest.spyOn(workspace, 'removeDetachedProjectMarker')
      .mockImplementationOnce(async (...args) => {
        await originalRemove(...args);
        throw Object.assign(new Error('crash after marker removal'), { code: 'EIO' });
      });

    await expect(subject.finalizeRetiredChoice({
      choice: 'keep-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({ code: 'EIO' });
    expect(records.records.get('project-alpha')?.phase).toBe('marker-removing');
    remove.mockRestore();

    await expect(subject.resume('project-alpha')).resolves.toMatchObject({
      markerRetained: false,
      status: 'complete',
    });
    expect(records.records.get('project-alpha')?.phase).toBe('choice-applied');
    await subject.completeRetiredFinalization('project-alpha');
    expect(records.records.has('project-alpha')).toBe(false);
  });

  it('rejects a tampered or symlinked Retired marker', async () => {
    await subject.cleanup(intent({ purpose: 'retire' }));
    const markerPath = path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(markerPath, JSON.stringify({ ...marker, nonce: 'b'.repeat(43) }));

    await expect(subject.finalizeRetiredChoice({
      choice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'detached-marker-mismatch' },
    });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
  });

  it('rejects a missing or symlinked Retired marker without deleting files', async () => {
    await subject.cleanup(intent({ purpose: 'retire' }));
    const markerPath = path.join(vaultRoot, 'workspace', 'project-alpha', '.claudian-collab-detached.json');
    const copiedMarkerPath = path.join(vaultRoot, 'copied-marker.json');
    await writeFile(copiedMarkerPath, JSON.stringify({
      cleanupOperationId: 'other-operation',
      createdAt: testTime({ days: -14 }),
      memberId: 'member-alpha',
      nonce: 'b'.repeat(43),
      projectId: 'project-alpha',
      purpose: 'retire',
      schemaVersion: 1,
    }));
    await rm(markerPath);

    await expect(subject.finalizeRetiredChoice({
      choice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'detached-marker-invalid' },
    });

    await symlink(copiedMarkerPath, markerPath);
    await expect(subject.finalizeRetiredChoice({
      choice: 'delete-files',
      projectId: 'project-alpha',
    })).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'detached-marker-invalid' },
    });
    await expect(readFile(path.join(vaultRoot, 'workspace', 'project-alpha', 'note.md'), 'utf8'))
      .resolves.toBe('visible\n');
  });

  it('persists the final Retired Delete choice before detaching and resumes it', async () => {
    await subject.cleanup(intent({ purpose: 'retire' }));
    const controller = new AbortController();

    await expect(subject.finalizeRetiredChoice({
      choice: 'delete-files',
      projectId: 'project-alpha',
    }, {
      onProgress: progress => {
        if (progress.phase === 'deleting') controller.abort();
      },
      signal: controller.signal,
    })).resolves.toEqual({ phase: 'deleting', status: 'cancelled' });
    expect(records.records.get('project-alpha')?.choice).toBe('delete-files');

    await expect(subject.resume('project-alpha')).resolves.toEqual({
      filesPreserved: false,
      gitDataRemoved: true,
      markerRetained: false,
      status: 'complete',
    });
    await expect(lstat(path.join(vaultRoot, 'workspace', 'project-alpha')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(records.records.get('project-alpha')?.phase).toBe('choice-applied');
    await subject.completeRetiredFinalization('project-alpha');
    expect(records.records.has('project-alpha')).toBe(false);
  });
});
