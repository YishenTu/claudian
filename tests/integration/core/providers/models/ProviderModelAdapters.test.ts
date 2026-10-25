import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { createTestRuntimeHost } from '@test/helpers/providerRuntimeHost';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { createProviderRuntimeHost } from '@/composition/ClaudianProviderHost';
import type { ProviderModelCatalog } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { assertClaudeModelAvailable } from '@/providers/claude/runtime/ClaudeModelAvailability';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { assertDeepSeekModelAvailable, createDeepSeekModels } from '@/providers/deepseek/runtime/DeepSeekModels';
import { assertGrokModelAvailable } from '@/providers/grok/runtime/GrokModelAvailability';
import { createGrokModels } from '@/providers/grok/runtime/GrokModels';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { assertPiModelAvailable } from '@/providers/pi/runtime/PiModelAvailability';
import { createPiModels } from '@/providers/pi/runtime/PiModels';

const mockPiDiscover = jest.fn();
jest.mock('@/providers/pi/runtime/PiModelDiscoveryService', () => ({
  PiModelDiscoveryService: class { discoverModels = mockPiDiscover; },
}));

const assertions = { deepseek: (settings: Record<string, unknown>, model: string | undefined) => assertDeepSeekModelAvailable(createTestRuntimeHost(settings, 'deepseek'), model), claude: (settings: Record<string, unknown>, model: string | undefined) => assertClaudeModelAvailable(createTestRuntimeHost(settings, 'claude'), model), codex: (settings: Record<string, unknown>, model: string | undefined) => assertCodexModelAvailable(createTestRuntimeHost(settings, 'codex'), model), grok: (settings: Record<string, unknown>, model: string | undefined) => assertGrokModelAvailable(createTestRuntimeHost(settings, 'grok'), model), opencode: (settings: Record<string, unknown>, model: string | undefined) => assertOpencodeModelAvailable(createTestRuntimeHost(settings, 'opencode'), model),
  pi: (settings: Record<string, unknown>, model: string | undefined) => assertPiModelAvailable(createTestRuntimeHost(settings, 'pi'), model) };

const browseOrders = {
  deepseek: ['deepseek:native/selected', 'deepseek:native/unselected-catalog-entry'],
  claude: ['sonnet', 'unselected-catalog-entry'],
  codex: ['gpt-5.5', 'unselected-catalog-entry'],
  grok: ['selected', 'unselected-catalog-entry'],
  opencode: ['unselected-catalog-entry', 'anthropic/selected'],
  pi: ['pi:anthropic/unselected-catalog-entry', 'pi:anthropic/selected'],
};

it.each(modelCatalogCases)('$id keeps native selection, aliases and metadata behind the common catalog', async ({id, selected, populate, read}) => {
  const settings: Record<string, unknown> = {};
  populate(settings);
  const persist = jest.fn(async () => undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = { settings, mutateSettings: coordinator.mutate.bind(coordinator), mutateSettingsConditionally: coordinator.mutateConditionally.bind(coordinator), notifyProviderChatOptionsChanged: jest.fn() } as unknown as ProviderHost;
  const discovery = jest.fn(async () => ({ changed: true, refreshed: true, kind: 'completed' as const, catalog: null, models: [], persistedSettingsChanged: false }));
  const warmModelsMetadata = jest.fn(async () => true);
  mockPiDiscover.mockResolvedValue({ kind: 'completed', models: read(settings) });
  const factories: Record<string, () => ProviderModelCatalog> = {
    deepseek: () => createDeepSeekModels(createProviderRuntimeHost(host, coordinator, 'deepseek'), async () => { await discovery(); return { groups: [{ id: 'native', models: [{ id: 'selected', name: 'Selected label' }, { id: 'unselected-catalog-entry', name: 'Unselected' }] }] }; }),
    claude: () => createClaudeModels(createProviderRuntimeHost(host, coordinator, 'claude'), discovery),
    codex: () => createCodexModels(createProviderRuntimeHost(host, coordinator, 'codex'), { refresh: discovery }),
    grok: () => createGrokModels(createProviderRuntimeHost(host, coordinator, 'grok'), { refresh: discovery }),
    opencode: () => createOpencodeModels(createProviderRuntimeHost(host, coordinator, 'opencode'), { discoverModels: discovery, warmModelsMetadata }),
    pi: () => createPiModels(createProviderRuntimeHost(host, coordinator, 'pi')),
  };
  const catalog = factories[id]();
  const discoveredModels = structuredClone(read(settings));
  expect(catalog.getSnapshot().models.map(model => model.id)).toEqual(browseOrders[id]);
  expect(read(settings)).toEqual(discoveredModels);
  const selectedId = catalog.getSnapshot().selectedIds[0];
  expect(catalog.getSnapshot().defaultModelId).toBe(selectedId);
  expect(() => assertions[id](settings, selected)).not.toThrow();
  await catalog.refresh();
  const discover = id === 'pi' ? mockPiDiscover : discovery;
  const calls = discover.mock.calls.length;
  catalog.markStale();
  await catalog.refresh();
  expect(discover).toHaveBeenCalledTimes(calls);
  expect(catalog.getSnapshot()).toMatchObject({ stale: true, discoveredCount: 2, selectedIds: [selectedId] });
  await catalog.refresh({ force: true });
  expect(discover).toHaveBeenCalledTimes(calls + 1);
  await catalog.setAlias(selectedId, 'My selected model');
  expect(catalog.getSnapshot().aliases[selectedId]).toBe('My selected model');
  await catalog.changeSelection({ type: 'clear' });
  expect(catalog.getSnapshot().selectedIds).toEqual([]);
  expect(() => assertions[id](settings, selected)).toThrow(ProviderModelUnavailableError);
  await catalog.changeSelection({ type: 'set', modelId: selectedId, selected: true });
  expect(warmModelsMetadata.mock.calls).toEqual(id === 'opencode'
    ? [[[]], [[selected]]] : []);
  const before = structuredClone(settings);
  persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(catalog.changeSelection({ type: 'clear' })).rejects.toThrow('disk full');
  expect(settings).toEqual(before);
  expect(catalog.getSnapshot().selectedIds).toEqual([selectedId]);
  await catalog.dispose();
});

it('preserves OpenCode provider labels for catalog filtering', () => {
  const host = createTestRuntimeHost({ providerConfigs: { opencode: {
    visibleModels: [], discoveredModels: [
      { rawId: 'anthropic/sonnet', label: 'Anthropic/Sonnet' },
      { rawId: 'openai/gpt', label: 'OpenAI/GPT' },
    ],
  } } }, 'opencode');
  const catalog = createOpencodeModels(host, { discoverModels: jest.fn(), warmModelsMetadata: jest.fn() });
  expect(catalog.getSnapshot().models).toEqual([
    expect.objectContaining({ id: 'openai/gpt', name: 'GPT', providerKey: 'openai', providerLabel: 'OpenAI' }),
    expect.objectContaining({ id: 'anthropic/sonnet', name: 'Sonnet', providerKey: 'anthropic', providerLabel: 'Anthropic' }),
  ]);
});
