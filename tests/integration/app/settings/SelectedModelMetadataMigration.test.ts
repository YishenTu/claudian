import '@/providers';

import { modelCatalogCases as cases } from '@test/helpers/providerModelCatalogs';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';

import { migrateSelectedModelMetadata } from '@/app/settings/SelectedModelMetadataMigration';
import { CLAUDIAN_SETTINGS_PATH } from '@/core/bootstrap/storagePaths';
import { findProviderModelOption, resolveConversationModel, resolveNewConversationModel } from '@/core/providers/conversationModel';
import {
  ProviderModelCatalogController,
  type ProviderModelCatalogPatch,
  type ProviderModelCatalogState,
  type ProviderModelCatalogStore,
} from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { getClaudeModelOptions, getClaudeSupportedEffortLevels } from '@/providers/claude/modelOptions';
import { createClaudeModels, discoverClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { getClaudeModelSource, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { updateCodexProviderSettings } from '@/providers/codex/settings';
import { updateDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { updateGrokProviderSettings } from '@/providers/grok/settings';
import { updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { updatePiProviderSettings } from '@/providers/pi/settings';

const update = {
  deepseek: updateDeepSeekProviderSettings,
  claude: updateClaudeProviderSettings, codex: updateCodexProviderSettings,
  grok: updateGrokProviderSettings, opencode: updateOpencodeProviderSettings, pi: updatePiProviderSettings,
};

/** A catalog store persisting selections through the settings document, as the migration sees them. */
function documentStore(
  host: ProviderHost,
  read: (settings: ProviderHost['settings']) => ProviderModelCatalogState,
  update: (settings: import('@/core/types').ClaudianSettings, patch: ProviderModelCatalogPatch) => void,
): ProviderModelCatalogStore {
  return {
    read: () => read(host.settings),
    write: change => host.mutateSettings(settings => { update(settings, change(read(settings))); }),
    notifyChatOptionsChanged: () => undefined,
  };
}

async function makeHost() {
  const fixture = await createProviderHostFixture();
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, fixture.settings, false);
  return {
    host: fixture.host, storage: fixture.settingsStorage,
    read: async () => JSON.parse(await fixture.vault.read(CLAUDIAN_SETTINGS_PATH)),
  };
}

beforeEach(() => {
  vi.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue();
});
afterEach(() => {
  for (const { id } of cases) ProviderWorkspaceRegistry.setServices(id, undefined);
  vi.restoreAllMocks();
});

it.each([false, true])('repairs saved Claude family aliases through startup discovery and reload (cached: %s)', async cached => {
  const { host, storage, read } = await makeHost();
  const rows = [
    { value: 'default', label: 'Default', description: '', resolvedModel: 'claude-opus-4-1-20250805[1m]', reasoningMetadataResolved: true },
    { value: 'claude-opus-4-20250514', label: 'Older Opus', description: '', reasoningMetadataResolved: true },
    { value: 'opus[1m]', label: 'Opus', description: '', resolvedModel: 'claude-opus-4-1-20250805[1m]', reasoningMetadataResolved: true },
    { value: 'claude-fable-5-2', label: 'Older Fable', description: '', reasoningMetadataResolved: true },
    { value: 'claude-fable-5-10', label: 'Fable', description: '', resolvedModel: 'claude-fable-5-10', reasoningMetadataResolved: true },
    { value: 'sonnet', label: 'Sonnet', description: '', reasoningMetadataResolved: true },
    { value: 'haiku', label: 'Haiku', description: '', reasoningMetadataResolved: true },
  ];
  updateClaudeProviderSettings(host.settings, {
    enabled: true,
    visibleModels: ['fable', 'haiku', 'opus', 'sonnet'],
    discoveredModels: cached ? rows : [],
    modelAliases: { fable: 'My Fable' },
  });
  await storage.save(host.settings);
  expect((await read()).providerConfigs.claude.selectedModels.map((model: { value: string }) => model.value))
    .toEqual(cached ? ['opus[1m]', 'claude-fable-5-10', 'sonnet', 'haiku'] : []);
  Object.assign(host.settings, await storage.load());
  const probe = vi.fn(async () => ({ models: rows, outputStyles: [] }));
  const claudeHost = host.getRuntimeHost('claude');
  const catalog = createClaudeModels(claudeHost, signal => discoverClaudeModels(claudeHost, signal, probe));
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: catalog });

  await migrateSelectedModelMetadata(host, new AbortController().signal);

  const expected = ['claude-fable-5-10', 'haiku', 'opus[1m]', 'sonnet'];
  expect((await read()).providerConfigs.claude.visibleModels).toEqual(expected);
  expect((await read()).providerConfigs.claude.selectedModels.map((model: { value: string }) => model.value))
    .toEqual(['opus[1m]', 'claude-fable-5-10', 'sonnet', 'haiku']);
  const restored = await storage.load();
  expect(getClaudeModelOptions(getClaudeModelSource(restored)).map(model => [model.value, model.label])).toEqual([
    ['claude-code/claude-fable-5-10', 'My Fable'], ['haiku', 'Haiku'],
    ['claude-code/opus[1m]', 'Opus'], ['sonnet', 'Sonnet'],
  ]);
  expect(findProviderModelOption('claude', 'opus', restored)).toBe('claude-code/opus[1m]');
  expect(findProviderModelOption('claude', 'fable', restored)).toBe('claude-code/claude-fable-5-10');
  Object.assign(host.settings, restored);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(probe).toHaveBeenCalledTimes(1);
  await catalog.dispose();
});

function catalogWith(overrides: Partial<import('@/core/providers/models/ProviderModelCatalog').ProviderModelCatalog>) {
  return Object.assign(new ProviderModelCatalogController({
    providerName: 'Test',
    store: {
      read: () => ({ enabled: true, models: [], selectedIds: [], aliases: {} }),
      write: async () => {}, notifyChatOptionsChanged: () => {},
    },
    discover: async () => ({ changed: false }),
  }), overrides);
}

it('keeps saved family aliases enabled after discovering a newer unselected version', async () => {
  const { host, storage } = await makeHost();
  await host.mutateSettings(settings => {
    settings.titleGenerationModel = 'fable';
    settings.lastSelectedChatModel = { providerId: 'claude', model: 'fable' };
    updateClaudeProviderSettings(settings, {
      enabled: true, visibleModels: ['fable'], discoveredModels: [],
    });
  });
  const selected = { value: 'claude-fable-5-10', label: 'Selected Fable', description: '', supportedEffortLevels: ['high'] as const };
  const probe = vi.fn()
    .mockResolvedValueOnce({ models: [selected], outputStyles: [] })
    .mockResolvedValueOnce({ models: [selected, {
      value: 'claude-fable-6-0', label: 'New Fable', description: '', resolvedModel: 'claude-fable-6-0', supportedEffortLevels: ['low'],
    }], outputStyles: [] });
  const claudeHost = host.getRuntimeHost('claude');
  const catalog = createClaudeModels(claudeHost, signal => discoverClaudeModels(claudeHost, signal, probe));
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: catalog });
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(ProviderRegistry.resolveTitleGenerationSelection(host.settings)?.model).toBe('claude-code/claude-fable-5-10');

  await catalog.refresh({ force: true });

  // Resolve references only after the second catalog has arrived, including unopened chats.
  for (const settings of [host.settings, await storage.load()]) {
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)).toEqual({
      providerId: 'claude', model: 'claude-code/claude-fable-5-10',
    });
    expect(resolveConversationModel(settings, 'claude', { selectedModel: 'fable' }).model)
      .toBe('claude-code/claude-fable-5-10');
    expect(resolveNewConversationModel(settings)?.model).toBe('claude-code/claude-fable-5-10');
    expect(ProviderRegistry.getModelPolicy('claude').normalizeModelVariant('fable', settings))
      .toBe('claude-code/claude-fable-5-10');
    expect(getClaudeSupportedEffortLevels(getClaudeModelSource(settings), 'fable')).toEqual(['high']);
    // A retired explicit ID follows the enabled family member.
    expect(findProviderModelOption('claude', 'claude-fable-4-0', settings)).toBe('claude-code/claude-fable-5-10');
  }
  // A reported but unselected ID stays unavailable; storage keeps only selected rows, so after
  // reload it is indistinguishable from a retired one until the next discovery.
  expect(findProviderModelOption('claude', 'claude-fable-6-0', host.settings)).toBeNull();
  expect(findProviderModelOption('claude', 'claude-fable-6-0', await storage.load())).toBe('claude-code/claude-fable-5-10');
  await catalog.changeSelection({ type: 'clear' });
  expect(ProviderRegistry.resolveTitleGenerationSelection(host.settings)).toBeNull();
  expect(findProviderModelOption('claude', 'fable', host.settings)).toBeNull();
  await catalog.dispose();
});

it.each(cases.flatMap(entry => [false, true].map(deselectDuringQuery => ({ ...entry, deselectDuringQuery }))))(
  '$id fills missing metadata and respects deselection during query: $deselectDuringQuery', async ({ id, populate, deselectDuringQuery }) => {
  const { host, storage, read } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selectedIds = [...config.visibleModels as string[]];
  const complete = structuredClone(host.settings);
  if (id === 'claude') (complete.providerConfigs.claude!.discoveredModels as Array<Record<string, unknown>>)[0].supportedEffortLevels = ['low', 'high'];
  if (id === 'opencode') complete.providerConfigs.opencode!.thinkingOptionsByModel = {
    [selectedIds[0]]: [{ value: 'high', label: 'High' }],
  };
  if (id === 'grok') {
    writeGrokCatalog(complete, { defaultModelId: selectedIds[0], fingerprint: 'test', refreshedAt: 1,
      models: [{ rawId: selectedIds[0], displayName: 'Selected', reasoningMetadataResolved: true,
        supportsReasoning: true, reasoningEfforts: [{ value: 'high', label: 'High' }] }] });
    writeGrokCatalog(host.settings, { defaultModelId: selectedIds[0], fingerprint: 'old', refreshedAt: 0, models: [] });
  } else config.discoveredModels = [];
  const discover = vi.fn(async () => {
    await host.mutateSettings(settings => {
      if (deselectDuringQuery) update[id](settings, { visibleModels: [] });
      const currentSelection = settings.providerConfigs[id]!.visibleModels;
      settings.providerConfigs[id] = { ...complete.providerConfigs[id], visibleModels: currentSelection };
    });
    return { changed: true };
  });
  const catalog = new ProviderModelCatalogController({
    providerName: id, discover,
    store: documentStore(host, settings => ({
      enabled: true, selectedIds: settings.providerConfigs[id]!.visibleModels as string[], models: [], aliases: {},
    }), (settings, patch) => update[id](settings, patch)),
  });
  ProviderWorkspaceRegistry.setServices(id, { modelCatalog: catalog });
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);

  await migrateSelectedModelMetadata(host, new AbortController().signal);

  expect(discover).toHaveBeenCalledTimes(1);
  expect((await read()).providerConfigs[id].visibleModels).toEqual(deselectDuringQuery ? [] : selectedIds);
  expect(JSON.stringify(await read())).not.toContain('unselected-catalog-entry');
  const restored = await storage.load();
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(restored)).toHaveLength(deselectDuringQuery ? 0 : 1);
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(restored)).toBe(false);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(discover).toHaveBeenCalledTimes(1);
  await catalog.dispose();
});

it.each([
  { label: 'enabled providers with no selected models', enabled: true, selected: false },
  { label: 'disabled providers with incomplete selected metadata', enabled: false, selected: true },
])('does not initialize $label', async ({ enabled, selected }) => {
  const { host } = await makeHost();
  updateClaudeProviderSettings(host.settings, {
    enabled, visibleModels: selected ? ['sonnet'] : [], discoveredModels: [],
  });
  expect(ProviderRegistry.isEnabled('claude', host.settings)).toBe(enabled);
  expect(ProviderRegistry.getSettingsStorageAdapter('claude').needsReasoningMetadata!(host.settings)).toBe(selected);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(ProviderWorkspaceRegistry.ensureInitialized).not.toHaveBeenCalled();
});

it.each(['deselected', 'disabled', 'cancelled'] as const)('rechecks %s state after workspace initialization', async change => {
  const { host } = await makeHost();
  cases[0].populate(host.settings);
  const controller = new AbortController();
  const refresh = vi.fn();
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: catalogWith({ refresh }) });
  vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation(async () => {
    if (change === 'deselected') updateClaudeProviderSettings(host.settings, { visibleModels: [] });
    if (change === 'disabled') updateClaudeProviderSettings(host.settings, { enabled: false });
    if (change === 'cancelled') controller.abort();
  });
  await migrateSelectedModelMetadata(host, controller.signal);
  expect(refresh).not.toHaveBeenCalled();
});

it('preserves incomplete selections after a failed query and retries on a later startup', async () => {
  const { host } = await makeHost();
  cases[0].populate(host.settings);
  const before = structuredClone(host.settings);
  const refresh = vi.fn().mockRejectedValue(new Error('CLI unavailable'));
  ProviderWorkspaceRegistry.setServices('claude', { modelCatalog: catalogWith({ refresh }) });
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(host.settings).toEqual(before);
});

it.each(cases)('$id detects missing effort fields in an otherwise present selected record', async ({ id, populate }) => {
  const { host } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  if (id === 'deepseek') delete (config.discoveredModels as Array<Record<string, unknown>>)[0].reasoning;
  if (id === 'codex') delete (config.discoveredModels as Array<Record<string, unknown>>)[0].supportedReasoningEfforts;
  if (id === 'pi') delete (config.discoveredModels as Array<Record<string, unknown>>)[0].thinkingLevels;
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});

it.each(cases)('$id detects a selected model missing from the catalog despite resolved effort metadata', async ({ id, populate }) => {
  const { host } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selected = (config.visibleModels as string[])[0];
  if (id === 'opencode') config.thinkingOptionsByModel = { [selected]: [] };
  if (id === 'grok') writeGrokCatalog(host.settings, { defaultModelId: selected, fingerprint: 'native', refreshedAt: 1, models: [] });
  else config.discoveredModels = [];
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});

it.each(['claude', 'grok', 'opencode', 'pi'] as const)('%s retains confirmed non-reasoning metadata without querying on every reload', async id => {
  const { host, storage } = await makeHost();
  cases.find(entry => entry.id === id)!.populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selected = (config.visibleModels as string[])[0];
  if (id === 'claude') Object.assign((config.discoveredModels as Array<Record<string, unknown>>)[0], {
    supportedEffortLevels: [], reasoningMetadataResolved: true,
  });
  if (id === 'pi') Object.assign((config.discoveredModels as Array<Record<string, unknown>>)[0], {
    thinkingLevels: ['off'], reasoning: false,
  });
  if (id === 'opencode') config.thinkingOptionsByModel = { [selected]: [] };
  if (id === 'grok') writeGrokCatalog(host.settings, {
    defaultModelId: selected, fingerprint: 'native', refreshedAt: 1,
    models: [{ rawId: selected, displayName: selected, reasoningEfforts: [], supportsReasoning: false, reasoningMetadataResolved: true }],
  });
  await storage.save(host.settings);
  const restored = await storage.load();
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(restored)).toBe(false);
});

it('cancels an active native query on unload', async () => {
  const { host } = await makeHost();
  cases[0].populate(host.settings);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const catalog = new ProviderModelCatalogController({
    providerName: 'Claude',
    store: documentStore(host, () => ({ enabled: true, selectedIds: ['sonnet'], models: [], aliases: {} }), vi.fn()),
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
