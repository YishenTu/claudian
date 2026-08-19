import { CollabGitTreePolicy } from '@/app/collab/git/CollabGitTreePolicy';
import type { GitRecursiveTreeEntry } from '@/app/collab/git/GitRepositoryService';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

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

describe('CollabGitTreePolicy', () => {
  it('accepts a portable regular-file tree within every quota', () => {
    expect(() => new CollabGitTreePolicy().validate([
      file('README.md'),
      file('notes/alpha.md'),
    ])).not.toThrow();
  });

  it.each([
    file('link', { mode: '120000' }),
    file('nested', { mode: '160000', size: null, type: 'commit' }),
  ])('rejects unsupported entry mode $mode', entry => {
    expect(() => new CollabGitTreePolicy().validate([entry])).toThrow(
      expect.objectContaining({ code: 'unsupported-file-type' }),
    );
  });

  it('rejects merged trees that violate portability or aggregate quotas', () => {
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
      expect(() => new CollabGitTreePolicy().validate(entries)).toThrow(
        expect.objectContaining({
          code: expect.stringMatching(/^(path-not-portable|quota-exceeded)$/),
        }),
      );
    }
  });
});
