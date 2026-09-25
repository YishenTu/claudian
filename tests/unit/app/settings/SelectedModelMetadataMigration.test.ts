import '@/providers';

import { modelCatalogCases as cases } from '@test/helpers/providerModelCatalogs';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { migrateSelectedModelMetadata } from '@/app/settings/SelectedModelMetadataMigration';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { updateClaudeProviderSettings } from '@/providers/claude/settings';
import { updateCodexProviderSettings } from '@/providers/codex/settings';
import { updateCurrentGrokCatalog, updateGrokProviderSettings } from '@/providers/grok/settings';
import { updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { updatePiProviderSettings } from '@/providers/pi/settings';

const update = {
  claude: updateClaudeProviderSettings, codex: updateCodexProviderSettings,
  grok: updateGrokProviderSettings, opencode: updateOpencodeProviderSettings, pi: updatePiProviderSettings,
};

function makeHost() {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, settings, false);
  let content = '';
  const storage = new ClaudianSettingsStorage({
    exists: async () => Boolean(content), read: async () => content,
    write: async (_path: string, value: string) => { content = value; }, delete: async () => undefined,
  } as unknown as VaultFileAdapter);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  const host = {
    settings, mutateSettings: coordinator.mutate.bind(coordinator),
    notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
  return { host, storage, read: () => JSON.parse(content) };
}

beforeEach(() => {
  jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue();
});
afterEach(() => {
  for (const { id } of cases) ProviderWorkspaceRegistry.setServices(id, undefined);
  jest.restoreAllMocks();
});

it.each(cases.flatMap(entry => [false, true].map(deselectDuringQuery => ({ ...entry, deselectDuringQuery }))))(
  '$id fills missing metadata and respects deselection during query: $deselectDuringQuery', async ({ id, populate, deselectDuringQuery }) => {
  const { host, storage, read } = makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selectedIds = [...config.visibleModels as string[]];
  const complete = structuredClone(host.settings);
  if (id === 'claude') (complete.providerConfigs.claude!.discoveredModels as any[])[0].supportedEffortLevels = ['low', 'high'];
  if (id === 'opencode') complete.providerConfigs.opencode!.thinkingOptionsByModel = {
    [selectedIds[0]]: [{ value: 'high', label: 'High' }],
  };
  if (id === 'grok') {
    updateCurrentGrokCatalog(complete, { defaultModelId: selectedIds[0], fingerprint: 'test', refreshedAt: 1,
      models: [{ rawId: selectedIds[0], displayName: 'Selected', reasoningMetadataResolved: true,
        supportsReasoning: true, reasoningEfforts: [{ value: 'high', label: 'High' }] }] });
    updateCurrentGrokCatalog(host.settings, { defaultModelId: selectedIds[0], fingerprint: 'old', refreshedAt: 0, models: [] });
  } else config.discoveredModels = [];
  const discover = jest.fn(async () => {
    await host.mutateSettings(settings => {
      if (deselectDuringQuery) update[id](settings, { visibleModels: [] });
      const currentSelection = settings.providerConfigs[id]!.visibleModels;
      settings.providerConfigs[id] = { ...complete.providerConfigs[id], visibleModels: currentSelection };
    });
    return { changed: true };
  });
  const catalog = new ProviderModelCatalogController({
    providerId: id, providerName: id, host,
    read: () => ({ enabled: true, selectedIds: host.settings.providerConfigs[id]!.visibleModels as string[], models: [], aliases: {} }),
    update: (settings, patch) => update[id](settings, patch), discover,
  });
  ProviderWorkspaceRegistry.setServices(id, { modelCatalog: catalog });
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);

  await migrateSelectedModelMetadata(host, new AbortController().signal);

  expect(discover).toHaveBeenCalledTimes(1);
  expect(read().providerConfigs[id].visibleModels).toEqual(deselectDuringQuery ? [] : selectedIds);
  expect(JSON.stringify(read())).not.toContain('unselected-catalog-entry');
  const restored = await storage.load();
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(restored)).toHaveLength(deselectDuringQuery ? 0 : 1);
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(restored)).toBe(false);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(discover).toHaveBeenCalledTimes(1);
  await catalog.dispose();
});

it('does not initialize providers with no selected models or disabled providers', async () => {
  const { host } = makeHost();
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
});

it.each(['deselected', 'disabled', 'cancelled'] as const)('rechecks %s state after workspace initialization', async change => {
  const { host } = makeHost();
  cases[0].populate(host.settings);
  const controller = new AbortController();
  const refresh = jest.fn();
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: { refresh } as any });
  jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation(async () => {
    if (change === 'deselected') updateClaudeProviderSettings(host.settings, { visibleModels: [] });
    if (change === 'disabled') updateClaudeProviderSettings(host.settings, { enabled: false });
    if (change === 'cancelled') controller.abort();
  });
  await migrateSelectedModelMetadata(host, controller.signal);
  expect(refresh).not.toHaveBeenCalled();
});

it('preserves incomplete selections after a failed query and retries on a later startup', async () => {
  const { host } = makeHost();
  cases[0].populate(host.settings);
  const before = structuredClone(host.settings);
  const refresh = jest.fn().mockRejectedValue(new Error('CLI unavailable'));
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: { refresh } as any });
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(host.settings).toEqual(before);
});

it.each(cases)('$id detects missing effort fields in an otherwise present selected record', ({ id, populate }) => {
  const { host } = makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  if (id === 'codex') delete (config.discoveredModels as any[])[0].supportedReasoningEfforts;
  if (id === 'pi') delete (config.discoveredModels as any[])[0].thinkingLevels;
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});

it.each(cases)('$id detects a selected model missing from the catalog despite resolved effort metadata', ({ id, populate }) => {
  const { host } = makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selected = (config.visibleModels as string[])[0];
  if (id === 'opencode') config.thinkingOptionsByModel = { [selected]: [] };
  if (id === 'grok') updateCurrentGrokCatalog(host.settings, { defaultModelId: selected, fingerprint: 'native', refreshedAt: 1, models: [] });
  else config.discoveredModels = [];
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});

it.each(['claude', 'grok', 'opencode', 'pi'] as const)('%s retains confirmed non-reasoning metadata without querying on every reload', async id => {
  const { host, storage } = makeHost();
  cases.find(entry => entry.id === id)!.populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selected = (config.visibleModels as string[])[0];
  if (id === 'claude') Object.assign((config.discoveredModels as any[])[0], {
    supportedEffortLevels: [], reasoningMetadataResolved: true,
  });
  if (id === 'pi') Object.assign((config.discoveredModels as any[])[0], {
    thinkingLevels: ['off'], reasoning: false,
  });
  if (id === 'opencode') config.thinkingOptionsByModel = { [selected]: [] };
  if (id === 'grok') updateCurrentGrokCatalog(host.settings, {
    defaultModelId: selected, fingerprint: 'native', refreshedAt: 1,
    models: [{ rawId: selected, displayName: selected, reasoningEfforts: [], supportsReasoning: false, reasoningMetadataResolved: true }],
  });
  await storage.save(host.settings);
  const restored = await storage.load();
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(restored)).toBe(false);
});

it('cancels an active native query on unload', async () => {
  const { host } = makeHost();
  cases[0].populate(host.settings);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const catalog = new ProviderModelCatalogController({
    providerId: 'claude', providerName: 'Claude', host,
    read: () => ({ enabled: true, selectedIds: ['sonnet'], models: [], aliases: {} }), update: jest.fn(),
    discover: signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ changed: false }); }, { once: true });
      started();
    }),
  });
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: catalog });
  const flight = migrateSelectedModelMetadata(host, controller.signal);
  await ready;
  controller.abort();
  await flight;
  expect(aborted).toBe(true);
  await catalog.dispose();
});
