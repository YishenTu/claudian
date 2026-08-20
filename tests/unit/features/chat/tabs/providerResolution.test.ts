import { getTabProviderId } from '@/features/chat/tabs/providerResolution';

describe('getTabProviderId', () => {
  it('keeps the blank tab provider when multiple providers own the same model id', () => {
    const tab = {
      conversationId: null,
      draftModel: 'shared-model',
      providerId: 'codex',
    } as any;
    const plugin = {
      getConversationSync: jest.fn(),
      settings: {},
    } as any;

    expect(getTabProviderId(tab, plugin)).toBe('codex');
    expect(plugin.getConversationSync).not.toHaveBeenCalled();
  });

  it('prefers durable conversation ownership over a stale runtime provider', () => {
    const tab = {
      conversationId: 'conversation-1',
      draftModel: null,
      providerId: 'codex',
    } as any;
    const plugin = {
      getConversationSync: jest.fn().mockReturnValue({ providerId: 'claude' }),
      settings: {},
    } as any;

    expect(getTabProviderId(tab, plugin)).toBe('claude');
  });
});
