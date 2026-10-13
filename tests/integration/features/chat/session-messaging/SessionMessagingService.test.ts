/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';
import { App } from 'obsidian';

import { ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ClaudianSettings, Conversation, ConversationMutablePatch } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';

function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  const settings = {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    lastSelectedChatModel: { providerId: 'claude', model: 'claude-sonnet-4-5' },
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']) },
  } as unknown as ClaudianSettings;
  const record = (id: string): Conversation => ({
    id, sessionId: null, providerId: 'claude', selectedModel: settings.model, title: id === 'sender' ? 'Research' : id,
    messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  } as Conversation);
  const records = new Map(['sender', 'recipient', 'archived'].map(id => [id, record(id)]));
  records.get('archived')!.isArchived = true;
  const saves: ConversationMutablePatch[] = [];
  const registry = new ProviderExecutionLifecycleRegistry();
  const host = {
    app, settings, providerHost: { app, settings, executionLifecycleRegistry: registry },
    getSessionSnapshotDirectory: () => '/tmp/claudian-sessions',
    getCommittedSettings: () => settings, getActiveEnvironmentVariables: () => '',
    getConversationSummary: (id: string) => records.get(id) ?? null,
    getConversationSync: (id: string) => records.get(id) ?? null,
    getCachedConversation: (id: string) => records.get(id) ?? null,
    getConversationById: async (id: string) => records.get(id) ?? null,
    getConversationList: () => [...records.values()],
    ensureConversationMetadataLoaded: async () => undefined,
    renameConversation: async () => undefined,
    updateConversation: async (_id: string, patch: ConversationMutablePatch) => { saves.push(structuredClone(patch)); },
    createConversation: jest.fn(async () => { const created = record('created'); records.set(created.id, created); return created; }),
    mutateSettings: async (mutate: (settings: ClaudianSettings) => void) => mutate(settings),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  } as unknown as ChatFeatureHost;
  const pool = installSessionRuntimePool(host);
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => 'sender' });
  Object.assign(host, { bindSessionTools: (id: string) => service.bindSessionTools(id) });
  const binding = service.bindSessionTools('sender');
  return { host, pool, service, binding, records, backend, saves, record };
}
const requestText = (request: ProviderExecutionRequest) => request.input.filter(block => block.type === 'text').map(block => block.text).join('');
const signal = () => new AbortController().signal;
afterEach(() => { ProviderWorkspaceRegistry.clear(); jest.restoreAllMocks(); });

it('lists metadata and focus without creating runtimes, omitting archived records', async () => {
  const h = setup();
  expect(await h.binding.port.list(signal())).toEqual([
    { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true },
    { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
  ]);
  expect(h.pool.getAll()).toHaveLength(0);
  expect(h.backend.sessions).toHaveLength(0);
});

it('delivers to a cold headless recipient with caller provenance and no composer capture', async () => {
  const h = setup();
  expect(await h.binding.port.send({ sessionId: 'recipient', text: 'Review this' }, signal()))
    .toEqual({ sessionId: 'recipient', status: 'started' });
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

it.each(['sender', 'archived', 'missing'])('rejects unavailable recipient %s without creating a runtime', async sessionId => {
  const h = setup();
  await expect(h.binding.port.send({ sessionId, text: 'Hello' }, signal())).rejects.toThrow();
  expect(h.pool.getAll()).toHaveLength(0);
});

it('rejects an unavailable explicit model before creating a shell', async () => {
  const h = setup();
  await expect(h.binding.port.send({ text: 'Hello', model: 'unavailable' }, signal())).rejects.toThrow(/model/i);
  expect(h.host.createConversation).not.toHaveBeenCalled();
});

it('keeps a published shell on cancellation and joins creation during shutdown', async () => {
  const h = setup();
  const created = h.record('created');
  const completion = deferred<Conversation>();
  jest.mocked(h.host.createConversation).mockImplementation(async () => {
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
  await expect(h.binding.port.list(signal())).rejects.toThrow();
  expect(h.backend.latest.cancelCalls).toBe(0);
  h.backend.latest.complete();
  await h.pool.get('recipient')!.turns.drain();
});

it('defers a message when native background work starts during preparation, then resumes once', async () => {
  const h = setup();
  const preparing = deferred<void>();
  jest.spyOn(h.host.executionPersistence, 'assertConversationExecutionAuthority').mockImplementationOnce(() => preparing.promise);
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
  expect((await h.binding.port.list(signal())).find(item => item.sessionId === 'recipient')?.status).toBe('running');
  native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'provider-ended' });
  await waitFor(() => expect(native.requests).toHaveLength(1));
  native.complete();
  await runtime.turns.drain();
  expect(runtime.mailbox!.hasPending).toBe(false);
});

it('creates a headless session using the selected default without mutating the future-tab seed', async () => {
  const h = setup();
  const seed = structuredClone(h.host.settings.lastSelectedChatModel);
  expect(await h.binding.port.send({ text: 'New task' }, signal())).toEqual({ sessionId: 'created', status: 'started' });
  expect(h.host.createConversation).toHaveBeenCalledWith({ providerId: 'claude', selectedModel: 'claude-code/claude-sonnet-4-5' });
  expect(h.host.settings.lastSelectedChatModel).toEqual(seed);
  expect(h.pool.getAttachment('created')).toBeNull();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.backend.latest.complete();
  await h.pool.get('created')!.turns.drain();
});

it('waits for a published first-turn shell to adopt its original draft runtime', async () => {
  const h = setup();
  Object.assign(h.host.app.workspace, { getActiveFile: () => null });
  const created = h.record('created');
  const completion = deferred<Conversation>();
  jest.mocked(h.host.createConversation).mockImplementation(async () => {
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
