import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

interface MockKernelOptions {
  readonly onNotification: (notification: {
    sessionId: string;
    update: Record<string, unknown>;
  }) => void;
}

const mockKernelOptions: MockKernelOptions[] = [];

jest.mock('@/providers/opencode/execution/OpencodeAcpSessionKernel', () => ({
  DefaultOpencodeAcpSessionKernel: jest.fn().mockImplementation((options) => {
    mockKernelOptions.push(options);
    return {
      connect: jest.fn(async () => undefined),
      dispose: jest.fn(async () => undefined),
      openSession: jest.fn(async () => ({
        configOptions: [],
        databasePath: ':memory:',
        models: {
          availableModels: [{ modelId: 'anthropic/claude', name: 'Claude' }],
          currentModelId: 'anthropic/claude',
        },
        sessionId: 'metadata-session',
      })),
      setConfigOption: jest.fn(),
    };
  }),
}));

function createPlugin(): any {
  const plugin: any = {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
      },
    },
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(() => jest.fn()),
    },
    mutateSettings: jest.fn(async (
      mutation: (settings: Record<string, unknown>) => void,
    ): Promise<void> => {
      mutation(plugin.settings);
    }),
    notifyProviderChatOptionsChanged: jest.fn(),
    settings: {
      providerConfigs: {
        opencode: {
          discoveredModels: [],
          visibleModels: [],
        },
      },
    },
  };
  return plugin;
}

function createContext(plugin: any): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: true,
    conversation: null,
    externalContextPaths: [],
    plugin,
  };
}

async function waitForKernel(): Promise<MockKernelOptions> {
  for (let attempt = 0; attempt < 10 && mockKernelOptions.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  const options = mockKernelOptions[0];
  if (!options) throw new Error('OpenCode metadata kernel was not created');
  return options;
}

describe('OpencodeMetadataService command update timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockKernelOptions.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('reports retryable command discovery when no command update arrives', async () => {
    const plugin = createPlugin();
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(plugin, { commandCatalog });
    const loader = new OpencodeCommandLoader(service);

    try {
      const result = loader.loadCommands(createContext(plugin));
      await waitForKernel();
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toEqual({
        message: 'Could not load OpenCode commands.',
        retryable: true,
        status: 'error',
      });
      expect(commandCatalog.setCommandSnapshot).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });

  it('still publishes model metadata when the command update is absent', async () => {
    const plugin = createPlugin();
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(plugin, { commandCatalog });

    try {
      const loaded = service.loadCatalog();
      await waitForKernel();
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(loaded).resolves.toBe(true);
      expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
        { label: 'Claude', rawId: 'anthropic/claude' },
      ]);
      expect(commandCatalog.setCommandSnapshot).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });

  it('treats an observed empty command update as a valid empty catalog', async () => {
    const plugin = createPlugin();
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(plugin, { commandCatalog });
    const loader = new OpencodeCommandLoader(service);

    try {
      const result = loader.loadCommands(createContext(plugin));
      const kernelOptions = await waitForKernel();
      kernelOptions.onNotification({
        sessionId: 'metadata-session',
        update: {
          availableCommands: [],
          sessionUpdate: 'available_commands_update',
        },
      });

      await expect(result).resolves.toEqual({ status: 'empty' });
      expect(commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([]);
    } finally {
      await service.dispose();
    }
  });
});
