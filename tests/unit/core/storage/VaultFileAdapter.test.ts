import type { App } from 'obsidian';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

describe('VaultFileAdapter', () => {
  let mockAdapter: jest.Mocked<any>;
  let vaultAdapter: VaultFileAdapter;

  const mockApp: Partial<App> = {
    vault: {} as any,
  };

  beforeEach(() => {
    mockAdapter = {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      remove: jest.fn(),
      rename: jest.fn(),
      list: jest.fn(),
      mkdir: jest.fn(),
      stat: jest.fn(),
    };

    mockApp.vault = { adapter: mockAdapter } as any;
    vaultAdapter = new VaultFileAdapter(mockApp as App);
  });

  describe('exists', () => {
    it('delegates to vault adapter', async () => {
      mockAdapter.exists.mockResolvedValue(true);

      const result = await vaultAdapter.exists('test/path.md');

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith('test/path.md');
    });

    it('delegates to vault adapter with false', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await vaultAdapter.exists('test/path.md');

      expect(result).toBe(false);
    });
  });

  describe('read', () => {
    it('delegates to vault adapter', async () => {
      mockAdapter.read.mockResolvedValue('file content');

      const result = await vaultAdapter.read('test/path.md');

      expect(result).toBe('file content');
      expect(mockAdapter.read).toHaveBeenCalledWith('test/path.md');
    });
  });

  describe('write', () => {
    it('writes file when folder exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.write('folder/file.md', 'content');

      expect(mockAdapter.exists).toHaveBeenCalledWith('folder');
      expect(mockAdapter.write).toHaveBeenCalledWith('folder/file.md', 'content');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('creates parent folder when it does not exist', async () => {
      mockAdapter.exists.mockImplementation((path: string) => Promise.resolve(path !== 'folder'));
      mockAdapter.mkdir.mockResolvedValue();
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.write('folder/file.md', 'content');

      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder');
      expect(mockAdapter.write).toHaveBeenCalledWith('folder/file.md', 'content');
    });

    it('handles file in root (no folder)', async () => {
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.write('file.md', 'content');

      expect(mockAdapter.exists).not.toHaveBeenCalled();
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
      expect(mockAdapter.write).toHaveBeenCalledWith('file.md', 'content');
    });

    it('handles deeply nested paths', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.mkdir.mockResolvedValue();
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.write('level1/level2/level3/file.md', 'content');

      expect(mockAdapter.mkdir).toHaveBeenCalledWith('level1');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('level1/level2');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('level1/level2/level3');
      expect(mockAdapter.write).toHaveBeenCalledWith('level1/level2/level3/file.md', 'content');
    });
  });

  describe('append', () => {
    it('creates new file if it does not exist', async () => {
      // All existence checks return false: folder doesn't exist, file doesn't exist
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.mkdir.mockResolvedValue();
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.append('folder/file.md', 'new content');

      expect(mockAdapter.mkdir).toHaveBeenCalled();
      expect(mockAdapter.write).toHaveBeenCalledWith('folder/file.md', 'new content');
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('appends to existing file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('existing content');
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.append('file.md', '\nmore content');

      expect(mockAdapter.read).toHaveBeenCalledWith('file.md');
      expect(mockAdapter.write).toHaveBeenCalledWith('file.md', 'existing content\nmore content');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('creates parent folder for new file', async () => {
      mockAdapter.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      mockAdapter.mkdir.mockResolvedValue();
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.append('folder/file.md', 'content');

      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder');
    });

    it('handles file in root', async () => {
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.append('file.md', 'content');

      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
      expect(mockAdapter.write).toHaveBeenCalledWith('file.md', 'content');
    });

    it('appends empty string', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('existing');
      mockAdapter.write.mockResolvedValue();

      await vaultAdapter.append('file.md', '');

      expect(mockAdapter.write).toHaveBeenCalledWith('file.md', 'existing');
    });
  });

  describe('delete', () => {
    it('deletes file when it exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.remove.mockResolvedValue();

      await vaultAdapter.delete('file.md');

      expect(mockAdapter.exists).toHaveBeenCalledWith('file.md');
      expect(mockAdapter.remove).toHaveBeenCalledWith('file.md');
    });

    it('does nothing when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      await vaultAdapter.delete('file.md');

      expect(mockAdapter.exists).toHaveBeenCalledWith('file.md');
      expect(mockAdapter.remove).not.toHaveBeenCalled();
    });

    it('deletes nested file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.remove.mockResolvedValue();

      await vaultAdapter.delete('folder/subfolder/file.md');

      expect(mockAdapter.remove).toHaveBeenCalledWith('folder/subfolder/file.md');
    });
  });

  describe('listFiles', () => {
    it('lists files in existing folder', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({
        files: ['file1.md', 'file2.md'],
        folders: ['subfolder'],
      });

      const result = await vaultAdapter.listFiles('folder');

      expect(result).toEqual(['file1.md', 'file2.md']);
      expect(mockAdapter.list).toHaveBeenCalledWith('folder');
    });

    it('returns empty array when folder does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await vaultAdapter.listFiles('folder');

      expect(result).toEqual([]);
      expect(mockAdapter.list).not.toHaveBeenCalled();
    });

    it('returns empty array when no files exist', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({
        files: [],
        folders: [],
      });

      const result = await vaultAdapter.listFiles('folder');

      expect(result).toEqual([]);
    });

    it('handles folder with only subfolders', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({
        files: [],
        folders: ['sub1', 'sub2'],
      });

      const result = await vaultAdapter.listFiles('folder');

      expect(result).toEqual([]);
    });
  });

  describe('listFolders', () => {
    it('lists folders in existing directory', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({
        files: ['file.md'],
        folders: ['folder1', 'folder2'],
      });

      const result = await vaultAdapter.listFolders('folder');

      expect(result).toEqual(['folder1', 'folder2']);
    });

    it('returns empty array when folder does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await vaultAdapter.listFolders('folder');

      expect(result).toEqual([]);
      expect(mockAdapter.list).not.toHaveBeenCalled();
    });

    it('returns empty array when no folders exist', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({
        files: ['file.md'],
        folders: [],
      });

      const result = await vaultAdapter.listFolders('folder');

      expect(result).toEqual([]);
    });
  });

  describe('listFilesRecursive', () => {
    it('lists all files in nested structure', async () => {
      const mockList = jest.fn();
      mockList
        .mockResolvedValueOnce({ files: ['root.md'], folders: ['folder1', 'folder2'] })
        .mockResolvedValueOnce({ files: ['folder1/f1.md'], folders: ['folder1/sub'] })
        .mockResolvedValueOnce({ files: ['folder1/sub/f2.md'], folders: [] })
        .mockResolvedValueOnce({ files: ['folder2/f3.md'], folders: [] });

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockImplementation((path: string) => mockList(path));

      const result = await vaultAdapter.listFilesRecursive('root');

      expect(result).toEqual([
        'root.md',
        'folder1/f1.md',
        'folder1/sub/f2.md',
        'folder2/f3.md',
      ]);
    });

    it('returns empty array for non-existent folder', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await vaultAdapter.listFilesRecursive('nonexistent');

      expect(result).toEqual([]);
    });

    it('handles empty folder', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      const result = await vaultAdapter.listFilesRecursive('empty');

      expect(result).toEqual([]);
    });

    it('handles folder with only subfolders and no files', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      const mockList = jest.fn();
      mockList
        .mockResolvedValueOnce({ files: [], folders: ['sub'] })
        .mockResolvedValueOnce({ files: [], folders: [] });

      mockAdapter.list.mockImplementation((path: string) => mockList(path));

      const result = await vaultAdapter.listFilesRecursive('root');

      expect(result).toEqual([]);
    });

    it('handles deeply nested structure', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      const mockList = jest.fn();
      mockList
        .mockResolvedValueOnce({ files: ['a.txt'], folders: ['b'] })
        .mockResolvedValueOnce({ files: ['b/b.txt'], folders: ['b/c'] })
        .mockResolvedValueOnce({ files: ['b/c/c.txt'], folders: ['b/c/d'] })
        .mockResolvedValueOnce({ files: ['b/c/d/d.txt'], folders: [] });

      mockAdapter.list.mockImplementation((path: string) => mockList(path));

      const result = await vaultAdapter.listFilesRecursive('root');

      expect(result).toHaveLength(4);
      expect(result).toContain('a.txt');
      expect(result).toContain('b/b.txt');
      expect(result).toContain('b/c/c.txt');
      expect(result).toContain('b/c/d/d.txt');
    });

    it('handles multiple subfolders at same level', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      const mockList = jest.fn();
      mockList
        .mockResolvedValueOnce({ files: ['root.md'], folders: ['a', 'b', 'c'] })
        .mockResolvedValueOnce({ files: ['a/a.txt'], folders: [] })
        .mockResolvedValueOnce({ files: ['b/b.txt'], folders: [] })
        .mockResolvedValueOnce({ files: ['c/c.txt'], folders: [] });

      mockAdapter.list.mockImplementation((path: string) => mockList(path));

      const result = await vaultAdapter.listFilesRecursive('root');

      expect(result).toHaveLength(4);
    });
  });

  describe('ensureFolder', () => {
    it('returns early when folder exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);

      await vaultAdapter.ensureFolder('existing/folder');

      expect(mockAdapter.exists).toHaveBeenCalledWith('existing/folder');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('creates folder when it does not exist', async () => {
      mockAdapter.exists.mockResolvedValueOnce(false);
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('new/folder');

      expect(mockAdapter.exists).toHaveBeenCalledWith('new/folder');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('new/folder');
    });

    it('creates nested folders', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('a/b/c');

      expect(mockAdapter.mkdir).toHaveBeenCalledTimes(3);
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('a');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('a/b');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('a/b/c');
    });

    it('handles folder with trailing slash', async () => {
      mockAdapter.exists.mockResolvedValueOnce(false);
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('folder/');

      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder');
    });

    it('handles root folder', async () => {
      mockAdapter.exists.mockResolvedValueOnce(false);
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('folder');

      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder');
    });

    it('skips creating intermediate folders that exist', async () => {
      mockAdapter.exists.mockImplementation((path: string) => Promise.resolve(
        path !== 'existing/intermediate/new'
      ));
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('existing/intermediate/new');

      expect(mockAdapter.mkdir).toHaveBeenCalledTimes(1);
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('existing/intermediate/new');
    });

    it('handles folder with empty segments', async () => {
      mockAdapter.exists.mockResolvedValueOnce(false);
      mockAdapter.mkdir.mockResolvedValue();

      await vaultAdapter.ensureFolder('folder//nested');

      expect(mockAdapter.mkdir).toHaveBeenCalledTimes(2);
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder');
      expect(mockAdapter.mkdir).toHaveBeenCalledWith('folder/nested');
    });
  });

  describe('rename', () => {
    it('delegates to vault adapter rename', async () => {
      mockAdapter.rename.mockResolvedValue();

      await vaultAdapter.rename('old.md', 'new.md');

      expect(mockAdapter.rename).toHaveBeenCalledWith('old.md', 'new.md');
    });

    it('renames nested file', async () => {
      mockAdapter.rename.mockResolvedValue();

      await vaultAdapter.rename('folder/old.md', 'folder/new.md');

      expect(mockAdapter.rename).toHaveBeenCalledWith('folder/old.md', 'folder/new.md');
    });

    it('moves file across folders', async () => {
      mockAdapter.rename.mockResolvedValue();

      await vaultAdapter.rename('folder1/file.md', 'folder2/file.md');

      expect(mockAdapter.rename).toHaveBeenCalledWith('folder1/file.md', 'folder2/file.md');
    });
  });

  describe('stat', () => {
    it('returns file stats for existing file', async () => {
      mockAdapter.stat.mockResolvedValue({ mtime: 1234567890, size: 1024 });

      const result = await vaultAdapter.stat('file.md');

      expect(result).toEqual({ mtime: 1234567890, size: 1024 });
      expect(mockAdapter.stat).toHaveBeenCalledWith('file.md');
    });

    it('returns null when stat returns null', async () => {
      mockAdapter.stat.mockResolvedValue(null);

      const result = await vaultAdapter.stat('file.md');

      expect(result).toBeNull();
    });

    it('returns null on stat error', async () => {
      mockAdapter.stat.mockRejectedValue(new Error('Stat error'));

      const result = await vaultAdapter.stat('file.md');

      expect(result).toBeNull();
    });

    it('handles nested file path', async () => {
      mockAdapter.stat.mockResolvedValue({ mtime: 9876543210, size: 2048 });

      const result = await vaultAdapter.stat('folder/subfolder/file.md');

      expect(result).toEqual({ mtime: 9876543210, size: 2048 });
    });

    it('handles zero-sized file', async () => {
      mockAdapter.stat.mockResolvedValue({ mtime: 1234567890, size: 0 });

      const result = await vaultAdapter.stat('empty.md');

      expect(result).toEqual({ mtime: 1234567890, size: 0 });
    });
  });
});
