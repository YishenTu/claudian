import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { SlashCommand } from '@/core/types';
import {
  createClaudeWorkspaceServices,
} from '@/providers/claude/app/ClaudeWorkspaceServices';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

describe('ClaudeWorkspaceServices', () => {
  it.each([true, false])('does not fetch on workspace creation or configuration invalidation (enabled: %s)', async enabled => {
    const { host: plugin, lifecycle: registry, settings } = await createProviderHostFixture();
    settings.providerConfigs = { claude: { enabled, visibleModels: [] } };
    const catalogProbe = vi.fn().mockResolvedValue({ models: [{ value: 'sdk-only', label: 'SDK model', description: '' }], outputStyles: [] });
    const services = await createClaudeWorkspaceServices(plugin, { catalogProbe });
    expect(catalogProbe).not.toHaveBeenCalled();
    await registry.runTransition(['claude'], async () => {});
    expect(services.modelCatalog!.getSnapshot().stale).toBe(true);
    expect(catalogProbe).not.toHaveBeenCalled();
    await services.dispose();
    await registry.dispose();
  });

  it.each([false, true])('fences panel discovery across a runtime transition (start during transition: %s)', async startDuring => {
    const { host: plugin, lifecycle: registry, settings } = await createProviderHostFixture();
    settings.providerConfigs = { claude: { enabled: true, visibleModels: ['sonnet'] } };
    let started!: () => void;
    const probeStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    let signal!: AbortSignal;
    const rows = [{ value: 'sonnet', label: 'Sonnet', description: '' }];
    const catalogProbe = vi.fn((_host, probeSignal) => {
      signal = probeSignal;
      started();
      return new Promise<{ models: typeof rows; outputStyles: string[] }>(resolve => {
        release = () => resolve({ models: rows, outputStyles: [] });
        signal.addEventListener('abort', () => resolve({ models: [], outputStyles: [] }), { once: true });
      });
    });
    const services = await createClaudeWorkspaceServices(plugin, { catalogProbe });
    const catalog = services.modelCatalog!;
    let discovery: Promise<unknown> | undefined;
    const ready = () => { discovery = catalog.refresh(); };
    if (!startDuring) { ready(); await probeStarted; }
    await registry.runTransition(['claude'], async () => {
      if (startDuring) ready();
      settings.userName = 'Updated name';
    });
    await probeStarted;
    expect(signal.aborted).toBe(!startDuring);
    release();
    await discovery;
    expect(getClaudeProviderSettings(plugin.settings).discoveredModels).toEqual(startDuring ? rows : []);
    expect(catalogProbe).toHaveBeenCalledTimes(1);
    await services.dispose();
    await registry.dispose();
  });

  it('quiesces the command probe before a Claude provider transition mutation', async () => {
    const { host: plugin, lifecycle: registry } = await createProviderHostFixture();
    let releaseProbe!: () => void;
    let releaseMutation!: () => void;
    let probeSignal: AbortSignal | undefined;
    let notifyAborted!: () => void;
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve; });
    let notifyMutation!: () => void;
    const mutation = new Promise<void>(resolve => { notifyMutation = resolve; });
    const commandProbe = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        probeSignal = signal;
        signal?.addEventListener('abort', () => notifyAborted(), { once: true });
        return new Promise<SlashCommand[]>((resolve) => {
          releaseProbe = () => resolve([]);
        });
      })
      .mockResolvedValueOnce([
        { id: 'sdk:fresh', name: 'fresh', content: '', source: 'sdk' },
      ]);
    const services = await createClaudeWorkspaceServices(
      plugin,
      { commandProbe },
    );
    const load = services.commandCatalog.listDropdownEntries({ includeBuiltIns: false });
    await Promise.resolve();

    let mutationStarted = false;
    const transition = registry.runTransition(['claude'], async () => {
      mutationStarted = true;
      notifyMutation();
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
    });
    await aborted;

    expect(probeSignal?.aborted).toBe(true);
    expect(mutationStarted).toBe(false);

    releaseProbe();
    await expect(load).resolves.toEqual([]);
    await mutation;
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
    const { host: plugin, lifecycle: registry } = await createProviderHostFixture();
    const register = vi.spyOn(registry, 'registerTransitionHook');
    let releaseProbe!: () => void;
    let probeSignal: AbortSignal | undefined;
    const commandProbe = vi.fn((signal?: AbortSignal) => {
      probeSignal = signal;
      return new Promise<[]>((resolve) => {
        releaseProbe = () => resolve([]);
      });
    });
    const services = await createClaudeWorkspaceServices(
      plugin,
      { commandProbe },
    );
    const load = services.commandCatalog.listDropdownEntries({ includeBuiltIns: false });
    await Promise.resolve();

    let disposed = false;
    const disposal = services.dispose().then(() => {
      disposed = true;
    });

    const hook = register.mock.calls[0][1];
    const beforeTransition = vi.spyOn(hook, 'beforeTransition');
    expect(probeSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseProbe();
    await expect(load).resolves.toEqual([]);
    await disposal;
    expect(disposed).toBe(true);
    await registry.runTransition(['claude'], async () => {});
    expect(beforeTransition).not.toHaveBeenCalled();

    await registry.dispose();
  });
});
