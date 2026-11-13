import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { FakeSideBackend, waitFor } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation, SessionMetadata } from '@/core/types';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';

function fixture() {
  const conversation: Conversation = {
    id: 'audit-conversation', providerId: 'claude', title: 'Original',
    sessionId: 'native-shared', createdAt: testDate().getTime(),
    lastActivityAt: testDate().getTime(), messages: [], isPinned: false,
  };
  const persistence = {
    metadataReader: {
      revalidate: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      scan: vi.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
      loadMetadata: vi.fn().mockResolvedValue(null),
      scanMetadata: vi.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
      listMetadata: vi.fn().mockResolvedValue([]),
    },
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
  };
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => '/vault', persistence,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll([conversation]);
  return { conversation, persistence, repository };
}

test('failed pin persistence preserves committed state and allows a real retry', async () => {
  const { repository, persistence, conversation } = fixture();
  persistence.saveMetadata.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(repository.setPlacement(conversation.id, { isPinned: true })).rejects.toThrow('disk unavailable');
  const publishedAfterFailure = repository.list()[0].isPinned;
  await repository.setPlacement(conversation.id, { isPinned: true });
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
    workingDirectory: '/vault', createId: () => `audit-binding-${++serial}`,
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
      configuration: { systemInstructions: { kind: 'main-agent' as const, instructions: 'Main Agent prompt.' } },
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
  const { repository, persistence, conversation } = fixture();
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
    isUnloading: () => unloading, whenLayoutReady: callback => callback(),
    onConversationListChanged: () => undefined,
  });
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
  const pin = repository.setPlacement(conversation.id, { isPinned: true });
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
  const { repository, persistence, conversation } = fixture();
  repository.replaceAll([]);
  persistence.metadataReader.load.mockResolvedValue({ metadata: conversation, source: 'unscoped', needsMigration: true });
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const loader = new SessionMetadataLoader({
    sessions: persistence.metadataReader, conversations: repository,
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
  const recoverySpy = vi.spyOn(history, 'recoverConversationModelSelection').mockReturnValue(recoveryResult);
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

test('a native history read waits for an already-admitted binding write', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const readSessionIds: Array<string | null> = [];
  const availabilitySpy = vi.spyOn(history, 'getConversationSessionAvailability').mockImplementation(async input => {
    readSessionIds.push(input.sessionId);
    return 'available';
  });
  const hydrateSpy = vi.spyOn(history, 'hydrateConversationHistory').mockImplementation(async input => {
    readSessionIds.push(input.sessionId);
    return {};
  });
  try {
    const update = repository.update(conversation.id, { sessionId: 'replacement' });
    await waitFor(() => Boolean(finishWrite));
    const hydration = repository.ensureHydrated(conversation.id);
    // Let the read continuation run while persistence is paused.
    await new Promise(resolve => setImmediate(resolve));
    finishWrite();
    await update;
    await hydration;
    // A later read reaches the provider, so the spies observe every native read.
    await repository.ensureHydrated(conversation.id);
    expect(readSessionIds).toContain('replacement');
    expect(readSessionIds).not.toContain('native-shared');
    expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('replacement');
  } finally {
    availabilitySpy.mockRestore();
    hydrateSpy.mockRestore();
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
  const recoverySpy = vi.spyOn(history, 'recoverConversationModelSelection').mockResolvedValue('sonnet');
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
