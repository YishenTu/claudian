import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';
import {
  type OpencodeMetadataProbe,
  OpencodeMetadataService,
} from '@/providers/opencode/metadata/OpencodeMetadataService';

function createPlugin(): any {
  const plugin: any = {
    executionLifecycleRegistry: {
      registerTransitionHook: vi.fn(() => vi.fn()),
    },
    mutateSettings: vi.fn(async (mutation) => mutation(plugin.settings)),
    mutateSettingsConditionally: vi.fn(async (mutation) => mutation(plugin.settings)),
    notifyProviderChatOptionsChanged: vi.fn(),
    settings: { providerConfigs: { opencode: { discoveredModels: [], visibleModels: [] } } },
  };
  return plugin;
}

function createProbe(loadCommands: OpencodeMetadataProbe['loadCommands']): OpencodeMetadataProbe {
  return {
    dispose: vi.fn(async () => undefined),
    loadCatalog: vi.fn(async () => ({ models: [] })),
    loadCommands,
    warmModel: vi.fn(),
  };
}

function createContext(plugin: any): ProviderCommandLoaderContext {
  return { allowIsolatedMetadataCreation: true, conversation: null, plugin };
}

describe('OpencodeMetadataService command discovery outcomes', () => {
  it('reports retryable command discovery when the native catalog cannot be read', async () => {
    const plugin = createPlugin();
    const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry, {
      createProbe: () => createProbe(vi.fn(async () => { throw new Error('catalog unavailable'); })),
    });
    try {
      await expect(new OpencodeCommandLoader(service).loadCommands(createContext(plugin))).resolves.toEqual({
        message: 'Could not load OpenCode commands.',
        retryable: true,
        status: 'error',
      });
    } finally {
      await service.dispose();
    }
  });

  it('treats an observed empty command catalog as a valid empty catalog', async () => {
    const plugin = createPlugin();
    const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry, {
      createProbe: () => createProbe(vi.fn(async () => [])),
    });
    try {
      await expect(new OpencodeCommandLoader(service).loadCommands(createContext(plugin)))
        .resolves.toEqual({ status: 'empty' });
    } finally {
      await service.dispose();
    }
  });
});
