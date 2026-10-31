import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { createCodexModelCatalogCommit } from '@/providers/codex/app/CodexWorkspaceServices';
import { DEFAULT_CODEX_PROVIDER_SETTINGS } from '@/providers/codex/config';
import type { CodexDiscoveredModel } from '@/providers/codex/models';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import type {
  CodexModelDiscoveryResult,
  CodexModelDiscoveryServiceLike,
} from '@/providers/codex/runtime/CodexModelDiscoveryService';

function makeModel(model: string, displayName = model): CodexDiscoveredModel {
  return {
    model,
    displayName,
    description: `${model} description`,
    supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
    defaultServiceTier: null,
    inputModalities: ['text', 'image'],
    isDefault: false,
  };
}

describe('Startup optimization', () => {
  beforeEach(() => {
    StartupProfiler.reset();
    ProviderWorkspaceRegistry.clear();
  });

  afterEach(async () => {
    await ProviderWorkspaceRegistry.disposeInitialized();
    ProviderWorkspaceRegistry.clear();
    StartupProfiler.reset();
  });

  it('initializes the workspace without discovering Codex models until explicit refresh', async () => {
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: vi.fn(async () => ({
        kind: 'completed',
        models: [makeModel('gpt-4o')],
      } as CodexModelDiscoveryResult)),
    };

    let catalog!: CodexModelCatalogCoordinator;
    ProviderWorkspaceRegistry.register('codex', {
      initialize: async ({ plugin }) => {
        catalog = new CodexModelCatalogCoordinator(
          plugin.getRuntimeHost('codex'), discovery, createCodexModelCatalogCommit(plugin),
        );
        return { dispose: () => catalog.dispose() };
      },
    });

    const { host } = await createProviderHostFixture({
      settings: { providerConfigs: { codex: { ...DEFAULT_CODEX_PROVIDER_SETTINGS, enabled: true } } },
      overrides: { getResolvedProviderCliPath: async () => '/usr/bin/codex' },
    });
    const initPromise = ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'startup-test');
    expect(discovery.discoverModels).not.toHaveBeenCalled();

    await initPromise;
    expect(discovery.discoverModels).not.toHaveBeenCalled();
    const report = StartupProfiler.getReport();
    expect(report.spans.some((span) => span.name === 'provider-init:codex')).toBe(true);

    await catalog.refresh();
    expect(discovery.discoverModels).toHaveBeenCalledTimes(1);
  });
});
