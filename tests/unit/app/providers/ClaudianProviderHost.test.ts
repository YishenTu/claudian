import { ClaudianProviderHost } from '@/app/providers/ClaudianProviderHost';
import type ClaudianPlugin from '@/main';

function createPlugin(overrides: Record<string, unknown> = {}): ClaudianPlugin {
  return {
    app: {},
    executionLifecycleRegistry: {},
    settings: {},
    storage: {},
    manifest: { version: '1.2.3' },
    saveSettings: jest.fn(async () => undefined),
    loadData: jest.fn(async () => ({})),
    saveData: jest.fn(async () => undefined),
    normalizeModelVariantSettings: jest.fn(() => false),
    getActiveEnvironmentVariables: jest.fn(() => 'OPENAI_API_KEY=test'),
    getEnvironmentVariablesForScope: jest.fn(() => 'SHARED=value'),
    applyEnvironmentVariables: jest.fn(async () => undefined),
    applyEnvironmentVariablesBatch: jest.fn(async () => undefined),
    applyProviderRuntimeSettings: jest.fn(async () => undefined),
    getResolvedProviderCliPath: jest.fn(() => '/usr/bin/provider'),
    runProviderExecutionTransition: jest.fn(
      async (_providerIds: string[], mutation: () => Promise<unknown>) => mutation(),
    ),
    getAllViews: jest.fn(() => []),
    getView: jest.fn(() => null),
    ...overrides,
  } as unknown as ClaudianPlugin;
}

describe('ClaudianProviderHost', () => {
  it('delegates provider capabilities without exposing plugin lifecycle APIs', async () => {
    const trace: string[] = [];
    const plugin = createPlugin({
      saveSettings: jest.fn(async () => { trace.push('save'); }),
      applyEnvironmentVariables: jest.fn(async () => { trace.push('environment'); }),
      getResolvedProviderCliPath: jest.fn(() => {
        trace.push('cli');
        return '/usr/bin/codex';
      }),
    });
    const host = new ClaudianProviderHost(plugin);

    await host.saveSettings();
    await host.applyEnvironmentVariables('provider:codex', 'OPENAI_API_KEY=test');
    await expect(host.getResolvedProviderCliPath('codex')).resolves.toBe('/usr/bin/codex');

    expect(trace).toEqual(['save', 'environment', 'cli']);
    expect('registerView' in host).toBe(false);
    expect('addCommand' in host).toBe(false);
  });

  it('routes provider chat-option changes to every view with provider scope', () => {
    const firstRefresh = jest.fn();
    const secondRefresh = jest.fn();
    const plugin = createPlugin({
      getAllViews: jest.fn(() => [
        { refreshModelSelector: firstRefresh },
        { refreshModelSelector: secondRefresh },
      ]),
    });
    const host = new ClaudianProviderHost(plugin);

    host.notifyProviderChatOptionsChanged('codex');

    expect(firstRefresh).toHaveBeenCalledWith('codex');
    expect(secondRefresh).toHaveBeenCalledWith('codex');
  });

  it('delegates execution transitions through the application lifecycle registry', async () => {
    const executionLifecycleRegistry = {};
    const mutation = jest.fn(async () => 'result');
    const runProviderExecutionTransition = jest.fn(
      async (_providerIds: string[], callback: () => Promise<string>) => callback(),
    );
    const plugin = createPlugin({
      executionLifecycleRegistry,
      runProviderExecutionTransition,
    });
    const host = new ClaudianProviderHost(plugin);

    expect(host.executionLifecycleRegistry).toBe(executionLifecycleRegistry);
    await expect(
      host.runProviderExecutionTransition(['opencode', 'claude'], mutation),
    ).resolves.toBe('result');

    expect(runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode', 'claude'],
      mutation,
    );
  });

  it('delegates atomic provider runtime settings changes', async () => {
    const mutation = jest.fn();
    const onApplied = jest.fn();
    const applyProviderRuntimeSettings = jest.fn(async () => undefined);
    const plugin = createPlugin({ applyProviderRuntimeSettings });
    const host = new ClaudianProviderHost(plugin);

    await host.applyProviderRuntimeSettings(['codex'], mutation, onApplied);

    expect(applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['codex'],
      mutation,
      onApplied,
    );
  });

});
