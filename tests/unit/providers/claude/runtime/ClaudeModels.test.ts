import '@/providers';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { getClaudeModelOptions } from '@/providers/claude/modelOptions';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import type { ClaudeModelProbe } from '@/providers/claude/runtime/ClaudeModels';
import { createClaudeModels, discoverClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
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

function discover(host: ProviderHost, probe: ClaudeModelProbe) {
  return discoverClaudeModels(host, new AbortController().signal, probe);
}

function catalogFor(host: ProviderHost, probe: ClaudeModelProbe) {
  return createClaudeModels(host, signal => discoverClaudeModels(host, signal, probe));
}

describe('Claude panel model discovery', () => {
  it.each([
    { selected: null, expected: ['haiku', 'sonnet', 'opus[1m]', 'fable'] },
    { selected: ['opus', 'opus[1m]', 'removed-model'], expected: ['opus[1m]', 'removed-model'] },
    { selected: [], expected: [] },
    { selected: ['claude-opus-4', 'sonnet[1m]'], expected: ['opus[1m]', 'sonnet[1m]'] },
  ])('repairs legacy selections $selected without enabling other models', async ({ selected, expected }) => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, {
      visibleModels: selected,
      modelAliases: { opus: 'Old label', 'opus[1m]': 'Explicit label' },
    });
    await discover(host, async () => [
      ...rows, { value: 'opus[1m]', label: 'Opus', description: '' },
    ]);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(expected);
    expect(getClaudeProviderSettings(settings).modelAliases['opus[1m]']).toBe('Explicit label');
  });

  it('migrates a family selection to its highest reported version', async () => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, { visibleModels: ['opus'] });
    await discover(host, async () => [
      { value: 'opus[1m]', label: 'Opus 1M', description: '' },
      { value: 'claude-opus-5-5', label: 'Opus', description: '' },
    ]);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['claude-opus-5-5']);
    expect(getClaudeModelOptions(settings).map(model => model.value)).toEqual(['claude-code/claude-opus-5-5']);
  });

  it('follows a retired pinned version to its successor on the next discovery', async () => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, { visibleModels: ['fable', 'sonnet'], modelAliases: { fable: 'My Fable' } });
    const shared = [
      { ...rows[0], reasoningMetadataResolved: true },
      { value: 'opus[1m]', label: 'Opus', description: '', resolvedModel: 'claude-opus-5-5[1m]', reasoningMetadataResolved: true },
    ];
    await discover(host, async () => [
      ...shared, { value: 'claude-fable-5-1', label: 'Fable', description: '', reasoningMetadataResolved: true },
    ]);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['claude-fable-5-1', 'sonnet']);
    expect(getClaudeProviderSettings(settings).modelAliases).toEqual({ 'claude-fable-5-1': 'My Fable' });

    await discover(host, async () => [
      ...shared, { value: 'claude-fable-5-2', label: 'Fable', description: '', reasoningMetadataResolved: true },
    ]);

    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['claude-fable-5-2', 'sonnet']);
    expect(getClaudeProviderSettings(settings).modelAliases).toEqual({ 'claude-fable-5-2': 'My Fable' });
    expect(getClaudeModelOptions(settings).map(model => [model.value, model.label]))
      .toEqual([['claude-code/claude-fable-5-2', 'My Fable'], ['sonnet', 'SDK Sonnet']]);
    expect(claudeProviderRegistration.settingsStorage?.needsReasoningMetadata?.(settings)).toBe(false);
  });

  it('respects deselection while native discovery is pending', async () => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, { visibleModels: ['opus'] });
    let finish!: (value: Array<{ value: string; label: string; description: string }>) => void;
    const refresh = discover(host, () => new Promise(resolve => { finish = resolve; }));
    updateClaudeProviderSettings(settings, { visibleModels: [] });
    finish([{ value: 'opus[1m]', label: 'Opus', description: '' }]);
    await refresh;
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual([]);
    expect(getClaudeModelOptions(settings)).toEqual([]);
  });

  it('keeps a legacy title selection when discovery canonicalizes its enabled SDK identity', async () => {
    const { settings, host } = setup();
    settings.titleGenerationModel = 'gateway-model';
    updateClaudeProviderSettings(settings, { visibleModels: null, discoveredModels: [], environmentVariables: 'ANTHROPIC_MODEL=gateway-model' });
    host.notifyProviderChatOptionsChanged = () => {
      ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
    };
    await discover(host, async () => rows);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['sonnet']);
    expect(settings.titleGenerationModel).toBe('gateway-model');
  });

  it('preserves explicitly saved choices and order when the SDK catalog changes', async () => {
    const { settings, host } = setup();
    updateClaudeProviderSettings(settings, { visibleModels: ['gateway-model', 'removed-model'] });
    await discover(host, async () => rows);
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
    await discover(host, async () => [
      { value: 'fable', label: 'Fable', description: '', resolvedModel: 'claude-fable-5' },
    ]);
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
    const catalog = catalogFor(host, probe);
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
    const catalog = catalogFor(host, probe);
    const refresh = catalog.refresh();
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    release(rows);
    await refresh;
    catalog.markStale();
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['sonnet']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports the failure reason without retries or synthetic models', async () => {
    const { settings, host } = setup();
    const probe = jest.fn().mockRejectedValue(new Error('Claude Code exited with code 1'));
    const catalog = catalogFor(host, probe);
    const result = await catalog.refresh();
    expect(catalog.getSnapshot()).toMatchObject({ status: 'failed', error: 'Claude Code exited with code 1' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getClaudeModelOptions(settings)).toHaveLength(1);
    expect(result.diagnostics).toBe('Claude Code exited with code 1');
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
    const catalog = catalogFor(host, probe);
    const startup = catalog.refresh();
    await Promise.resolve();
    catalog.markStale();
    expect(oldSignal.aborted).toBe(true);
    release(rows);
    await Promise.all([startup, catalog.quiesce()]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(rows);
    expect(host.notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
    await catalog.refresh({ force: true });
    expect(getClaudeProviderSettings(settings).discoveredModels).toEqual(freshRows);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'dispose'])('never publishes an obsolete result after %s', async action => {
    const { settings, host } = setup();
    let release!: (value: typeof rows) => void;
    let signal!: AbortSignal;
    const probe = jest.fn((_host: ProviderHost, probeSignal: AbortSignal) => {
      signal = probeSignal;
      return new Promise<typeof rows>(resolve => { release = resolve; });
    });
    const catalog = catalogFor(host, probe);
    const startup = catalog.refresh();
    await Promise.resolve();
    // Disabling alone does not abort discovery; the write-back guard must still refuse it.
    if (action === 'disable') updateClaudeProviderSettings(settings, { enabled: false });
    const stop = action === 'disable' ? Promise.resolve() : catalog.dispose();
    expect(signal.aborted).toBe(action === 'dispose');
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
