import {
  ensureTrustedCollabOrigin,
  rotateAuthorityTransferOrigin,
  rotateCloudRelocationOrigin,
  rotateTrustedCollabOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';

const projectId = 'project-a';
const oldURL = 'https://192.168.1.10:54545/v1/git/project-a/repository.git';
const newURL = 'https://192.168.1.20:54545/v1/git/project-a/repository.git';

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
  it('accepts only persisted locators when recovery supplies an exact origin plan', async () => {
    const repository = git(['https://192.168.1.99:54545/v1/git/project-a/repository.git']);
    await expect(rotateAuthorityTransferOrigin(repository, { projectId, repositoryPath: '/vault/project-a',
      oldRemoteUrl: oldURL, oldServerUrl: null, newRemoteUrl: newURL, newServerUrl: null,
      exactBindings: true, retainedBindings: [{ remoteUrl: oldURL, serverUrl: null }] })).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(await repository.listRemoteUrls()).toEqual(['https://192.168.1.99:54545/v1/git/project-a/repository.git']);
  });

  it('rotates one exact trusted same-Project Member origin', async () => {
    const repository = git([oldURL]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newURL,
    );
  });

  it('accepts an already rotated trusted origin without rewriting it', async () => {
    const repository = git([newURL]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).not.toHaveBeenCalled();
  });

  it('establishes the first trusted origin for a fresh Host Project', async () => {
    const repository = git([]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newURL,
    );
  });

  it('repairs a legacy stopped-Host origin without creating a new sentinel', async () => {
    const repository = git([
      'https://127.0.0.1:1/claudian-collab/host-stopped/project-a',
    ]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newURL,
    );
  });

  it('establishes an absent origin from the exact trusted membership route', async () => {
    const repository = git([]);

    await ensureTrustedCollabOrigin(repository, {
      projectId,
      remoteUrl: newURL,
      repositoryPath: '/vault/workspace/project-a',
    }, 'origin-mismatch');

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newURL,
    );
  });

  it('rejects a failed first-origin write', async () => {
    const repository = {
      addRemote: jest.fn().mockResolvedValue(undefined),
      listRemoteUrls: jest.fn().mockResolvedValue([]),
    };

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
  });

  it('rotates an older same-Project origin after the Host address changed', async () => {
    const previousUrl = 'https://192.168.1.5:54545/v1/git/project-a/repository.git';
    const repository = git([previousUrl]);

    await rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newURL,
    );
  });

  it.each([
    ['an arbitrary origin', ['https://example.com/repository.git']],
    ['multiple origins', [oldURL, newURL]],
    ['a cross-Project old URL', [
      'https://192.168.1.10:54545/v1/git/project-b/repository.git',
    ]],
  ])('rejects %s', async (_label, urls) => {
    const repository = git(urls);

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: newURL,
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toEqual(expect.objectContaining({
      code: 'repository-invalid',
    }));
    expect(repository.addRemote).not.toHaveBeenCalled();
  });

  it('rejects a cross-Project trusted transition before reading Git', async () => {
    const repository = git([oldURL]);

    await expect(rotateTrustedCollabOrigin(repository, {
      newRemoteUrl: 'https://192.168.1.20:54545/v1/git/project-b/repository.git',
      oldRemoteUrl: oldURL,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toEqual(expect.objectContaining({
      code: 'repository-invalid',
    }));
    expect(repository.listRemoteUrls).not.toHaveBeenCalled();
  });

  it('relocates between exact prefix-preserving Cloud origins idempotently', async () => {
    const oldServerUrl = 'https://old.example.test/operator';
    const newServerUrl = 'http://new.example.test/proxy/cloud';
    const oldCloudUrl = `${oldServerUrl}/v10/projects/project-a/repository.git`;
    const newCloudUrl = `${newServerUrl}/v10/projects/project-a/repository.git`;
    const repository = git([oldCloudUrl]);

    const transition = {
      newRemoteUrl: newCloudUrl,
      newServerUrl,
      oldRemoteUrl: oldCloudUrl,
      oldServerUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    };
    await rotateCloudRelocationOrigin(repository, transition);
    await rotateCloudRelocationOrigin(repository, transition);

    expect(repository.addRemote).toHaveBeenCalledTimes(1);
    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      newCloudUrl,
    );
  });

  it('rejects a reconstructed prefix or unexpected existing Cloud origin', async () => {
    const oldServerUrl = 'https://old.example.test/operator';
    const newServerUrl = 'https://new.example.test/proxy/cloud';
    const repository = git([
      'https://other.example.test/v10/projects/project-a/repository.git',
    ]);

    await expect(rotateCloudRelocationOrigin(repository, {
      newRemoteUrl: 'https://new.example.test/v10/projects/project-a/repository.git',
      newServerUrl,
      oldRemoteUrl: `${oldServerUrl}/v10/projects/project-a/repository.git`,
      oldServerUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(repository.listRemoteUrls).not.toHaveBeenCalled();
  });

  it('rotates exact authority-transfer origins in both directions', async () => {
    const cloudUrl = 'https://cloud.example.test/v10/projects/project-a/repository.git';
    const toCloud = git([oldURL]);
    await rotateAuthorityTransferOrigin(toCloud, {
      newRemoteUrl: cloudUrl,
      newServerUrl: 'https://cloud.example.test',
      oldRemoteUrl: oldURL,
      oldServerUrl: null,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });
    const toLan = git([cloudUrl]);
    await rotateAuthorityTransferOrigin(toLan, {
      newRemoteUrl: newURL,
      newServerUrl: null,
      oldRemoteUrl: cloudUrl,
      oldServerUrl: 'https://cloud.example.test',
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(toCloud.addRemote).toHaveBeenCalledTimes(1);
    expect(toLan.addRemote).toHaveBeenCalledTimes(1);
  });

  it('retains the exact Cloud deployment prefix for authority transfer origins', async () => {
    const cloudServerUrl = 'https://cloud.example.test/operator/v3';
    const cloudUrl = `${cloudServerUrl}/v10/projects/project-a/repository.git`;
    const toCloud = git([oldURL]);
    await rotateAuthorityTransferOrigin(toCloud, {
      newRemoteUrl: cloudUrl,
      newServerUrl: cloudServerUrl,
      oldRemoteUrl: oldURL,
      oldServerUrl: null,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });
    const toLan = git([cloudUrl]);
    await rotateAuthorityTransferOrigin(toLan, {
      newRemoteUrl: newURL,
      newServerUrl: null,
      oldRemoteUrl: cloudUrl,
      oldServerUrl: cloudServerUrl,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(toCloud.addRemote).toHaveBeenCalledTimes(1);
    expect(toLan.addRemote).toHaveBeenCalledTimes(1);
  });

  it('rotates a fenced stopped-Host origin to Cloud after LAN relinquishment', async () => {
    const cloudUrl = 'https://cloud.example.test/v10/projects/project-a/repository.git';
    const repository = git([
      'https://127.0.0.1:1/claudian-collab/host-stopped/project-a',
    ]);

    await rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: cloudUrl,
      newServerUrl: 'https://cloud.example.test',
      oldRemoteUrl: oldURL,
      oldServerUrl: null,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    });

    expect(repository.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      cloudUrl,
    );
  });

  it('finishes Cloud-to-LAN convergence when origin changed before membership and the target moved again', async () => {
    const repository = git([oldURL]);
    await expect(rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: newURL,
      newServerUrl: null,
      oldRemoteUrl: 'https://cloud.example.test/v10/projects/project-a/repository.git',
      oldServerUrl: 'https://cloud.example.test',
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).resolves.toBeUndefined();
    expect(repository.addRemote).toHaveBeenCalledWith('/vault/workspace/project-a', 'origin', newURL);
  });

  it('recovers an authenticated LAN target location and rejects a different Project', async () => {
    const repository = git([oldURL]);

    await expect(rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: newURL,
      newServerUrl: null,
      oldRemoteUrl: oldURL,
      oldServerUrl: null,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).resolves.toBeUndefined();
    expect(repository.addRemote).toHaveBeenCalledWith('/vault/workspace/project-a', 'origin', newURL);
    await expect(rotateAuthorityTransferOrigin(repository, {
      newRemoteUrl: 'https://cloud.example.test/v10/projects/project-b/repository.git',
      newServerUrl: 'https://cloud.example.test',
      oldRemoteUrl: oldURL,
      oldServerUrl: null,
      projectId,
      repositoryPath: '/vault/workspace/project-a',
    })).rejects.toMatchObject({ code: 'repository-invalid' });
  });
});
