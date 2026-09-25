const mockDiscoverModels = jest.fn();
const mockNormalizeAllModelVariants = jest.fn().mockReturnValue(false);
const mockSkillBeginTransition = jest.fn();
const mockSkillQuiesce = jest.fn().mockResolvedValue(undefined);
const mockSkillEndTransition = jest.fn();
const mockSkillDispose = jest.fn().mockResolvedValue(undefined);

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

jest.mock('@/providers/codex/commands/CodexSkillCatalog', () => ({
  CodexSkillCatalog: jest.fn(),
}));

jest.mock('@/providers/codex/skills/CodexSkillListingService', () => ({
  CodexSkillListingService: jest.fn().mockImplementation(() => ({
    beginEnvironmentTransition: mockSkillBeginTransition,
    dispose: mockSkillDispose,
    endEnvironmentTransition: mockSkillEndTransition,
    quiesceForEnvironmentChange: mockSkillQuiesce,
  })),
}));

import { testClock } from '@test/helpers/testClock';

import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import type { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

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
    notifyProviderChatOptionsChanged: jest.fn(),
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(),
    },
    getResolvedProviderCliPath: jest.fn(),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    app: {
      vault: {
        adapter: { basePath: '/workspace' },
      },
      workspace: {
        onLayoutReady: jest.fn(),
      },
    },
  };
  plugin.unregisterTransitionHook = jest.fn();
  plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
    (_providerId: string, hook: {
      afterTransition(): void;
      beforeTransition(): Promise<void>;
    }) => {
      plugin.transitionHook = hook;
      return plugin.unregisterTransitionHook;
    },
  );
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

  it('defers discovery during initialization and persists an explicitly refreshed catalog', async () => {
    const plugin = createPlugin(true);
    const sol = makeDiscoveredModel('gpt-5.6-sol');
    mockDiscoverModels.mockResolvedValue({ kind: 'completed', models: [sol] });

    const services = await createCodexWorkspaceServices(plugin);

    expect(mockDiscoverModels).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.app.workspace.onLayoutReady).not.toHaveBeenCalled();

    await services.modelCatalog!.refresh({ force: true });

    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([sol]);
    expect(mockNormalizeAllModelVariants).toHaveBeenCalledWith(plugin.settings);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('persists and publishes selection normalization when the catalog is unchanged', async () => {
    const sol = makeDiscoveredModel('gpt-5.6-sol');
    const plugin = createPlugin(true, [sol]);
    mockDiscoverModels.mockResolvedValue({ kind: 'completed', models: [sol] });
    mockNormalizeAllModelVariants.mockReturnValue(false);
    const services = await createCodexWorkspaceServices(plugin);
    const now = testClock();
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now().getTime());

    try {
      await services.modelCatalog!.refresh({ force: true });
      expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([sol]);
      plugin.saveSettings.mockClear();
      plugin.notifyProviderChatOptionsChanged.mockClear();
      mockNormalizeAllModelVariants.mockClear();

      await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: false });
      expect(plugin.saveSettings).not.toHaveBeenCalled();
      expect(plugin.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();

      mockNormalizeAllModelVariants.mockReturnValueOnce(true);
      await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: true });
      expect(mockNormalizeAllModelVariants).toHaveBeenCalledTimes(2);
      expect(mockNormalizeAllModelVariants).toHaveBeenCalledWith(plugin.settings);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
      expect(plugin.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1);
      expect(plugin.notifyProviderChatOptionsChanged).toHaveBeenCalledWith('codex');
      expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([sol]);
    } finally {
      try {
        await services.dispose();
      } finally {
        dateNow.mockRestore();
      }
    }
  });

  it('does not discover or persist when the catalog is refreshed after workspace disposal', async () => {
    const plugin = createPlugin(true);
    mockDiscoverModels.mockResolvedValue({
      kind: 'completed',
      models: [makeDiscoveredModel('gpt-5.6-sol')],
    });
    const services = await createCodexWorkspaceServices(plugin);

    await services.dispose?.();
    await services.modelCatalog!.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));

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
    const services = await createCodexWorkspaceServices(plugin);

    expect(mockDiscoverModels).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();

    await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: false });
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([cached]);
    expect(mockDiscoverModels).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps the last successful catalog when a refresh fails', async () => {
    const cached = makeDiscoveredModel('gpt-5.5');
    const plugin = createPlugin(true, [cached]);
    mockDiscoverModels.mockResolvedValue({
      diagnostics: 'Method not found',
      kind: 'completed',
      models: [],
    });
    const services = await createCodexWorkspaceServices(plugin);

    await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({
      changed: false,
      diagnostics: 'Method not found',
    });
    expect(getCodexProviderSettings(plugin.settings).discoveredModels).toEqual([cached]);
  });

  it('preserves an explicit visibility filter when the catalog changes', async () => {
    const oldModel = makeDiscoveredModel('gpt-5.4');
    const currentModel = makeDiscoveredModel('gpt-5.5');
    const plugin = createPlugin(true, [oldModel, currentModel], ['gpt-5.4', 'gpt-5.5']);
    mockDiscoverModels.mockResolvedValue({ kind: 'completed', models: [currentModel] });
    const services = await createCodexWorkspaceServices(plugin);

    await services.modelCatalog!.refresh({ force: true });

    expect(getCodexProviderSettings(plugin.settings).visibleModels).toEqual(['gpt-5.4', 'gpt-5.5']);
  });

  it('registers one transition hook that awaits model and skill metadata quiescence', async () => {
    const plugin = createPlugin(false);
    let releaseModel!: () => void;
    let releaseSkills!: () => void;
    const modelQuiescence = new Promise<void>(resolve => { releaseModel = resolve; });
    const skillQuiescence = new Promise<void>(resolve => { releaseSkills = resolve; });
    const modelCatalogCoordinator = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
      endEnvironmentTransition: jest.fn(),
      quiesceForEnvironmentChange: jest.fn(() => modelQuiescence),
    };
    const skillListingService = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
      endEnvironmentTransition: jest.fn(),
      quiesceForEnvironmentChange: jest.fn(() => skillQuiescence),
    };
    await createCodexWorkspaceServices(plugin, {
      modelCatalogCoordinator: modelCatalogCoordinator as any,
      skillListingService: skillListingService as any,
    });

    expect(plugin.executionLifecycleRegistry.registerTransitionHook).toHaveBeenCalledWith(
      'codex',
      {
        afterTransition: expect.any(Function),
        beforeTransition: expect.any(Function),
      },
    );
    const transition = plugin.transitionHook.beforeTransition();
    let transitionSettled = false;
    void transition.then(() => { transitionSettled = true; });
    await Promise.resolve();

    expect(modelCatalogCoordinator.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(skillListingService.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(modelCatalogCoordinator.beginEnvironmentTransition).toHaveBeenCalledTimes(1);
    expect(skillListingService.beginEnvironmentTransition).toHaveBeenCalledTimes(1);
    expect(modelCatalogCoordinator.beginEnvironmentTransition.mock.invocationCallOrder[0])
      .toBeLessThan(modelCatalogCoordinator.quiesceForEnvironmentChange.mock.invocationCallOrder[0]);
    expect(skillListingService.beginEnvironmentTransition.mock.invocationCallOrder[0])
      .toBeLessThan(skillListingService.quiesceForEnvironmentChange.mock.invocationCallOrder[0]);
    expect(transitionSettled).toBe(false);

    releaseModel();
    await Promise.resolve();
    expect(transitionSettled).toBe(false);
    releaseSkills();
    await transition;
    plugin.transitionHook.afterTransition();
    expect(modelCatalogCoordinator.endEnvironmentTransition).toHaveBeenCalledTimes(1);
    expect(skillListingService.endEnvironmentTransition).toHaveBeenCalledTimes(1);
  });

  it('blocks metadata requested after beforeTransition until the new environment is active', async () => {
    const plugin = createPlugin(true);
    let environment = 'OLD_API_KEY=old';
    plugin.getActiveEnvironmentVariables.mockImplementation(() => environment);
    const observedModelEnvironments: string[] = [];
    const modelDiscovery = {
      discoverModels: jest.fn(async () => {
        observedModelEnvironments.push(plugin.getActiveEnvironmentVariables('codex'));
        return {
          kind: 'completed' as const,
          models: [makeDiscoveredModel('gpt-new-environment')],
        };
      }),
    };
    const modelCatalogCoordinator = new CodexModelCatalogCoordinator(
      plugin,
      modelDiscovery,
    );
    const { CodexSkillListingService: ActualCodexSkillListingService } = jest.requireActual(
      '@/providers/codex/skills/CodexSkillListingService',
    ) as { CodexSkillListingService: typeof CodexSkillListingService };
    const skillListingService = new ActualCodexSkillListingService(plugin, { ttlMs: 0 });
    const observedSkillEnvironments: string[] = [];
    jest.spyOn(skillListingService as any, 'fetchSkills').mockImplementation(async () => {
      observedSkillEnvironments.push(plugin.getActiveEnvironmentVariables('codex'));
      return [{
        name: 'new-environment-skill',
        path: '/vault/.agents/skills/new-environment-skill/SKILL.md',
        scope: 'repo',
        enabled: true,
      }];
    });
    const services = await createCodexWorkspaceServices(plugin, {
      modelCatalogCoordinator,
      skillListingService,
    });

    await plugin.transitionHook.beforeTransition();
    const modelRefresh = modelCatalogCoordinator.refresh();
    const skillListing = skillListingService.listSkills();
    let modelRefreshSettled = false;
    let skillListingSettled = false;
    void modelRefresh.then(() => { modelRefreshSettled = true; });
    void skillListing.then(() => { skillListingSettled = true; });
    try {
      await Promise.resolve();

      expect(modelDiscovery.discoverModels).not.toHaveBeenCalled();
      expect(observedSkillEnvironments).toEqual([]);

      environment = 'NEW_API_KEY=new';
      await modelCatalogCoordinator.refresh({ providerTransitionOwner: true });
      expect(observedModelEnvironments).toEqual(['NEW_API_KEY=new']);
      expect(observedSkillEnvironments).toEqual([]);
      expect(modelRefreshSettled).toBe(false);
      expect(skillListingSettled).toBe(false);

      plugin.transitionHook.afterTransition();
      await Promise.all([modelRefresh, skillListing]);
    } finally {
      plugin.transitionHook.afterTransition();
      await Promise.allSettled([modelRefresh, skillListing]);
      await services.dispose();
    }

    expect(observedModelEnvironments).toEqual(['NEW_API_KEY=new', 'NEW_API_KEY=new']);
    expect(observedSkillEnvironments).toEqual(['NEW_API_KEY=new']);
  });

  it('unregisters its hook and awaits both metadata owners during disposal', async () => {
    const plugin = createPlugin(false);
    let releaseModel!: () => void;
    let releaseSkills!: () => void;
    const modelDisposal = new Promise<void>(resolve => { releaseModel = resolve; });
    const skillDisposal = new Promise<void>(resolve => { releaseSkills = resolve; });
    const modelCatalogCoordinator = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn(() => modelDisposal),
      endEnvironmentTransition: jest.fn(),
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    const skillListingService = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn(() => skillDisposal),
      endEnvironmentTransition: jest.fn(),
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    const services = await createCodexWorkspaceServices(plugin, {
      modelCatalogCoordinator: modelCatalogCoordinator as any,
      skillListingService: skillListingService as any,
    });

    const disposal = services.dispose();
    expect(services.dispose()).toBe(disposal);
    let disposalSettled = false;
    void disposal.then(() => { disposalSettled = true; });
    await Promise.resolve();

    expect(plugin.unregisterTransitionHook).toHaveBeenCalledTimes(1);
    expect(modelCatalogCoordinator.dispose).toHaveBeenCalledTimes(1);
    expect(skillListingService.dispose).toHaveBeenCalledTimes(1);
    expect(disposalSettled).toBe(false);

    releaseModel();
    await Promise.resolve();
    expect(disposalSettled).toBe(false);
    releaseSkills();
    await disposal;
    expect(plugin.unregisterTransitionHook).toHaveBeenCalledTimes(1);
    expect(modelCatalogCoordinator.dispose).toHaveBeenCalledTimes(1);
    expect(skillListingService.dispose).toHaveBeenCalledTimes(1);
  });
});
