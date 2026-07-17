import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

function createConversation(id = 'conversation-1'): Conversation {
  return {
    id,
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'session-1',
    messages: [],
  };
}

function createRepository(conversation = createConversation()) {
  const sessions = {
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteMetadata: jest.fn().mockResolvedValue(undefined),
    toSessionMetadata: jest.fn((value) => value),
  };
  const repository = new ConversationRepository({
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    sessions: sessions as any,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  repository.replaceAll([conversation]);
  return { repository, sessions };
}

describe('ConversationRepository hydration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns cached metadata without hydrating provider history', () => {
    const hydrateConversationHistory = jest.fn();
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(hydrateConversationHistory).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent hydration and does not reread an empty transcript', async () => {
    let release!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    const first = repository.ensureHydrated(conversation.id);
    const second = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([conversation, conversation]);
    await repository.ensureHydrated(conversation.id);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);
  });

  it('allows hydration to retry after a provider history failure', async () => {
    const hydrateConversationHistory = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository(conversation);

    await expect(repository.ensureHydrated(conversation.id)).rejects.toThrow('temporary failure');
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('merges background metadata without replacing an already hydrated conversation', () => {
    const existing = createConversation('existing');
    existing.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository } = createRepository(existing);
    const duplicate = createConversation('existing');
    const added = createConversation('added');
    added.updatedAt = 2;

    const merged = repository.mergeMetadataConversations([duplicate, added]);

    expect(merged).toEqual([added]);
    expect(repository.getCachedConversation('existing')).toBe(existing);
    expect(repository.getCachedConversation('existing')?.messages).toHaveLength(1);
    expect(repository.getAll().map(conversation => conversation.id)).toEqual(['added', 'existing']);
  });
});
