import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';
import {
  type OpencodeMetadataProbe,
  OpencodeMetadataService,
} from '@/providers/opencode/metadata/OpencodeMetadataService';

function createPlugin(): any {
  const plugin: any = {
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(() => jest.fn()),
    },
    mutateSettings: jest.fn(async (mutation) => mutation(plugin.settings)),
    mutateSettingsConditionally: jest.fn(async (mutation) => mutation(plugin.settings)),
    notifyProviderChatOptionsChanged: jest.fn(),
    settings: { providerConfigs: { opencode: { discoveredModels: [], visibleModels: [] } } },
  };
  return plugin;
}

function createProbe(loadCommands: OpencodeMetadataProbe['loadCommands']): OpencodeMetadataProbe {
  return {
    dispose: jest.fn(async () => undefined),
    loadCatalog: jest.fn(async () => ({ models: [] })),
    loadCommands,
    warmModel: jest.fn(),
  };
}

function createContext(plugin: any): ProviderCommandLoaderContext {
  return { allowIsolatedMetadataCreation: true, conversation: null, plugin };
}

describe('OpencodeMetadataService command discovery outcomes', () => {
  it('reports retryable command discovery when the native catalog cannot be read', async () => {
    const plugin = createPlugin();
    const service = new OpencodeMetadataService(plugin, {
      createProbe: () => createProbe(jest.fn(async () => { throw new Error('catalog unavailable'); })),
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
    const service = new OpencodeMetadataService(plugin, {
      createProbe: () => createProbe(jest.fn(async () => [])),
    });
    try {
      await expect(new OpencodeCommandLoader(service).loadCommands(createContext(plugin)))
        .resolves.toEqual({ status: 'empty' });
    } finally {
      await service.dispose();
    }
  });
});
