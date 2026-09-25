import {
  type OpencodeMetadataProbe,
  OpencodeMetadataService,
  type OpencodeMetadataWarmResult,
} from '@/providers/opencode/metadata/OpencodeMetadataService';
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

function createProbe(overrides: Partial<OpencodeMetadataProbe> = {}): OpencodeMetadataProbe {
  return {
    dispose: jest.fn(async () => undefined),
    loadCatalog: jest.fn(async () => ({
      commands: [{ id: 'acp:review', name: 'review', content: '' }],
      configOptions: [],
      models: {
        availableModels: [{
          modelId: 'anthropic/claude',
          name: 'Claude',
        }],
        currentModelId: 'anthropic/claude',
      },
    })),
    warmModel: jest.fn(async (): Promise<OpencodeMetadataWarmResult> => ({
      configOptions: [{
        category: 'thought_level',
        currentValue: 'high',
        id: 'effort',
        name: 'Effort',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'High', value: 'high' },
        ],
        type: 'select',
      }],
      rawModelId: 'anthropic/claude',
    })),
    ...overrides,
  };
}

describe('OpencodeMetadataService', () => {
  it('uses an isolated probe, publishes commands, and persists discovered models', async () => {
    const plugin = createPlugin();
    const probe = createProbe();
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(plugin, {
      commandCatalog,
      createProbe: jest.fn(() => probe),
    });

    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(service.loadCommands()).resolves.toEqual([
      { id: 'acp:review', name: 'review', content: '' },
    ]);

    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { label: 'Claude', rawId: 'anthropic/claude' },
    ]);
    expect(commandCatalog.setCommandSnapshot).toHaveBeenCalled();
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
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(transitionPlugin, {
      commandCatalog,
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
    expect(commandCatalog.setCommandSnapshot).toHaveBeenCalledWith([]);
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
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const service = new OpencodeMetadataService(transitionPlugin, {
      commandCatalog,
      createProbe: createProbeFactory,
    });

    await beforeTransition();
    transitionPlugin.mutateSettingsConditionally.mockClear();
    commandCatalog.setCommandSnapshot.mockClear();
    const catalog = service.loadCatalog();
    const commands = service.discoverCommands();
    const warm = service.warmModelMetadata('opencode:anthropic/claude');
    await Promise.resolve();

    expect(createProbeFactory).not.toHaveBeenCalled();
    expect(transitionPlugin.mutateSettingsConditionally).not.toHaveBeenCalled();
    expect(commandCatalog.setCommandSnapshot).not.toHaveBeenCalled();

    environment = 'environment-b';
    await afterTransition();
    await expect(Promise.all([catalog, commands, warm])).resolves.toEqual([
      true,
      expect.objectContaining({ loaded: true }),
      true,
    ]);
    expect(probeEnvironments).toEqual([
      'environment-b',
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
  await expect(service.loadCommands()).resolves.toHaveLength(1);
  expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([{ rawId: 'old/model', label: 'Old model' }]);
  expect(host.mutateSettingsConditionally).not.toHaveBeenCalled();
  await service.dispose();
});

it.each(['catalog', 'warm'] as const)('does not publish canceled %s metadata queued behind a settings write', async kind => {
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
    : service.warmModelMetadata('opencode:anthropic/claude', controller.signal);
  await waiting;
  controller.abort();
  release();
  await expect(pending).resolves.toBe(false);
  expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([]);
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel).toEqual({});
  expect(host.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
  await service.dispose();
});
