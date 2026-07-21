const mockGetCatalogFingerprint = jest.fn();
const mockDiscoverCatalog = jest.fn();

jest.mock('@/providers/grok/runtime/GrokModelCatalogService', () => ({
  GrokModelCatalogService: jest.fn().mockImplementation(() => ({
    discoverCatalog: mockDiscoverCatalog,
    getCatalogFingerprint: mockGetCatalogFingerprint,
  })),
}));

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
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/opt/grok/bin/grok'),
    mutateSettingsConditionally: jest.fn(async (mutation: (value: any) => boolean) => {
      await mutation(settings);
    }),
    refreshModelSelectors: jest.fn(),
    settings,
  };
}

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
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
    expect(services.tabWarmupPolicy?.resolveMode({} as any)).toBe('none');
    expect(services.runtimeCommandLoader).toBeUndefined();
    expect(services.agentMentionProvider).toBeUndefined();
    expect(services.mcpServerManager).toBeUndefined();
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

    await services.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    releaseRefresh({ kind: 'skipped', reason: 'provider-disabled' });
  });
});
