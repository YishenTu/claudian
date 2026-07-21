import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import {
  grokWorkspaceRegistration,
} from '@/providers/grok/app/GrokWorkspaceServices';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import { grokProviderRegistration } from '@/providers/grok/registration';
import { GrokAuxQueryRunner } from '@/providers/grok/runtime/GrokAuxQueryRunner';
import { GrokCliResolver } from '@/providers/grok/runtime/GrokCliResolver';
import type { GrokModelCatalogCoordinator } from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import { getGrokProviderSettings } from '@/providers/grok/settings';

jest.mock('@/providers/grok/runtime/GrokAuxQueryRunner');

const MockGrokAuxQueryRunner = GrokAuxQueryRunner as jest.MockedClass<typeof GrokAuxQueryRunner>;

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

function createPlugin(): any {
  return {
    app: { vault: { adapter: { basePath: '/tmp/grok-registration' } } },
    manifest: { version: 'test' },
    settings: {
      model: 'sonnet',
      providerConfigs: { grok: { enabled: true } },
    },
    storage: { getAdapter: jest.fn(() => ({})) },
  };
}

describe('Grok provider registration', () => {
  beforeEach(() => {
    MockGrokAuxQueryRunner.mockImplementation((_plugin, options) => ({
      query: jest.fn(async (config: any, prompt: string) => {
        await options?.resolveLifecycle?.();
        if (prompt.includes('<editor_')) return '<replacement>edited</replacement>';
        if (config.systemPrompt.includes('title')) return 'Cold Grok title';
        if (config.systemPrompt.includes('instruction')) {
          return '<instruction>Cold refined instruction</instruction>';
        }
        return '<replacement>edited</replacement>';
      }),
      reset: jest.fn(),
    } as unknown as GrokAuxQueryRunner));
  });

  afterEach(() => {
    ProviderWorkspaceRegistry.setServices('grok', undefined);
    ProviderWorkspaceRegistry.register('grok', grokWorkspaceRegistration);
  });

  it('registers the complete provider surface with the locked environment boundary', () => {
    expect(grokProviderRegistration).toMatchObject({
      id: 'grok',
      displayName: 'Grok',
      blankTabOrder: 12,
    });
    expect(grokProviderRegistration.environmentKeyPatterns?.map(pattern => ({
      flags: pattern.flags,
      source: pattern.source,
    }))).toEqual([
      { flags: 'i', source: '^GROK_' },
      { flags: 'i', source: '^XAI_' },
    ]);
    expect(grokProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('GROK_HOME'))).toBe(true);
    expect(grokProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('XAI_API_KEY'))).toBe(true);
    expect(grokProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('OPENAI_API_KEY'))).toBe(false);
    expect(grokProviderRegistration.subagentLifecycleAdapter).toMatchObject({
      isSpawnTool: expect.any(Function),
      isWaitTool: expect.any(Function),
      isCloseTool: expect.any(Function),
    });
    expect(grokProviderRegistration.settingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(grokProviderRegistration.historyService).toHaveProperty('hydrateConversationHistory');
    expect(grokProviderRegistration.taskResultInterpreter).toHaveProperty('resolveTerminalStatus');
  });

  it('requires initialized workspace services before constructing a chat runtime', () => {
    ProviderWorkspaceRegistry.setServices('grok', undefined);

    expect(() => grokProviderRegistration.createRuntime({
      plugin: createPlugin(),
    })).toThrow('Provider workspace "grok" is not initialized.');
  });

  it('is disabled by default, mutates enablement through Grok settings, and routes model ids', () => {
    const settings: Record<string, unknown> = {};
    expect(grokProviderRegistration.isEnabled(settings)).toBe(false);
    grokProviderRegistration.setEnabled?.(settings, true);
    expect(getGrokProviderSettings(settings).enabled).toBe(true);
    expect(ProviderRegistry.resolveProviderForModel('grok/grok-4.5', settings)).toBe('grok');
    expect(ProviderRegistry.resolveProviderForModel('grok', settings)).toBe('claude');
  });

  it('constructs runtime and auxiliary factories against initialized workspace services', () => {
    const plugin = createPlugin();
    const commandCatalog = new GrokCommandCatalog();
    const cliResolver = new GrokCliResolver();
    const modelCatalogCoordinator = {
      mergeLiveModels: jest.fn(),
    } as unknown as GrokModelCatalogCoordinator;
    ProviderWorkspaceRegistry.setServices('grok', {
      cliResolver,
      commandCatalog,
      modelCatalogCoordinator,
    } as any);

    const runtime = grokProviderRegistration.createRuntime({ plugin });
    expect(runtime.providerId).toBe('grok');
    expect(runtime.getCapabilities()).toBe(grokProviderRegistration.capabilities);
    expect(runtime).toMatchObject({
      cliResolver,
      commandCatalog,
      modelCatalogCoordinator,
    });
    expect(grokProviderRegistration.createTitleGenerationService(plugin)).toBeDefined();
    expect(grokProviderRegistration.createInstructionRefineService(plugin)).toBeDefined();
    expect(grokProviderRegistration.createInlineEditService(plugin)).toBeDefined();
    runtime.cleanup();
  });

  it('constructs saved blank-tab and inline services before Grok workspace initialization', () => {
    const plugin = createPlugin();
    ProviderWorkspaceRegistry.setServices('grok', undefined);

    expect(() => grokProviderRegistration.createInstructionRefineService(plugin)).not.toThrow();
    expect(() => grokProviderRegistration.createInlineEditService(plugin)).not.toThrow();
    expect(ProviderWorkspaceRegistry.getIfInitialized('grok')).toBeNull();
  });

  it('shares one pending cold initialization across a blank-tab switch and routed Grok title use', async () => {
    const plugin = createPlugin();
    plugin.settings.titleGenerationModel = 'grok/grok-4.5';
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    const initialize = jest.fn(async () => {
      await initialization;
      return { auxiliaryLifecycle: lifecycle } as any;
    });
    ProviderWorkspaceRegistry.register('grok', { initialize });

    const blankTabService = grokProviderRegistration.createInstructionRefineService(plugin);
    const routedTitleService = ProviderRegistry.createTitleGenerationService(plugin);
    const callback = jest.fn();
    const refine = blankTabService.refineInstruction('cold refine', 'Existing');
    const title = routedTitleService.generateTitle('conversation-1', 'Cold route', callback);
    await new Promise(resolve => setImmediate(resolve));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(() => blankTabService.resetConversation()).not.toThrow();

    finishInitialization();
    await Promise.all([title, expect(refine).resolves.toEqual({
      refinedInstruction: 'Cold refined instruction',
      success: true,
    })]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Cold Grok title',
    });
  });

  it('does not launch a pending cold query with the old environment during a transition', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.grok.environmentVariables = 'GROK_PROFILE=old';
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    ProviderWorkspaceRegistry.register('grok', {
      initialize: jest.fn(async () => {
        await initialization;
        return { auxiliaryLifecycle: lifecycle } as any;
      }),
    });
    const launchedEnvironments: string[] = [];
    MockGrokAuxQueryRunner.mockImplementation((queryPlugin, options) => ({
      query: jest.fn(async () => {
        await options?.resolveLifecycle?.();
        launchedEnvironments.push(
          getGrokProviderSettings(queryPlugin.settings).environmentVariables,
        );
        return '<instruction>Cold refined instruction</instruction>';
      }),
      reset: jest.fn(),
    } as unknown as GrokAuxQueryRunner));
    const service = grokProviderRegistration.createInstructionRefineService(plugin);
    const query = service.refineInstruction('cold refine', 'Existing');
    await new Promise(resolve => setImmediate(resolve));

    const transitionPromise = ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['grok']);
    let transitionAcquired = false;
    void transitionPromise.then(() => { transitionAcquired = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(transitionAcquired).toBe(false);

    finishInitialization();
    const transition = await transitionPromise;
    expect(launchedEnvironments).toEqual([]);
    plugin.settings.providerConfigs.grok.environmentVariables = 'GROK_PROFILE=new';
    await transition.release();

    await expect(query).resolves.toEqual({
      refinedInstruction: 'Cold refined instruction',
      success: true,
    });
    expect(launchedEnvironments).toEqual(['GROK_PROFILE=new']);
  });

  it('initializes once on first use of a cold inline factory and returns the edit', async () => {
    const plugin = createPlugin();
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const initialize = jest.fn(async () => ({ auxiliaryLifecycle: lifecycle }) as any);
    ProviderWorkspaceRegistry.register('grok', { initialize });

    const service = grokProviderRegistration.createInlineEditService(plugin);
    expect(initialize).not.toHaveBeenCalled();
    await expect(service.editText({
      instruction: 'Improve this',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'draft',
    })).resolves.toEqual({ editedText: 'edited', success: true });
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('surfaces cold workspace initialization failures through the title service', async () => {
    const plugin = createPlugin();
    plugin.settings.titleGenerationModel = 'grok/grok-4.5';
    const initialize = jest.fn(async () => {
      throw new Error('Grok workspace initialization failed');
    });
    ProviderWorkspaceRegistry.register('grok', { initialize });

    const service = ProviderRegistry.createTitleGenerationService(plugin);
    const callback = jest.fn();
    await service.generateTitle('conversation-1', 'Cold route', callback);

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Grok workspace initialization failed',
      success: false,
    });
  });

  it('host-scopes CLI paths and model catalogs during storage normalization', () => {
    expect(grokProviderRegistration.settingsStorage.hostScopedFields).toEqual([
      'cliPathsByHost',
      'catalogsByHost',
    ]);
    const target: Record<string, unknown> = {};
    const stored = {
      providerConfigs: {
        grok: {
          catalogsByHost: {
            'device:current': {
              defaultModelId: 'grok-4.5',
              fingerprint: 'fingerprint',
              models: [{ displayName: 'Grok 4.5', rawId: 'grok-4.5' }],
              refreshedAt: 1,
            },
            'device:other': {
              defaultModelId: null,
              fingerprint: 'other',
              models: [],
              refreshedAt: 2,
            },
          },
          cliPathsByHost: {
            'device:current': '/opt/grok/bin/grok',
            'device:other': '/other/grok',
          },
          enabled: true,
          runtimeAuthToken: 'must-not-persist',
          sessionMetadata: { secret: 'must-not-persist' },
        },
      },
    };

    grokProviderRegistration.settingsStorage.normalizeStored(target, stored);

    expect(getGrokProviderSettings(target).cliPathsByHost).toEqual({
      'device:current': '/opt/grok/bin/grok',
      'device:other': '/other/grok',
    });
    expect(getGrokProviderSettings(target).catalogsByHost).toEqual(
      expect.objectContaining({
        'device:current': expect.objectContaining({ fingerprint: 'fingerprint' }),
        'device:other': expect.objectContaining({ fingerprint: 'other' }),
      }),
    );
    expect((target.providerConfigs as Record<string, Record<string, unknown>>).grok)
      .not.toHaveProperty('runtimeAuthToken');
    expect((target.providerConfigs as Record<string, Record<string, unknown>>).grok)
      .not.toHaveProperty('sessionMetadata');
  });
});
