import {
  findBestMentionLookupMatch,
  isMentionStart,
  normalizeForPlatformLookup,
  normalizeMentionPath,
} from '@/utils/contextMentionResolver';

describe('contextMentionResolver', () => {
  describe('isMentionStart', () => {
    it('returns true when @ is at the beginning of text', () => {
      expect(isMentionStart('@note.md', 0)).toBe(true);
    });

    it('returns true when @ is preceded by whitespace', () => {
      expect(isMentionStart('check @note.md', 6)).toBe(true);
      expect(isMentionStart('check\n@note.md', 6)).toBe(true);
    });

    it('returns false when @ is not preceded by whitespace', () => {
      expect(isMentionStart('email@test.com', 5)).toBe(false);
    });

    it('returns false when the index is not @', () => {
      expect(isMentionStart('hello', 0)).toBe(false);
    });
  });

  describe('normalizeMentionPath', () => {
    it('normalizes separators and trims leading/trailing slashes', () => {
      expect(normalizeMentionPath('./src\\folder//file.md/')).toBe('src/folder/file.md');
    });

    it('returns empty string for root-like input', () => {
      expect(normalizeMentionPath('./')).toBe('');
    });
  });

  describe('normalizeForPlatformLookup', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('lowercases lookup keys on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(normalizeForPlatformLookup('SRC/FILE.MD')).toBe('src/file.md');
    });

    it('keeps lookup keys unchanged on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(normalizeForPlatformLookup('SRC/FILE.MD')).toBe('SRC/FILE.MD');
    });
  });

  describe('findBestMentionLookupMatch', () => {
    it('matches the longest path followed by punctuation', () => {
      const text = 'Check @src/my file.md, then continue';
      const pathStart = text.indexOf('@') + 1;
      const lookup = new Map<string, string>([
        ['src/my', '/vault/src/my'],
        ['src/my file.md', '/vault/src/my file.md'],
      ]);

      const match = findBestMentionLookupMatch(
        text,
        pathStart,
        lookup
      );

      expect(match).toEqual({
        resolvedPath: '/vault/src/my file.md',
        endIndex: text.indexOf(',') + 1,
      });
    });

    it('returns null when no lookup key matches', () => {
      const text = 'Check @missing/path';
      const pathStart = text.indexOf('@') + 1;
      const lookup = new Map<string, string>([['src/file.md', '/vault/src/file.md']]);

      const match = findBestMentionLookupMatch(
        text,
        pathStart,
        lookup
      );

      expect(match).toBeNull();
    });
  });
});
