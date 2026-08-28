import {
  ensureTrustedCollabOrigin,
  rotateAuthorityTransferOrigin,
  rotateCloudBootstrapOrigin,
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

  it('establishes the first trusted origin for a fresh Host Project', async () => {
    const repository = git([]);

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

  it('repairs a legacy stopped-Host origin without creating a new sentinel', async () => {
    const repository = git([
      'https://127.0.0.1:1/claudian-collab/host-stopped/project-a',
    ]);

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

  it('establishes an absent origin from the exact trusted membership route', async () => {
    const repository = git([]);

    await ensureTrustedCollabOrigin(repository, {
      projectId,
      remoteUrl: newUrl,
      repositoryPath: '/vault/workspace/project-a',
    }, 'origin-mismatch');

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newUrl,
    );
  });

  it('rejects a failed first-origin write', async () => {
    const repository = {
      addRemote: jest.fn().mockResolvedValue(undefined),
      listRemoteUrls: jest.fn().mockResolvedValue([]),
    };

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
  });

  it('rotates an older same-Project origin after the Host address changed', async () => {
    const previousUrl = 'https://192.168.1.5:54545/v1/git/project-a/repository.git';
    const repository = git([previousUrl]);

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

  it('rotates an exact LAN origin to the canonical Cloud Project route idempotently', async () => {
    const cloudUrl = 'https://cloud.example.test/v2/projects/project-a/repository.git';
    const repository = git([oldUrl]);

    await rotateCloudBootstrapOrigin(repository, {
      newRemoteUrl: cloudUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });
    await rotateCloudBootstrapOrigin(repository, {
      newRemoteUrl: cloudUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledTimes(1);
  });

  it('rotates a stale generated same-Project LAN origin after Host readdressing', async () => {
    const cloudUrl = 'https://cloud.example.test/v2/projects/project-a/repository.git';
    const staleLanUrl = 'https://192.168.1.5:54545/v1/git/project-a/repository.git';
    const repository = git([staleLanUrl]);

    await rotateCloudBootstrapOrigin(repository, {
      newRemoteUrl: cloudUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      cloudUrl,
    );
  });

  it('rejects a non-canonical Cloud Project route', async () => {
    const repository = git([oldUrl]);

    await expect(rotateCloudBootstrapOrigin(repository, {
      newRemoteUrl: 'https://cloud.example.test/v2/projects/project-b/repository.git',
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(repository.listRemoteUrls).not.toHaveBeenCalled();
  });

  it('permits the canonical loopback development Cloud route', async () => {
    const repository = git([oldUrl]);

    await rotateCloudBootstrapOrigin(repository, {
      newRemoteUrl: 'http://127.0.0.1:8787/v2/projects/project-a/repository.git',
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledTimes(1);
  });

  it('rotates exact authority-transfer origins in both directions', async () => {
    const cloudUrl = 'https://cloud.example.test/v2/projects/project-a/repository.git';
    const toCloud = git([oldUrl]);
    await rotateAuthorityTransferOrigin(toCloud, {
      newRemoteUrl: cloudUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });
    const toLan = git([cloudUrl]);
    await rotateAuthorityTransferOrigin(toLan, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: cloudUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(toCloud.addRemote).toHaveBeenCalledTimes(1);
    expect(toLan.addRemote).toHaveBeenCalledTimes(1);
  });

  it('rotates a fenced stopped-Host origin to Cloud after LAN relinquishment', async () => {
    const cloudUrl = 'https://cloud.example.test/v2/projects/project-a/repository.git';
    const repository = git([
      'https://127.0.0.1:1/claudian-collab/host-stopped/project-a',
    ]);

    await rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: cloudUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      cloudUrl,
    );
  });

  it('rejects same-kind and cross-Project authority-transfer origins', async () => {
    const repository = git([oldUrl]);

    await expect(rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: newUrl,
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
    await expect(rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: 'https://cloud.example.test/v2/projects/project-b/repository.git',
      oldRemoteUrl: oldUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(repository.listRemoteUrls).not.toHaveBeenCalled();
  });
});
