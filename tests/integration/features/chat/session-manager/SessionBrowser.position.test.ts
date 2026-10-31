/** @vitest-environment jsdom */
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import type { Mock } from 'vitest';

import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';



async function createFixture() {
  const projects = createProjectsFake();
  const { plugin, store } = await createSessionBrowserHost({ host: {
    projects, settings: { enableAutoTitleGeneration: true },
    renameConversation: vi.fn().mockResolvedValue(undefined),
  } });
  for (const method of ['delete', 'setPinned', 'archive'] as const) vi.spyOn(plugin.conversationLifecycle, method);
  const deps = { plugin: Object.assign(plugin, { projects }), store, state: { currentConversationId: null as string | null } };
  const controller = new SessionBrowser({
    plugin,
    getCurrentConversationId: () => deps.state.currentConversationId,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  onTestFinished(() => controller.dispose());
  return { deps, controller };
}

/** Scroll position and loaded row count carried across a session-list rerender. */
describe('SessionListPosition', () => {
  let controller: SessionBrowser;
  let deps: Awaited<ReturnType<typeof createFixture>>['deps'];

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ controller, deps } = await createFixture());
  });

  it('preserves grouped-list position and loaded count across an external rerender', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
        linkedContentPath: 'Projects/Plan.md',
      })),
    );
    const options = {
      onSelectConversation: vi.fn(),
      organization: 'linked-content' as const,
      sort: 'last-updated' as const,
      language: 'en',
      pageSize: 25,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-load-more')?.click();
    const previousList = container.querySelector<HTMLElement>('.claudian-history-list')!;
    previousList.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    const rerenderedList = container.querySelector<HTMLElement>('.claudian-history-list')!;
    expect([...rerenderedList.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(50);
    expect(rerenderedList.scrollTop).toBe(320);
  });

  it('preserves the projects section scroll across a rerender, such as expanding a project', () => {
    const container = document.body.createDiv();
    for (let index = 0; index < 30; index += 1) {
      deps.plugin.projects.put(projectRecord({ id: `project-${index}`, name: `Project ${index}` }));
    }
    const options = {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      scrollLayout: 'sections' as const,
      sessionScope: 'active' as const,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-session-project-items')!.scrollTop = 180;
    controller.renderHistoryDropdown(container, options);

    expect(container.querySelector<HTMLElement>('.claudian-session-project-items')!.scrollTop).toBe(180);
  });

  it('preserves the compact menu scroll, which moves its projects and sessions as one list', () => {
    const container = document.body.createDiv();
    deps.plugin.projects.put(projectRecord({ id: 'project-1', name: 'Project 1' }));
    (deps.plugin.getConversationList as Mock).mockReturnValue(
      Array.from({ length: 40 }, (_, index) => ({ id: `conv-${index}`, title: `Conversation ${index}`, createdAt: 40 - index })),
    );
    // The drop-up lists projects without the sidebar's Pinned section.
    const options = {
      onSelectConversation: vi.fn(),
      sessionScope: 'active' as const,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-list')!.scrollTop = 220;
    controller.renderHistoryDropdown(container, options);

    const list = container.querySelector<HTMLElement>('.claudian-history-list')!;
    expect(list.querySelector<HTMLElement>('.claudian-session-list-items')!).not.toBeNull();
    expect(list.scrollTop).toBe(220);
  });

  it('preserves flat session-list position and loaded count across an external rerender', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
      })),
    );
    const options = {
      onSelectConversation: vi.fn(),
      organization: 'list' as const,
      sort: 'last-updated' as const,
      pageSize: 25,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-load-more')?.click();
    const previousList = container.querySelector<HTMLElement>('.claudian-history-list')!;
    previousList.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    const rerenderedList = container.querySelector<HTMLElement>('.claudian-history-list')!;
    expect([...rerenderedList.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(50);
    expect(rerenderedList.scrollTop).toBe(320);
  });

  it('preserves the loaded session count through an empty search result', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue(
      Array.from({ length: 75 }, (_, index) => ({
        id: `conv-${index}`,
        title: `Conversation ${index}`,
        createdAt: 75 - index,
      })),
    );
    const options = {
      onSelectConversation: vi.fn(),
      pageSize: 25,
      preserveListState: true,
      showPinnedSection: true,
      scrollLayout: 'sections' as const,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-load-more')?.click();
    controller.renderHistoryDropdown(container, options);
    expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(50);

    controller.renderHistoryDropdown(container, {
      ...options,
      searchQuery: 'missing',
    });
    expect(container.querySelector<HTMLElement>('.claudian-history-list')?.dataset.visibleCount).toBe('50');

    controller.renderHistoryDropdown(container, options);
    expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(50);
  });

  it('preserves dual-mode pinned and session scroll positions across a rerender', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'pinned', title: 'Pinned', createdAt: 100, isPinned: true },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `session-${index}`,
        title: `Session ${index}`,
        createdAt: 40 - index,
      })),
    ]);
    const options = {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      scrollLayout: 'sections' as const,
      pageSize: 50,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    const pinnedItems = container.querySelector('.claudian-history-section--pinned')!
      .querySelector<HTMLElement>('.claudian-history-section-items')!;
    const sessionItems = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    pinnedItems.scrollTop = 24;
    sessionItems.scrollTop = 320;

    controller.renderHistoryDropdown(container, options);

    expect(
      container.querySelector('.claudian-history-section--pinned')!
        .querySelector<HTMLElement>('.claudian-history-section-items')!.scrollTop,
    ).toBe(24);
    expect(container.querySelector<HTMLElement>('.claudian-session-list-items')!.scrollTop).toBe(320);
  });

  it('preserves list position when archiving removes the final active session', () => {
    const container = document.body.createDiv();
    const conversation = {
      id: 'conv-1',
      title: 'Conversation',
      createdAt: 1,
      isArchived: false,
    };
    (deps.plugin.getConversationList as Mock).mockImplementation(() => [conversation]);
    const options = {
      onSelectConversation: vi.fn(),
      sessionScope: 'active' as const,
      sessionActionMode: 'active' as const,
      preserveListState: true,
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-list')!.scrollTop = 120;
    conversation.isArchived = true;

    controller.renderHistoryDropdown(container, options);

    expect(container.querySelector<HTMLElement>('.claudian-history-list')!.scrollTop).toBe(120);
  });

  it('installs surface controls before restoring preserved list position', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Conversation', createdAt: 1 },
    ]);
    const options = {
      onSelectConversation: vi.fn(),
      preserveListState: true,
      onBeforeRestoreListState: (listContainer: HTMLElement) => {
        const list = listContainer.querySelector<HTMLElement>('.claudian-history-list')!;
        list.insertBefore(document.createElement('div'), list.firstChild);
        // Installing controls resets scroll; restoration must run afterwards to win.
        list.scrollTop = 0;
      },
    };

    controller.renderHistoryDropdown(container, options);
    container.querySelector<HTMLElement>('.claudian-history-list')!.scrollTop = 120;

    controller.renderHistoryDropdown(container, options);

    expect(container.querySelector<HTMLElement>('.claudian-history-list')!.scrollTop).toBe(120);
  });

  it.each(['active', 'archived'] as const)(
    'installs surface controls when the %s session scope is empty',
    (sessionScope) => {
      const container = document.body.createDiv();
      const onBeforeRestoreListState = vi.fn((listContainer: HTMLElement) => {
        const list = listContainer.querySelector<HTMLElement>('.claudian-history-list')!;
        list.insertBefore(document.createElement('div'), list.firstChild);
      });
      (deps.plugin.getConversationList as Mock).mockReturnValue([]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: vi.fn(),
        sessionScope,
        preserveListState: true,
        onBeforeRestoreListState,
      });

      const list = container.querySelector<HTMLElement>('.claudian-history-list')!;
      expect(onBeforeRestoreListState).toHaveBeenCalledWith(container);
      const emptyState = list.querySelector<HTMLElement>('.claudian-history-empty')!;
      expect(list.children[0]).not.toBe(emptyState);
      expect(emptyState).not.toBeNull();
    },
  );
});

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
