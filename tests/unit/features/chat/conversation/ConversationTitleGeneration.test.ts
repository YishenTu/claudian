import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { testDate } from '@test/helpers/testClock';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import type { TitleGenerationService } from '@/core/providers/types';
import {
  ConversationTitleGeneration,
  fallbackConversationTitle,
} from '@/features/chat/conversation/ConversationTitleGeneration';

describe('fallbackConversationTitle', () => {
  it('uses the first sentence', () => {
    expect(fallbackConversationTitle('How do I set up React? I need help.')).toBe('How do I set up React');
  });

  it.each([
    ['A'.repeat(100), 'A'.repeat(50) + '...'],
    ['A'.repeat(50), 'A'.repeat(50)],
    ['A'.repeat(49) + '\uD83D\uDE00tail', 'A'.repeat(49) + '...'],
    ['A'.repeat(48) + '\uD83D\uDE00tail', 'A'.repeat(48) + '\uD83D\uDE00...'],
    ['A'.repeat(48) + '\uD83D\uDE00', 'A'.repeat(48) + '\uD83D\uDE00'],
    ['  ' + 'A'.repeat(49) + '\uD83D\uDE00tail? Later sentence', 'A'.repeat(49) + '...'],
    ['A'.repeat(49) + '\u4E2Dtail', 'A'.repeat(49) + '\u4E2D...'],
  ])('preserves the 50-unit prefix and suffix without splitting pairs (%#)', (input, expected) => {
    expect(fallbackConversationTitle(input)).toBe(expected);
  });

  it('keeps messages without sentence breaks', () => {
    expect(fallbackConversationTitle('Hello world')).toBe('Hello world');
  });
});

describe('ConversationTitleGeneration', () => {
  let host: {
    settings: Record<string, unknown>;
    getConversationById: Mock;
    renameConversation: Mock;
    completeConversationTitleGeneration: Mock;
    updateConversation: Mock;
  };
  let service: { generateTitle: Mock; cancel: Mock };
  let titles: ConversationTitleGeneration;

  function createTitles(getService: () => TitleGenerationService | null): ConversationTitleGeneration {
    return new ConversationTitleGeneration({ host: host as any, getService });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    host = {
      settings: {
        enableAutoTitleGeneration: true,
        titleGenerationModel: 'haiku',
        providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
      },
      getConversationById: vi.fn().mockResolvedValue(null),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      completeConversationTitleGeneration: vi.fn().mockResolvedValue(undefined),
      updateConversation: vi.fn().mockResolvedValue(undefined),
    };
    service = { generateTitle: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
    titles = createTitles(() => service as unknown as TitleGenerationService);
  });

  it('uses a pair-safe first-turn fallback when automatic title generation is disabled', async () => {
    host.settings.enableAutoTitleGeneration = false;

    await titles.titleFirstTurn('conv-1', {
      id: 'user-1', role: 'user', content: 'A'.repeat(49) + '\uD83D\uDE00tail',
      timestamp: testDate().getTime(),
    });

    expect(host.renameConversation).toHaveBeenCalledTimes(1);
    expect(host.renameConversation).toHaveBeenCalledWith('conv-1', 'A'.repeat(49) + '...');
    expect(service.generateTitle).not.toHaveBeenCalled();
    expect(host.updateConversation).not.toHaveBeenCalled();
    expect(host.completeConversationTitleGeneration).not.toHaveBeenCalled();
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
