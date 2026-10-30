// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { createFixture, turn } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import { type ProviderExecutionEvent } from '@/core/execution';
import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { forkOpencodeSession } from '@/providers/opencode/history/OpencodeSessionFork';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { buildOpencodeRuntimeEnv } from '@/providers/opencode/runtime/OpencodeRuntimeEnvironment';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

it('shares native history and fork operations with catalog and chat transport', async () => {
  const f = await createFixture();
  const service = f.workspace.serverService;
  try {
    await f.workspace.metadataService.loadCatalog();
    const lease = await service.acquire(f.cli, f.root, f.environment);
    const native = await lease.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
    await lease.request(`/api/session/${native.data.id}/model`, { method: 'POST', body: { model: { providerID: 'local', id: 'chat' } } });
    ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
    const history = opencodeProviderRegistration.historyService!;
    const conversation: any = { sessionId: native.data.id, messages: [], providerState: { databasePath: f.environment.OPENCODE_DB } };
    expect(await history.recoverConversationModelSelection!(conversation, f.root, { ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: { ...f.environment, PATH: process.env.PATH }, vaultPath: f.root })).toBe('opencode:local/chat');
    const child = await forkOpencodeSession({ cliPath: f.cli, cwd: f.root, environment: f.environment, sourceSessionId: native.data.id, resolveServerService: async () => service });
    expect(child).not.toBe(native.data.id);
    expect(await lease.request(`/api/session/${child}`)).toMatchObject({ data: { id: child } });
    expect(f.processes()).toHaveLength(1);
    await lease.dispose();
  } finally { ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

it('keeps history, model recovery and forks on a trusted bound database after changing the default', async () => {
  const f = await createFixture();
  let lease;
  try {
    // The bound database lies in an OpenCode data root, so it stays trusted after the default moves.
    const xdgDataHome = path.join(f.root, 'xdg');
    const boundDatabase = path.join(xdgDataHome, 'opencode', 'opencode.db');
    mkdirSync(path.dirname(boundDatabase), { recursive: true });
    writeFileSync(boundDatabase, '');
    updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + `\nXDG_DATA_HOME=${xdgDataHome}` });
    lease = await f.workspace.serverService.acquire(f.cli, f.root, { ...f.environment, XDG_DATA_HOME: xdgDataHome, OPENCODE_DB: boundDatabase });
    const native = await lease.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
    await lease.request(`/api/session/${native.data.id}/model`, { method: 'POST', body: { model: { providerID: 'local', id: 'chat' } } });
    ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
    const history = opencodeProviderRegistration.historyService!;
    const conversation: any = { providerId: 'opencode', sessionId: native.data.id, messages: [], providerState: { databasePath: boundDatabase } };
    const nextDatabase = path.join(f.root, 'replacement.db');
    writeFileSync(nextDatabase, '');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + `\nOPENCODE_DB=${nextDatabase}` });
      opencodeSettingsReconciler.reconcileModelWithEnvironment(f.plugin.settings);
      opencodeSettingsReconciler.invalidateConversationSessions([conversation]);
    });
    const context = { ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: buildOpencodeRuntimeEnv(f.plugin.getRuntimeHost('opencode').environmentText, f.cli), vaultPath: f.root };
    expect(context.environment.OPENCODE_DB).toBe(nextDatabase);
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context)).toBe('opencode:local/chat');
    const hydrated = await history.hydrateConversationHistory(conversation, f.root, context);
    expect(hydrated.providerState?.databasePath).toBe(boundDatabase);
    expect(hydrated.messages?.some(message => message.content === 'Source reply')).toBe(true);
    const child = await history.buildForkProviderState!(native.data.id, 'msg_source', conversation.providerState, f.root, context);
    expect(child.databasePath).toBe(boundDatabase);
    expect(child.sessionId).not.toBe(native.data.id);
    // Execution resumes the same binding on the same database.
    updateOpencodeProviderSettings(f.plugin.settings, { discoveredModels: [{ rawId: 'local/chat', label: 'Chat' }] });
    const session = f.createSession({ resumeSeed: { providerSessionId: native.data.id, providerState: conversation.providerState } });
    try {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute(turn('resumed')).events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(session.getSnapshot()).toMatchObject({ providerSessionId: native.data.id, providerState: { databasePath: boundDatabase } });
    } finally { await session.dispose(); }
    const reader = await f.workspace.serverService.acquire(f.cli, f.root, { ...context.environment, OPENCODE_DB: boundDatabase });
    try { expect(await reader.request(`/api/session/${child.sessionId}`)).toMatchObject({ data: { id: child.sessionId } }); }
    finally { await reader.dispose(); }
  } finally { await lease?.dispose(); ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

it.each(['custom path', 'missing file'] as const)('keeps the locator of an inaccessible bound database (%s) and reads it again once accessible', async mode => {
  const f = await createFixture();
  const bound = f.environment.OPENCODE_DB!;
  writeFileSync(bound + '.sessions.json', JSON.stringify({ sessions: [['ses_bound', { id: 'ses_bound', model: { providerID: 'local', id: 'chat' } }]], deleted: [], sequence: 0 }));
  const transition = (database: string) => f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
    updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + `\nOPENCODE_DB=${database}` });
    opencodeSettingsReconciler.reconcileModelWithEnvironment(f.plugin.settings);
    opencodeSettingsReconciler.invalidateConversationSessions([conversation]);
  });
  const context = () => ({ ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: buildOpencodeRuntimeEnv(f.plugin.getRuntimeHost('opencode').environmentText, f.cli), vaultPath: f.root });
  const conversation: any = { providerId: 'opencode', sessionId: 'ses_bound', messages: [], providerState: { sessionId: 'ses_bound', databasePath: bound } };
  updateOpencodeProviderSettings(f.plugin.settings, { discoveredModels: [{ rawId: 'local/chat', label: 'Chat' }] });
  const execute = async (seed: { providerSessionId?: string; providerState: Record<string, unknown> }) => {
    const session = f.createSession({ resumeSeed: seed });
    const events: ProviderExecutionEvent[] = [];
    try { for await (const event of session.execute(turn('while inaccessible')).events) events.push(event); return { terminal: events.at(-1), snapshot: session.getSnapshot() }; }
    finally { await session.dispose(); }
  };
  ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
  try {
    const history = opencodeProviderRegistration.historyService!;
    // A deferred side fork captures its source database before it executes.
    const fork = await history.buildForkProviderState!('ses_bound', 'msg_source', conversation.providerState, f.root, context(), { lifecycle: 'ephemeral' });
    expect(fork).toMatchObject({ databasePath: bound, forkSource: { sessionId: 'ses_bound' } });
    // A custom database stops being trusted once another one is configured; a missing file is never opened,
    // even while it is still the configured database.
    const replacement = path.join(f.root, 'replacement.db');
    if (mode === 'custom path') {
      writeFileSync(replacement, '');
      // A copied database can contain the same source session.
      writeFileSync(replacement + '.sessions.json', readFileSync(bound + '.sessions.json'));
      await transition(replacement);
    } else {
      rmSync(bound);
    }
    const hydrated: any = await history.hydrateConversationHistory(conversation, f.root, context());
    expect(hydrated.providerState).toEqual({ sessionId: 'ses_bound', databasePath: bound });
    expect(hydrated.messages).toEqual([expect.objectContaining({ id: 'opencode-hydration-error-session-ses_bound' })]);
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context())).toBeNull();
    await expect(history.buildForkProviderState!('ses_bound', 'msg_source', conversation.providerState, f.root, context())).rejects.toThrow();

    // Execution refuses the resume and the deferred fork before acquiring any server.
    const before = f.processes().length;
    const resumed = await execute({ providerSessionId: 'ses_bound', providerState: conversation.providerState });
    expect(resumed.terminal).toMatchObject({ type: 'execution_error', category: 'provider-session-missing', missingProviderSessionId: 'ses_bound' });
    expect(resumed.snapshot).toMatchObject({ providerSessionId: 'ses_bound', providerState: { databasePath: bound } });
    const forked = await execute({ providerState: fork });
    expect(forked.terminal).toMatchObject({ type: 'execution_error', category: 'provider' });
    expect(forked.snapshot.providerSessionId ?? null).toBeNull();
    expect(forked.snapshot.providerState).toMatchObject({ databasePath: bound, forkSource: { sessionId: 'ses_bound' } });
    expect(f.processes()).toHaveLength(before);
    expect(f.processes().filter(process => process.db === bound)).toEqual([]);
    // No database, including a copy holding the source, received a fork child.
    const stored = [bound, replacement].map(database => database + '.sessions.json').filter(store => existsSync(store))
      .flatMap(store => (JSON.parse(readFileSync(store, 'utf8')).sessions as Array<[string]>).map(([id]) => id));
    expect(new Set(stored)).toEqual(new Set(['ses_bound']));

    if (mode === 'custom path') await transition(bound);
    else writeFileSync(bound, '');
    const restored = await history.hydrateConversationHistory(hydrated, f.root, context());
    expect(restored.messages?.map(message => message.content)).toEqual(['Source reply']);
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context())).toBe('opencode:local/chat');
  } finally { ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

it.each(['switch back', 'migrate later'] as const)('runs no execution against an untrusted bound database and recovers its retired session after a %s', async mode => {
  const f = await createFixture();
  const original = f.environment.OPENCODE_DB!;
  const replacement = path.join(f.root, 'replacement.db');
  writeFileSync(replacement, '');
  // The session reaches the original database either before the switch or through a later native migration.
  const migrate = () => writeFileSync(original + '.sessions.json', JSON.stringify({ sessions: [['ses_legacy', { id: 'ses_legacy' }]], deleted: [], sequence: 0 }));
  if (mode === 'switch back') migrate();
  updateOpencodeProviderSettings(f.plugin.settings, { discoveredModels: [{ rawId: 'local/chat', label: 'Chat' }] });
  let conversation: any = { providerId: 'opencode', sessionId: 'ses_legacy', messages: [], providerState: { databasePath: original } };
  const transition = (database: string) => f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
    updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + `\nOPENCODE_DB=${database}` });
    opencodeSettingsReconciler.reconcileModelWithEnvironment(f.plugin.settings);
    opencodeSettingsReconciler.invalidateConversationSessions([conversation]);
  });
  const context = () => ({ ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: buildOpencodeRuntimeEnv(f.plugin.getRuntimeHost('opencode').environmentText, f.cli), vaultPath: f.root });
  const execute = async () => {
    const session = f.createSession({ resumeSeed: { providerSessionId: conversation.sessionId ?? undefined, providerState: conversation.providerState } });
    const events: ProviderExecutionEvent[] = [];
    try { for await (const event of session.execute(turn('after switch')).events) events.push(event); return { terminal: events.at(-1), snapshot: session.getSnapshot() }; }
    finally { await session.dispose(); }
  };
  ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
  try {
    const history = opencodeProviderRegistration.historyService!;
    await transition(replacement);
    conversation = await history.hydrateConversationHistory(conversation, f.root, context());
    expect(conversation).toMatchObject({ sessionId: 'ses_legacy', providerState: { databasePath: original } });

    // History and execution apply one policy: the untrusted database is never launched.
    const missing = await execute();
    expect(missing.terminal).toMatchObject({ type: 'execution_error', category: 'provider-session-missing', missingProviderSessionId: 'ses_legacy' });
    expect(missing.snapshot.providerState).toMatchObject({ databasePath: original });
    expect(f.processes().filter(process => process.db === original)).toEqual([]);
    const retired = await history.resolveMissingConversationSession!(conversation, f.root, 'ses_legacy');
    expect(retired.outcome).toBe('reset');
    conversation = { ...conversation, ...(retired.outcome === 'reset' ? retired.changes : {}) };

    // The next send starts a fresh session on the current database; the retired locator keeps the original.
    const fresh = await execute();
    expect(fresh.terminal).toMatchObject({ type: 'turn_completed' });
    expect(fresh.snapshot).toMatchObject({ providerSessionId: expect.any(String), providerState: { databasePath: replacement, previousSessions: [{ sessionId: 'ses_legacy', databasePath: original }] } });
    expect(f.processes().filter(process => process.db === original)).toEqual([]);
    conversation = { ...conversation, sessionId: fresh.snapshot.providerSessionId, providerState: fresh.snapshot.providerState };

    if (mode === 'migrate later') migrate();
    await transition(original);
    const restored = await history.hydrateConversationHistory(conversation, f.root, context());
    // The retired session reads from its recorded database; the live binding keeps its now-untrusted one.
    expect(restored.messages).toEqual([
      expect.objectContaining({ content: 'Source reply' }),
      expect.objectContaining({ id: `opencode-hydration-error-session-${fresh.snapshot.providerSessionId}` }),
    ]);
    expect(restored.providerState).toMatchObject({ databasePath: replacement, previousSessions: [{ sessionId: 'ses_legacy', databasePath: original }] });
  } finally { ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); }
});

it('initializes the provider-owned service for early history and reuses it for later tab startup and forks', async () => {
  const f = await createFixture();
  await f.workspace.dispose?.();
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.register('opencode', opencodeProviderRegistration.workspace!);
  writeFileSync(f.environment.OPENCODE_DB! + '.sessions.json', JSON.stringify({ sessions: [['source', { id: 'source', model: { providerID: 'local', id: 'chat' } }]], deleted: [], sequence: 1 }));
  const context = {
    ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root),
    environment: { ...f.environment, PATH: process.env.PATH },
    ensureWorkspace: () => ProviderWorkspaceRegistry.ensureInitialized(f.plugin, 'opencode', 'history'),
  };
  const previousSessions = [{ sessionId: 'ses_invalidated', databasePath: f.environment.OPENCODE_DB }];
  const conversation: any = { sessionId: 'source', messages: [], providerState: { databasePath: f.environment.OPENCODE_DB, previousSessions } };
  try {
    const history = opencodeProviderRegistration.historyService;
    expect(await history.recoverConversationModelSelection!(conversation, f.root, context)).toBe('opencode:local/chat');
    const workspace = ProviderWorkspaceRegistry.getIfInitialized('opencode');
    expect(workspace).not.toBeNull();
    await workspace?.startRuntime?.();
    // A fork keeps the source's earlier native sessions as history only.
    expect(await history.buildForkProviderState!('source', 'msg_source', conversation.providerState, f.root, context))
      .toMatchObject({ sessionId: 'ses_2', databasePath: f.environment.OPENCODE_DB, previousSessions });
    expect(f.processes()).toHaveLength(1);
  } finally { await ProviderWorkspaceRegistry.disposeInitialized(); ProviderWorkspaceRegistry.clear(); await f.dispose(); }
});

it.each([
  ['a prewarmed workspace', true],
  ['an uninitialized workspace', false],
] as const)('forks in %s on a v2 runtime with one version probe per native process', async (_, initialized) => {
  const f = await createFixture();
  writeFileSync(f.environment.OPENCODE_DB! + '.sessions.json', JSON.stringify({ sessions: [['source', { id: 'source' }]], deleted: [], sequence: 1 }));
  const probes = () => existsSync(f.log + '.version-count') ? readFileSync(f.log + '.version-count', 'utf8').length : 0;
  ProviderWorkspaceRegistry.clear();
  try {
    if (initialized) {
      ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
      await f.workspace.startRuntime?.();
    }
    const before = probes();
    const context = { ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: f.environment, vaultPath: f.root };
    const state = { databasePath: f.environment.OPENCODE_DB };
    expect(await opencodeProviderRegistration.historyService.buildForkProviderState!('source', 'msg_source', state, f.root, context))
      .toMatchObject({ sessionId: 'ses_2', databasePath: f.environment.OPENCODE_DB });
    // The prewarmed server was already verified; a fork that launches its own server verifies it once.
    expect({ probes: probes() - before, processes: f.processes().length }).toEqual({ probes: initialized ? 0 : 1, processes: 1 });
  } finally { ProviderWorkspaceRegistry.clear(); await f.dispose(); }
});
