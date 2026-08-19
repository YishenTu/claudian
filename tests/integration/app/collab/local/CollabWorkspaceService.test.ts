import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';

describe('CollabWorkspaceService', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-collab-workspace-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('adopts the guarded historical workspace without deleting unrelated rules', async () => {
    await mkdir(path.join(vaultRoot, 'workspace'));
    await writeFile(
      path.join(vaultRoot, 'workspace', '.gitignore'),
      '# Retain this comment\n/custom\n\n/*\n/*\n\n',
    );
    const service = new CollabWorkspaceService(vaultRoot);

    await service.ensureWorkspaceContainer();

    expect(await readFile(path.join(vaultRoot, 'workspace', '.gitignore'), 'utf8'))
      .toBe('# Retain this comment\n/custom\n\n/*\n\n');
    expect(JSON.parse(await readFile(
      path.join(vaultRoot, 'workspace', '.claudian-collab-root.json'),
      'utf8',
    ))).toEqual({ owner: 'claudian-collab-projects', schemaVersion: 1 });
  });

  it('claims a nested custom Projects folder with a marker and guard', async () => {
    const service = new CollabWorkspaceService(vaultRoot);

    await service.claimProjectsFolder('Shared/Collab Projects');

    expect(JSON.parse(await readFile(
      path.join(vaultRoot, 'Shared', 'Collab Projects', '.claudian-collab-root.json'),
      'utf8',
    ))).toEqual({ owner: 'claudian-collab-projects', schemaVersion: 1 });
    expect(await readFile(
      path.join(vaultRoot, 'Shared', 'Collab Projects', '.gitignore'),
      'utf8',
    )).toBe('/*\n');
  });

  it('accepts an empty or already owned custom Projects folder', async () => {
    await mkdir(path.join(vaultRoot, 'Shared', 'Projects'), { recursive: true });
    await chmod(path.join(vaultRoot, 'Shared'), 0o700);
    await chmod(path.join(vaultRoot, 'Shared', 'Projects'), 0o700);
    const service = new CollabWorkspaceService(vaultRoot);
    await service.claimProjectsFolder('Shared/Projects');
    await writeFile(path.join(vaultRoot, 'Shared', 'Projects', 'keep.txt'), 'owned');

    await expect(service.claimProjectsFolder('Shared/Projects')).resolves.toBeUndefined();
    await expect(readFile(
      path.join(vaultRoot, 'Shared', 'Projects', 'keep.txt'),
      'utf8',
    )).resolves.toBe('owned');
    expect((await stat(path.join(vaultRoot, 'Shared'))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(vaultRoot, 'Shared', 'Projects'))).mode & 0o777)
      .toBe(0o700);
  });

  it('resolves only Project paths under an owned root and adopts the guarded legacy root', async () => {
    const service = new CollabWorkspaceService(vaultRoot);
    await mkdir(path.join(vaultRoot, 'workspace', 'project-alpha'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'workspace', '.gitignore'), '/*\n');

    await expect(service.resolveManagedProjectPath('workspace/project-alpha'))
      .resolves.toBe(path.join(vaultRoot, 'workspace', 'project-alpha'));
    await expect(readFile(
      path.join(vaultRoot, 'workspace', '.claudian-collab-root.json'),
      'utf8',
    )).resolves.toContain('claudian-collab-projects');

    await mkdir(path.join(vaultRoot, 'Unowned', 'project-beta'), { recursive: true });
    await expect(service.resolveManagedProjectPath('Unowned/project-beta')).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'projects-root-unowned-nonempty' },
    });
  });

  it('rejects an unrelated non-empty custom folder before writing ownership files', async () => {
    await mkdir(path.join(vaultRoot, 'Shared', 'Projects'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'Shared', 'Projects', 'keep.txt'), 'unrelated');
    await chmod(path.join(vaultRoot, 'Shared'), 0o700);
    await chmod(path.join(vaultRoot, 'Shared', 'Projects'), 0o700);
    const service = new CollabWorkspaceService(vaultRoot);

    await expect(service.claimProjectsFolder('Shared/Projects')).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
      safeContext: { reason: 'projects-root-unowned-nonempty' },
    });
    await expect(readFile(
      path.join(vaultRoot, 'Shared', 'Projects', '.claudian-collab-root.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(vaultRoot, 'Shared'))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(vaultRoot, 'Shared', 'Projects'))).mode & 0o777)
      .toBe(0o700);
  });

  it('rejects invalid or symlinked ownership files without overwriting them', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'claudian-collab-root-files-'));
    try {
      const invalidRoot = path.join(vaultRoot, 'InvalidRoot');
      await mkdir(invalidRoot);
      await writeFile(path.join(invalidRoot, '.claudian-collab-root.json'), JSON.stringify({
        owner: 'another-application',
        schemaVersion: 1,
      }));
      const linkedRoot = path.join(vaultRoot, 'LinkedRoot');
      await mkdir(linkedRoot);
      await writeFile(path.join(outside, 'marker.json'), JSON.stringify({
        owner: 'claudian-collab-projects',
        schemaVersion: 1,
      }));
      await symlink(
        path.join(outside, 'marker.json'),
        path.join(linkedRoot, '.claudian-collab-root.json'),
      );
      const service = new CollabWorkspaceService(vaultRoot);

      await expect(service.claimProjectsFolder('InvalidRoot')).rejects.toMatchObject({
        code: 'workspace-boundary-invalid',
      });
      await expect(service.claimProjectsFolder('LinkedRoot')).rejects.toMatchObject({
        code: 'workspace-boundary-invalid',
      });
      expect(JSON.parse(await readFile(
        path.join(invalidRoot, '.claudian-collab-root.json'),
        'utf8',
      ))).toEqual({ owner: 'another-application', schemaVersion: 1 });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('removes a temporary child only with exact root and operation ownership', async () => {
    const service = new CollabWorkspaceService(vaultRoot);
    await service.claimProjectsFolder('Shared/Projects');
    const ownership = {
      childName: '.claudian-seed-project-alpha',
      operationId: 'create-alpha',
      projectId: 'project-alpha',
      purpose: 'create-seed' as const,
    };
    const reserved = await service.reserveProjectsFolderChild(
      'Shared/Projects',
      ownership,
    );
    await mkdir(reserved.absolutePath);
    await writeFile(path.join(reserved.absolutePath, 'keep.md'), 'temporary\n');

    await expect(service.removeReservedProjectsFolderChild('Shared/Projects', {
      ...ownership,
      operationId: 'create-other',
    })).resolves.toBe(false);
    await expect(readFile(path.join(reserved.absolutePath, 'keep.md'), 'utf8'))
      .resolves.toBe('temporary\n');
    await expect(service.removeReservedProjectsFolderChild(
      'Shared/Projects',
      ownership,
    )).resolves.toBe(true);
    await expect(stat(reserved.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('owns Host-transfer staging by exact transfer and purpose before cleanup', async () => {
    const service = new CollabWorkspaceService(vaultRoot);
    await service.claimProjectsFolder('Shared/Projects');
    const ownership = {
      childName: '.claudian-host-transfer-transfer-alpha',
      operationId: 'transfer-alpha',
      projectId: 'project-alpha',
      purpose: 'host-transfer-staging' as const,
    };
    const reserved = await service.reserveProjectsFolderChild('Shared/Projects', ownership);
    await mkdir(reserved.absolutePath);
    await writeFile(path.join(reserved.absolutePath, 'authority.bundle'), 'private artifact');

    await expect(service.removeReservedProjectsFolderChild('Shared/Projects', {
      ...ownership,
      operationId: 'transfer-beta',
    })).resolves.toBe(false);
    await expect(readFile(path.join(reserved.absolutePath, 'authority.bundle'), 'utf8'))
      .resolves.toBe('private artifact');
    await expect(service.removeReservedProjectsFolderChild('Shared/Projects', ownership))
      .resolves.toBe(true);
    await expect(stat(reserved.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps Project children ignored before or after Vault Git initialization', async () => {
    const service = new CollabWorkspaceService(vaultRoot);
    await service.ensureWorkspaceContainer();
    await mkdir(path.join(vaultRoot, 'workspace', 'project'));
    await writeFile(path.join(vaultRoot, 'workspace', 'project', 'note.md'), 'draft');

    expect(spawnSync('git', ['init', '--quiet'], { cwd: vaultRoot }).status).toBe(0);
    expect(spawnSync(
      'git',
      ['check-ignore', '--quiet', 'workspace/project/note.md'],
      { cwd: vaultRoot },
    ).status).toBe(0);
  });

  it('rejects a symlinked Projects folder without writing through it', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'claudian-collab-outside-'));
    try {
      await symlink(outside, path.join(vaultRoot, 'workspace'), 'junction');
      const service = new CollabWorkspaceService(vaultRoot);

      await expect(service.ensureWorkspaceContainer()).rejects.toMatchObject({
        code: 'workspace-boundary-invalid',
      });
      await expect(readFile(path.join(outside, '.gitignore'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
