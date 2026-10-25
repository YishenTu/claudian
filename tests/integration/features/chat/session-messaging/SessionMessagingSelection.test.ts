/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';
import { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation, ConversationMutablePatch, SessionMetadata } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { getSessionSettingsSnapshot } from '@/features/chat/sessions/sessionSettings';

const sonnet = 'claude-code/claude-sonnet-4-5';
const haiku = 'claude-code/claude-haiku-4-5';
const opus = 'claude-code/claude-opus-4-6';

function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  const settings = {
    model: sonnet, permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    lastSelectedChatModel: { providerId: 'claude', model: sonnet },
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-6'], ['low', 'high']) },
  } as unknown as ClaudianSettings;
  const records: Conversation[] = ['sender', 'recipient'].map(id => ({
    id, sessionId: null, providerId: 'claude', selectedModel: sonnet, title: id, messages: [],
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  }));
  const stored = new Map<string, SessionMetadata>();
  const saveMetadata = jest.fn<Promise<void>, [SessionMetadata]>(async metadata => { stored.set(metadata.id, structuredClone(metadata)); });
  const persistence = {
    metadataReader: { revalidate: jest.fn(), load: jest.fn(), scan: jest.fn(), loadMetadata: jest.fn(), scanMetadata: jest.fn(), listMetadata: jest.fn() },
    saveMetadata, deleteCurrentMetadata: jest.fn(), assignMetadataToDevice: jest.fn(),
  } as ConversationPersistence;
  const repository = new ConversationRepository({
    persistence, providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => '/vault', onConversationDeleted: async () => undefined,
  });
  repository.replaceAll(records);
  const host = {
    app, settings, providerHost: { app, settings, executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry() },
    getCommittedSettings: () => settings, getActiveEnvironmentVariables: () => '',
    getConversationSummary: (id: string) => repository.getSummary(id),
    getConversationSync: (id: string) => repository.getSync(id),
    getCachedConversation: (id: string) => repository.getSync(id),
    getConversationById: async (id: string) => repository.getSync(id),
    getConversationList: () => repository.list(), ensureConversationMetadataLoaded: async () => undefined,
    renameConversation: (id: string, title: string) => repository.rename(id, title),
    updateConversation: jest.fn((id: string, patch: ConversationMutablePatch) => repository.update(id, patch)),
    executionPersistence: repository,
    projects: createProjectsFake(),
  } as unknown as ChatFeatureHost;
  const pool = installSessionRuntimePool(host);
  const refreshModelControls = jest.fn();
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => null, refreshModelControls });
  Object.assign(host, { bindSessionTools: (id: string) => service.bindSessionTools(id) });
  const runtime = pool.ensure({ conversationId: 'recipient', providerId: 'claude', draftModel: null });
  getSessionSettingsSnapshot(runtime, host);
  const reasoningBefore = [...runtime.reasoningSelections];
  const send = (
    choice: { model?: string; reasoning?: string } = { model: haiku, reasoning: 'low' },
    signal = new AbortController().signal,
  ) => service.bindSessionTools('sender').port.send({ sessionId: 'recipient', text: 'Incoming task', ...choice }, signal);
  const pauseWrite = () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    saveMetadata.mockImplementationOnce(async metadata => {
      entered.resolve();
      await release.promise;
      stored.set(metadata.id, structuredClone(metadata));
    });
    return { entered: entered.promise, release: () => release.resolve() };
  };
  const waitForSend = () => waitFor(() => expect(runtime.mailbox!.hasPending || jest.mocked(host.updateConversation).mock.calls.length > 0 || refreshModelControls.mock.calls.length > 0).toBe(true));
  return { host, repository, runtime, backend, refreshModelControls, saveMetadata, stored, send, pauseWrite, waitForSend, reasoningBefore };
}

afterEach(() => { ProviderWorkspaceRegistry.clear(); jest.restoreAllMocks(); });

it('does not reject a committed switch when its presentation refresh throws', async () => {
  const h = setup();
  h.refreshModelControls.mockImplementation(() => { throw new Error('View closed'); });
  await expect(h.send()).resolves.toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'started' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.latest.requests[0].configuration).toMatchObject({ model: haiku, reasoning: 'low' });
  h.backend.latest.complete();
  await h.runtime.turns.drain();
});

it('rejects a send whose model write fails without switching reasoning or delivering', async () => {
  const h = setup();
  h.saveMetadata.mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(h.send()).rejects.toThrow('Disk unavailable');
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.refreshModelControls).not.toHaveBeenCalled();
});

it('keeps a committed switch but delivers nothing when the send is cancelled during its model write', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const cancellation = new AbortController();
  const sending = h.send({ model: haiku }, cancellation.signal);
  await write.entered;
  cancellation.abort();
  write.release();
  await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(haiku);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
});

it('applies its switch after a pending user model choice instead of rejecting the message', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const selecting = h.repository.update('recipient', { selectedModel: haiku });
  await write.entered;
  const sending = h.send({ model: opus });
  try { await h.waitForSend(); } finally { write.release(); }
  await selecting;
  await expect(sending).resolves.toMatchObject({ sessionId: 'recipient', status: 'started' });
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(opus);
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.latest.requests[0].configuration).toMatchObject({ model: opus });
  h.backend.latest.complete();
  await h.runtime.turns.drain();
});
