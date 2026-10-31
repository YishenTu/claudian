import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { OpencodeNativeModel } from '@/providers/opencode/http/OpencodeNativeModelCatalog';
import {
  type OpencodeMetadataProbe,
  OpencodeMetadataService,
  type OpencodeMetadataWarmResult,
} from '@/providers/opencode/metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

async function createPlugin(beforePersist?: () => Promise<void>) {
  const notifyProviderChatOptionsChanged = vi.fn();
  const { host, settings, lifecycle } = await createProviderHostFixture({
    settings: { providerConfigs: { opencode: { discoveredModels: [], visibleModels: [] } } },
    overrides: { notifyProviderChatOptionsChanged },
    beforePersist,
  });
  const runtime = host.getRuntimeHost('opencode');
  return Object.assign(runtime, {
    updateConfig: vi.fn(runtime.updateConfig), settings, notifyProviderChatOptionsChanged,
    executionLifecycleRegistry: lifecycle,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function holdTransition(host: Awaited<ReturnType<typeof createPlugin>>) {
  const entered = deferred();
  const gate = deferred();
  const transition = host.executionLifecycleRegistry.runTransition(['opencode'], async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  return async () => { gate.resolve(); await transition; };
}

function nativeModel(rawId: string, label: string): OpencodeNativeModel {
  const [providerID, id] = rawId.split('/');
  return { rawId, providerID, id, label, variants: [], contextWindow: 0 };
}

function createProbe(overrides: Partial<OpencodeMetadataProbe> = {}): OpencodeMetadataProbe {
  return {
    dispose: vi.fn(async () => undefined),
    loadCatalog: vi.fn(async () => ({ models: [nativeModel('anthropic/claude', 'Claude')] })),
    loadCommands: vi.fn(async () => [{ id: 'opencode-command:review', name: 'review', content: '' }]),
    warmModel: vi.fn(async (): Promise<OpencodeMetadataWarmResult> => ({
      models: [nativeModel('anthropic/claude', 'Claude')],
      rawModelId: 'anthropic/claude',
      thinkingLevels: ['low', 'high'],
    })),
    ...overrides,
  };
}

describe('OpencodeMetadataService', () => {
  it('discovers selected model metadata with one probe and skips models deselected during the batch', async () => {
    const plugin = await createPlugin();
    updateOpencodeProviderSettings(plugin.settings, { visibleModels: ['a/one', 'b/two', 'c/three'] });
    const catalog = ['a/one', 'b/two', 'c/three'].map(rawId => nativeModel(rawId, rawId));
    const probe = createProbe({
      loadCatalog: vi.fn(async () => ({ models: catalog })),
      warmModel: vi.fn(async rawModelId => {
        if (rawModelId === 'a/one') {
          updateOpencodeProviderSettings(plugin.settings, { visibleModels: ['a/one', 'b/two'] });
          throw new Error('First model unavailable');
        }
        return { rawModelId, models: catalog, thinkingLevels: [] };
      }),
    });
    const create = vi.fn(() => probe);
    const service = new OpencodeMetadataService(plugin, plugin.executionLifecycleRegistry, { createProbe: create });
    try {
      await expect(service.discoverModels()).resolves.toEqual({ changed: true });
      expect(create).toHaveBeenCalledTimes(1);
      expect(vi.mocked(probe.warmModel).mock.calls.map(([id]) => id)).toEqual(['a/one', 'b/two']);
      expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['b/two']).toEqual([]);
      expect(probe.dispose).toHaveBeenCalledTimes(1);
    } finally { await service.dispose(); }
  });

  it('fences every metadata entrypoint until the transition mutation completes', async () => {
    const transitionPlugin = await createPlugin();
    let environment = 'environment-a';
    const probeEnvironments: string[] = [];
    const createProbeFactory = vi.fn(() => {
      probeEnvironments.push(environment);
      return createProbe();
    });
    const service = new OpencodeMetadataService(transitionPlugin, transitionPlugin.executionLifecycleRegistry, {
      createProbe: createProbeFactory,
    });

    const releaseTransition = await holdTransition(transitionPlugin);
    transitionPlugin.updateConfig.mockClear();
    const catalog = service.loadCatalog();
    const commands = service.discoverCommands();
    const warm = service.warmModelMetadata('opencode:anthropic/claude');
    const discovery = service.discoverModels();
    const batch = service.warmModelsMetadata(['opencode:anthropic/claude']);
    await Promise.resolve();

    expect(createProbeFactory).not.toHaveBeenCalled();
    expect(transitionPlugin.updateConfig).not.toHaveBeenCalled();

    environment = 'environment-b';
    await releaseTransition();
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
    const transitionPlugin = await createPlugin();
    const createProbeFactory = vi.fn(() => createProbe());
    const service = new OpencodeMetadataService(transitionPlugin, transitionPlugin.executionLifecycleRegistry, {
      createProbe: createProbeFactory,
    });

    const releaseTransition = await holdTransition(transitionPlugin);
    const controller = new AbortController();
    const aborted = service.loadCatalog(controller.signal);
    const disposed = service.loadCatalog();
    controller.abort();

    await expect(aborted).resolves.toBe(false);
    await service.dispose();
    await expect(disposed).resolves.toBe(false);
    expect(createProbeFactory).not.toHaveBeenCalled();
    await releaseTransition();
  });
});

it.each(['catalog', 'warm', 'discovery', 'batch'] as const)('does not publish canceled %s metadata queued behind a settings write', async kind => {
  const entered = deferred();
  const gate = deferred();
  const queued = deferred();
  const host = await createPlugin(async () => { entered.resolve(); await gate.promise; });
  const write = host.updateConfig(config => { config.extensionField = 'preserved'; return true; });
  await entered.promise;
  const updateConfig = host.updateConfig;
  host.updateConfig = vi.fn(mutation => {
    const pending = updateConfig(mutation);
    queued.resolve();
    return pending;
  });
  const service = new OpencodeMetadataService(host, host.executionLifecycleRegistry, { createProbe: () => createProbe() });
  const controller = new AbortController();
  const pending = kind === 'catalog'
    ? service.loadCatalog(controller.signal)
    : kind === 'discovery' ? service.discoverModels(controller.signal)
      : kind === 'batch' ? service.warmModelsMetadata(['opencode:anthropic/claude'], controller.signal)
        : service.warmModelMetadata('opencode:anthropic/claude', controller.signal);
  await queued.promise;
  controller.abort();
  gate.resolve();
  await write;
  expect(await pending).toEqual(kind === 'discovery' ? { changed: false } : false);
  expect(getOpencodeProviderSettings(host.settings).discoveredModels).toEqual([]);
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel).toEqual({});
  expect(host.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
  await service.dispose();
});
