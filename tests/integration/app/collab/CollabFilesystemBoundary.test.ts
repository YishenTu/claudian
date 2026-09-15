import { constants } from 'node:fs';
import type * as FileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureCollabVaultDirectory,
  syncCollabVaultDirectoryDurably,
} from '@/app/collab/CollabFilesystemBoundary';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';

let directory: string;

beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'collab-durable-files-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('synchronizes newly created and existing directory entries on the native filesystem', async () => {
  const created = await ensureCollabVaultDirectory(directory, 'private/nested', { durable: true });
  expect(created).toBe(path.join(directory, 'private/nested'));
  await expect(syncCollabVaultDirectoryDurably(directory, 'private/nested')).resolves.toBeUndefined();
});

it('retains required directory synchronization failures', async () => {
  await mkdir(path.join(directory, 'private'));
  const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
  const open = filesystem.open;
  const fault = jest.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    handle.sync = () => Promise.reject(Object.assign(new Error('Injected sync failure'), { code: 'EIO' }));
    return handle;
  });
  try {
    await expect(syncCollabVaultDirectoryDurably(directory, 'private')).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'directory-sync-required' },
    });
  } finally { fault.mockRestore(); }
});

it('can publish and reload the same credential when flushing requires Windows write access', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
  const open = filesystem.open;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const windowsAccess = jest.spyOn(filesystem, 'open').mockImplementation(async (file, flags, mode) => {
    const isDirectory = (await filesystem.stat(file).catch(() => null))?.isDirectory() === true;
    // POSIX cannot open a directory for writing; preserve its real flush while
    // applying the Windows FlushFileBuffers access requirement at this OS seam.
    const handle = await open(file, isDirectory && platform.value !== 'win32' ? constants.O_RDONLY : flags, mode);
    const sync = handle.sync.bind(handle);
    handle.sync = () => {
      if (typeof flags === 'number' && (flags & (constants.O_RDWR | constants.O_WRONLY)) === 0) {
        return Promise.reject(Object.assign(new Error('Windows flush requires write access'), { code: 'EPERM' }));
      }
      return sync();
    };
    return handle;
  });
  try {
    const first = await new CloudProjectCredentialStore(directory).getOrCreate('project-windows-flush');
    expect(await new CloudProjectCredentialStore(directory).require('project-windows-flush')).toEqual(first);
    const stored = JSON.parse(await readFile(path.join(directory, '.claudian/collab/cloud-credentials/project-windows-flush.json'), 'utf8')) as { credential: string };
    expect(stored.credential).toBe(first.credential);
  } finally {
    windowsAccess.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
