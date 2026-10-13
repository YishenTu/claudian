import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { Notice } from 'obsidian';

import type { TitleGenerationService } from '@/core/providers/types';
import {
  ConversationTitleGeneration,
  fallbackConversationTitle,
} from '@/features/chat/conversation/ConversationTitleGeneration';

describe('fallbackConversationTitle', () => {
  it('uses the first sentence', () => {
    expect(fallbackConversationTitle('How do I set up React? I need help.')).toBe('How do I set up React');
  });

  it('truncates long titles to 50 chars', () => {
    const title = fallbackConversationTitle('A'.repeat(100));

    expect(title.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(title).toContain('...');
  });

  it('keeps messages without sentence breaks', () => {
    expect(fallbackConversationTitle('Hello world')).toBe('Hello world');
  });
});

describe('ConversationTitleGeneration.regenerate', () => {
  let host: {
    settings: Record<string, unknown>;
    getConversationById: jest.Mock;
    renameConversation: jest.Mock;
    completeConversationTitleGeneration: jest.Mock;
    updateConversation: jest.Mock;
  };
  let service: { generateTitle: jest.Mock; cancel: jest.Mock };
  let titles: ConversationTitleGeneration;

  function createTitles(getService: () => TitleGenerationService | null): ConversationTitleGeneration {
    return new ConversationTitleGeneration({ host: host as any, getService });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    host = {
      settings: {
        enableAutoTitleGeneration: true,
        titleGenerationModel: 'haiku',
        providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
      },
      getConversationById: jest.fn().mockResolvedValue(null),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      completeConversationTitleGeneration: jest.fn().mockResolvedValue(undefined),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    };
    service = { generateTitle: jest.fn().mockResolvedValue(undefined), cancel: jest.fn() };
    titles = createTitles(() => service as unknown as TitleGenerationService);
  });

  it.each(['', 'removed-model'])('gives settings guidance without pending status for title model %s', async model => {
    host.settings.titleGenerationModel = model;
    await titles.regenerate('conv-1');
    expect(service.generateTitle).not.toHaveBeenCalled();
    expect(host.updateConversation).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Select an available title model'));
  });

  it('should not regenerate if titleService is null', async () => {
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Old Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });

    await createTitles(() => null).regenerate('conv-1');

    expect(host.updateConversation).not.toHaveBeenCalled();
  });

  it('should not regenerate if enableAutoTitleGeneration is false', async () => {
    host.settings.enableAutoTitleGeneration = false;
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Old Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });

    await titles.regenerate('conv-1');

    expect(service.generateTitle).not.toHaveBeenCalled();
    expect(host.updateConversation).not.toHaveBeenCalled();
  });

  it('should not regenerate if conversation not found', async () => {
    await titles.regenerate('non-existent');

    expect(service.generateTitle).not.toHaveBeenCalled();
  });

  it('should not regenerate if conversation has no messages', async () => {
    host.getConversationById.mockResolvedValue({ id: 'conv-1', title: 'Title', messages: [] });

    await titles.regenerate('conv-1');

    expect(service.generateTitle).not.toHaveBeenCalled();
  });

  it('should not regenerate if no user message found', async () => {
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Title',
      messages: [
        { role: 'assistant', content: 'Hi' },
        { role: 'assistant', content: 'There' },
      ],
    });

    await titles.regenerate('conv-1');

    expect(service.generateTitle).not.toHaveBeenCalled();
  });

  it('should call titleService.generateTitle with correct params', async () => {
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Old Title',
      messages: [
        { role: 'user', content: 'Hello world', displayContent: 'Hello world!' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });

    service.generateTitle.mockImplementation(async () => {
      expect(host.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    await titles.regenerate('conv-1');

    expect(service.generateTitle).toHaveBeenCalledWith(
      'conv-1',
      'Hello world!', // Uses displayContent
      expect.any(Function),
    );
  });

  it('should regenerate title with only user message (no assistant yet)', async () => {
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Old Title',
      messages: [{ role: 'user', content: 'Hello world' }],
    });

    await titles.regenerate('conv-1');

    expect(service.generateTitle).toHaveBeenCalledWith(
      'conv-1',
      'Hello world',
      expect.any(Function),
    );
  });

  it('commits the generated title against the title captured before generation', async () => {
    host.getConversationById.mockResolvedValue({
      id: 'conv-1',
      title: 'Old Title',
      messages: [
        { role: 'user', content: 'Create a plan' },
        { role: 'assistant', content: 'Here is the plan...' },
      ],
    });
    service.generateTitle.mockImplementation(
      async (convId: string, _user: string, callback: any) => {
        await callback(convId, { success: true, title: 'New Generated Title' });
      },
    );

    await titles.regenerate('conv-1');

    expect(host.completeConversationTitleGeneration).toHaveBeenCalledWith('conv-1', 'Old Title', 'New Generated Title');
    expect(host.renameConversation).not.toHaveBeenCalled();
  });

  describe('generation callback', () => {
    beforeEach(() => {
      host.getConversationById.mockResolvedValue({
        id: 'conv-1',
        title: 'Original Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
        ],
      });
    });

    it('commits a failed generation against the captured title', async () => {
      service.generateTitle.mockImplementation(
        async (_convId: string, _user: string, callback: any) => {
          await callback('conv-1', { success: false, error: 'Unavailable' });
        },
      );

      await titles.regenerate('conv-1');

      expect(host.renameConversation).not.toHaveBeenCalled();
      expect(host.completeConversationTitleGeneration).toHaveBeenCalledWith('conv-1', 'Original Title', null);
    });
  });
});
