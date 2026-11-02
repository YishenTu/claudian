import { App, type DataAdapter } from 'obsidian';
import type { Mocked } from 'vitest';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

describe('VaultFileAdapter', () => {
  let mockAdapter: Mocked<Pick<DataAdapter, 'exists' | 'read' | 'write' | 'remove' | 'rename' | 'list' | 'mkdir' | 'rmdir' | 'stat' | 'trashSystem' | 'trashLocal'>>;
  let vaultAdapter: VaultFileAdapter;

  const mockApp = new App();

  beforeEach(() => {
    mockAdapter = {
      exists: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      list: vi.fn(),
      mkdir: vi.fn(),
      rmdir: vi.fn(),
      stat: vi.fn(),
      trashSystem: vi.fn(),
      trashLocal: vi.fn(),
    };

    Object.assign(mockApp.vault.adapter, mockAdapter);
    vaultAdapter = new VaultFileAdapter(mockApp);
  });

  describe('write', () => {
    it('writes file when folder exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.write.mockResolvedValue(undefined);

      await vaultAdapter.write('folder/file.md', 'content');

      expect(mockAdapter.exists).toHaveBeenCalledWith('folder');
      expect(mockAdapter.write).toHaveBeenCalledWith('folder/file.md', 'content');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('handles file in root (no folder)', async () => {
      mockAdapter.write.mockResolvedValue(undefined);

      await vaultAdapter.write('file.md', 'content');

      expect(mockAdapter.exists).not.toHaveBeenCalled();
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
      expect(mockAdapter.write).toHaveBeenCalledWith('file.md', 'content');
    });

    it('creates a missing parent folder chain in one call', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.mkdir.mockResolvedValue(undefined);
      mockAdapter.write.mockResolvedValue(undefined);

      await vaultAdapter.write('level1/level2/level3/file.md', 'content');

      expect(mockAdapter.mkdir.mock.calls).toEqual([['level1/level2/level3']]);
      expect(mockAdapter.write).toHaveBeenCalledWith('level1/level2/level3/file.md', 'content');
    });
  });

  describe('delete', () => {
    it('deletes file when it exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.remove.mockResolvedValue(undefined);

      await vaultAdapter.delete('folder/subfolder/file.md');

      expect(mockAdapter.exists).toHaveBeenCalledWith('folder/subfolder/file.md');
      expect(mockAdapter.remove).toHaveBeenCalledWith('folder/subfolder/file.md');
    });

    it('does nothing when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      await vaultAdapter.delete('file.md');

      expect(mockAdapter.exists).toHaveBeenCalledWith('file.md');
      expect(mockAdapter.remove).not.toHaveBeenCalled();
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

  describe('listFilesRecursive', () => {
    it('lists independent folders concurrently and preserves traversal order', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered: string[] = [];
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockImplementation(async (folder: string) => {
        if (folder === 'root') return { files: ['root/file'], folders: ['root/a', 'root/b'] };
        entered.push(folder);
        await gate;
        return { files: [`${folder}/file`], folders: [] };
      });
      const listing = vaultAdapter.listFilesRecursive('root');
      try {
        await new Promise(resolve => setImmediate(resolve));
        expect(entered).toEqual(['root/a', 'root/b']);
      } finally { release(); }
      expect(await listing).toEqual(['root/file', 'root/a/file', 'root/b/file']);
    });

    it('lists all files in nested structure', async () => {
      const folders: Record<string, { files: string[]; folders: string[] }> = {
        root: { files: ['root.md'], folders: ['folder1', 'folder2'] },
        folder1: { files: ['folder1/f1.md'], folders: ['folder1/sub'] },
        'folder1/sub': { files: ['folder1/sub/f2.md'], folders: [] },
        folder2: { files: ['folder2/f3.md'], folders: [] },
      };
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.list.mockImplementation(async (folder: string) => folders[folder]);

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
      const mockList = vi.fn();
      mockList
        .mockResolvedValueOnce({ files: [], folders: ['sub'] })
        .mockResolvedValueOnce({ files: [], folders: [] });

      mockAdapter.list.mockImplementation((path: string) => mockList(path));

      const result = await vaultAdapter.listFilesRecursive('root');

      expect(result).toEqual([]);
    });

    it('handles deeply nested structure', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      const mockList = vi.fn();
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
  });

  describe('ensureFolder', () => {
    it('returns early when folder exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);

      await vaultAdapter.ensureFolder('existing/folder');

      expect(mockAdapter.exists).toHaveBeenCalledWith('existing/folder');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('creates a missing folder chain in one call', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.mkdir.mockResolvedValue(undefined);

      await vaultAdapter.ensureFolder('a/b/c');

      expect(mockAdapter.exists).toHaveBeenCalledWith('a/b/c');
      expect(mockAdapter.mkdir.mock.calls).toEqual([['a/b/c']]);
    });
  });

  describe('stat', () => {
    it('returns file stats for existing file', async () => {
      mockAdapter.stat.mockResolvedValue({ type: 'file', ctime: 0, mtime: 1234567890, size: 1024 });

      const result = await vaultAdapter.stat('folder/subfolder/file.md');

      expect(result).toEqual({ mtime: 1234567890, size: 1024 });
      expect(mockAdapter.stat).toHaveBeenCalledWith('folder/subfolder/file.md');
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

    it('handles zero-sized file', async () => {
      mockAdapter.stat.mockResolvedValue({ type: 'file', ctime: 0, mtime: 1234567890, size: 0 });

      const result = await vaultAdapter.stat('empty.md');

      expect(result).toEqual({ mtime: 1234567890, size: 0 });
    });
  });

  describe('managed resources', () => {
    it('refuses managed operations on a vault adapter without a filesystem base path', async () => {
      await expect(vaultAdapter.ensureManagedFolder('.agents/skills')).rejects.toThrow('filesystem-backed vault adapter');
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('rejects paths outside the normalized vault namespace', async () => {
      await expect(vaultAdapter.verifyManagedPath('../escape', {
        expectedType: 'folder',
        allowMissing: true,
      })).rejects.toThrow('vault-relative');

      expect(mockAdapter.stat).not.toHaveBeenCalled();
    });
  });

  describe('trash', () => {
    it('does nothing when the path is missing', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      await vaultAdapter.trash('.agents/skills/missing');

      expect(mockAdapter.trashSystem).not.toHaveBeenCalled();
      expect(mockAdapter.trashLocal).not.toHaveBeenCalled();
    });

    it('uses system trash when available', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.trashSystem.mockResolvedValue(true);

      await vaultAdapter.trash('.agents/skills/portable-skill');

      expect(mockAdapter.trashLocal).not.toHaveBeenCalled();
    });

    it('falls back to local trash and propagates failures', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.trashSystem.mockResolvedValue(false);
      mockAdapter.trashLocal.mockRejectedValue(new Error('trash failed'));

      await expect(vaultAdapter.trash('.agents/skills/portable-skill'))
        .rejects.toThrow('Could not trash managed resource');
    });
  });
});
