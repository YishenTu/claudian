import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App } from 'obsidian';

import {
  ManagedResourceCollisionError,
  ManagedResourceRelocationError,
  VaultFileAdapter,
} from '@/core/storage/VaultFileAdapter';

function createDesktopFsAdapter(
  root: string,
  hooks: {
    afterExists?: (relativePath: string, exists: boolean) => Promise<void>;
    afterList?: (relativePath: string) => Promise<void>;
    beforeRename?: (source: string, target: string) => Promise<void>;
  } = {},
): any {
  const resolve = (relativePath: string) => path.join(root, ...relativePath.split('/'));
  return {
    exists: async (relativePath: string) => fs.access(resolve(relativePath)).then(
      () => true,
      () => false,
    ).then(async (exists) => {
      await hooks.afterExists?.(relativePath, exists);
      return exists;
    }),
    getBasePath: () => root,
    list: async (relativePath: string) => {
      const entries = await fs.readdir(resolve(relativePath), { withFileTypes: true });
      await hooks.afterList?.(relativePath);
      return {
        files: entries.filter(entry => entry.isFile() || entry.isSymbolicLink())
          .map(entry => `${relativePath}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relativePath}/${entry.name}`),
      };
    },
    mkdir: async (relativePath: string) => fs.mkdir(resolve(relativePath)),
    rename: async (source: string, target: string) => {
      await hooks.beforeRename?.(source, target);
      await fs.rename(resolve(source), resolve(target));
    },
    rmdir: async (relativePath: string) => fs.rmdir(resolve(relativePath)),
  };
}

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
      rmdir: jest.fn(),
      stat: jest.fn(),
      trashSystem: jest.fn(),
      trashLocal: jest.fn(),
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

  describe('deleteFolder', () => {
    it('deletes folder when it exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.rmdir = jest.fn().mockResolvedValue(undefined);

      await vaultAdapter.deleteFolder('empty-folder');

      expect(mockAdapter.exists).toHaveBeenCalledWith('empty-folder');
      expect(mockAdapter.rmdir).toHaveBeenCalledWith('empty-folder', false);
    });

    it('does nothing when folder does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      mockAdapter.rmdir = jest.fn();

      await vaultAdapter.deleteFolder('nonexistent-folder');

      expect(mockAdapter.rmdir).not.toHaveBeenCalled();
    });

    it('silently handles rmdir error (non-empty folder)', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.rmdir = jest.fn().mockRejectedValue(new Error('Directory not empty'));

      await expect(vaultAdapter.deleteFolder('non-empty-folder')).resolves.toBeUndefined();
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

    it('deduplicates concurrent creation of the same missing folder', async () => {
      const existingFolders = new Set<string>();
      mockAdapter.exists.mockImplementation(async (path: string) => existingFolders.has(path));
      mockAdapter.mkdir.mockImplementation(async (path: string) => {
        await Promise.resolve();
        if (existingFolders.has(path)) {
          throw new Error(`EEXIST: ${path}`);
        }
        existingFolders.add(path);
      });

      await expect(Promise.all([
        vaultAdapter.ensureFolder('.claudian/sessions'),
        vaultAdapter.ensureFolder('.claudian/sessions'),
      ])).resolves.toEqual([undefined, undefined]);

      expect(mockAdapter.mkdir).toHaveBeenCalledTimes(2);
      expect(mockAdapter.mkdir).toHaveBeenNthCalledWith(1, '.claudian');
      expect(mockAdapter.mkdir).toHaveBeenNthCalledWith(2, '.claudian/sessions');
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

  describe('managed resources', () => {
    it.each([
      ['managed root', '.agents', 'folder'],
      ['skills root', '.agents/skills', 'folder'],
      ['package', '.agents/skills/portable-skill', 'folder'],
      ['SKILL.md', '.agents/skills/portable-skill/SKILL.md', 'file'],
    ] as const)('rejects a symlinked %s on desktop adapters', async (_label, relative, type) => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-external-'));
      try {
        if (relative !== '.agents') {
          await fs.mkdir(path.join(vaultPath, '.agents/skills/portable-skill'), { recursive: true });
        }
        const target = type === 'folder'
          ? externalPath
          : path.join(externalPath, 'SKILL.md');
        if (type === 'file') await fs.writeFile(target, 'external');
        if (type === 'folder' && relative !== '.agents') {
          await fs.rm(path.join(vaultPath, relative), { recursive: true });
        }
        await fs.symlink(target, path.join(vaultPath, relative));
        const desktopApp = {
          vault: { adapter: { getBasePath: () => vaultPath } },
        } as unknown as App;

        await expect(new VaultFileAdapter(desktopApp).verifyManagedPath(relative, {
          expectedType: type,
        })).rejects.toThrow('symlink');
      } finally {
        await fs.rm(vaultPath, { recursive: true, force: true });
        await fs.rm(externalPath, { recursive: true, force: true });
      }
    });

    it('rejects paths outside the normalized vault namespace', async () => {
      await expect(vaultAdapter.verifyManagedPath('../escape', {
        expectedType: 'folder',
        allowMissing: true,
      })).rejects.toThrow('vault-relative');

      expect(mockAdapter.stat).not.toHaveBeenCalled();
    });

    it('rejects an existing path with the wrong adapter-reported type', async () => {
      mockAdapter.stat.mockResolvedValue({ type: 'file', ctime: 0, mtime: 0, size: 0 });

      await expect(vaultAdapter.verifyManagedPath('.agents/skills', {
        expectedType: 'folder',
      })).rejects.toThrow('folder');
    });

    it('creates missing managed root segments and revalidates each one', async () => {
      const folders = new Set<string>();
      mockAdapter.stat.mockImplementation(async (path: string) => folders.has(path)
        ? { type: 'folder', ctime: 0, mtime: 0, size: 0 }
        : null);
      mockAdapter.mkdir.mockImplementation(async (path: string) => {
        folders.add(path);
      });

      await vaultAdapter.ensureManagedFolder('.agents/skills');

      expect(mockAdapter.mkdir.mock.calls).toEqual([['.agents'], ['.agents/skills']]);
      expect(mockAdapter.stat).toHaveBeenCalledWith('.agents/skills');
    });

    it('rejects an exclusive directory claim when the target already exists', async () => {
      mockAdapter.stat.mockImplementation(async (path: string) => ({
        type: 'folder', ctime: 0, mtime: 0, size: 0, path,
      }));

      await expect(vaultAdapter.createManagedFolderExclusive('.agents/skills/existing'))
        .rejects.toMatchObject({ name: 'ManagedResourceCollisionError' });
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('reports a race-lost exclusive directory claim as a collision', async () => {
      const racingTargets = new Set(['.agents', '.agents/skills']);
      mockAdapter.stat.mockImplementation(async (path: string) => racingTargets.has(path)
        ? { type: 'folder', ctime: 0, mtime: 0, size: 0 }
        : null);
      mockAdapter.mkdir.mockImplementation(async (path: string) => {
        racingTargets.add(path);
        throw new Error('EEXIST');
      });

      await expect(vaultAdapter.createManagedFolderExclusive('.agents/skills/racing'))
        .rejects.toMatchObject({ name: 'ManagedResourceCollisionError' });
    });

    it('propagates an exclusive claim failure when no competing target exists', async () => {
      mockAdapter.stat.mockImplementation(async (path: string) => path === '.agents/skills'
        || path === '.agents'
        ? { type: 'folder', ctime: 0, mtime: 0, size: 0 }
        : null);
      mockAdapter.mkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(vaultAdapter.createManagedFolderExclusive('.agents/skills/failing'))
        .rejects.toThrow('Could not exclusively create');
    });

    it('relocates direct package entries into an exclusive target with SKILL.md last', async () => {
      const existing = new Map<string, 'file' | 'folder'>([
        ['.agents', 'folder'],
        ['.agents/skills', 'folder'],
        ['.agents/skills/old', 'folder'],
        ['.agents/skills/old/SKILL.md', 'file'],
        ['.agents/skills/old/assets', 'folder'],
      ]);
      mockAdapter.stat.mockImplementation(async (path: string) => {
        const type = existing.get(path);
        return type ? { type, ctime: 0, mtime: 0, size: 0 } : null;
      });
      mockAdapter.mkdir.mockImplementation(async (path: string) => {
        if (existing.has(path)) throw new Error('EEXIST');
        existing.set(path, 'folder');
      });
      mockAdapter.list.mockResolvedValue({
        files: ['.agents/skills/old/SKILL.md'],
        folders: ['.agents/skills/old/assets'],
      });
      const moveEntry = jest.spyOn(vaultAdapter as any, 'moveManagedEntryNoReplace');
      moveEntry.mockImplementation(async (...args: unknown[]) => {
        const [source, target] = args as [string, string];
        const type = existing.get(source);
        if (!type || existing.has(target)) throw new Error('rename failed');
        existing.delete(source);
        existing.set(target, type);
      });
      mockAdapter.rmdir.mockImplementation(async (path: string) => {
        existing.delete(path);
      });

      await vaultAdapter.relocateManagedPackageNoReplace(
        '.agents/skills/old',
        '.agents/skills/new',
      );

      expect(moveEntry.mock.calls).toEqual([
        ['.agents/skills/old/assets', '.agents/skills/new/assets'],
        ['.agents/skills/old/SKILL.md', '.agents/skills/new/SKILL.md'],
      ]);
      expect(existing.has('.agents/skills/old')).toBe(false);
      expect(existing.has('.agents/skills/new/SKILL.md')).toBe(true);
    });

    it('rolls back moved entries when relocation fails', async () => {
      const existing = new Set([
        '.agents', '.agents/skills', '.agents/skills/old',
        '.agents/skills/old/a.txt', '.agents/skills/old/SKILL.md',
      ]);
      mockAdapter.stat.mockImplementation(async (path: string) => existing.has(path)
        ? { type: path.endsWith('.txt') || path.endsWith('.md') ? 'file' : 'folder', ctime: 0, mtime: 0, size: 0 }
        : null);
      mockAdapter.exists.mockImplementation(async (path: string) => existing.has(path));
      mockAdapter.mkdir.mockImplementation(async (path: string) => {
        existing.add(path);
      });
      mockAdapter.list.mockResolvedValue({
        files: ['.agents/skills/old/a.txt', '.agents/skills/old/SKILL.md'],
        folders: [],
      });
      jest.spyOn(vaultAdapter as any, 'moveManagedEntryNoReplace')
        .mockImplementation(async (...args: unknown[]) => {
        const [source, target] = args as [string, string];
        if (source.endsWith('/SKILL.md') && source.includes('/old/')) {
          throw new Error('rename failed at /private/vault/.agents/skills/old/SKILL.md');
        }
        existing.delete(source);
        existing.add(target);
      });
      mockAdapter.rmdir.mockImplementation(async (path: string) => {
        existing.delete(path);
      });

      let relocationError: (Error & { cause?: Error }) | null = null;
      try {
        await vaultAdapter.relocateManagedPackageNoReplace(
          '.agents/skills/old',
          '.agents/skills/new',
        );
      } catch (error) {
        relocationError = error as Error & { cause?: Error };
      }

      expect(relocationError?.message).toBe(
        'Failed to relocate managed package from .agents/skills/old to .agents/skills/new',
      );
      expect(relocationError?.message).not.toContain('/private/vault');
      expect(relocationError?.cause?.message).toContain('/private/vault');

      expect(existing.has('.agents/skills/old/a.txt')).toBe(true);
      expect(existing.has('.agents/skills/new')).toBe(false);
    });

    it('preserves nested collision classification after complete rollback', async () => {
      const existing = new Map<string, 'file' | 'folder'>([
        ['.agents', 'folder'],
        ['.agents/skills', 'folder'],
        ['.agents/skills/old', 'folder'],
        ['.agents/skills/old/assets', 'folder'],
      ]);
      mockAdapter.stat.mockImplementation(async (resourcePath: string) => {
        const type = existing.get(resourcePath);
        return type ? { type, ctime: 0, mtime: 0, size: 0 } : null;
      });
      mockAdapter.mkdir.mockImplementation(async (resourcePath: string) => {
        existing.set(resourcePath, 'folder');
      });
      mockAdapter.list.mockResolvedValue({
        files: [],
        folders: ['.agents/skills/old/assets'],
      });
      jest.spyOn(vaultAdapter as any, 'moveManagedEntryNoReplace')
        .mockRejectedValue(new ManagedResourceRelocationError(
          '.agents/skills/old/assets',
          '.agents/skills/new/assets',
          new ManagedResourceCollisionError('.agents/skills/new/assets/example.txt'),
          [],
        ));
      mockAdapter.rmdir.mockImplementation(async (resourcePath: string) => {
        existing.delete(resourcePath);
      });

      await expect(vaultAdapter.relocateManagedPackageNoReplace(
        '.agents/skills/old',
        '.agents/skills/new',
      )).rejects.toBeInstanceOf(ManagedResourceCollisionError);
      expect(existing.has('.agents/skills/old')).toBe(true);
      expect(existing.has('.agents/skills/new')).toBe(false);
    });

    it('never overwrites a destination child created during relocation', async () => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/a.txt'), 'source');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        let raced = false;
        const existenceChecks: string[] = [];
        const adapter = createDesktopFsAdapter(vaultPath, {
          async afterExists(relativePath, exists) {
            existenceChecks.push(relativePath);
            if (relativePath === '.agents/skills/new/a.txt' && !exists) {
              await fs.writeFile(path.join(vaultPath, '.agents/skills/new/a.txt'), 'racer');
              raced = true;
            }
          },
        });

        let relocationError: unknown;
        try {
          await new VaultFileAdapter({ vault: { adapter } } as unknown as App)
            .relocateManagedPackageNoReplace('.agents/skills/old', '.agents/skills/new');
        } catch (error) {
          relocationError = error;
        }

        expect(relocationError).toBeInstanceOf(Error);
        expect(existenceChecks).toContain('.agents/skills/new/a.txt');
        expect(raced).toBe(true);
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/old/a.txt'), 'utf8'))
          .resolves.toBe('source');
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/a.txt'), 'utf8'))
          .resolves.toBe('racer');
      } finally {
        await fs.rm(vaultPath, { recursive: true, force: true });
      }
    });

    it('never overwrites a source child created before rollback', async () => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/a.txt'), 'source');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        const adapter = createDesktopFsAdapter(vaultPath, {
          async afterExists(relativePath, exists) {
            if (relativePath === '.agents/skills/new/SKILL.md' && !exists) {
              await fs.writeFile(path.join(vaultPath, '.agents/skills/new/SKILL.md'), 'blocker');
            }
            if (
              relativePath === '.agents/skills/new/a.txt'
              && exists
              && await fs.access(path.join(vaultPath, '.agents/skills/old/a.txt')).then(
                () => false,
                () => true,
              )
            ) {
              await fs.writeFile(path.join(vaultPath, '.agents/skills/old/a.txt'), 'racer');
            }
          },
          async beforeRename(source) {
            if (source === '.agents/skills/old/SKILL.md') {
              throw new Error('forced move failure');
            }
          },
        });

        await expect(new VaultFileAdapter({ vault: { adapter } } as unknown as App)
          .relocateManagedPackageNoReplace('.agents/skills/old', '.agents/skills/new'))
          .rejects.toThrow();

        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/old/a.txt'), 'utf8'))
          .resolves.toBe('racer');
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/a.txt'), 'utf8'))
          .resolves.toBe('source');
      } finally {
        await fs.rm(vaultPath, { recursive: true, force: true });
      }
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
