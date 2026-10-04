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

  it('runs provider transitions through the application lifecycle registry', async () => {
    const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
    const runTransition = jest.spyOn(executionLifecycleRegistry, 'runTransition')
      .mockImplementation(async (_providerIds, mutation) => mutation({} as ProviderExecutionTransitionScope));
    const host = createHost({ executionLifecycleRegistry });
    const mutation = jest.fn(async () => 'result');

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
    const sessionArchive = { setSessionsArchived: jest.fn() } as unknown as ProviderSessionArchive;
    const initializeArchive = jest.fn(async () => ({ sessionArchive }));
    const initializePlain = jest.fn(async () => ({}));
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
