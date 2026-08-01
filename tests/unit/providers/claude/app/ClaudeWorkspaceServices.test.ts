import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand } from '@/core/types';
import {
  createClaudeWorkspaceServices,
} from '@/providers/claude/app/ClaudeWorkspaceServices';

function createAdapter(): VaultFileAdapter {
  return {
    append: jest.fn(),
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
