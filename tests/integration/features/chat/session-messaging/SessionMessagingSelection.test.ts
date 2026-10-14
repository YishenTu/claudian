/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
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

function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  const settings = {
    model: sonnet, permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    lastSelectedChatModel: { providerId: 'claude', model: sonnet },
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5', 'claude-haiku-4-5'], ['low', 'high']) },
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
  } as unknown as ChatFeatureHost;
  const pool = installSessionRuntimePool(host);
  const refreshModelControls = jest.fn();
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => null, refreshModelControls,
    commitSelection: (...args) => repository.updateSelectedModelIf(...args),
  });
  Object.assign(host, { bindSessionTools: (id: string) => service.bindSessionTools(id) });
  const runtime = pool.ensure({ conversationId: 'recipient', providerId: 'claude', draftModel: null });
  getSessionSettingsSnapshot(runtime, host);
  const reasoningBefore = [...runtime.reasoningSelections];
  const send = (choice = { model: haiku, reasoning: 'low' }) => service.bindSessionTools('sender').port.send(
    { sessionId: 'recipient', text: 'Incoming task', ...choice }, new AbortController().signal,
  );
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

it('rejects a switch queued behind archive without changing model or reasoning', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const archive = h.repository.setArchived('recipient', true);
  await write.entered;
  const sending = h.send().catch(error => error as unknown);
  try { await h.waitForSend(); } finally { write.release(); }
  await archive;
  expect(await sending).toBeInstanceOf(Error);
  expect(h.repository.getSync('recipient')).toMatchObject({ isArchived: true, selectedModel: sonnet });
  expect(h.stored.get('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.refreshModelControls).not.toHaveBeenCalled();
});

it.each(['stop', 'shutdown'] as const)('changes nothing when %s discards the reservation during its metadata write', async action => {
  const h = setup();
  const write = h.pauseWrite();
  const sending = h.send().catch(error => error as unknown);
  await write.entered;
  if (action === 'stop') h.runtime.cancelTurn('user');
  else h.runtime.beginShutdown();
  write.release();
  expect(await sending).toBeInstanceOf(Error);
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(sonnet);
  expect(h.stored.get('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
});

it('rejects reasoning validated against a model superseded by a competing selection', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const selecting = h.repository.update('recipient', { selectedModel: haiku });
  await write.entered;
  const sending = h.send({ model: sonnet, reasoning: 'low' }).catch(error => error as unknown);
  try { await h.waitForSend(); } finally { write.release(); }
  await selecting;
  expect(await sending).toBeInstanceOf(Error);
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(haiku);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
});

it('does not reject an admitted switch when its presentation refresh throws', async () => {
  const h = setup();
  h.refreshModelControls.mockImplementation(() => { throw new Error('View closed'); });
  await expect(h.send()).resolves.toEqual({ sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'started' });
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.backend.latest.requests[0].configuration).toMatchObject({ model: haiku, reasoning: 'low' });
  h.backend.latest.complete();
  await h.runtime.turns.drain();
});

it('finishes cancellation rollback before a newer user model selection commits', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const sending = h.send().catch(error => error as unknown);
  await write.entered;
  expect(h.runtime.mailbox!.hasPending).toBe(true);
  expect(h.runtime.isIdle).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
  h.runtime.cancelTurn('user');
  const newerChoice = h.repository.update('recipient', { selectedModel: haiku });
  write.release();
  expect(await sending).toBeInstanceOf(Error);
  await newerChoice;
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(haiku);
  expect(h.stored.get('recipient')?.selectedModel).toBe(haiku);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
});

it('preserves a newer reasoning choice made while the model write is pending', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const sending = h.send().catch(error => error as unknown);
  await write.entered;
  h.runtime.reasoningSelections.set(`claude:${haiku}`, 'high');
  write.release();
  expect(await sending).toBeInstanceOf(Error);
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(sonnet);
  expect(h.stored.get('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual([...h.reasoningBefore, [`claude:${haiku}`, 'high']]);
  expect(h.backend.sessions).toHaveLength(0);
});

it('revalidates reasoning capability after persistence and restores metadata if it changed', async () => {
  const h = setup();
  const write = h.pauseWrite();
  const sending = h.send().catch(error => error as unknown);
  await write.entered;
  const config = h.host.settings.providerConfigs.claude as ReturnType<typeof claudeCatalogFixture>;
  config.discoveredModels[1].supportedEffortLevels = ['high'];
  write.release();
  expect(await sending).toBeInstanceOf(Error);
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(sonnet);
  expect(h.stored.get('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
});

it('discards a failed metadata write without committing reasoning or message admission', async () => {
  const h = setup();
  h.saveMetadata.mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(h.send()).rejects.toThrow('Disk unavailable');
  expect(h.repository.getSummary('recipient')?.selectedModel).toBe(sonnet);
  expect([...h.runtime.reasoningSelections]).toEqual(h.reasoningBefore);
  expect(h.runtime.mailbox!.hasPending).toBe(false);
  expect(h.backend.sessions).toHaveLength(0);
  expect(h.refreshModelControls).not.toHaveBeenCalled();
});
