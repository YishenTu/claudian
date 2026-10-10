import { NativePeer } from '@test/helpers/deepseek/NativePeer';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createDeepSeekWorkspaceServices, type DeepSeekWorkspaceServices } from '@/providers/deepseek/app/DeepSeekWorkspaceServices';
import { deepseekModelPolicy } from '@/providers/deepseek/DeepSeekModelPolicy';
import { encodeDeepSeekModelId } from '@/providers/deepseek/models';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHostProcess';
import { projectDeepSeekModelSettings } from '@/providers/deepseek/settings';

it('discovers native models lazily and preserves explicit selection order and unavailable choices', async () => {
  const peer = new NativePeer(); await peer.open();
  const first = encodeDeepSeekModelId('native/a', 'model/a');
  const second = encodeDeepSeekModelId('native/b', 'model/b');
  const settings: any = { providerConfigs: { deepseek: { enabled: true, visibleModels: [second, first], preferredReasoningByModel: { [second]: 'max' } } } };
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = { settings, app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/bin/dsh', notifyProviderChatOptionsChanged: jest.fn(),
    mutateSettings: async (mutation: (settings: any) => unknown) => { await mutation(settings); },
    mutateSettingsConditionally: async (mutation: (settings: any) => unknown) => { await mutation(settings); },
  } as unknown as ProviderHost;
  const start = jest.fn(async () => ({ client: await peer.connect(), onExit: () => () => {}, dispose: async () => {}, writePrompt: async () => {} }));
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    expect(start).not.toHaveBeenCalled();
    peer.onCall = method => method === 'session/list' ? { items: [] } : Promise.reject(new Error(`Warm-up called ${method}.`));
    // Tab presence warms the shared Host without creating a native session.
    await workspace.startRuntime?.();
    expect(start).toHaveBeenCalledTimes(1);
    peer.onCall = method => {
      if (method === 'session/list') return { items: [] };
      if (method !== 'session/modelCatalog') throw new Error('Metadata discovery activated native work.');
      return { default: { provider: 'native/a', model: 'model/a' }, groups: [
        { id: 'native/a', models: [{ id: 'model/a', name: 'A' }] },
        { id: 'native/b', models: [{ id: 'model/b', name: 'B', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }] },
      ] };
    };
    await workspace.modelCatalog.refresh();
    expect(start).toHaveBeenCalledTimes(1);
    expect(peer.calls.map(call => call.method)).toEqual(['session/list', 'session/modelCatalog']);
    expect(workspace.modelCatalog.getSnapshot().selectedIds).toEqual([second, first]);
    expect(deepseekModelPolicy.getModelOptions(settings).map(option => option.value)).toEqual([second, first]);
    expect(deepseekModelPolicy.getReasoningOptions(second, settings)).toEqual([{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]);
    expect(deepseekModelPolicy.getDefaultReasoningValue(second, settings)).toBe('max');
    peer.onCall = method => method === 'session/list' ? { items: [] } : { groups: [{ id: 'native/a', models: [{ id: 'model/a', name: 'A' }] }] };
    await workspace.modelCatalog.refresh({ force: true });
    expect(workspace.modelCatalog.getSnapshot().models.find(model => model.id === second)?.isAvailable).toBe(false);
    expect(workspace.modelCatalog.getSnapshot().selectedIds).toEqual([second, first]);
    expect(projectDeepSeekModelSettings(settings)).toMatchObject({ visibleModels: [second, first], selectedModels: expect.arrayContaining([expect.objectContaining({ encodedId: second, available: false })]) });
    expect(peer.calls.every(call => call.method === 'session/modelCatalog' || call.method === 'session/list')).toBe(true);
    // A malformed native catalog is reported and never replaces the discovered models.
    const discovered = structuredClone(settings.providerConfigs.deepseek.discoveredModels);
    for (const [catalog, diagnostics] of [
      [{ groups: 'native/a' }, 'Malformed DeepSeek model catalog.'],
      [{ groups: [{ id: 'native/a', models: [{ name: 'Nameless' }] }] }, 'Malformed DeepSeek model.'],
    ] as const) {
      peer.onCall = method => method === 'session/list' ? { items: [] } : catalog;
      expect(await workspace.modelCatalog.refresh({ force: true })).toEqual({ changed: false, diagnostics });
      expect(settings.providerConfigs.deepseek.discoveredModels).toEqual(discovered);
    }
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('lists vault skills for the dropdown from saved native sessions without activating or creating one', async () => {
  const peer = new NativePeer(); await peer.open();
  const settings: any = { providerConfigs: { deepseek: { enabled: true, codeMode: true } } };
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = { settings, app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => '/bin/dsh', notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
  const start = jest.fn(async () => ({ client: await peer.connect(), onExit: () => () => {}, dispose: async () => {}, writePrompt: async () => {} }));
  // Native list order is not recency order; the newest chat root in the vault owns the catalog.
  const rows = [
    { sessionId: 'older-chat', updatedAt: 1, agentAvailable: false, running: false, blank: false, cwd: '/vault' },
    { sessionId: 'child', updatedAt: 3, agentAvailable: false, running: false, blank: false, cwd: '/vault', parentSessionId: 'chat', origin: 'subagent' },
    { sessionId: 'chat', updatedAt: 2, agentAvailable: false, running: false, blank: false, cwd: '/vault' },
    { sessionId: 'elsewhere', updatedAt: 5, agentAvailable: false, running: false, blank: false, cwd: '/other' },
    { sessionId: 'title', updatedAt: 4, agentAvailable: false, running: false, blank: false, cwd: '/vault' },
  ];
  const presets: Record<string, string> = { 'older-chat': 'claudian', elsewhere: 'claudian', title: 'claudian-passive', child: 'claudian', chat: 'claudian', saved: 'claudian-code', relocated: 'claudian' };
  let listFailure: Error | undefined;
  peer.onCall = (method, args: any) => {
    if (method === 'session/list') { if (listFailure) throw listFailure; return { items: rows }; }
    if (method === 'session/projections') return { asOfSeq: 1, values: { agentPreset: presets[args.request.sessionId] } };
    if (method === 'skills/list') return { skills: [{ name: `skill-of-${args.request.sessionId}`, description: 'Native skill', modelInvocable: true }] };
    throw new Error(`Skill discovery called ${method}.`);
  };
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    const load = (conversation: any, allowIsolatedMetadataCreation = true) => workspace!.commandLoader!.loadCommands({ allowIsolatedMetadataCreation, conversation, plugin: host });
    // Background tabs never start discovery work.
    expect(await load(null, false)).toMatchObject({ status: 'requires-session' });
    expect(start).not.toHaveBeenCalled();
    const home = getDeepSeekHome(process.env);
    const saved = { sessionId: 'saved', providerState: { schemaVersion: 1, home, profile: 'web', preset: 'claudian-code' } };
    expect(await load(saved)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-saved', kind: 'skill' }] });
    // Both chat presets mount the same skills (code mode changes tools only); auxiliary presets mount none.
    expect(await load(null)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-chat', kind: 'skill' }] });
    // A conversation saved against another native store cannot name a session in this Host's store.
    const relocated = { sessionId: 'relocated', providerState: { schemaVersion: 1, home: `${home}-relocated`, profile: 'web', preset: 'claudian' } };
    expect(await load(relocated)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-chat', kind: 'skill' }] });
    listFailure = new Error('native store busy');
    expect(await load(null)).toEqual({ status: 'error', message: 'Could not load DeepSeek skills.', retryable: true });
    listFailure = undefined;
    for (const sessionId of ['chat', 'older-chat']) rows.splice(rows.findIndex(row => row.sessionId === sessionId), 1);
    expect(await load(null)).toMatchObject({ status: 'requires-session' });
    expect(peer.calls.some(call => call.method === 'session/create' || call.method === 'commands/list')).toBe(false);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('stops the shared Host before a provider transition and restarts it lazily with the new CLI and environment', async () => {
  const peer = new NativePeer(); await peer.open();
  const settings: any = { providerConfigs: { deepseek: { enabled: true, environmentVariables: 'DSH_HOME=/homes/before' } } };
  const registry = new ProviderExecutionLifecycleRegistry();
  let cliPath = '/bin/dsh-before';
  const host = { settings, app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: registry,
    getResolvedProviderCliPath: async () => cliPath, notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
  peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
  const launches: Array<{ cliPath: string; home?: string }> = [];
  let disposed = 0;
  const start = jest.fn(async (options: { cliPath: string; environment: NodeJS.ProcessEnv }) => {
    launches.push({ cliPath: options.cliPath, home: options.environment.DSH_HOME });
    const client = await peer.connect();
    return { client, onExit: () => () => {}, dispose: async () => { client.dispose(); disposed++; }, writePrompt: async () => {} };
  });
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    await workspace.startRuntime?.();
    let disposedBeforeMutation: number | undefined;
    await registry.runTransition(['deepseek'], async () => {
      disposedBeforeMutation = disposed;
      settings.providerConfigs.deepseek.environmentVariables = 'DSH_HOME=/homes/after';
      cliPath = '/bin/dsh-after';
    });
    // The old process must release its native writers before settings change.
    expect(disposedBeforeMutation).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await workspace.deepseek.read(async (reader, home) => ({ home, value: await reader.call('session/modelCatalog') })))
      .toEqual({ home: '/homes/after', value: 'session/modelCatalog answered' });
    expect(launches).toEqual([{ cliPath: '/bin/dsh-before', home: '/homes/before' }, { cliPath: '/bin/dsh-after', home: '/homes/after' }]);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});
