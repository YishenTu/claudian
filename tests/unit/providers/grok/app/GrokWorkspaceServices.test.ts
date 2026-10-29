const mockDiscoverCatalog = vi.fn();

vi.mock('@/providers/grok/runtime/GrokModelDiscoveryService', () => ({
  GrokModelDiscoveryService: vi.fn().mockImplementation(function () { return ({
    discoverCatalog: mockDiscoverCatalog,
  }); }),
}));

import { withRuntimeHosts } from '@test/helpers/providerRuntimeHost';

import { GrokCommandLoader } from '@/providers/grok/app/GrokCommandLoader';
import { GrokCommandMetadataProbe } from '@/providers/grok/app/GrokCommandMetadataProbe';
import {
  createGrokWorkspaceServices,
  grokWorkspaceRegistration,
} from '@/providers/grok/app/GrokWorkspaceServices';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import { GrokCLIResolver } from '@/providers/grok/runtime/GrokCLIResolver';
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
  return withRuntimeHosts({
    workingDirectory: '/tmp/grok-workspace',
    executionLifecycleRegistry: {
      registerTransitionHook: vi.fn(() => vi.fn()),
    },
    getResolvedProviderCliPath: vi.fn().mockResolvedValue('/opt/grok/bin/grok'),
    notifyProviderChatOptionsChanged: vi.fn(),
    settings,
  });
}

vi.mock('@/core/device/InstallationKey', async () => ({
  ...(await vi.importActual<typeof import('@/core/device/InstallationKey')>('@/core/device/InstallationKey')),
  getInstallationKey: () => 'device:current',
}));

describe('GrokWorkspaceServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(services.cliResolver).toBeInstanceOf(GrokCLIResolver);
    expect(services.commandCatalog).toBeInstanceOf(GrokCommandCatalog);
    expect(services.settingsTabRenderer).toBe(grokSettingsTabRenderer);
    expect(services.commandLoader).toBeInstanceOf(GrokCommandLoader);
    expect(services).not.toHaveProperty('beginAuxiliaryServicesEnvironmentChange');
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
  });

  it('exposes cached catalog state and performs explicit refresh through the coordinator', async () => {
    const services = await createGrokWorkspaceServices(createPlugin());

    expect(services.modelCatalogCoordinator.getCachedCatalog()).toEqual(
      expect.objectContaining({ fingerprint: 'cached-fingerprint' }),
    );
    await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({
      changed: false,
      diagnostics: undefined,
    });
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('disposes its explicitly requested catalog discovery', async () => {
    let releaseRefresh!: (value: unknown) => void;
    mockDiscoverCatalog.mockReturnValue(new Promise(resolve => { releaseRefresh = resolve; }));
    const services = await createGrokWorkspaceServices(createPlugin());
    const dispose = vi.spyOn(services.modelCatalogCoordinator, 'dispose');

    const refresh = services.modelCatalog!.refresh();
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);

    const disposing = services.dispose();
    releaseRefresh({ kind: 'skipped', reason: 'provider-disabled' });
    await disposing;
    await refresh;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('registers a transition hook that drains model probes and unregisters on dispose', async () => {
    const plugin = createPlugin();
    const unregister = vi.fn();
    const commandMetadataProbe = {
      beginEnvironmentTransition: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      endEnvironmentTransition: vi.fn(),
      load: vi.fn(),
      quiesceForEnvironmentChange: vi.fn().mockResolvedValue(undefined),
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
    const quiesce = vi.spyOn(
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
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(commandMetadataProbe.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(commandMetadataProbe.dispose).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('fences command and model metadata behind one workspace transition hook', async () => {
    const plugin = createPlugin();
    let cliPath = '/configured/grok-a';
    plugin.getResolvedProviderCliPath.mockImplementation(async () => cliPath);
    const nativeCreate = vi.fn((options: any) => ({
      cancel: vi.fn(),
      initialize: vi.fn(async () => undefined),
      listCommands: vi.fn(async () => [{
        content: '',
        id: `grok:${options.command}`,
        kind: 'command' as const,
        name: `from-${options.command}`,
        source: 'sdk' as const,
      }]),
      loadSession: vi.fn(),
      newSession: vi.fn(),
      onNotification: vi.fn(() => vi.fn()),
      prompt: vi.fn(),
      setMode: vi.fn(),
      setModel: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    }));
    const commandMetadataProbe = new GrokCommandMetadataProbe(
      plugin.getRuntimeHost('grok'),
      { create: nativeCreate },
    );
    let hook!: {
      afterTransition(): Promise<void>;
      beforeTransition(): Promise<void>;
    };
    plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
      (_providerId: string, registeredHook: typeof hook) => {
        hook = registeredHook;
        return vi.fn();
      },
    );
    const services = await createGrokWorkspaceServices(plugin, {
      commandMetadataProbe,
    });

    await hook.beforeTransition();
    const settingsBeforeFencedWork = structuredClone(plugin.settings);
    const commandLoad = services.commandLoader!.loadCommands({
      allowIsolatedMetadataCreation: true,
      conversation: null,
      plugin,
    });
    const ensure = services.modelCatalogCoordinator.refresh();
    const refresh = services.modelCatalogCoordinator.refresh();
    const liveMerge = services.modelCatalogCoordinator.mergeLiveModels([{
      displayName: 'Live B',
      rawId: 'live-b',
      reasoningEfforts: [],
      supportsReasoning: false,
    }]);
    await Promise.resolve();

    expect(nativeCreate).not.toHaveBeenCalled();
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
    expect(plugin.settings).toEqual(settingsBeforeFencedWork);

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
