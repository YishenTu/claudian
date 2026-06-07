import { createMockEl } from '@test/helpers/mockElement';

import type { ConversationMeta } from '@/core/types';
import type { TabBarItem } from '@/features/chat/tabs/types';
import { SessionsPanel } from '@/features/chat/ui/SessionsPanel';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    getChatUIConfig: jest.fn(() => ({ getProviderIcon: () => null })),
  },
}));

jest.mock('@/shared/icons', () => ({
  createProviderIconSvg: jest.fn(() => ({ tagName: 'svg' })),
}));

type FakeTabManager = {
  getTabBarItems: jest.Mock<TabBarItem[], []>;
  getAllTabs: jest.Mock<Array<{ conversationId: string | null }>, []>;
  switchToTab: jest.Mock;
  closeTab: jest.Mock;
  createTab: jest.Mock;
  openConversation: jest.Mock;
};

function makeTabItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Tab one',
    providerId: 'claude',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    canClose: true,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'conv-1',
    providerId: 'claude',
    title: 'Conversation one',
    createdAt: 1000,
    updatedAt: 1000,
    lastResponseAt: 1000,
    messageCount: 1,
    preview: '',
    ...overrides,
  };
}

describe('SessionsPanel', () => {
  let container: ReturnType<typeof createMockEl>;
  let tabManager: FakeTabManager;
  let plugin: any;

  function buildPlugin(options: {
    tabItems?: TabBarItem[];
    openConversationIds?: Array<string | null>;
    conversations?: ConversationMeta[];
    hasChatView?: boolean;
  }) {
    tabManager = {
      getTabBarItems: jest.fn(() => options.tabItems ?? []),
      getAllTabs: jest.fn(() => (options.openConversationIds ?? []).map((id) => ({ conversationId: id }))),
      switchToTab: jest.fn().mockResolvedValue(undefined),
      closeTab: jest.fn().mockResolvedValue(true),
      createTab: jest.fn().mockResolvedValue({ id: 'tab-new' }),
      openConversation: jest.fn().mockResolvedValue(undefined),
    };

    const chatView = { getTabManager: () => tabManager };

    plugin = {
      settings: { maxTabs: 3 },
      getActiveChatView: jest.fn(() => (options.hasChatView === false ? null : chatView)),
      getConversationList: jest.fn(() => options.conversations ?? []),
      activateView: jest.fn().mockResolvedValue(undefined),
      deleteConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    container = createMockEl('div');
  });

  it('renders open tabs with active highlight and excludes open conversations from recent', () => {
    buildPlugin({
      tabItems: [
        makeTabItem({ id: 'tab-1', title: 'Active tab', isActive: true }),
        makeTabItem({ id: 'tab-2', title: 'Other tab' }),
      ],
      openConversationIds: ['conv-open'],
      conversations: [
        makeConversation({ id: 'conv-open', title: 'Already open' }),
        makeConversation({ id: 'conv-recent', title: 'Recent only' }),
      ],
    });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const lists = container.querySelectorAll('.claudian-sessions-list');
    expect(lists.length).toBe(2);

    const openItems = lists[0].querySelectorAll('.claudian-sessions-item');
    expect(openItems.length).toBe(2);
    expect(openItems[0].hasClass('claudian-sessions-item--active')).toBe(true);

    const recentItems = lists[1].querySelectorAll('.claudian-sessions-item');
    // conv-open is excluded because it is already an open tab
    expect(recentItems.length).toBe(1);
    const recentTitle = recentItems[0].querySelector('.claudian-sessions-item-title');
    expect(recentTitle?.textContent).toBe('Recent only');
  });

  it('switches to a tab when an open row is clicked', () => {
    buildPlugin({
      tabItems: [makeTabItem({ id: 'tab-42', title: 'Clickable' })],
    });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const lists = container.querySelectorAll('.claudian-sessions-list');
    const content = lists[0].querySelectorAll('.claudian-sessions-item')[0]
      .querySelector('.claudian-sessions-item-content');
    content!.dispatchEvent({ type: 'click', stopPropagation: () => {} });

    expect(tabManager.switchToTab).toHaveBeenCalledWith('tab-42');
  });

  it('force-closes a streaming tab when its close button is clicked', () => {
    buildPlugin({
      tabItems: [makeTabItem({ id: 'tab-7', isStreaming: true, canClose: true })],
    });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const closeBtn = container.querySelector('.claudian-sessions-item-close');
    closeBtn!.dispatchEvent({ type: 'click', stopPropagation: () => {} });

    expect(tabManager.closeTab).toHaveBeenCalledWith('tab-7', true);
  });

  it('opens a recent conversation in a new tab when clicked', async () => {
    buildPlugin({
      conversations: [makeConversation({ id: 'conv-x', title: 'Resume me' })],
    });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const lists = container.querySelectorAll('.claudian-sessions-list');
    const content = lists[0].querySelectorAll('.claudian-sessions-item')[0]
      .querySelector('.claudian-sessions-item-content');
    content!.dispatchEvent({ type: 'click', stopPropagation: () => {} });

    await Promise.resolve();
    await Promise.resolve();

    expect(tabManager.openConversation).toHaveBeenCalledWith('conv-x', {
      preferNewTab: true,
      activate: true,
    });
  });

  it('creates a new tab when the New session button is clicked', async () => {
    buildPlugin({ tabItems: [makeTabItem()] });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const newBtn = container.querySelector('.claudian-sessions-new-btn');
    newBtn!.dispatchEvent({ type: 'click', stopPropagation: () => {} });

    await Promise.resolve();
    await Promise.resolve();

    expect(tabManager.createTab).toHaveBeenCalled();
  });

  it('shows an empty hint when there are no recent sessions', () => {
    buildPlugin({ tabItems: [], conversations: [] });

    const panel = new SessionsPanel(plugin, container as unknown as HTMLElement);
    panel.render();

    const empty = container.querySelector('.claudian-sessions-empty');
    expect(empty).not.toBeNull();
  });
});
