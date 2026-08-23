import { type CollabRequestDetail } from '@claudian-collab/protocol';

import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import {
  collabStoppedHostRemoteUrl,
  type GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import {
  NativeGitReviewRepository,
  type ReviewGitNetworkPort,
} from '@/app/collab/review/NativeGitReviewRepository';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

const BASE = '0'.repeat(40);
const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TREE = '3'.repeat(40);
const ADVANCED = '4'.repeat(40);
const REMOTE_URL = 'https://192.168.1.20/repository.git';
const PREVIOUS_HOST_URL = 'https://192.168.1.20:54545/v1/git/project-a/repository.git';
const CURRENT_HOST_URL = 'https://192.168.1.21:54545/v1/git/project-a/repository.git';
const NETWORK: GitNetworkEnvironment = {
  headers: [{ name: 'Authorization', value: 'Basic Zm9vOmJhcg==' }],
  sslCaInfoPath: '/vault/.claudian/review-ca.pem',
};

describe('NativeGitReviewRepository', () => {
  it('uses authoritative local refs without opening a Git network operation', async () => {
    const git = fakeGit();
    const reviewNetwork = network();
    const repository = new NativeGitReviewRepository(git, reviewNetwork);

    await expect(repository.prepare(context(), detail('clean'))).resolves.toMatchObject({
      comparisonBaseOid: MAIN,
      comparisonTargetOid: TREE,
      projectId: 'project-a',
    });

    expect(reviewNetwork.withNetwork).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('fetches exact refs and compares current main with the clean candidate tree', async () => {
    const git = fakeGit();
    git.resolveRefs
      .mockResolvedValueOnce(new Map([
        ['refs/remotes/origin/main', null],
        ['refs/remotes/origin/members/member-a', null],
      ]))
      .mockResolvedValueOnce(new Map([
        ['refs/remotes/origin/main', MAIN],
        ['refs/remotes/origin/members/member-a', HEAD],
      ]));
    git.mergeTree.mockResolvedValue({ kind: 'clean', treeOid: TREE });
    git.listChangedBlobs.mockResolvedValue([{
      kind: 'modified',
      newOid: 'b'.repeat(40),
      newSize: 8,
      oldOid: 'a'.repeat(40),
      oldSize: 4,
      path: 'note.md',
    }]);
    const repository = new NativeGitReviewRepository(git, network());

    await expect(repository.prepare(context(), detail('clean'))).resolves.toEqual({
      comparisonBaseOid: MAIN,
      comparisonKind: 'candidate',
      comparisonTargetOid: TREE,
      detail: detail('clean'),
      files: [{
        binary: false,
        kind: 'modified',
        largeForReview: false,
        newBytes: 8,
        oldBytes: 4,
        path: 'note.md',
      }],
      projectId: 'project-a',
    });
    expect(git.fetch).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      [
        '+refs/heads/main:refs/remotes/origin/main',
        '+refs/heads/members/member-a:refs/remotes/origin/members/member-a',
      ],
      NETWORK,
      undefined,
    );
    expect(git.withReadSession).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'working',
      expect.any(Function),
    );
  });

  it('falls back to the Member contribution for conflicts and preserves rename metadata', async () => {
    const git = fakeGit();
    git.mergeTree.mockResolvedValue({ kind: 'conflicting', treeOid: null });
    git.findMergeBase.mockResolvedValue(BASE);
    git.listChangedBlobs.mockResolvedValue([{
      kind: 'renamed',
      newOid: 'b'.repeat(40),
      newSize: 12,
      oldOid: 'a'.repeat(40),
      oldSize: 10,
      path: 'image-new.png',
      previousPath: 'image.png',
    }]);

    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context(),
      detail('conflicting'),
    )).resolves.toMatchObject({
      comparisonBaseOid: BASE,
      comparisonKind: 'contribution',
      comparisonTargetOid: HEAD,
      files: [{
        binary: true,
        kind: 'renamed',
        newBytes: 12,
        oldBytes: 10,
        path: 'image-new.png',
        previousPath: 'image.png',
      }],
    });
  });

  it('allows an advanced personal ref only for a stale request whose head remains reachable', async () => {
    const git = fakeGit();
    git.resolveRefs.mockResolvedValue(new Map([
      ['refs/remotes/origin/main', MAIN],
      ['refs/remotes/origin/members/member-a', ADVANCED],
    ]));
    git.isAncestor.mockResolvedValue(true);
    git.mergeTree.mockResolvedValue({ kind: 'clean', treeOid: TREE });
    git.findMergeBase.mockResolvedValue(BASE);

    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context(),
      detail('stale'),
    )).resolves.toMatchObject({
      comparisonBaseOid: BASE,
      comparisonKind: 'contribution',
      comparisonTargetOid: HEAD,
    });
    expect(git.isAncestor).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      HEAD,
      ADVANCED,
    );

    git.resolveRefs.mockResolvedValue(new Map([
      ['refs/remotes/origin/main', MAIN],
      ['refs/remotes/origin/members/member-a', ADVANCED],
    ]));
    git.isAncestor.mockResolvedValue(false);
    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context(),
      detail('stale'),
    )).rejects.toMatchObject({ code: 'stale-request-head' });
  });

  it('rejects remote and advertised OID drift before building review data', async () => {
    const git = fakeGit();
    git.listRemoteUrls.mockResolvedValue(['https://other.test/repository.git']);
    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context(),
      detail('clean'),
    )).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'review-origin-url-mismatch' },
    });
    expect(git.fetch).not.toHaveBeenCalled();

    git.listRemoteUrls.mockResolvedValue([REMOTE_URL]);
    git.resolveRefs.mockResolvedValue(new Map([
      ['refs/remotes/origin/main', ADVANCED],
      ['refs/remotes/origin/members/member-a', HEAD],
    ]));
    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context(),
      detail('clean'),
    )).rejects.toMatchObject({ code: 'stale-main' });
    expect(git.listChangedBlobs).not.toHaveBeenCalled();
  });

  it('repairs only the generated stopped-Host origin for an authority owner', async () => {
    const git = fakeGit();
    git.listRemoteUrls
      .mockResolvedValueOnce([collabStoppedHostRemoteUrl('project-a')])
      .mockResolvedValueOnce([REMOTE_URL]);

    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context({ allowHostRemoteRepair: true }),
      detail('clean'),
    )).resolves.toMatchObject({ projectId: 'project-a' });
    expect(git.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      REMOTE_URL,
    );

    git.listRemoteUrls.mockReset()
      .mockResolvedValue(['https://other.test/repository.git']);
    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context({ allowHostRemoteRepair: true }),
      detail('clean'),
    )).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(git.addRemote).toHaveBeenCalledTimes(1);
  });

  it('repairs a generated same-Project Host origin after the LAN address changes', async () => {
    const git = fakeGit();
    git.listRemoteUrls
      .mockResolvedValueOnce([PREVIOUS_HOST_URL])
      .mockResolvedValueOnce([CURRENT_HOST_URL]);

    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context({ allowHostRemoteRepair: true, remoteUrl: CURRENT_HOST_URL }),
      detail('clean'),
    )).resolves.toMatchObject({ projectId: 'project-a' });
    expect(git.addRemote).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      'origin',
      CURRENT_HOST_URL,
    );

    git.listRemoteUrls.mockReset().mockResolvedValue([
      'https://192.168.1.20:54545/v1/git/project-other/repository.git',
    ]);
    await expect(new NativeGitReviewRepository(git, network()).prepare(
      context({ allowHostRemoteRepair: true, remoteUrl: CURRENT_HOST_URL }),
      detail('clean'),
    )).rejects.toMatchObject({ code: 'repository-invalid' });
    expect(git.addRemote).toHaveBeenCalledTimes(1);
  });

  it('returns text, large-text, and safe binary-preview models one file at a time', async () => {
    const git = fakeGit();
    const repository = new NativeGitReviewRepository(git, network());
    git.readBlobsAtPaths.mockResolvedValueOnce([
      Buffer.from('old\n'),
      Buffer.from('new\n'),
    ]);
    await expect(repository.readFile(context(), fileRequest({
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'note.md',
    }))).resolves.toEqual({
      file: expect.objectContaining({ newBytes: 4, oldBytes: 4, path: 'note.md' }),
      kind: 'text',
      newText: 'new\n',
      oldText: 'old\n',
    });

    const manyLines = `${'x\n'.repeat(CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines)}x`;
    git.readBlobsAtPaths.mockResolvedValueOnce([
      Buffer.from('old\n'),
      Buffer.from(manyLines),
    ]);
    await expect(repository.readFile(context(), fileRequest({
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'large.md',
    }))).resolves.toMatchObject({
      file: { largeForReview: true, path: 'large.md' },
      kind: 'large-text',
    });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    git.readBlobsAtPaths.mockResolvedValueOnce([png]);
    await expect(repository.readFile(context(), fileRequest({
      binary: true,
      kind: 'added',
      largeForReview: false,
      path: 'image.png',
    }))).resolves.toEqual({
      file: expect.objectContaining({ binary: true, newBytes: 8, path: 'image.png' }),
      kind: 'binary',
      preview: { bytes: png, mimeType: 'image/png' },
    });

    git.readBlobsAtPaths.mockResolvedValueOnce([Buffer.from('<html>not an image</html>')]);
    await expect(repository.readFile(context(), fileRequest({
      binary: true,
      kind: 'added',
      largeForReview: false,
      path: 'spoofed.png',
    }))).resolves.toEqual({
      file: expect.objectContaining({ binary: true, path: 'spoofed.png' }),
      kind: 'binary',
    });
  });
});

function context(overrides: Partial<ReturnType<typeof baseContext>> = {}) {
  return { ...baseContext(), ...overrides };
}

function baseContext() {
  return {
    allowHostRemoteRepair: false,
    memberId: 'member-reviewer',
    personalRef: 'refs/heads/members/member-reviewer',
    projectId: 'project-a',
    remoteUrl: REMOTE_URL,
    repositoryPath: '/vault/workspace/project-a',
    role: 'manager' as const,
  };
}

function detail(reviewCondition: 'clean' | 'conflicting' | 'stale'): CollabRequestDetail {
  return {
    comments: { comments: [] },
    currentMainOid: MAIN,
    request: {
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      description: 'Published change',
      firstBaseOid: BASE,
      id: 'request-a',
      latestHeadOid: HEAD,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
    reviewCondition,
    reviewedHeadOid: HEAD,
  };
}

function fileRequest(file: {
  binary: boolean;
  kind: 'added' | 'modified';
  largeForReview: boolean;
  path: string;
}) {
  return {
    comparisonBaseOid: MAIN,
    comparisonTargetOid: TREE,
    file,
    projectId: 'project-a',
    requestId: 'request-a',
  };
}

function network(): ReviewGitNetworkPort {
  return {
    withNetwork: jest.fn(async (_context, operation) => operation(NETWORK)),
  };
}

function fakeGit(): jest.Mocked<GitRepositoryService> {
  const git = {
    addRemote: jest.fn().mockResolvedValue(undefined),
    fetch: jest.fn().mockResolvedValue(undefined),
    findMergeBase: jest.fn().mockResolvedValue(BASE),
    getWorkingTreeState: jest.fn(),
    isAncestor: jest.fn().mockResolvedValue(false),
    listChangedBlobs: jest.fn().mockResolvedValue([]),
    listRemoteUrls: jest.fn().mockResolvedValue([REMOTE_URL]),
    mergeTree: jest.fn().mockResolvedValue({ kind: 'clean', treeOid: TREE }),
    readBlobsAtPaths: jest.fn(),
    resolveRefs: jest.fn().mockResolvedValue(new Map([
      ['refs/remotes/origin/main', MAIN],
      ['refs/remotes/origin/members/member-a', HEAD],
    ])),
    withReadSession: jest.fn(),
  } as unknown as jest.Mocked<GitRepositoryService>;
  git.withReadSession.mockImplementation(async (_path, _kind, operation) => operation({
    countDivergence: (leftOid, rightOid) => git.countDivergence(
      '/vault/workspace/project-a', leftOid, rightOid,
    ),
    findMergeBase: (leftOid, rightOid) => git.findMergeBase(
      '/vault/workspace/project-a', leftOid, rightOid,
    ),
    getWorkingTreeStatus: () => git.getWorkingTreeStatus('/vault/workspace/project-a'),
    getWorkingTreeState: () => git.getWorkingTreeState('/vault/workspace/project-a'),
    isAncestor: (ancestorOid, descendantOid) => git.isAncestor(
      '/vault/workspace/project-a', ancestorOid, descendantOid,
    ),
    listChangedBlobs: (baseOid, headOid) => git.listChangedBlobs(
      '/vault/workspace/project-a', baseOid, headOid,
    ),
    listChangedFiles: (baseOid, headOid) => git.listChangedFiles(
      '/vault/workspace/project-a', baseOid, headOid,
    ),
    listWorkingTreeChangedFiles: baseOid => git.listWorkingTreeChangedFiles(
      '/vault/workspace/project-a', baseOid,
    ),
    listRemoteUrls: remote => git.listRemoteUrls('/vault/workspace/project-a', remote),
    listTreeRecursive: commitOid => git.listTreeRecursive(
      '/vault/workspace/project-a', commitOid,
    ),
    mergeTree: (acceptedOid, memberOid) => git.mergeTree(
      '/vault/workspace/project-a', acceptedOid, memberOid,
    ),
    readBlobsAtPaths: requests => git.readBlobsAtPaths(
      '/vault/workspace/project-a', requests,
    ),
    resolveRef: ref => git.resolveRef('/vault/workspace/project-a', ref),
    resolveRefs: refs => git.resolveRefs('/vault/workspace/project-a', refs),
  }));
  return git;
}
