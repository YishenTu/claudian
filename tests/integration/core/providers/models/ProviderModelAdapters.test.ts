import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderModelCatalog } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { assertClaudeModelAvailable } from '@/providers/claude/runtime/ClaudeModelAvailability';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
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

const assertions = { claude: assertClaudeModelAvailable, codex: assertCodexModelAvailable, grok: assertGrokModelAvailable, opencode: assertOpencodeModelAvailable, pi: assertPiModelAvailable };

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
    claude: () => createClaudeModels(host, { refresh: discovery }),
    codex: () => createCodexModels(host, { refresh: discovery }),
    grok: () => createGrokModels(host, { refresh: discovery }),
    opencode: () => createOpencodeModels(host, { discoverModels: async () => { await discovery(); return true; }, warmModelsMetadata }),
    pi: () => createPiModels(host),
  };
  const catalog = factories[id]();
  const selectedId = catalog.getSnapshot().selectedIds[0];
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
  await catalog.setAliases({ [selectedId]: 'My selected model' });
  expect(catalog.getSnapshot().aliases[selectedId]).toBe('My selected model');
  await catalog.select([]);
  expect(catalog.getSnapshot().selectedIds).toEqual([]);
  expect(() => assertions[id](settings, selected)).toThrow(ProviderModelUnavailableError);
  await catalog.select([selectedId]);
  expect(warmModelsMetadata.mock.calls).toEqual(id === 'opencode'
    ? [[[]], [[selected]]] : []);
  const before = structuredClone(settings);
  persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(catalog.select([])).rejects.toThrow('disk full');
  expect(settings).toEqual(before);
  expect(catalog.getSnapshot().selectedIds).toEqual([selectedId]);
  await catalog.dispose();
});

it('preserves OpenCode provider labels for catalog filtering', () => {
  const host = { settings: { providerConfigs: { opencode: {
    visibleModels: [], discoveredModels: [
      { rawId: 'anthropic/sonnet', label: 'Anthropic/Sonnet' },
      { rawId: 'openai/gpt', label: 'OpenAI/GPT' },
    ],
  } } } } as unknown as ProviderHost;
  const catalog = createOpencodeModels(host, { discoverModels: jest.fn(), warmModelsMetadata: jest.fn() });
  expect(catalog.getSnapshot().models).toEqual([
    expect.objectContaining({ id: 'anthropic/sonnet', name: 'Sonnet', providerKey: 'anthropic', providerLabel: 'Anthropic' }),
    expect.objectContaining({ id: 'openai/gpt', name: 'GPT', providerKey: 'openai', providerLabel: 'OpenAI' }),
  ]);
});
