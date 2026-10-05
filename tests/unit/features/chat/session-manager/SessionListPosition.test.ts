import { createMockEl } from '@test/helpers/MockElement';

import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';

function createFixture() {
  const deps = {
    plugin: {
      app: {},
      getConversationList: jest.fn().mockReturnValue([]),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      conversationLifecycle: { delete: jest.fn().mockResolvedValue(undefined) },
      settings: { enableAutoTitleGeneration: true },
    },
    state: { currentConversationId: null as string | null },
  };
  const controller = new SessionBrowser({
    plugin: deps.plugin as unknown as SessionBrowserDeps['plugin'],
    getCurrentConversationId: () => deps.state.currentConversationId,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  return { deps, controller };
}

/** Scroll position and loaded row count carried across a session-list rerender. */
describe('SessionListPosition', () => {
  let controller: SessionBrowser;
  let deps: ReturnType<typeof createFixture>['deps'];

  beforeEach(() => {
    jest.clearAllMocks();
    ({ controller, deps } = createFixture());
  });

  it('preserves grouped-list position and loaded count across an external rerender', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
        linkedContentPath: 'Projects/Plan.md',
      })),
    );
    const options = {
      onSelectConversation: jest.fn(),
      organization: 'linked-content' as const,
      sort: 'last-updated' as const,
      language: 'en',
      pageSize: 25,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector('.claudian-history-load-more')?.click();
    const previousList = container.querySelector('.claudian-history-list')!;
    previousList.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    const rerenderedList = container.querySelector('.claudian-history-list')!;
    expect(rerenderedList.querySelectorAll('.claudian-history-item')).toHaveLength(50);
    expect(rerenderedList.scrollTop).toBe(320);
  });

  it('preserves flat session-list position and loaded count across an external rerender', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
      })),
    );
    const options = {
      onSelectConversation: jest.fn(),
      organization: 'list' as const,
      sort: 'last-updated' as const,
      pageSize: 25,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector('.claudian-history-load-more')?.click();
    const previousList = container.querySelector('.claudian-history-list')!;
    previousList.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    const rerenderedList = container.querySelector('.claudian-history-list')!;
    expect(rerenderedList.querySelectorAll('.claudian-history-item')).toHaveLength(50);
    expect(rerenderedList.scrollTop).toBe(320);
  });

  it('preserves the loaded session count through an empty search result', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
      })),
    );
    const options = {
      onSelectConversation: jest.fn(),
      pageSize: 25,
      preserveListState: true,
      showPinnedSection: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector('.claudian-history-load-more')?.click();
    controller.renderHistoryDropdown(container, options);
    expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(50);

    controller.renderHistoryDropdown(container, {
      ...options,
      searchQuery: 'missing',
    });
    expect(container.querySelector('.claudian-history-list')?.dataset.visibleCount).toBe('50');

    controller.renderHistoryDropdown(container, options);
    expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(50);
  });

  it('preserves dual-mode pinned and session scroll positions across a rerender', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'pinned', title: 'Pinned', createdAt: 100, isPinned: true },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `session-${index}`,
        title: `Session ${index}`,
        createdAt: 40 - index,
      })),
    ]);
    const options = {
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      pageSize: 50,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    const pinnedItems = container.querySelector('.claudian-history-section--pinned')!
      .querySelector('.claudian-history-section-items')!;
    const sessionItems = container.querySelector('.claudian-session-list-items')!;
    pinnedItems.scrollTop = 24;
    sessionItems.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    expect(
      container.querySelector('.claudian-history-section--pinned')!
        .querySelector('.claudian-history-section-items')!.scrollTop,
    ).toBe(24);
    expect(container.querySelector('.claudian-session-list-items')!.scrollTop).toBe(320);
  });

  it('preserves list position when archiving removes the final active session', () => {
    const container = createMockEl();
    const conversation = {
      id: 'conv-1',
      title: 'Conversation',
      createdAt: 1,
      isArchived: false,
    };
    (deps.plugin.getConversationList as jest.Mock).mockImplementation(() => [conversation]);
    const options = {
      onSelectConversation: jest.fn(),
      sessionScope: 'active' as const,
      sessionActionMode: 'active' as const,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector('.claudian-history-list')!.scrollTop = 120;
    conversation.isArchived = true;

    controller.renderHistoryDropdown(container, options);

    expect(container.querySelector('.claudian-history-list')!.scrollTop).toBe(120);
  });

  it('installs surface controls before restoring preserved list position', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Conversation', createdAt: 1 },
    ]);
    const options = {
      onSelectConversation: jest.fn(),
      preserveListState: true,
      onBeforeRestoreListState: (listContainer: HTMLElement) => {
        const list = listContainer.querySelector<HTMLElement>('.claudian-history-list')!;
        list.insertBefore(createMockEl(), list.firstChild);
        // Installing controls resets scroll; restoration must run afterwards to win.
        list.scrollTop = 0;
      },
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector('.claudian-history-list')!.scrollTop = 120;

    controller.renderHistoryDropdown(container, options);

    expect(container.querySelector('.claudian-history-list')!.scrollTop).toBe(120);
  });

  it.each(['active', 'archived'] as const)(
    'installs surface controls when the %s session scope is empty',
    (sessionScope) => {
      const container = createMockEl();
      const onBeforeRestoreListState = jest.fn((listContainer: HTMLElement) => {
        const list = listContainer.querySelector('.claudian-history-list')!;
        list.insertBefore(createMockEl(), list.firstChild);
      });
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: jest.fn(),
        sessionScope,
        preserveListState: true,
        onBeforeRestoreListState,
      });

      const list = container.querySelector('.claudian-history-list')!;
      expect(onBeforeRestoreListState).toHaveBeenCalledWith(container);
      const emptyState = list.querySelector('.claudian-history-empty');
      expect(list.children[0]).not.toBe(emptyState);
      expect(emptyState).not.toBeNull();
    },
  );
});
