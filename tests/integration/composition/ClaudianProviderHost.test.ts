import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ClaudianProviderHost, type ClaudianProviderHostDeps } from '@/composition/ClaudianProviderHost';
import {
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionTransitionScope,
} from '@/core/execution';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderSessionArchive } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';

function createHost(overrides: Partial<ClaudianProviderHostDeps> = {}): ClaudianProviderHost {
  const settings = { userName: 'before' } as ClaudianSettings;
  return new ClaudianProviderHost({
    app: {} as ClaudianProviderHostDeps['app'],
    executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
    storage: { installationKey: 'device-key' as never },
    sessionToolEndpoint: { registerMCPRoute: vi.fn(), registerCallRoute: vi.fn() },
    settings: new SettingsCoordinator(settings, async () => undefined),
    environment: {} as ClaudianProviderHostDeps['environment'],
    notifyProviderChatOptionsChanged: async () => undefined,
    ...overrides,
  });
}

describe('ClaudianProviderHost', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('exposes committed settings and serialized mutations without plugin lifecycle APIs', async () => {
    const host = createHost();
    const committed = host.settings;

    await host.mutateSettings((settings) => { settings.userName = 'after'; });

    expect(host.settings).toBe(committed);
    expect(host.settings.userName).toBe('after');
    expect('registerView' in host).toBe(false);
    expect('addCommand' in host).toBe(false);
  });

  it('projects the local vault directory as the provider working directory', () => {
    const adapter: { basePath?: unknown } = { basePath: '/vault' };
    const host = createHost({ app: { vault: { adapter } } as unknown as ClaudianProviderHostDeps['app'] });

    expect(host.workingDirectory).toBe('/vault');
    adapter.basePath = '/moved';
    expect(host.workingDirectory).toBe('/moved');
    delete adapter.basePath;
    expect(host.workingDirectory).toBeNull();
  });

  it('gives provider runtimes live scoped reads and writes of only their own configuration', async () => {
    const settings = {
      model: 'other/model', titleGenerationModel: 'pi/title', effortLevel: 'low', locale: 'de',
      savedProviderModel: { pi: 'pi/saved', codex: 'codex/saved' },
      sharedEnvironmentVariables: 'SHARED=1',
      providerConfigs: { pi: { enabled: true, environmentVariables: 'PI=1', nested: { kept: true } }, codex: { enabled: false } },
    } as unknown as ClaudianSettings;
    const coordinator = new SettingsCoordinator(settings, async () => undefined);
    const host = createHost({ settings: coordinator, manifest: { version: '9.9.9' } });
    const runtime = host.getRuntimeHost('pi');

    expect(host.getRuntimeHost('pi')).toBe(runtime);
    expect(runtime.config).toEqual({ enabled: true, environmentVariables: 'PI=1', nested: { kept: true } });
    expect(runtime.selection).toEqual({
      model: 'other/model', effortLevel: 'low', permissionMode: undefined, serviceTier: undefined,
      referencedModelIds: ['other/model', 'pi/title', 'pi/saved'],
    });
    expect(runtime.savedSelection).toEqual({
      model: 'pi/saved', effortLevel: undefined, permissionMode: undefined, serviceTier: undefined,
    });
    expect(runtime.environmentText).toBe('SHARED=1\nPI=1');
    expect(runtime.locale).toBe('de');
    expect(runtime.clientVersion).toBe('9.9.9');

    // A rejected mutation leaves committed state untouched, nested values included.
    await expect(runtime.updateConfig(config => {
      (config.nested as Record<string, unknown>).kept = false;
      config.enabled = false;
      return false;
    })).resolves.toBe(false);
    expect(runtime.config).toEqual({ enabled: true, environmentVariables: 'PI=1', nested: { kept: true } });

    await expect(runtime.updateConfig((config, selection) => {
      config.visibleModels = [...selection.referencedModelIds];
      return true;
    })).resolves.toBe(true);
    const committed = coordinator.getCommittedSettings() as unknown as Record<string, unknown>;
    expect((committed.providerConfigs as Record<string, unknown>).pi).toMatchObject({
      enabled: true, visibleModels: ['other/model', 'pi/title', 'pi/saved'],
    });
    expect((committed.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: false });
    expect(committed.model).toBe('other/model');

    // Reads are live: a later application change is visible without a new view.
    await coordinator.mutate(draft => { (draft as unknown as Record<string, unknown>).model = 'pi/next'; });
    expect(runtime.selection.model).toBe('pi/next');
  });

  it('runs provider transitions through the application lifecycle registry', async () => {
    const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
    const runTransition = vi.spyOn(executionLifecycleRegistry, 'runTransition')
      .mockImplementation(async (_providerIds, mutation) => mutation({} as ProviderExecutionTransitionScope));
    const host = createHost({ executionLifecycleRegistry });
    const mutation = vi.fn(async () => 'result');

    expect(host.executionLifecycleRegistry).toBe(executionLifecycleRegistry);
    await expect(
      host.runProviderExecutionTransition(['opencode', 'claude'], mutation),
    ).resolves.toBe('result');
    expect(runTransition).toHaveBeenLastCalledWith(['opencode', 'claude'], mutation);

    const parentScope = { providerIds: ['claude'] } as unknown as ProviderExecutionTransitionScope;
    await host.runProviderExecutionTransition(['codex'], mutation, parentScope);
    expect(runTransition).toHaveBeenLastCalledWith(['codex'], mutation, parentScope);
  });

  it('initializes only session-archive providers before reading their archive', async () => {
    const sessionArchive = { setSessionsArchived: vi.fn() } as unknown as ProviderSessionArchive;
    const initializeArchive = vi.fn(async () => ({ sessionArchive }));
    const initializePlain = vi.fn(async () => ({}));
    ProviderWorkspaceRegistry.register('test-archive', {
      providesSessionArchive: true,
      initialize: initializeArchive,
    });
    ProviderWorkspaceRegistry.register('test-plain', { initialize: initializePlain });
    const host = createHost();

    await expect(host.getSessionArchive('test-plain')).resolves.toBeNull();
    await expect(host.getSessionArchive('test-archive')).resolves.toBe(sessionArchive);

    expect(initializePlain).not.toHaveBeenCalled();
    expect(initializeArchive).toHaveBeenCalledWith(expect.objectContaining({ plugin: host }));
  });
});
