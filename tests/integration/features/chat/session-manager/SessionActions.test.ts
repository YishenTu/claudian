/** @vitest-environment jsdom */
import { createHarness } from '@test/helpers/ChatExecutionHarness';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { fireEvent } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';

async function createFixture(options: { host?: Pick<import('@/features/chat/ChatFeatureHost').ChatFeatureHost, 'executionPersistence'>; onSessionChanged?: () => void } = {}) {
  const projects = createProjectsFake();
  const { plugin, store, pool } = await createSessionBrowserHost({ ...options, host: {
    projects, settings: { enableAutoTitleGeneration: true },
    renameConversation: vi.fn().mockResolvedValue(undefined),
    ...options.host,
  } });
  for (const method of ['delete', 'setPinned', 'archive'] as const) vi.spyOn(plugin.conversationLifecycle, method);
  const deps = { plugin: Object.assign(plugin, { projects }), store, pool, state: { currentConversationId: null as string | null } };
  const controller = new SessionBrowser({
    plugin,
    getCurrentConversationId: () => deps.state.currentConversationId,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  onTestFinished(() => controller.dispose());
  return { deps, controller };
}

/** Session actions offered by rows, row menus, and group headers of a rendered session list. */
describe('SessionActions', () => {
  let controller: SessionBrowser;
  let deps: Awaited<ReturnType<typeof createFixture>>['deps'];

  beforeEach(async () => {
    vi.clearAllMocks();
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    ({ controller, deps } = await createFixture());
  });

  it('offers note pinning from linked-content header context menus', async () => {
    const container = document.body.createDiv();
    const onSetLinkedContentPinned = vi.fn().mockResolvedValue(undefined);
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      {
        id: 'plan',
        title: 'Plan session',
        createdAt: 2,
        linkedContentPath: 'Projects/Plan.md',
      },
      {
        id: 'other',
        title: 'Other session',
        createdAt: 1,
        linkedContentPath: 'Projects/Other.md',
      },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      organization: 'linked-content',
      sort: 'created',
      language: 'en',
      contentExists: () => true,
      pinnedLinkedContentPaths: new Set(['Projects/Plan.md']),
      onSetLinkedContentPinned,
    });

    const groupHeaders = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')];
    const pinnedHeader = groupHeaders.find((header: any) => (
      header.getAttribute('data-content-path') === 'Projects/Plan.md'
    ))!;
    fireEvent.contextMenu(pinnedHeader, {preventDefault: vi.fn(), stopPropagation: vi.fn()});
    let menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Unpin Linked content']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetLinkedContentPinned).toHaveBeenCalledWith('Projects/Plan.md', false);

    const regularHeader = groupHeaders.find((header: any) => (
      header.getAttribute('data-content-path') === 'Projects/Other.md'
    ))!;
    fireEvent.contextMenu(regularHeader, {preventDefault: vi.fn(), stopPropagation: vi.fn()});
    menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Pin Linked content']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetLinkedContentPinned).toHaveBeenCalledWith('Projects/Other.md', true);
  });

  it('uses a DOM menu and archives non-running sessions from a linked-content header', async () => {
    const container = document.body.createDiv();
    const onSetConversationsArchived = deps.plugin.conversationLifecycle.archive;
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      {
        id: 'ready',
        title: 'Ready session',
        createdAt: 3,
        linkedContentPath: 'Projects/Plan.md',
      },
      {
        id: 'running',
        title: 'Running session',
        createdAt: 2,
        linkedContentPath: 'Projects/Plan.md',
      },
      {
        id: 'hidden',
        title: 'Hidden session',
        createdAt: 1,
        linkedContentPath: 'Projects/Plan.md',
      },
      {
        id: 'busy',
        title: 'Busy session',
        createdAt: 0,
        linkedContentPath: 'Projects/Busy.md',
      },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      organization: 'linked-content',
      sessionActionMode: 'active',
      searchQuery: 'ready',
      getConversationStatus: id => ({
        openState: 'closed',
        isRunning: id === 'running' || id === 'busy',
      }),
      onSetLinkedContentPinned: vi.fn().mockResolvedValue(undefined),

    });

    const groupHeaders = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')];
    const planHeader = groupHeaders.find((header: any) => (
      header.getAttribute('data-content-path') === 'Projects/Plan.md'
    ))!;
    fireEvent.contextMenu(planHeader, {preventDefault: vi.fn(), stopPropagation: vi.fn()});
    let menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{
          title: string;
          disabled: boolean;
          clickHandler: (() => void) | null;
        }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual([
      'Pin Linked content',
      'Archive all sessions',
    ]);
    expect(menu.items[1].disabled).toBe(false);
    menu.items[1].clickHandler?.();
    await Promise.resolve();
    expect(onSetConversationsArchived).toHaveBeenCalledWith(['ready', 'hidden']);

    const busyContainer = document.createElement('div');
    controller.renderHistoryDropdown(busyContainer, {
      onSelectConversation: vi.fn(),
      organization: 'linked-content',
      sessionActionMode: 'active',
      searchQuery: 'busy',
      getConversationStatus: id => ({
        openState: 'closed',
        isRunning: id === 'running' || id === 'busy',
      }),
      onSetLinkedContentPinned: vi.fn().mockResolvedValue(undefined),

    });
    const busyHeader = busyContainer.querySelector<HTMLElement>('.claudian-session-group-header')!;
    fireEvent.contextMenu(busyHeader, {preventDefault: vi.fn(), stopPropagation: vi.fn()});
    menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{
          title: string;
          disabled: boolean;
          clickHandler: (() => void) | null;
        }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.items[1].disabled).toBe(true);
    expect(menu.items[1].clickHandler).toBeNull();
  });

  it('renders active session management actions without archived sessions', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      sessionScope: 'active',
      sessionActionMode: 'active',

    });

    expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
      .map((el: { textContent: string }) => el.textContent))
      .toEqual(['Active']);
    expect(container.querySelector<HTMLElement>('.claudian-pin-btn')!).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-archive-btn')!).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-delete-btn')!).toBeNull();
    expect([...container.querySelectorAll<HTMLElement>('.claudian-action-btn')].some(
      (button: { getAttribute(name: string): string | null | undefined }) => (
        button.getAttribute('aria-label') === 'Rename'
      ),
    )).toBe(false);
  });

  it('marks released and never-loaded sessions unread, and read again, from their row menus', async () => {
    const harness = createHarness();
    const onChanged = vi.fn();
    ({ controller, deps } = await createFixture({
      host: { executionPersistence: harness.repository }, onSessionChanged: onChanged,
    }));
    const pool = deps.pool;
    // Opened earlier, then closed: the session keeps a runtime but no loaded model.
    const { attachment } = pool.acquire({ conversationId: 'seen', providerId: 'claude', draftModel: null }, { reveal: vi.fn() });
    pool.release(attachment);
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'seen', title: 'Seen', createdAt: 2 },
      { id: 'never-opened', title: 'Never opened', createdAt: 1, providerId: 'codex' },
    ]);
    const render = () => {
      const container = document.body.createDiv();
      controller.renderHistoryDropdown(container, {
        onSelectConversation: vi.fn(),
        sessionActionMode: 'active',
        sessionScope: 'active',
        showAttentionState: true,
        showOpenStateLabels: false,
        showOpenStateActions: false,
        getConversationStatus: id => ({
          openState: 'closed',
          isRunning: false,
          attention: pool.get(id)?.statusAttention ?? null,
        }),
      });
      return (id: string) => [...container.querySelectorAll<HTMLElement>('.claudian-history-item')].find(
        (item: HTMLElement) => item.getAttribute('data-conversation-id') === id,
      )!;
    };
    const openMenu = (item: HTMLElement) => {
      fireEvent.contextMenu(item, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
      return (Menu as typeof Menu & {
        instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
      }).instances.at(-1)!;
    };

    let findItem = render();
    expect(findItem('seen').querySelector<HTMLElement>('.claudian-session-status-indicator')!).toBeNull();
    let menu = openMenu(findItem('seen'));
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Mark as unread', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    menu.items[1].clickHandler?.();

    expect(onChanged).toHaveBeenCalled();
    findItem = render();
    const badge = findItem('seen').querySelector<HTMLElement>('.claudian-session-status-indicator--unread')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Unread');
    expect(findItem('seen').hasClass('claudian-history-item--attention')).toBe(true);
    menu = openMenu(findItem('seen'));
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Mark as read', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    menu.items[1].clickHandler?.();

    findItem = render();
    expect(findItem('seen').querySelector<HTMLElement>('.claudian-session-status-indicator')!).toBeNull();
    expect(findItem('seen').hasClass('claudian-history-item--attention')).toBe(false);

    // A session not loaded since startup gets its session without loading history.
    expect(pool.get('never-opened')).toBeNull();
    menu = openMenu(findItem('never-opened'));
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Mark as unread', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    menu.items[1].clickHandler?.();
    expect(pool.get('never-opened')?.providerId).toBe('codex');
    expect(pool.get('never-opened')?.peekModel).toBeNull();
    findItem = render();
    expect(findItem('never-opened').querySelector<HTMLElement>('.claudian-session-status-indicator--unread')!).not.toBeNull();

    // An error badge, like other badges, outranks the unread dot and offers no read-state action.
    pool.get('never-opened')!.attention.markReviewRequired('error');
    findItem = render();
    expect(findItem('never-opened').querySelector<HTMLElement>('.claudian-session-status-indicator--error')!).not.toBeNull();
    expect(openMenu(findItem('never-opened')).items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    await pool.dispose();
  });

  it('renders archived sessions with restore and delete actions only', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',

    });

    expect(container.querySelector<HTMLElement>('.claudian-history-section-label')?.textContent)
      .toBe('Archived');
    expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
      .map((el: { textContent: string }) => el.textContent))
      .toEqual(['Archived']);
    expect(container.querySelector<HTMLElement>('.claudian-restore-btn')!).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-delete-btn')!).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-pin-btn')!).toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-archive-btn')!).toBeNull();
  });

  it('delegates rerendering after deletion when the surface owner provides a callback', async () => {
    const container = document.body.createDiv();
    const onRerender = vi.fn();

    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Test', createdAt: 1000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onRerender,
    });

    const deleteBtn = container.querySelector<HTMLElement>('.claudian-delete-btn')!;

    fireEvent.click(deleteBtn!);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalledWith(['conv-1']);
    expect(onRerender).toHaveBeenCalledTimes(1);
  });

  it('should render a new-tab button for closed conversations', async () => {
    const container = document.body.createDiv();
    const onSelectConversation = vi.fn();
    const onOpenConversationInNewTab = vi.fn().mockResolvedValue(undefined);

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Closed', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation,
      onOpenConversationInNewTab,
      getConversationOpenState: (id) => id === 'conv-2' ? 'closed' : 'current',
    });

    const list = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    const closedItem = list.children[1];
    const openInNewTabBtn = closedItem.querySelector<HTMLElement>('.claudian-open-new-tab-btn')!;

    expect(openInNewTabBtn).toBeTruthy();

    fireEvent.click(openInNewTabBtn!);
    await Promise.resolve();

    expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it('should not render a new-tab button for already-open conversations', () => {
    const container = document.body.createDiv();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onOpenConversationInNewTab: vi.fn().mockResolvedValue(undefined),
      getConversationOpenState: (id) => id === 'conv-2' ? 'open' : 'current',
    });

    const list = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    const openItem = list.children[1];

    expect(openItem.querySelector<HTMLElement>('.claudian-open-new-tab-btn')!).toBeNull();
  });

  it('should show new-tab actions in the context menu for closed conversations', () => {
    const container = document.body.createDiv();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onOpenConversationInNewTab: vi.fn().mockResolvedValue(undefined),
      getConversationOpenState: () => 'closed',
    });

    const list = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    const otherItem = list.children[1];
    fireEvent.contextMenu(otherItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Open in new tab',
      'Open in background tab',
      'Rename',
      'Copy session ID',
      'Delete',
    ]);
  });

  it('should show switch action in the context menu for already-open conversations', () => {
    const container = document.body.createDiv();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onOpenConversationInNewTab: vi.fn().mockResolvedValue(undefined),
      getConversationOpenState: () => 'open',
    });

    const list = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    const otherItem = list.children[1];
    fireEvent.contextMenu(otherItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Switch to open session',
      'Rename',
      'Copy session ID',
      'Delete',
    ]);
  });

  it('should derive context menu open state from conversation status', () => {
    const container = document.body.createDiv();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onOpenConversationInNewTab: vi.fn().mockResolvedValue(undefined),
      getConversationStatus: (id) => id === 'conv-2'
        ? { openState: 'open', isRunning: false, location: 'current-view', tabIndex: 2 }
        : { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 },
    });

    const list = container.querySelector<HTMLElement>('.claudian-session-list-items')!;
    const otherItem = list.children[1];
    fireEvent.contextMenu(otherItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Switch to open session',
      'Rename',
      'Copy session ID',
      'Delete',
    ]);
  });

  it('hides tab-aware context actions on the Sessions surface', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'conv-1', title: 'Open elsewhere', createdAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      getConversationStatus: () => ({
        openState: 'open',
        isRunning: false,
        location: 'current-view',
        tabIndex: 2,
      }),
      showOpenStateActions: false,
      showOpenStateLabels: false,
    });

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.claudian-history-item')!, {stopPropagation: vi.fn(), preventDefault: vi.fn()});

    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual(['Rename', 'Copy session ID', 'Delete']);
  });

  it('shows inline device assignment beside pin and archive only for legacy sessions', async () => {
    const container = document.body.createDiv();
    const onAssignConversationToDevice = vi.fn().mockResolvedValue(undefined);
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      {
        id: 'legacy',
        title: 'Legacy session',
        createdAt: 1,
        isLegacySession: true,
      },
      {
        id: 'device',
        title: 'Device session',
        createdAt: 0,
      },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      onAssignConversationToDevice,

      sessionActionMode: 'active',
      showOpenStateActions: false,
    });

    const items = [...container.querySelectorAll<HTMLElement>('.claudian-history-item')];
    const legacyItem = items.find((item: HTMLElement) => (
      item.getAttribute('data-conversation-id') === 'legacy'
    ))!;
    const deviceItem = items.find((item: HTMLElement) => (
      item.getAttribute('data-conversation-id') === 'device'
    ))!;
    const assignButton = legacyItem.querySelector<HTMLElement>(
      '.claudian-assign-device-btn',
    )!;
    expect(assignButton).not.toBeNull();
    expect(deviceItem.querySelector<HTMLElement>('.claudian-assign-device-btn')!).toBeNull();
    expect(
      Array.from(legacyItem.querySelector<HTMLElement>('.claudian-history-item-actions')!.children)
        .map((button: Element) => button.getAttribute('aria-label')),
    ).toEqual(['Generate title', 'Assign to this device', 'Pin', 'Archive']);

    fireEvent.click(assignButton, {stopPropagation: vi.fn()});
    await Promise.resolve();
    expect(onAssignConversationToDevice).toHaveBeenCalledWith('legacy');

    fireEvent.contextMenu(legacyItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual([
      'Pin',
      'Rename',
      'Copy session ID',
      'Move to project…',
      'Archive',
    ]);
  });

  it('offers pin and unpin actions on the Sessions surface', async () => {
    const container = document.body.createDiv();
    const onSetConversationPinned = deps.plugin.conversationLifecycle.setPinned;
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'normal', title: 'Normal', createdAt: 2 },
      { id: 'pinned', title: 'Pinned', createdAt: 1, isPinned: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      sessionActionMode: 'active',

      showOpenStateActions: false,
    });

    const normalItem = container.querySelector('.claudian-history-section--sessions')!
      .querySelector<HTMLElement>('.claudian-history-item')!;
    fireEvent.contextMenu(normalItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    let menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetConversationPinned).toHaveBeenCalledWith(['normal'], true);

    const pinnedItem = container.querySelector('.claudian-history-section--pinned')!
      .querySelector<HTMLElement>('.claudian-history-item')!;
    fireEvent.contextMenu(pinnedItem, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Unpin', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetConversationPinned).toHaveBeenCalledWith(['pinned'], false);
  });

  it('hides the inline pin action without removing the context-menu action', () => {
    const container = document.body.createDiv();
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn(),

      sessionActionMode: 'active',
      showInlinePinAction: false,
      showOpenStateActions: false,
    });

    const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
    expect(item.querySelector<HTMLElement>('.claudian-pin-btn')!).toBeNull();
    expect(item.querySelector<HTMLElement>('.claudian-archive-btn')!).not.toBeNull();

    fireEvent.contextMenu(item, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(menuItem => menuItem.title)).toEqual([
      'Pin',
      'Rename',
      'Copy session ID',
      'Move to project…',
      'Archive',
    ]);
  });

  it('keeps rename in the active context menu and delete in Archived only', () => {
    const activeContainer = document.createElement('div');
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
    ]);
    controller.renderHistoryDropdown(activeContainer, {
      onSelectConversation: vi.fn(),
      showPinnedSection: true,
      sessionScope: 'active',
      sessionActionMode: 'active',
      showOpenStateActions: false,

    });
    fireEvent.contextMenu(activeContainer.querySelector<HTMLElement>('.claudian-history-item')!, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    let menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{ title: string }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Copy session ID', 'Move to project…', 'Archive']);

    const archivedContainer = document.createElement('div');
    (deps.plugin.getConversationList as Mock).mockReturnValue([
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);
    controller.renderHistoryDropdown(archivedContainer, {
      onSelectConversation: vi.fn(),
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      showOpenStateActions: false,

    });
    fireEvent.contextMenu(archivedContainer.querySelector<HTMLElement>('.claudian-history-item')!, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
    menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{ title: string }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual(['Restore', 'Delete']);
  });

  it('copies the session ID from non-archived row menus so agents can target the session', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const openRowMenu = (conversation: Record<string, unknown>, mode: 'active' | 'archived') => {
      const container = document.body.createDiv();
      (deps.plugin.getConversationList as Mock).mockReturnValue([conversation]);
      controller.renderHistoryDropdown(container, {
        onSelectConversation: vi.fn(),
        showPinnedSection: mode === 'active',
        showArchivedSection: mode === 'archived',
        sessionScope: mode,
        sessionActionMode: mode,
        showOpenStateActions: false,
      });
      fireEvent.contextMenu(container.querySelector<HTMLElement>('.claudian-history-item')!, {stopPropagation: vi.fn(), preventDefault: vi.fn()});
      return (Menu as typeof Menu & {
        instances: Array<{ items: Array<{ title: string; clickHandler?: () => void }> }>;
      }).instances.at(-1)!;
    };

    const activeMenu = openRowMenu({ id: 'conv-active-1', title: 'Active', createdAt: 2 }, 'active');
    const copyItem = activeMenu.items.find(item => item.title === 'Copy session ID');
    expect(copyItem).toBeDefined();
    copyItem!.clickHandler!();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('conv-active-1');

    const archivedMenu = openRowMenu({ id: 'conv-archived', title: 'Archived', createdAt: 1, isArchived: true }, 'archived');
    expect(archivedMenu.items.map(item => item.title)).toEqual(['Restore', 'Delete']);
  });
});

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
