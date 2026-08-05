const mockGetCatalogFingerprint = jest.fn();
const mockDiscoverCatalog = jest.fn();

jest.mock('@/providers/grok/runtime/GrokModelCatalogService', () => ({
  GrokModelCatalogService: jest.fn().mockImplementation(() => ({
    discoverCatalog: mockDiscoverCatalog,
    getCatalogFingerprint: mockGetCatalogFingerprint,
  })),
}));

import { GrokCommandLoader } from '@/providers/grok/app/GrokCommandLoader';
import { GrokCommandMetadataProbe } from '@/providers/grok/app/GrokCommandMetadataProbe';
import {
  createGrokWorkspaceServices,
  grokWorkspaceRegistration,
} from '@/providers/grok/app/GrokWorkspaceServices';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import { GrokCliResolver } from '@/providers/grok/runtime/GrokCliResolver';
import { grokSettingsTabRenderer } from '@/providers/grok/ui/GrokSettingsTab';

function createPlugin(cached = true): any {
  const catalog = {
    defaultModelId: 'grok-4.5',
    fingerprint: 'cached-fingerprint',
    models: [{ displayName: 'Grok 4.5', rawId: 'grok-4.5' }],
    refreshedAt: Date.now(),
  };
  const settings = {
    providerConfigs: {
      grok: {
        catalogsByHost: cached ? { 'device:current': catalog } : {},
        enabled: true,
      },
    },
  };
  return {
    app: { vault: { adapter: { basePath: '/tmp/grok-workspace' } } },
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(() => jest.fn()),
    },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/opt/grok/bin/grok'),
    mutateSettingsConditionally: jest.fn(async (mutation: (value: any) => boolean) => {
      await mutation(settings);
    }),
    notifyProviderChatOptionsChanged: jest.fn(),
    settings,
  };
}

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
}));

describe('GrokWorkspaceServices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCatalogFingerprint.mockResolvedValue('cached-fingerprint');
    mockDiscoverCatalog.mockResolvedValue({
      defaultModelId: 'grok-4.5',
      fingerprint: 'fresh-fingerprint',
      kind: 'completed',
      models: [{ displayName: 'Grok 4.5', rawId: 'grok-4.5' }],
    });
  });

  it('initializes only workspace-owned services and never creates a warmup session', async () => {
    const plugin = createPlugin();
    const services = await grokWorkspaceRegistration.initialize({ plugin } as any);

    expect(services.cliResolver).toBeInstanceOf(GrokCliResolver);
    expect(services.commandCatalog).toBeInstanceOf(GrokCommandCatalog);
    expect(services.settingsTabRenderer).toBe(grokSettingsTabRenderer);
    expect(services.tabWarmupPolicy?.resolveMode({} as any)).toBe('commands');
    expect(services.commandLoader).toBeInstanceOf(GrokCommandLoader);
    expect(services.agentMentionProvider).toBeUndefined();
    expect(services.mcpServerManager).toBeUndefined();
    expect(services).not.toHaveProperty('beginAuxiliaryServicesEnvironmentChange');
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
  });

  it('exposes cached catalog state and performs explicit refresh through the coordinator', async () => {
    const services = await createGrokWorkspaceServices(createPlugin());

    expect(services.modelCatalogCoordinator.getCachedCatalog()).toEqual(
      expect.objectContaining({ fingerprint: 'cached-fingerprint' }),
    );
    await expect(services.refreshModelCatalog()).resolves.toEqual({
      changed: false,
      persistedSettingsChanged: true,
    });
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('uses stale-while-revalidate preparation and disposes its catalog owner', async () => {
    let releaseRefresh!: (value: unknown) => void;
    mockGetCatalogFingerprint.mockResolvedValue('changed-fingerprint');
    mockDiscoverCatalog.mockReturnValue(new Promise(resolve => { releaseRefresh = resolve; }));
    const services = await createGrokWorkspaceServices(createPlugin());
    const dispose = jest.spyOn(services.modelCatalogCoordinator, 'dispose');

    await services.prepareSettings();
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);

    const disposing = services.dispose();
    releaseRefresh({ kind: 'skipped', reason: 'provider-disabled' });
    await disposing;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('registers a transition hook that drains model probes and unregisters on dispose', async () => {
    const plugin = createPlugin();
    const unregister = jest.fn();
    const commandMetadataProbe = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
      endEnvironmentTransition: jest.fn(),
      load: jest.fn(),
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    let hook: {
      afterTransition(): Promise<void>;
      beforeTransition(): Promise<void>;
    } | undefined;
    plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
      (_providerId: string, registeredHook: typeof hook) => {
        hook = registeredHook;
        return unregister;
      },
    );
    const services = await createGrokWorkspaceServices(plugin, {
      commandMetadataProbe: commandMetadataProbe as any,
    });
    const quiesce = jest.spyOn(
      services.modelCatalogCoordinator,
      'quiesceForEnvironmentChange',
    ).mockResolvedValue();

    await hook?.beforeTransition();
    await services.dispose();

    expect(plugin.executionLifecycleRegistry.registerTransitionHook).toHaveBeenCalledWith(
      'grok',
      {
        afterTransition: expect.any(Function),
        beforeTransition: expect.any(Function),
      },
    );
    expect(quiesce).toHaveBeenCalledTimes(2);
    expect(commandMetadataProbe.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(commandMetadataProbe.dispose).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('fences command and model metadata behind one workspace transition hook', async () => {
    const plugin = createPlugin();
    let cliPath = '/configured/grok-a';
    plugin.getResolvedProviderCliPath.mockImplementation(async () => cliPath);
    const nativeCreate = jest.fn((options: any) => ({
      cancel: jest.fn(),
      initialize: jest.fn(async () => undefined),
      listCommands: jest.fn(async () => [{
        content: '',
        id: `grok:${options.command}`,
        kind: 'command' as const,
        name: `from-${options.command}`,
        source: 'sdk' as const,
      }]),
      loadSession: jest.fn(),
      newSession: jest.fn(),
      onNotification: jest.fn(() => jest.fn()),
      prompt: jest.fn(),
      setMode: jest.fn(),
      setModel: jest.fn(),
      shutdown: jest.fn(async () => undefined),
    }));
    const commandMetadataProbe = new GrokCommandMetadataProbe(
      plugin,
      { create: nativeCreate },
    );
    let hook!: {
      afterTransition(): Promise<void>;
      beforeTransition(): Promise<void>;
    };
    plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
      (_providerId: string, registeredHook: typeof hook) => {
        hook = registeredHook;
        return jest.fn();
      },
    );
    const services = await createGrokWorkspaceServices(plugin, {
      commandMetadataProbe,
    });

    await hook.beforeTransition();
    plugin.mutateSettingsConditionally.mockClear();
    const commandLoad = services.commandLoader!.loadCommands({
      allowIsolatedMetadataCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin,
    });
    const ensure = services.modelCatalogCoordinator.ensureFresh('settings');
    const refresh = services.modelCatalogCoordinator.refresh();
    const liveMerge = services.modelCatalogCoordinator.mergeLiveModels([{
      displayName: 'Live B',
      rawId: 'live-b',
      reasoningEfforts: [],
      supportsReasoning: false,
    }]);
    await Promise.resolve();

    expect(nativeCreate).not.toHaveBeenCalled();
    expect(mockGetCatalogFingerprint).not.toHaveBeenCalled();
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
    expect(plugin.mutateSettingsConditionally).not.toHaveBeenCalled();

    cliPath = '/configured/grok-b';
    plugin.settings.providerConfigs.grok.environmentVariables = 'GROK_PROFILE=b';
    await hook.afterTransition();
    await expect(commandLoad).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'from-/configured/grok-b' })],
      status: 'ready',
    });
    await Promise.all([ensure, refresh, liveMerge]);
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(nativeCreate.mock.calls[0][0]).toMatchObject({
      command: '/configured/grok-b',
    });
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);

    await services.dispose();
  });
});
