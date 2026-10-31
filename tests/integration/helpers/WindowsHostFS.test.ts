import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));

// Windows-shaped paths are real on a Windows host; the fake refuses to shadow them there.
describe.skipIf(path.sep === '\\')('WindowsHostFS on a POSIX host', () => {
  const modules = { fs, fsPromises };

  it('serves each distro through both UNC servers with case-insensitive share and distro names', async () => {
    const host = createWindowsHostFS(modules);
    await host.write(host.fromLinux('/home/alice/note.txt'), 'ubuntu');
    await host.write(host.fromLinux('/home/alice/note.txt', 'Debian'), 'debian');
    expect(fs.readFileSync(String.raw`\\wsl$\Ubuntu\home\alice\note.txt`, 'utf8')).toBe('ubuntu');
    expect(await fsPromises.readFile('//WSL.localhost/ubuntu/home/alice/note.txt', 'utf8')).toBe('ubuntu');
    expect(fs.readFileSync(String.raw`\\wsl$\Debian\home\alice\note.txt`, 'utf8')).toBe('debian');
    expect(fs.existsSync(String.raw`\\wsl$\Alpine\home\alice\note.txt`)).toBe(false);
    expect(fs.readdirSync(String.raw`\\wsl$\Ubuntu\home\alice`)).toEqual(['note.txt']);
  });

  it('serves /mnt drive files at their Windows paths, not through the distro share', async () => {
    const host = createWindowsHostFS(modules);
    expect(host.fromLinux('/mnt/c/Vault/note.txt')).toBe(String.raw`C:\Vault\note.txt`);
    await host.write(host.fromLinux('/mnt/c/Vault/note.txt'), 'drive');
    expect(fs.statSync(String.raw`c:\Vault\note.txt`).isFile()).toBe(true);
    expect(fs.existsSync(String.raw`\\wsl$\Ubuntu\mnt\c\Vault\note.txt`)).toBe(false);
  });

  it('maps realpath results back to host paths, including a link into another distro', async () => {
    const host = createWindowsHostFS(modules);
    await host.write(String.raw`\\wsl$\Debian\tmp\target.txt`, 'linked');
    await host.write(String.raw`D:\Data\file.txt`, 'drive');
    await fsPromises.mkdir(String.raw`\\wsl$\Ubuntu\tmp`, { recursive: true });
    fs.symlinkSync(host.local(String.raw`\\wsl$\Debian\tmp\target.txt`), host.local(String.raw`\\wsl$\Ubuntu\tmp\link.txt`));
    expect(fs.realpathSync(String.raw`\\wsl.localhost\ubuntu\tmp\link.txt`)).toBe(String.raw`\\wsl$\Debian\tmp\target.txt`);
    expect(await fsPromises.realpath(String.raw`d:\Data\file.txt`)).toBe(String.raw`D:\Data\file.txt`);
  });

  it('matches Windows paths case-insensitively and Linux paths case-sensitively on any host filesystem', async () => {
    const host = createWindowsHostFS(modules);
    await host.write(String.raw`C:\Vault\Note.md`, 'first casing');
    expect(fs.readFileSync(String.raw`c:\VAULT\note.MD`, 'utf8')).toBe('first casing');
    expect(fs.readdirSync(String.raw`C:\vault`)).toEqual(['Note.md']);
    expect(fs.realpathSync(String.raw`c:\vault\note.md`)).toBe(String.raw`C:\Vault\Note.md`);
    await host.write(host.fromLinux('/home/Alice/a.txt'), 'upper');
    // A case-insensitive host would silently merge these; every host reports the unmodeled case instead.
    expect(() => fs.existsSync(host.fromLinux('/home/alice/a.txt'))).toThrow('case-distinct Linux paths');
  });

  it('takes casing from existing entries, not from an earlier unsuccessful lookup', async () => {
    const host = createWindowsHostFS(modules);
    expect(fs.existsSync(String.raw`C:\vault\note.md`)).toBe(false);
    await host.write(String.raw`C:\Vault\Note.md`, 'created');
    expect(fs.readdirSync('C:\\')).toEqual(['Vault']);
    expect(fs.readdirSync(String.raw`C:\Vault`)).toEqual(['Note.md']);
    expect(fs.existsSync(host.fromLinux('/home/alice/a.txt'))).toBe(false);
    await host.write(host.fromLinux('/home/Alice/a.txt'), 'linux');
    expect(fs.readdirSync(String.raw`\\wsl$\Ubuntu\home`)).toEqual(['Alice']);
  });

  it('maps only path arguments, leaving Windows-shaped file contents verbatim', async () => {
    const host = createWindowsHostFS(modules);
    await host.write(String.raw`C:\Vault\note.txt`, '');
    await fsPromises.writeFile(String.raw`C:\Vault\note.txt`, String.raw`D:\Data\literal.txt`, 'utf8');
    expect(await fsPromises.readFile(String.raw`C:\Vault\note.txt`, 'utf8')).toBe(String.raw`D:\Data\literal.txt`);
    // copyFile takes two paths.
    await fsPromises.mkdir(String.raw`\\wsl$\Ubuntu`, { recursive: true });
    await fsPromises.copyFile(String.raw`C:\Vault\note.txt`, String.raw`\\wsl$\Ubuntu\note.txt`);
    expect(await host.read(String.raw`\\wsl$\Ubuntu\note.txt`)).toBe(String.raw`D:\Data\literal.txt`);
  });

  it('uses directory names that are valid on NTFS', async () => {
    const host = createWindowsHostFS(modules);
    for (const hostPath of [String.raw`C:\Vault\note.md`, String.raw`\\wsl$\Ubuntu\home\me\note.md`]) {
      await host.write(hostPath, 'content');
      const segments = host.local(hostPath).split(path.sep).filter(Boolean);
      expect(segments.filter(segment => /[<>:"|?*]/u.test(segment))).toEqual([]);
    }
  });

  it('leaves native paths, its own root and the host temp directory unredirected', async () => {
    const native = await fsPromises.mkdtemp(path.join(tmpdir(), 'claudian-windows-native-'));
    onTestFinished(() => fsPromises.rm(native, { recursive: true, force: true }));
    const host = createWindowsHostFS(modules, { hostTmpDir: String.raw`C:\Users\me\AppData\Local\Temp` });
    await fsPromises.writeFile(path.join(native, 'note.txt'), 'native');
    expect(fs.readFileSync(path.join(native, 'note.txt'), 'utf8')).toBe('native');
    expect(fs.realpathSync(native)).toBe(fs.realpathSync.native(native));
    // A Windows host's temp directory is Windows-shaped; it stays native rather than being shadowed.
    expect(() => host.local(String.raw`c:\users\me\appdata\local\temp\claudian\x`)).toThrow('Not a modeled Windows host path');
    const local = host.local(String.raw`C:\Vault\note.md`);
    expect(fs.existsSync(local)).toBe(false);
    expect(host.local(String.raw`C:\Vault\note.md`)).toBe(local);
  });

  it('throws when production reaches an unredirected fs function with a Windows path', async () => {
    const native = await fsPromises.mkdtemp(path.join(tmpdir(), 'claudian-windows-native-'));
    onTestFinished(() => fsPromises.rm(native, { recursive: true, force: true }));
    createWindowsHostFS(modules);
    expect(() => fs.appendFileSync(String.raw`C:\Vault\log.txt`, 'line')).toThrow('does not model fs.appendFileSync');
    expect(() => fsPromises.appendFile(String.raw`\\wsl$\Ubuntu\log.txt`, 'line')).toThrow('does not model fs/promises.appendFile');
    fs.appendFileSync(path.join(native, 'log.txt'), 'line');
    expect(fs.readFileSync(path.join(native, 'log.txt'), 'utf8')).toBe('line');
  });

  it('refuses to run on a Windows host, where the paths are real', () => {
    const readFileSync = fs.readFileSync;
    expect(() => createWindowsHostFS(modules, { hostPlatform: 'win32' })).toThrow('skip this suite on Windows');
    expect(fs.readFileSync).toBe(readFileSync);
  });
});
