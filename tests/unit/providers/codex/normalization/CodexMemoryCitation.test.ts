import {
  normalizeCodexMemoryCitation,
  stripCodexMemoryCitationMarkup,
} from '@/providers/codex/normalization/CodexMemoryCitation';

describe('CodexMemoryCitation', () => {
  describe('stripCodexMemoryCitationMarkup', () => {
    it('strips complete and unterminated citation blocks while preserving visible text', () => {
      expect(stripCodexMemoryCitationMarkup(
        'Before<oai-mem-citation>first</oai-mem-citation>After',
      )).toBe('BeforeAfter');
      expect(stripCodexMemoryCitationMarkup(
        'Before<oai-mem-citation>unfinished',
      )).toBe('Before');
    });

    it('preserves partial opening-tag prefixes that are not complete tags', () => {
      expect(stripCodexMemoryCitationMarkup('Before<oai-mem-')).toBe('Before<oai-mem-');
    });
  });

  describe('normalizeCodexMemoryCitation', () => {
    it('normalizes valid entries and ignores provider tracking IDs', () => {
      expect(normalizeCodexMemoryCitation({
        entries: [{
          path: ' MEMORY.md ',
          lineStart: 10,
          lineEnd: 12,
          note: ' Used project conventions ',
        }],
        threadIds: ['thread-1'],
      })).toEqual({
        kind: 'memory',
        entries: [{
          path: 'MEMORY.md',
          lineStart: 10,
          lineEnd: 12,
          note: 'Used project conventions',
        }],
      });
    });

    it('supports persisted snake_case line fields and drops malformed entries', () => {
      expect(normalizeCodexMemoryCitation({
        entries: [
          {
            path: 'rollout.md',
            line_start: 3,
            line_end: 4,
            note: 'Prior result',
          },
          {
            path: '../invalid.md',
            lineStart: 8,
            lineEnd: 2,
            note: 'Invalid range',
          },
        ],
      })).toEqual({
        kind: 'memory',
        entries: [{
          path: 'rollout.md',
          lineStart: 3,
          lineEnd: 4,
          note: 'Prior result',
        }],
      });
      expect(normalizeCodexMemoryCitation({ entries: [] })).toBeNull();
    });
  });
});
