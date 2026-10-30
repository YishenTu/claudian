/** @vitest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';
import { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ClaudianSettings, Conversation, ConversationMutablePatch, ProjectReader } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import type { SessionSignal } from '@/features/chat/sessions/ChatSessionRuntime';
import { getSessionSettingsSnapshot } from '@/features/chat/sessions/sessionSettings';

function setup(options: { projects?: ProjectReader; members?: Record<string, string> } = {}) {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const backend = new FakeSideBackend();
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  // Sonnet has effort control; Haiku has none.
  const catalog = claudeCatalogFixture(['claude-sonnet-4-5', 'claude-haiku-4-5'], ['low', 'high']);
  delete (catalog.discoveredModels[1] as { supportedEffortLevels?: string[] }).supportedEffortLevels;
  const settings = {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    lastSelectedChatModel: { providerId: 'claude', model: 'claude-sonnet-4-5' },
    providerConfigs: { claude: catalog },
  } as unknown as ClaudianSettings;
  const record = (id: string, activityOffset = 0): Conversation => ({
    id, sessionId: null, providerId: 'claude', selectedModel: settings.model, title: id === 'sender' ? 'Research' : id,
    messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate({ minutes: activityOffset }).getTime(),
  } as Conversation);
  // The recipient is the most recently active session; the caller is older.
  const records = new Map([['sender', -1], ['recipient', 0], ['archived', 1]].map(([id, offset]) => [id, record(id as string, offset as number)]));
  records.get('archived')!.isArchived = true;
  for (const [id, projectId] of Object.entries(options.members ?? {})) {
    records.set(id, { ...(records.get(id) ?? record(id, -2)), projectId });
  }
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => '/vault', onConversationDeleted: async () => undefined,
    persistence: {
      metadataReader: { revalidate: vi.fn(), load: vi.fn(), scan: vi.fn(), loadMetadata: vi.fn(), scanMetadata: vi.fn(), listMetadata: vi.fn() },
      saveMetadata: async () => undefined, deleteCurrentMetadata: async () => undefined, assignMetadataToDevice: async () => undefined,
    } as ConversationPersistence,
  });
  repository.replaceAll([...records.values()]);
  const saves: ConversationMutablePatch[] = [];
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = {
    app, settings, providerHost: { app, settings, executionLifecycleRegistry: registry },
    getCommittedSettings: () => settings, getActiveEnvironmentVariables: () => '',
    projects: options.projects ?? createProjectsFake(),
    getConversationSummary: (id: string) => repository.getSync(id),
    getConversationSync: (id: string) => repository.getSync(id),
    getCachedConversation: (id: string) => repository.getSync(id),
    getConversationById: async (id: string) => repository.getSync(id),
    getConversationList: () => repository.list(),
    ensureConversationMetadataLoaded: async () => { repository.mergeMetadataConversations([...records.values()]); },
    renameConversation: async () => undefined,
    updateConversation: async (id: string, patch: ConversationMutablePatch) => {
      saves.push(structuredClone(patch));
      await repository.update(id, patch);
    },
    createConversation: vi.fn(async () => { const created = record('created'); records.set(created.id, created); return created; }),
    mutateSettings: async (mutate: (settings: ClaudianSettings) => void) => mutate(settings),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  } as unknown as ChatFeatureHost;
  const settled: string[] = [];
  const signals: Array<{ sessionId: string; signal: SessionSignal }> = [];
  const pool = installSessionRuntimePool(host, {
    onSessionSettled: id => settled.push(id),
    onSessionSignal: (sessionId, signal) => signals.push({ sessionId, signal: structuredClone(signal) }),
  });
  const refreshModelControls = vi.fn();
  const views = { openSession: vi.fn(async (_id: string, _options: { focus: boolean }) => undefined) };
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => 'sender', refreshModelControls });
  Object.assign(host, { bindSessionTools: (id: string) => service.bindSessionTools(id) });
  const binding = service.bindSessionTools('sender');
  return { host, pool, service, binding, records, repository, backend, saves, record, refreshModelControls, settled, signals, views };
}
const requestText = (request: ProviderExecutionRequest) => request.input.filter(block => block.type === 'text').map(block => block.text).join('');
const signal = () => new AbortController().signal;
const modelChoice = ({ configuration }: ProviderExecutionRequest) => ({ model: configuration.model, reasoning: configuration.reasoning });
afterEach(() => { ProviderWorkspaceRegistry.clear(); vi.restoreAllMocks(); });

const listArgs = (overrides: Partial<{ includeProviders: boolean; limit: number }> = {}) => ({ includeProviders: false, limit: 50, ...overrides });

it('lists recent sessions first without creating runtimes, omitting archived records and providers', async () => {
  const h = setup();
  expect(await h.binding.port.list(listArgs(), signal())).toEqual({ sessions: [
    { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
    { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true, self: true },
  ] });
  expect(await h.binding.port.list(listArgs({ limit: 1 }), signal())).toEqual({ sessions: [
    { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
  ], truncated: true });
  // `self` follows the calling binding, independently of the user's active view.
  expect((await h.service.bindSessionTools('recipient').port.list(listArgs(), signal())).sessions).toEqual([
    { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false, self: true },
    { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true },
  ]);
  expect(h.pool.getAll()).toHaveLength(0);
  expect(h.backend.sessions).toHaveLength(0);
});

describe('project scope', () => {
  const members = { sender: 'project-1', recipient: 'project-1', archived: 'project-1', outsider: 'project-2' };
  const sessionIds = (result: { readonly sessions: readonly { sessionId: string }[] }) => result.sessions.map(session => session.sessionId);

  it('lists only the caller\'s non-archived fellow members of its live project, leaving unscoped listing unchanged', async () => {
    const h = setup({ members, projects: createProjectsFake([projectRecord({ id: 'project-1' }), projectRecord({ id: 'project-2' })]) });
    const scoped = await h.binding.port.list({ ...listArgs(), project: true }, signal());
    expect(scoped.sessions).toEqual([
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
      { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true, self: true },
    ]);
    expect(sessionIds(await h.binding.port.list({ ...listArgs(), project: false }, signal()))).toEqual(['recipient', 'sender', 'outsider']);
    expect(sessionIds(await h.binding.port.list(listArgs(), signal()))).toEqual(['recipient', 'sender', 'outsider']);
  });

  it.each([
    ['not a member', {}],
    ['a member of a deleted project', members],
  ])('rejects a project listing from a caller that is %s', async (_case, callerMembers) => {
    const h = setup({ members: callerMembers, projects: createProjectsFake([projectRecord({ id: 'project-2' })]) });
    await expect(h.binding.port.list({ ...listArgs(), project: true }, signal())).rejects.toThrow('This session is not in a project.');
  });

  // Creation keeps the id only while the project is live (ConversationRepository project membership tests).
  it('starts a new session in the caller\'s project', async () => {
    const h = setup({ members });
    await h.binding.port.send({ text: 'Take this over' }, signal());
    expect(h.host.createConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.host.createConversation).mock.calls[0][0]?.projectId).toBe('project-1');
  });
});

it('lists enabled providers with available models, new-session defaults and reasoning, read fresh', async () => {
  const h = setup();
  const sonnet = 'claude-code/claude-sonnet-4-5';
  const haiku = 'claude-code/claude-haiku-4-5';
  const { providers } = await h.binding.port.list(listArgs({ includeProviders: true }), signal());
  expect(providers).toEqual([{ provider: 'claude', default: true, models: [
    { id: sonnet, default: true, reasoning: { options: ['low', 'high'], default: 'high' } },
    { id: haiku },
  ] }]);

  // A later user choice of the future-tab model is reflected by the next call.
  await h.host.mutateSettings(settings => { settings.lastSelectedChatModel = { providerId: 'claude', model: 'claude-haiku-4-5' }; });
  const fresh = await h.binding.port.list(listArgs({ includeProviders: true }), signal());
  expect(fresh.providers?.[0]?.models).toEqual([
    { id: sonnet, reasoning: { options: ['low', 'high'], default: 'high' } },
    { id: haiku, default: true },
  ]);
  expect(h.pool.getAll()).toHaveLength(0);
});

it('delivers to a cold headless recipient with caller provenance and no composer capture', async () => {
  const h = setup();
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Review this' }, signal()))
    .toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'started' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(decodeSessionMessage(requestText(h.backend.latest.requests[0]))).toEqual({ from: 'Research', sessionId: 'sender', text: 'Review this' });
  expect(h.backend.latest.config.sessionTools).toBeDefined();
  expect(h.pool.getAttachment('recipient')).toBeNull();
  h.backend.latest.complete();
  await h.pool.get('recipient')!.turns.drain();
  await waitFor(() => expect(h.saves.some(patch => patch.messages?.some(message => message.sessionMessage?.sessionId === 'sender'))).toBe(true));
});

it('keeps FIFO mailbox turns behind queued user input without consuming recovered input', async () => {
  const h = setup();
  const runtime = h.pool.ensure({ conversationId: 'recipient', providerId: 'claude', draftModel: null });
  // Keep the real model present while checking its unsent draft.
  await runtime.withModel(async model => {
    const sending = model.inputController.sendMessage({ content: 'User first' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    await model.inputController.sendMessage({ content: 'User second' });
    model.composer.restore('main', { content: 'Keep my draft' });
    for (const text of ['Mailbox one', 'Mailbox two']) {
      expect(await h.binding.port.send({ sessionId: 'recipient', text }, signal())).toMatchObject({ status: 'queued' });
    }
    h.backend.latest.complete();
    await sending;
    await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
    expect(requestText(h.backend.latest.requests[1])).toContain('User second');
    h.backend.latest.complete();
    await waitFor(() => expect(h.backend.latest.requests).toHaveLength(3));
    expect(decodeSessionMessage(requestText(h.backend.latest.requests[2]))?.text).toBe('Mailbox one');
    h.backend.latest.complete();
    await waitFor(() => expect(h.backend.latest.requests).toHaveLength(4));
    expect(decodeSessionMessage(requestText(h.backend.latest.requests[3]))?.text).toBe('Mailbox two');
    h.backend.latest.complete();
    await runtime.turns.drain();
    expect(model.composer.hasRecovery).toBe(true);
  });
});

it('reads stored transcripts by id, archived included, loading metadata the deferred scan has not admitted', async () => {
  const h = setup();
  const time = testDate().getTime();
  h.records.get('archived')!.messages = [
    { id: 'u', role: 'user', content: 'q1', timestamp: time },
    { id: 'a', role: 'assistant', content: 'a1', timestamp: time },
  ];
  // Startup admits restored sessions only; the archived one is still waiting for the background scan.
  h.repository.replaceAll([...h.records.values()].filter(record => record.id !== 'archived'));
  const read = await h.binding.port.read({ sessionId: 'archived' }, signal());
  expect(read).toEqual({
    sessionId: 'archived', title: 'archived', provider: 'claude', status: 'idle',
    content: expect.stringContaining('ID: archived\nProvider: claude'), fromTurn: 1, toTurn: 1, totalTurns: 1,
  });
  expect(read.content).toContain('## T1 user\nq1\n\n## T1 assistant\na1');
  expect(await h.binding.port.read({ sessionId: 'archived', beforeTurn: 1 }, signal())).toMatchObject({ fromTurn: 0, toTurn: 0, totalTurns: 1 });
  await expect(h.binding.port.read({ sessionId: 'missing' }, signal())).rejects.toThrow('The session does not exist');
  expect(h.pool.getAll()).toHaveLength(0);
});

it('reads a live session from its runtime, omitting the turn still running', async () => {
  const h = setup();
  await h.binding.port.send({ sessionId: 'recipient', text: 'Review this' }, signal());
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.backend.latest.emitText('Looks good');
  expect(await h.binding.port.read({ sessionId: 'recipient' }, signal())).toMatchObject({ status: 'running', totalTurns: 0 });
  h.backend.latest.complete();
  await h.pool.get('recipient')!.turns.drain();
  // Storage is stale; only the runtime's transcript has the finished turn.
  Object.assign(h.host, { getConversationById: async (id: string) => ({ ...h.records.get(id)!, messages: [] }) });
  const read = await h.binding.port.read({ sessionId: 'recipient' }, signal());
  expect(read).toMatchObject({ status: 'idle', fromTurn: 1, toTurn: 1, totalTurns: 1 });
  expect(read.content).toContain('Review this');
  expect(read.content).toContain('## T1 assistant\nLooks good');
});

it('interrupts a running recipient, delivers the interrupting message next and keeps other queued messages', async () => {
  const h = setup();
  await h.binding.port.send({ sessionId: 'recipient', text: 'Long task' }, signal());
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const native = h.backend.latest;
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Later' }, signal())).toMatchObject({ status: 'queued' });
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Do Y instead', mode: 'interrupt' }, signal()))
    .toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'interrupted' });
  expect(native.cancelCalls).toBe(1);
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(decodeSessionMessage(requestText(native.requests[1]))?.text).toBe('Do Y instead');
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(3));
  expect(decodeSessionMessage(requestText(native.requests[2]))?.text).toBe('Later');
  native.complete();
  await h.pool.get('recipient')!.turns.drain();
});

it('stops without a message, returning the user\'s queued input to the composer', async () => {
  const h = setup();
  const runtime = h.pool.ensure({ conversationId: 'recipient', providerId: 'claude', draftModel: null });
  await runtime.withModel(async model => {
    const sending = model.inputController.sendMessage({ content: 'User task' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    await model.inputController.sendMessage({ content: 'User follow-up' });
    expect(await h.binding.port.send({ sessionId: 'recipient', mode: 'interrupt' }, signal())).toMatchObject({ status: 'interrupted' });
    await sending;
    await runtime.turns.drain();
    // Stopped like the user's Stop: the queued follow-up does not run; it is held for the composer.
    expect(h.backend.latest.requests).toHaveLength(1);
    expect(model.composer.hasRecovery).toBe(true);
  });
  expect(await h.binding.port.send({ sessionId: 'recipient', mode: 'interrupt' }, signal())).toMatchObject({ status: 'idle' });
  expect(h.backend.latest.cancelCalls).toBe(1);
});

it('steers into a running turn with a sender line, and queues when the recipient cannot take a steer', async () => {
  const h = setup();
  // An idle recipient has no turn to steer: the message starts one instead.
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Start', mode: 'steer' }, signal())).toMatchObject({ status: 'started' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const native = h.backend.latest;
  const steers: ProviderExecutionRequest[] = [];
  Object.assign(native, { steer: async (request: ProviderExecutionRequest) => { steers.push(request); return true; } });
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Also check X', mode: 'steer' }, signal()))
    .toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'steered' });
  expect(decodeSessionMessage(requestText(steers[0]))).toEqual({ from: 'Research', sessionId: 'sender', text: 'Also check X' });
  // The turn's own input echoes first; the next echo is the steer.
  native.emitOutput({ type: 'user_message_started', content: requestText(native.requests[0]), nativeUserMessageId: 'native-start' });
  native.emitOutput({ type: 'user_message_started', content: requestText(steers[0]), nativeUserMessageId: 'native-steer' });
  const model = h.pool.get('recipient')!.peekModel!;
  await waitFor(() => expect(model.state.messages.find(message => message.userMessageId === 'native-steer')).toMatchObject({
    displayContent: 'Also check X', sessionMessage: { from: 'Research', sessionId: 'sender' },
  }));
  // A provider that definitely refuses the steer leaves the message queued, never in the composer.
  Object.assign(native, { steer: async () => false });
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Refused steer', mode: 'steer' }, signal())).toMatchObject({ status: 'queued' });
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(decodeSessionMessage(requestText(native.requests[1]))?.text).toBe('Refused steer');
  expect(model.composer.hasRecovery).toBe(false);
  native.complete();
  await h.pool.get('recipient')!.turns.drain();
});

it('queues a steer while the recipient waits on a question, and never resends an uncertain steer', async () => {
  const h = setup();
  await h.binding.port.send({ sessionId: 'recipient', text: 'Start' }, signal());
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const native = h.backend.latest;
  const steer = vi.fn(async (_request: ProviderExecutionRequest) => true);
  Object.assign(native, { steer });
  const port = native.config.interactionPort;
  const question = port.askUserQuestion({
    interactionId: 'q', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
    input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: '' }] }] },
  }, new AbortController().signal).catch(() => null);
  const model = h.pool.get('recipient')!.peekModel!;
  await waitFor(() => expect(model.hasPendingInteraction).toBe(true));
  // The user must answer first: the message waits in the mailbox instead of reaching the native steer.
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'While asking', mode: 'steer' }, signal())).toMatchObject({ status: 'queued' });
  expect(steer).not.toHaveBeenCalled();
  port.dismissInteraction('q', 'native-rejected');
  await question;
  // A steer whose handoff outcome is unknown is reported, not queued again.
  Object.assign(native, { steer: async () => { throw new Error('Transport closed'); } });
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Lost?', mode: 'steer' }, signal())).toMatchObject({ status: 'uncertain' });
  native.complete();
  await waitFor(() => expect(native.requests).toHaveLength(2));
  expect(decodeSessionMessage(requestText(native.requests[1]))?.text).toBe('While asking');
  native.complete();
  await h.pool.get('recipient')!.turns.drain();
  expect(native.requests.map(request => decodeSessionMessage(requestText(request))?.text)).toEqual(['Start', 'While asking']);
});

it.each(['sender', 'archived', 'missing'])('rejects unavailable recipient %s without creating a runtime', async sessionId => {
  const h = setup();
  await expect(h.binding.port.send({ sessionId, text: 'Hello' }, signal())).rejects.toThrow();
  expect(h.pool.getAll()).toHaveLength(0);
});

it.each([
  ['an unknown provider', { provider: 'nope', model: 'm' }, /^Unknown or disabled provider "nope"\. Available: claude$/],
  ['an unavailable model', { model: 'unavailable' },
    /^Unknown model "unavailable" for claude\. Available: claude-code\/claude-sonnet-4-5, claude-code\/claude-haiku-4-5$/],
  ['an unsupported reasoning level', { model: 'claude-sonnet-4-5', reasoning: 'max' },
    /^Unknown reasoning "max" for claude model claude-code\/claude-sonnet-4-5\. Available: low, high$/],
  ['reasoning for a model without effort control', { model: 'claude-haiku-4-5', reasoning: 'low' },
    /^Model claude-code\/claude-haiku-4-5 for claude has no reasoning control\.$/],
])('rejects %s before creating a shell, listing the valid options', async (_label, choice, error) => {
  const h = setup();
  await expect(h.binding.port.send({ text: 'Hello', ...choice }, signal())).rejects.toThrow(error);
  expect(h.host.createConversation).not.toHaveBeenCalled();
});

it('applies an explicit model and reasoning to the new session before its first turn', async () => {
  const h = setup();
  expect(await h.binding.port.send({ text: 'New task', provider: 'claude', model: 'claude-sonnet-4-5', reasoning: 'low' }, signal()))
    .toEqual({ sessionId: 'created', title: 'created', provider: 'claude', status: 'started' });
  expect(h.host.createConversation).toHaveBeenCalledWith({ providerId: 'claude', selectedModel: 'claude-code/claude-sonnet-4-5' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(modelChoice(h.backend.latest.requests[0])).toEqual({ model: 'claude-code/claude-sonnet-4-5', reasoning: 'low' });
  // The session-owned choice does not rewrite the user's saved effort.
  expect(h.host.settings.effortLevel).toBe('high');
  h.backend.latest.complete();
  await h.pool.get('created')!.turns.drain();
});

it('keeps a published shell on cancellation and joins creation during shutdown', async () => {
  const h = setup();
  const created = h.record('created');
  const completion = deferred<Conversation>();
  vi.mocked(h.host.createConversation).mockImplementation(async () => {
    h.records.set(created.id, created);
    return completion.promise;
  });
  const sending = h.binding.port.send({ text: 'Hello' }, signal());
  const rejected = sending.catch(error => error as unknown);
  await waitFor(() => expect(h.host.createConversation).toHaveBeenCalled());
  h.service.beginShutdown();
  let drained = false;
  const draining = h.service.dispose().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(h.records.get('created')).toBe(created);
  completion.resolve(created);
  expect(await rejected).toBeInstanceOf(Error);
  await draining;
  expect(h.records.get('created')).toBe(created);
  expect(h.pool.get('created')).toBeNull();
});

it('revokes released caller bindings without cancelling an already admitted recipient', async () => {
  const h = setup();
  await h.binding.port.send({ sessionId: 'recipient', text: 'Keep working' }, signal());
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.binding.dispose();
  await expect(h.binding.port.list(listArgs(), signal())).rejects.toThrow();
  expect(h.backend.latest.cancelCalls).toBe(0);
  h.backend.latest.complete();
  await h.pool.get('recipient')!.turns.drain();
});

it('defers a message when native background work starts during preparation, then resumes once', async () => {
  const h = setup();
  const preparing = deferred<void>();
  vi.spyOn(h.host.executionPersistence, 'assertConversationExecutionAuthority').mockImplementationOnce(() => preparing.promise);
  await h.binding.port.send({ sessionId: 'recipient', text: 'After background' }, signal());
  await waitFor(() => expect(h.host.executionPersistence.assertConversationExecutionAuthority).toHaveBeenCalled());
  const native = h.backend.latest;
  native.emitBackgroundEvent({ type: 'background_turn_started' });
  const runtime = h.pool.get('recipient')!;
  await waitFor(() => expect(runtime.hasBackgroundWork).toBe(true));
  preparing.resolve();
  await waitFor(() => expect(runtime.mailbox!.hasPending || native.requests.length > 0).toBe(true));
  expect(native.requests).toHaveLength(0);
  expect(runtime.mailbox!.hasPending).toBe(true);
  expect((await h.binding.port.list(listArgs(), signal())).sessions.find(item => item.sessionId === 'recipient')?.status).toBe('running');
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'provider-ended' });
  await waitFor(() => expect(native.requests).toHaveLength(1));
  native.complete();
  await runtime.turns.drain();
  expect(runtime.mailbox!.hasPending).toBe(false);
});

it('creates a headless session using the selected default without mutating the future-tab seed', async () => {
  const h = setup();
  const seed = structuredClone(h.host.settings.lastSelectedChatModel);
  expect(await h.binding.port.send({ text: 'New task' }, signal())).toEqual({ sessionId: 'created', title: 'created', provider: 'claude', status: 'started' });
  expect(h.host.createConversation).toHaveBeenCalledWith({ providerId: 'claude', selectedModel: 'claude-code/claude-sonnet-4-5' });
  expect(h.host.settings.lastSelectedChatModel).toEqual(seed);
  expect(h.pool.getAttachment('created')).toBeNull();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(modelChoice(h.backend.latest.requests[0])).toEqual({ model: 'claude-code/claude-sonnet-4-5', reasoning: 'high' });
  h.backend.latest.complete();
  await h.pool.get('created')!.turns.drain();
});

it('waits for a published first-turn shell to adopt its original draft runtime', async () => {
  const h = setup();
  Object.assign(h.host.app.workspace, { getActiveFile: () => null });
  const created = h.record('created');
  const completion = deferred<Conversation>();
  vi.mocked(h.host.createConversation).mockImplementation(async () => {
    h.records.set(created.id, created);
    return completion.promise;
  });
  const { attachment } = h.pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'claude-sonnet-4-5' }, { reveal() {} });
  const original = attachment.runtime;
  const first = original.withModel(model => model.inputController.sendMessage({ content: 'Original user task' }));
  const firstResult = first.catch(error => error as unknown);
  await waitFor(() => expect(h.records.has('created')).toBe(true));
  const sending = h.binding.port.send({ sessionId: 'created', text: 'Mailbox follow-up' }, signal());
  // Creation has published its metadata, but its original runtime has not adopted the ID yet.
  await new Promise(resolve => setTimeout(resolve, 0));
  try { expect(h.pool.get('created')).toBeNull(); }
  finally {
    const duplicate = h.pool.get('created');
    if (duplicate) { duplicate.cancelTurn('user'); await duplicate.turns.drain(); await h.pool.retire('created'); }
    completion.resolve(created);
  }
  await sending;
  await waitFor(() => expect(h.backend.sessions[0]?.requests.length).toBeGreaterThan(0));
  expect(h.pool.get('created')).toBe(original);
  expect(requestText(h.backend.latest.requests[0])).toBe('Original user task');
  h.backend.latest.complete();
  expect(await firstResult).toBeUndefined();
  await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
  expect(decodeSessionMessage(requestText(h.backend.latest.requests[1]))?.text).toBe('Mailbox follow-up');
  h.backend.latest.complete();
  await original.turns.drain();
});

const sonnetId = 'claude-code/claude-sonnet-4-5';
const haikuId = 'claude-code/claude-haiku-4-5';

it('switches an existing session\'s reasoning for the delivered turn and later user turns, not the running one', async () => {
  const h = setup();
  const runtime = h.pool.ensure({ conversationId: 'recipient', providerId: 'claude', draftModel: null });
  await runtime.withModel(async model => {
    const running = model.inputController.sendMessage({ content: 'User first' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Go faster', reasoning: 'low' }, signal()))
      .toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'queued' });
    expect(h.refreshModelControls).toHaveBeenCalledWith('claude');
    h.backend.latest.complete();
    await running;
    await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
    expect(modelChoice(h.backend.latest.requests[0])).toEqual({ model: sonnetId, reasoning: 'high' });
    expect(decodeSessionMessage(requestText(h.backend.latest.requests[1]))?.text).toBe('Go faster');
    expect(modelChoice(h.backend.latest.requests[1])).toEqual({ model: sonnetId, reasoning: 'low' });
    h.backend.latest.complete();
    await runtime.turns.drain();
    const later = model.inputController.sendMessage({ content: 'User later' });
    await waitFor(() => expect(h.backend.latest.requests).toHaveLength(3));
    expect(modelChoice(h.backend.latest.requests[2])).toEqual({ model: sonnetId, reasoning: 'low' });
    h.backend.latest.complete();
    await later;
  });
  // The saved preference is untouched; the choice belongs to the session.
  expect(h.host.settings.effortLevel).toBe('high');
});

it('switches a history-only session\'s model without opening it in a tab', async () => {
  const h = setup();
  expect(h.pool.get('recipient')).toBeNull();
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Use Haiku', model: 'claude-haiku-4-5' }, signal()))
    .toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'started' });
  expect(h.host.getConversationSummary('recipient')!.selectedModel).toBe(haikuId);
  expect(h.pool.getAttachment('recipient')).toBeNull();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(modelChoice(h.backend.latest.requests[0])).toEqual({ model: haikuId, reasoning: null });
  h.backend.latest.complete();
  await h.pool.get('recipient')!.turns.drain();
});

it.each([
  ['an unavailable model', { sessionId: 'recipient', model: 'unavailable' },
    /^Unknown model "unavailable" for claude\. Available: claude-code\/claude-sonnet-4-5, claude-code\/claude-haiku-4-5$/],
  ['an unsupported reasoning level', { sessionId: 'recipient', reasoning: 'max' },
    /^Unknown reasoning "max" for claude model claude-code\/claude-sonnet-4-5\. Available: low, high$/],
  ['reasoning for the switched model without effort control', { sessionId: 'recipient', model: 'claude-haiku-4-5', reasoning: 'low' },
    /^Model claude-code\/claude-haiku-4-5 for claude has no reasoning control\.$/],
  ['a self-send', { sessionId: 'sender', model: 'claude-haiku-4-5', reasoning: 'low' }, /cannot send a message to itself/],
  ['an archived destination', { sessionId: 'archived', model: 'claude-haiku-4-5' }, /does not exist or is archived/],
])('rejects an existing-session switch with %s and changes nothing', async (_label, choice, error) => {
  const h = setup();
  const runtime = h.pool.ensure({ conversationId: choice.sessionId, providerId: 'claude', draftModel: null });
  const before = getSessionSettingsSnapshot(runtime, h.host);
  await expect(h.binding.port.send({ text: 'Hello', ...choice }, signal())).rejects.toThrow(error);
  expect(h.records.get(choice.sessionId)!.selectedModel).toBe('claude-sonnet-4-5');
  expect(h.saves).toEqual([]);
  const after = getSessionSettingsSnapshot(runtime, h.host);
  expect({ model: after.model, reasoning: after.reasoning }).toEqual({ model: before.model, reasoning: before.reasoning });
  expect(runtime.mailbox?.hasPending ?? false).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
});

it('applies no switch when the call is cancelled before admission', async () => {
  const h = setup();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(h.binding.port.send({ sessionId: 'recipient', text: 'Hello', model: 'claude-haiku-4-5' }, cancelled.signal)).rejects.toThrow();
  expect(h.records.get('recipient')!.selectedModel).toBe('claude-sonnet-4-5');
  expect(h.pool.get('recipient')).toBeNull();
});

describe('outside-client API', () => {
  it.each([
    { label: 'tool only', finalText: undefined, isError: false, interrupted: false, trailingNotification: false, expected: '(no reply)' },
    { label: 'blank text after work', finalText: ' \n', isError: false, interrupted: false, trailingNotification: false, expected: '(no reply)' },
    { label: 'failed tool', finalText: undefined, isError: true, interrupted: false, trailingNotification: false, expected: '(error)' },
    { label: 'stopped after work', finalText: undefined, isError: false, interrupted: true, trailingNotification: false, expected: '(interrupted)' },
    { label: 'final text after work', finalText: 'The note is up to date.', isError: false, interrupted: false, trailingNotification: false, expected: 'The note is up to date.' },
    { label: 'notification after final text', finalText: 'The note is up to date.', isError: false, interrupted: false, trailingNotification: true, expected: 'The note is up to date.' },
  ])('reads the final answer after notification-split work: $label', async ({ finalText, isError, interrupted, trailingNotification, expected }) => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    const model = h.pool.get('recipient')!.peekModel!;
    native.emitText('I will inspect the note.');
    await waitFor(() => expect(model.state.currentTextContent).toContain('I will inspect the note.'));
    native.emitSessionEvent({ type: 'task_notification', content: 'An earlier task finished.' });
    native.emitOutput({ type: 'tool_started', toolCallId: 'inspect', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } });
    native.emitOutput({ type: 'tool_completed', toolCallId: 'inspect', toolScope: { kind: 'main' }, content: 'Current note content.', isError });
    if (finalText) native.emitText(finalText);
    await waitFor(() => expect(model.state.currentTextContent).toBe(finalText ?? ''));
    if (trailingNotification) {
      native.emitSessionEvent({ type: 'task_notification', content: 'Another earlier task finished.' });
    }
    if (interrupted) native.cancel();
    else native.complete();
    await h.pool.get('recipient')!.turns.drain();

    expect(model.state.messages.some(message => message.responseContinuationOf !== undefined)).toBe(true);
    expect(await api.read('recipient')).toBe(expected);
  });

  it('delivers client text as the user\'s own prompt, reports the active session, and reads the finished reply', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    expect(api.version).toBe(1);
    expect(api.getActiveSessionId()).toBe('sender');
    expect(await api.send('recipient', { text: 'What is next?' })).toBe('started');
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    // No session envelope: the provider receives exactly what the user said.
    expect(requestText(h.backend.latest.requests[0])).toBe('What is next?');
    h.backend.latest.emitText('Ship the release.');
    h.backend.latest.complete();
    await h.pool.get('recipient')!.turns.drain();
    await waitFor(() => expect(h.settled).toEqual(['recipient']));
    expect(await api.read('recipient')).toBe('Ship the release.');
    // Persisted as an ordinary user prompt, so history shows no session sender.
    const prompt = await waitFor(() => {
      const saved = h.saves.flatMap(patch => patch.messages ?? []).find(message => message.role === 'user');
      expect(saved).toBeDefined();
      return saved!;
    });
    expect(prompt).toMatchObject({ content: 'What is next?', displayContent: 'What is next?' });
    expect(prompt.sessionMessage).toBeUndefined();
  });

  it('reads no reply from a first turn that is still running after a steer', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    const steers: ProviderExecutionRequest[] = [];
    Object.assign(native, { steer: async (request: ProviderExecutionRequest) => { steers.push(request); return true; } });
    native.emitText('I am still inspecting.');
    expect(await api.send('recipient', { text: 'Also check the links', mode: 'steer' })).toBe('steered');
    native.emitOutput({ type: 'user_message_started', content: requestText(native.requests[0]), nativeUserMessageId: 'native-start' });
    native.emitOutput({ type: 'user_message_started', content: requestText(steers[0]), nativeUserMessageId: 'native-steer' });
    const model = h.pool.get('recipient')!.peekModel!;
    await waitFor(() => expect(model.state.messages.some(message => message.userMessageId === 'native-steer')).toBe(true));
    expect(await api.read('recipient')).toBe('');
    native.emitText('Both look fine.');
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    expect(await api.read('recipient')).toBe('Both look fine.');
  });

  it('stops a running session through send without text, and requires text otherwise', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await expect(api.send('recipient', {})).rejects.toThrow('"text" is required unless mode is "interrupt"');
    await expect(api.send('recipient', { mode: 'steer' })).rejects.toThrow('"text" is required unless mode is "interrupt"');
    await api.send('recipient', { text: 'Long task' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    expect(h.settled).toEqual([]);
    expect(await api.send('recipient', { mode: 'interrupt' })).toBe('interrupted');
    expect(h.backend.latest.cancelCalls).toBe(1);
    await h.pool.get('recipient')!.turns.drain();
    await waitFor(() => expect(h.settled).toEqual(['recipient']));
    expect(await api.send('recipient', { mode: 'interrupt' })).toBe('idle');
  });
  it('lists sessions like the list tool, with live status and no caller row', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    expect(await api.listSessions()).toEqual({ sessions: [
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
      { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true },
    ] });
    expect(await api.listSessions({ limit: 1 })).toEqual({ sessions: [
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
    ], truncated: true });
    await expect(api.listSessions({ limit: 0 })).rejects.toThrow('"limit" must be an integer from 1 to 200.');
    await api.send('recipient', { text: 'Start' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    expect((await api.listSessions()).sessions[0]).toMatchObject({ sessionId: 'recipient', status: 'running' });
    const native = h.backend.latest;
    const question = native.config.interactionPort.askUserQuestion({
      interactionId: 'q', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: '' }] }] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await waitFor(async () => expect((await api.listSessions()).sessions[0]).toMatchObject({ status: 'awaiting-user' }));
    native.config.interactionPort.dismissInteraction('q', 'native-rejected');
    await expect(question).rejects.toThrow('Provider interaction is stale');
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('signals every streamed block as received: thinking and text with their position, tools by id', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    native.emitOutput({ type: 'thinking_delta', text: 'Plan' });
    native.emitText('I will ');
    native.emitText('look.');
    native.emitOutput({ type: 'tool_started', toolCallId: 'inspect', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } });
    native.emitOutput({ type: 'tool_completed', toolCallId: 'inspect', toolScope: { kind: 'main' }, content: 'Content.', isError: false });
    native.emitText('Done.');
    native.emitOutput({ type: 'notice', message: 'Rate limited', level: 'warning' });
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    const progress = h.signals.filter(entry => entry.signal.type === 'progress');
    expect(progress.every(entry => entry.sessionId === 'recipient')).toBe(true);
    const messageId = (progress[0].signal as { progress: { messageId: string } }).progress.messageId;
    expect(progress.map(entry => (entry.signal as { progress: unknown }).progress)).toEqual([
      { kind: 'thinking', messageId, blockIndex: 0, text: 'Plan' },
      { kind: 'text', messageId, blockIndex: 1, text: 'I will ' },
      { kind: 'text', messageId, blockIndex: 1, text: 'I will look.' },
      { kind: 'tool', messageId, toolId: 'inspect', toolName: 'Read', status: 'running' },
      { kind: 'tool', messageId, toolId: 'inspect', toolName: 'Read', status: 'completed' },
      { kind: 'text', messageId, blockIndex: 3, text: 'Done.' },
      // Notices join the open text block exactly as the transcript shows them.
      { kind: 'text', messageId, blockIndex: 3, text: 'Done.\n\n⚠️ **Warning:** Rate limited' },
    ]);
  });

  it('signals a notice after thinking as a new text block, and a terminal execution error as text', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    native.emitOutput({ type: 'thinking_delta', text: 'Plan' });
    native.emitOutput({ type: 'notice', message: 'Slow', level: 'info' });
    native.emitText('Answer');
    native.emitOutput({ type: 'execution_error', category: 'provider', message: 'Overloaded', recoverable: false });
    await h.pool.get('recipient')!.turns.drain();
    const progress = h.signals.filter(entry => entry.signal.type === 'progress')
      .map(entry => (entry.signal as { progress: { kind: string; blockIndex?: number; text?: string } }).progress)
      .map(({ kind, blockIndex, text }) => ({ kind, blockIndex, text }));
    expect(progress).toEqual([
      { kind: 'thinking', blockIndex: 0, text: 'Plan' },
      { kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** Slow' },
      { kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** SlowAnswer' },
      { kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** SlowAnswer\n\n**Error:** Overloaded' },
    ]);
  });

  it('opens only existing, unarchived sessions, without moving focus unless asked', async () => {
    const h = setup();
    const api = createClaudianAPI(h.service, h.views);
    await expect(api.openSession('archived')).rejects.toThrow('The session does not exist or is archived');
    await expect(api.openSession('missing')).rejects.toThrow('The session does not exist or is archived');
    expect(h.views.openSession).not.toHaveBeenCalled();
    await api.openSession('recipient');
    await api.openSession('recipient', { focus: true });
    expect(h.views.openSession.mock.calls).toEqual([['recipient', { focus: false }], ['recipient', { focus: true }]]);
  });

  async function startWithInteractionPort(h: ReturnType<typeof setup>) {
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Start' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    return { api, native, port: native.config.interactionPort };
  }
  const interactionSignals = (h: ReturnType<typeof setup>) => h.signals
    .filter(entry => entry.signal.type === 'interaction')
    .map(entry => ({ sessionId: entry.sessionId, ...(entry.signal as object) }));

  it('exposes every approval option with its decision and answers with the chosen one', async () => {
    const h = setup();
    const { api, native, port } = await startWithInteractionPort(h);
    const approval = port.requestApproval({
      interactionId: 'approve', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'approval',
      toolName: 'Bash', input: { command: 'ls' }, description: 'ls', blockedPath: '/outside',
    }, new AbortController().signal);
    approval.catch(() => undefined);
    await waitFor(() => expect(api.getPendingInteractions('recipient')).toHaveLength(1));
    const [pending] = api.getPendingInteractions('recipient');
    expect(pending).toMatchObject({
      interactionId: 'approve', kind: 'approval', toolName: 'Bash', description: 'ls', blockedPath: '/outside',
    });
    expect(pending.questions).toHaveLength(1);
    expect(pending.questions[0]).toMatchObject({ multiSelect: false, isOther: false, isSecret: false });
    expect(pending.questions[0].options.map(option => option.decision)).toEqual(['deny', 'allow', 'allow-always']);
    const always = pending.questions[0].options.find(option => option.decision === 'allow-always')!;
    const key = pending.questions[0].id ?? pending.questions[0].question;
    await expect(api.answerInteraction('recipient', 'approve', { [key]: 'Not an option' })).rejects.toThrow();
    expect(api.getPendingInteractions('recipient')).toHaveLength(1);
    await api.answerInteraction('recipient', 'approve', { [key]: always.value });
    expect(await approval).toEqual({ interactionId: 'approve', decision: 'allow-always' });
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    expect(interactionSignals(h)).toEqual([
      { sessionId: 'recipient', type: 'interaction', interactionId: 'approve', pending: true },
      { sessionId: 'recipient', type: 'interaction', interactionId: 'approve', pending: false },
    ]);
    await expect(api.answerInteraction('recipient', 'approve', { [key]: always.value })).rejects.toThrow();
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('answers a question with an option or custom text only where the question accepts it', async () => {
    const h = setup();
    const { api, native, port } = await startWithInteractionPort(h);
    const question = port.askUserQuestion({
      interactionId: 'ask', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [
        { id: 'color', question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }], isOther: true },
        { question: 'Which sizes?', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }], multiSelect: true },
      ] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await waitFor(() => expect(api.getPendingInteractions('recipient')).toHaveLength(1));
    expect(api.getPendingInteractions('recipient')[0]).toEqual({
      interactionId: 'ask', kind: 'question', questions: [
        { id: 'color', header: 'Color', question: 'Which color?', multiSelect: false, isOther: true, isSecret: false,
          options: [{ label: 'Red', value: 'Red', description: 'warm' }] },
        { header: 'Q2', question: 'Which sizes?', multiSelect: true, isOther: false, isSecret: false,
          options: [{ label: 'S', value: 'S', description: '' }, { label: 'M', value: 'M', description: '' }] },
      ],
    });
    // Free text only where isOther allows it; every question needs an answer.
    await expect(api.answerInteraction('recipient', 'ask', { color: 'Red', 'Which sizes?': ['XL'] })).rejects.toThrow();
    await expect(api.answerInteraction('recipient', 'ask', { color: 'Red' })).rejects.toThrow();
    await api.answerInteraction('recipient', 'ask', { color: 'Teal', 'Which sizes?': ['S', 'M'] });
    expect(await question).toEqual({ interactionId: 'ask', answers: { color: 'Teal', 'Which sizes?': ['S', 'M'] } });
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('answers an async question only once its reply is delivered as the next prompt', async () => {
    const h = setup();
    const { api, native } = await startWithInteractionPort(h);
    native.emitOutput({ type: 'tool_started', toolCallId: 'ask-tool', toolScope: { kind: 'main' }, name: 'AskUserQuestion', input: {
      replyMode: 'user-message', questions: [{ question: 'Which file?', options: [{ label: 'a.md', description: '' }], isOther: true }],
    } });
    native.emitOutput({ type: 'tool_completed', toolCallId: 'ask-tool', toolScope: { kind: 'main' }, content: 'Waiting for the user.', isError: false });
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    await waitFor(() => expect(api.getPendingInteractions('recipient')).toHaveLength(1));
    const [pending] = api.getPendingInteractions('recipient');
    expect(pending).toMatchObject({ kind: 'question', questions: [{ question: 'Which file?', isOther: true }] });
    // Claude formats no async reply: delivery fails, the request stays pending and can be retried.
    await expect(api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'b.md' })).rejects.toThrow();
    expect(api.getPendingInteractions('recipient')).toHaveLength(1);
    expect(native.requests).toHaveLength(1);
    vi.spyOn(ProviderRegistry, 'formatQuestionReply').mockImplementation((_provider, _tool, answers) => ({
      content: `Answer: ${String(answers['Which file?'])}`, displayContent: '',
    }));
    let delivered = false;
    const answering = api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'b.md' }).then(() => { delivered = native.requests.length === 2; });
    // While the answer is being delivered, a second answer is refused.
    await expect(api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'a.md' })).rejects.toThrow('is not awaiting an answer');
    await answering;
    expect(delivered).toBe(true);
    expect(requestText(native.requests[1])).toContain('b.md');
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('signals an interaction settled when it is answered elsewhere', async () => {
    const h = setup();
    const { api, native, port } = await startWithInteractionPort(h);
    const question = port.askUserQuestion({
      interactionId: 'ask', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: '' }] }] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await waitFor(() => expect(api.getPendingInteractions('recipient')).toHaveLength(1));
    port.dismissInteraction('ask', 'native-rejected');
    await expect(question).rejects.toThrow('Provider interaction is stale');
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    expect(interactionSignals(h)).toEqual([
      { sessionId: 'recipient', type: 'interaction', interactionId: 'ask', pending: true },
      { sessionId: 'recipient', type: 'interaction', interactionId: 'ask', pending: false },
    ]);
    expect(api.getPendingInteractions('missing')).toEqual([]);
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });
});
