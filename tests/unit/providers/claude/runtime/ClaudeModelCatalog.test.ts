import '@/providers';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { getClaudeModelOptions } from '@/providers/claude/modelOptions';
import { ClaudeModelCatalog } from '@/providers/claude/runtime/ClaudeModelCatalog';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';

const rows = [{ value: 'sonnet', label: 'SDK Sonnet', description: '', resolvedModel: 'gateway-model' }];
function setup(enabled = true) {
  const settings: Record<string, unknown> = { providerConfigs: { claude: { enabled, visibleModels: ['sonnet'], discoveredModels: rows } } };
  const host = {
    settings,
    mutateSettingsConditionally: jest.fn(async fn => fn(settings)),
    notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
  return { settings, host };
}

describe('Claude panel model discovery', () => {
  it('keeps a legacy title selection when discovery canonicalizes its enabled SDK identity', async () => {
    const { settings, host } = setup();
    settings.titleGenerationModel = 'gateway-model';
    updateClaudeProviderSettings(settings, { visibleModels: null, discoveredModels: [], environmentVariables: 'ANTHROPIC_MODEL=gateway-model' });
    host.notifyProviderChatOptionsChanged = () => {
      ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
    };
    await new ClaudeModelCatalog(host, async () => rows).refresh();
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['sonnet']);
    expect(settings.titleGenerationModel).toBe('gateway-model');
  });

  it('preserves explicitly saved choices and order when the SDK catalog changes', async () => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, { visibleModels: ['gateway-model', 'removed-model'] });
    await new ClaudeModelCatalog(host, async () => rows).refresh();
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['gateway-model', 'removed-model']);
  });

  it('retains a historical title ID through settings load until SDK evidence arrives', async () => {
    const { settings, host } = setup();
    settings.titleGenerationModel = 'claude-fable-5';
    updateClaudeProviderSettings(settings, { visibleModels: null, discoveredModels: [] });
    ProviderSettingsCoordinator.normalizeAllModelVariants(settings);
    expect(settings.titleGenerationModel).toBe('claude-fable-5');
    expect(getClaudeModelOptions(settings)).toHaveLength(0);
    host.notifyProviderChatOptionsChanged = () => {
      ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
    };
    await new ClaudeModelCatalog(host, async () => [
      { value: 'fable', label: 'Fable', description: '', resolvedModel: 'claude-fable-5' },
    ]).refresh();
    expect(settings.titleGenerationModel).toBe('claude-fable-5');
  });

  it.each([['opus', false], ['default', true]] as const)(
    'claims a shared raw title identity only when the other SDK choice (%s) is hidden', (value, expected) => {
      const { settings } = setup();
      updateClaudeProviderSettings(settings, {
        discoveredModels: [...rows, { value, label: value, description: '', resolvedModel: 'gateway-model' }],
      });
      expect(claudeChatUIConfig.ownsModel('gateway-model', settings)).toBe(expected);
    },
  );

  it('skips disabled providers and fetches when enabled', async () => {
    const { settings, host } = setup(false);
    const probe = jest.fn().mockResolvedValue(rows);
    const catalog = new ClaudeModelCatalog(host, probe);
    await catalog.refresh();
    expect(probe).not.toHaveBeenCalled();
    updateClaudeProviderSettings(settings, { enabled: true });
    await catalog.refresh();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getClaudeModelOptions(settings)[0].label).toBe('SDK Sonnet');
  });

  it('keeps cached rows during a manual refresh and retains them on configuration invalidation', async () => {
    const { settings, host } = setup();
    let release!: (value: typeof rows) => void;
    const probe = jest.fn(() => new Promise<typeof rows>(resolve => { release = resolve; }));
    const catalog = new ClaudeModelCatalog(host, probe);
    const refresh = catalog.refresh();
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    release(rows);
    await refresh;
    await catalog.cancel();
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['sonnet']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports a failed fetch without retries or synthetic models', async () => {
    const { settings, host } = setup();
    const probe = jest.fn().mockRejectedValue(new Error('private endpoint details'));
    const result = await new ClaudeModelCatalog(host, probe).refresh();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    expect(result.diagnostics).toContain('refresh the model list');
  });

  it('cancels discovery on configuration change and waits for a manual refresh', async () => {
    const { settings, host } = setup();
    let release!: (value: typeof rows) => void;
    let oldSignal!: AbortSignal;
    const freshRows = [{ value: 'haiku', label: 'Fresh model', description: '', resolvedModel: 'new-gateway-model' }];
    const probe = jest.fn()
      .mockImplementationOnce((_host, signal) => {
        oldSignal = signal;
        return new Promise<typeof rows>(resolve => { release = resolve; });
      })
      .mockResolvedValueOnce(freshRows);
    const catalog = new ClaudeModelCatalog(host, probe);
    const startup = catalog.refresh();
    await Promise.resolve();
    const invalidation = catalog.cancel();
    expect(oldSignal.aborted).toBe(true);
    release(rows);
    await Promise.all([startup, invalidation]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(rows);
    await catalog.refresh();
    expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(freshRows);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'dispose'])('never publishes an obsolete result after %s', async action => {
    const { settings, host } = setup();
    let release!: (value: typeof rows) => void;
    let signal!: AbortSignal;
    const probe = jest.fn((_host, probeSignal) => {
      signal = probeSignal;
      return new Promise<typeof rows>(resolve => { release = resolve; });
    });
    const catalog = new ClaudeModelCatalog(host, probe);
    const startup = catalog.refresh();
    await Promise.resolve();
    if (action === 'disable') updateClaudeProviderSettings(settings, { enabled: false });
    const stop = action === 'disable'
      ? catalog.cancel()
      : catalog.dispose();
    expect(signal.aborted).toBe(true);
    release([{ value: 'haiku', label: 'Stale refresh', description: '', resolvedModel: 'stale' }]);
    await Promise.all([stop, startup]);
    expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(rows);
    expect(host.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    updateClaudeProviderSettings(settings, { enabled: true });
    expect(getClaudeModelOptions(settings)[0].label).toBe('SDK Sonnet');
    await catalog.dispose();
  });
});

it('does not join an aborted native discovery and still drains it on dispose', async () => {
  const { settings, host } = setup();
  let finishOld!: (value: typeof rows) => void;
  const fresh = [{ value: 'sonnet', label: 'Fresh catalog', description: '', resolvedModel: 'fresh' }];
  const probe = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(fresh);
  const catalog = new ClaudeModelCatalog(host, probe);
  const controller = new AbortController();
  const old = catalog.refresh(controller.signal);
  controller.abort();
  const replacement = catalog.refresh();
  expect(probe).toHaveBeenCalledTimes(2);
  await replacement;
  expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(fresh);
  let disposed = false;
  const disposal = catalog.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finishOld(rows);
  await Promise.all([old, disposal]);
  expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(fresh);
  expect(host.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1);
});
