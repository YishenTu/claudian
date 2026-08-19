import {
  rotateTrustedCollabOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';

const projectId = 'project-a';
const oldUrl = 'https://192.168.1.10:54545/v1/git/project-a/repository.git';
const newUrl = 'https://192.168.1.20:54545/v1/git/project-a/repository.git';

function git(urls: readonly string[]) {
  let current = [...urls];
  return {
    addRemote: jest.fn(async (_path: string, _remote: string, url: string) => {
      current = [url];
    }),
    listRemoteUrls: jest.fn(async () => current),
  };
}

describe('CollabGitOriginPolicy', () => {
  it('rotates one exact trusted same-Project Member origin', async () => {
    const repository = git([oldUrl]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newUrl,
    );
  });

  it('accepts an already rotated trusted origin without rewriting it', async () => {
    const repository = git([newUrl]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).not.toHaveBeenCalled();
  });

  it.each([
    ['an arbitrary origin', ['https://example.com/repository.git']],
    ['multiple origins', [oldUrl, newUrl]],
    ['a cross-Project old URL', [
      'https://192.168.1.10:54545/v1/git/project-b/repository.git',
    ]],
  ])('rejects %s', async (_label, urls) => {
    const repository = git(urls);

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toEqual(expect.objectContaining({
      code: 'repository-invalid',
    }));
    expect(repository.addRemote).not.toHaveBeenCalled();
  });

  it('rejects a cross-Project trusted transition before reading Git', async () => {
    const repository = git([oldUrl]);

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: 'https://192.168.1.20:54545/v1/git/project-b/repository.git',
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toEqual(expect.objectContaining({
      code: 'repository-invalid',
    }));
    expect(repository.listRemoteUrls).not.toHaveBeenCalled();
  });
});
