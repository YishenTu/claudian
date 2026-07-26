const mockRuntimeBehavior: {
  discoveredModels: Array<{ label: string; rawId: string }>;
  ensureReadyResult: boolean | Error;
  probeResult: {
    currentThinkingByModel: Record<string, string>;
    failedRawIds: string[];
    noThinkingRawIds: string[];
    thinkingOptionsByModel: Record<string, Array<{ label: string; value: string }>>;
  };
} = {
  discoveredModels: [],
  ensureReadyResult: true,
  probeResult: {
    currentThinkingByModel: {},
    failedRawIds: [],
    noThinkingRawIds: [],
    thinkingOptionsByModel: {},
  },
};
const mockCreatedRuntimes: Array<{
  cleanup: jest.Mock;
  ensureReady: jest.Mock;
  getDiscoveredModels: jest.Mock;
  probeThinkingOptionsForModels: jest.Mock;
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
      probeThinkingOptionsForModels: jest.fn(() => Promise.resolve(mockRuntimeBehavior.probeResult)),
    };
    mockCreatedRuntimes.push(runtime);
    return runtime;
  }),
}));

import { refreshKimiModelCatalog } from '@/providers/kimi/app/KimiModelCatalogRefresh';
import { getKimiDiscoveryState } from '@/providers/kimi/discoveryState';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

const CATALOG = [
  { label: 'K2.7 Coding', rawId: 'kimi-code/kimi-for-coding' },
  { label: 'K2.7 Coding Highspeed', rawId: 'kimi-code/kimi-for-coding-highspeed' },
  { label: 'K3', rawId: 'kimi-code/k3' },
  { label: 'K3-256k', rawId: 'kimi-code/k3-256k' },
];

// Fixtures from a live kimi acp probe (CLI 0.29.0).
const CODING_THINKING_OPTIONS = [{ label: 'On', value: 'on' }];
const K3_THINKING_OPTIONS = [
  { label: 'Low', value: 'low' },
  { label: 'High', value: 'high' },
  { label: 'Max', value: 'max' },
];

function fullProbeResult(): typeof mockRuntimeBehavior.probeResult {
  return {
    currentThinkingByModel: {
      'kimi-code/kimi-for-coding': 'on',
      'kimi-code/kimi-for-coding-highspeed': 'on',
      'kimi-code/k3': 'high',
      'kimi-code/k3-256k': 'high',
    },
    failedRawIds: [],
    noThinkingRawIds: [],
    thinkingOptionsByModel: {
      'kimi-code/kimi-for-coding': CODING_THINKING_OPTIONS,
      'kimi-code/kimi-for-coding-highspeed': CODING_THINKING_OPTIONS,
      'kimi-code/k3': K3_THINKING_OPTIONS,
      'kimi-code/k3-256k': K3_THINKING_OPTIONS,
    },
  };
}

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
    mockRuntimeBehavior.probeResult = fullProbeResult();
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

  it('persists probed thinking options for every discovered model in one pass', async () => {
    const plugin = createMockPlugin();

    const result = await refreshKimiModelCatalog(plugin);

    expect(result).toEqual({ changed: true, persistedSettingsChanged: true });
    expect(mockCreatedRuntimes[0].probeThinkingOptionsForModels).toHaveBeenCalledWith(
      CATALOG.map((model) => model.rawId),
    );
    expect(getKimiProviderSettings(plugin.settings).thinkingOptionsByModel).toEqual(
      fullProbeResult().thinkingOptionsByModel,
    );
    expect(getKimiProviderSettings(plugin.settings).currentThinkingByModel).toEqual(
      fullProbeResult().currentThinkingByModel,
    );
    expect(getKimiDiscoveryState(plugin.settings).thinkingOptionsByModel).toEqual(
      fullProbeResult().thinkingOptionsByModel,
    );
    // One mirror + write-through for the whole batch.
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(1);
  });

  it('tolerates a per-model probe failure and keeps its existing entry', async () => {
    const plugin = createMockPlugin();
    plugin.settings.providerConfigs.kimi.thinkingOptionsByModel = {
      'kimi-code/kimi-for-coding-highspeed': [{ label: 'On', value: 'on' }],
    };
    plugin.settings.providerConfigs.kimi.currentThinkingByModel = {
      'kimi-code/kimi-for-coding-highspeed': 'on',
    };
    mockRuntimeBehavior.probeResult = {
      ...fullProbeResult(),
      failedRawIds: ['kimi-code/kimi-for-coding-highspeed'],
    };
    delete mockRuntimeBehavior.probeResult.thinkingOptionsByModel[
      'kimi-code/kimi-for-coding-highspeed'
    ];
    delete mockRuntimeBehavior.probeResult.currentThinkingByModel[
      'kimi-code/kimi-for-coding-highspeed'
    ];

    const result = await refreshKimiModelCatalog(plugin);

    expect(result.changed).toBe(true);
    expect(result.diagnostics).toContain('kimi-code/kimi-for-coding-highspeed');
    const persisted = getKimiProviderSettings(plugin.settings);
    expect(persisted.thinkingOptionsByModel['kimi-code/kimi-for-coding-highspeed']).toEqual([
      { label: 'On', value: 'on' },
    ]);
    expect(persisted.thinkingOptionsByModel['kimi-code/k3']).toEqual(K3_THINKING_OPTIONS);
    expect(persisted.currentThinkingByModel['kimi-code/kimi-for-coding-highspeed']).toBe('on');
  });

  it('removes the stale entry when a probed model advertises no thought level', async () => {
    const plugin = createMockPlugin();
    plugin.settings.providerConfigs.kimi.thinkingOptionsByModel = {
      'kimi-code/k3-256k': K3_THINKING_OPTIONS,
    };
    plugin.settings.providerConfigs.kimi.currentThinkingByModel = {
      'kimi-code/k3-256k': 'high',
    };
    mockRuntimeBehavior.probeResult = {
      ...fullProbeResult(),
      noThinkingRawIds: ['kimi-code/k3-256k'],
    };
    delete mockRuntimeBehavior.probeResult.thinkingOptionsByModel['kimi-code/k3-256k'];
    delete mockRuntimeBehavior.probeResult.currentThinkingByModel['kimi-code/k3-256k'];

    const result = await refreshKimiModelCatalog(plugin);

    expect(result.changed).toBe(true);
    expect(result.diagnostics).toBeUndefined();
    const persisted = getKimiProviderSettings(plugin.settings);
    expect(persisted.thinkingOptionsByModel['kimi-code/k3-256k']).toBeUndefined();
    expect(persisted.currentThinkingByModel['kimi-code/k3-256k']).toBeUndefined();
    expect(persisted.thinkingOptionsByModel['kimi-code/k3']).toEqual(K3_THINKING_OPTIONS);
  });

  it('reports no change when the catalog is already current', async () => {
    const plugin = createMockPlugin();
    await refreshKimiModelCatalog(plugin);
    plugin.notifyProviderChatOptionsChanged.mockClear();
    plugin.mutateSettings.mockClear();

    const result = await refreshKimiModelCatalog(plugin);

    expect(result).toEqual({ changed: false });
    expect(plugin.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
    expect(plugin.mutateSettings).not.toHaveBeenCalled();
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
