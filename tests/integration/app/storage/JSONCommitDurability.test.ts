const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule1 = await vi.importActual<typeof fs>('node:fs/promises');
import '@/providers';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath } from '@/core/bootstrap/storagePaths';
import type { SessionMetadata } from '@/core/types';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
let vault: DesktopVault;

beforeEach(async () => { vault = await DesktopVault.create(); });
afterEach(async () => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualModule0.writeFile);
  await vault.dispose();
});

function failPartialWrite(): void {
  vi.mocked(fs.writeFile).mockImplementationOnce(async file => {
    await actualModule1.writeFile(file, '{"trunca');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
}

it('keeps committed settings reloadable when a transactional save writes only a prefix', async () => {
  const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
  await storage.save(settings);
  const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
  const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft));

  failPartialWrite();
  await expect(coordinator.mutate(draft => { draft.userName = 'Uncommitted'; })).rejects.toThrow('disk full');

  expect(settings.userName).toBe('Committed');
  expect(await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load())
    .toMatchObject({ userName: 'Committed' });
  expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
  expect(await fs.readdir(path.dirname(vault.resolve(CLAUDIAN_SETTINGS_PATH))))
    .not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
});

it('keeps committed conversation metadata available after a torn save', async () => {
  const store = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  const metadata: SessionMetadata = {
    id: 'conversation-durable', providerId: 'claude', title: 'Committed',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  await store.saveMetadata(metadata);
  const file = `${getDeviceSessionsPath(DEVICE_KEY)}/${metadata.id}.meta.json`;
  const committed = await vault.read(file);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);

  failPartialWrite();
  await expect(store.saveMetadata({ ...metadata, title: 'Uncommitted' })).rejects.toThrow('disk full');

  const reopened = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  expect(await reopened.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await vault.read(file)).toBe(committed);
  expect(await fs.readdir(path.dirname(vault.resolve(file))))
    .not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('ordinary-file compatibility on POSIX', () => {
  it('preserves restrictive modes when replacing committed settings', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    await storage.save(structuredClone(DEFAULT_CLAUDIAN_SETTINGS));
    await fs.chmod(vault.resolve(CLAUDIAN_SETTINGS_PATH), 0o600);

    await storage.save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Updated' });

    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).mode & 0o777).toBe(0o600);
    expect(await storage.load()).toMatchObject({ userName: 'Updated' });
  });

  it('preserves existing group permissions under a stricter creation umask', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    await storage.save(structuredClone(DEFAULT_CLAUDIAN_SETTINGS));
    await fs.chmod(vault.resolve(CLAUDIAN_SETTINGS_PATH), 0o660);
    const previousMask = process.umask(0o077);
    try {
      await storage.save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Updated' });
    } finally {
      process.umask(previousMask);
    }
    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).mode & 0o777).toBe(0o660);
  });

  it('retains leaf symlink write-through behavior', async () => {
    await vault.write('original.json', '{}');
    await vault.mkdir('.claudian');
    await vault.symlink(CLAUDIAN_SETTINGS_PATH, vault.resolve('original.json'));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked' });

    expect(await fs.lstat(vault.resolve(CLAUDIAN_SETTINGS_PATH)).then(stat => stat.isSymbolicLink())).toBe(true);
    expect(JSON.parse(await vault.read('original.json'))).toMatchObject({ userName: 'Linked' });
  });

  it('retains hardlink write-through behavior', async () => {
    await vault.write('original.json', '{}');
    await vault.mkdir('.claudian');
    await fs.link(vault.resolve('original.json'), vault.resolve(CLAUDIAN_SETTINGS_PATH));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked' });

    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).nlink).toBe(2);
    expect(JSON.parse(await vault.read('original.json'))).toMatchObject({ userName: 'Linked' });
  });

  it('continues writing through a linked parent directory', async () => {
    await vault.mkdir('settings');
    await vault.symlink('.claudian', vault.resolve('settings'));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked parent' });

    expect(await fs.lstat(vault.resolve('.claudian')).then(stat => stat.isSymbolicLink())).toBe(true);
    expect(JSON.parse(await vault.read('settings/claudian-settings.json'))).toMatchObject({ userName: 'Linked parent' });
  });
});
