// @test-ci {"native":true}
const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule1 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule2 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule3 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule4 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule5 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule6 = await vi.importActual<typeof fs>('node:fs/promises');
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { App, type DataAdapter } from 'obsidian';
import type { Mocked } from 'vitest';

import {
  ManagedResourceCollisionError,
  VaultFileAdapter,
} from '@/core/storage/VaultFileAdapter';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
    symlink: vi.fn(actual.symlink),
    writeFile: vi.fn(actual.writeFile),
  };
});

function createDesktopFsAdapter(root: string) {
  const resolve = (relativePath: string) => path.join(root, ...relativePath.split('/'));
  return {
    exists: async (relativePath: string) => fs.access(resolve(relativePath)).then(
      () => true,
      () => false,
    ),
    getBasePath: () => root,
    list: async (relativePath: string) => {
      const entries = await fs.readdir(resolve(relativePath), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile() || entry.isSymbolicLink())
          .map(entry => `${relativePath}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relativePath}/${entry.name}`),
      };
    },
    // Mirrors Obsidian's desktop adapter: recursive mkdir, `fs.rm` rmdir.
    mkdir: async (relativePath: string) => {
      await fs.mkdir(resolve(relativePath), { recursive: true });
    },
    rename: async (source: string, target: string) => {
      await fs.rename(resolve(source), resolve(target));
    },
    rmdir: async (relativePath: string, recursive = false) => (
      fs.rm(resolve(relativePath), { maxRetries: 5, recursive })
    ),
  };
}

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

  describe('rename', () => {
    it('moves file across folders', async () => {
      mockAdapter.rename.mockResolvedValue(undefined);

      await vaultAdapter.rename('folder1/old.md', 'folder2/new.md');

      expect(mockAdapter.rename).toHaveBeenCalledWith('folder1/old.md', 'folder2/new.md');
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

    it('moves a complete package without requiring hard-link support', async () => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      const link = vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old/assets'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/assets/example.txt'), 'asset');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        const adapter = createDesktopFsAdapter(vaultPath);

        await new VaultFileAdapter({ vault: { adapter } } as unknown as App)
          .relocateManagedPackage('.agents/skills/old', '.agents/skills/new');

        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/assets/example.txt'), 'utf8'))
          .resolves.toBe('asset');
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/SKILL.md'), 'utf8'))
          .resolves.toBe('skill');
        await expect(fs.stat(path.join(vaultPath, '.agents/skills/old'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        link.mockReset().mockImplementation(actualModule0.link);
        await fs.rm(vaultPath, { recursive: true, force: true });
      }
    });

    it('leaves the whole source in place when the directory move fails', async () => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      const rename = vi.mocked(fs.rename).mockRejectedValue(
        Object.assign(new Error('denied at /private/vault'), { code: 'EPERM' }),
      );
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old/assets'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/assets/example.txt'), 'asset');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        const adapter = createDesktopFsAdapter(vaultPath);

        await expect(new VaultFileAdapter({ vault: { adapter } } as unknown as App)
          .relocateManagedPackage('.agents/skills/old', '.agents/skills/new'))
          .rejects.toMatchObject({
            message: 'Could not relocate managed package from .agents/skills/old to .agents/skills/new',
            cause: expect.objectContaining({ message: 'denied at /private/vault', code: 'EPERM' }),
          });
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/old/assets/example.txt'), 'utf8'))
          .resolves.toBe('asset');
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'utf8'))
          .resolves.toBe('skill');
        await expect(fs.stat(path.join(vaultPath, '.agents/skills/new'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        rename.mockReset().mockImplementation(actualModule1.rename);
        await fs.rm(vaultPath, { recursive: true, force: true });
      }
    });

    it.each(['empty', 'nonempty', 'racing-nonempty', 'racing-nonempty-EPERM'])('preserves a %s destination', async kind => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'));
      const renameDirectory = actualModule2.rename;
      const rename = vi.mocked(fs.rename);
      try {
        const source = path.join(vaultPath, '.agents/skills/old');
        const target = path.join(vaultPath, '.agents/skills/new');
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, 'SKILL.md'), 'skill');
        const createTarget = async () => {
          await fs.mkdir(target);
          if (kind !== 'empty') await fs.writeFile(path.join(target, 'racer.txt'), 'racer');
        };
        if (kind.startsWith('racing-nonempty')) {
          rename.mockImplementationOnce(async (from, to) => {
            await createTarget();
            if (kind === 'racing-nonempty-EPERM') {
              throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
            }
            return renameDirectory(from, to);
          });
        } else {
          await createTarget();
        }
        const adapter = createDesktopFsAdapter(vaultPath);
        await expect(new VaultFileAdapter({ vault: { adapter } } as unknown as App)
          .relocateManagedPackage('.agents/skills/old', '.agents/skills/new'))
          .rejects.toBeInstanceOf(ManagedResourceCollisionError);
        await expect(fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).resolves.toBe('skill');
        const contents = await Promise.all((await fs.readdir(target)).map(name => fs.readFile(path.join(target, name), 'utf8')));
        expect(contents).toEqual(kind === 'empty' ? [] : ['racer']);
      } finally {
        rename.mockReset().mockImplementation(actualModule3.rename);
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
  describe('managed folders on desktop', () => {
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vaultPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-')));
      files = new VaultFileAdapter({
        vault: { adapter: createDesktopFsAdapter(vaultPath) },
      } as unknown as App);
      vi.mocked(fs.lstat).mockClear();
      vi.mocked(fs.mkdir).mockClear();
    });

    afterEach(async () => {
      await fs.rm(vaultPath, { recursive: true, force: true });
    });

    it('rejects an existing path of the wrong type', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents'));
      await fs.writeFile(path.join(vaultPath, '.agents/skills'), 'file');

      await expect(files.verifyManagedPath('.agents/skills', {
        expectedType: 'folder',
      })).rejects.toThrow('must be a regular folder');
    });

    it('validates an existing folder chain once', async () => {
      await actualModule4
        .mkdir(path.join(vaultPath, '.agents/skills/package/assets/nested/images'), { recursive: true });

      await files.ensureManagedFolder('.agents/skills/package/assets/nested/images');

      expect(fs.lstat).toHaveBeenCalledTimes(6);
      expect(fs.mkdir).not.toHaveBeenCalled();
    });

    it('creates missing managed root segments and verifies the result', async () => {
      await files.ensureManagedFolder('.agents/skills/package');

      for (const folder of ['.agents', '.agents/skills', '.agents/skills/package']) {
        expect((await fs.lstat(path.join(vaultPath, folder))).isDirectory()).toBe(true);
      }
    });

    it('rejects a created folder that fails the final validation', async () => {
      const adapter = createDesktopFsAdapter(vaultPath);
      // The recursive adapter mkdir reports success but leaves a link at the leaf.
      adapter.mkdir = async () => {
        await fs.mkdir(path.join(vaultPath, '.agents'));
        await fs.symlink(os.tmpdir(), path.join(vaultPath, '.agents/skills'));
      };
      files = new VaultFileAdapter({ vault: { adapter } } as unknown as App);

      await expect(files.ensureManagedFolder('.agents/skills')).rejects.toThrow('must not be a symlink');
    });

    it('rejects an exclusive directory claim when the target already exists', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills/existing/kept'), { recursive: true });
      vi.mocked(fs.mkdir).mockClear();

      await expect(files.createManagedFolderExclusive('.agents/skills/existing'))
        .rejects.toBeInstanceOf(ManagedResourceCollisionError);
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(vaultPath, '.agents/skills/existing'))).toEqual(['kept']);
    });

    it('reports a race-lost exclusive directory claim as a collision', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });
      const actual = actualModule5;
      vi.mocked(fs.mkdir).mockImplementationOnce(async (target, options) => {
        // Another writer claims the folder between the existence check and the claim.
        await actual.mkdir(target);
        return actual.mkdir(target, options);
      });

      await expect(files.createManagedFolderExclusive('.agents/skills/racing'))
        .rejects.toBeInstanceOf(ManagedResourceCollisionError);
    });

    it('propagates an exclusive claim failure when no competing target exists', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });
      vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

      await expect(files.createManagedFolderExclusive('.agents/skills/failing'))
        .rejects.toThrow('Could not exclusively create');
      await expect(fs.lstat(path.join(vaultPath, '.agents/skills/failing'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('managed writes on desktop', () => {
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vaultPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-')));
      files = new VaultFileAdapter({
        vault: { adapter: createDesktopFsAdapter(vaultPath) },
      } as unknown as App);
      await fs.mkdir(path.join(vaultPath, '.agents/skills/kept'), { recursive: true });
      await fs.writeFile(path.join(vaultPath, '.agents/skills/kept/SKILL.md'), 'original');
    });

    afterEach(async () => {
      await fs.rm(vaultPath, { recursive: true, force: true });
    });

    it('replaces the file content in one step', async () => {
      await files.writeManagedFile('.agents/skills/kept/SKILL.md', 'updated');

      expect(await fs.readFile(path.join(vaultPath, '.agents/skills/kept/SKILL.md'), 'utf8')).toBe('updated');
      expect(await fs.readdir(path.join(vaultPath, '.agents/skills/kept'))).toEqual(['SKILL.md']);
    });

    it('keeps the previous content when a write fails partway', async () => {
      const actual = actualModule6;
      vi.mocked(fs.writeFile).mockImplementationOnce(async file => {
        await actual.writeFile(file, 'torn');
        throw new Error('ENOSPC: no space left on device');
      });

      await expect(files.writeManagedFile('.agents/skills/kept/SKILL.md', 'updated'))
        .rejects.toThrow('Could not write managed resource');

      expect(await fs.readFile(path.join(vaultPath, '.agents/skills/kept/SKILL.md'), 'utf8')).toBe('original');
      expect(await fs.readdir(path.join(vaultPath, '.agents/skills/kept'))).toEqual(['SKILL.md']);
    });
  });

  describe('managed file moves on desktop', () => {
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vaultPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-')));
      files = new VaultFileAdapter({
        vault: { adapter: createDesktopFsAdapter(vaultPath) },
      } as unknown as App);
      await fs.mkdir(path.join(vaultPath, 'Docs/Old'), { recursive: true });
      await fs.mkdir(path.join(vaultPath, 'Docs/New'), { recursive: true });
      await fs.writeFile(path.join(vaultPath, 'Docs/Old/plan.md'), 'plan');
    });

    afterEach(async () => {
      await fs.rm(vaultPath, { recursive: true, force: true });
    });

    it.each([
      ['another folder', 'Docs/New/plan.md'],
      ['the vault root', 'plan.md'],
    ])('moves a file into %s', async (_label, target) => {
      await files.moveManagedFile('Docs/Old/plan.md', target);

      expect(await fs.readFile(path.join(vaultPath, ...target.split('/')), 'utf8')).toBe('plan');
      await expect(fs.access(path.join(vaultPath, 'Docs/Old/plan.md'))).rejects.toThrow();
    });

    it('moves a file out of the vault root', async () => {
      await fs.writeFile(path.join(vaultPath, 'root.md'), 'root');

      await files.moveManagedFile('root.md', 'Docs/New/root.md');

      expect(await fs.readFile(path.join(vaultPath, 'Docs/New/root.md'), 'utf8')).toBe('root');
      await expect(fs.access(path.join(vaultPath, 'root.md'))).rejects.toThrow();
    });

    it('never replaces an existing target and keeps both files', async () => {
      await fs.writeFile(path.join(vaultPath, 'Docs/New/plan.md'), 'other');

      await expect(files.moveManagedFile('Docs/Old/plan.md', 'Docs/New/plan.md'))
        .rejects.toBeInstanceOf(ManagedResourceCollisionError);

      expect(await fs.readFile(path.join(vaultPath, 'Docs/Old/plan.md'), 'utf8')).toBe('plan');
      expect(await fs.readFile(path.join(vaultPath, 'Docs/New/plan.md'), 'utf8')).toBe('other');
    });
  });

  describe('folder links', () => {
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vaultPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-')));
      files = new VaultFileAdapter({
        vault: { adapter: createDesktopFsAdapter(vaultPath) },
      } as unknown as App);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(vaultPath, { recursive: true, force: true });
    });

    it('creates a native folder link and reports it as linked to the target', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });

      await files.createFolderLink('.claude/skills', '.agents/skills');

      expect(await fs.readlink(path.join(vaultPath, '.claude/skills'))).toBe(
        process.platform === 'win32'
          ? path.join(vaultPath, '.agents', 'skills')
          : path.join('..', '.agents', 'skills'),
      );
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('linked');
    });

    it('reports missing, folder, file, foreign and broken states without following links', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('missing');

      await fs.mkdir(path.join(vaultPath, '.claude/skills'), { recursive: true });
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('folder');
      await fs.rmdir(path.join(vaultPath, '.claude/skills'));

      await fs.writeFile(path.join(vaultPath, '.claude/skills'), 'file');
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('other');
      await fs.rm(path.join(vaultPath, '.claude/skills'));

      await fs.mkdir(path.join(vaultPath, 'elsewhere'));
      await fs.symlink(path.join(vaultPath, 'elsewhere'), path.join(vaultPath, '.claude/skills'));
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('foreign-link');
      await fs.unlink(path.join(vaultPath, '.claude/skills'));

      await fs.symlink(path.join(vaultPath, 'gone'), path.join(vaultPath, '.claude/skills'));
      await expect(files.inspectFolderLink('.claude/skills', '.agents/skills')).resolves.toBe('broken-link');
    });

    it('refuses to replace an existing entry when creating a link', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });
      await fs.mkdir(path.join(vaultPath, '.claude/skills'), { recursive: true });

      await expect(files.createFolderLink('.claude/skills', '.agents/skills'))
        .rejects.toBeInstanceOf(ManagedResourceCollisionError);
    });

    it('removes only the link and never its target', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills/kept'), { recursive: true });
      await files.createFolderLink('.claude/skills', '.agents/skills');

      await files.removeFolderLink('.claude/skills');

      await expect(fs.lstat(path.join(vaultPath, '.claude/skills'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(vaultPath, '.agents/skills/kept'))).resolves.toBeTruthy();
    });

    it('refuses to remove a real folder as a link', async () => {
      await fs.mkdir(path.join(vaultPath, '.claude/skills/real'), { recursive: true });

      await expect(files.removeFolderLink('.claude/skills')).rejects.toThrow('not a link');
      await expect(fs.stat(path.join(vaultPath, '.claude/skills/real'))).resolves.toBeTruthy();
    });

    it('creates an absolute junction on Windows', async () => {
      await fs.mkdir(path.join(vaultPath, '.agents/skills'), { recursive: true });
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const symlink = vi.mocked(fs.symlink).mockResolvedValueOnce(undefined);
      try {
        await files.createFolderLink('.claude/skills', '.agents/skills');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      expect(symlink).toHaveBeenCalledWith(
        path.join(vaultPath, '.agents', 'skills'),
        path.join(vaultPath, '.claude', 'skills'),
        'junction',
      );
    });
  });
});
