import {
  type CollabImportCandidate,
  CollabPathPolicy,
} from '@/app/collab/CollabPathPolicy';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

function file(path: string, size = 1): CollabImportCandidate {
  return { kind: 'file', path, size };
}

describe('CollabPathPolicy', () => {
  const policy = new CollabPathPolicy({ obsidianConfigDirectory: '.obsidian' });

  describe('repository paths', () => {
    it.each([
      '',
      '/absolute.md',
      'C:/absolute.md',
      '\\\\server\\share\\file.md',
      '../escape.md',
      'folder/../escape.md',
      './note.md',
      'folder//note.md',
      'folder\\note.md',
      'folder/trailing. ',
      'folder/has?.md',
      'folder/control\u0000.md',
      'CON.md',
      'COM¹.md',
      'folder/lpt9.txt',
      'folder/LPT³.txt',
      '.git/config',
      'folder/.Obsidian/theme.css',
      '.claudian/private.json',
      'workspace/nested.md',
    ])('rejects non-portable path %j', path => {
      const result = policy.validateRepositoryPath(path);

      expect(result).toMatchObject({ ok: false });
      const error = result.ok ? null : result.error;
      expect(['path-invalid', 'path-not-portable']).toContain(error?.code);
      expect(error?.safeContext).not.toEqual(
        expect.objectContaining({ absolutePath: expect.anything() }),
      );
    });

    it('enforces UTF-16 segment and repository path limits', () => {
      const longSegment = `${'a'.repeat(CLAUDIAN_COLLAB_LIMITS.maxPathSegmentUtf16)}x.md`;
      const longPath = [
        'a'.repeat(100),
        'b'.repeat(100),
        `${'c'.repeat(38)}.md`,
      ].join('/');

      expect(policy.validateRepositoryPath(longSegment)).toMatchObject({
        ok: false,
        error: { code: 'path-not-portable' },
      });
      expect(longPath.length).toBeGreaterThan(CLAUDIAN_COLLAB_LIMITS.maxRepositoryPathUtf16);
      expect(policy.validateRepositoryPath(longPath)).toMatchObject({
        ok: false,
        error: { code: 'path-not-portable' },
      });
    });

    it('preserves a safe Vault-relative path', () => {
      expect(policy.validateRepositoryPath('Research/Notes/idea.md')).toEqual({
        comparisonKey: 'research/notes/idea.md',
        ok: true,
        path: 'Research/Notes/idea.md',
      });
    });
  });

  describe('import preflight', () => {
    it('rejects every member of case-fold and Unicode-normalization collisions', () => {
      const result = policy.validateImportCandidates([
        file('Notes/Plan.md'),
        file('notes/plan.md'),
        file('Cafe\u0301.md'),
        file('Caf\u00e9.md'),
        file('safe.md'),
      ]);

      expect(result.ok).toBe(false);
      expect(result.accepted).toEqual([file('safe.md')]);
      expect(result.rejected.map(item => item.candidate.path)).toEqual([
        'Notes/Plan.md',
        'notes/plan.md',
        'Cafe\u0301.md',
        'Caf\u00e9.md',
      ]);
      expect(result.rejected.every(item => item.error.code === 'path-not-portable')).toBe(true);
    });

    it('deduplicates the same file selected through overlapping folders', () => {
      const result = policy.validateImportCandidates([
        file('Notes/Plan.md', 10),
        file('Notes/Plan.md', 10),
      ]);

      expect(result).toMatchObject({
        accepted: [file('Notes/Plan.md', 10)],
        ok: true,
        rejected: [],
        totalBytes: 10,
      });
    });

    it.each(['symlink', 'junction', 'gitlink', 'other'] as const)(
      'rejects %s candidates',
      kind => {
        const candidate: CollabImportCandidate = {
          kind,
          path: 'unsafe-entry',
          size: 0,
        };

        const result = policy.validateImportCandidates([candidate]);

        expect(result.ok).toBe(false);
        expect(result.rejected[0]).toMatchObject({
          candidate,
          error: { code: 'unsupported-file-type' },
        });
      },
    );

    it('rejects an oversized blob without treating 5 MiB as a hard limit', () => {
      const allowed = file('allowed.bin', 5 * 1024 * 1024 + 1);
      const oversized = file('oversized.bin', CLAUDIAN_COLLAB_LIMITS.maxBlobBytes + 1);

      expect(policy.validateImportCandidates([allowed])).toMatchObject({
        accepted: [allowed],
        ok: true,
      });
      expect(policy.validateImportCandidates([oversized])).toMatchObject({
        accepted: [],
        ok: false,
        rejected: [{
          candidate: oversized,
          error: { code: 'quota-exceeded' },
        }],
      });
    });

    it('blocks the whole import when checked-out content exceeds its quota', () => {
      const candidates = Array.from({ length: 11 }, (_, index) => (
        file(`file-${index}.bin`, CLAUDIAN_COLLAB_LIMITS.maxBlobBytes)
      ));

      const result = policy.validateImportCandidates(candidates);

      expect(result.ok).toBe(false);
      expect(result.accepted).toEqual(candidates);
      expect(result.totalBytes).toBe(11 * CLAUDIAN_COLLAB_LIMITS.maxBlobBytes);
      expect(result.aggregateError).toMatchObject({ code: 'quota-exceeded' });
    });
  });

  describe('non-path quotas', () => {
    it('validates every frozen MVP quota at its exact boundary', () => {
      expect(policy.validateChangedPathCount(CLAUDIAN_COLLAB_LIMITS.maxChangedPaths)).toBeNull();
      expect(policy.validateChangedPathCount(CLAUDIAN_COLLAB_LIMITS.maxChangedPaths + 1)).toMatchObject({
        code: 'quota-exceeded',
      });
      expect(policy.validateReceivedPackSize(CLAUDIAN_COLLAB_LIMITS.maxReceivedPackBytes)).toBeNull();
      expect(policy.validateReceivedPackSize(CLAUDIAN_COLLAB_LIMITS.maxReceivedPackBytes + 1)).toMatchObject({
        code: 'quota-exceeded',
      });
      expect(policy.validateCommentSize(CLAUDIAN_COLLAB_LIMITS.maxCommentBytes)).toBeNull();
      expect(policy.validateCommentSize(CLAUDIAN_COLLAB_LIMITS.maxCommentBytes + 1)).toMatchObject({
        code: 'quota-exceeded',
      });
      expect(policy.validateHostRepositorySize(CLAUDIAN_COLLAB_LIMITS.hostRepositorySoftLimitBytes)).toBeNull();
      expect(
        policy.validateHostRepositorySize(CLAUDIAN_COLLAB_LIMITS.hostRepositorySoftLimitBytes + 1),
      ).toMatchObject({ code: 'quota-exceeded' });
      expect(policy.classifyTextDiff(
        CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes,
        CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines,
      )).toBe('text');
      expect(policy.classifyTextDiff(CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes + 1, 1)).toBe('opaque');
      expect(policy.classifyTextDiff(1, CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines + 1)).toBe('opaque');
    });
  });
});
