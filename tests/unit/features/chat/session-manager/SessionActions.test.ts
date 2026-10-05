import { createMockEl } from '@test/helpers/MockElement';
import { Menu } from 'obsidian';

import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';

function createFixture() {
  const deps = {
    plugin: {
      app: {},
      getConversationList: jest.fn().mockReturnValue([]),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      conversationLifecycle: { delete: jest.fn().mockResolvedValue(undefined), setPinned: jest.fn().mockResolvedValue(undefined), archive: jest.fn().mockResolvedValue(undefined) },
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

/** Session actions offered by rows, row menus, and group headers of a rendered session list. */
describe('SessionActions', () => {
  let controller: SessionBrowser;
  let deps: ReturnType<typeof createFixture>['deps'];

  beforeEach(() => {
    jest.clearAllMocks();
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    ({ controller, deps } = createFixture());
  });

  it('offers note pinning from linked-content header context menus', async () => {
    const container = createMockEl();
    const onSetLinkedContentPinned = jest.fn().mockResolvedValue(undefined);
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      organization: 'linked-content',
      sort: 'created',
      language: 'en',
      contentExists: () => true,
      pinnedLinkedContentPaths: new Set(['Projects/Plan.md']),
      onSetLinkedContentPinned,
    });

    const groupHeaders = container.querySelectorAll('.claudian-session-group-header');
    const pinnedHeader = groupHeaders.find((header: any) => (
      header.getAttribute('data-content-path') === 'Projects/Plan.md'
    ))!;
    pinnedHeader.dispatchEvent({
      type: 'contextmenu',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
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
    regularHeader.dispatchEvent({
      type: 'contextmenu',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Pin Linked content']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetLinkedContentPinned).toHaveBeenCalledWith('Projects/Other.md', true);
  });

  it('uses a DOM menu and archives non-running sessions from a linked-content header', async () => {
    const container = createMockEl();
    const onSetConversationsArchived = deps.plugin.conversationLifecycle.archive;
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
      onSelectConversation: jest.fn(),
      organization: 'linked-content',
      sessionActionMode: 'active',
      searchQuery: 'ready',
      getConversationStatus: id => ({
        openState: 'closed',
        isRunning: id === 'running' || id === 'busy',
      }),
      onSetLinkedContentPinned: jest.fn().mockResolvedValue(undefined),

    });

    const groupHeaders = container.querySelectorAll('.claudian-session-group-header');
    const planHeader = groupHeaders.find((header: any) => (
      header.getAttribute('data-content-path') === 'Projects/Plan.md'
    ))!;
    planHeader.dispatchEvent({
      type: 'contextmenu',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
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

    const busyContainer = createMockEl();
    controller.renderHistoryDropdown(busyContainer, {
      onSelectConversation: jest.fn(),
      organization: 'linked-content',
      sessionActionMode: 'active',
      searchQuery: 'busy',
      getConversationStatus: id => ({
        openState: 'closed',
        isRunning: id === 'running' || id === 'busy',
      }),
      onSetLinkedContentPinned: jest.fn().mockResolvedValue(undefined),

    });
    const busyHeader = busyContainer.querySelector('.claudian-session-group-header')!;
    busyHeader.dispatchEvent({
      type: 'contextmenu',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
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
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      sessionScope: 'active',
      sessionActionMode: 'active',


    });

    expect(container.querySelectorAll('.claudian-history-item-title')
      .map((el: { textContent: string }) => el.textContent))
      .toEqual(['Active']);
    expect(container.querySelector('.claudian-pin-btn')).not.toBeNull();
    expect(container.querySelector('.claudian-archive-btn')).not.toBeNull();
    expect(container.querySelector('.claudian-delete-btn')).toBeNull();
    expect(container.querySelectorAll('.claudian-action-btn').some(
      (button: { getAttribute(name: string): string | null | undefined }) => (
        button.getAttribute('aria-label') === 'Rename'
      ),
    )).toBe(false);
  });

  it('renders archived sessions with restore and delete actions only', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',

    });

    expect(container.querySelector('.claudian-history-section-label')?.textContent)
      .toBe('Archived');
    expect(container.querySelectorAll('.claudian-history-item-title')
      .map((el: { textContent: string }) => el.textContent))
      .toEqual(['Archived']);
    expect(container.querySelector('.claudian-restore-btn')).not.toBeNull();
    expect(container.querySelector('.claudian-delete-btn')).not.toBeNull();
    expect(container.querySelector('.claudian-pin-btn')).toBeNull();
    expect(container.querySelector('.claudian-archive-btn')).toBeNull();
  });

  it('disables archive actions for running sessions', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'running', title: 'Running', createdAt: 1 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      sessionScope: 'active',
      sessionActionMode: 'active',
      getConversationStatus: () => ({ openState: 'current', isRunning: true }),


    });

    const archiveButton = container.querySelector('.claudian-archive-btn')!;
    expect(archiveButton.getAttribute('disabled')).not.toBeNull();
    expect(archiveButton.getAttribute('aria-label'))
      .toBe('Cannot archive a running session');
  });

  it('delegates rerendering after deletion when the surface owner provides a callback', async () => {
    const container = createMockEl();
    const onRerender = jest.fn();

    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Test', createdAt: 1000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      onRerender,
    });

    const deleteBtn = container.querySelector('.claudian-delete-btn');
    const clickHandlers = deleteBtn?._eventListeners?.get('click');
    expect(clickHandlers).toBeDefined();

    clickHandlers![0]({ stopPropagation: jest.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalledWith(['conv-1']);
    expect(onRerender).toHaveBeenCalledTimes(1);
  });

  it('should render a new-tab button for closed conversations', async () => {
    const container = createMockEl();
    const onSelectConversation = jest.fn();
    const onOpenConversationInNewTab = jest.fn().mockResolvedValue(undefined);

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Closed', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation,
      onOpenConversationInNewTab,
      getConversationOpenState: (id) => id === 'conv-2' ? 'closed' : 'current',
    });

    const list = container.children[1];
    const closedItem = list.children[1];
    const openInNewTabBtn = closedItem.querySelector('.claudian-open-new-tab-btn');
    const clickHandlers = openInNewTabBtn?._eventListeners?.get('click');

    expect(openInNewTabBtn).toBeTruthy();
    expect(clickHandlers).toBeDefined();

    await clickHandlers![0]({ stopPropagation: jest.fn() });

    expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it('should not render a new-tab button for already-open conversations', () => {
    const container = createMockEl();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
      getConversationOpenState: (id) => id === 'conv-2' ? 'open' : 'current',
    });

    const list = container.children[1];
    const openItem = list.children[1];

    expect(openItem.querySelector('.claudian-open-new-tab-btn')).toBeNull();
  });

  it('should show new-tab actions in the context menu for closed conversations', () => {
    const container = createMockEl();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
      getConversationOpenState: () => 'closed',
    });

    const list = container.children[1];
    const otherItem = list.children[1];
    otherItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Open in new tab',
      'Open in background tab',
      'Rename',
      'Delete',
    ]);
  });

  it('should show switch action in the context menu for already-open conversations', () => {
    const container = createMockEl();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
      getConversationOpenState: () => 'open',
    });

    const list = container.children[1];
    const otherItem = list.children[1];
    otherItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Switch to open session',
      'Rename',
      'Delete',
    ]);
  });

  it('should derive context menu open state from conversation status', () => {
    const container = createMockEl();

    deps.state.currentConversationId = 'conv-1';
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
      { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
      getConversationStatus: (id) => id === 'conv-2'
        ? { openState: 'open', isRunning: false, location: 'current-view', tabIndex: 2 }
        : { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 },
    });

    const list = container.children[1];
    const otherItem = list.children[1];
    otherItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });

    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual([
      'Switch to open session',
      'Rename',
      'Delete',
    ]);
  });

  it('hides tab-aware context actions on the Sessions surface', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'conv-1', title: 'Open elsewhere', createdAt: 1000 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      getConversationStatus: () => ({
        openState: 'open',
        isRunning: false,
        location: 'current-view',
        tabIndex: 2,
      }),
      showOpenStateActions: false,
      showOpenStateLabels: false,
    });

    container.querySelector('.claudian-history-item')!.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });

    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances[0];
    expect(menu.items.map(item => item.title)).toEqual(['Rename', 'Delete']);
  });

  it('shows inline device assignment beside pin and archive only for legacy sessions', async () => {
    const container = createMockEl();
    const onAssignConversationToDevice = jest.fn().mockResolvedValue(undefined);
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
      onSelectConversation: jest.fn(),
      onAssignConversationToDevice,


      sessionActionMode: 'active',
      showOpenStateActions: false,
    });

    const items = container.querySelectorAll('.claudian-history-item');
    const legacyItem = items.find((item: HTMLElement) => (
      item.getAttribute('data-conversation-id') === 'legacy'
    ))!;
    const deviceItem = items.find((item: HTMLElement) => (
      item.getAttribute('data-conversation-id') === 'device'
    ))!;
    const assignButton = legacyItem.querySelector(
      '.claudian-assign-device-btn',
    )!;
    expect(assignButton).not.toBeNull();
    expect(deviceItem.querySelector('.claudian-assign-device-btn')).toBeNull();
    expect(
      legacyItem.querySelector('.claudian-history-item-actions')!.children
        .map((button: HTMLElement) => button.getAttribute('aria-label')),
    ).toEqual(['Generate title', 'Assign to this device', 'Pin', 'Archive']);

    assignButton.dispatchEvent({
      type: 'click',
      stopPropagation: jest.fn(),
    });
    await Promise.resolve();
    expect(onAssignConversationToDevice).toHaveBeenCalledWith('legacy');

    legacyItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual([
      'Pin',
      'Rename',
      'Archive',
    ]);
  });

  it('offers pin and unpin actions on the Sessions surface', async () => {
    const container = createMockEl();
    const onSetConversationPinned = deps.plugin.conversationLifecycle.setPinned;
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'normal', title: 'Normal', createdAt: 2 },
      { id: 'pinned', title: 'Pinned', createdAt: 1, isPinned: true },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      sessionActionMode: 'active',

      showOpenStateActions: false,
    });

    const normalItem = container.querySelector('.claudian-history-section--sessions')!
      .querySelector('.claudian-history-item')!;
    normalItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    let menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Archive']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetConversationPinned).toHaveBeenCalledWith(['normal'], true);

    const pinnedItem = container.querySelector('.claudian-history-section--pinned')!
      .querySelector('.claudian-history-item')!;
    pinnedItem.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual(['Unpin', 'Rename', 'Archive']);
    menu.items[0].clickHandler?.();
    await Promise.resolve();
    expect(onSetConversationPinned).toHaveBeenCalledWith(['pinned'], false);
  });

  it('hides the inline pin action without removing the context-menu action', () => {
    const container = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
    ]);

    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn(),


      sessionActionMode: 'active',
      showInlinePinAction: false,
      showOpenStateActions: false,
    });

    const item = container.querySelector('.claudian-history-item')!;
    expect(item.querySelector('.claudian-pin-btn')).toBeNull();
    expect(item.querySelector('.claudian-archive-btn')).not.toBeNull();

    item.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string }> }>;
    }).instances.at(-1)!;
    expect(menu.items.map(menuItem => menuItem.title)).toEqual([
      'Pin',
      'Rename',
      'Archive',
    ]);
  });

  it('keeps rename in the active context menu and delete in Archived only', () => {
    const activeContainer = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'active', title: 'Active', createdAt: 2 },
    ]);
    controller.renderHistoryDropdown(activeContainer, {
      onSelectConversation: jest.fn(),
      showPinnedSection: true,
      sessionScope: 'active',
      sessionActionMode: 'active',
      showOpenStateActions: false,


    });
    activeContainer.querySelector('.claudian-history-item')!.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    let menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{ title: string }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Archive']);

    const archivedContainer = createMockEl();
    (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
      { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
    ]);
    controller.renderHistoryDropdown(archivedContainer, {
      onSelectConversation: jest.fn(),
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      showOpenStateActions: false,

    });
    archivedContainer.querySelector('.claudian-history-item')!.dispatchEvent({
      type: 'contextmenu',
      stopPropagation: jest.fn(),
      preventDefault: jest.fn(),
    });
    menu = (Menu as typeof Menu & {
      instances: Array<{
        items: Array<{ title: string }>;
        useNativeMenu: boolean | null;
      }>;
    }).instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual(['Restore', 'Delete']);
  });
});
