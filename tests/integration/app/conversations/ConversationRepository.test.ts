import '@/providers';

import { FakeSideBackend, waitFor } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation, SessionMetadata } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { refreshTabContextUsage } from '@/features/chat/tabs/TabProviderState';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

function fixture() {
  const conversation: Conversation = {
    id: 'audit-conversation', providerId: 'claude', title: 'Original',
    sessionId: 'native-shared', createdAt: testDate().getTime(),
    lastActivityAt: testDate().getTime(), messages: [], isPinned: false,
  };
  const persistence = {
    metadataReader: {
      revalidate: jest.fn().mockResolvedValue([]),
      load: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
      loadMetadata: jest.fn().mockResolvedValue(null),
      scanMetadata: jest.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
      listMetadata: jest.fn().mockResolvedValue([]),
    },
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
  };
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const repository = new ConversationRepository({
    getSettings: () => settings, getVaultPath: () => '/vault', persistence,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll([conversation]);
  const runtimeSettings = new RuntimeSettingsCoordinator({
    settings: new SettingsCoordinator(settings, async () => undefined),
    conversations: repository, getSettings: () => settings, canCompleteInvalidations: () => false,
  });
  return { conversation, persistence, repository, runtimeSettings };
}

test('failed pin persistence preserves committed state and allows a real retry', async () => {
  const { repository, persistence, conversation } = fixture();
  persistence.saveMetadata.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(repository.setPinned(conversation.id, true)).rejects.toThrow('disk unavailable');
  const publishedAfterFailure = repository.list()[0].isPinned;
  await repository.setPinned(conversation.id, true);
  expect({ publishedAfterFailure, writes: persistence.saveMetadata.mock.calls.length })
    .toEqual({ publishedAfterFailure: false, writes: 2 });
});

test('two runtime owners cannot both hand off the same conversation to native execution', async () => {
  const { repository, conversation } = fixture();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  let serial = 0;
  const coordinators = [0, 1].map(() => new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend, persistence: repository,
    vaultWorkingDirectory: '/vault', createId: () => `audit-binding-${++serial}`,
    resolveMissingProviderSession: async () => 'preserved',
    interactionPort: {
      requestApproval: async () => { throw new Error('unexpected'); },
      askUserQuestion: async () => { throw new Error('unexpected'); },
      dismissInteraction: () => undefined,
    },
  }));
  try {
    for (const coordinator of coordinators) {
      await coordinator.bindConversation({ conversationId: conversation.id, providerId: 'claude', resumeSeed: { providerSessionId: conversation.sessionId! } });
    }
    const outcomes: unknown[] = [];
    const runs = coordinators.map((coordinator, index) => coordinator.execute({
      submissionId: `audit-${index}`, timestamp: testDate().getTime(),
      rawDisplayText: 'run', canonicalText: 'run', images: [],
      configuration: { systemInstructions: { kind: 'provider-default' } },
      toolPolicy: { kind: 'provider-default' },
    }).then(result => { outcomes[index] = result; }, error => { outcomes[index] = error; }));
    await waitFor(() => backend.sessions.reduce((n, session) => n + session.requests.length, 0) + outcomes.filter(Boolean).length >= 2);
    const handedOff = backend.sessions.reduce((n, session) => n + session.requests.length, 0);
    for (const session of backend.sessions) session.complete();
    await Promise.all(runs);
    expect(handedOff).toBeLessThanOrEqual(1);
  } finally {
    await Promise.all(coordinators.map(coordinator => coordinator.dispose()));
    await lifecycleRegistry.dispose();
  }
});

test('a metadata scan paused during source resolution cannot publish writes after unload', async () => {
  const { repository, persistence, conversation, runtimeSettings } = fixture();
  repository.replaceAll([]);
  const metadata: SessionMetadata = { ...conversation, providerState: undefined };
  const record = { metadata, source: 'unscoped' as const, needsMigration: true };
  let resolveSource!: (value: (typeof record)[]) => void;
  let sourceStarted!: () => void;
  const readingSource = new Promise<void>(resolve => { sourceStarted = resolve; });
  persistence.metadataReader.revalidate.mockImplementation(() => new Promise(resolve => {
    resolveSource = resolve;
    sourceStarted();
  }));
  persistence.metadataReader.scan.mockResolvedValue({ records: [record], complete: true, invalidMetadataCount: 0 });
  let unloading = false;
  const loader = new SessionMetadataLoader({
    sessions: persistence.metadataReader, conversations: repository,
    runtimeSettings,
    isUnloading: () => unloading, whenLayoutReady: callback => callback(),
    onConversationListChanged: () => undefined,
  });
  loader.finishStartup(false, true);
  loader.scheduleRemainingLoad();
  await readingSource;
  unloading = true;
  const disposal = loader.dispose();
  resolveSource([record]);
  await disposal;
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
});

test.each(['rename', 'archive', 'model'] as const)('failed %s writes leave the committed projection intact', async operation => {
  const { repository, persistence, conversation } = fixture();
  conversation.selectedModel = 'opus';
  repository.replaceAll([conversation]);
  const before = { ...conversation };
  const mutate = () => operation === 'rename'
    ? repository.rename(conversation.id, 'New title')
    : operation === 'archive'
      ? repository.setArchived(conversation.id, true)
      : repository.update(conversation.id, { selectedModel: 'sonnet' });
  persistence.saveMetadata.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(mutate()).rejects.toThrow('disk unavailable');
  expect(repository.getCachedConversation(conversation.id)).toEqual(before);
  await mutate();
  expect(persistence.saveMetadata).toHaveBeenCalledTimes(2);
  expect(repository.getCachedConversation(conversation.id)).not.toEqual(before);
});

test('queued archive and pin decisions use the committed result of the preceding mutation', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const archive = repository.setArchived(conversation.id, true);
  await waitFor(() => Boolean(finishWrite));
  const pin = repository.setPinned(conversation.id, true);
  expect(conversation.isArchived).toBeUndefined();
  finishWrite();
  await Promise.all([archive, pin]);
  expect(repository.getSync(conversation.id)).toMatchObject({ isArchived: true, isPinned: false });
  expect(persistence.saveMetadata).toHaveBeenCalledTimes(1);
});

test('execution claims reject competitors and stale handoffs until explicitly released', async () => {
  const { repository, conversation } = fixture();
  repository.registerExecutionBinding(conversation.id, 'owner-1', 0);
  expect(() => repository.registerExecutionBinding(conversation.id, 'owner-2', 0)).toThrow('another tab');
  await expect(repository.assertConversationExecutionAuthority(conversation.id, 'owner-1', 0)).resolves.toBeUndefined();
  await expect(repository.assertConversationExecutionAuthority(conversation.id, 'owner-1', 1)).rejects.toThrow();
  repository.releaseExecutionBinding(conversation.id, 'owner-1');
  repository.registerExecutionBinding(conversation.id, 'owner-2', 0);
  await expect(repository.assertConversationExecutionAuthority(conversation.id, 'owner-1', 0)).rejects.toThrow();
  await expect(repository.assertConversationExecutionAuthority(conversation.id, 'owner-2', 0)).resolves.toBeUndefined();
});

test('loader disposal drains an admitted migration and rejects further on-demand reads', async () => {
  const { repository, persistence, conversation, runtimeSettings } = fixture();
  repository.replaceAll([]);
  persistence.metadataReader.load.mockResolvedValue({ metadata: conversation, source: 'unscoped', needsMigration: true });
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const loader = new SessionMetadataLoader({
    sessions: persistence.metadataReader, conversations: repository, runtimeSettings,
    isUnloading: () => false, whenLayoutReady: callback => callback(), onConversationListChanged: () => undefined,
  });
  const load = loader.ensureLoaded([conversation.id]);
  await waitFor(() => Boolean(finishWrite));
  let disposed = false;
  const disposal = loader.dispose().then(() => { disposed = true; });
  await loader.ensureLoaded(['another-conversation']);
  expect(disposed).toBe(false);
  expect(persistence.metadataReader.load).toHaveBeenCalledTimes(1);
  finishWrite();
  await Promise.all([load, disposal]);
  expect(persistence.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ id: conversation.id }), 'unscoped');
  expect(disposed).toBe(true);
});

test('historical recovery cannot overwrite a model selection whose write is pending', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishRecovery!: (model: string) => void;
  const recoveryResult = new Promise<string>(resolve => { finishRecovery = resolve; });
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const recoverySpy = jest.spyOn(history, 'recoverConversationModelSelection').mockReturnValue(recoveryResult);
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  try {
    const recovery = repository.recoverMissingSelectedModels();
    const update = repository.update(conversation.id, { selectedModel: 'sonnet' });
    await waitFor(() => Boolean(finishWrite));
    finishRecovery('opus');
    // Let the native read finish while the explicit write is still pending.
    await recoveryResult;
    await Promise.resolve();
    finishWrite();
    await Promise.all([recovery, update]);
    expect(persistence.saveMetadata.mock.calls.map(([metadata]) => metadata.selectedModel)).toEqual(['sonnet']);
    expect(repository.getSync(conversation.id)?.selectedModel).toBe('sonnet');
  } finally {
    recoverySpy.mockRestore();
  }
});

test('provider invalidation preserves an ordinary metadata commit already in flight', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const rename = repository.rename(conversation.id, 'Renamed');
  await waitFor(() => Boolean(finishWrite));
  const invalidation = repository.persistConversations(repository.invalidateProviderSessions(['claude']));
  finishWrite();
  await Promise.all([rename, invalidation]);
  expect(persistence.saveMetadata.mock.calls.map(([metadata]) => metadata.title)).toEqual(['Renamed', 'Renamed']);
  expect(repository.getSync(conversation.id)).toMatchObject({ title: 'Renamed', sessionId: null });
});

test('failed deletion restores an ordinary metadata commit that finished during deletion', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  persistence.deleteCurrentMetadata.mockRejectedValueOnce(new Error('deletion failed'));
  const rename = repository.rename(conversation.id, 'Renamed');
  await waitFor(() => Boolean(finishWrite));
  const deletion = repository.delete(conversation.id);
  finishWrite();
  await expect(deletion).rejects.toThrow('deletion failed');
  await rename;
  expect(repository.getCachedConversation(conversation.id)?.title).toBe('Renamed');
});

test('provider invalidation fences session fields while preserving the rest of a pending update', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const update = repository.update(conversation.id, { title: 'Renamed', sessionId: 'replacement' });
  await waitFor(() => Boolean(finishWrite));
  const invalidation = repository.persistConversations(repository.invalidateProviderSessions(['claude']));
  finishWrite();
  await Promise.all([update, invalidation]);
  expect(repository.getSync(conversation.id)).toMatchObject({ title: 'Renamed', sessionId: null });
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Renamed', sessionId: null });
});

test('a missing-session check waits for an already-admitted binding write', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const missingSpy = jest.spyOn(history, 'resolveMissingConversationSession').mockImplementation(async draft => (
    draft.sessionId === 'native-shared' ? 'delete' : 'preserve'
  ));
  try {
    const update = repository.update(conversation.id, { sessionId: 'replacement' });
    await waitFor(() => Boolean(finishWrite));
    const missing = repository.handleMissingProviderSession(conversation.id, 'native-shared');
    // Let the missing-session continuation run while persistence is paused.
    await new Promise(resolve => setImmediate(resolve));
    finishWrite();
    await update;
    expect(await missing).toBe('preserved');
    expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('replacement');
    expect(persistence.deleteCurrentMetadata).not.toHaveBeenCalled();
  } finally {
    missingSpy.mockRestore();
  }
});

test('failed deletion restores a binding committed while deletion was pending', async () => {
  const { repository, persistence, conversation } = fixture();
  const messages: Conversation['messages'] = [
    { id: 'replacement-message', role: 'assistant', content: 'Replacement', timestamp: testDate().getTime() },
  ];
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  persistence.deleteCurrentMetadata.mockRejectedValueOnce(new Error('deletion failed'));
  const update = repository.update(conversation.id, { sessionId: 'replacement', messages });
  await waitFor(() => Boolean(finishWrite));
  const deletion = repository.delete(conversation.id);
  finishWrite();
  await expect(deletion).rejects.toThrow('deletion failed');
  await update;
  expect(repository.getCachedConversation(conversation.id)).toMatchObject({ sessionId: 'replacement', messages });
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].sessionId).toBe('replacement');
});

test('failed deletion restores a recovered model committed while deletion was pending', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  persistence.deleteCurrentMetadata.mockRejectedValueOnce(new Error('deletion failed'));
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const recoverySpy = jest.spyOn(history, 'recoverConversationModelSelection').mockResolvedValue('sonnet');
  try {
    const recovery = repository.recoverMissingSelectedModels();
    await waitFor(() => Boolean(finishWrite));
    const deletion = repository.delete(conversation.id);
    finishWrite();
    await expect(deletion).rejects.toThrow('deletion failed');
    await recovery;
    expect(repository.getCachedConversation(conversation.id)?.selectedModel).toBe('sonnet');
    expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].selectedModel).toBe('sonnet');
  } finally {
    recoverySpy.mockRestore();
  }
});

test('activity accepted during a session write reaches disk', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const update = repository.update(conversation.id, { sessionId: 'replacement' });
  await waitFor(() => Boolean(finishWrite));
  const timestamp = conversation.lastActivityAt + 1000;
  const activity = repository.recordConversationActivity(conversation.id, timestamp);
  finishWrite();
  await Promise.all([update, activity]);
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].lastActivityAt).toBe(timestamp);
});

test('linked-content rename during a session write reaches disk', async () => {
  const { repository, persistence, conversation } = fixture();
  const linked = { ...conversation, linkedContentPath: 'old.md' };
  repository.replaceAll([linked]);
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const update = repository.update(linked.id, { sessionId: 'replacement' });
  await waitFor(() => Boolean(finishWrite));
  const rename = repository.rewriteLinkedContentPaths('old.md', 'new.md');
  finishWrite();
  await Promise.all([update, rename]);
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].linkedContentPath).toBe('new.md');
});

test('conversation reads and update inputs are detached from repository records', async () => {
  const { repository, conversation } = fixture();
  const messages = [{ id: 'message', role: 'assistant', content: 'original', timestamp: testDate().getTime() }] as Conversation['messages'];
  await repository.update(conversation.id, { messages });
  messages[0].content = 'caller edit';
  const snapshot = repository.getCachedConversation(conversation.id)!;
  expect(snapshot.messages[0].content).toBe('original');
  snapshot.messages[0].content = 'reader edit';
  repository.getAll().splice(0);
  expect(repository.getSync(conversation.id)?.messages[0].content).toBe('original');
});

test('context controls read detached metadata without copying the transcript', async () => {
  const { repository, conversation } = fixture();
  conversation.selectedModel = 'sonnet';
  conversation.messages = [{
    id: 'large-message', role: 'user', content: 'transcript'.repeat(100_000), timestamp: testDate().getTime(),
  }];
  repository.replaceAll([conversation]);
  const settings = { ...DEFAULT_CLAUDIAN_SETTINGS, customContextLimits: { sonnet: 100_000, opus: 200_000 } };
  const fullRead = jest.spyOn(repository, 'getSync');
  const summaryRead = jest.spyOn(repository, 'getSummary');
  const update = jest.fn();
  const tab = {
    conversationId: conversation.id, providerId: 'claude', draftModel: null,
    session: { reasoningSelections: new Map() },
    state: { usage: { model: 'sonnet', contextTokens: 50_000, inputTokens: 50_000 } },
    ui: { contextUsageMeter: { update } },
  } as unknown as AssembledTabRuntime;
  const host = {
    getCommittedSettings: () => settings,
    getConversationSummary: (id: string) => repository.getSummary(id),
    getConversationSync: (id: string) => repository.getSync(id),
  } as unknown as ChatFeatureHost;

  refreshTabContextUsage(tab, host);
  expect(summaryRead).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 100_000, percentage: 50 }));
  const previous = repository.getSummary(conversation.id)!;
  expect(previous).not.toHaveProperty('messages');
  expect(previous).not.toHaveProperty('providerState');
  await repository.update(conversation.id, { selectedModel: 'opus' });
  refreshTabContextUsage(tab, host);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 200_000, percentage: 25 }));
  expect(previous.selectedModel).toBe('sonnet');
  expect(fullRead).not.toHaveBeenCalled();
});
