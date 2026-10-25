import { assertCatalogModelAvailable, modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderModelCatalog } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { createDeepSeekModels } from '@/providers/deepseek/runtime/DeepSeekModels';
import { createGrokModels } from '@/providers/grok/runtime/GrokModels';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { createPiModels } from '@/providers/pi/runtime/PiModels';

const mockPiDiscover = jest.fn();
jest.mock('@/providers/pi/runtime/PiModelDiscoveryService', () => ({
  PiModelDiscoveryService: class { discoverModels = mockPiDiscover; },
}));

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
  const host = runtimeHostFor({ settings, notifyProviderChatOptionsChanged: jest.fn() }, id, { persist });
  const discovery = jest.fn(async () => ({ changed: true, refreshed: true, kind: 'completed' as const, catalog: null, models: [], persistedSettingsChanged: false }));
  const warmModelsMetadata = jest.fn(async () => true);
  mockPiDiscover.mockResolvedValue({ kind: 'completed', models: read(settings) });
  const factories: Record<string, () => ProviderModelCatalog> = {
    deepseek: () => createDeepSeekModels(host, async () => { await discovery(); return { groups: [{ id: 'native', models: [{ id: 'selected', name: 'Selected label' }, { id: 'unselected-catalog-entry', name: 'Unselected' }] }] }; }),
    claude: () => createClaudeModels(host, discovery),
    codex: () => createCodexModels(host, { refresh: discovery }),
    grok: () => createGrokModels(host, { refresh: discovery }),
    opencode: () => createOpencodeModels(host, { discoverModels: discovery, warmModelsMetadata }),
    pi: () => createPiModels(host),
  };
  const catalog = factories[id]();
  const discoveredModels = structuredClone(read(settings));
  expect(catalog.getSnapshot().models.map(model => model.id)).toEqual(browseOrders[id]);
  expect(read(settings)).toEqual(discoveredModels);
  const selectedId = catalog.getSnapshot().selectedIds[0];
  expect(catalog.getSnapshot().defaultModelId).toBe(selectedId);
  expect(() => assertCatalogModelAvailable(id, settings, selected)).not.toThrow();
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
  expect(() => assertCatalogModelAvailable(id, settings, selected)).toThrow(ProviderModelUnavailableError);
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
  const host = runtimeHostFor({ settings: { providerConfigs: { opencode: {
    visibleModels: [], discoveredModels: [
      { rawId: 'anthropic/sonnet', label: 'Anthropic/Sonnet' },
      { rawId: 'openai/gpt', label: 'OpenAI/GPT' },
    ],
  } } } }, 'opencode');
  const catalog = createOpencodeModels(host, { discoverModels: jest.fn(), warmModelsMetadata: jest.fn() });
  expect(catalog.getSnapshot().models).toEqual([
    expect.objectContaining({ id: 'openai/gpt', name: 'GPT', providerKey: 'openai', providerLabel: 'OpenAI' }),
    expect.objectContaining({ id: 'anthropic/sonnet', name: 'Sonnet', providerKey: 'anthropic', providerLabel: 'Anthropic' }),
  ]);
});
