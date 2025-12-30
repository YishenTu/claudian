import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { contextPathScanner } from '@/utils/contextPathScanner';

describe('contextPathScanner', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-test-'));

    // Create test file structure
    fs.mkdirSync(path.join(tempDir, 'subdir'));
    fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'content1');
    fs.writeFileSync(path.join(tempDir, 'file2.md'), 'content2');
    fs.writeFileSync(path.join(tempDir, 'subdir', 'file3.ts'), 'content3');

    // Create hidden file (should be skipped)
    fs.writeFileSync(path.join(tempDir, '.hidden'), 'hidden');

    // Clear cache before each test
    contextPathScanner.invalidateCache();
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('scanPaths', () => {
    it('should scan directory and return files', () => {
      const files = contextPathScanner.scanPaths([tempDir]);

      expect(files.length).toBe(3);
      expect(files.map(f => f.name).sort()).toEqual(['file1.txt', 'file2.md', 'file3.ts']);
    });

    it('should include file metadata', () => {
      const files = contextPathScanner.scanPaths([tempDir]);
      const file1 = files.find(f => f.name === 'file1.txt');

      expect(file1).toBeDefined();
      expect(file1!.path).toBe(path.join(tempDir, 'file1.txt'));
      expect(file1!.relativePath).toBe('file1.txt');
      expect(file1!.contextRoot).toBe(tempDir);
      expect(file1!.mtime).toBeGreaterThan(0);
    });

    it('should include files in subdirectories', () => {
      const files = contextPathScanner.scanPaths([tempDir]);
      const file3 = files.find(f => f.name === 'file3.ts');

      expect(file3).toBeDefined();
      expect(file3!.relativePath).toBe(path.join('subdir', 'file3.ts'));
    });

    it('should skip hidden files', () => {
      const files = contextPathScanner.scanPaths([tempDir]);
      const hidden = files.find(f => f.name === '.hidden');

      expect(hidden).toBeUndefined();
    });

    it('should skip hidden directories', () => {
      // Create a hidden directory with a file
      const hiddenDir = path.join(tempDir, '.hidden-dir');
      fs.mkdirSync(hiddenDir);
      fs.writeFileSync(path.join(hiddenDir, 'secret.txt'), 'secret');

      const files = contextPathScanner.scanPaths([tempDir]);
      const secret = files.find(f => f.name === 'secret.txt');

      expect(secret).toBeUndefined();
    });

    it('should skip node_modules', () => {
      // Create node_modules with a file
      const nodeModules = path.join(tempDir, 'node_modules');
      fs.mkdirSync(nodeModules);
      fs.writeFileSync(path.join(nodeModules, 'package.json'), '{}');

      const files = contextPathScanner.scanPaths([tempDir]);
      const pkg = files.find(f => f.name === 'package.json');

      expect(pkg).toBeUndefined();
    });

    it('should handle non-existent paths', () => {
      const files = contextPathScanner.scanPaths(['/non/existent/path']);

      expect(files).toEqual([]);
    });

    it('should handle multiple context paths', () => {
      // Create a second temp directory
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-test2-'));
      fs.writeFileSync(path.join(tempDir2, 'file4.js'), 'content4');

      try {
        const files = contextPathScanner.scanPaths([tempDir, tempDir2]);

        expect(files.length).toBe(4);
        expect(files.map(f => f.name).sort()).toEqual([
          'file1.txt',
          'file2.md',
          'file3.ts',
          'file4.js',
        ]);
      } finally {
        fs.rmSync(tempDir2, { recursive: true, force: true });
      }
    });
  });

  describe('caching', () => {
    it('should cache results', () => {
      // First scan
      const files1 = contextPathScanner.scanPaths([tempDir]);

      // Add a new file
      fs.writeFileSync(path.join(tempDir, 'new-file.txt'), 'new content');

      // Second scan should use cache
      const files2 = contextPathScanner.scanPaths([tempDir]);

      expect(files1.length).toBe(files2.length);
      expect(files2.find(f => f.name === 'new-file.txt')).toBeUndefined();
    });

    it('should respect cache invalidation', () => {
      // First scan
      contextPathScanner.scanPaths([tempDir]);

      // Add a new file
      fs.writeFileSync(path.join(tempDir, 'new-file.txt'), 'new content');

      // Invalidate cache
      contextPathScanner.invalidateCache();

      // Second scan should see new file
      const files = contextPathScanner.scanPaths([tempDir]);

      expect(files.find(f => f.name === 'new-file.txt')).toBeDefined();
    });

    it('should invalidate specific path', () => {
      // Create a second temp directory
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-test2-'));
      fs.writeFileSync(path.join(tempDir2, 'file4.js'), 'content4');

      try {
        // First scan both paths
        contextPathScanner.scanPaths([tempDir, tempDir2]);

        // Add files to both
        fs.writeFileSync(path.join(tempDir, 'new1.txt'), 'new1');
        fs.writeFileSync(path.join(tempDir2, 'new2.txt'), 'new2');

        // Invalidate only first path
        contextPathScanner.invalidatePath(tempDir);

        // Second scan
        const files = contextPathScanner.scanPaths([tempDir, tempDir2]);

        // Should see new file in first path (invalidated)
        expect(files.find(f => f.name === 'new1.txt')).toBeDefined();
        // Should NOT see new file in second path (still cached)
        expect(files.find(f => f.name === 'new2.txt')).toBeUndefined();
      } finally {
        fs.rmSync(tempDir2, { recursive: true, force: true });
      }
    });
  });

  describe('home path expansion', () => {
    it('should expand home paths', () => {
      // This test uses a real path that should exist
      const files = contextPathScanner.scanPaths(['~']);

      // Should not throw and should return some files (or empty if home is empty)
      expect(Array.isArray(files)).toBe(true);
    });
  });
});
