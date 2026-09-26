import '@/providers';

import { CLAUDIAN_SETTINGS_PATH, ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

function fixture() {
  const retiredPath = '.claude/claudian-settings.json';
  const files = new Map([[retiredPath, JSON.stringify({ userName: 'Retired' })]]);
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path)),
    read: jest.fn(async (path: string) => files.get(path)!),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    delete: jest.fn(async (path: string) => { files.delete(path); }),
  };
  const storage = new ClaudianSettingsStorage(adapter as unknown as VaultFileAdapter);
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  return { files, adapter, storage, settings, coordinator, retiredPath };
}

test('loads and saves canonical settings without reading or deleting retired storage', async () => {
  const { files, adapter, settings, coordinator, storage, retiredPath } = fixture();
  expect((await storage.load()).userName).toBe(DEFAULT_CLAUDIAN_SETTINGS.userName);
  expect(adapter.read).not.toHaveBeenCalled();
  const publish = jest.fn();
  await coordinator.mutate(value => { value.userName = 'Updated'; }, publish);
  expect(settings.userName).toBe('Updated');
  expect((await storage.load()).userName).toBe('Updated');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(files.get(retiredPath)).toBe(JSON.stringify({ userName: 'Retired' }));
  expect(adapter.delete).not.toHaveBeenCalled();
});

test('a canonical write failure rolls back memory without touching retired storage', async () => {
  const { files, adapter, settings, coordinator, retiredPath } = fixture();
  const previousName = settings.userName;
  adapter.write.mockRejectedValueOnce(new Error('Write failed'));
  await expect(coordinator.mutate(value => { value.userName = 'Unsaved'; })).rejects.toThrow('Write failed');
  expect(settings.userName).toBe(previousName);
  expect(files.has(CLAUDIAN_SETTINGS_PATH)).toBe(false);
  expect(files.has(retiredPath)).toBe(true);
  expect(adapter.delete).not.toHaveBeenCalled();
});
