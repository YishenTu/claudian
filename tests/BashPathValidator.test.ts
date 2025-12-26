import { isPathLikeToken } from '../src/security/BashPathValidator';

describe('BashPathValidator', () => {
  const isWindows = process.platform === 'win32';

  describe('isPathLikeToken', () => {
    it('detects Unix-style home paths', () => {
      expect(isPathLikeToken('~/notes')).toBe(true);
      expect(isPathLikeToken('~')).toBe(true);
    });

    it('detects Windows-style home paths only on Windows', () => {
      // ~\ is only recognized as a path on Windows
      expect(isPathLikeToken('~\\notes')).toBe(isWindows);
    });

    it('detects Unix-style relative paths', () => {
      expect(isPathLikeToken('./notes')).toBe(true);
      expect(isPathLikeToken('../notes')).toBe(true);
      expect(isPathLikeToken('..')).toBe(true);
    });

    it('detects Windows-style relative paths only on Windows', () => {
      // .\ and ..\ are only recognized as paths on Windows
      expect(isPathLikeToken('.\\notes')).toBe(isWindows);
      expect(isPathLikeToken('..\\notes')).toBe(isWindows);
    });

    it('detects Unix-style absolute paths', () => {
      expect(isPathLikeToken('/tmp/note.md')).toBe(true);
    });

    it('detects Windows-style absolute paths only on Windows', () => {
      // Drive letters and UNC paths are only recognized on Windows
      expect(isPathLikeToken('C:\\temp\\note.md')).toBe(isWindows);
      expect(isPathLikeToken('\\\\server\\share\\note.md')).toBe(isWindows);
    });

    it('handles backslash escapes based on platform', () => {
      // Backslash in middle of token: path on Windows, escape on Unix
      expect(isPathLikeToken('foo\\ bar')).toBe(isWindows);
    });

    it('does not treat dot-prefixed names as parent directories', () => {
      expect(isPathLikeToken('..hidden')).toBe(false);
    });

    it('detects forward-slash paths on all platforms', () => {
      expect(isPathLikeToken('foo/bar')).toBe(true);
    });

    it('rejects non-path tokens', () => {
      expect(isPathLikeToken('.')).toBe(false);
      expect(isPathLikeToken('/')).toBe(false);
      expect(isPathLikeToken('\\')).toBe(false);
      expect(isPathLikeToken('--')).toBe(false);
      expect(isPathLikeToken('')).toBe(false);
      expect(isPathLikeToken('plainword')).toBe(false);
    });
  });
});
