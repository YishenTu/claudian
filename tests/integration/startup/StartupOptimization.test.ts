import { StartupProfiler } from '@/core/performance/StartupProfiler';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderWorkspaceServices } from '@/core/providers/types';
import type { CodexDiscoveredModel } from '@/providers/codex/models';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import type {
  CodexModelDiscoveryResult,
  CodexModelDiscoveryServiceLike,
} from '@/providers/codex/runtime/CodexModelDiscoveryService';
import { DEFAULT_CODEX_PROVIDER_SETTINGS } from '@/providers/codex/settings';

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

function createFakeHost(): ProviderHost {
  return {
    app: {
      vault: { adapter: { basePath: '/vault' } },
      workspace: {
        onLayoutReady: jest.fn(),
      },
    },
    settings: {
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
        },
      },
      environmentVariables: {},
    },
    storage: {
      getAdapter: jest.fn(),
    } as unknown as ProviderHost['storage'],
    getResolvedProviderCliPath: jest.fn(() => '/usr/bin/codex'),
    getActiveEnvironmentVariables: jest.fn(() => 'OPENAI_API_KEY=test'),
    mutateSettingsConditionally: jest.fn(async () => false),
  } as unknown as ProviderHost;
}

describe('Startup optimization', () => {
  beforeEach(() => {
    StartupProfiler.reset();
    ProviderWorkspaceRegistry.clear();
  });

  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
    StartupProfiler.reset();
  });

  it('workspace registry initializeAll resolves before Codex discovery completes', async () => {
    let discoveryResolved = false;
    const discovery: CodexModelDiscoveryServiceLike = {
      discoverModels: jest.fn(async () => {
        await new Promise((res) => setTimeout(res, 50));
        discoveryResolved = true;
        return {
          kind: 'completed',
          models: [makeModel('gpt-4o')],
        } as CodexModelDiscoveryResult;
      }),
    };

    ProviderWorkspaceRegistry.register('codex', {
      initialize: async ({ plugin }) => ({
        modelCatalogCoordinator: new CodexModelCatalogCoordinator(plugin, discovery),
      } as unknown as ProviderWorkspaceServices),
    });

    const host = createFakeHost();
    const initPromise = ProviderWorkspaceRegistry.initializeAll(host);
    expect(discoveryResolved).toBe(false);

    await initPromise;
    expect(discoveryResolved).toBe(false);

    const services = ProviderWorkspaceRegistry.getServices('codex') as {
      modelCatalogCoordinator: CodexModelCatalogCoordinator;
    };
    await services.modelCatalogCoordinator.refresh();
    expect(discoveryResolved).toBe(true);
  });

  it('profiler captures provider initialization span', async () => {
    ProviderWorkspaceRegistry.register('codex', {
      initialize: async () => ({
        modelCatalogCoordinator: null,
      } as unknown as ProviderWorkspaceServices),
    });

    const host = createFakeHost();
    await ProviderWorkspaceRegistry.initializeAll(host);

    const report = StartupProfiler.getReport();
    expect(report.spans.some((span) => span.name === 'provider-init:codex')).toBe(true);
  });
});
