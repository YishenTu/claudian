import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/core/bootstrap/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as claudeHistory from '@/providers/claude/history/ClaudeHistoryStore';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import * as history from '@/providers/opencode/history/OpencodeHistoryStore';

function createConversation(id = 'conversation-1'): Conversation {
  return {
    id,
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: 'session-1',
    messages: [],
  };
}

function createRepository(conversation = createConversation()) {
  const persistence: jest.Mocked<ConversationPersistence> = {
    metadataReader: {
      revalidate: jest.fn().mockResolvedValue([]),
      load: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue({
        records: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      loadMetadata: jest.fn().mockResolvedValue(null),
      scanMetadata: jest.fn().mockResolvedValue({
        metadata: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      listMetadata: jest.fn().mockResolvedValue([]),
    },
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
  };
  const repository = new ConversationRepository({
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  repository.replaceAll([conversation]);
  return { repository, persistence };
}

afterEach(() => jest.restoreAllMocks());

test('a superseded native history read cannot overwrite the current conversation', async () => {
  let started!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const deferred = new Promise<void>(resolve => { release = resolve; });
  const oldMessages: Conversation['messages'] = [
    { id: 'old-message', role: 'assistant', content: 'Old session response', timestamp: 1 },
  ];
  const newMessages: Conversation['messages'] = [
    { id: 'new-message', role: 'assistant', content: 'Current session response', timestamp: 2 },
  ];
  jest.spyOn(history, 'loadOpencodeSessionMessages').mockImplementation(async () => {
    started();
    await deferred;
    return oldMessages;
  });
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockReturnValue(new OpencodeConversationHistoryService());
  const conversation = createConversation();
  conversation.providerId = 'opencode';
  conversation.selectedModel = 'opencode/example';
  const { repository } = createRepository(conversation);
  const pending = repository.ensureHydrated(conversation.id);
  await reading;
  await repository.update(conversation.id, { sessionId: 'session-2', messages: newMessages });
  release();
  expect(await pending).toBeNull();
  expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('session-2');
  expect(repository.getCachedConversation(conversation.id)?.messages).toEqual(newMessages);
});

test('does not publish recovered identity after concurrent deletion', async () => {
  const conversation = createConversation();
  const { repository, persistence } = createRepository(conversation);
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async () => undefined,
    resolveSessionIdForConversation: value => value?.sessionId ?? null,
    isPendingForkConversation: () => false,
    buildForkProviderState: () => ({}),
    recoverConversationSessionReference: async draft => {
      draft.sessionId = 'recovered-session';
      await repository.delete(conversation.id);
      return true;
    },
  });
  expect(await repository.ensureHydrated(conversation.id)).toBeNull();
  expect(repository.getCachedConversation(conversation.id)).toBeNull();
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
});

test('keeps relocated Claude history readable after its metadata save fails', async () => {
  const conversation = createConversation();
  conversation.selectedModel = 'sonnet';
  const messages: Conversation['messages'] = [
    { id: 'native-response', role: 'assistant', content: 'Native history', timestamp: 2 },
  ];
  const location = { availability: 'relocated' as const, sessionPath: '/old-vault/session-1.jsonl' };
  jest.spyOn(claudeHistory, 'locateSDKSession').mockResolvedValue(location);
  jest.spyOn(claudeHistory, 'locateSDKSessions').mockResolvedValue(new Map([['session-1', location]]));
  jest.spyOn(claudeHistory, 'loadSDKSessionMessages').mockResolvedValue({ messages, skippedLines: 0 });
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockReturnValue(new ClaudeConversationHistoryService());
  const { repository, persistence } = createRepository(conversation);
  persistence.saveMetadata.mockRejectedValue(new Error('Metadata unavailable'));

  expect((await repository.ensureHydrated(conversation.id))?.messages).toEqual(messages);
  expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('session-1');
});

test('OpenCode hydrates a fresh projection after another projection was discarded', async () => {
  const service = new OpencodeConversationHistoryService();
  const first = { ...createConversation(), providerId: 'opencode' };
  const nativeMessages: Conversation['messages'] = [
    { id: 'native-response', role: 'assistant', content: 'Native history', timestamp: 2 },
  ];
  jest.spyOn(history, 'loadOpencodeSessionMessages').mockResolvedValue(nativeMessages);
  await service.hydrateConversationHistory(first, '/vault');
  const fresh = { ...createConversation(), providerId: 'opencode', messages: [
    { id: 'local-input', role: 'user' as const, content: 'Local draft', timestamp: 1 },
  ] };
  await service.hydrateConversationHistory(fresh, '/vault');
  expect(fresh.messages).toEqual(nativeMessages);
});

test('restores the conversation when missing-session metadata removal fails', async () => {
  const conversation = createConversation();
  const { repository, persistence } = createRepository(conversation);
  jest.spyOn(claudeHistory, 'locateSDKSessions').mockResolvedValue(new Map([
    ['session-1', { availability: 'missing' as const }],
  ]));
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockReturnValue(new ClaudeConversationHistoryService());
  persistence.deleteCurrentMetadata.mockRejectedValue(new Error('Metadata cleanup failed'));

  await expect(repository.handleMissingProviderSession(conversation.id, 'session-1'))
    .rejects.toThrow('Metadata cleanup failed');
  expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
});

test('surfaces a failed missing-session reset save while preserving live identity', async () => {
  const conversation = { ...createConversation(), providerId: 'opencode' };
  const { repository, persistence } = createRepository(conversation);
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockReturnValue(new OpencodeConversationHistoryService());
  persistence.saveMetadata.mockRejectedValue(new Error('Metadata save failed'));

  await expect(repository.handleMissingProviderSession(conversation.id, 'session-1'))
    .rejects.toThrow('Metadata save failed');
  expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('session-1');
});

test('late accepted binding survives a missing-session decision', async () => {
  const conversation = createConversation();
  const { repository } = createRepository(conversation);
  let updating: Promise<void> | undefined;
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async () => undefined,
    resolveSessionIdForConversation: value => value?.sessionId ?? null,
    isPendingForkConversation: () => false,
    buildForkProviderState: () => ({}),
    resolveMissingConversationSession: async () => {
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        updating = repository.update(conversation.id, { sessionId: 'new-session' });
      })));
      return 'delete';
    },
  });
  const outcome = await repository.handleMissingProviderSession(conversation.id, 'session-1');
  await updating;
  expect(outcome).toBe('preserved');
  expect(repository.getCachedConversation(conversation.id)?.sessionId).toBe('new-session');
});
