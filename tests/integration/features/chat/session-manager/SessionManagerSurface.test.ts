import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
/** @vitest-environment jsdom */
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { createEvent, fireEvent } from '@testing-library/dom';
import { App, Menu, setIcon } from 'obsidian';
import type { MockInstance } from 'vitest';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ConversationMeta } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import type { SessionSurfaceNavigation } from '@/features/chat/session-manager/SessionSurfaceShared';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';

/** A document click whose dispatch path never entered the history control. */
const outsideClick = () => ({ composedPath: () => [] }) as unknown as Event;

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
  doc?: Document;
  conversations?: ConversationMeta[];
  settings?: Partial<import('@/core/types').ClaudianSettings>;
  wide?: boolean;
  canCreateTab?: boolean | null;
}

async function createHarness(options: HarnessOptions = {}) {
  const conversations = [...(options.conversations ?? [])];
  const fixture = await createFeatureHostFixture({
    app: new App(), settings: { enableAutoTitleGeneration: false, ...options.settings },
    afterPublish: (value, previous) => publisher.publishSettings(value, previous),
  });
  const { plugin } = await createSessionBrowserHost({ conversations, host: {
    fixture,
    assignConversationToCurrentDevice: vi.fn().mockResolvedValue(true),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    setLinkedContentPinned: vi.fn().mockResolvedValue(undefined),
  } });
  const settings = plugin.settings;
  vi.spyOn(plugin, 'mutateSettings');
  const navigation = {
    contentExists: vi.fn((_contentPath: string) => true),
    getConversationStatus: vi.fn((_id: string) => ({ openState: 'closed' as const, isRunning: false })),
    openConversation: vi.fn().mockResolvedValue(undefined),
    openSessionConversation: vi.fn().mockResolvedValue(undefined),
    startLinkedContentConversation: vi.fn().mockResolvedValue(undefined),
    startProjectConversation: vi.fn().mockResolvedValue(undefined),
  } satisfies SessionSurfaceNavigation;
  const state = {
    wide: options.wide ?? true,
    canCreateTab: options.canCreateTab === undefined ? true : options.canCreateTab,
  };
  const requestNew = vi.fn();
  const notifyOtherViews = vi.fn();
  const surface = new SessionManagerSurface({
    plugin,
    navigation,
    getActiveTab: () => null,
    isWide: () => state.wide,
    canCreateTab: () => state.canCreateTab,
    requestNew,
    notifyOtherViews,
  });
  onTestFinished(() => surface.dispose());
  const publisher = new ChatViewPublisher({
    views: { getAllViews: () => [
      { notifyConversationListChanged: () => surface.invalidate() },
      { notifyConversationListChanged: notifyOtherViews },
    ] as never },
    zenMode: { reconcile: vi.fn() }, inactiveSessions: { request: vi.fn() },
    hasLoadedAllSessionMetadata: () => true,
  });
  const sidebarEl = (options.doc ?? document).body.createDiv();
  surface.mountSidebar(sidebarEl);
  const navEl = (options.doc ?? document).body.createDiv();
  surface.mountHistoryControl(navEl);

  return {
    conversations,
    historyButton: navEl.querySelector<HTMLInputElement>('.claudian-input-nav-btn')!,
    historyMenu: navEl.querySelector<HTMLElement>('.claudian-history-menu')!,
    navigation,
    notifyOtherViews,
    plugin,
    requestNew,
    sessionSurfaceEl: sidebarEl.querySelector<HTMLElement>('.claudian-session-surface')!,
    settings,
    sidebarEl,
    state,
    surface,
  };
}

function renderedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('.claudian-history-item')]
    .map((item: HTMLElement) => item.getAttribute('data-conversation-id')!);
}

function findItem(container: HTMLElement, conversationId: string) {
  return [...container.querySelectorAll<HTMLElement>('.claudian-history-item')]
    .find((item: HTMLElement) => item.getAttribute('data-conversation-id') === conversationId)!;
}

function navLabel(control: HTMLElement | null): string | null | undefined {
  return control?.querySelector<HTMLElement>('.claudian-session-nav-label')?.textContent;
}

function sessionsHeaderLabel(container: HTMLElement): string | null | undefined {
  return container.querySelector<HTMLElement>('.claudian-session-list-header')
    ?.querySelector<HTMLElement>('.claudian-history-section-label')?.textContent;
}

function searchInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('.claudian-session-search-input')!;
}

function typeSearch(container: HTMLElement, value: string): void {
  const input = searchInput(container);
  input.value = value;
  fireEvent.input(input);
}

function headerActions(container: HTMLElement) {
  return container.querySelector<HTMLElement>('.claudian-session-list-header')!
    .querySelector<HTMLElement>('.claudian-session-header-actions')!;
}

afterEach(() => {
  vi.restoreAllMocks();
  menuInstances().length = 0;
});

describe('SessionManagerSurface session header', () => {
  it('renders New, Search, and Archive navigation above the Sessions header', async () => {
    const h = await createHarness({ conversations: [conversation('first')] });

    h.surface.renderSidebar();

    const container = h.sessionSurfaceEl;
    const actions = headerActions(container);
    const optionsButton = actions?.querySelectorAll<HTMLElement>('button')[0];
    const newButton = container.querySelector<HTMLElement>('.claudian-session-new-control')!;
    const searchButton = container.querySelector<HTMLInputElement>('.claudian-session-search-control')!;
    const archiveButton = container.querySelector<HTMLElement>('.claudian-session-archive-control')!;
    expect(sessionsHeaderLabel(container)).toBe('Sessions');
    expect(actions?.children).toHaveLength(1);
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    expect(newButton?.tagName).toBe('DIV');
    expect(newButton?.getAttribute('role')).toBe('button');
    expect(newButton?.getAttribute('tabindex')).toBe('0');
    expect(newButton?.getAttribute('aria-label')).toBeNull();
    expect(newButton?.querySelector<HTMLElement>('.claudian-session-new-label')?.textContent).toBe('New');
    expect(setIcon).toHaveBeenCalledWith(
      newButton.querySelector<HTMLElement>('.claudian-session-new-icon')!,
      'square-pen',
    );
    expect(searchButton?.getAttribute('aria-label')).toBeNull();
    expect(navLabel(searchButton)).toBe('Search');
    expect(container.querySelector<HTMLElement>('.claudian-session-files-control')!).toBeNull();
    expect(archiveButton?.getAttribute('aria-label')).toBeNull();
    expect(container.querySelector<HTMLElement>('.claudian-history-list')!).not.toBeNull();

    newButton?.click();
    expect(h.requestNew).toHaveBeenCalledTimes(1);
    expect(searchInput(container)).toBeNull();
    searchButton?.click();
    expect(searchInput(container)).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('.claudian-session-search-control')!).toBeNull();
  });

  it('switches between active and archived session manager views', async () => {
    const h = await createHarness({
      conversations: [
        conversation('active'),
        conversation('archived', { isArchived: true }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const archiveControl = container.querySelector<HTMLElement>('.claudian-session-archive-control')!;
    expect(navLabel(archiveControl)).toBe('Archive');
    expect(renderedIds(container)).toEqual(['active']);

    archiveControl.click();

    const sessionsControl = container.querySelector<HTMLElement>('.claudian-session-archive-control')!;
    expect(sessionsControl).not.toBe(archiveControl);
    expect(navLabel(sessionsControl)).toBe('Sessions');
    expect(sessionsHeaderLabel(container)).toBe('Archived');
    expect(renderedIds(container)).toEqual(['archived']);

    sessionsControl.click();

    expect(navLabel(container.querySelector<HTMLElement>('.claudian-session-archive-control')!))
      .toBe('Archive');
    expect(sessionsHeaderLabel(container)).toBe('Sessions');
    expect(renderedIds(container)).toEqual(['active']);
  });

  it('renders an inline search field and routes query and close interactions', async () => {
    const h = await createHarness({
      conversations: [
        conversation('roadmap-review', { title: 'Roadmap review' }),
        conversation('roadmap-draft', { title: 'Roadmap draft' }),
        conversation('plan', { title: '项目计划 notes' }),
        conversation('groceries', { title: 'Groceries' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    typeSearch(container, 'roadmap');

    const input = searchInput(container);
    expect(input.value).toBe('roadmap');
    expect(input.getAttribute('placeholder')).toBe('Search sessions');
    expect(container.querySelector<HTMLInputElement>('.claudian-session-search-close')!).toBeNull();
    expect(renderedIds(container).sort()).toEqual(['roadmap-draft', 'roadmap-review']);

    typeSearch(container, 'roadmap review');
    expect(renderedIds(container)).toEqual(['roadmap-review']);

    const composingInput = searchInput(container);
    fireEvent.compositionStart(composingInput);
    composingInput.value = '项目计划';
    fireEvent.input(composingInput, {isComposing: true});
    expect(searchInput(container)).toBe(composingInput);
    expect(renderedIds(container)).toEqual(['roadmap-review']);
    const composingEscape = createEvent.keyDown(composingInput, { key: 'Escape', isComposing: true });
    vi.spyOn(composingEscape, 'preventDefault');
    vi.spyOn(composingEscape, 'stopPropagation');
    composingInput.dispatchEvent(composingEscape);
    expect(searchInput(container)).toBe(composingInput);
    expect(composingEscape.preventDefault).not.toHaveBeenCalled();
    expect(composingEscape.stopPropagation).toHaveBeenCalledTimes(1);

    fireEvent.compositionEnd(composingInput);
    expect(renderedIds(container)).toEqual(['plan']);
    const committedInput = searchInput(container);
    expect(committedInput.value).toBe('项目计划');
    // The input event that follows compositionend must not render the committed text twice.
    fireEvent.input(composingInput, {isComposing: false});
    expect(searchInput(container)).toBe(committedInput);

    const escape = createEvent.keyDown(committedInput, { key: 'Escape', isComposing: false });
    vi.spyOn(escape, 'preventDefault');
    vi.spyOn(escape, 'stopPropagation');
    committedInput.dispatchEvent(escape);
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    expect(searchInput(container)).toBeNull();
    expect(container.querySelector<HTMLInputElement>('.claudian-session-search-control')!).not.toBeNull();
    expect(renderedIds(container)).toHaveLength(4);
  });

  it('restores session and pinned scroll positions after search', async () => {
    const h = await createHarness({
      conversations: [
        conversation('pinned', { title: 'Pinned notes', isPinned: true }),
        conversation('session', { title: 'Session notes' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const scrollLists = () => {
      const list = container.querySelector<HTMLElement>('.claudian-history-list')!;
      return {
        pinnedList: list.querySelector<HTMLElement>('.claudian-history-section--pinned')!
          .querySelector<HTMLElement>('.claudian-history-section-items')!,
        sessionList: list.querySelector<HTMLElement>('.claudian-session-list-items')!,
      };
    };
    scrollLists().pinnedList.scrollTop = 40;
    scrollLists().sessionList.scrollTop = 160;

    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    typeSearch(container, 'notes');
    scrollLists().pinnedList.scrollTop = 0;
    scrollLists().sessionList.scrollTop = 0;
    h.surface.handleEscape();

    expect(searchInput(container)).toBeNull();
    expect(scrollLists().pinnedList.scrollTop).toBe(40);
    expect(scrollLists().sessionList.scrollTop).toBe(160);
  });

  it('dismisses search after outside pointer and keyboard focus interactions', async () => {
    const h = await createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const activateSearch = () => container.querySelector<HTMLElement>('.claudian-session-search-control')!.click();
    const isSearchOpen = () => searchInput(container) !== null;
    activateSearch();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    const outsideTarget = container.querySelector<HTMLElement>('.claudian-history-list')!;
    fireEvent.focusIn(searchInput(container));
    expect(isSearchOpen()).toBe(true);
    fireEvent.pointerDown(outsideTarget);
    fireEvent.focusIn(outsideTarget);
    expect(isSearchOpen()).toBe(true);
    fireEvent.click(outsideTarget);
    expect(isSearchOpen()).toBe(true);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(isSearchOpen()).toBe(false);

    activateSearch();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(isSearchOpen()).toBe(true);
    const keyboardTarget = container.querySelector<HTMLElement>('.claudian-history-list')!;
    fireEvent.keyDown(keyboardTarget, { key: 'Tab' });
    fireEvent.focusIn(keyboardTarget);
    expect(isSearchOpen()).toBe(false);
  });

  it('collapses and expands every linked-content group from the session header', async () => {
    const h = await createHarness({
      conversations: [
        conversation('linked', { linkedContentPath: 'Projects/Plan.md' }),
        conversation('unlinked'),
      ],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    const toggleButton = () => headerActions(container).querySelectorAll<HTMLElement>('button')[1];
    const groupHeader = (kind: string) => [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')]
      .find((header: HTMLElement) => header.getAttribute('data-group-kind') === kind)!;
    const collapsedBodies = () => [...container.querySelectorAll<HTMLElement>('.claudian-session-group-body')]
      .filter((body: any) => body.hasClass('claudian-session-group-body--collapsed'))
      .map((body: any) => body.getAttribute('data-group-key'))
      .sort();

    expect(headerActions(container).children).toHaveLength(2);
    const collapseIcon = toggleButton().querySelector<HTMLElement>('.claudian-session-header-icon')!;
    expect(toggleButton().getAttribute('aria-label')).toBe('Collapse all groups');
    expect(collapseIcon.dataset.iconState).toBe('collapse');
    expect(collapseIcon.children[0]?.tagName).toBe('svg');

    groupHeader('content').click();
    groupHeader('ungrouped').click();

    expect(collapsedBodies()).toEqual(['content:Projects/Plan.md', 'ungrouped']);
    expect(toggleButton().getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggleButton().querySelector<HTMLElement>('.claudian-session-header-icon')!.dataset.iconState)
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

  it('updates the group toggle in place while search composition holds the column render', async () => {
    const h = await createHarness({
      conversations: [
        conversation('linked', { linkedContentPath: 'Projects/Plan.md' }),
        conversation('unlinked'),
      ],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    fireEvent.compositionStart(searchInput(container));
    const toggleButton = headerActions(container).querySelectorAll<HTMLElement>('button')[1];

    for (const header of [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')]) {
      header.click();
    }

    expect(headerActions(container).querySelectorAll<HTMLElement>('button')[1]).toBe(toggleButton);
    expect(toggleButton.getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggleButton.querySelector<HTMLElement>('.claudian-session-header-icon')!.dataset.iconState)
      .toBe('expand');
  });

  it('persists linked-content pins through the feature host', async () => {
    const h = await createHarness({
      conversations: [conversation('linked', { linkedContentPath: 'Projects/Plan.md' })],
      settings: { sessionManagerOrganization: 'linked-content' },
    });
    h.surface.renderSidebar();
    const groupHeader = h.sessionSurfaceEl.querySelector<HTMLElement>('.claudian-session-group-header')!;

    fireEvent.contextMenu(groupHeader, {preventDefault: vi.fn(), stopPropagation: vi.fn()});
    menuInstances().at(-1)!.items
      .find(item => item.title === 'Pin Linked content')!.clickHandler!();
    await Promise.resolve();

    expect(h.plugin.setLinkedContentPinned).toHaveBeenCalledWith('Projects/Plan.md', true);
  });

  it('renders session options and persists the selected organization', async () => {
    const h = await createHarness({
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
    const optionsButton = actions?.querySelectorAll<HTMLElement>('button')[0];
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    expect(container.querySelector<HTMLElement>('.claudian-session-group-header')!).toBeNull();
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
    await vi.mocked(h.plugin.mutateSettings).mock.results.at(-1)!.value;

    expect(h.settings.sessionManagerOrganization).toBe('linked-content');
    expect(h.plugin.mutateSettings).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')]).toHaveLength(2);
    expect(h.notifyOtherViews).toHaveBeenCalledTimes(1);
  });

  it('falls back to last activity when a legacy title sort setting is present', async () => {
    const h = await createHarness({
      conversations: [conversation('first')],
      settings: { sessionManagerSort: 'title' as never },
    });
    h.surface.renderSidebar();

    headerActions(h.sessionSurfaceEl).querySelectorAll<HTMLElement>('button')[0].click();

    const menu = menuInstances().at(-1)!;
    expect(menu.items.some(item => item.title === 'Title')).toBe(false);
    expect(menu.items.find(item => item.title === 'Last activity')!.checked).toBe(true);
  });
});

describe('SessionManagerSurface session column rendering', () => {
  it('refreshes the persistent session column while wide', async () => {
    const h = await createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['first']);

    h.conversations.push(conversation('second', { lastActivityAt: testDate().getTime() }));
    h.surface.invalidate();

    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['second', 'first']);
  });

  it('defers persistent session column refresh while search IME composition is active', async () => {
    const h = await createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    const input = searchInput(container);
    fireEvent.compositionStart(input);
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

    h.conversations.push(conversation('second', { lastActivityAt: testDate().getTime() }));
    h.surface.invalidate();
    h.surface.renderSidebar();

    expect(render).not.toHaveBeenCalled();
    expect(searchInput(container)).toBe(input);
    expect(renderedIds(container)).toEqual(['first']);

    fireEvent.compositionEnd(input);

    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedIds(container)).toEqual(['second', 'first']);
  });

  it('renders the existing history content into the persistent session column', async () => {
    const h = await createHarness({
      conversations: [
        conversation('roadmap', { title: 'Roadmap plan' }),
        conversation('groceries', { title: 'Groceries' }),
        conversation('old-roadmap', { title: 'Old roadmap', isArchived: true }),
      ],
    });
    const container = h.sessionSurfaceEl;
    const renderList = SessionBrowser.prototype.renderHistoryDropdown;
    const listsSeenByRender: unknown[] = [];
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown')
      .mockImplementation(function (this: SessionBrowser, target, options) {
        listsSeenByRender.push(target.querySelector<HTMLElement>('.claudian-history-list')!);
        renderList.call(this, target, options);
      });
    h.surface.renderSidebar();
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    typeSearch(container, 'roadmap');
    const previousList = container.querySelector<HTMLElement>('.claudian-history-list')!;
    render.mockClear();
    listsSeenByRender.length = 0;

    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(1);
    expect(listsSeenByRender[0]).toBe(previousList);
    expect(render).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        getConversationStatus: expect.any(Function),
        isGroupCollapsed: expect.any(Function),
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
    expect(sessionOptions.isGroupCollapsed('content:Projects/Plan.md')).toBe(true);

    sessionOptions.onRerender();
    expect(render).toHaveBeenCalledTimes(2);

    const ownerRequestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container.ownerDocument.defaultView!.requestAnimationFrame = ownerRequestAnimationFrame;
    const staleItem = findItem(container, 'roadmap');
    const beginRename = vi.fn();

    sessionOptions.onRequestInlineRename({ beginRename, conversationId: 'roadmap' });

    expect(searchInput(container)).toBeNull();
    expect(container.querySelector<HTMLInputElement>('.claudian-session-search-control')!).not.toBeNull();
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    const replacementItem = findItem(container, 'roadmap');
    expect(replacementItem).not.toBe(staleItem);
    expect(beginRename).toHaveBeenCalledWith(replacementItem);

    container.querySelector<HTMLElement>('.claudian-session-archive-control')!.click();

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
        isGroupCollapsed: expect.any(Function),
      }),
    );
    expect(renderedIds(container)).toEqual(['old-roadmap']);
  });

  it('formats persisted model metadata for the session hover card', async () => {
    vi.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: vi.fn().mockReturnValue([
        { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      ]),
      getReasoningOptions: () => [],
      supportsReasoningEffort: () => false,
    } as any);
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const h = await createHarness({ conversations: [conversation('first')] });

    h.surface.renderSidebar();

    const { getModelLabel } = render.mock.calls[0][1] as any;
    expect(getModelLabel({ providerId: 'codex', selectedModel: 'gpt-5.1-codex' }))
      .toBe('GPT-5.1 Codex');
  });

  it('ignores malformed persisted model metadata in the session hover card', async () => {
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const h = await createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    const getChatUIConfig = vi.spyOn(ProviderRegistry, 'getChatUIConfig');

    const { getModelLabel } = render.mock.calls[0][1] as any;

    expect(getModelLabel({ providerId: 'claude', selectedModel: 42 })).toBe('');
    expect(getChatUIConfig).not.toHaveBeenCalled();
  });
});

describe('SessionManagerSurface New availability', () => {
  const newControl = (h: Awaited<ReturnType<typeof createHarness>>) => (
    h.sessionSurfaceEl.querySelector<HTMLElement>('.claudian-session-new-control')!
  );
  const availability = (control: HTMLElement) => ({
    hidden: control.hasClass('claudian-hidden'),
    ariaDisabled: control.getAttribute('aria-disabled'),
    ariaHidden: control.getAttribute('aria-hidden'),
  });
  const AVAILABLE = { hidden: false, ariaDisabled: null, ariaHidden: null };
  const UNAVAILABLE = { hidden: true, ariaDisabled: 'true', ariaHidden: 'true' };

  it('hides New at capacity and shows it once another tab can be created', async () => {
    const h = await createHarness({ canCreateTab: false });
    h.surface.renderSidebar();
    expect(availability(newControl(h))).toEqual(UNAVAILABLE);

    h.state.canCreateTab = true;
    h.surface.refreshNewAvailability();

    expect(availability(newControl(h))).toEqual(AVAILABLE);
  });

  it('leaves New untouched while the view has no tabs', async () => {
    const h = await createHarness({ canCreateTab: false });
    h.surface.renderSidebar();
    h.state.canCreateTab = null;

    h.surface.refreshNewAvailability();

    expect(availability(newControl(h))).toEqual(UNAVAILABLE);
  });
});

describe('SessionManagerSurface history dropdown', () => {
  it('keeps archive navigation at the top of the single-mode history list', async () => {
    const h = await createHarness({
      conversations: [conversation('active'), conversation('archived', { isArchived: true })],
      wide: false,
    });
    h.historyButton.click();
    const list = h.historyMenu.querySelector<HTMLElement>('.claudian-history-list')!;

    const archiveControl = list.querySelector<HTMLElement>('.claudian-history-archive-control')!;
    expect(list.children[0]).toBe(archiveControl);
    expect(navLabel(archiveControl)).toBe('Archive');
    const click = createEvent.click(archiveControl!);
    const stopPropagation = vi.spyOn(click, 'stopPropagation');
    fireEvent(archiveControl!, click);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(navLabel(h.historyMenu.querySelector<HTMLElement>('.claudian-history-archive-control')!))
      .toBe('Sessions');
    expect(renderedIds(h.historyMenu)).toEqual(['archived']);
  });

  it('keeps tab-aware navigation on the single-mode history surface', async () => {
    const popout = createPopoutDocument();
    const h = await createHarness({ doc: popout, conversations: [conversation('conversation-1')], wide: false });
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const ownerRequestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    h.historyMenu.ownerDocument.defaultView!.requestAnimationFrame = ownerRequestAnimationFrame;
    const globalRequestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');

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
    expect(item.querySelector<HTMLElement>('.claudian-open-new-tab-btn')!).not.toBeNull();
    expect(item.querySelector<HTMLElement>('.claudian-pin-btn')!).toBeNull();

    // An outside click hides the menu without abandoning the rendered list.
    h.surface.dismissDropdownFor(outsideClick());
    expect(h.historyMenu.hasClass('visible')).toBe(false);
    const beginRename = vi.fn();
    globalRequestAnimationFrame.mockClear();
    options.onRequestInlineRename({ beginRename, conversationId: 'conversation-1' });

    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(beginRename).toHaveBeenCalledWith(item);
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(globalRequestAnimationFrame).not.toHaveBeenCalled();
  });

  it('opens history entries through navigation and closes the dropdown', async () => {
    const h = await createHarness({ conversations: [conversation('conversation-1')], wide: false });
    h.historyButton.click();
    expect(h.historyMenu.hasClass('visible')).toBe(true);
    const content = findItem(h.historyMenu, 'conversation-1')
      .querySelector<HTMLElement>('.claudian-history-item-content')!;

    fireEvent.click(content, {stopPropagation: vi.fn()});
    await new Promise(resolve => setImmediate(resolve));

    expect(h.navigation.openConversation).toHaveBeenCalledWith('conversation-1', undefined);
    expect(h.historyMenu.hasClass('visible')).toBe(false);
  });

  it('switches the single-mode history menu between Sessions and Archived', async () => {
    const h = await createHarness({
      conversations: [conversation('active'), conversation('archived', { isArchived: true })],
      wide: false,
    });
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

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
    h.historyMenu.querySelector<HTMLElement>('.claudian-history-archive-control')!.click();

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
    expect(h.historyMenu.querySelector<HTMLElement>('.claudian-session-nav-label')?.textContent)
      .toBe('Sessions');
    expect(renderedIds(h.historyMenu)).toEqual(['archived']);
    expect(findItem(h.historyMenu, 'archived').hasClass('claudian-history-item--noninteractive'))
      .toBe(true);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', async () => {
    const h = await createHarness({ wide: false });
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    const signalOf = (call: number) => (render.mock.calls[call][1] as { signal: AbortSignal }).signal;

    h.surface.invalidate();
    h.surface.invalidate();

    expect(render).not.toHaveBeenCalled();

    h.historyButton.click();

    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(signalOf(0).aborted).toBe(false);

    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(2);

    h.historyButton.click();
    expect(h.historyMenu.hasClass('visible')).toBe(false);
    expect(signalOf(0).aborted).toBe(true);
    expect(signalOf(1).aborted).toBe(true);
    h.surface.invalidate();

    expect(render).toHaveBeenCalledTimes(2);

    h.historyButton.click();

    expect(render).toHaveBeenCalledTimes(3);
    expect(signalOf(2).aborted).toBe(false);

    // Dismissing keeps the current render, so reopening does not rebuild the list.
    h.surface.dismissDropdownFor(outsideClick());
    h.historyButton.click();
    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(render).toHaveBeenCalledTimes(3);
    expect(signalOf(2).aborted).toBe(false);
  });

});

describe('SessionManagerSurface wide layout transitions', () => {
  const signalOf = (render: MockInstance, call: number) => (
    (render.mock.calls[call][1] as { signal: AbortSignal }).signal
  );

  it('hides the history dropdown and abandons its render when entering wide', async () => {
    const h = await createHarness({ conversations: [conversation('first')], wide: false });
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');
    h.historyButton.click();
    expect(h.historyMenu.hasClass('visible')).toBe(true);
    expect(signalOf(render, 0).aborted).toBe(false);

    h.state.wide = true;
    h.surface.enterWide();

    expect(h.historyMenu.hasClass('visible')).toBe(false);
    expect(signalOf(render, 0).aborted).toBe(true);
    // The cancelled render left the list stale, so the next open renders it again.
    h.state.wide = false;
    h.historyButton.click();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('carries the archive view between the sidebar and the history dropdown', async () => {
    const h = await createHarness({
      conversations: [conversation('active'), conversation('archived', { isArchived: true })],
    });
    h.surface.renderSidebar();
    h.sessionSurfaceEl.querySelector<HTMLElement>('.claudian-session-archive-control')!.click();
    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['archived']);

    h.state.wide = false;
    h.surface.leaveWide();
    h.historyButton.click();

    expect(renderedIds(h.historyMenu)).toEqual(['archived']);
    expect(navLabel(h.historyMenu.querySelector<HTMLElement>('.claudian-history-archive-control')!))
      .toBe('Sessions');

    h.historyMenu.querySelector<HTMLElement>('.claudian-history-archive-control')!.click();
    expect(renderedIds(h.historyMenu)).toEqual(['active']);

    h.state.wide = true;
    h.surface.enterWide();
    h.surface.renderSidebar();

    expect(renderedIds(h.sessionSurfaceEl)).toEqual(['active']);
    expect(navLabel(h.sessionSurfaceEl.querySelector<HTMLElement>('.claudian-session-archive-control')!))
      .toBe('Archive');
  });

  it('closes search and abandons the sidebar render when leaving wide', async () => {
    const h = await createHarness({
      conversations: [
        conversation('roadmap', { title: 'Roadmap' }),
        conversation('groceries', { title: 'Groceries' }),
      ],
    });
    h.surface.renderSidebar();
    const container = h.sessionSurfaceEl;
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    typeSearch(container, 'roadmap');
    expect(renderedIds(container)).toEqual(['roadmap']);
    const render = vi.spyOn(SessionBrowser.prototype, 'renderHistoryDropdown');

    h.surface.leaveWide();

    expect(searchInput(container)).toBeNull();
    expect(container.querySelector<HTMLInputElement>('.claudian-session-search-control')!).not.toBeNull();
    // Search ended with its query: the unfiltered list renders, and that render is then abandoned.
    expect(renderedIds(container).sort()).toEqual(['groceries', 'roadmap']);
    expect(render).toHaveBeenCalledTimes(1);
    expect(signalOf(render, 0).aborted).toBe(true);
    // A new search starts empty rather than resuming the closed query.
    container.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(searchInput(container)).not.toBeNull();
    expect(searchInput(container).value).toBe('');
    expect(renderedIds(container).sort()).toEqual(['groceries', 'roadmap']);
  });
});

describe('SessionManagerSurface Escape handling', () => {
  async function createSearchingHarness() {
    const h = await createHarness({ conversations: [conversation('first')] });
    h.surface.renderSidebar();
    h.sessionSurfaceEl.querySelector<HTMLInputElement>('.claudian-session-search-control')!.click();
    expect(searchInput(h.sessionSurfaceEl)).not.toBeNull();
    return h;
  }

  it('exits inline rename before handling other scoped Escape actions', async () => {
    const h = await createSearchingHarness();
    const cancelInlineRename = vi.spyOn(SessionBrowser.prototype, 'cancelInlineRename')
      .mockReturnValue(true);

    expect(h.surface.handleEscape()).toBe(true);

    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(searchInput(h.sessionSurfaceEl)).not.toBeNull();
  });

  it('closes session search from the scoped Escape handler', async () => {
    const h = await createSearchingHarness();

    expect(h.surface.handleEscape()).toBe(true);

    expect(searchInput(h.sessionSurfaceEl)).toBeNull();
    expect(h.sessionSurfaceEl.querySelector<HTMLInputElement>('.claudian-session-search-control')!).not.toBeNull();
    // With nothing left to dismiss, Escape falls through to the view.
    expect(h.surface.handleEscape()).toBe(false);
  });

  it('reports search IME composition so scoped Escape belongs to it', async () => {
    const h = await createSearchingHarness();
    const input = searchInput(h.sessionSurfaceEl);
    expect(h.surface.isComposing).toBe(false);

    fireEvent.compositionStart(input);
    expect(h.surface.isComposing).toBe(true);

    fireEvent.compositionEnd(input);
    expect(h.surface.isComposing).toBe(false);
  });
});
