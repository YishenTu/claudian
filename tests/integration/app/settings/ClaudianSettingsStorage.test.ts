import '@/providers';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { clearWriteFaults, failWritesUnder } from '@test/helpers/core/fsWriteFaults';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';

import { CLAUDIAN_SETTINGS_PATH, ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';

vi.mock('node:fs/promises', async () => {
  const { createFsPromisesWithWriteFaults } = await vi.importActual<typeof import('@test/helpers/core/fsWriteFaults')>('@test/helpers/core/fsWriteFaults');
  return createFsPromisesWithWriteFaults();
});

const retiredPath = '.claude/claudian-settings.json';
let vault: DesktopVault;

beforeEach(async () => {
  vault = await DesktopVault.create();
  await vault.write(retiredPath, JSON.stringify({ userName: 'Retired' }));
});

afterEach(async () => {
  clearWriteFaults();
  vi.restoreAllMocks();
  await vault.dispose();
});

function fixture() {
  const adapter = vault.files;
  const storage = new ClaudianSettingsStorage(adapter, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  return { adapter, storage, settings, coordinator };
}

test('loads and saves canonical settings without reading or deleting retired storage', async () => {
  const { adapter, settings, coordinator, storage } = fixture();
  const read = vi.spyOn(adapter, 'read');
  const write = vi.spyOn(adapter, 'write');
  const remove = vi.spyOn(adapter, 'delete');
  expect(await storage.load()).toMatchObject({
    model: DEFAULT_CLAUDIAN_SETTINGS.model,
    permissionMode: DEFAULT_CLAUDIAN_SETTINGS.permissionMode,
    userName: DEFAULT_CLAUDIAN_SETTINGS.userName,
    requireCommandOrControlEnterToSend: false, titleGenerationLocale: '', lastSelectedChatModel: null,
    enableDualPane: true, dualPaneSide: 'right', restoreTabsOnStartup: true, enableZenMode: true,
  });
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const publish = vi.fn();
  await coordinator.mutate(value => { value.userName = 'Updated'; }, publish);
  expect(settings.userName).toBe('Updated');
  expect(JSON.parse(await vault.read(CLAUDIAN_SETTINGS_PATH)).userName).toBe('Updated');
  expect((await storage.load()).userName).toBe('Updated');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(await vault.read(retiredPath)).toBe(JSON.stringify({ userName: 'Retired' }));
  expect(remove).not.toHaveBeenCalled();
});

test('a canonical write failure rolls back memory without touching retired storage', async () => {
  const { adapter, settings, coordinator } = fixture();
  const remove = vi.spyOn(adapter, 'delete');
  const previousName = settings.userName;
  failWritesUnder(vault.root);
  await expect(coordinator.mutate(value => { value.userName = 'Unsaved'; })).rejects.toThrow('ENOSPC');
  expect(settings.userName).toBe(previousName);
  expect(await vault.exists(CLAUDIAN_SETTINGS_PATH)).toBe(false);
  expect(await vault.read(retiredPath)).toBe(JSON.stringify({ userName: 'Retired' }));
  expect(remove).not.toHaveBeenCalled();
});
