import { createMockEl } from '@test/helpers/MockElement';
import { testDate } from '@test/helpers/testClock';
import { Menu, setIcon } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import {
  SessionManagerSurface,
  type SessionSurfaceNavigation,
} from '@/features/chat/session-manager/SessionManagerSurface';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';

type MockMenuItem = { title: string; checked: boolean | null; clickHandler: (() => void) | null };
type MockMenu = { items: MockMenuItem[] };

const menuInstances = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;

function conversation(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const at = testDate({ hours: -1 }).getTime();
  return {
    id,
    providerId: 'claude',
    title: id,
    createdAt: at,
    lastActivityAt: at,
    messageCount: 1,
    preview: '',
    ...overrides,
  };
}

interface HarnessOptions {
  conversations?: ConversationMeta[];
  settings?: Record<string, unknown>;
  wide?: boolean;
  canCreateTab?: boolean | null;
  conversationLifecycle?: unknown;
  getActiveTab?: () => unknown;
}

function createHarness(options: HarnessOptions = {}) {
  const conversations = [...(options.conversations ?? [])];
  const settings: Record<string, unknown> = {
    enableAutoTitleGeneration: false,
    ...options.settings,
  };
  const plugin = {
    app: { vault: { getAbstractFileByPath: jest.fn(() => null) } },
    settings,
    getConversationList: () => conversations,
    conversationLifecycle: options.conversationLifecycle ?? {
      archive: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      restore: jest.fn().mockResolvedValue(undefined),
      setArchived: jest.fn().mockResolvedValue(undefined),
      setPinned: jest.fn().mockResolvedValue(undefined),
    },
    assignConversationToCurrentDevice: jest.fn().mockResolvedValue(undefined),
    mutateSettings: jest.fn(async (mutation: (value: Record<string, unknown>) => void) => {
      const previous = { ...settings };
      mutation(settings);
      publisher.publishSettings(settings as never, previous as never);
    }),
    renameConversation: jest.fn().mockResolvedValue(undefined),
    setLinkedContentPinned: jest.fn().mockResolvedValue(undefined),
  };
  const navigation = {
    contentExists: jest.fn((_contentPath: string) => true),
    getConversationStatus: jest.fn((_id: string) => ({ openState: 'closed' as const, isRunning: false })),
    hasUnboundDraft: jest.fn(() => false),
    openConversation: jest.fn().mockResolvedValue(undefined),
    openSessionConversation: jest.fn().mockResolvedValue(undefined),
    startLinkedContentConversation: jest.fn().mockResolvedValue(undefined),
  } satisfies SessionSurfaceNavigation;
  const state = {
    wide: options.wide ?? true,
    canCreateTab: options.canCreateTab === undefined ? true : options.canCreateTab,
  };
  const requestNew = jest.fn();
  const notifyOtherViews = jest.fn();
  const surface = new SessionManagerSurface({
    plugin: plugin as unknown as ChatFeatureHost,
    navigation,
    getActiveTab: (options.getActiveTab ?? (() => null)) as never,
    isWide: () => state.wide,
    canCreateTab: () => state.canCreateTab,
    requestNew,
    notifyOtherViews,
  });
  const publisher = new ChatViewPublisher({
    views: { getAllViews: () => [
      { notifyConversationListChanged: () => surface.invalidate() },
      { notifyConversationListChanged: notifyOtherViews },
    ] as never },
    zenMode: { reconcile: jest.fn() }, inactiveSessions: { request: jest.fn() },
    hasLoadedAllSessionMetadata: () => true,
  });
  const sidebarEl = createMockEl();
  surface.mountSidebar(sidebarEl);
  const navEl = createMockEl();
  surface.mountHistoryControl(navEl);

  return {
    conversations,
    historyButton: navEl.querySelector('.claudian-input-nav-btn'),
    historyMenu: navEl.querySelector('.claudian-history-menu'),
    navigation,
    notifyOtherViews,
    plugin,
    requestNew,
    sessionSurfaceEl: sidebarEl.querySelector('.claudian-session-surface'),
    settings,
    sidebarEl,
    state,
    surface,
  };
}

function renderedIds(container: any): string[] {
  return container.querySelectorAll('.claudian-history-item')
    .map((item: any) => item.getAttribute('data-conversation-id'));
}

function findItem(container: any, conversationId: string): any {
  return container.querySelectorAll('.claudian-history-item')
    .find((item: any) => item.getAttribute('data-conversation-id') === conversationId);
}

function navLabel(control: any): string | undefined {
  return control?.querySelector('.claudian-session-nav-label')?.textContent;
}

function sessionsHeaderLabel(container: any): string | undefined {
  return container.querySelector('.claudian-session-list-header')
    ?.querySelector('.claudian-history-section-label')?.textContent;
}

function searchInput(container: any): any {
  return container.querySelector('.claudian-session-search-input');
}

function typeSearch(container: any, value: string): void {
  const input = searchInput(container);
  input.value = value;
  input.dispatchEvent('input');
}

function headerActions(container: any): any {
  return container.querySelector('.claudian-session-header-actions');
}

afterEach(() => {
  jest.restoreAllMocks();
  menuInstances().length = 0;
});

describe('SessionManagerSurface session header', () => {
  it('renders New, Search, and Archive navigation above the Sessions header', () => {
    const h = createHarness({ conversations: [conversation('first')] });

    h.surface.renderSidebar();

    const container = h.sessionSurfaceEl;
    const actions = headerActions(container);
    const optionsButton = actions?.children[0];
    const newButton = container.querySelector('.claudian-session-new-control');
    const searchButton = container.querySelector('.claudian-session-search-control');
    const archiveButton = container.querySelector('.claudian-session-archive-control');
    expect(sessionsHeaderLabel(container)).toBe('Sessions');
    expect(actions?.children).toHaveLength(1);
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    expect(newButton?.tagName).toBe('DIV');
    expect(newButton?.getAttribute('role')).toBe('button');
    expect(newButton?.getAttribute('tabindex')).toBe('0');
    expect(newButton?.getAttribute('aria-label')).toBeNull();
    expect(newButton?.querySelector('.claudian-session-new-label')?.textContent).toBe('New');
    expect(setIcon).toHaveBeenCalledWith(
      newButton?.querySelector('.claudian-session-new-icon'),
      'square-pen',
    );
    expect(searchButton?.getAttribute('aria-label')).toBeNull();
    expect(navLabel(searchButton)).toBe('Search');
    expect(container.querySelector('.claudian-session-files-control')).toBeNull();
    expect(archiveButton?.getAttribute('aria-label')).toBeNull();
    expect(container.querySelector('.claudian-history-list')).not.toBeNull();

    newButton?.click();
    expect(h.requestNew).toHaveBeenCalledTimes(1);
    expect(searchInput(container)).toBeNull();
    searchButton?.click();
    expect(searchInput(container)).not.toBeNull();
    expect(container.querySelector('.claudian-session-search-control')).toBeNull();
  });

  it('switches between active and archived session manager views', () => {
    const h = createHarness({
      conversations: [
        conversation('active'),
        conversation('archived', { isArchived: true }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const archiveControl = container.querySelector('.claudian-session-archive-control');
    expect(navLabel(archiveControl)).toBe('Archive');
    expect(renderedIds(container)).toEqual(['active']);

    archiveControl.click();

    const sessionsControl = container.querySelector('.claudian-session-archive-control');
    expect(sessionsControl).not.toBe(archiveControl);
    expect(navLabel(sessionsControl)).toBe('Sessions');
    expect(sessionsHeaderLabel(container)).toBe('Archived');
    expect(renderedIds(container)).toEqual(['archived']);

    sessionsControl.click();

    expect(navLabel(container.querySelector('.claudian-session-archive-control')))
      .toBe('Archive');
    expect(sessionsHeaderLabel(container)).toBe('Sessions');
    expect(renderedIds(container)).toEqual(['active']);
  });

  it('renders an inline search field and routes query and close interactions', () => {
    const h = createHarness({
      conversations: [
        conversation('roadmap-review', { title: 'Roadmap review' }),
        conversation('roadmap-draft', { title: 'Roadmap draft' }),
        conversation('plan', { title: '项目计划 notes' }),
        conversation('groceries', { title: 'Groceries' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector('.claudian-session-search-control').click();
    typeSearch(container, 'roadmap');

    const input = searchInput(container);
    expect(input.value).toBe('roadmap');
    expect(input.getAttribute('placeholder')).toBe('Search sessions');
    expect(container.querySelector('.claudian-session-search-close')).toBeNull();
    expect(renderedIds(container).sort()).toEqual(['roadmap-draft', 'roadmap-review']);

    typeSearch(container, 'roadmap review');
    expect(renderedIds(container)).toEqual(['roadmap-review']);

    const composingInput = searchInput(container);
    composingInput.dispatchEvent('compositionstart');
    composingInput.value = '项目计划';
    composingInput.dispatchEvent({ type: 'input', isComposing: true });
    expect(searchInput(container)).toBe(composingInput);
    expect(renderedIds(container)).toEqual(['roadmap-review']);
    const composingEscape = {
      type: 'keydown',
      key: 'Escape',
      isComposing: true,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    composingInput.dispatchEvent(composingEscape);
    expect(searchInput(container)).toBe(composingInput);
    expect(composingEscape.preventDefault).not.toHaveBeenCalled();
    expect(composingEscape.stopPropagation).toHaveBeenCalledTimes(1);

    composingInput.dispatchEvent('compositionend');
    expect(renderedIds(container)).toEqual(['plan']);
    const committedInput = searchInput(container);
    expect(committedInput.value).toBe('项目计划');
    // The input event that follows compositionend must not render the committed text twice.
    composingInput.dispatchEvent({ type: 'input', isComposing: false });
    expect(searchInput(container)).toBe(committedInput);

    const escape = {
      type: 'keydown',
      key: 'Escape',
      isComposing: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    committedInput.dispatchEvent(escape);
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    expect(searchInput(container)).toBeNull();
    expect(container.querySelector('.claudian-session-search-control')).not.toBeNull();
    expect(renderedIds(container)).toHaveLength(4);
  });

  it('restores session and pinned scroll positions after search', () => {
    const h = createHarness({
      conversations: [
        conversation('pinned', { title: 'Pinned notes', isPinned: true }),
        conversation('session', { title: 'Session notes' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const scrollLists = () => {
      const list = container.querySelector('.claudian-history-list');
      return {
        pinnedList: list.querySelector('.claudian-history-section--pinned')
          .querySelector('.claudian-history-section-items'),
        sessionList: list.querySelector('.claudian-session-list-items'),
      };
    };
    scrollLists().pinnedList.scrollTop = 40;
    scrollLists().sessionList.scrollTop = 160;

    container.querySelector('.claudian-session-search-control').click();
    typeSearch(container, 'notes');
    scrollLists().pinnedList.scrollTop = 0;
    scrollLists().sessionList.scrollTop = 0;
    h.surface.handleEscape();

    expect(searchInput(container)).toBeNull();
    expect(scrollLists().pinnedList.scrollTop).toBe(40);
    expect(scrollLists().sessionList.scrollTop).toBe(160);
  });

  it('dismisses search after outside pointer and keyboard focus interactions', async () => {
    const h = createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const activateSearchWithListeners = () => {
      const listeners = new Map<string, (event: Event) => void>();
      container.querySelector('.claudian-session-search-control').click();
      const ownerDocument = searchInput(container).ownerDocument;
      ownerDocument.addEventListener = jest.fn((type: string, listener: (event: Event) => void) => {
        listeners.set(type, listener);
      });
      ownerDocument.removeEventListener = jest.fn();
      return { listeners, ownerDocument };
    };
    const isSearchOpen = () => searchInput(container) !== null;

    const { listeners, ownerDocument } = activateSearchWithListeners();
    await Promise.resolve();

    const searchField = container.querySelector('.claudian-session-search-field');
    const outsideTarget = container.querySelector('.claudian-history-list');
    listeners.get('focusin')?.({ target: searchInput(container) } as unknown as Event);
    expect(isSearchOpen()).toBe(true);
    listeners.get('pointerdown')?.({ target: outsideTarget } as unknown as Event);
    listeners.get('focusin')?.({ target: outsideTarget } as unknown as Event);
    expect(isSearchOpen()).toBe(true);

    listeners.get('click')?.({ target: outsideTarget } as unknown as Event);
    expect(isSearchOpen()).toBe(true);
    await Promise.resolve();
    expect(isSearchOpen()).toBe(false);
    expect(searchField).not.toBeNull();
    expect(ownerDocument.removeEventListener).toHaveBeenCalledWith(
      'click',
      listeners.get('click'),
      true,
    );

    const keyboard = activateSearchWithListeners();
    await Promise.resolve();
    keyboard.listeners.get('keydown')?.({ target: outsideTarget } as unknown as Event);
    keyboard.listeners.get('focusin')?.({ target: outsideTarget } as unknown as Event);
    expect(isSearchOpen()).toBe(false);
  });

  it('collapses and expands every linked-content group from the session header', () => {
    const h = createHarness({
      conversations: [
        conversation('linked', { linkedContentPath: 'Projects/Plan.md' }),
        conversation('unlinked'),
      ],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const toggleButton = () => headerActions(container).children[0];
    const groupHeader = (kind: string) => container.querySelectorAll('.claudian-session-group-header')
      .find((header: any) => header.getAttribute('data-group-kind') === kind);
    const collapsedBodies = () => container.querySelectorAll('.claudian-session-group-body')
      .filter((body: any) => body.hasClass('claudian-session-group-body--collapsed'))
      .map((body: any) => body.getAttribute('data-group-key'))
      .sort();

    expect(headerActions(container).children).toHaveLength(2);
    const collapseIcon = toggleButton().querySelector('.claudian-session-header-icon');
    expect(toggleButton().getAttribute('aria-label')).toBe('Collapse all groups');
    expect(collapseIcon.dataset.iconState).toBe('collapse');
    expect(collapseIcon.children[0]?.tagName).toBe('SVG');

    groupHeader('content').click();
    groupHeader('ungrouped').click();

    expect(collapsedBodies()).toEqual(['content:Projects/Plan.md', 'ungrouped']);
    expect(toggleButton().getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggleButton().querySelector('.claudian-session-header-icon').dataset.iconState)
      .toBe('expand');

    toggleButton().click();

    expect(collapsedBodies()).toEqual([]);
    expect(toggleButton().getAttribute('aria-label')).toBe('Collapse all groups');
    expect(h.notifyOtherViews).toHaveBeenCalledTimes(1);

    toggleButton().click();

    expect(collapsedBodies()).toEqual(['content:Projects/Plan.md', 'ungrouped']);
    expect(toggleButton().getAttribute('aria-label')).toBe('Expand all groups');
    expect(h.notifyOtherViews).toHaveBeenCalledTimes(2);
  });

  it('updates the group toggle in place while search composition holds the column render', () => {
    const h = createHarness({
      conversations: [
        conversation('linked', { linkedContentPath: 'Projects/Plan.md' }),
        conversation('unlinked'),
      ],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector('.claudian-session-search-control').click();
    searchInput(container).dispatchEvent('compositionstart');
    const toggleButton = headerActions(container).children[0];

    for (const header of container.querySelectorAll('.claudian-session-group-header')) {
      header.click();
    }

    expect(headerActions(container).children[0]).toBe(toggleButton);
    expect(toggleButton.getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggleButton.querySelector('.claudian-session-header-icon').dataset.iconState)
      .toBe('expand');
  });

  it('persists linked-content pins through the feature host', async () => {
    const h = createHarness({
      conversations: [conversation('linked', { linkedContentPath: 'Projects/Plan.md' })],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const groupHeader = h.sessionSurfaceEl.querySelector('.claudian-session-group-header');

    groupHeader.dispatchEvent({
      type: 'contextmenu',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    menuInstances().at(-1)!.items
      .find(item => item.title === 'Pin Linked content')!.clickHandler!();
    await Promise.resolve();

    expect(h.plugin.setLinkedContentPinned).toHaveBeenCalledWith('Projects/Plan.md', true);
  });

  it('renders session options and persists the selected organization', async () => {
    const h = createHarness({
      conversations: [
        conversation('linked', { linkedContentPath: 'Projects/Plan.md' }),
        conversation('unlinked'),
      ],
      settings: {
        sessionManagerOrganization: 'list',
        sessionManagerSort: 'last-updated',
      },
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;

    const actions = headerActions(container);
    expect(actions?.children).toHaveLength(1);
    const optionsButton = actions?.children[0];
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    expect(container.querySelector('.claudian-session-group-header')).toBeNull();
    optionsButton?.click();

    const menu = menuInstances().at(-1)!;
    expect(menu.items.map(item => item.title)).toEqual([
      'Organize sessions',
      'In one list',
      'By linked content',
      'Sort sessions by',
      'Last activity',
      'Created',
    ]);
    expect(menu.items.find(item => item.title === 'In one list')!.checked).toBe(true);
    expect(menu.items.find(item => item.title === 'Last activity')!.checked).toBe(true);

    menu.items.find(item => item.title === 'By linked content')!.clickHandler!();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.settings.sessionManagerOrganization).toBe('linked-content');
    expect(h.plugin.mutateSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.claudian-session-group-header')).toHaveLength(2);
    expect(h.notifyOtherViews).toHaveBeenCalledTimes(1);
  });

  it('falls back to last activity when a legacy title sort setting is present', () => {
    const h = createHarness({
      conversations: [conversation('first')],
      settings: { sessionManagerSort: 'title' },
    });
    h.surface.renderSidebar();

    headerActions(h.sessionSurfaceEl).children[0].click();

    const menu = menuInstances().at(-1)!;
    expect(menu.items.some(item => item.title === 'Title')).toBe(false);
    expect(menu.items.find(item => item.title === 'Last activity')!.checked).toBe(true);
  });
});

describe('SessionManagerSurface session column rendering', () => {
  it('refreshes the persistent session column while wide', () => {
    const h = createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['first']);

    h.conversations.push(conversation('second', { lastActivityAt: testDate().getTime() }));
    h.surface.invalidate();

    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['second', 'first']);
  });

  it('defers persistent session column refresh while search IME composition is active', () => {
    const h = createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector('.claudian-session-search-control').click();
    const input = searchInput(container);
    input.dispatchEvent('compositionstart');
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

    h.conversations.push(conversation('second', { lastActivityAt: testDate().getTime() }));
    h.surface.invalidate();
    h.surface.renderSidebar();

    expect(render).not.toHaveBeenCalled();
    expect(searchInput(container)).toBe(input);
    expect(renderedIds(container)).toEqual(['first']);

    input.dispatchEvent('compositionend');

    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedIds(container)).toEqual(['second', 'first']);
  });

  it('renders the existing history content into the persistent session column', () => {
    const h = createHarness({
      conversations: [
        conversation('roadmap', { title: 'Roadmap plan' }),
        conversation('groceries', { title: 'Groceries' }),
        conversation('old-roadmap', { title: 'Old roadmap', isArchived: true }),
      ],
    });
    const container = h.sessionSurfaceEl;
    const renderList = SessionBrowser.prototype.renderHistoryDropdown;
    const listsSeenByRender: unknown[] = [];
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown')
      .mockImplementation(function (this: SessionBrowser, target, options) {
        listsSeenByRender.push(target.querySelector('.claudian-history-list'));
        renderList.call(this, target, options);
      });
    h.surface.renderSidebar();
    container.querySelector('.claudian-session-search-control').click();
    typeSearch(container, 'roadmap');
    const previousList = container.querySelector('.claudian-history-list');
    render.mockClear();
    listsSeenByRender.length = 0;

    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(1);
    expect(listsSeenByRender[0]).toBe(previousList);
    expect(render).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        getConversationStatus: expect.any(Function),
        collapsedGroupKeys: expect.any(Set),
        onGroupCollapseChange: expect.any(Function),

        onSetLinkedContentPinned: expect.any(Function),
        onStartLinkedContentConversation: expect.any(Function),
        getProviderIcon: expect.any(Function),
        getModelLabel: expect.any(Function),
        onRerender: expect.any(Function),
        onRequestInlineRename: expect.any(Function),
        onSelectConversation: expect.any(Function),
        preserveListState: true,
        searchQuery: 'roadmap',
        showAttentionState: true,
        showInlinePinAction: true,
        showOpenStateActions: false,
        showOpenStateLabels: false,
        showMetadataPopover: true,
        showPinnedSection: true,
        pinnedLinkedContentPaths: expect.any(Set),
        showArchivedSection: false,
        sessionScope: 'active',
        sessionActionMode: 'active',
        allowConversationSelection: true,


        signal: expect.any(AbortSignal),
      }),
    );
    expect(render.mock.calls[0][1]).not.toHaveProperty('onOpenConversationInNewTab');
    expect(renderedIds(container)).toEqual(['roadmap']);
    // A clean column ignores render requests until something invalidates it.
    h.surface.renderSidebar();
    expect(render).toHaveBeenCalledTimes(1);

    const sessionOptions = render.mock.calls[0][1] as any;
    const historicalProviderConversation = {
      id: 'historical-provider-conversation',
      providerId: 'removed-provider',
      selectedModel: 'removed-provider/opaque-model',
    };
    expect(sessionOptions.getProviderIcon(historicalProviderConversation)).toBeUndefined();
    expect(sessionOptions.getModelLabel(historicalProviderConversation))
      .toBe('removed-provider/opaque-model');
    sessionOptions.onGroupCollapseChange('content:Projects/Plan.md', true);
    expect(sessionOptions.collapsedGroupKeys.has('content:Projects/Plan.md')).toBe(true);

    sessionOptions.onRerender();
    expect(render).toHaveBeenCalledTimes(2);

    const ownerRequestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container.ownerDocument.defaultView.requestAnimationFrame = ownerRequestAnimationFrame;
    const staleItem = findItem(container, 'roadmap');
    const beginRename = jest.fn();

    sessionOptions.onRequestInlineRename({ beginRename, conversationId: 'roadmap' });

    expect(searchInput(container)).toBeNull();
    expect(container.querySelector('.claudian-session-search-control')).not.toBeNull();
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    const replacementItem = findItem(container, 'roadmap');
    expect(replacementItem).not.toBe(staleItem);
    expect(beginRename).toHaveBeenCalledWith(replacementItem);

    container.querySelector('.claudian-session-archive-control').click();

    expect(render).toHaveBeenLastCalledWith(
      container,
      expect.objectContaining({
        organization: 'list',
        sort: 'last-updated',
        showAttentionState: false,
        showPinnedSection: false,
        showArchivedSection: true,
        sessionScope: 'archived',
        sessionActionMode: 'archived',
        allowConversationSelection: false,
        collapsedGroupKeys: expect.any(Set),
      }),
    );
    expect(renderedIds(container)).toEqual(['old-roadmap']);
  });

  it('formats persisted model metadata for the session hover card', () => {
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([
        { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      ]),
      getReasoningOptions: () => [],
      supportsReasoningEffort: () => false,
    } as any);
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const h = createHarness({ conversations: [conversation('first')] });

    h.surface.renderSidebar();

    const { getModelLabel } = render.mock.calls[0][1] as any;
    expect(getModelLabel({ providerId: 'codex', selectedModel: 'gpt-5.1-codex' }))
      .toBe('GPT-5.1 Codex');
  });

  it('ignores malformed persisted model metadata in the session hover card', () => {
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const h = createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const getChatUIConfig = jest.spyOn(ProviderRegistry, 'getChatUIConfig');

    const { getModelLabel } = render.mock.calls[0][1] as any;

    expect(getModelLabel({ providerId: 'claude', selectedModel: 42 })).toBe('');
    expect(getChatUIConfig).not.toHaveBeenCalled();
  });
});

describe('SessionManagerSurface New availability', () => {
  const newControl = (h: ReturnType<typeof createHarness>) => (
    h.sessionSurfaceEl.querySelector('.claudian-session-new-control')
  );
  const availability = (control: any) => ({
    hidden: control.hasClass('claudian-hidden'),
    ariaDisabled: control.getAttribute('aria-disabled'),
    ariaHidden: control.getAttribute('aria-hidden'),
  });
  const AVAILABLE = { hidden: false, ariaDisabled: null, ariaHidden: null };
  const UNAVAILABLE = { hidden: true, ariaDisabled: 'true', ariaHidden: 'true' };

  it('hides New at capacity and shows it once another tab can be created', () => {
    const h = createHarness({ canCreateTab: false });
    h.surface.renderSidebar();
    expect(availability(newControl(h))).toEqual(UNAVAILABLE);

    h.state.canCreateTab = true;
    h.surface.refreshNewAvailability();

    expect(availability(newControl(h))).toEqual(AVAILABLE);
  });

  it('keeps the dual-mode New control available to resume an unbound draft at capacity', () => {
    const h = createHarness({ canCreateTab: false });
    h.surface.renderSidebar();
    expect(availability(newControl(h))).toEqual(UNAVAILABLE);

    h.navigation.hasUnboundDraft.mockReturnValue(true);
    h.surface.refreshNewAvailability();

    expect(availability(newControl(h))).toEqual(AVAILABLE);
  });

  it('leaves New untouched while the view has no tabs', () => {
    const h = createHarness({ canCreateTab: false });
    h.surface.renderSidebar();
    h.state.canCreateTab = null;
    h.navigation.hasUnboundDraft.mockReturnValue(true);

    h.surface.refreshNewAvailability();

    expect(availability(newControl(h))).toEqual(UNAVAILABLE);
  });
});

describe('SessionManagerSurface history dropdown', () => {
  it('keeps archive navigation at the top of the single-mode history list', () => {
    const h = createHarness({
      conversations: [conversation('active'), conversation('archived', { isArchived: true })],
      wide: false,
    });
    h.historyButton.click();
    const list = h.historyMenu.querySelector('.claudian-history-list');

    const archiveControl = list.querySelector('.claudian-history-archive-control');
    expect(list.children[0]).toBe(archiveControl);
    expect(navLabel(archiveControl)).toBe('Archive');
    const stopPropagation = jest.fn();
    archiveControl.dispatchEvent({ type: 'click', stopPropagation });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(navLabel(h.historyMenu.querySelector('.claudian-history-archive-control')))
      .toBe('Sessions');
    expect(renderedIds(h.historyMenu)).toEqual(['archived']);
  });

  it('keeps tab-aware navigation on the single-mode history surface', () => {
    const h = createHarness({ conversations: [conversation('conversation-1')], wide: false });
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const ownerRequestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    h.historyMenu.ownerDocument.defaultView.requestAnimationFrame = ownerRequestAnimationFrame;
    const globalRequestAnimationFrame = jest.spyOn(window, 'requestAnimationFrame');

    h.historyButton.click();

    const options = render.mock.calls[0]?.[1] as any;
    expect(options.showOpenStateLabels).toBe(true);
    expect(options.showOpenStateActions).toBe(true);
    expect(options.showInlinePinAction).toBe(false);
    expect(options.onRequestInlineRename).toEqual(expect.any(Function));
    expect(options.onOpenConversationInNewTab).toEqual(expect.any(Function));
    expect(options.onBeforeRestoreListState).toEqual(expect.any(Function));
    expect(options).not.toHaveProperty('organization');
    expect(options).not.toHaveProperty('showMetadataPopover');
    const item = findItem(h.historyMenu, 'conversation-1');
    expect(item.querySelector('.claudian-open-new-tab-btn')).not.toBeNull();
    expect(item.querySelector('.claudian-pin-btn')).toBeNull();

    // An outside click hides the menu without abandoning the rendered list.
    h.surface.dismissDropdown();
    expect(h.historyMenu.hasClass('visible')).toBe(false);
    const beginRename = jest.fn();
    options.onRequestInlineRename({ beginRename, conversationId: 'conversation-1' });

    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(beginRename).toHaveBeenCalledWith(item);
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(globalRequestAnimationFrame).not.toHaveBeenCalled();
  });

  it('opens history entries through navigation and closes the dropdown', async () => {
    const h = createHarness({ conversations: [conversation('conversation-1')], wide: false });
    h.historyButton.click();
    const content = findItem(h.historyMenu, 'conversation-1')
      .querySelector('.claudian-history-item-content');

    content.dispatchEvent({ type: 'click', stopPropagation: jest.fn() });
    await new Promise(resolve => setImmediate(resolve));

    expect(h.navigation.openConversation).toHaveBeenCalledWith('conversation-1', undefined);
    expect(h.historyMenu.hasClass('visible')).toBe(false);
  });

  it('switches the single-mode history menu between Sessions and Archived', () => {
    const h = createHarness({
      conversations: [conversation('active'), conversation('archived', { isArchived: true })],
      wide: false,
    });
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

    h.historyButton.click();

    expect(render).toHaveBeenLastCalledWith(
      h.historyMenu,
      expect.objectContaining({
        preserveListState: true,
        sessionScope: 'active',
        sessionActionMode: 'active',
        allowConversationSelection: true,
        onOpenConversationInNewTab: expect.any(Function),
        onBeforeRestoreListState: expect.any(Function),
      }),
    );
    expect(renderedIds(h.historyMenu)).toEqual(['active']);
    h.historyMenu.querySelector('.claudian-history-archive-control').click();

    expect(render).toHaveBeenLastCalledWith(
      h.historyMenu,
      expect.objectContaining({
        preserveListState: true,
        sessionScope: 'archived',
        sessionActionMode: 'archived',
        allowConversationSelection: false,
      }),
    );
    expect(render.mock.calls.at(-1)?.[1]).not.toHaveProperty('onOpenConversationInNewTab');
    expect(h.historyMenu.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Sessions');
    expect(renderedIds(h.historyMenu)).toEqual(['archived']);
    expect(findItem(h.historyMenu, 'archived').hasClass('claudian-history-item--noninteractive'))
      .toBe(true);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', () => {
    const h = createHarness({ wide: false });
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const signalOf = (call: number) => (render.mock.calls[call][1] as { signal: AbortSignal }).signal;

    h.surface.invalidate();
    h.surface.invalidate();

    expect(render).not.toHaveBeenCalled();

    h.surface.toggleDropdown();

    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(signalOf(0).aborted).toBe(false);

    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(2);

    h.surface.toggleDropdown();
    expect(h.historyMenu.hasClass('visible')).toBe(false);
    expect(signalOf(0).aborted).toBe(true);
    expect(signalOf(1).aborted).toBe(true);
    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(2);

    h.surface.toggleDropdown();

    expect(render).toHaveBeenCalledTimes(3);
    expect(signalOf(2).aborted).toBe(false);

    // Dismissing keeps the current render, so reopening does not rebuild the list.
    h.surface.dismissDropdown();
    h.surface.toggleDropdown();
    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(render).toHaveBeenCalledTimes(3);
    expect(signalOf(2).aborted).toBe(false);
  });

  it.each([
    ['refuses a session whose own background tab is working', 'running', false],
    ['deletes an idle session while the active tab streams another session', 'idle', true],
  ])('judges archived deletion by the target session: %s', async (_label, targetId, shouldDelete) => {
    const activeTab = { id: 'active-tab', conversationId: 'active', state: { isStreaming: true } };
    const backgroundTab = { id: 'background-tab', conversationId: 'running', state: { isStreaming: false } };
    const manager = {
      getActiveTab: () => activeTab,
      getTabIdentities: () => [activeTab, backgroundTab],
      getTab: (id: string) => [activeTab, backgroundTab].find(tab => tab.id === id) ?? null,
      getAllTabs: () => [activeTab, backgroundTab],
      isTabWorking: (id: string) => id === 'active-tab' || id === 'background-tab',
      resetConversationTabs: jest.fn().mockResolvedValue(undefined),
    };
    const deleteConversation = jest.fn().mockResolvedValue(undefined);
    const h = createHarness({
      conversations: [
        conversation('running', { title: 'Running', isArchived: true }),
        conversation('idle', { title: 'Idle', isArchived: true }),
      ],
      conversationLifecycle: new ConversationLifecycle({
        conversations: { deleteConversation } as never,
        views: { getAllViews: () => [{ getTabManager: () => manager }] as never },
      }),
      getActiveTab: () => activeTab,
      wide: false,
    });
    h.historyButton.click();
    h.historyMenu.querySelector('.claudian-history-archive-control').click();

    const deleteButton = findItem(h.historyMenu, targetId).querySelector('.claudian-delete-btn');
    deleteButton.dispatchEvent({ type: 'click', stopPropagation: jest.fn() });
    await new Promise(resolve => setImmediate(resolve));

    expect(deleteConversation.mock.calls).toEqual(shouldDelete ? [[targetId]] : []);
  });
});

describe('SessionManagerSurface wide layout transitions', () => {
  const signalOf = (render: jest.SpyInstance, call: number) => (
    (render.mock.calls[call][1] as { signal: AbortSignal }).signal
  );

  it('hides the history dropdown and abandons its render when entering wide', () => {
    const h = createHarness({ conversations: [conversation('first')], wide: false });
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    h.historyButton.click();
    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(signalOf(render, 0).aborted).toBe(false);

    h.state.wide = true;
    h.surface.enterWide();

    expect(h.historyMenu.hasClass('visible')).toBe(false);
    expect(signalOf(render, 0).aborted).toBe(true);
    // The cancelled render left the list stale, so the next open renders it again.
    h.state.wide = false;
    h.surface.toggleDropdown();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('closes search and abandons the sidebar render when leaving wide', () => {
    const h = createHarness({
      conversations: [
        conversation('roadmap', { title: 'Roadmap' }),
        conversation('groceries', { title: 'Groceries' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector('.claudian-session-search-control').click();
    typeSearch(container, 'roadmap');
    expect(renderedIds(container)).toEqual(['roadmap']);
    const render = jest.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

    h.surface.leaveWide();

    expect(searchInput(container)).toBeNull();
    expect(container.querySelector('.claudian-session-search-control')).not.toBeNull();
    // Search ended with its query: the unfiltered list renders, and that render is then abandoned.
    expect(renderedIds(container).sort()).toEqual(['groceries', 'roadmap']);
    expect(render).toHaveBeenCalledTimes(1);
    expect(signalOf(render, 0).aborted).toBe(true);
    // A new search starts empty rather than resuming the closed query.
    container.querySelector('.claudian-session-search-control').click();
    expect(searchInput(container).value).toBe('');
    expect(renderedIds(container).sort()).toEqual(['groceries', 'roadmap']);
  });
});

describe('SessionManagerSurface Escape handling', () => {
  function createSearchingHarness() {
    const h = createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    h.sessionSurfaceEl.querySelector('.claudian-session-search-control').click();
    expect(searchInput(h.sessionSurfaceEl)).not.toBeNull();
    return h;
  }

  it('exits inline rename before handling other scoped Escape actions', () => {
    const h = createSearchingHarness();
    const cancelInlineRename = jest.spyOn(SessionBrowser.prototype, 'cancelInlineRename')
      .mockReturnValue(true);

    expect(h.surface.handleEscape()).toBe(true);

    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(searchInput(h.sessionSurfaceEl)).not.toBeNull();
  });

  it('closes session search from the scoped Escape handler', () => {
    const h = createSearchingHarness();

    expect(h.surface.handleEscape()).toBe(true);

    expect(searchInput(h.sessionSurfaceEl)).toBeNull();
    expect(h.sessionSurfaceEl.querySelector('.claudian-session-search-control')).not.toBeNull();
    // With nothing left to dismiss, Escape falls through to the view.
    expect(h.surface.handleEscape()).toBe(false);
  });

  it('reports search IME composition so scoped Escape belongs to it', () => {
    const h = createSearchingHarness();
    const input = searchInput(h.sessionSurfaceEl);
    expect(h.surface.isComposing).toBe(false);

    input.dispatchEvent('compositionstart');
    expect(h.surface.isComposing).toBe(true);

    input.dispatchEvent('compositionend');
    expect(h.surface.isComposing).toBe(false);
  });
});
