import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { AuthorityTransferCheckpointGit } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointGit';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';

it('settles failed checkpoint commands before cleanup releases the authority resource', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'checkpoint-settlement-'));
  const projects = new CollabLocalProjectRepository(root, { installationKey: TEST_INSTALLATION_A });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let childPending = false;
  try {
    const resource = await projects.prepareProvisionalAuthorityDirectory('project-alpha', {
      kind: 'authority-transfer', operationId: 'transfer-git', transferId: 'transfer-git',
      sourceGeneration: 1, targetGeneration: 2,
    });
    const bundlePath = path.join(root, 'repository.bundle');
    await writeFile(bundlePath, 'x');
    const manifest = createAuthorityTransferCheckpointManifest({
      artifacts: [
        { byteCount: 1, name: 'coordination.ndjson', sha256: 'a'.repeat(64) },
        { byteCount: 1, name: 'repository.bundle', sha256: createHash('sha256').update('x').digest('hex') },
      ],
      createdAt: '2026-08-26T00:00:00.000Z', expectedMainOid: 'a'.repeat(40), gitObjectFormat: 'sha1',
      operationId: 'transfer-git', projectId: 'project-alpha',
      refs: [{ name: 'refs/heads/main', oid: 'a'.repeat(40) }],
      sourceAuthority: { generation: 1, kind: 'cloud' }, targetAuthority: { generation: 2, kind: 'lan' },
    });
    const runner: Pick<GitCommandRunner, 'run'> = {
      run: async request => {
        if (request.args[0] === 'symbolic-ref') throw new Error('injected identity command failure');
        if (request.args[0] === 'rev-parse') {
          childPending = true;
          await delayed;
          childPending = false;
        }
        return { stdout: Buffer.from(''), stderr: '', exitCode: 0 };
      },
    };
    const operation = projects.withAuthorityDirectory(resource, () => (
      new AuthorityTransferCheckpointGit(runner).importIntoEmptyBareRepository({
        bundlePath, manifest, targetRepositoryPath: path.join(resource.authorityDirectory, 'repository.git'),
      })
    ));
    await expect(operation).rejects.toThrow('injected identity command failure');
    expect(childPending).toBe(false);
    await expect(projects.removeProvisionalAuthorityDirectory(resource)).resolves.toBe(true);
  } finally {
    release();
    await delayed;
    await rm(root, { recursive: true, force: true });
  }
});
