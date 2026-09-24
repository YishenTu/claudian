import '@/providers';

import { modelCatalogCases as cases } from '@test/helpers/providerModelCatalogs';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { getGrokProviderSettings, updateCurrentGrokCatalog } from '@/providers/grok/settings';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';
import { getPiProviderSettings } from '@/providers/pi/settings';

it.each(cases)('$id persists selected metadata without saving the available catalog', async ({ id, populate, read }) => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  populate(settings);
  let content = '';
  const adapter = {
    exists: jest.fn(async () => Boolean(content)),
    read: jest.fn(async () => content),
    write: jest.fn(async (_path: string, value: string) => { content = value; }),
    delete: jest.fn(async () => undefined),
  } as unknown as VaultFileAdapter;
  const storage = new ClaudianSettingsStorage(adapter);
  const expectedMetadata = read(settings)[0];
  await storage.save(settings);
  expect(content).not.toContain('unselected-catalog-entry');
  expect(JSON.parse(content).providerConfigs[id]).not.toHaveProperty('discoveredModels');
  expect(JSON.parse(content).providerConfigs[id]).not.toHaveProperty('catalogsByHost');
  expect(read(settings)).toHaveLength(2);
  const restored = await storage.load();
  expect(read(restored)).toEqual([expectedMetadata]);
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(restored)).toHaveLength(1);
});

it.each(cases)('$id keeps an unavailable saved selection unchanged', ({ id: providerId, populate, selected }) => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.model = selected;
  populate(settings);
  const current = settings.providerConfigs[providerId]!;
  current.visibleModels = [...current.visibleModels as string[], 'missing-model'];
  if (providerId === 'pi') current.visibleModels = ['pi:anthropic/missing-model'];
  if (providerId === 'grok') current.visibleModels = ['missing-model'];
  if (providerId === 'codex') current.visibleModels = ['missing-model'];
  const decoded = {
    claude: getClaudeProviderSettings,
    codex: getCodexProviderSettings,
    grok: getGrokProviderSettings,
    opencode: getOpencodeProviderSettings,
    pi: getPiProviderSettings,
  }[providerId](settings);
  expect(decoded.visibleModels).toEqual(current.visibleModels);
  expect(settings.model).toBe(selected);
});

it.each(cases)('$id does not restore removed models from an older selected snapshot', async ({ id, populate, read }) => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  populate(settings);
  let content = '';
  const storage = new ClaudianSettingsStorage({
    exists: async () => Boolean(content), read: async () => content,
    write: async (_path: string, value: string) => { content = value; }, delete: async () => undefined,
  } as unknown as VaultFileAdapter);
  await storage.save(settings);
  const restored = await storage.load();
  const config = restored.providerConfigs[id]!;
  const selected = config.visibleModels;
  if (id === 'grok') {
    updateCurrentGrokCatalog(restored, { defaultModelId: null, fingerprint: 'new', refreshedAt: 20, models: [] });
  } else {
    config.discoveredModels = [];
  }
  await storage.save(restored);
  const unavailable = await storage.load();
  expect(unavailable.providerConfigs[id]!.visibleModels).toEqual(selected);
  expect(read(unavailable)).toEqual([]);
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(unavailable)).toEqual([]);
});

it.each(cases)('$id keeps runtime catalog and selection intact when persistence fails', async ({ id, populate, read }) => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  populate(settings);
  const before = read(settings);
  const coordinator = new SettingsCoordinator(settings, async () => { throw new Error('Disk full'); });
  await expect(coordinator.mutate(value => { value.providerConfigs[id] = {}; }))
    .rejects.toThrow('Disk full');
  expect(read(settings)).toEqual(before);
});

it('materializes legacy implicit selections before a new catalog arrives', async () => {
  for (const id of ['claude', 'codex', 'grok'] as const) {
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    cases.find(entry => entry.id === id)!.populate(settings);
    settings.providerConfigs[id]!.visibleModels = null;
    const normalized = structuredClone(settings);
    ProviderRegistry.getSettingsStorageAdapter(id).normalizeStored?.(normalized, settings);
    expect(Array.isArray(normalized.providerConfigs[id]!.visibleModels)).toBe(true);
    expect(normalized.providerConfigs[id]!.visibleModels).toEqual(id === 'claude' ? ['haiku', 'sonnet', 'opus', 'fable'] : id === 'codex' ? ['gpt-5.5', 'unselected-catalog-entry'] : ['selected', 'unselected-catalog-entry']);
  }
});

it.each(['codex', 'grok'] as const)('does not implicitly enable %s discovery on a fresh profile', async id => {
  const storage = new ClaudianSettingsStorage({ exists: async () => false } as unknown as VaultFileAdapter);
  const settings = await storage.load();
  const selected = settings.providerConfigs[id]!.visibleModels;
  expect(selected).toEqual([]);
  cases.find(entry => entry.id === id)!.populate(settings);
  settings.providerConfigs[id]!.visibleModels = selected;
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(settings)).toEqual([]);
});
