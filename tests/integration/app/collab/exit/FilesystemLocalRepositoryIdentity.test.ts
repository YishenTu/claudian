import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FilesystemLocalRepositoryIdentity } from '@/app/collab/exit/FilesystemLocalRepositoryIdentity';

describe('FilesystemLocalRepositoryIdentity', () => {
  let root: string;
  const expected = {
    memberId: 'member-alpha',
    personalRef: 'refs/heads/members/member-alpha',
    projectId: 'project-alpha',
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-retired-identity-'));
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), [
      '[core]',
      '\trepositoryformatversion = 0',
      '[claudian]',
      '\tprojectId = project-alpha',
      '\tmemberId = member-alpha',
      '\tpersonalRef = refs/heads/members/member-alpha',
      '',
    ].join('\n'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('verifies the exact Claudian repository identity without a Git process', async () => {
    await expect(new FilesystemLocalRepositoryIdentity()
      .assertLocalRepositoryIdentity(root, expected)).resolves.toBeUndefined();
  });

  it('fails closed on an identity mismatch', async () => {
    await expect(new FilesystemLocalRepositoryIdentity().assertLocalRepositoryIdentity(root, {
      ...expected,
      projectId: 'project-other',
    })).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'collab-local-config-mismatch' },
    });
  });

  it('never follows a symlinked Git directory', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'claudian-retired-git-'));
    await rm(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(outside, '.git'), { recursive: true });
    await writeFile(path.join(outside, '.git', 'config'), '[claudian]\nprojectId = project-alpha\n');
    await symlink(path.join(outside, '.git'), path.join(root, '.git'));

    await expect(new FilesystemLocalRepositoryIdentity()
      .assertLocalRepositoryIdentity(root, expected)).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'collab-local-git-directory-invalid' },
    });
    await rm(outside, { force: true, recursive: true });
  });
});
