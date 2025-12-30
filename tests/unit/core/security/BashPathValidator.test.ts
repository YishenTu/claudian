import { isPathLikeToken } from '@/core/security/BashPathValidator';

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

  describe('isPathLikeToken with mocked Windows platform', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    describe('on Windows (mocked)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
      });

      it('detects Windows drive letter paths', () => {
        expect(isPathLikeToken('C:\\Users\\test')).toBe(true);
        expect(isPathLikeToken('D:/Projects/vault')).toBe(true);
      });

      it('detects Windows UNC paths', () => {
        expect(isPathLikeToken('\\\\server\\share')).toBe(true);
        expect(isPathLikeToken('//server/share')).toBe(true);
      });

      it('detects Windows-style home and relative paths', () => {
        expect(isPathLikeToken('~\\Documents')).toBe(true);
        expect(isPathLikeToken('.\\local')).toBe(true);
        expect(isPathLikeToken('..\\parent')).toBe(true);
      });

      it('detects paths with backslashes', () => {
        expect(isPathLikeToken('folder\\file.txt')).toBe(true);
      });

      it('detects MSYS-style paths as forward slash paths', () => {
        // MSYS paths like /c/Users look like Unix absolute paths
        // They contain forward slashes so they're detected as paths
        expect(isPathLikeToken('/c/Users/test')).toBe(true);
      });
    });

    describe('on Unix (mocked)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
      });

      it('does not detect Windows drive letter paths', () => {
        // C:\path looks like it has a colon which isn't a path indicator on Unix
        // but it does contain a backslash after the colon
        expect(isPathLikeToken('C:\\Users\\test')).toBe(false);
      });

      it('does not detect Windows-style backslash paths', () => {
        expect(isPathLikeToken('~\\Documents')).toBe(false);
        expect(isPathLikeToken('.\\local')).toBe(false);
      });

      it('detects Unix absolute paths', () => {
        expect(isPathLikeToken('/home/user')).toBe(true);
        expect(isPathLikeToken('/c/Users/test')).toBe(true); // looks like Unix path
      });
    });
  });
});
