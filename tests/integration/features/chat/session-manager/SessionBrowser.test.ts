/** @vitest-environment jsdom */
import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { createEvent, fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu, setIcon } from 'obsidian';
import type { Mock, Mocked } from 'vitest';

import type { TitleGenerationService } from '@/core/providers/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { formatSessionDate } from '@/features/chat/session-manager/SessionStatusPresentation';




async function createMockDeps(overrides: { getTitleGenerationService?: () => TitleGenerationService | null } = {}) {
  const historyDropdown: HTMLElement = document.createElement('div');
  return {
    plugin: (await createSessionBrowserHost({ host: {
      switchConversation: vi.fn().mockResolvedValue(undefined),
      getConversationById: vi.fn().mockResolvedValue(null),
      getConversationSummary: vi.fn().mockReturnValue(null),
      getConversationList: vi.fn().mockReturnValue([]),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        titleGenerationModel: 'haiku',
        providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
        permissionMode: 'yolo',
      },
    } })).plugin,
    state: { currentConversationId: null as string | null },
    getHistoryDropdown: () => historyDropdown,
    getTitleGenerationService: (): TitleGenerationService | null => null,
    ...overrides,
  };
}

function createBrowser(deps: Awaited<ReturnType<typeof createMockDeps>>): SessionBrowser {
  return new SessionBrowser({
    plugin: deps.plugin,
    getCurrentConversationId: () => deps.state.currentConversationId,
    getTitleGenerationService: () => deps.getTitleGenerationService(),
    onListChanged: () => undefined,
  });
}

const sessionList = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.claudian-session-list-items') ?? container.querySelector<HTMLElement>('.claudian-history-list')!;

function renderDropdown(browser: SessionBrowser, deps: Awaited<ReturnType<typeof createMockDeps>>): void {
  browser.renderHistoryDropdown(deps.getHistoryDropdown(), {
    onSelectConversation: async (id) => { await deps.plugin.switchConversation(id); },
  });
}

describe('SessionBrowser', () => {
  let mockTitleService: Mocked<TitleGenerationService>;
  let controller: SessionBrowser;
  let deps: Awaited<ReturnType<typeof createMockDeps>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    mockTitleService = { generateTitle: vi.fn<TitleGenerationService['generateTitle']>().mockResolvedValue(undefined), cancel: vi.fn<TitleGenerationService['cancel']>() };
    deps = await createMockDeps({ getTitleGenerationService: () => mockTitleService });
    vi.spyOn(deps.plugin.conversationLifecycle, 'delete');
    controller = createBrowser(deps);
    onTestFinished(() => controller.dispose());
  });
  describe('History Rendering', () => {
    let dropdown: HTMLElement;

    beforeEach(async () => {
      dropdown = document.body.createDiv();
      deps.getHistoryDropdown = () => dropdown;
    });

    describe('updateHistoryDropdown with conversations', () => {
      it('should show "No conversations" when list is empty', () => {
        (deps.plugin.getConversationList as Mock).mockReturnValue([]);

        renderDropdown(controller, deps);

        expect(within(dropdown).getByText('Sessions')).toBeTruthy();
        const list = sessionList(dropdown);
        expect(list.children[0].hasClass('claudian-history-empty')).toBe(true);
        expect(list.children[0].textContent).toBe('No conversations');
      });

      it('should sort conversations by lastActivityAt descending', () => {
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-old', title: 'Old', createdAt: 1000, lastActivityAt: 1000 },
          { id: 'conv-new', title: 'New', createdAt: 2000, lastActivityAt: 5000 },
          { id: 'conv-mid', title: 'Mid', createdAt: 3000, lastActivityAt: 3000 },
        ]);

        renderDropdown(controller, deps);

        const list = sessionList(dropdown);
        expect(list.children.length).toBe(3);
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((title: Element) => title.textContent))
          .toEqual(['New', 'Mid', 'Old']);
      });

      it('should show loading indicator for pending title generation', () => {
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Generating...', createdAt: 1000, lastActivityAt: 1000, titleGenerationStatus: 'pending' },
        ]);

        renderDropdown(controller, deps);

        const list = sessionList(dropdown);
        const item = list.children[0];
        const loadingEl = item.querySelector<HTMLElement>('.claudian-action-loading')!;
        expect(loadingEl).toBeTruthy();
      });


    });

    describe('renderHistoryDropdown', () => {
      it('partitions pinned sessions into a dedicated dual-mode section', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'normal', title: 'Normal', createdAt: 2, lastActivityAt: 2 },
          { id: 'pinned-old', title: 'Pinned old', createdAt: 1, lastActivityAt: 1, isPinned: true },
          { id: 'pinned-new', title: 'Pinned new', createdAt: 3, lastActivityAt: 3, isPinned: true },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showPinnedSection: true,
          sort: 'last-updated',
        });

        const pinnedSection = container.querySelector<HTMLElement>('.claudian-history-section--pinned')!;
        const sessionsSection = container.querySelector<HTMLElement>('.claudian-history-section--sessions')!;
        expect(pinnedSection.querySelector<HTMLElement>('.claudian-history-section-label')?.textContent)
          .toBe('Pinned');
        expect(sessionsSection.querySelector<HTMLElement>('.claudian-history-section-label')?.textContent)
          .toBe('Sessions');
        expect([...pinnedSection.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Pinned new', 'Pinned old']);
        expect([...sessionsSection.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Normal']);
      });

      it('moves pinned content groups above standalone pinned sessions without duplication', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'note-regular',
            title: 'Note regular',
            createdAt: 4,
            lastActivityAt: 4,
            linkedContentPath: 'Projects/Plan.md',
          },
          {
            id: 'note-pinned-session',
            title: 'Note pinned session',
            createdAt: 3,
            lastActivityAt: 3,
            linkedContentPath: 'Projects/Plan.md',
            isPinned: true,
          },
          {
            id: 'standalone',
            title: 'Standalone pinned',
            createdAt: 2,
            lastActivityAt: 2,
            isPinned: true,
          },
          {
            id: 'regular',
            title: 'Regular',
            createdAt: 1,
            lastActivityAt: 1,
            linkedContentPath: 'Projects/Other.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showPinnedSection: true,
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          contentExists: () => true,
          pinnedLinkedContentPaths: new Set([
            'Projects/Plan.md',
            'Projects/Empty.md',
          ]),
        });

        const pinnedSection = container.querySelector<HTMLElement>('.claudian-history-section--pinned')!;
        const pinnedHeaders = [...pinnedSection.querySelectorAll<HTMLElement>('.claudian-session-group-header')];
        expect(pinnedHeaders.map((header) => header.getAttribute('data-content-path'))).toEqual([
          'Projects/Plan.md',
          'Projects/Empty.md',
        ]);
        expect([...pinnedSection.querySelectorAll('.claudian-session-group-body')[0]
          .querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((item) => item.textContent))
          .toEqual(['Note regular', 'Note pinned session']);
        expect([...pinnedSection.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((item) => item.textContent))
          .toEqual(['Note regular', 'Note pinned session', 'Standalone pinned']);

        const sessionsSection = container.querySelector<HTMLElement>('.claudian-history-section--sessions')!;
        expect([...sessionsSection.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((item) => item.textContent))
          .toEqual(['Regular']);
        expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')].filter((item) => (
          item.getAttribute('data-conversation-id') === 'note-pinned-session'
        ))).toHaveLength(1);
      });

      it.each(['Enter', ' '])('opens a focusable dual-mode session with %s', async (key) => {
        const container = document.body.createDiv();
        const onSelectConversation = vi.fn().mockResolvedValue(undefined);
        (deps.plugin.getConversationList as Mock).mockReturnValue([{
          id: 'session-1',
          providerId: 'claude',
          title: 'Keyboard session',
          createdAt: 1_000,
          lastActivityAt: 2_000,
        }]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          showMetadataPopover: true,
        });

        const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
        const content = item.querySelector<HTMLElement>('.claudian-history-item-content')!;
        const event = createEvent.keyDown(content, { key });
        const preventDefault = vi.spyOn(event, 'preventDefault');
        const stopPropagation = vi.spyOn(event, 'stopPropagation');
        expect(item.getAttribute('role')).toBeNull();
        expect(content.getAttribute('role')).toBe('button');

        fireEvent(content, event);
        await Promise.resolve();
        await Promise.resolve();

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onSelectConversation).toHaveBeenCalledWith('session-1');
      });

      it('hides the pinned section when no sessions are pinned', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'normal', title: 'Normal', createdAt: 1 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showPinnedSection: true,
        });

        expect(container.querySelector<HTMLElement>('.claudian-history-section--pinned')!).toBeNull();
        expect(container.querySelector<HTMLElement>('.claudian-history-section--sessions')!).not.toBeNull();
      });

      it('pulses completed reviews and hides inline actions while a session waits or errored', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'review-pinned',
            title: 'Pinned review',
            createdAt: 5,
            isPinned: true,
          },
          { id: 'action', title: 'Action required', createdAt: 4 },
          { id: 'error', title: 'Stopped with error', createdAt: 3 },
          { id: 'review', title: 'Review later', createdAt: 2 },
          { id: 'normal', title: 'Normal', createdAt: 1 },
        ]);
        const attentionById = new Map([
          ['review-pinned', { kind: 'review' as const, outcome: 'completed' as const, since: 400 }],
          ['action', { kind: 'action-required' as const, since: 100 }],
          ['error', { kind: 'review' as const, outcome: 'error' as const, since: 300 }],
          ['review', { kind: 'review' as const, outcome: 'completed' as const, since: 200 }],
        ]);

        controller.renderHistoryDropdown(container, {
          getConversationStatus: id => ({
            attention: attentionById.get(id) ?? null,
            isRunning: false,
            openState: 'open',
          }),
          onSelectConversation: vi.fn(),
          sessionActionMode: 'active',
          showAttentionState: true,
          showPinnedSection: true,
        });

        expect(container.querySelector<HTMLElement>('.claudian-history-section--attention')!).toBeNull();
        const items = [...container.querySelectorAll<HTMLElement>('.claudian-history-item')];
        expect(items).toHaveLength(5);
        const findItem = (id: string) => items.find(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') === id,
        )!;
        const attentionIds = [...container.querySelectorAll<HTMLElement>('.claudian-history-item--attention')]
          .map((item: HTMLElement) => item.getAttribute('data-conversation-id'));
        expect(attentionIds.sort()).toEqual(['review', 'review-pinned']);
        expect(container.querySelector<HTMLElement>('.claudian-session-attention-indicator')!).toBeNull();

        const inlineActionLabels = (id: string) => ['claudian-pin-btn', 'claudian-archive-btn']
          .flatMap(cls => [...findItem(id).querySelectorAll(`.${cls}`)])
          .map((button: Element) => button.getAttribute('aria-label'));
        expect(inlineActionLabels('normal')).toEqual(['Pin', 'Archive']);
        expect(inlineActionLabels('review')).toEqual(['Pin', 'Archive']);
        expect(inlineActionLabels('review-pinned')).toEqual(['Unpin', 'Archive']);
        expect(inlineActionLabels('error')).toEqual([]);
        expect(inlineActionLabels('action')).toEqual([]);
      });

      it('does not mark archived rows for attention presentation', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
        ]);

        controller.renderHistoryDropdown(container, {
          getConversationStatus: () => ({
            attention: { kind: 'review', outcome: 'completed', since: 1 },
            isRunning: false,
            openState: 'open',
          }),
          onSelectConversation: vi.fn(),
          sessionScope: 'archived',
          showArchivedSection: true,
          showAttentionState: true,
        });

        expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(1);
        expect(container.querySelector<HTMLElement>('.claudian-history-item--attention')!).toBeNull();
      });

      it('filters the current session scope by title and linked-content path', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'active-title',
            title: 'Roadmap review',
            createdAt: 4,
            lastActivityAt: 4,
          },
          {
            id: 'active-note',
            title: 'Planning notes',
            linkedContentPath: 'Projects/Roadmap.md',
            createdAt: 3,
            lastActivityAt: 3,
          },
          {
            id: 'active-other',
            title: 'Other',
            createdAt: 2,
            lastActivityAt: 2,
          },
          {
            id: 'archived-match',
            title: 'Archived roadmap',
            createdAt: 1,
            lastActivityAt: 1,
            isArchived: true,
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showPinnedSection: true,
          sessionScope: 'active',
          searchQuery: 'ROADMAP',
        });

        expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item-title')]
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Roadmap review', 'Planning notes']);
      });

      it('shows a search-specific empty state within the archived scope', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showArchivedSection: true,
          sessionScope: 'archived',
          searchQuery: 'missing',
        });

        expect(container.querySelector<HTMLElement>('.claudian-history-empty')?.textContent)
          .toBe('No matching sessions');
      });

      it('uses the same linked-content grouping and sorting for archived sessions', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'archived-b',
            title: 'Second',
            createdAt: 2,
            linkedContentPath: 'Projects/B.md',
            isArchived: true,
          },
          {
            id: 'archived-a',
            title: 'First',
            createdAt: 1,
            linkedContentPath: 'Projects/A.md',
            isArchived: true,
          },
          { id: 'active', title: 'Active', createdAt: 3 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showArchivedSection: true,
          sessionScope: 'archived',
          sessionActionMode: 'archived',
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => true,

        });

        expect([...container.querySelectorAll<HTMLElement>('.claudian-session-group-label')]
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['B', 'A']);
      });

      it('renders full-path content groups only for the linked-content organization', () => {
        const container = document.body.createDiv();
        const onGroupCollapseChange = vi.fn();
        const onGroupKeysChange = vi.fn();
        const onStartLinkedContentConversation = vi.fn().mockResolvedValue(undefined);
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'plan-a',
            title: 'Plan A',
            createdAt: 3,
            linkedContentPath: 'Projects/A/Plan.md',
          },
          {
            id: 'plan-b',
            title: 'Plan B',
            createdAt: 2,
            linkedContentPath: 'Projects/B/Plan.md',
          },
          {
            id: 'untitled',
            title: 'Draft discussion',
            createdAt: 1,
            linkedContentPath: 'Inbox/Untitled 2.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => true,
          onGroupCollapseChange,
          onGroupKeysChange,
          onStartLinkedContentConversation,
        });

        const labels = [...container
          .querySelectorAll<HTMLElement>('.claudian-session-group-label')]
          .map((label: { textContent: string }) => label.textContent);
        expect(labels).toEqual(['Plan', 'Plan', 'Unlinked']);
        expect(labels).not.toContain('Untitled 2');
        const groupHeaders = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')];
        expect(groupHeaders[0].getAttribute('title')).toBe('Projects/A/Plan.md');
        expect(groupHeaders[1].getAttribute('title')).toBe('Projects/B/Plan.md');
        const groupIcons = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-icon')];
        expect(groupIcons).toHaveLength(3);
        expect(setIcon).toHaveBeenCalledWith(groupIcons[0], 'link');
        expect(setIcon).toHaveBeenCalledWith(groupIcons[1], 'link');
        expect(setIcon).toHaveBeenCalledWith(groupIcons[2], 'inbox');
        const linkedContentActions = [...container.querySelectorAll<HTMLElement>(
          '.claudian-session-group-new-action',
        )];
        expect(linkedContentActions).toHaveLength(2);
        expect(linkedContentActions[0].tagName).toBe('SPAN');
        expect(linkedContentActions[0].getAttribute('role')).toBe('button');
        expect(linkedContentActions[0].getAttribute('tabindex')).toBe('0');
        expect(setIcon).toHaveBeenCalledWith(linkedContentActions[0], 'square-pen');
        expect(linkedContentActions[0].getAttribute('aria-label'))
          .toBe('New chat for Plan');
        const click = createEvent.click(linkedContentActions[0]);
        const stopPropagation = vi.spyOn(click, 'stopPropagation');
        fireEvent(linkedContentActions[0], click);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onStartLinkedContentConversation).toHaveBeenCalledWith(
          'Projects/A/Plan.md',
        );
        expect(groupHeaders[0].getAttribute('aria-expanded')).toBe('true');
        expect(onGroupKeysChange).toHaveBeenCalledWith([
          'content:Projects/A/Plan.md',
          'content:Projects/B/Plan.md',
          'ungrouped',
        ]);
        expect(groupHeaders[0].getAttribute('role')).toBe('button');
        expect(groupHeaders[0].getAttribute('aria-expanded')).toBe('true');
        const groupBodies = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-body')];
        expect(groupBodies).toHaveLength(3);

        groupHeaders[0].click();

        expect(groupHeaders[0].getAttribute('aria-expanded')).toBe('false');
        expect(groupBodies[0].hasClass('claudian-session-group-body--collapsed')).toBe(true);
        expect(onGroupCollapseChange).toHaveBeenCalledWith(
          'content:Projects/A/Plan.md',
          true,
        );
        expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(3);
      });

      it('keeps missing groups visible without offering a new linked chat', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([{
          id: 'missing-plan',
          title: 'Missing plan',
          createdAt: 1,
          linkedContentPath: 'Gone/Plan.md',
        }]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => false,
          onStartLinkedContentConversation: vi.fn(),
        });

        expect(container.querySelector<HTMLElement>('.claudian-session-group-status')?.textContent)
          .toBe('Missing');
        expect(container.querySelector<HTMLElement>('.claudian-session-group-new-action')!).toBeNull();
      });

      it('paginates large history lists and loads the next bounded page on demand', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue(
          Array.from({ length: 125 }, (_, index) => ({
            id: `conv-${index}`,
            title: `Conversation ${index}`,
            createdAt: 125 - index,
          })),
        );

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          pageSize: 25,
        });

        let list = sessionList(container);
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(25);
        const loadMore = list.querySelector<HTMLElement>('.claudian-history-load-more')!;
        expect(loadMore).not.toBeNull();

        loadMore!.click();
        list = sessionList(container);
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(50);
        expect(list.querySelector<HTMLElement>('.claudian-history-load-more')!).not.toBeNull();
      });

      it('keeps pagination bounded across pinned and regular dual-mode sessions', () => {
        const container = document.body.createDiv();
        const onRerender = vi.fn();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `pinned-${index}`,
            title: `Pinned ${index}`,
            createdAt: 100 - index,
            isPinned: true,
          })),
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `regular-${index}`,
            title: `Regular ${index}`,
            createdAt: 50 - index,
          })),
        ]);

        const options = {
          onSelectConversation: vi.fn(),
          showPinnedSection: true,
          pageSize: 25,
          preserveListState: true,
          onRerender,
        };
        controller.renderHistoryDropdown(container, options);

        let list = container.querySelector<HTMLElement>('.claudian-history-list')!;
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(25);
        expect(list.querySelector<HTMLElement>('.claudian-history-load-more')!).not.toBeNull();

        list.querySelector<HTMLElement>('.claudian-history-load-more')!.click();
        expect(onRerender).toHaveBeenCalledTimes(1);
        expect(list.dataset.visibleCount).toBe('50');
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(25);

        controller.renderHistoryDropdown(container, options);
        list = container.querySelector<HTMLElement>('.claudian-history-list')!;
        expect([...list.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(40);
        expect(list.querySelector<HTMLElement>('.claudian-history-load-more')!).toBeNull();
      });

      it('does not let collapsed groups consume pagination or hide later headers', () => {
        const container = document.body.createDiv();
        const collapsedGroupKeys = new Set(['content:Projects/A.md']);
        const onRerender = vi.fn();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          ...Array.from({ length: 75 }, (_, index) => ({
            id: `a-${index}`,
            title: `A ${index}`,
            createdAt: 1000 - index,
            linkedContentPath: 'Projects/A.md',
          })),
          {
            id: 'b-1',
            title: 'B 1',
            createdAt: 1,
            linkedContentPath: 'Projects/B.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          onRerender,
          organization: 'linked-content',
          sort: 'created',
          pageSize: 25,
          isGroupCollapsed: groupKey => collapsedGroupKeys.has(groupKey),
          onGroupCollapseChange: (groupKey, collapsed) => {
            if (collapsed) {
              collapsedGroupKeys.add(groupKey);
            } else {
              collapsedGroupKeys.delete(groupKey);
            }
          },
        });

        const labels = [...container.querySelectorAll<HTMLElement>('.claudian-session-group-label')];
        expect(labels.map((label: { textContent: string }) => label.textContent))
          .toEqual(['A', 'B']);
        expect([...container.querySelectorAll<HTMLElement>('.claudian-history-item')]).toHaveLength(1);
        expect(container.querySelector<HTMLElement>('.claudian-history-load-more')!).toBeNull();

        [...container.querySelectorAll<HTMLElement>('.claudian-session-group-header')][0].click();
        expect(onRerender).toHaveBeenCalledTimes(1);
      });

      it('does not render when the history render signal is already aborted', () => {
        const container = document.body.createDiv();
        container.createDiv({ cls: 'sentinel' });
        const abortController = new AbortController();
        abortController.abort();

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          signal: abortController.signal,
        });

        expect(container.querySelector<HTMLElement>('.sentinel')!).not.toBeNull();
      });

      it('should highlight conversations already open in a tab', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationOpenState: (id) => id === 'conv-2' ? 'open' : 'current',
        });

        const list = sessionList(container);
        const openItem = list.children[1];
        const openItemDate = openItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(openItem.hasClass('open')).toBe(true);
        expect(openItem.hasClass('active')).toBe(false);
        expect(openItem.getAttribute('data-open-state')).toBe('open');
        expect(openItemDate?.textContent).toBe('Open in tab');
      });

      it('should display the current tab number when available', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: () => ({
            openState: 'current',
            isRunning: false,
            location: 'current-view',
            tabIndex: 1,
          }),
        });

        const list = sessionList(container);
        const currentItem = list.children[0];
        const currentItemDate = currentItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(currentItem.getAttribute('data-tab-index')).toBe('1');
        expect(currentItem.getAttribute('data-tab-location')).toBe('current-view');
        expect(currentItemDate?.textContent).toBe('Current tab 1');
      });

      it('should display the open tab number when available', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: (id) => id === 'conv-2'
            ? { openState: 'open', isRunning: false, location: 'current-view', tabIndex: 2 }
            : { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 },
        });

        const list = sessionList(container);
        const openItem = list.children[1];
        const openItemDate = openItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(openItem.getAttribute('data-tab-index')).toBe('2');
        expect(openItem.getAttribute('data-tab-location')).toBe('current-view');
        expect(openItemDate?.textContent).toBe('Open in tab 2');
      });

      it('shows timestamps instead of open-state labels when requested by the surface', () => {
        const container = document.body.createDiv();
        const currentActivity = testDate({ days: -10 }).getTime();
        const openActivity = testDate({ days: -40 }).getTime();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: openActivity, lastActivityAt: currentActivity },
          { id: 'conv-2', title: 'Open', createdAt: currentActivity, lastActivityAt: openActivity },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: (id) => id === 'conv-1'
            ? { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 }
            : { openState: 'open', isRunning: true, location: 'current-view', tabIndex: 2 },
          showOpenStateLabels: false,
        });

        const list = sessionList(container);
        expect(list.children[0].querySelector<HTMLElement>('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(currentActivity));
        expect(list.children[1].querySelector<HTMLElement>('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(openActivity));
        const runningIndicators = [...list.querySelectorAll<HTMLElement>(
          '.claudian-session-running-indicator',
        )];
        expect(runningIndicators).toHaveLength(1);
        expect(setIcon).toHaveBeenCalledWith(runningIndicators[0], 'loader-2');
      });

      it('replaces the dual-pane spinner with matched action and error badges', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'waiting', title: 'Waiting', createdAt: 5000 },
          { id: 'working', title: 'Working', createdAt: 4000 },
          { id: 'error', title: 'Error', createdAt: 3000 },
          { id: 'review', title: 'Review', createdAt: 2000 },
          { id: 'idle', title: 'Idle', createdAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          showAttentionState: true,
          showOpenStateLabels: false,
          getConversationStatus: (id) => ({
            openState: 'open',
            isRunning: id === 'waiting' || id === 'working',
            attention: id === 'waiting'
              ? { kind: 'action-required', since: 1 }
              : id === 'error'
                ? { kind: 'review', outcome: 'error', since: 2 }
                : id === 'review'
                  ? { kind: 'review', outcome: 'completed', since: 3 }
                  : null,
          }),
        });

        const items = [...container.querySelectorAll<HTMLElement>('.claudian-history-item')];
        const findItem = (id: string) => items.find(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') === id,
        )!;
        const waitingItem = findItem('waiting');
        const waitingBadge = waitingItem.querySelector<HTMLElement>(
          '.claudian-session-status-indicator--action-required',
        )!;
        const workingItem = findItem('working');
        const errorItem = findItem('error');
        const errorBadge = errorItem.querySelector<HTMLElement>(
          '.claudian-session-status-indicator--error',
        )!;

        expect(waitingBadge).not.toBeNull();
        expect(waitingBadge.hasClass('claudian-session-status-indicator')).toBe(true);
        expect(waitingBadge.getAttribute('aria-label')).toBe('Needs your input');
        expect(waitingItem.querySelector<HTMLElement>('.claudian-session-running-indicator')!).toBeNull();
        expect(waitingItem.hasClass('running')).toBe(false);
        expect(waitingItem.getAttribute('data-running')).toBe('true');
        expect(setIcon).toHaveBeenCalledWith(
          waitingItem.querySelector<HTMLElement>('.claudian-history-item-icon')!,
          'message-square',
        );
        expect(waitingItem.hasClass('claudian-history-item--attention')).toBe(false);
        expect(setIcon).toHaveBeenCalledWith(waitingBadge, 'alert-circle');

        expect(workingItem.querySelector<HTMLElement>('.claudian-session-running-indicator')!).not.toBeNull();
        expect(workingItem.querySelector<HTMLElement>('.claudian-session-status-indicator')!).toBeNull();

        expect(errorBadge).not.toBeNull();
        expect(errorBadge.hasClass('claudian-session-status-indicator')).toBe(true);
        expect(errorBadge.getAttribute('aria-label')).toBe('Stopped with an error');
        expect(errorItem.hasClass('claudian-history-item--attention')).toBe(false);
        expect(setIcon).toHaveBeenCalledWith(errorBadge, 'x-circle');

        const reviewItem = findItem('review');
        const unreadBadges = [...reviewItem.querySelectorAll<HTMLElement>('.claudian-session-status-indicator')];
        expect(reviewItem.hasClass('claudian-history-item--attention')).toBe(true);
        expect(unreadBadges).toHaveLength(1);
        expect(unreadBadges[0].hasClass('claudian-session-status-indicator--unread')).toBe(true);
        expect(unreadBadges[0].getAttribute('aria-label')).toBe('Unread');
        expect(setIcon).not.toHaveBeenCalledWith(unreadBadges[0], expect.anything());
        expect(errorItem.querySelector<HTMLElement>('.claudian-session-status-indicator--unread')!).toBeNull();
        expect(findItem('idle').querySelector<HTMLElement>('.claudian-session-status-indicator')!).toBeNull();
      });

      it('displays the timestamp selected by the session sort mode', () => {
        const container = document.body.createDiv();
        const createdAt = testDate({ days: -40 }).getTime();
        const lastActivityAt = testDate({ days: -10 }).getTime();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'conv-1',
            title: 'Timestamped',
            createdAt,
            lastActivityAt,
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          sort: 'last-updated',
          showOpenStateLabels: false,
        });

        expect(container.querySelector<HTMLElement>('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(lastActivityAt));

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          sort: 'created',
          showOpenStateLabels: false,
        });

        expect(container.querySelector<HTMLElement>('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(createdAt));
      });

      it('shows a running indicator on a collapsed linked-content header', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'running',
            title: 'Running session',
            createdAt: 1000,
            linkedContentPath: 'Projects/Plan.md',
          },
          {
            id: 'idle',
            title: 'Idle session',
            createdAt: 900,
            linkedContentPath: 'Projects/Plan.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showOpenStateLabels: false,
          getConversationStatus: (id) => ({
            openState: id === 'running' ? 'open' : 'closed',
            isRunning: id === 'running',
          }),
        });

        const header = container.querySelector<HTMLElement>('.claudian-session-group-header')!;
        const headerIndicator = header.querySelector<HTMLElement>(
          '.claudian-session-group-running-indicator',
        )!;
        expect(headerIndicator).not.toBeNull();
        expect(headerIndicator.hasClass(
          'claudian-session-group-running-indicator--visible',
        )).toBe(false);

        header.click();

        expect(headerIndicator.hasClass(
          'claudian-session-group-running-indicator--visible',
        )).toBe(true);
        expect(setIcon).toHaveBeenCalledWith(headerIndicator, 'loader-2');
      });

      it('prioritizes a waiting badge on a collapsed linked-content group', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'waiting',
            title: 'Waiting session',
            createdAt: 1000,
            linkedContentPath: 'Projects/Plan.md',
          },
          {
            id: 'working',
            title: 'Working session',
            createdAt: 900,
            linkedContentPath: 'Projects/Plan.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showAttentionState: true,
          showOpenStateLabels: false,
          getConversationStatus: (id) => ({
            openState: 'open',
            isRunning: true,
            attention: id === 'waiting'
              ? { kind: 'action-required', since: 1 }
              : null,
          }),
        });

        const header = container.querySelector<HTMLElement>('.claudian-session-group-header')!;
        const badge = header.querySelector<HTMLElement>(
          '.claudian-session-group-status-indicator',
        )!;
        expect(badge).not.toBeNull();
        expect(badge.hasClass('claudian-session-status-indicator--action-required')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(false);
        expect(header.querySelector<HTMLElement>('.claudian-session-group-running-indicator')!).toBeNull();

        header.click();

        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(true);
        expect(badge.getAttribute('aria-label')).toBe('Needs your input');
        expect(setIcon).toHaveBeenCalledWith(badge, 'alert-circle');
      });

      it('shows an error badge on a collapsed linked-content group without active work', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'error',
            title: 'Failed session',
            createdAt: 1000,
            linkedContentPath: 'Projects/Plan.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showAttentionState: true,
          showOpenStateLabels: false,
          getConversationStatus: () => ({
            openState: 'open',
            isRunning: false,
            attention: { kind: 'review', outcome: 'error', since: 1 },
          }),
        });

        const header = container.querySelector<HTMLElement>('.claudian-session-group-header')!;
        const badge = header.querySelector<HTMLElement>(
          '.claudian-session-group-status-indicator',
        )!;
        header.click();

        expect(badge.hasClass('claudian-session-status-indicator--error')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(true);
        expect(badge.getAttribute('aria-label')).toBe('Stopped with an error');
        expect(setIcon).toHaveBeenCalledWith(badge, 'x-circle');
      });

      it('marks a collapsed linked-content header when it contains attention', () => {
        const container = document.body.createDiv();
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          {
            id: 'attention',
            title: 'Needs review',
            createdAt: 1000,
            linkedContentPath: 'Projects/Plan.md',
          },
          {
            id: 'normal',
            title: 'No attention',
            createdAt: 900,
            linkedContentPath: 'Projects/Plan.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showAttentionState: true,
          showOpenStateLabels: false,
          getConversationStatus: (id) => ({
            openState: 'open',
            isRunning: false,
            attention: id === 'attention'
              ? { kind: 'review', outcome: 'completed', since: 1000 }
              : null,
          }),
        });

        const header = container.querySelector<HTMLElement>('.claudian-session-group-header')!;
        expect(header.hasClass('claudian-session-group-header--attention')).toBe(false);
        expect(header.querySelector<HTMLElement>('.claudian-session-group-attention-indicator')!).toBeNull();

        const badge = header.querySelector<HTMLElement>('.claudian-session-group-status-indicator')!;
        expect(badge.hasClass('claudian-session-status-indicator--unread')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(false);

        header.click();

        expect(header.hasClass('claudian-session-group-header--attention')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(true);
      });

      it('should display running status for the current conversation', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: () => ({
            openState: 'current',
            isRunning: true,
          }),
        });

        const list = sessionList(container);
        const currentItem = list.children[0];
        const currentItemDate = currentItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(currentItem.hasClass('active')).toBe(true);
        expect(currentItem.hasClass('running')).toBe(true);
        expect(currentItem.getAttribute('data-running')).toBe('true');
        expect(currentItemDate?.textContent).toBe('Running in current tab');
      });

      it('should display running status for a conversation open in another tab', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Running elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: (id) => id === 'conv-2'
            ? { openState: 'open', isRunning: true, location: 'current-view', tabIndex: 2 }
            : { openState: 'current', isRunning: false },
        });

        const list = sessionList(container);
        const runningItem = list.children[1];
        const runningItemDate = runningItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(runningItem.hasClass('open')).toBe(true);
        expect(runningItem.hasClass('running')).toBe(true);
        expect(runningItem.getAttribute('data-open-state')).toBe('open');
        expect(runningItem.getAttribute('data-running')).toBe('true');
        expect(runningItemDate?.textContent).toBe('Running in tab 2');
      });

      it('should display another-pane status without a local tab number', () => {
        const container = document.body.createDiv();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
          { id: 'conv-3', title: 'Running elsewhere', createdAt: 3000, lastActivityAt: 500 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          getConversationStatus: (id) => {
            if (id === 'conv-2') {
              return { openState: 'open', isRunning: false, location: 'other-view' };
            }
            if (id === 'conv-3') {
              return { openState: 'open', isRunning: true, location: 'other-view' };
            }
            return { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 };
          },
        });

        const list = sessionList(container);
        const openOtherPaneItem = list.children[1];
        const runningOtherPaneItem = list.children[2];
        const runningOtherPaneDate = runningOtherPaneItem.querySelector<HTMLElement>('.claudian-history-item-date')!;
        const openOtherPaneDate = openOtherPaneItem.querySelector<HTMLElement>('.claudian-history-item-date')!;

        expect(runningOtherPaneItem.getAttribute('data-tab-location')).toBe('other-view');
        expect(runningOtherPaneItem.getAttribute('data-tab-index')).toBeNull();
        expect(runningOtherPaneDate?.textContent).toBe('Running in another pane');
        expect(openOtherPaneDate?.textContent).toBe('Open in another pane');
      });

      it('should open a conversation in a new tab on modifier click when supported', async () => {
        const container = document.body.createDiv();
        const onSelectConversation = vi.fn();
        const onOpenConversationInNewTab = vi.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = sessionList(container);
        const otherItem = list.children[1];
        const content = otherItem.querySelector<HTMLElement>('.claudian-history-item-content')!;

        fireEvent.click(content!, { metaKey: true });
        await Promise.resolve();

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('should open a conversation in a new tab on middle click when supported', async () => {
        const container = document.body.createDiv();
        const onSelectConversation = vi.fn();
        const onOpenConversationInNewTab = vi.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = sessionList(container);
        const otherItem = list.children[1];
        const content = otherItem.querySelector<HTMLElement>('.claudian-history-item-content')!;

        fireEvent(content!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
        await Promise.resolve();

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('defers inline rename until the transient history surface is restored', async () => {
        const container = document.body.createDiv();
        const onRerender = vi.fn();
        const onRequestInlineRename = vi.fn();
        // The active row menu offers project membership actions.
        Object.assign(deps.plugin, { projects: createProjectsFake() });
        (deps.plugin.getConversationList as Mock).mockReturnValue([
          { id: 'active', title: 'Original title', createdAt: 2 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: vi.fn(),
          onRerender,
          onRequestInlineRename,
          sessionActionMode: 'active',
          showOpenStateActions: true,
        });

        const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
        const title = item.querySelector<HTMLElement>('.claudian-history-item-title')!;
        vi.spyOn(title, 'replaceWith');
        fireEvent.contextMenu(item, {stopPropagation: vi.fn(), preventDefault: vi.fn()});

        const menu = (Menu as typeof Menu & {
          instances: Array<{
            items: Array<{ title: string; clickHandler: (() => void) | null }>;
          }>;
        }).instances.at(-1)!;
        menu.items.find(menuItem => menuItem.title === 'Rename')?.clickHandler?.();

        expect(title.replaceWith).not.toHaveBeenCalled();
        expect(item.querySelector<HTMLInputElement>('.claudian-rename-input')!).toBeNull();
        expect(onRequestInlineRename).toHaveBeenCalledWith({
          beginRename: expect.any(Function),
          conversationId: 'active',
        });

        onRequestInlineRename.mock.calls[0][0].beginRename(item);
        const input = item.querySelector<HTMLInputElement>('.claudian-rename-input')!;
        expect(title.replaceWith).toHaveBeenCalledWith(input);
        input.value = 'Renamed title';
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();

        expect(deps.plugin.renameConversation).toHaveBeenCalledWith(
          'active',
          'Renamed title',
        );
        expect(onRerender).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('History Item Interactions', () => {
    let dropdown: HTMLElement;

    beforeEach(async () => {
      dropdown = document.body.createDiv();
      deps.getHistoryDropdown = () => dropdown;
    });

    it('should switch conversation when clicking a non-current item content', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = sessionList(dropdown);
      const currentItem = list.children[0];
      expect(currentItem.hasClass('active')).toBe(true);
      fireEvent.click(currentItem.querySelector<HTMLElement>('.claudian-history-item-content')!);
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
      const otherItem = list.children[1];
      const content = otherItem.querySelector<HTMLElement>('.claudian-history-item-content')!;
      expect(otherItem.hasClass('active')).toBe(false);

      fireEvent.click(content!);
      await waitFor(() => expect(deps.plugin.switchConversation).toHaveBeenCalledWith('conv-2'));
    });

    it('should call regenerateTitle when clicking regenerate button on failed item', async () => {
      const mockTitleService = {
        generateTitle: vi.fn<TitleGenerationService['generateTitle']>().mockResolvedValue(undefined),
        cancel: vi.fn<TitleGenerationService['cancel']>(),
      };
      deps.getTitleGenerationService = () => mockTitleService;

      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Failed', createdAt: 1000, lastActivityAt: 1000, titleGenerationStatus: 'failed' },
      ]);

      renderDropdown(controller, deps);

      const list = sessionList(dropdown);
      const item = list.children[0];
      const actions = item.querySelector<HTMLElement>('.claudian-history-item-actions')!;
      expect(actions).toBeTruthy();
      expect(actions!.children).toHaveLength(3);
      // First child is the regenerate button
      const regenerateBtn = actions!.children[0];
      expect(regenerateBtn.getAttribute('aria-label')).toBe('Regenerate title');

      (deps.plugin.getConversationById as Mock).mockResolvedValue({
        id: 'conv-1',
        title: 'Failed',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      fireEvent.click(regenerateBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('rerenders the owning session surface after inline rename', async () => {
      const container = document.body.createDiv();
      const onRerender = vi.fn();
      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Old title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: vi.fn(),
        onRerender,
        organization: 'linked-content',
        sort: 'created',
      });

      const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
      const title = item.querySelector<HTMLElement>('.claudian-history-item-title')!;
      vi.spyOn(title, 'replaceWith');
      fireEvent.click(within(item).getByRole('button', { name: 'Rename' }));
      const input = item.querySelector<HTMLInputElement>('.claudian-rename-input')!;
      input.value = 'New title';
      fireEvent.blur(input);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'New title');
      expect(onRerender).toHaveBeenCalledTimes(1);
    });

    it('cancels the active inline rename without persisting the draft', async () => {
      const container = document.body.createDiv();
      const onRerender = vi.fn();
      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Original title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: vi.fn(),
        onRerender,
      });

      const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
      const title = item.querySelector<HTMLElement>('.claudian-history-item-title')!;
      vi.spyOn(title, 'replaceWith');
      fireEvent.click(within(item).getByRole('button', { name: 'Rename' }));
      const input = item.querySelector<HTMLInputElement>('.claudian-rename-input')!;
      input.value = 'Unsaved title';

      expect(controller.cancelInlineRename()).toBe(true);
      await Promise.resolve();

      expect(input.value).toBe('Original title');
      expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
      expect(onRerender).toHaveBeenCalledTimes(1);
      expect(controller.cancelInlineRename()).toBe(false);
    });

    it('releases inline rename ownership when its surface rerenders without blur', () => {
      const container = document.body.createDiv();
      const options = {
        onSelectConversation: vi.fn(),
        onRerender: vi.fn(),
      };
      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Original title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, options);
      const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
      const title = item.querySelector<HTMLElement>('.claudian-history-item-title')!;
      vi.spyOn(title, 'replaceWith');
      fireEvent.click(within(item).getByRole('button', { name: 'Rename' }));
      const input = item.querySelector<HTMLInputElement>('.claudian-rename-input')!;
      input.value = 'Detached draft';

      controller.renderHistoryDropdown(container, options);

      expect(controller.cancelInlineRename()).toBe(false);
      expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    });

    it('emits a delete intent for the clicked session without reloading the active tab', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = sessionList(dropdown);
      const otherItem = list.children[1]; // conv-2
      const deleteBtn = otherItem.querySelector<HTMLElement>('.claudian-delete-btn')!;

      fireEvent.click(deleteBtn!);
      await waitFor(() => expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalled());

      expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalledWith(['conv-2']);
      expect(deps.plugin.getConversationById).not.toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });
  });
});

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
