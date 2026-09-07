import {
  RequestEnsureGitPolicy,
  type RequestEnsureGitPort,
} from '@/app/collab/authority/RequestEnsureGitPolicy';
import type { GitRecursiveTreeEntry } from '@/app/collab/git/GitRepositoryService';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

const HEAD = '2'.repeat(40);
const MAIN = '1'.repeat(40);
const OTHER = '3'.repeat(40);
const INPUT = {
  expectedMainOid: MAIN,
  headOid: HEAD,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
};

function file(
  path: string,
  overrides: Partial<GitRecursiveTreeEntry> = {},
): GitRecursiveTreeEntry {
  return {
    mode: '100644',
    oid: '4'.repeat(40),
    path,
    size: 10,
    type: 'blob',
    ...overrides,
  };
}

class FakeGit implements RequestEnsureGitPort {
  ancestor = true;
  entries: readonly GitRecursiveTreeEntry[] = [file('note.md')];
  mainOids: Array<string | null> = [MAIN, MAIN];
  personalHeads: Array<string | null> = [HEAD, HEAD];

  async resolveRef(_repositoryPath: string, ref: string): Promise<string | null> {
    return ref === 'refs/heads/main'
      ? this.mainOids.shift() ?? null
      : this.personalHeads.shift() ?? null;
  }

  async isAncestor(): Promise<boolean> {
    return this.ancestor;
  }

  async listTreeRecursive(): Promise<readonly GitRecursiveTreeEntry[]> {
    return this.entries;
  }
}

describe('RequestEnsureGitPolicy', () => {
  it('accepts only the exact reachable personal head and returns current main', async () => {
    const policy = new RequestEnsureGitPolicy('/authority.git', new FakeGit());

    await expect(policy.validate(INPUT)).resolves.toEqual({ mainOid: MAIN });
  });

  it('rejects a main change before and during validation', async () => {
    const stale = new FakeGit();
    stale.mainOids = [OTHER];
    await expect(new RequestEnsureGitPolicy('/authority.git', stale).validate(INPUT))
      .rejects.toMatchObject({
        code: 'stale-main',
        safeContext: { reason: 'request-main-not-expected' },
      });

    const changed = new FakeGit();
    changed.mainOids = [MAIN, OTHER];
    await expect(new RequestEnsureGitPolicy('/authority.git', changed).validate(INPUT))
      .rejects.toMatchObject({
        code: 'stale-main',
        safeContext: { reason: 'request-main-changed-during-validation' },
      });
  });

  it.each([
    {
      configure: (git: FakeGit) => { git.personalHeads = [OTHER]; },
      reason: 'request-head-not-current',
    },
    {
      configure: (git: FakeGit) => { git.ancestor = false; },
      reason: 'request-head-not-reachable',
    },
    {
      configure: (git: FakeGit) => { git.personalHeads = [HEAD, OTHER]; },
      reason: 'request-head-changed-during-validation',
    },
  ])('rejects an unpushed or unstable personal head: $reason', async ({ configure, reason }) => {
    const git = new FakeGit();
    configure(git);

    await expect(new RequestEnsureGitPolicy('/authority.git', git).validate(INPUT))
      .rejects.toMatchObject({
        code: 'request-head-not-pushed',
        safeContext: { reason },
      });
  });

  it.each([
    file('link', { mode: '120000' }),
    file('nested', { mode: '160000', size: null, type: 'commit' }),
  ])('rejects non-regular tree mode $mode', async entry => {
    const git = new FakeGit();
    git.entries = [entry];

    await expect(new RequestEnsureGitPolicy('/authority.git', git).validate(INPUT))
      .rejects.toMatchObject({ code: 'unsupported-file-type' });
  });

  it('enforces portable paths, blob size, file count, and total checkout size', async () => {
    const cases: readonly GitRecursiveTreeEntry[][] = [
      [file('Note.md'), file('note.md')],
      [file('large.bin', { size: CLAUDIAN_COLLAB_LIMITS.maxBlobBytes + 1 })],
      Array.from(
        { length: CLAUDIAN_COLLAB_LIMITS.maxChangedPaths + 1 },
        (_, index) => file(`notes/${index}.md`),
      ),
      Array.from(
        { length: 11 },
        (_, index) => file(`large/${index}.bin`, { size: 49 * 1024 * 1024 }),
      ),
    ];

    for (const entries of cases) {
      const git = new FakeGit();
      git.entries = entries;
      await expect(new RequestEnsureGitPolicy('/authority.git', git).validate(INPUT))
        .rejects.toMatchObject({
          code: expect.stringMatching(/^(path-not-portable|quota-exceeded)$/),
        });
    }
  });

  it('rejects a missing main and a mismatched membership personal ref', async () => {
    const git = new FakeGit();
    git.mainOids = [null];
    await expect(new RequestEnsureGitPolicy('/authority.git', git).validate(INPUT))
      .rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(new RequestEnsureGitPolicy('/authority.git', new FakeGit()).validate({
      ...INPUT,
      personalRef: 'refs/heads/members/member-b',
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });
});
