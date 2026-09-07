import {
  lstat,
  mkdir,
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
  HostInstallationBindingService,
  type HostInstallationBindingServiceOptions,
} from '@/app/collab/host-installation/HostInstallationBindingService';
import { parseInstallationKey } from '@/core/device/InstallationKey';

const PROJECT_ID = 'project-alpha';
const INSTALLATION_A = parseInstallationKey(`device-${'a'.repeat(64)}`);
const INSTALLATION_B = parseInstallationKey(`device-${'b'.repeat(64)}`);

describe('HostInstallationBindingService filesystem boundary', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-host-installation-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  function createBinding(
    installationKey = INSTALLATION_A,
    prepareLegacyRuntime?: () => Promise<void>,
    bindEligibleLegacyRecovery?: HostInstallationBindingServiceOptions[
      'bindEligibleLegacyRecovery'
    ],
  ) {
    const projects = new CollabLocalProjectRepository(vaultRoot, { installationKey });
    return {
      binding: new HostInstallationBindingService({
        installationKey,
        prepareLegacyRuntime: prepareLegacyRuntime ?? (async () => undefined),
        bindEligibleLegacyRecovery: bindEligibleLegacyRecovery
          ?? (async () => undefined),
        projects,
      }),
      projects,
    };
  }

  function authorityDirectory(): string {
    return path.join(vaultRoot, '.claudian', 'collab', 'authorities', PROJECT_ID);
  }

  function markerPath(): string {
    return path.join(authorityDirectory(), '.claudian-authority.json');
  }

  async function writeMarker(value: unknown): Promise<void> {
    await mkdir(authorityDirectory(), { recursive: true });
    await writeFile(markerPath(), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  it('writes schema 2 before exposing a newly owned authority capability', async () => {
    const { binding } = createBinding();

    await expect(binding.inspect(PROJECT_ID)).resolves.toBe('absent');
    const capability = await binding.createOwned(PROJECT_ID);

    expect(capability.projectId).toBe(PROJECT_ID);
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    await expect(binding.inspect(PROJECT_ID)).resolves.toBe('hosted-here');
  });

  it('classifies a copied schema 2 marker as foreign and rejects every authority capability', async () => {
    const { binding: owner } = createBinding(INSTALLATION_A);
    await owner.createOwned(PROJECT_ID);
    await writeFile(path.join(authorityDirectory(), 'collab.db'), 'private-authority');

    const { binding: foreign } = createBinding(INSTALLATION_B);

    await expect(foreign.inspect(PROJECT_ID)).resolves.toBe('hosted-elsewhere');
    await expect(foreign.assertOwned(PROJECT_ID, 'open')).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'host-installation-owner-mismatch' },
    });
    await expect(foreign.createOwned(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    await expect(readFile(path.join(authorityDirectory(), 'collab.db'), 'utf8'))
      .resolves.toBe('private-authority');
  });

  it('treats schema 1 as legacy and claims only after explicit runtime preparation', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    await writeFile(path.join(authorityDirectory(), 'collab.db'), 'legacy-authority');
    const phases: string[] = [];
    const { binding } = createBinding(INSTALLATION_A, async () => {
      phases.push('runtime-prepared');
      expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
        projectId: PROJECT_ID,
        schemaVersion: 1,
      });
    });

    await expect(binding.inspect(PROJECT_ID)).resolves.toBe('legacy-unbound');
    expect(JSON.parse(await readFile(markerPath(), 'utf8')).schemaVersion).toBe(1);
    await binding.claimLegacy(PROJECT_ID);
    phases.push('claimed');

    expect(phases).toEqual(['runtime-prepared', 'claimed']);
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    await expect(binding.claimLegacy(PROJECT_ID)).resolves.toMatchObject({ projectId: PROJECT_ID });
  });

  it('migrates eligible legacy recovery only after the explicit marker claim is durable', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    const migrations: Array<{ installationKey: string; marker: unknown; projectId: string }> = [];
    const { binding } = createBinding(INSTALLATION_A, undefined, async (
      projectId,
      installationKey,
    ) => {
      migrations.push({
        installationKey,
        marker: JSON.parse(await readFile(markerPath(), 'utf8')),
        projectId,
      });
    });

    await binding.inspect(PROJECT_ID);
    expect(migrations).toEqual([]);

    await binding.claimLegacy(PROJECT_ID);

    expect(migrations).toEqual([{
      installationKey: INSTALLATION_A,
      marker: {
        ownerInstallationKey: INSTALLATION_A,
        projectId: PROJECT_ID,
        schemaVersion: 2,
      },
      projectId: PROJECT_ID,
    }]);
  });

  it('retries an explicit legacy claim after scoped runtime preparation fails', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    const scopedRuntime = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'installations',
      INSTALLATION_A,
      'tls',
      'host-ca.json',
    );
    const prepareLegacyRuntime = jest.fn()
      .mockImplementationOnce(async () => {
        await mkdir(path.dirname(scopedRuntime), { recursive: true });
        await writeFile(scopedRuntime, 'prepared');
        throw new Error('fault after scoped CA preparation');
      })
      .mockResolvedValue(undefined);
    const { binding } = createBinding(INSTALLATION_A, prepareLegacyRuntime);

    await expect(binding.claimLegacy(PROJECT_ID)).rejects.toThrow(
      'fault after scoped CA preparation',
    );
    await expect(readFile(scopedRuntime, 'utf8')).resolves.toBe('prepared');
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      projectId: PROJECT_ID,
      schemaVersion: 1,
    });

    await expect(binding.claimLegacy(PROJECT_ID)).resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(prepareLegacyRuntime).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toMatchObject({
      ownerInstallationKey: INSTALLATION_A,
      schemaVersion: 2,
    });
  });

  it('resumes owner-bound recovery migration after the marker upgrade commits', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    const bindEligibleLegacyRecovery = jest.fn()
      .mockRejectedValueOnce(new Error('fault after marker upgrade'))
      .mockResolvedValue(undefined);
    const { binding } = createBinding(
      INSTALLATION_A,
      undefined,
      bindEligibleLegacyRecovery,
    );

    await expect(binding.claimLegacy(PROJECT_ID)).rejects.toThrow('fault after marker upgrade');
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });

    await expect(binding.claimLegacy(PROJECT_ID)).resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(bindEligibleLegacyRecovery).toHaveBeenCalledTimes(2);
  });

  it('resumes owner-bound recovery migration on start after a post-marker crash', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    const firstMigration = jest.fn().mockRejectedValue(new Error('fault after marker upgrade'));
    const { binding } = createBinding(INSTALLATION_A, undefined, firstMigration);

    await expect(binding.claimLegacy(PROJECT_ID)).rejects.toThrow('fault after marker upgrade');
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toMatchObject({
      ownerInstallationKey: INSTALLATION_A,
      schemaVersion: 2,
    });

    const resumedMigration = jest.fn().mockResolvedValue(undefined);
    const restarted = createBinding(INSTALLATION_A, undefined, resumedMigration).binding;
    await expect(restarted.assertOwned(PROJECT_ID, 'start'))
      .resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(resumedMigration).toHaveBeenCalledWith(PROJECT_ID, INSTALLATION_A);
  });

  it('revalidates an already-admitted marker capability without reentering legacy binding', async () => {
    const bindEligibleLegacyRecovery = jest.fn().mockResolvedValue(undefined);
    const { binding } = createBinding(
      INSTALLATION_A,
      undefined,
      bindEligibleLegacyRecovery,
    );
    await binding.createOwned(PROJECT_ID);

    await expect(binding.assertOwnedAfterLegacyRecoveryBinding(PROJECT_ID, 'open'))
      .resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(bindEligibleLegacyRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong Project', { ownerInstallationKey: INSTALLATION_A, projectId: 'project-other', schemaVersion: 2 }],
    ['unknown schema', { ownerInstallationKey: INSTALLATION_A, projectId: PROJECT_ID, schemaVersion: 3 }],
    ['extra field', { extra: true, ownerInstallationKey: INSTALLATION_A, projectId: PROJECT_ID, schemaVersion: 2 }],
    ['invalid owner', { ownerInstallationKey: 'device-invalid', projectId: PROJECT_ID, schemaVersion: 2 }],
  ])('rejects a %s marker without changing it', async (_label, marker) => {
    await writeMarker(marker);
    const before = await readFile(markerPath(), 'utf8');
    const { binding } = createBinding();

    await expect(binding.inspect(PROJECT_ID)).rejects.toMatchObject({ code: 'operation-failed' });
    await expect(readFile(markerPath(), 'utf8')).resolves.toBe(before);
  });

  it('rejects corrupt, oversized, and symlinked markers', async () => {
    const { binding } = createBinding();
    await mkdir(authorityDirectory(), { recursive: true });

    await writeFile(markerPath(), '{');
    await expect(binding.inspect(PROJECT_ID)).rejects.toMatchObject({ code: 'operation-failed' });

    await writeFile(markerPath(), 'x'.repeat(1_025));
    await expect(binding.inspect(PROJECT_ID)).rejects.toMatchObject({ code: 'operation-failed' });

    await rm(markerPath());
    const external = path.join(vaultRoot, 'foreign-marker.json');
    await writeFile(external, JSON.stringify({ projectId: PROJECT_ID, schemaVersion: 1 }));
    await symlink(external, markerPath());
    await expect(binding.inspect(PROJECT_ID)).rejects.toMatchObject({
      code: 'workspace-boundary-invalid',
    });
  });

  it('removes and retires authority bytes only through a current owned capability', async () => {
    const { binding, projects } = createBinding();
    const removable = await binding.createOwned(PROJECT_ID);
    await writeFile(path.join(authorityDirectory(), 'collab.db'), 'owned');

    await expect(projects.removeOwnedAuthorityDirectory(removable)).resolves.toBe(true);
    await expect(readFile(path.join(authorityDirectory(), 'collab.db'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const retiredProjectId = 'project-retire';
    const retiredAuthorityDirectory = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      retiredProjectId,
    );
    const owned = await binding.createOwned(retiredProjectId);
    await writeFile(path.join(retiredAuthorityDirectory, 'collab.db'), 'owned');
    const retired = await projects.retireOwnedAuthorityDirectory(
      owned,
      'bootstrap-attempt-one',
    );
    expect(retired).toContain('retired-lan-authorities');
    await expect(projects.retireOwnedAuthorityDirectory(
      owned,
      'bootstrap-attempt-one',
    )).resolves.toBe(retired);
  });

  it('makes owner-authorized post-cutover deletion idempotent without admitting foreign state', async () => {
    const { binding: owner } = createBinding(INSTALLATION_A);
    await owner.createOwned(PROJECT_ID);

    await expect(owner.removeOwned(PROJECT_ID)).resolves.toBe(true);
    await expect(owner.removeOwned(PROJECT_ID)).resolves.toBe(false);

    await writeMarker({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    const { binding: foreign } = createBinding(INSTALLATION_B);
    await expect(foreign.removeOwned(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
      safeContext: { reason: 'host-installation-owner-mismatch' },
    });
  });

  it('refuses a target binding when copied legacy or foreign authority state already exists', async () => {
    await writeMarker({ projectId: PROJECT_ID, schemaVersion: 1 });
    const { binding: legacy } = createBinding(INSTALLATION_A);
    await expect(legacy.bindTransferTarget(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
    });

    await writeMarker({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    const { binding: foreign } = createBinding(INSTALLATION_B);
    await expect(foreign.bindTransferTarget(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
  });

  it('keeps a Cloud-to-LAN target provisional until proof-time activation on its recorded installation', async () => {
    const { binding: owner } = createBinding(INSTALLATION_A);
    const provisional = await owner.prepareAuthorityTransferTarget(
      PROJECT_ID,
      INSTALLATION_A,
    );
    await writeFile(path.join(provisional.authorityDirectory, 'collab.db'), 'provisional');
    await mkdir(path.join(provisional.authorityDirectory, 'repository.git'));

    await expect(readFile(markerPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(owner.inspect(PROJECT_ID)).resolves.toBe('absent');

    const { binding: foreign } = createBinding(INSTALLATION_B);
    await expect(foreign.activateAuthorityTransferTarget(
      PROJECT_ID,
      INSTALLATION_A,
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-installation-recovery-owner-mismatch' },
    });
    await expect(readFile(path.join(provisional.authorityDirectory, 'collab.db'), 'utf8'))
      .resolves.toBe('provisional');
    await expect(readFile(markerPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await owner.activateAuthorityTransferTarget(PROJECT_ID, INSTALLATION_A);

    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      ownerInstallationKey: INSTALLATION_A,
      projectId: PROJECT_ID,
      schemaVersion: 2,
    });
    await expect(foreign.inspect(PROJECT_ID)).resolves.toBe('hosted-elsewhere');
  });

  it('does not create or bind a missing Cloud-to-LAN provisional authority at activation', async () => {
    const { binding: owner } = createBinding(INSTALLATION_A);

    await expect(owner.activateAuthorityTransferTarget(
      PROJECT_ID,
      INSTALLATION_A,
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-installation-target-provisional-missing' },
    });

    await expect(lstat(authorityDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
