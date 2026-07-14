const mockDiscoverModels = jest.fn();
const mockLoadAgents = jest.fn().mockResolvedValue(undefined);
const mockNormalizeAllModelVariants = jest.fn().mockReturnValue(false);

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    normalizeAllModelVariants: (...args: unknown[]) => mockNormalizeAllModelVariants(...args),
  },
}));

jest.mock('@/providers/codex/runtime/CodexModelDiscoveryService', () => ({
  CodexModelDiscoveryService: jest.fn().mockImplementation(() => ({
    discoverModels: mockDiscoverModels,
  })),
}));

jest.mock('@/providers/codex/agents/CodexAgentMentionProvider', () => ({
  CodexAgentMentionProvider: jest.fn().mockImplementation(() => ({
    loadAgents: mockLoadAgents,
  })),
}));

jest.mock('@/providers/codex/commands/CodexSkillCatalog', () => ({
  CodexSkillCatalog: jest.fn(),
}));

jest.mock('@/providers/codex/skills/CodexSkillListingService', () => ({
  CodexSkillListingService: jest.fn(),
}));

jest.mock('@/providers/codex/storage/CodexSkillStorage', () => ({
  CodexSkillStorage: jest.fn(),
}));

jest.mock('@/providers/codex/storage/CodexSubagentStorage', () => ({
  CodexSubagentStorage: jest.fn(),
}));

import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';
import { getCodexProviderSettings } from '@/providers/codex/settings';

function makeDiscoveredModel(model: string) {
  return {
    model,
    displayName: model,
    description: `${model} description`,
    supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
    isDefault: true,
  };
}

function createPlugin(
  enabled: boolean,
  discoveredModels: unknown[] = [],
  visibleModels: string[] | null = null,
) {
  const plugin: any = {
    settings: {
      providerConfigs: {
        codex: {
          enabled,
          discoveredModels,
          visibleModels,
        },
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getResolvedProviderCliPath: jest.fn(),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    app: {
      vault: {
        adapter: { basePath: '/workspace' },
      },
    },
  };
  plugin.mutateSettingsConditionally = jest.fn(async (
    mutation: (settings: any) => boolean | Promise<boolean>,
  ) => {
    if (await mutation(plugin.settings)) {
      await plugin.saveSettings();
    }
  });
  return plugin;
}

describe('CodexWorkspaceServices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads the app-server catalog in memory without rewriting settings during startup', async () => {
    const plugin = createPlugin(true);
    const sol = makeDiscoveredModel('gpt-5.6-sol');
    mockDiscoverModels.mockResolvedValue({ kind: 'completed', models: [sol] });

    await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([sol]);
    expect(mockNormalizeAllModelVariants).toHaveBeenCalledWith(plugin.settings);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('persists a selection normalization caused by startup discovery', async () => {
    const plugin = createPlugin(true);
    mockDiscoverModels.mockResolvedValue({
      kind: 'completed',
      models: [makeDiscoveredModel('gpt-5.6-sol')],
    });
    mockNormalizeAllModelVariants.mockReturnValueOnce(true);

    await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('does not start app-server for a disabled provider', async () => {
    const plugin = createPlugin(false);

    await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    expect(mockDiscoverModels).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('treats a disabled catalog refresh as skipped without diagnostics', async () => {
    const cached = makeDiscoveredModel('gpt-5.5');
    const plugin = createPlugin(false, [cached]);
    mockDiscoverModels.mockResolvedValue({
      kind: 'skipped',
      reason: 'provider-disabled',
    });
    const services = await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    await expect(services.refreshModelCatalog!()).resolves.toEqual({ changed: false });
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([cached]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps the last successful catalog when a refresh fails', async () => {
    const cached = makeDiscoveredModel('gpt-5.5');
    const plugin = createPlugin(false, [cached]);
    mockDiscoverModels.mockResolvedValue({
      diagnostics: 'Method not found',
      kind: 'completed',
      models: [],
    });
    const services = await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    await expect(services.refreshModelCatalog!()).resolves.toEqual({
      changed: false,
      diagnostics: 'Method not found',
    });
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([cached]);
  });

  it('prunes an explicit visibility filter when the catalog changes', async () => {
    const oldModel = makeDiscoveredModel('gpt-5.4');
    const currentModel = makeDiscoveredModel('gpt-5.5');
    const plugin = createPlugin(false, [oldModel, currentModel], ['gpt-5.4', 'gpt-5.5']);
    mockDiscoverModels.mockResolvedValue({ kind: 'completed', models: [currentModel] });
    const services = await createCodexWorkspaceServices(plugin, {} as any, {} as any);

    await services.refreshModelCatalog!();

    expect(getCodexProviderSettings(plugin.settings).visibleModels).toEqual(['gpt-5.5']);
  });
});
