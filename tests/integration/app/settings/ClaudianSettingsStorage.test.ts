import '@/providers';

import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage,
  LEGACY_CLAUDIAN_SETTINGS_PATH,
} from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

function fixture() {
  const files = new Map([[LEGACY_CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Legacy' })]]);
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path)),
    read: jest.fn(async (path: string) => files.get(path)!),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    delete: jest.fn(async (path: string) => { files.delete(path); }),
  };
  const storage = new ClaudianSettingsStorage(adapter as unknown as VaultFileAdapter);
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  return { files, adapter, storage, settings, coordinator };
}

test.each(['exists', 'delete'] as const)(
  'legacy cleanup %s failure preserves the committed settings and retries on the next save',
  async operation => {
    const { files, adapter, settings, coordinator } = fixture();
    adapter[operation].mockRejectedValueOnce(new Error('Legacy file unavailable'));
    const publish = jest.fn();

    await expect(coordinator.mutate(value => { value.userName = 'Updated'; }, publish))
      .resolves.toBeUndefined();

    expect(settings.userName).toBe('Updated');
    expect(JSON.parse(files.get(CLAUDIAN_SETTINGS_PATH)!).userName).toBe('Updated');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(files.has(LEGACY_CLAUDIAN_SETTINGS_PATH)).toBe(true);

    await coordinator.persistCurrent();
    expect(files.has(LEGACY_CLAUDIAN_SETTINGS_PATH)).toBe(false);
  },
);

test('legacy migration remains usable when obsolete settings cannot be deleted', async () => {
  const { files, adapter, storage } = fixture();
  adapter.delete.mockRejectedValueOnce(new Error('Legacy file is locked'));

  await expect(storage.load()).resolves.toMatchObject({ userName: 'Legacy' });
  expect(JSON.parse(files.get(CLAUDIAN_SETTINGS_PATH)!).userName).toBe('Legacy');
  expect(files.has(LEGACY_CLAUDIAN_SETTINGS_PATH)).toBe(true);
  await expect(storage.load()).resolves.toMatchObject({ userName: 'Legacy' });
});

test('a canonical write failure still rolls back memory and preserves the legacy file', async () => {
  const { files, adapter, settings, coordinator } = fixture();
  const previousName = settings.userName;
  adapter.write.mockRejectedValueOnce(new Error('Write failed'));

  await expect(coordinator.mutate(value => { value.userName = 'Unsaved'; }))
    .rejects.toThrow('Write failed');
  expect(settings.userName).toBe(previousName);
  expect(files.has(CLAUDIAN_SETTINGS_PATH)).toBe(false);
  expect(files.has(LEGACY_CLAUDIAN_SETTINGS_PATH)).toBe(true);
  expect(adapter.delete).not.toHaveBeenCalled();
});
