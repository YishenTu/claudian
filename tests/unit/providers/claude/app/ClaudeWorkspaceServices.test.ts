import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand } from '@/core/types';
import {
  createClaudeWorkspaceServices,
} from '@/providers/claude/app/ClaudeWorkspaceServices';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import { createClaudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

jest.mock('@/providers/claude/ui/ClaudeSettingsTab', () => ({ createClaudeSettingsTabRenderer: jest.fn(() => ({ render: jest.fn() })) }));

function createAdapter(): VaultFileAdapter {
  return {
    delete: jest.fn(),
    deleteFolder: jest.fn(),
    ensureFolder: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
    listFiles: jest.fn().mockResolvedValue([]),
    listFilesRecursive: jest.fn().mockResolvedValue([]),
    listFolders: jest.fn().mockResolvedValue([]),
    read: jest.fn(),
    rename: jest.fn(),
    stat: jest.fn(),
    write: jest.fn(),
  } as unknown as VaultFileAdapter;
}

function createPlugin(
  executionLifecycleRegistry: ProviderExecutionLifecycleRegistry,
): ProviderHost {
  return {
    app: {
      workspace: { onLayoutReady: jest.fn() },
      vault: {
        adapter: { basePath: '/tmp/claude-workspace' },
      },
    },
    executionLifecycleRegistry,
    getActiveEnvironmentVariables: jest.fn(() => ''),
    loadData: jest.fn().mockResolvedValue({}),
    saveData: jest.fn().mockResolvedValue(undefined),
    settings: {},
  } as unknown as ProviderHost;
}

describe('ClaudeWorkspaceServices', () => {
  it.each([true, false])('does not fetch on workspace creation or configuration invalidation (enabled: %s)', async enabled => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const plugin = createPlugin(registry);
    plugin.settings.providerConfigs = { claude: { enabled, visibleModels: [] } };
    plugin.mutateSettingsConditionally = jest.fn(async mutation => { await mutation(plugin.settings); });
    plugin.notifyProviderChatOptionsChanged = jest.fn();
    const modelProbe = jest.fn().mockResolvedValue([{ value: 'sdk-only', label: 'SDK model', description: '' }]);
    const services = await createClaudeWorkspaceServices(plugin, createAdapter(), { modelProbe });
    const ready = plugin.app.workspace.onLayoutReady as jest.Mock;
    expect(modelProbe).not.toHaveBeenCalled();
    await registry.runTransition(['claude'], async () => {});
    expect(services.modelCatalog!.getSnapshot().stale).toBe(true);
    expect(ready).not.toHaveBeenCalled();
    expect(modelProbe).not.toHaveBeenCalled();
    await services.dispose();
    await registry.dispose();
  });

  it.each([false, true])('fences panel discovery across a runtime transition (start during transition: %s)', async startDuring => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const plugin = createPlugin(registry);
    plugin.settings.providerConfigs = { claude: { enabled: true, visibleModels: ['sonnet'] } };
    plugin.mutateSettingsConditionally = jest.fn(async mutation => { await mutation(plugin.settings); });
    plugin.notifyProviderChatOptionsChanged = jest.fn();
    let started!: () => void;
    const probeStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    let signal!: AbortSignal;
    const rows = [{ value: 'sonnet', label: 'Sonnet', description: '' }];
    const modelProbe = jest.fn((_host, probeSignal) => {
      signal = probeSignal;
      started();
      return new Promise<typeof rows>(resolve => {
        release = () => resolve(rows);
        signal.addEventListener('abort', () => resolve([]), { once: true });
      });
    });
    const services = await createClaudeWorkspaceServices(plugin, createAdapter(), { modelProbe });
    const catalog = jest.mocked(createClaudeSettingsTabRenderer).mock.calls.at(-1)![0].modelCatalog;
    let discovery: Promise<unknown> | undefined;
    const ready = () => { discovery = catalog.refresh(); };
    if (!startDuring) { ready(); await probeStarted; }
    await registry.runTransition(['claude'], async () => {
      if (startDuring) ready();
      plugin.settings.userName = 'Updated name';
    });
    await probeStarted;
    expect(signal.aborted).toBe(!startDuring);
    release();
    await discovery;
    expect(getClaudeProviderSettings(plugin.settings).discoveredModels).toEqual(startDuring ? rows : []);
    expect(modelProbe).toHaveBeenCalledTimes(1);
    await services.dispose();
    await registry.dispose();
  });

  it('quiesces the command probe before a Claude provider transition mutation', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const plugin = createPlugin(registry);
    let releaseProbe!: () => void;
    let releaseMutation!: () => void;
    let probeSignal: AbortSignal | undefined;
    const commandProbe = jest.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        probeSignal = signal;
        return new Promise<SlashCommand[]>((resolve) => {
          releaseProbe = () => resolve([]);
        });
      })
      .mockResolvedValueOnce([
        { id: 'sdk:fresh', name: 'fresh', content: '', source: 'sdk' },
      ]);
    const services = await createClaudeWorkspaceServices(
      plugin,
      createAdapter(),
      { commandProbe },
    );
    const load = services.commandCatalog.listDropdownEntries({ includeBuiltIns: false });
    await Promise.resolve();

    let mutationStarted = false;
    const transition = registry.runTransition(['claude'], async () => {
      mutationStarted = true;
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
    });
    for (let index = 0; index < 10 && !probeSignal?.aborted; index += 1) {
      await Promise.resolve();
    }

    expect(probeSignal?.aborted).toBe(true);
    expect(mutationStarted).toBe(false);

    releaseProbe();
    await expect(load).resolves.toEqual([]);
    for (let index = 0; index < 10 && !mutationStarted; index += 1) {
      await Promise.resolve();
    }
    expect(mutationStarted).toBe(true);

    await expect(
      services.commandCatalog.listDropdownEntries({ includeBuiltIns: false }),
    ).resolves.toEqual([]);
    expect(commandProbe).toHaveBeenCalledTimes(1);

    releaseMutation();
    await transition;
    await expect(
      services.commandCatalog.listDropdownEntries({ includeBuiltIns: false }),
    ).resolves.toEqual([
      expect.objectContaining({ name: 'fresh' }),
    ]);
    expect(commandProbe).toHaveBeenCalledTimes(2);

    await services.dispose();
    await registry.dispose();
  });

  it('unregisters its transition hook and awaits probe abortion on disposal', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const unregister = jest.fn();
    jest.spyOn(registry, 'registerTransitionHook').mockReturnValue(unregister);
    const plugin = createPlugin(registry);
    let releaseProbe!: () => void;
    let probeSignal: AbortSignal | undefined;
    const commandProbe = jest.fn((signal?: AbortSignal) => {
      probeSignal = signal;
      return new Promise<[]>((resolve) => {
        releaseProbe = () => resolve([]);
      });
    });
    const services = await createClaudeWorkspaceServices(
      plugin,
      createAdapter(),
      { commandProbe },
    );
    const load = services.commandCatalog.listDropdownEntries({ includeBuiltIns: false });
    await Promise.resolve();

    let disposed = false;
    const disposal = services.dispose().then(() => {
      disposed = true;
    });

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(probeSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseProbe();
    await expect(load).resolves.toEqual([]);
    await disposal;
    expect(disposed).toBe(true);

    await registry.dispose();
  });
});
