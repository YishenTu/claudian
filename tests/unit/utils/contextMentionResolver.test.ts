import {
  buildExternalContextLookup,
  findBestMentionLookupMatch,
  isMentionStart,
  normalizeForPlatformLookup,
  normalizeMentionPath,
  resolveExternalMentionAtIndex,
} from '@/utils/contextMentionResolver';
import type { ExternalContextDisplayEntry } from '@/utils/externalContext';
import type { ExternalContextFile } from '@/utils/externalContextScanner';

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

  describe('buildExternalContextLookup', () => {
    it('normalizes keys and keeps the first file for duplicate paths', () => {
      const files: ExternalContextFile[] = [
        {
          path: '/external/src/file.md',
          name: 'file.md',
          relativePath: 'src/file.md',
          contextRoot: '/external',
          mtime: 1,
        },
        {
          path: '/external/src/file-duplicate.md',
          name: 'file-duplicate.md',
          relativePath: './src\\file.md',
          contextRoot: '/external',
          mtime: 2,
        },
        {
          path: '/external/ignored',
          name: 'ignored',
          relativePath: './',
          contextRoot: '/external',
          mtime: 3,
        },
      ];

      const lookup = buildExternalContextLookup(files);
      expect(lookup.size).toBe(1);
      expect(lookup.get(normalizeForPlatformLookup('src/file.md'))).toBe('/external/src/file.md');
    });
  });

  describe('findBestMentionLookupMatch', () => {
    it('matches the longest path and preserves trailing punctuation', () => {
      const text = 'Check @src/my file.md, then continue';
      const pathStart = text.indexOf('@') + 1;
      const lookup = new Map<string, string>([
        ['src/my', '/vault/src/my'],
        ['src/my file.md', '/vault/src/my file.md'],
      ]);

      const match = findBestMentionLookupMatch(
        text,
        pathStart,
        lookup,
        normalizeMentionPath,
        normalizeForPlatformLookup
      );

      expect(match).toEqual({
        resolvedPath: '/vault/src/my file.md',
        endIndex: text.indexOf(',') + 1,
        trailingPunctuation: ',',
      });
    });

    it('returns null when no lookup key matches', () => {
      const text = 'Check @missing/path';
      const pathStart = text.indexOf('@') + 1;
      const lookup = new Map<string, string>([['src/file.md', '/vault/src/file.md']]);

      const match = findBestMentionLookupMatch(
        text,
        pathStart,
        lookup,
        normalizeMentionPath,
        normalizeForPlatformLookup
      );

      expect(match).toBeNull();
    });
  });

  describe('resolveExternalMentionAtIndex', () => {
    it('resolves external mention with trailing punctuation', () => {
      const text = 'Use @external/src/app.md.';
      const mentionStart = text.indexOf('@');
      const contextEntries: ExternalContextDisplayEntry[] = [
        {
          contextRoot: '/external',
          displayName: 'external',
          displayNameLower: 'external',
        },
      ];

      const getContextLookup = jest.fn().mockReturnValue(
        new Map<string, string>([['src/app.md', '/external/src/app.md']])
      );

      const match = resolveExternalMentionAtIndex(
        text,
        mentionStart,
        contextEntries,
        getContextLookup
      );

      expect(match).toEqual({
        resolvedPath: '/external/src/app.md',
        trailingPunctuation: '.',
        endIndex: text.length,
      });
      expect(getContextLookup).toHaveBeenCalledWith('/external');
    });

    it('returns null when mention does not include a path separator after display name', () => {
      const text = 'Use @external and continue';
      const mentionStart = text.indexOf('@');
      const contextEntries: ExternalContextDisplayEntry[] = [
        {
          contextRoot: '/external',
          displayName: 'external',
          displayNameLower: 'external',
        },
      ];

      const getContextLookup = jest.fn().mockReturnValue(new Map<string, string>());

      const match = resolveExternalMentionAtIndex(
        text,
        mentionStart,
        contextEntries,
        getContextLookup
      );

      expect(match).toBeNull();
      expect(getContextLookup).not.toHaveBeenCalled();
    });
  });
});
