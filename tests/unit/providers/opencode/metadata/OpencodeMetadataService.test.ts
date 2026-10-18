import type { OpencodeNativeModel } from '@/providers/opencode/http/OpencodeNativeModelCatalog';
import type { OpencodeServerLease } from '@/providers/opencode/http/OpencodeServerService';
import {
  type OpencodeMetadataProbe,
  OpencodeMetadataService,
  type OpencodeMetadataWarmResult,
} from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeV2MetadataProbe } from '@/providers/opencode/metadata/OpencodeV2MetadataProbe';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

function createPlugin(): any {
  const plugin: any = {
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(() => jest.fn()),
    },
    mutateSettings: jest.fn(async (mutation) => mutation(plugin.settings)),
    mutateSettingsConditionally: jest.fn(async (mutation) => mutation(plugin.settings)),
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

function nativeModel(rawId: string, label: string): OpencodeNativeModel {
  const [providerID, id] = rawId.split('/');
  return { rawId, providerID, id, label, variants: [], contextWindow: 0 };
}

function createProbe(overrides: Partial<OpencodeMetadataProbe> = {}): OpencodeMetadataProbe {
  return {
    dispose: jest.fn(async () => undefined),
    loadCatalog: jest.fn(async () => ({ models: [nativeModel('anthropic/claude', 'Claude')] })),
    loadCommands: jest.fn(async () => [{ id: 'opencode-command:review', name: 'review', content: '' }]),
    warmModel: jest.fn(async (): Promise<OpencodeMetadataWarmResult> => ({
      models: [nativeModel('anthropic/claude', 'Claude')],
      rawModelId: 'anthropic/claude',
      thinkingLevels: ['low', 'high'],
    })),
    ...overrides,
  };
}

describe('OpencodeMetadataService', () => {
  it('discovers selected model metadata with one probe and skips models deselected during the batch', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.opencode.visibleModels = ['a/one', 'b/two', 'c/three'];
    const catalog = ['a/one', 'b/two', 'c/three'].map(rawId => nativeModel(rawId, rawId));
    const probe = createProbe({
      loadCatalog: jest.fn(async () => ({ models: catalog })),
      warmModel: jest.fn(async rawModelId => {
        if (rawModelId === 'a/one') {
          plugin.settings.providerConfigs.opencode.visibleModels = ['a/one', 'b/two'];
          throw new Error('First model unavailable');
        }
        return { rawModelId, models: catalog, thinkingLevels: [] };
      }),
    });
    const create = jest.fn(() => probe);
    const service = new OpencodeMetadataService(plugin, { createProbe: create });
    try {
      await expect(service.discoverModels()).resolves.toEqual({ changed: true });
      expect(create).toHaveBeenCalledTimes(1);
      expect(jest.mocked(probe.warmModel).mock.calls.map(([id]) => id)).toEqual(['a/one', 'b/two']);
      expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['b/two']).toEqual([]);
      expect(probe.dispose).toHaveBeenCalledTimes(1);
    } finally { await service.dispose(); }
  });

  it('uses an isolated probe, loads commands, and persists discovered models', async () => {
    const plugin = createPlugin();
    const probe = createProbe();
    const service = new OpencodeMetadataService(plugin, {
      createProbe: jest.fn(() => probe),
    });

    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(service.discoverCommands()).resolves.toEqual({
      commands: [{ id: 'opencode-command:review', name: 'review', content: '' }],
      loaded: true,
    });

    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { label: 'Claude', rawId: 'anthropic/claude' },
    ]);
    expect(probe.dispose).toHaveBeenCalledTimes(2);
  });

  it('warms detached thought-level metadata without constructing a chat runtime', async () => {
    const plugin = createPlugin();
    const probe = createProbe();
    const service = new OpencodeMetadataService(plugin, {
      createProbe: () => probe,
    });

    await expect(
      service.warmModelMetadata('opencode:anthropic/claude'),
    ).resolves.toBe(true);

    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel).toEqual({
      'anthropic/claude': [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
    });
  });

  it('registers transition invalidation and unregisters it on disposal', async () => {
    let beforeTransition!: () => Promise<void>;
    const unregister = jest.fn();
    const transitionPlugin = createPlugin();
    transitionPlugin.executionLifecycleRegistry.registerTransitionHook
      .mockImplementation((_providerId: string, hook: {
        beforeTransition(): Promise<void>;
      }) => {
        beforeTransition = hook.beforeTransition;
        return unregister;
      });
    let rejectLoad!: (error: Error) => void;
    let ownedSignal: AbortSignal | undefined;
    const probe = createProbe({
      loadCatalog: jest.fn((signal) => new Promise((_resolve, reject) => {
        ownedSignal = signal;
        rejectLoad = reject;
      })),
    });
    const service = new OpencodeMetadataService(transitionPlugin, {
      createProbe: () => probe,
    });
    const load = service.loadCatalog();
    await Promise.resolve();

    const transition = beforeTransition();
    expect(ownedSignal?.aborted).toBe(true);
    rejectLoad(new Error('transition'));
    await transition;
    await expect(load).resolves.toBe(false);

    expect(
      transitionPlugin.executionLifecycleRegistry.registerTransitionHook,
    ).toHaveBeenCalledWith('opencode', {
      afterTransition: expect.any(Function),
      beforeTransition: expect.any(Function),
    });
    expect(probe.dispose).toHaveBeenCalledTimes(1);

    await service.dispose();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('fences every metadata entrypoint until the transition mutation completes', async () => {
    let beforeTransition!: () => Promise<void>;
    let afterTransition!: () => Promise<void>;
    const transitionPlugin = createPlugin();
    transitionPlugin.executionLifecycleRegistry.registerTransitionHook
      .mockImplementation((_providerId: string, hook: {
        afterTransition(): Promise<void>;
        beforeTransition(): Promise<void>;
      }) => {
        afterTransition = hook.afterTransition;
        beforeTransition = hook.beforeTransition;
        return jest.fn();
      });
    let environment = 'environment-a';
    const probeEnvironments: string[] = [];
    const createProbeFactory = jest.fn(() => {
      probeEnvironments.push(environment);
      return createProbe();
    });
    const service = new OpencodeMetadataService(transitionPlugin, {
      createProbe: createProbeFactory,
    });

    await beforeTransition();
    transitionPlugin.mutateSettingsConditionally.mockClear();
    const catalog = service.loadCatalog();
    const commands = service.discoverCommands();
    const warm = service.warmModelMetadata('opencode:anthropic/claude');
    const discovery = service.discoverModels();
    const batch = service.warmModelsMetadata(['opencode:anthropic/claude']);
    await Promise.resolve();

    expect(createProbeFactory).not.toHaveBeenCalled();
    expect(transitionPlugin.mutateSettingsConditionally).not.toHaveBeenCalled();

    environment = 'environment-b';
    await afterTransition();
    await expect(Promise.all([catalog, commands, warm, discovery, batch])).resolves.toEqual([
      true,
      expect.objectContaining({ loaded: true }),
      true, { changed: true }, true,
    ]);
    expect(probeEnvironments).toEqual([
      'environment-b', 'environment-b', 'environment-b',
      'environment-b',
      'environment-b',
    ]);

    await service.dispose();
  });

  it('releases aborted and disposed callers waiting behind the transition fence', async () => {
    let beforeTransition!: () => Promise<void>;
    let afterTransition!: () => Promise<void>;
    const transitionPlugin = createPlugin();
    transitionPlugin.executionLifecycleRegistry.registerTransitionHook
      .mockImplementation((_providerId: string, hook: {
        afterTransition(): Promise<void>;
        beforeTransition(): Promise<void>;
      }) => {
        afterTransition = hook.afterTransition;
        beforeTransition = hook.beforeTransition;
        return jest.fn();
      });
    const createProbeFactory = jest.fn(() => createProbe());
    const service = new OpencodeMetadataService(transitionPlugin, {
      createProbe: createProbeFactory,
    });

    await beforeTransition();
    const controller = new AbortController();
    const aborted = service.loadCatalog(controller.signal);
    const disposed = service.loadCatalog();
    controller.abort();

    await expect(aborted).resolves.toBe(false);
    await service.dispose();
    await expect(disposed).resolves.toBe(false);
    expect(createProbeFactory).not.toHaveBeenCalled();
    await afterTransition();
  });
});

it('does not replace catalog rows during command warmup', async () => {
  const host = createPlugin();
  host.settings.providerConfigs.opencode.discoveredModels = [{ rawId: 'old/model', label: 'Old model' }];
  const service = new OpencodeMetadataService(host, { createProbe });
  expect((await service.discoverCommands()).commands).toHaveLength(1);
  expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([{ rawId: 'old/model', label: 'Old model' }]);
  expect(host.mutateSettingsConditionally).not.toHaveBeenCalled();
  await service.dispose();
});

it.each(['catalog', 'warm', 'discovery', 'batch'] as const)('does not publish canceled %s metadata queued behind a settings write', async kind => {
  const host = createPlugin();
  let release!: () => void;
  let queued!: () => void;
  const waiting = new Promise<void>(resolve => { queued = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = jest.fn(async (mutate: (settings: any) => unknown) => {
    queued();
    await gate;
    return mutate(host.settings);
  });
  host.mutateSettings = write;
  host.mutateSettingsConditionally = write;
  const service = new OpencodeMetadataService(host, { createProbe: () => createProbe() });
  const controller = new AbortController();
  const pending = kind === 'catalog'
    ? service.loadCatalog(controller.signal)
    : kind === 'discovery' ? service.discoverModels(controller.signal)
      : kind === 'batch' ? service.warmModelsMetadata(['opencode:anthropic/claude'], controller.signal)
        : service.warmModelMetadata('opencode:anthropic/claude', controller.signal);
  await waiting;
  controller.abort();
  release();
  expect(await pending).toEqual(kind === 'discovery' ? { changed: false } : false);
  expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([]);
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel).toEqual({});
  expect(host.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
  await service.dispose();
});

it('publishes enabled native models without reading the command catalog', async () => {
  const host = createPlugin();
  const routes: string[] = [];
  const lease = {
    signal: (signal?: AbortSignal) => signal ?? new AbortController().signal,
    waitForActivation: async () => undefined,
    request: async (route: string) => {
      routes.push(route);
      if (route !== '/api/model') throw new Error(`Unavailable route: ${route}`);
      return { data: [
        { id: 'chat', providerID: 'local', name: 'Chat', enabled: true },
        { id: 'bare', providerID: 'local', enabled: true },
        { id: 'off', providerID: 'local', name: 'Off', enabled: false },
        { id: {}, providerID: 'local', name: 'Malformed', enabled: true },
      ] };
    },
    dispose: async () => undefined,
  } as unknown as OpencodeServerLease;
  const service = new OpencodeMetadataService(host, { createProbe: () => new OpencodeV2MetadataProbe(lease) });
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    // Disabled and malformed entries are not selectable; a missing name falls back to the native ID.
    expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([
      { rawId: 'local/chat', label: 'local/Chat' },
      { rawId: 'local/bare', label: 'local/bare' },
    ]);
    expect(routes).toEqual(['/api/model']);
  } finally { await service.dispose(); }
});
