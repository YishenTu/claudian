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

import { DesktopVault } from '@test/helpers/core/DesktopVault';

import {
  ManagedResourceCollisionError,
  ManagedResourcePathError,
  type VaultFileAdapter,
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

describe('VaultFileAdapter on a desktop vault', () => {
  describe('managed resources', () => {
    it.each([
      ['managed root', '.agents', 'folder'],
      ['skills root', '.agents/skills', 'folder'],
      ['package', '.agents/skills/portable-skill', 'folder'],
      ['SKILL.md', '.agents/skills/portable-skill/SKILL.md', 'file'],
    ] as const)('rejects a symlinked %s on desktop adapters', async (_label, relative, type) => {
      const vault = await DesktopVault.create();
      const vaultPath = vault.root;
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

        await expect(vault.files.verifyManagedPath(relative, {
          expectedType: type,
        })).rejects.toThrow('symlink');
      } finally {
        await vault.dispose();
        await fs.rm(externalPath, { recursive: true, force: true });
      }
    });

    it('moves a complete package without requiring hard-link support', async () => {
      const vault = await DesktopVault.create();
      const vaultPath = vault.root;
      const link = vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old/assets'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/assets/example.txt'), 'asset');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        await vault.files
          .relocateManagedPackage('.agents/skills/old', '.agents/skills/new');

        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/assets/example.txt'), 'utf8'))
          .resolves.toBe('asset');
        await expect(fs.readFile(path.join(vaultPath, '.agents/skills/new/SKILL.md'), 'utf8'))
          .resolves.toBe('skill');
        await expect(fs.stat(path.join(vaultPath, '.agents/skills/old'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        link.mockReset().mockImplementation(actualModule0.link);
        await vault.dispose();
      }
    });

    it('leaves the whole source in place when the directory move fails', async () => {
      const vault = await DesktopVault.create();
      const vaultPath = vault.root;
      const rename = vi.mocked(fs.rename).mockRejectedValue(
        Object.assign(new Error('denied at /private/vault'), { code: 'EPERM' }),
      );
      try {
        await fs.mkdir(path.join(vaultPath, '.agents/skills/old/assets'), { recursive: true });
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/assets/example.txt'), 'asset');
        await fs.writeFile(path.join(vaultPath, '.agents/skills/old/SKILL.md'), 'skill');
        await expect(vault.files
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
        await vault.dispose();
      }
    });

    it.each(['empty', 'nonempty', 'racing-nonempty', 'racing-nonempty-EPERM'])('preserves a %s destination', async kind => {
      const vault = await DesktopVault.create();
      const vaultPath = vault.root;
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
        await expect(vault.files
          .relocateManagedPackage('.agents/skills/old', '.agents/skills/new'))
          .rejects.toBeInstanceOf(ManagedResourceCollisionError);
        await expect(fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).resolves.toBe('skill');
        const contents = await Promise.all((await fs.readdir(target)).map(name => fs.readFile(path.join(target, name), 'utf8')));
        expect(contents).toEqual(kind === 'empty' ? [] : ['racer']);
      } finally {
        rename.mockReset().mockImplementation(actualModule3.rename);
        await vault.dispose();
      }
    });

    it.each(['unchanged', 'target link'] as const)('rejects an existing %s package destination', async kind => {
      const vault = await DesktopVault.create();
      const vaultPath = vault.root;
      try {
        const source = path.join(vaultPath, '.agents/skills/old');
        const target = path.join(vaultPath, '.agents/skills/new');
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, 'SKILL.md'), 'skill');
        if (kind === 'target link') await fs.symlink(source, target, 'junction');
        await expect(vault.files.relocateManagedPackage('.agents/skills/old',
          kind === 'unchanged' ? '.agents/skills/old' : '.agents/skills/new'))
          .rejects.toBeInstanceOf(kind === 'unchanged' ? ManagedResourceCollisionError : ManagedResourcePathError);
        expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe('skill');
        const destination = kind === 'unchanged' ? source : target;
        expect((await fs.lstat(destination)).isSymbolicLink()).toBe(kind === 'target link');
        expect(await fs.realpath(destination)).toBe(await fs.realpath(source));
        expect((await fs.readdir(path.dirname(source))).sort()).toEqual(kind === 'unchanged' ? ['old'] : ['new', 'old']);
      } finally {
        await vault.dispose();
      }
    });

  });
  describe('managed folders on desktop', () => {
    let vault: DesktopVault;
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vault = await DesktopVault.create();
      vaultPath = vault.root;
      files = vault.files;
      vi.mocked(fs.lstat).mockClear();
      vi.mocked(fs.mkdir).mockClear();
    });

    afterEach(async () => {
      await vault.dispose();
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
      // The recursive adapter mkdir reports success but leaves a link at the leaf.
      vault.app.vault.adapter.mkdir = async () => {
        await fs.mkdir(path.join(vaultPath, '.agents'));
        await fs.symlink(os.tmpdir(), path.join(vaultPath, '.agents/skills'));
      };

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
    let vault: DesktopVault;
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vault = await DesktopVault.create();
      vaultPath = vault.root;
      files = vault.files;
      await fs.mkdir(path.join(vaultPath, '.agents/skills/kept'), { recursive: true });
      await fs.writeFile(path.join(vaultPath, '.agents/skills/kept/SKILL.md'), 'original');
    });

    afterEach(async () => {
      await vault.dispose();
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

    it('retries a replacement refused while another process briefly holds the target', async () => {
      const target = path.join(vaultPath, '.agents/skills/kept/SKILL.md');
      for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error(`${code}: file in use`), { code }));
        await files.writeManagedFile('.agents/skills/kept/SKILL.md', `after ${code}`);
        expect(await fs.readFile(target, 'utf8')).toBe(`after ${code}`);
      }
      expect(await fs.readdir(path.dirname(target))).toEqual(['SKILL.md']);

      // Other failures are not locks and surface at once.
      vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
      await expect(files.writeManagedFile('.agents/skills/kept/SKILL.md', 'full disk'))
        .rejects.toThrow('Could not write managed resource');
      expect(await fs.readFile(target, 'utf8')).toBe('after EBUSY');
      expect(await fs.readdir(path.dirname(target))).toEqual(['SKILL.md']);

      // A lock that outlasts the retries surfaces its last refusal instead of stalling the save.
      const refusals = Array.from({ length: 5 }, (_, index) => Object.assign(new Error(`locked-${index}`), { code: 'EBUSY' }));
      for (const refusal of refusals) vi.mocked(fs.rename).mockRejectedValueOnce(refusal);
      vi.mocked(fs.rename).mockClear();
      await expect(files.writeManagedFile('.agents/skills/kept/SKILL.md', 'still locked'))
        .rejects.toMatchObject({ cause: refusals[4] });
      expect(fs.rename).toHaveBeenCalledTimes(5);
      expect(await fs.readFile(target, 'utf8')).toBe('after EBUSY');
      expect(await fs.readdir(path.dirname(target))).toEqual(['SKILL.md']);
    });

    it('leaves a file untouched when its content is unchanged', async () => {
      // Sync clients treat each replacement as delete + create, so an unchanged save must not replace the file.
      const target = path.join(vaultPath, '.claudian/claudian-settings.json');
      await files.write('.claudian/claudian-settings.json', '{"a":1}');
      const before = await fs.stat(target);

      await files.write('.claudian/claudian-settings.json', '{"a":1}');
      await files.writeManagedFile('.claudian/claudian-settings.json', '{"a":1}');
      expect((await fs.stat(target)).ino).toBe(before.ino);

      await files.write('.claudian/claudian-settings.json', '{"a":2}');
      expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}');
      expect((await fs.stat(target)).ino).not.toBe(before.ino);
    });
  });

  describe('managed file moves on desktop', () => {
    let vault: DesktopVault;
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vault = await DesktopVault.create();
      vaultPath = vault.root;
      files = vault.files;
      await fs.mkdir(path.join(vaultPath, 'Docs/Old'), { recursive: true });
      await fs.mkdir(path.join(vaultPath, 'Docs/New'), { recursive: true });
      await fs.writeFile(path.join(vaultPath, 'Docs/Old/plan.md'), 'plan');
    });

    afterEach(async () => {
      await vault.dispose();
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
    let vault: DesktopVault;
    let vaultPath: string;
    let files: VaultFileAdapter;

    beforeEach(async () => {
      vault = await DesktopVault.create();
      vaultPath = vault.root;
      files = vault.files;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await vault.dispose();
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
