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

it.each(cases)('$id removes deselected aliases, preferences and saved effort projections from disk', async ({ id, populate, selected }) => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  populate(settings);
  const config = settings.providerConfigs[id]!;
  const selectedId = (config.visibleModels as string[])[0];
  const removedId = id === 'pi' ? 'pi:anthropic/unselected-catalog-entry' : 'unselected-catalog-entry';
  config.modelAliases = { [selectedId]: 'Keep alias', [removedId]: 'Remove alias' };
  if (id === 'grok') config.preferredReasoningByModel = { [selectedId]: 'high', [removedId]: 'medium' };
  if (id === 'pi' || id === 'opencode') config.preferredThinkingByModel = { [selectedId]: 'high', [removedId]: 'medium' };
  if (id === 'opencode') config.thinkingOptionsByModel = {
    [selectedId]: [{ label: 'High', value: 'high' }],
    [removedId]: [{ label: 'Medium', value: 'medium' }],
  };
  const ui = ProviderRegistry.getChatUIConfig(id);
  const removedSelection = ui.normalizeAvailableModelSelection?.(removedId, settings) ?? removedId;
  settings.savedProviderModel = { [id]: removedSelection };
  settings.savedProviderEffort = { [id]: 'medium' };
  settings.savedProviderThinkingBudget = { [id]: 'low' };
  settings.savedProviderServiceTier = { [id]: 'fast' };
  settings.savedProviderPermissionMode = { [id]: 'normal' };
  let content = '';
  const storage = new ClaudianSettingsStorage({
    exists: async () => false,
    write: async (_path: string, value: string) => { content = value; },
  } as unknown as VaultFileAdapter);

  await storage.save(settings);

  const saved = JSON.parse(content);
  expect(saved.providerConfigs[id].modelAliases).toEqual({ [selectedId]: 'Keep alias' });
  expect(content).not.toContain('unselected-catalog-entry');
  for (const field of ['savedProviderModel', 'savedProviderEffort', 'savedProviderThinkingBudget', 'savedProviderServiceTier']) {
    expect(saved[field]?.[id]).toBeUndefined();
  }
  expect(saved.savedProviderPermissionMode[id]).toBe('normal');
  expect(settings.savedProviderModel[id]).toBe(removedSelection);
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(settings).some(model => ui.normalizeModelVariant(model.value, settings) === ui.normalizeModelVariant(ui.normalizeAvailableModelSelection?.(selected, settings) ?? selected, settings))).toBe(true);
});

it('cleans stale projections for every provider together when loading saved settings', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  for (const { id, populate } of cases) {
    populate(settings);
    settings.savedProviderModel[id] = 'unselected-catalog-entry';
    settings.savedProviderEffort[id] = 'medium';
  }
  let content = JSON.stringify(settings);
  const storage = new ClaudianSettingsStorage({
    exists: async () => true,
    delete: async () => undefined,
    read: async () => content,
    write: async (_path: string, value: string) => { content = value; },
  } as unknown as VaultFileAdapter);
  const restored = await storage.load();
  for (const { id, read } of cases) {
    expect(restored.savedProviderModel[id]).toBeUndefined();
    expect(restored.savedProviderEffort[id]).toBeUndefined();
    expect(JSON.parse(content).savedProviderModel[id]).toBeUndefined();
    expect(read(restored).length).toBeGreaterThan(0);
  }
  expect(content).not.toContain('unselected-catalog-entry');
});

it('preserves the alias of a Claude model selected through its resolved identity', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.providerConfigs.claude = { enabled: true, visibleModels: ['claude-sonnet-resolved'],
    discoveredModels: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-resolved', label: 'Sonnet', description: '' }],
    modelAliases: { sonnet: 'My Sonnet', removed: 'Remove' } };
  let content = '';
  await new ClaudianSettingsStorage({
    exists: async () => false,
    write: async (_path: string, value: string) => { content = value; },
  } as unknown as VaultFileAdapter).save(settings);
  expect(JSON.parse(content).providerConfigs.claude.modelAliases).toEqual({ sonnet: 'My Sonnet' });
});

it.each(cases.flatMap(entry => [false, true].map(unavailable => ({ ...entry, unavailable }))))(
  '$id retains saved projections for an explicitly selected model (unavailable: $unavailable)',
  async ({ id, populate, unavailable }) => {
    const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
    populate(settings);
    const selected = ProviderRegistry.getChatUIConfig(id).getModelOptions(settings)[0].value;
    settings.savedProviderModel = { [id]: selected };
    settings.savedProviderEffort = { [id]: 'low' };
    settings.customContextLimits = { [selected]: 128_000, 'deselected-model': 32_000 };
    const originalLimits = { ...settings.customContextLimits };
    if (unavailable) {
      const config = settings.providerConfigs[id]!;
      config.discoveredModels = [];
      if (id === 'grok') {
        for (const catalog of Object.values(config.catalogsByHost as Record<string, { models: unknown[] }>)) {
          catalog.models = [];
        }
      }
    }
    let content = '';
    await new ClaudianSettingsStorage({
      exists: async () => false,
      write: async (_path: string, value: string) => { content = value; },
    } as unknown as VaultFileAdapter).save(settings);
    expect(JSON.parse(content).savedProviderModel[id]).toBe(selected);
    expect(JSON.parse(content).savedProviderEffort[id]).toBe('low');
    expect(JSON.parse(content).customContextLimits).toEqual({ [selected]: 128_000 });
    expect(settings.customContextLimits).toEqual(originalLimits);
  },
);

it('keeps xHigh for an explicitly selected Grok model while its capabilities are unavailable', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.providerConfigs.grok = { enabled: true, visibleModels: ['temporarily-unavailable'],
    preferredReasoningByModel: { 'temporarily-unavailable': 'xhigh', deselected: 'max' } };
  let content = '';
  const storage = new ClaudianSettingsStorage({
    exists: async () => Boolean(content),
    read: async () => content,
    write: async (_path: string, value: string) => { content = value; },
    delete: async () => undefined,
  } as unknown as VaultFileAdapter);
  await storage.save(settings);
  expect(JSON.parse(content).providerConfigs.grok.preferredReasoningByModel)
    .toEqual({ 'temporarily-unavailable': 'xhigh' });
  const restored = await storage.load();
  expect(getGrokProviderSettings(restored).preferredReasoningByModel)
    .toEqual({ 'temporarily-unavailable': 'xhigh' });
});


it('cleans context overrides by provider identity while preserving resolved aliases and snippet templates', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  for (const { populate } of cases) populate(settings);
  settings.providerConfigs.claude = { enabled: true, visibleModels: ['claude-sonnet-resolved'],
    discoveredModels: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-resolved', label: 'Sonnet', description: '' }] };
  settings.customContextLimits = {
    'claude-sonnet-resolved': 128_000,
    'claude-code/sonnet': 128_000,
    Sonnet: 128_000,
    selected: 128_000,
    'grok/selected': 128_000,
    'openai-codex/selected': 64_000,
    'grok/gpt-5.5': 64_000,
    removed: 32_000,
  };
  settings.envSnippets = [{ id: 'template', name: 'Template', description: '', envVars: '',
    contextLimits: { removed: 32_000 }, modelAliases: { removed: 'Template model' } }];
  const before = structuredClone(settings);
  let content = '';
  const storage = new ClaudianSettingsStorage({
    exists: async () => Boolean(content),
    read: async () => content,
    write: async (_path: string, value: string) => { content = value; },
    delete: async () => undefined,
  } as unknown as VaultFileAdapter);
  await storage.save(settings);
  const expected = {
    'claude-sonnet-resolved': 128_000, 'claude-code/sonnet': 128_000,
    Sonnet: 128_000, selected: 128_000, 'grok/selected': 128_000,
  };
  expect(JSON.parse(content).customContextLimits).toEqual(expected);
  expect(JSON.parse(content).envSnippets).toEqual(settings.envSnippets);
  expect(settings).toEqual(before);

  // An otherwise normalized file still triggers cleanup when only this map is stale.
  const saved = JSON.parse(content);
  content = JSON.stringify({ ...saved, customContextLimits: { ...expected, removed: 32_000 } });
  const restored = await storage.load();
  expect(restored.customContextLimits).toEqual(expected);
  expect(JSON.parse(content).customContextLimits).toEqual(expected);
  expect(restored.envSnippets).toEqual(settings.envSnippets);
});
