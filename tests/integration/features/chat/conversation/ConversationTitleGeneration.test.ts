import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { TitleGenerationResult, TitleGenerationService } from '@/core/providers/types';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { ConversationTitleGeneration } from '@/features/chat/conversation/ConversationTitleGeneration';

function createFixture(result: TitleGenerationResult = { success: true, title: 'Generated title' }) {
  const settings = {
    enableAutoTitleGeneration: true,
    titleGenerationModel: 'haiku',
    providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
  } as unknown as ClaudianSettings;
  const at = testDate().getTime();
  const conversation: Conversation = {
    id: 'conversation-1', providerId: 'claude', title: 'Original title', selectedModel: 'haiku',
    createdAt: at, lastActivityAt: at, sessionId: 'native',
    messages: [{ id: 'user', role: 'user', content: 'Explain the note', timestamp: at }],
  };
  const persistence = {
    metadataReader: {},
    saveMetadata: jest.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationPersistence;
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings,
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll([conversation]);
  const started = deferred<void>();
  const finishGeneration = deferred<void>();
  const service: TitleGenerationService = {
    async generateTitle(id, _content, callback) {
      started.resolve();
      await finishGeneration.promise;
      await callback(id, result);
    },
    cancel() {},
  };
  const titles = new ConversationTitleGeneration({
    host: {
      settings,
      getConversationById: id => repository.getById(id),
      renameConversation: (id, title) => repository.rename(id, title),
      completeConversationTitleGeneration: (id, expectedTitle, title) => repository.completeTitleGeneration(id, expectedTitle, title),
      updateConversation: (id, patch) => repository.update(id, patch),
    },
    getService: () => service,
  });
  return { conversation, finishGeneration, persistence, repository, started, titles };
}

it.each(['pending', 'committed'])('preserves a manual rename whose metadata write is %s when generation finishes', async timing => {
  const { conversation, finishGeneration, persistence, repository, started, titles } = createFixture();
  const regeneration = titles.regenerate(conversation.id);
  await started.promise;

  const writing = deferred<void>();
  const finishManualSave = deferred<void>();
  jest.mocked(persistence.saveMetadata).mockImplementationOnce(async () => {
    writing.resolve();
    await finishManualSave.promise;
  });
  const manual = repository.rename(conversation.id, 'My chosen title');
  await writing.promise;
  if (timing === 'committed') {
    finishManualSave.resolve();
    await manual;
  }
  finishGeneration.resolve();
  // Drain the completion callback's microtasks while the manual save remains held.
  await new Promise<void>(resolve => setImmediate(resolve));
  finishManualSave.resolve();
  await Promise.all([manual, regeneration]);

  expect(repository.getSync(conversation.id)).toMatchObject({ title: 'My chosen title' });
  expect(repository.getSync(conversation.id)?.titleGenerationStatus).toBeUndefined();
  expect(persistence.saveMetadata).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'My chosen title', titleGenerationStatus: undefined,
  }));
});

it.each([true, false])('commits the generated title and its status together (success: %s)', async success => {
  const result: TitleGenerationResult = success
    ? { success: true, title: 'Generated title' }
    : { success: false, error: 'Unavailable' };
  const { conversation, finishGeneration, persistence, repository, started, titles } = createFixture(result);
  const regeneration = titles.regenerate(conversation.id);
  await started.promise;
  const saved: Array<{ title: string; titleGenerationStatus: Conversation['titleGenerationStatus'] }> = [];
  jest.mocked(persistence.saveMetadata).mockImplementation(async metadata => {
    saved.push({ title: metadata.title, titleGenerationStatus: metadata.titleGenerationStatus });
  });
  finishGeneration.resolve();
  await regeneration;

  const expected = {
    title: success ? 'Generated title' : 'Original title',
    titleGenerationStatus: success ? 'success' : 'failed',
  };
  expect(repository.getSync(conversation.id)).toMatchObject(expected);
  expect(saved).toEqual([expected]);
});

it('does not recreate a conversation deleted before title completion', async () => {
  const { conversation, finishGeneration, persistence, repository, started, titles } = createFixture();
  const regeneration = titles.regenerate(conversation.id);
  await started.promise;
  await repository.delete(conversation.id);
  jest.mocked(persistence.saveMetadata).mockClear();
  finishGeneration.resolve();
  await regeneration;

  expect(repository.getSync(conversation.id)).toBeNull();
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
});
