const mockRuntimeBehavior: {
  discoveredModels: Array<{ label: string; rawId: string }>;
  ensureReadyResult: boolean | Error;
} = {
  discoveredModels: [],
  ensureReadyResult: true,
};
const mockCreatedRuntimes: Array<{
  cleanup: jest.Mock;
  ensureReady: jest.Mock;
  getDiscoveredModels: jest.Mock;
}> = [];

jest.mock('@/providers/kimi/runtime/KimiChatRuntime', () => ({
  KimiChatRuntime: jest.fn().mockImplementation(() => {
    const runtime = {
      cleanup: jest.fn(),
      ensureReady: jest.fn(() => {
        if (mockRuntimeBehavior.ensureReadyResult instanceof Error) {
          return Promise.reject(mockRuntimeBehavior.ensureReadyResult);
        }
        return Promise.resolve(mockRuntimeBehavior.ensureReadyResult);
      }),
      getDiscoveredModels: jest.fn(() => mockRuntimeBehavior.discoveredModels),
    };
    mockCreatedRuntimes.push(runtime);
    return runtime;
  }),
}));

import { refreshKimiModelCatalog } from '@/providers/kimi/app/KimiModelCatalogRefresh';
import { getKimiDiscoveryState } from '@/providers/kimi/discoveryState';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

const CATALOG = [
  { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
  { label: 'K2', rawId: 'kimi-k2' },
];

function createMockPlugin(enabled = true): any {
  const plugin: any = {
    notifyProviderChatOptionsChanged: jest.fn(),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    settings: {
      providerConfigs: {
        kimi: { enabled },
      },
    },
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

describe('refreshKimiModelCatalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatedRuntimes.length = 0;
    mockRuntimeBehavior.discoveredModels = [...CATALOG];
    mockRuntimeBehavior.ensureReadyResult = true;
  });

  it('mirrors and persists a freshly discovered catalog', async () => {
    const plugin = createMockPlugin();

    const result = await refreshKimiModelCatalog(plugin);

    expect(result).toEqual({ changed: true, persistedSettingsChanged: true });
    expect(getKimiDiscoveryState(plugin.settings).discoveredModels).toEqual(CATALOG);
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(CATALOG);
    expect(plugin.notifyProviderChatOptionsChanged).toHaveBeenCalledWith('kimi');
    expect(mockCreatedRuntimes[0].ensureReady).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalled();
  });

  it('reports no change when the catalog is already current', async () => {
    const plugin = createMockPlugin();
    await refreshKimiModelCatalog(plugin);
    plugin.notifyProviderChatOptionsChanged.mockClear();

    const result = await refreshKimiModelCatalog(plugin);

    expect(result).toEqual({ changed: false });
    expect(plugin.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
  });

  it('keeps the old catalog when the runtime cannot start', async () => {
    const plugin = createMockPlugin();
    await refreshKimiModelCatalog(plugin);
    mockRuntimeBehavior.ensureReadyResult = false;

    const result = await refreshKimiModelCatalog(plugin);

    expect(result.changed).toBe(false);
    expect(result.diagnostics).toBeTruthy();
    expect(getKimiDiscoveryState(plugin.settings).discoveredModels).toEqual(CATALOG);
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(CATALOG);
  });

  it('keeps the old catalog when discovery returns no models', async () => {
    const plugin = createMockPlugin();
    await refreshKimiModelCatalog(plugin);
    mockRuntimeBehavior.discoveredModels = [];

    const result = await refreshKimiModelCatalog(plugin);

    expect(result.changed).toBe(false);
    expect(result.diagnostics).toBeTruthy();
    expect(getKimiDiscoveryState(plugin.settings).discoveredModels).toEqual(CATALOG);
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(CATALOG);
  });

  it('keeps the old catalog when discovery throws', async () => {
    const plugin = createMockPlugin();
    await refreshKimiModelCatalog(plugin);
    mockRuntimeBehavior.ensureReadyResult = new Error('spawn failed');

    const result = await refreshKimiModelCatalog(plugin);

    expect(result.changed).toBe(false);
    expect(result.diagnostics).toContain('spawn failed');
    expect(getKimiProviderSettings(plugin.settings).discoveredModels).toEqual(CATALOG);
    expect(mockCreatedRuntimes[1].cleanup).toHaveBeenCalled();
  });

  it('skips discovery while the provider is disabled', async () => {
    const plugin = createMockPlugin(false);

    const result = await refreshKimiModelCatalog(plugin);

    expect(result).toEqual({ changed: false });
    expect(mockCreatedRuntimes).toHaveLength(0);
  });
});
