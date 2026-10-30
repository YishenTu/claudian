// @test-ci {"native":true}
import { resolve } from 'node:path';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { nativeRequest, nativeSessionId } from '@test/helpers/deepseek/NativeRequest';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { createDeepSeekWorkspaceServices, deepseekWorkspaceRegistration, type DeepSeekWorkspaceServices } from '@/providers/deepseek/app/DeepSeekWorkspaceServices';
import { deepseekModelPolicy } from '@/providers/deepseek/DeepSeekModelPolicy';
import { encodeDeepSeekModelId } from '@/providers/deepseek/models';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHome';
import { projectDeepSeekModelSettings } from '@/providers/deepseek/settings';

it('discovers native models lazily and preserves explicit selection order and unavailable choices', async () => {
  const peer = new NativePeer(); await peer.open();
  const first = encodeDeepSeekModelId('native/a', 'model/a');
  const second = encodeDeepSeekModelId('native/b', 'model/b');
  const { host, settings, lifecycle: registry } = await createProviderHostFixture({ settings: { providerConfigs: { deepseek: { enabled: true, visibleModels: [second, first], preferredReasoningByModel: { [second]: 'max' } } } }, overrides: {
    getResolvedProviderCliPath: async () => '/bin/dsh',
  } });

  const start = vi.fn(async () => ({ profile: 'web' as const, client: await peer.connect(), onExit: () => () => {}, dispose: async () => {}, writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {} }));
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
        { id: 'native/b', name: 'Native B', models: [{ id: 'model/b', name: 'B', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max', description: 'Deepest' }] } }] },
      ] };
    };
    await workspace.modelCatalog.refresh();
    expect(start).toHaveBeenCalledTimes(1);
    expect(peer.calls.map(call => call.method)).toEqual(['session/list', 'session/modelCatalog']);
    expect(workspace.modelCatalog.getSnapshot().selectedIds).toEqual([second, first]);
    expect(deepseekModelPolicy.getModelOptions(settings).map(option => option.value)).toEqual([second, first]);
    // A group's native display name heads its models; a group without one keeps its id.
    expect(deepseekModelPolicy.getModelOptions(settings).map(option => option.group)).toEqual(['Native B', 'native/a']);
    expect(deepseekModelPolicy.getReasoningOptions(second, settings))
      .toEqual([{ value: 'high', label: 'High' }, { value: 'max', label: 'Max', description: 'Deepest' }]);
    expect(deepseekModelPolicy.getDefaultReasoningValue(second, settings)).toBe('max');
    peer.onCall = method => method === 'session/list' ? { items: [] } : { groups: [{ id: 'native/a', models: [{ id: 'model/a', name: 'A' }] }] };
    await workspace.modelCatalog.refresh({ force: true });
    expect(workspace.modelCatalog.getSnapshot().models.find(model => model.id === second)?.isAvailable).toBe(false);
    expect(workspace.modelCatalog.getSnapshot().selectedIds).toEqual([second, first]);
    expect(projectDeepSeekModelSettings(settings)).toMatchObject({ visibleModels: [second, first], selectedModels: expect.arrayContaining([expect.objectContaining({ encodedId: second, available: false })]) });
    expect(peer.calls.every(call => call.method === 'session/modelCatalog' || call.method === 'session/list')).toBe(true);
    // A malformed native catalog is reported and never replaces the discovered models.
    const discovered = structuredClone(settings.providerConfigs.deepseek!.discoveredModels);
    for (const [catalog, diagnostics] of [
      [{ groups: 'native/a' }, 'Malformed DeepSeek model catalog.'],
      [{ groups: [{ id: 'native/a', models: [{ name: 'Nameless' }] }] }, 'Malformed DeepSeek model.'],
    ] as const) {
      peer.onCall = method => method === 'session/list' ? { items: [] } : catalog;
      expect(await workspace.modelCatalog.refresh({ force: true })).toEqual({ changed: false, diagnostics });
      expect(settings.providerConfigs.deepseek!.discoveredModels).toEqual(discovered);
    }
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('lists vault skills for the dropdown from saved native sessions without activating or creating one', async () => {
  const peer = new NativePeer(); await peer.open();
  const { host, lifecycle: registry } = await createProviderHostFixture({ settings: { providerConfigs: { deepseek: { enabled: true, codeMode: true } } }, overrides: {
    getResolvedProviderCliPath: async () => '/bin/dsh',
  } });

  const start = vi.fn(async () => ({ profile: 'web' as const, client: await peer.connect(), onExit: () => () => {}, dispose: async () => {}, writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {} }));
  // Native list order is not recency order; the newest chat root in the vault owns the catalog.
  const rows = [
    { sessionId: 'older-chat', updatedAt: 1, agentAvailable: false, running: false, blank: false, cwd: host.workingDirectory },
    { sessionId: 'child', updatedAt: 3, agentAvailable: false, running: false, blank: false, cwd: host.workingDirectory, parentSessionId: 'chat', origin: 'subagent' },
    { sessionId: 'chat', updatedAt: 2, agentAvailable: false, running: false, blank: false, cwd: host.workingDirectory },
    { sessionId: 'elsewhere', updatedAt: 5, agentAvailable: false, running: false, blank: false, cwd: '/other' },
    { sessionId: 'title', updatedAt: 4, agentAvailable: false, running: false, blank: false, cwd: host.workingDirectory },
  ];
  const presets: Record<string, string> = { 'older-chat': 'claudian', elsewhere: 'claudian', title: 'claudian-passive', child: 'claudian', chat: 'claudian', saved: 'claudian-code', relocated: 'claudian' };
  let listFailure: Error | undefined;
  peer.onCall = (method, args) => {
    if (method === 'session/list') { if (listFailure) throw listFailure; return { items: rows }; }
    if (method === 'session/projections') return { asOfSeq: 1, values: { agentPreset: presets[nativeSessionId(args)] } };
    if (method === 'skills/list') return { skills: [{ name: `skill-of-${nativeRequest(args).sessionId}`, description: 'Native skill', modelInvocable: true }] };
    throw new Error(`Skill discovery called ${method}.`);
  };
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    const load = (conversation: import('@/core/providers/types').ProviderCommandLoaderContext['conversation'], allowIsolatedMetadataCreation = true) => workspace!.commandLoader!.loadCommands({ allowIsolatedMetadataCreation, conversation, plugin: host });
    // Background tabs never start discovery work.
    expect(await load(null, false)).toMatchObject({ status: 'requires-session' });
    expect(start).not.toHaveBeenCalled();
    const home = getDeepSeekHome(process.env, process.cwd());
    const saved = conversationRecord('saved', { sessionId: 'saved', providerState: { schemaVersion: 1, home, profile: 'web', preset: 'claudian-code' } });
    expect(await load(saved)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-saved', kind: 'skill' }] });
    // Both chat presets mount the same skills (code mode changes tools only); a passive root is never the catalog.
    expect(await load(null)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-chat', kind: 'skill' }] });
    // A conversation saved against another native store cannot name a session in this Host's store.
    const relocated = conversationRecord('relocated', { sessionId: 'relocated', providerState: { schemaVersion: 1, home: `${home}-relocated`, profile: 'web', preset: 'claudian' } });
    expect(await load(relocated)).toMatchObject({ status: 'ready', items: [{ name: 'skill-of-chat', kind: 'skill' }] });
    listFailure = new Error('native store busy');
    expect(await load(null)).toEqual({ status: 'error', message: 'Could not load DeepSeek skills.', retryable: true });
    listFailure = undefined;
    for (const sessionId of ['chat', 'older-chat']) rows.splice(rows.findIndex(row => row.sessionId === sessionId), 1);
    expect(await load(null)).toMatchObject({ status: 'requires-session' });
    expect(peer.calls.some(call => call.method === 'session/create' || call.method === 'commands/list')).toBe(false);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('stops the shared Host before a provider transition and restarts it lazily with the new CLI, environment and preset plugins', async () => {
  const beforeHome = resolve('/homes/before');
  const afterHome = resolve('/homes/after');
  const peer = new NativePeer(); await peer.open();
  let cliPath = '/bin/dsh-before';
  const { host, settings, lifecycle: registry } = await createProviderHostFixture({
    settings: { providerConfigs: { deepseek: { enabled: true, environmentVariables: `DSH_HOME=${beforeHome}`, presetPlugins: '- id: tool-todo\n  name: "@deepseek-ai/dsh-tool-todo"\n' } } },
    overrides: { getResolvedProviderCliPath: async () => cliPath },
  });
  peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
  const launches: Array<{ cliPath: string; home?: string; presetPlugins: unknown }> = [];
  let disposed = 0;
  const start = vi.fn(async (options: { cliPath: string; environment: NodeJS.ProcessEnv; presetPlugins?: unknown }) => {
    launches.push({ cliPath: options.cliPath, home: options.environment.DSH_HOME, presetPlugins: options.presetPlugins });
    const client = await peer.connect();
    return { profile: 'web' as const, client, onExit: () => () => {}, dispose: async () => { client.dispose(); disposed++; }, writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {} };
  });
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    await workspace.startRuntime?.();
    let disposedBeforeMutation: number | undefined;
    await registry.runTransition(['deepseek'], async () => {
      disposedBeforeMutation = disposed;
      settings.providerConfigs.deepseek!.environmentVariables = `DSH_HOME=${afterHome}`;
      settings.providerConfigs.deepseek!.presetPlugins = '';
      cliPath = '/bin/dsh-after';
    });
    // The old process must release its native writers before settings change.
    expect(disposedBeforeMutation).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await workspace.deepseek.read(async (reader, home) => ({ home, value: await reader.call('session/modelCatalog') })))
      .toEqual({ home: afterHome, value: 'session/modelCatalog answered' });
    expect(launches).toEqual([
      { cliPath: '/bin/dsh-before', home: beforeHome, presetPlugins: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }] },
      { cliPath: '/bin/dsh-after', home: afterHome, presetPlugins: [] },
    ]);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('mirrors Claudian archive state onto native sessions in this Host store', async () => {
  expect(deepseekWorkspaceRegistration.providesSessionArchive).toBe(true);
  const peer = new NativePeer(); await peer.open();
  const { host, lifecycle: registry } = await createProviderHostFixture({
    settings: { providerConfigs: { deepseek: { enabled: true } } },
    overrides: { getResolvedProviderCliPath: async () => '/bin/dsh' },
  });
  const start = vi.fn(async () => ({ profile: 'web' as const, client: await peer.connect(), onExit: () => () => {}, dispose: async () => {}, writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {} }));
  peer.onCall = (method, args) => {
    if (method === 'session/list') return { items: [] };
    if (nativeRequest(args)?.sessionId === 'gone') throw Object.assign(new Error('no such session'), { code: 'session/not-found' });
    if (nativeRequest(args)?.sessionId === 'broken') throw new Error('disk full');
    return { archivedSessionIds: [] };
  };
  const home = getDeepSeekHome(process.env, process.cwd());
  const state = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, home, profile: 'web', preset: 'claudian', ...extra });
  const change = (sessionId: string | null, isArchived: boolean, providerState: Record<string, unknown> = state()) => ({ conversation: { sessionId, providerState, messages: [] }, isArchived });
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    await workspace.sessionArchive!.setSessionsArchived([
      change('chat', true),
      // A pending fork has no native session of its own; never archive its source.
      change(null, true, state({ pendingFork: { sessionId: 'source', atSeq: 3 } })),
      // Another store's session id cannot name a session in this Host's store.
      change('relocated', true, state({ home: `${home}-relocated` })),
      change('gone', true),
      change('restored', false),
    ]);
    const mutations = () => peer.calls.filter(call => call.method.startsWith('workspace/')).map(call => [call.method, nativeRequest(call.args)]);
    expect(mutations()).toEqual([
      // Claudian archives only closed sessions; leftover native work must not refuse the archive.
      ['workspace/archiveSession', { sessionId: 'chat', stopActivity: true }],
      ['workspace/archiveSession', { sessionId: 'gone', stopActivity: true }],
      ['workspace/unarchiveSession', { sessionId: 'restored' }],
    ]);
    peer.calls.length = 0;
    await expect(workspace.sessionArchive!.setSessionsArchived([change('broken', true), change('after', false)])).rejects.toThrow('disk full');
    expect(mutations()).toEqual([
      ['workspace/archiveSession', { sessionId: 'broken', stopActivity: true }],
      ['workspace/unarchiveSession', { sessionId: 'after' }],
    ]);
    expect(start).toHaveBeenCalledTimes(1);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});

it('lets an admitted archive finish before a provider transition stops the Host', async () => {
  const peer = new NativePeer(); await peer.open();
  const { host, lifecycle: registry } = await createProviderHostFixture({
    settings: { providerConfigs: { deepseek: { enabled: true } } },
    overrides: { getResolvedProviderCliPath: async () => '/bin/dsh' },
  });
  let disposed = 0;
  const start = vi.fn(async () => {
    const client = await peer.connect();
    return { profile: 'web' as const, client, onExit: () => () => {}, dispose: async () => { client.dispose(); disposed++; }, writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {}, readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {} };
  });
  let answer!: () => void;
  const archived = new Promise<void>(resolve => { answer = resolve; });
  let reached!: () => void;
  const inFlight = new Promise<void>(resolve => { reached = resolve; });
  peer.onCall = async method => {
    if (method === 'session/list') return { items: [] };
    reached(); await archived;
    return { archivedSessionIds: ['chat'] };
  };
  let workspace: DeepSeekWorkspaceServices | undefined;
  try {
    workspace = createDeepSeekWorkspaceServices(host, start);
    const home = getDeepSeekHome(process.env, process.cwd());
    const operation = workspace.sessionArchive!.setSessionsArchived([{ conversation: { sessionId: 'chat', providerState: { schemaVersion: 1, home, profile: 'web', preset: 'claudian' }, messages: [] }, isArchived: true }]);
    await inFlight;
    const transition = registry.runTransition(['deepseek'], async () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    const disposedAtArchive = disposed;
    answer();
    await expect(operation).resolves.toBeUndefined();
    await transition;
    expect(disposedAtArchive).toBe(0);
    expect(disposed).toBe(1);
  } finally { await workspace?.dispose?.(); await registry.dispose(); await peer.close(); }
});
