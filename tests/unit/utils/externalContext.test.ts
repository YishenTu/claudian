import * as fs from 'fs';

import {
  filterValidPaths,
  findConflictingPath,
  getFolderName,
  isDuplicatePath,
  isValidDirectoryPath,
  normalizePathForComparison,
} from '@/utils/externalContext';

jest.mock('fs');

describe('externalContext utilities', () => {
  describe('normalizePathForComparison', () => {
    const originalPlatform = process.platform;
    const expectNormalized = (input: string, expected: string) => {
      const normalized = normalizePathForComparison(input);
      const resolved = process.platform === 'win32' ? expected.toLowerCase() : expected;
      expect(normalized).toBe(resolved);
    };

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    // eslint-disable-next-line jest/expect-expect
    it('should convert backslashes to forward slashes', () => {
      expectNormalized('C:\\Users\\test', 'C:/Users/test');
      expectNormalized('path\\to\\file', 'path/to/file');
    });

    // eslint-disable-next-line jest/expect-expect
    it('should remove trailing slashes', () => {
      expectNormalized('/path/to/dir/', '/path/to/dir');
      expectNormalized('/path/to/dir///', '/path/to/dir');
    });

    // eslint-disable-next-line jest/expect-expect
    it('should handle combined cases', () => {
      expectNormalized('C:\\Users\\test\\', 'C:/Users/test');
      expectNormalized('C:\\Users\\test\\subdir\\', 'C:/Users/test/subdir');
    });

    // eslint-disable-next-line jest/expect-expect
    it('should handle paths without trailing slashes', () => {
      expectNormalized('/path/to/dir', '/path/to/dir');
      expectNormalized('C:/Users/test', 'C:/Users/test');
    });

    // eslint-disable-next-line jest/expect-expect
    it('should handle Unix-style paths', () => {
      expectNormalized('/home/user/project', '/home/user/project');
      expectNormalized('/home/user/project/', '/home/user/project');
    });

    it('should normalize Windows case when platform is win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(normalizePathForComparison('C:\\Users\\Test\\Docs')).toBe('c:/users/test/docs');
    });

    it('should translate MSYS paths on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(normalizePathForComparison('/c/Users/Test')).toBe('c:/users/test');
    });
  });

  describe('findConflictingPath', () => {
    describe('child path detection (adding child when parent exists)', () => {
      it('should detect when new path is inside existing path', () => {
        const result = findConflictingPath('/parent/child', ['/parent']);
        expect(result).toEqual({ path: '/parent', type: 'parent' });
      });

      it('should detect deeply nested child paths', () => {
        const result = findConflictingPath('/parent/child/grandchild', ['/parent']);
        expect(result).toEqual({ path: '/parent', type: 'parent' });
      });

      it('should detect with multiple existing paths', () => {
        const result = findConflictingPath('/workspace/project', ['/other', '/workspace', '/another']);
        expect(result).toEqual({ path: '/workspace', type: 'parent' });
      });

      it('should detect with Windows paths', () => {
        const result = findConflictingPath('C:\\Users\\test\\project', ['C:\\Users\\test']);
        expect(result).toEqual({ path: 'C:\\Users\\test', type: 'parent' });
      });
    });

    describe('parent path detection (adding parent when child exists)', () => {
      it('should detect when new path would contain existing path', () => {
        const result = findConflictingPath('/parent', ['/parent/child']);
        expect(result).toEqual({ path: '/parent/child', type: 'child' });
      });

      it('should detect when new path would contain deeply nested path', () => {
        const result = findConflictingPath('/parent', ['/parent/child/grandchild']);
        expect(result).toEqual({ path: '/parent/child/grandchild', type: 'child' });
      });

      it('should detect with Windows paths', () => {
        const result = findConflictingPath('C:\\Users\\test', ['C:\\Users\\test\\project']);
        expect(result).toEqual({ path: 'C:\\Users\\test\\project', type: 'child' });
      });
    });

    describe('unrelated paths (should be allowed)', () => {
      it('should return null for completely unrelated paths', () => {
        const result = findConflictingPath('/project1', ['/project2']);
        expect(result).toBeNull();
      });

      it('should return null for sibling paths', () => {
        const result = findConflictingPath('/parent/sibling1', ['/parent/sibling2']);
        expect(result).toBeNull();
      });

      it('should return null when no existing paths', () => {
        const result = findConflictingPath('/new/path', []);
        expect(result).toBeNull();
      });

      it('should return null for paths with similar prefixes but not nested', () => {
        // /vault vs /vault2 - should NOT be considered nested
        const result = findConflictingPath('/vault2', ['/vault']);
        expect(result).toBeNull();
      });

      it('should handle Windows paths with similar prefixes', () => {
        const result = findConflictingPath('C:\\Users\\test2', ['C:\\Users\\test']);
        expect(result).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should handle trailing slashes correctly', () => {
        const result = findConflictingPath('/parent/child/', ['/parent/']);
        expect(result).toEqual({ path: '/parent/', type: 'parent' });
      });

      it('should handle mixed path separators', () => {
        const result = findConflictingPath('/parent\\child', ['/parent']);
        expect(result).toEqual({ path: '/parent', type: 'parent' });
      });

      it('should handle exact same path', () => {
        // Exact same paths are not nested (handled by duplicate check elsewhere)
        const result = findConflictingPath('/parent', ['/parent']);
        expect(result).toBeNull();
      });

      it('should return first conflict when multiple exist', () => {
        const result = findConflictingPath('/a/b', ['/a', '/a/b/c']);
        // Should return /a as it appears first and is a parent
        expect(result).toEqual({ path: '/a', type: 'parent' });
      });
    });
  });

  describe('getFolderName', () => {
    it('should extract folder name from Unix path', () => {
      expect(getFolderName('/Users/test/workspace')).toBe('workspace');
    });

    it('should extract folder name from Windows path', () => {
      expect(getFolderName('C:\\Users\\test\\workspace')).toBe('workspace');
    });

    it('should handle trailing slashes', () => {
      expect(getFolderName('/Users/test/workspace/')).toBe('workspace');
    });

    it('should handle single segment paths', () => {
      expect(getFolderName('workspace')).toBe('workspace');
    });

    it('should handle root paths', () => {
      expect(getFolderName('/')).toBe('');
    });
  });

  describe('isValidDirectoryPath', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return true for existing directory', () => {
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
      expect(isValidDirectoryPath('/existing/dir')).toBe(true);
      expect(fs.statSync).toHaveBeenCalledWith('/existing/dir');
    });

    it('should return false for non-existent path', () => {
      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(isValidDirectoryPath('/non/existent')).toBe(false);
    });

    it('should return false for file path (not directory)', () => {
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
      expect(isValidDirectoryPath('/path/to/file.txt')).toBe(false);
    });
  });

  describe('filterValidPaths', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should filter out non-existent paths', () => {
      (fs.statSync as jest.Mock).mockImplementation((p: string) => {
        if (p === '/valid/path') {
          return { isDirectory: () => true };
        }
        throw new Error('ENOENT');
      });

      const result = filterValidPaths(['/valid/path', '/invalid/path', '/another/invalid']);
      expect(result).toEqual(['/valid/path']);
    });

    it('should return empty array when all paths are invalid', () => {
      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = filterValidPaths(['/invalid1', '/invalid2']);
      expect(result).toEqual([]);
    });

    it('should return all paths when all are valid', () => {
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });

      const paths = ['/path1', '/path2', '/path3'];
      const result = filterValidPaths(paths);
      expect(result).toEqual(paths);
    });

    it('should handle empty array', () => {
      const result = filterValidPaths([]);
      expect(result).toEqual([]);
    });
  });

  describe('isDuplicatePath', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should detect exact duplicate paths', () => {
      expect(isDuplicatePath('/path/to/dir', ['/path/to/dir'])).toBe(true);
    });

    it('should return false for non-duplicate paths', () => {
      expect(isDuplicatePath('/path/to/dir', ['/other/path'])).toBe(false);
    });

    it('should detect duplicates with different trailing slashes', () => {
      expect(isDuplicatePath('/path/to/dir/', ['/path/to/dir'])).toBe(true);
      expect(isDuplicatePath('/path/to/dir', ['/path/to/dir/'])).toBe(true);
    });

    it('should detect duplicates with mixed path separators', () => {
      expect(isDuplicatePath('/path\\to\\dir', ['/path/to/dir'])).toBe(true);
    });

    it('should detect case-insensitive duplicates on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(isDuplicatePath('C:\\Users\\Test', ['c:\\users\\test'])).toBe(true);
      expect(isDuplicatePath('C:/Users/Test', ['c:/users/test'])).toBe(true);
    });

    it('should handle empty existing paths array', () => {
      expect(isDuplicatePath('/path/to/dir', [])).toBe(false);
    });

    it('should check against multiple existing paths', () => {
      expect(isDuplicatePath('/path/b', ['/path/a', '/path/b', '/path/c'])).toBe(true);
      expect(isDuplicatePath('/path/d', ['/path/a', '/path/b', '/path/c'])).toBe(false);
    });
  });
});
