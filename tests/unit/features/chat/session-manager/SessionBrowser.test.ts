import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createConversationPorts, createTestTabSession, holdResponse } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';
import { testDate } from '@test/helpers/testClock';
import { Menu, setIcon } from 'obsidian';

import type { TitleGenerationService } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { ConversationController, type ConversationControllerDeps } from '@/features/chat/conversation/ConversationController';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { formatSessionDate } from '@/features/chat/session-manager/SessionStatusPresentation';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabSession } from '@/features/chat/tabs/TabSession';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

function createMockDeps(overrides: Record<string, unknown> = {}): ConversationControllerDeps & { session: TabSession; plugin: ConversationControllerDeps['plugin'] & { settings: ClaudianSettings }; getHistoryDropdown: () => HTMLElement; getTitleGenerationService: () => TitleGenerationService | null } {
  const session = createTestTabSession({ getState: () => state });
  const state: ChatState = new ChatState({}, undefined, session.turns);
  const inputEl = { value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement;
  const historyDropdown = createMockEl();
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const linkedContentController = {
    resetAutoDraft: jest.fn(),
    lock: jest.fn(),
  };

  const deps = {
    plugin: {
      createConversation: jest.fn().mockResolvedValue({
        id: 'new-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      switchConversation: jest.fn().mockResolvedValue({
        id: 'switched-conv',
        title: 'Switched Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
      getConversationById: jest.fn().mockResolvedValue(null),
      getConversationSummary(id: string) { return this.getConversationSync(id); },
      getConversationSync: jest.fn().mockReturnValue(null),
      getConversationList: jest.fn().mockReturnValue([]),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      conversationLifecycle: { delete: jest.fn().mockResolvedValue(undefined) },
      agentService: {
        getSessionId: jest.fn().mockResolvedValue(null),
        setSessionId: jest.fn(),
      },
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        titleGenerationModel: 'haiku',
        providerConfigs: { claude: claudeCatalogFixture(['haiku']) },
        permissionMode: 'yolo',
      },
    } as any,
    state,
    renderer: {
      renderMessages: jest.fn().mockReturnValue(createMockEl()),
    } as any,
    subagentManager: {
      orphanAllActive: jest.fn(),
      clear: jest.fn(),
    } as any,
    getHistoryDropdown: () => historyDropdown as any,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: any) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl as any,
    getInputEl: () => inputEl,
    getLinkedContentController: () => linkedContentController as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    getTitleGenerationService: () => null,
    getExecutionCoordinator: () => null,
    ...overrides,
  } as unknown as ReturnType<typeof createMockDeps>;
  return Object.assign(deps, createConversationPorts({ ...(deps as any), session }));
}

function createBrowser(deps: ReturnType<typeof createMockDeps>): SessionBrowser {
  return new SessionBrowser({
    plugin: deps.plugin,
    getCurrentConversationId: () => deps.state.currentConversationId,
    getTitleGenerationService: () => deps.getTitleGenerationService(),
    onListChanged: () => undefined,
  });
}

function renderDropdown(browser: SessionBrowser, deps: ReturnType<typeof createMockDeps>): void {
  browser.renderHistoryDropdown(deps.getHistoryDropdown(), {
    onSelectConversation: id => new ConversationController(deps).switchTo(id),
  });
}

describe('SessionBrowser', () => {
  let mockTitleService: any;
  let controller: SessionBrowser;
  let deps: ReturnType<typeof createMockDeps>;
  beforeEach(() => {
    jest.clearAllMocks();
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    mockTitleService = { generateTitle: jest.fn().mockResolvedValue(undefined), cancel: jest.fn() };
    deps = createMockDeps({ getTitleGenerationService: () => mockTitleService });
    controller = createBrowser(deps);
  });
  describe('History Rendering', () => {
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    describe('updateHistoryDropdown with conversations', () => {
      it('should show "No conversations" when list is empty', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([]);

        renderDropdown(controller, deps);

        expect(dropdown.children[0].children[0].textContent).toBe('Sessions');
        const list = dropdown.children[1];
        expect(list.children[0].hasClass('claudian-history-empty')).toBe(true);
        expect(list.children[0].textContent).toBe('No conversations');
      });

      it('should sort conversations by lastActivityAt descending', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-old', title: 'Old', createdAt: 1000, lastActivityAt: 1000 },
          { id: 'conv-new', title: 'New', createdAt: 2000, lastActivityAt: 5000 },
          { id: 'conv-mid', title: 'Mid', createdAt: 3000, lastActivityAt: 3000 },
        ]);

        renderDropdown(controller, deps);

        expect(dropdown.children.length).toBe(2);
        const list = dropdown.children[1];
        expect(list.hasClass('claudian-history-list')).toBe(true);
        expect(list.children.length).toBe(3);
        expect(list.querySelectorAll('.claudian-history-item-title')
          .map((title: { textContent: string }) => title.textContent))
          .toEqual(['New', 'Mid', 'Old']);
      });

      it('should show loading indicator for pending title generation', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Generating...', createdAt: 1000, lastActivityAt: 1000, titleGenerationStatus: 'pending' },
        ]);

        renderDropdown(controller, deps);

        const list = dropdown.children[1];
        const item = list.children[0];
        const loadingEl = item.querySelector('.claudian-action-loading');
        expect(loadingEl).toBeTruthy();
      });

      it('leaves the running guard to the conversation lifecycle while the active tab streams', async () => {
        holdResponse(deps.session.turns);
        deps.state.currentConversationId = 'conv-active';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Test', createdAt: 1000, lastActivityAt: 1000 },
        ]);

        renderDropdown(controller, deps);

        const list = dropdown.children[1];
        const item = list.children[0];
        const deleteBtn = item.querySelector('.claudian-delete-btn');
        expect(deleteBtn).toBeTruthy();

        const clickHandlers = deleteBtn!._eventListeners?.get('click');
        expect(clickHandlers).toBeDefined();
        await clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalledWith(['conv-1']);
      });
    });

    describe('renderHistoryDropdown', () => {
      it('partitions pinned sessions into a dedicated dual-mode section', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'normal', title: 'Normal', createdAt: 2, lastActivityAt: 2 },
          { id: 'pinned-old', title: 'Pinned old', createdAt: 1, lastActivityAt: 1, isPinned: true },
          { id: 'pinned-new', title: 'Pinned new', createdAt: 3, lastActivityAt: 3, isPinned: true },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showPinnedSection: true,
          sort: 'last-updated',
        });

        const pinnedSection = container.querySelector('.claudian-history-section--pinned')!;
        const sessionsSection = container.querySelector('.claudian-history-section--sessions')!;
        expect(pinnedSection.querySelector('.claudian-history-section-label')?.textContent)
          .toBe('Pinned');
        expect(sessionsSection.querySelector('.claudian-history-section-label')?.textContent)
          .toBe('Sessions');
        expect(pinnedSection.querySelectorAll('.claudian-history-item-title')
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Pinned new', 'Pinned old']);
        expect(sessionsSection.querySelectorAll('.claudian-history-item-title')
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Normal']);
      });

      it('moves pinned content groups above standalone pinned sessions without duplication', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
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

        const pinnedSection = container.querySelector('.claudian-history-section--pinned')!;
        const pinnedHeaders = pinnedSection.querySelectorAll('.claudian-session-group-header');
        expect(pinnedHeaders.map((header: any) => header.getAttribute('data-content-path'))).toEqual([
          'Projects/Plan.md',
          'Projects/Empty.md',
        ]);
        expect(pinnedSection.querySelectorAll('.claudian-session-group-body')[0]
          .querySelectorAll('.claudian-history-item-title')
          .map((item: any) => item.textContent))
          .toEqual(['Note regular', 'Note pinned session']);
        expect(pinnedSection.querySelectorAll('.claudian-history-item-title')
          .map((item: any) => item.textContent))
          .toEqual(['Note regular', 'Note pinned session', 'Standalone pinned']);

        const sessionsSection = container.querySelector('.claudian-history-section--sessions')!;
        expect(sessionsSection.querySelectorAll('.claudian-history-item-title')
          .map((item: any) => item.textContent))
          .toEqual(['Regular']);
        expect(container.querySelectorAll('.claudian-history-item').filter((item: any) => (
          item.getAttribute('data-conversation-id') === 'note-pinned-session'
        ))).toHaveLength(1);
      });

      it.each(['Enter', ' '])('opens a focusable dual-mode session with %s', async (key) => {
        const container = createMockEl();
        const onSelectConversation = jest.fn().mockResolvedValue(undefined);
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([{
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

        const item = container.querySelector('.claudian-history-item')!;
        const content = item.querySelector('.claudian-history-item-content')!;
        const preventDefault = jest.fn();
        const stopPropagation = jest.fn();
        expect(item.getAttribute('role')).toBeNull();
        expect(content.getAttribute('role')).toBe('button');

        content.dispatchEvent({
          type: 'keydown',
          key,
          target: content,
          preventDefault,
          stopPropagation,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onSelectConversation).toHaveBeenCalledWith('session-1');
      });

      it('hides the pinned section when no sessions are pinned', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'normal', title: 'Normal', createdAt: 1 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showPinnedSection: true,
        });

        expect(container.querySelector('.claudian-history-section--pinned')).toBeNull();
        expect(container.querySelector('.claudian-history-section--sessions')).not.toBeNull();
      });

      it('pulses completed reviews and hides actions for every attention state', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          {
            id: 'review-pinned',
            title: 'Pinned review',
            createdAt: 4,
            isPinned: true,
          },
          { id: 'action', title: 'Action required', createdAt: 3 },
          { id: 'review', title: 'Review later', createdAt: 2 },
          { id: 'normal', title: 'Normal', createdAt: 1 },
        ]);
        const attentionById = new Map([
          ['review-pinned', { kind: 'review' as const, outcome: 'completed' as const, since: 300 }],
          ['action', { kind: 'action-required' as const, since: 100 }],
          ['review', { kind: 'review' as const, outcome: 'completed' as const, since: 200 }],
        ]);

        controller.renderHistoryDropdown(container, {
          getConversationStatus: id => ({
            attention: attentionById.get(id) ?? null,
            isRunning: false,
            openState: 'open',
          }),
          onSelectConversation: jest.fn(),
          sessionActionMode: 'active',


          showAttentionState: true,
          showPinnedSection: true,
        });

        expect(container.querySelector('.claudian-history-section--attention')).toBeNull();
        expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(4);
        const attentionItems = container.querySelectorAll('.claudian-history-item--attention');
        expect(attentionItems).toHaveLength(2);
        expect(container.querySelector('.claudian-session-attention-indicator')).toBeNull();
        const attendedItems = container.querySelectorAll('.claudian-history-item').filter(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') !== 'normal',
        );
        for (const item of attendedItems) {
          expect(item.querySelector('.claudian-pin-btn')).toBeNull();
          expect(item.querySelector('.claudian-archive-btn')).toBeNull();
        }
        const actionItem = attendedItems.find(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') === 'action',
        )!;
        expect(actionItem.hasClass('claudian-history-item--attention')).toBe(false);
        const normalItem = container.querySelectorAll('.claudian-history-item').find(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') === 'normal',
        )!;
        expect(normalItem.querySelector('.claudian-pin-btn')).not.toBeNull();
        expect(normalItem.querySelector('.claudian-archive-btn')).not.toBeNull();
      });

      it('does not mark archived rows for attention presentation', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
        ]);

        controller.renderHistoryDropdown(container, {
          getConversationStatus: () => ({
            attention: { kind: 'review', outcome: 'completed', since: 1 },
            isRunning: false,
            openState: 'open',
          }),
          onSelectConversation: jest.fn(),
          sessionScope: 'archived',
          showArchivedSection: true,
          showAttentionState: true,
        });

        expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(1);
        expect(container.querySelector('.claudian-history-item--attention')).toBeNull();
      });

      it('filters the current session scope by title and linked-content path', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          showPinnedSection: true,
          sessionScope: 'active',
          searchQuery: 'ROADMAP',
        });

        expect(container.querySelectorAll('.claudian-history-item-title')
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['Roadmap review', 'Planning notes']);
      });

      it('shows a search-specific empty state within the archived scope', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'archived', title: 'Archived', createdAt: 1, isArchived: true },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showArchivedSection: true,
          sessionScope: 'archived',
          searchQuery: 'missing',
        });

        expect(container.querySelector('.claudian-history-empty')?.textContent)
          .toBe('No matching sessions');
      });

      it('uses the same linked-content grouping and sorting for archived sessions', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          showArchivedSection: true,
          sessionScope: 'archived',
          sessionActionMode: 'archived',
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => true,

        });

        expect(container.querySelectorAll('.claudian-session-group-label')
          .map((el: { textContent: string }) => el.textContent))
          .toEqual(['B', 'A']);
      });

      it('renders full-path content groups only for the linked-content organization', () => {
        const container = createMockEl();
        const onGroupCollapseChange = jest.fn();
        const onGroupKeysChange = jest.fn();
        const onStartLinkedContentConversation = jest.fn().mockResolvedValue(undefined);
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => true,
          onGroupCollapseChange,
          onGroupKeysChange,
          onStartLinkedContentConversation,
        });

        const labels = container
          .querySelectorAll('.claudian-session-group-label')
          .map((label: { textContent: string }) => label.textContent);
        expect(labels).toEqual(['Plan', 'Plan', 'Unlinked']);
        expect(labels).not.toContain('Untitled 2');
        const groupHeaders = container.querySelectorAll('.claudian-session-group-header');
        expect(groupHeaders[0].getAttribute('title')).toBe('Projects/A/Plan.md');
        expect(groupHeaders[1].getAttribute('title')).toBe('Projects/B/Plan.md');
        const groupIcons = container.querySelectorAll('.claudian-session-group-icon');
        expect(groupIcons).toHaveLength(3);
        expect(setIcon).toHaveBeenCalledWith(groupIcons[0], 'link');
        expect(setIcon).toHaveBeenCalledWith(groupIcons[1], 'link');
        expect(setIcon).toHaveBeenCalledWith(groupIcons[2], 'inbox');
        const linkedContentActions = container.querySelectorAll(
          '.claudian-session-group-new-action',
        );
        expect(linkedContentActions).toHaveLength(2);
        expect(linkedContentActions[0].tagName).toBe('SPAN');
        expect(linkedContentActions[0].getAttribute('role')).toBe('button');
        expect(linkedContentActions[0].getAttribute('tabindex')).toBe('0');
        expect(setIcon).toHaveBeenCalledWith(linkedContentActions[0], 'square-pen');
        expect(linkedContentActions[0].getAttribute('aria-label'))
          .toBe('New chat for Plan');
        const stopPropagation = jest.fn();
        linkedContentActions[0].dispatchEvent({ type: 'click', stopPropagation });
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
        const groupBodies = container.querySelectorAll('.claudian-session-group-body');
        expect(groupBodies).toHaveLength(3);

        groupHeaders[0].click();

        expect(groupHeaders[0].getAttribute('aria-expanded')).toBe('false');
        expect(groupBodies[0].hasClass('claudian-session-group-body--collapsed')).toBe(true);
        expect(onGroupCollapseChange).toHaveBeenCalledWith(
          'content:Projects/A/Plan.md',
          true,
        );
        expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(3);
      });

      it('keeps missing groups visible without offering a new linked chat', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([{
          id: 'missing-plan',
          title: 'Missing plan',
          createdAt: 1,
          linkedContentPath: 'Gone/Plan.md',
        }]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => false,
          onStartLinkedContentConversation: jest.fn(),
        });

        expect(container.querySelector('.claudian-session-group-status')?.textContent)
          .toBe('Missing');
        expect(container.querySelector('.claudian-session-group-new-action')).toBeNull();
      });

      it('paginates large history lists and loads the next bounded page on demand', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue(
          Array.from({ length: 125 }, (_, index) => ({
            id: `conv-${index}`,
            title: `Conversation ${index}`,
            createdAt: 125 - index,
          })),
        );

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          pageSize: 25,
        });

        let list = container.children[1];
        expect(list.querySelectorAll('.claudian-history-item')).toHaveLength(25);
        const loadMore = list.querySelector('.claudian-history-load-more');
        expect(loadMore).not.toBeNull();

        loadMore!.click();
        list = container.children[1];
        expect(list.querySelectorAll('.claudian-history-item')).toHaveLength(50);
        expect(list.querySelector('.claudian-history-load-more')).not.toBeNull();
      });

      it('keeps pagination bounded across pinned and regular dual-mode sessions', () => {
        const container = createMockEl();
        const onRerender = jest.fn();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          showPinnedSection: true,
          pageSize: 25,
          preserveListState: true,
          onRerender,
        };
        controller.renderHistoryDropdown(container, options);

        let list = container.querySelector('.claudian-history-list')!;
        expect(list.querySelectorAll('.claudian-history-item')).toHaveLength(25);
        expect(list.querySelector('.claudian-history-load-more')).not.toBeNull();

        list.querySelector('.claudian-history-load-more')!.click();
        expect(onRerender).toHaveBeenCalledTimes(1);
        expect(list.dataset.visibleCount).toBe('50');
        expect(list.querySelectorAll('.claudian-history-item')).toHaveLength(25);

        controller.renderHistoryDropdown(container, options);
        list = container.querySelector('.claudian-history-list')!;
        expect(list.querySelectorAll('.claudian-history-item')).toHaveLength(40);
        expect(list.querySelector('.claudian-history-load-more')).toBeNull();
      });

      it('does not let collapsed groups consume pagination or hide later headers', () => {
        const container = createMockEl();
        const collapsedGroupKeys = new Set(['content:Projects/A.md']);
        const onRerender = jest.fn();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          onRerender,
          organization: 'linked-content',
          sort: 'created',
          pageSize: 25,
          collapsedGroupKeys,
          onGroupCollapseChange: (groupKey, collapsed) => {
            if (collapsed) {
              collapsedGroupKeys.add(groupKey);
            } else {
              collapsedGroupKeys.delete(groupKey);
            }
          },
        });

        const labels = container.querySelectorAll('.claudian-session-group-label');
        expect(labels.map((label: { textContent: string }) => label.textContent))
          .toEqual(['A', 'B']);
        expect(container.querySelectorAll('.claudian-history-item')).toHaveLength(1);
        expect(container.querySelector('.claudian-history-load-more')).toBeNull();

        container.querySelectorAll('.claudian-session-group-header')[0].click();
        expect(onRerender).toHaveBeenCalledTimes(1);
      });

      it('does not render when the history render signal is already aborted', () => {
        const container = createMockEl();
        container.createDiv({ cls: 'sentinel' });
        const abortController = new AbortController();
        abortController.abort();

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          signal: abortController.signal,
        });

        expect(container.querySelector('.sentinel')).not.toBeNull();
      });

      it('should highlight conversations already open in a tab', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationOpenState: (id) => id === 'conv-2' ? 'open' : 'current',
        });

        const list = container.children[1];
        const openItem = list.children[1];
        const openItemDate = openItem.querySelector('.claudian-history-item-date');

        expect(openItem.hasClass('open')).toBe(true);
        expect(openItem.hasClass('active')).toBe(false);
        expect(openItem.getAttribute('data-open-state')).toBe('open');
        expect(openItemDate?.textContent).toBe('Open in tab');
      });

      it('should display the current tab number when available', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationStatus: () => ({
            openState: 'current',
            isRunning: false,
            location: 'current-view',
            tabIndex: 1,
          }),
        });

        const list = container.children[1];
        const currentItem = list.children[0];
        const currentItemDate = currentItem.querySelector('.claudian-history-item-date');

        expect(currentItem.getAttribute('data-tab-index')).toBe('1');
        expect(currentItem.getAttribute('data-tab-location')).toBe('current-view');
        expect(currentItemDate?.textContent).toBe('Current tab 1');
      });

      it('should display the open tab number when available', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationStatus: (id) => id === 'conv-2'
            ? { openState: 'open', isRunning: false, location: 'current-view', tabIndex: 2 }
            : { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 },
        });

        const list = container.children[1];
        const openItem = list.children[1];
        const openItemDate = openItem.querySelector('.claudian-history-item-date');

        expect(openItem.getAttribute('data-tab-index')).toBe('2');
        expect(openItem.getAttribute('data-tab-location')).toBe('current-view');
        expect(openItemDate?.textContent).toBe('Open in tab 2');
      });

      it('shows timestamps instead of open-state labels when requested by the surface', () => {
        const container = createMockEl();
        const currentActivity = testDate({ days: -10 }).getTime();
        const openActivity = testDate({ days: -40 }).getTime();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: openActivity, lastActivityAt: currentActivity },
          { id: 'conv-2', title: 'Open', createdAt: currentActivity, lastActivityAt: openActivity },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationStatus: (id) => id === 'conv-1'
            ? { openState: 'current', isRunning: false, location: 'current-view', tabIndex: 1 }
            : { openState: 'open', isRunning: true, location: 'current-view', tabIndex: 2 },
          showOpenStateLabels: false,
        });

        const list = container.children[1];
        expect(list.children[0].querySelector('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(currentActivity));
        expect(list.children[1].querySelector('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(openActivity));
        const runningIndicators = list.querySelectorAll(
          '.claudian-session-running-indicator',
        );
        expect(runningIndicators).toHaveLength(1);
        expect(setIcon).toHaveBeenCalledWith(runningIndicators[0], 'loader-2');
      });

      it('replaces the dual-pane spinner with matched action and error badges', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'waiting', title: 'Waiting', createdAt: 5000 },
          { id: 'working', title: 'Working', createdAt: 4000 },
          { id: 'error', title: 'Error', createdAt: 3000 },
          { id: 'review', title: 'Review', createdAt: 2000 },
          { id: 'idle', title: 'Idle', createdAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
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

        const items = container.querySelectorAll('.claudian-history-item');
        const findItem = (id: string) => items.find(
          (item: HTMLElement) => item.getAttribute('data-conversation-id') === id,
        )!;
        const waitingItem = findItem('waiting');
        const waitingBadge = waitingItem.querySelector(
          '.claudian-session-status-indicator--action-required',
        )!;
        const workingItem = findItem('working');
        const errorItem = findItem('error');
        const errorBadge = errorItem.querySelector(
          '.claudian-session-status-indicator--error',
        )!;

        expect(waitingBadge).not.toBeNull();
        expect(waitingBadge.hasClass('claudian-session-status-indicator')).toBe(true);
        expect(waitingBadge.getAttribute('aria-label')).toBe('Needs your input');
        expect(waitingItem.querySelector('.claudian-session-running-indicator')).toBeNull();
        expect(waitingItem.hasClass('running')).toBe(false);
        expect(waitingItem.getAttribute('data-running')).toBe('true');
        expect(setIcon).toHaveBeenCalledWith(
          waitingItem.querySelector('.claudian-history-item-icon'),
          'message-square',
        );
        expect(waitingItem.hasClass('claudian-history-item--attention')).toBe(false);
        expect(setIcon).toHaveBeenCalledWith(waitingBadge, 'alert-circle');

        expect(workingItem.querySelector('.claudian-session-running-indicator')).not.toBeNull();
        expect(workingItem.querySelector('.claudian-session-status-indicator')).toBeNull();

        expect(errorBadge).not.toBeNull();
        expect(errorBadge.hasClass('claudian-session-status-indicator')).toBe(true);
        expect(errorBadge.getAttribute('aria-label')).toBe('Stopped with an error');
        expect(errorItem.hasClass('claudian-history-item--attention')).toBe(false);
        expect(setIcon).toHaveBeenCalledWith(errorBadge, 'x-circle');

        expect(findItem('review').hasClass('claudian-history-item--attention')).toBe(true);
        expect(findItem('review').querySelector('.claudian-session-status-indicator')).toBeNull();
        expect(findItem('idle').querySelector('.claudian-session-status-indicator')).toBeNull();
      });

      it('displays the timestamp selected by the session sort mode', () => {
        const container = createMockEl();
        const createdAt = testDate({ days: -40 }).getTime();
        const lastActivityAt = testDate({ days: -10 }).getTime();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          {
            id: 'conv-1',
            title: 'Timestamped',
            createdAt,
            lastActivityAt,
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          sort: 'last-updated',
          showOpenStateLabels: false,
        });

        expect(container.querySelector('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(lastActivityAt));

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          sort: 'created',
          showOpenStateLabels: false,
        });

        expect(container.querySelector('.claudian-history-item-date')?.textContent)
          .toBe(formatSessionDate(createdAt));
      });

      it('shows a running indicator on a collapsed linked-content header', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showOpenStateLabels: false,
          getConversationStatus: (id) => ({
            openState: id === 'running' ? 'open' : 'closed',
            isRunning: id === 'running',
          }),
        });

        const header = container.querySelector('.claudian-session-group-header')!;
        const headerIndicator = header.querySelector(
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
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
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

        const header = container.querySelector('.claudian-session-group-header')!;
        const badge = header.querySelector(
          '.claudian-session-group-status-indicator',
        )!;
        expect(badge).not.toBeNull();
        expect(badge.hasClass('claudian-session-status-indicator--action-required')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(false);
        expect(header.querySelector('.claudian-session-group-running-indicator')).toBeNull();

        header.click();

        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(true);
        expect(badge.getAttribute('aria-label')).toBe('Needs your input');
        expect(setIcon).toHaveBeenCalledWith(badge, 'alert-circle');
      });

      it('shows an error badge on a collapsed linked-content group without active work', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          {
            id: 'error',
            title: 'Failed session',
            createdAt: 1000,
            linkedContentPath: 'Projects/Plan.md',
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
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

        const header = container.querySelector('.claudian-session-group-header')!;
        const badge = header.querySelector(
          '.claudian-session-group-status-indicator',
        )!;
        header.click();

        expect(badge.hasClass('claudian-session-status-indicator--error')).toBe(true);
        expect(badge.hasClass('claudian-session-group-status-indicator--visible')).toBe(true);
        expect(badge.getAttribute('aria-label')).toBe('Stopped with an error');
        expect(setIcon).toHaveBeenCalledWith(badge, 'x-circle');
      });

      it('marks a collapsed linked-content header when it contains attention', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
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
          onSelectConversation: jest.fn(),
          organization: 'linked-content',
          sort: 'last-updated',
          language: 'en',
          showAttentionState: true,
          getConversationStatus: (id) => ({
            openState: 'open',
            isRunning: false,
            attention: id === 'attention'
              ? { kind: 'review', outcome: 'completed', since: 1000 }
              : null,
          }),
        });

        const header = container.querySelector('.claudian-session-group-header')!;
        expect(header.hasClass('claudian-session-group-header--attention')).toBe(false);
        expect(header.querySelector('.claudian-session-group-attention-indicator')).toBeNull();

        header.click();

        expect(header.hasClass('claudian-session-group-header--attention')).toBe(true);
      });

      it('should display running status for the current conversation', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationStatus: () => ({
            openState: 'current',
            isRunning: true,
          }),
        });

        const list = container.children[1];
        const currentItem = list.children[0];
        const currentItemDate = currentItem.querySelector('.claudian-history-item-date');

        expect(currentItem.hasClass('active')).toBe(true);
        expect(currentItem.hasClass('running')).toBe(true);
        expect(currentItem.getAttribute('data-running')).toBe('true');
        expect(currentItemDate?.textContent).toBe('Running in current tab');
      });

      it('should display running status for a conversation open in another tab', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Running elsewhere', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          getConversationStatus: (id) => id === 'conv-2'
            ? { openState: 'open', isRunning: true, location: 'current-view', tabIndex: 2 }
            : { openState: 'current', isRunning: false },
        });

        const list = container.children[1];
        const runningItem = list.children[1];
        const runningItemDate = runningItem.querySelector('.claudian-history-item-date');

        expect(runningItem.hasClass('open')).toBe(true);
        expect(runningItem.hasClass('running')).toBe(true);
        expect(runningItem.getAttribute('data-open-state')).toBe('open');
        expect(runningItem.getAttribute('data-running')).toBe('true');
        expect(runningItemDate?.textContent).toBe('Running in tab 2');
      });

      it('should display another-pane status without a local tab number', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open elsewhere', createdAt: 2000, lastActivityAt: 1000 },
          { id: 'conv-3', title: 'Running elsewhere', createdAt: 3000, lastActivityAt: 500 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
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

        const list = container.children[1];
        const openOtherPaneItem = list.children[1];
        const runningOtherPaneItem = list.children[2];
        const runningOtherPaneDate = runningOtherPaneItem.querySelector('.claudian-history-item-date');
        const openOtherPaneDate = openOtherPaneItem.querySelector('.claudian-history-item-date');

        expect(runningOtherPaneItem.getAttribute('data-tab-location')).toBe('other-view');
        expect(runningOtherPaneItem.getAttribute('data-tab-index')).toBeNull();
        expect(runningOtherPaneDate?.textContent).toBe('Running in another pane');
        expect(openOtherPaneDate?.textContent).toBe('Open in another pane');
      });

      it('should open a conversation in a new tab on modifier click when supported', async () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();
        const onOpenConversationInNewTab = jest.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const clickHandlers = content?._eventListeners?.get('click');
        expect(clickHandlers).toBeDefined();

        await clickHandlers![0]({
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        });

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('should open a conversation in a new tab on middle click when supported', async () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();
        const onOpenConversationInNewTab = jest.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const auxClickHandlers = content?._eventListeners?.get('auxclick');
        expect(auxClickHandlers).toBeDefined();

        await auxClickHandlers![0]({
          button: 1,
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('defers inline rename until the transient history surface is restored', async () => {
        const container = createMockEl();
        const onRerender = jest.fn();
        const onRequestInlineRename = jest.fn();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'active', title: 'Original title', createdAt: 2 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          onRerender,
          onRequestInlineRename,
          sessionActionMode: 'active',
          showOpenStateActions: true,
        });

        const item = container.querySelector('.claudian-history-item')!;
        const title = item.querySelector('.claudian-history-item-title')!;
        title.replaceWith = jest.fn();
        item.dispatchEvent({
          type: 'contextmenu',
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });

        const menu = (Menu as typeof Menu & {
          instances: Array<{
            items: Array<{ title: string; clickHandler: (() => void) | null }>;
          }>;
        }).instances.at(-1)!;
        menu.items.find(menuItem => menuItem.title === 'Rename')?.clickHandler?.();

        expect(title.replaceWith).not.toHaveBeenCalled();
        expect(item.querySelector('.claudian-rename-input')).toBeNull();
        expect(onRequestInlineRename).toHaveBeenCalledWith({
          beginRename: expect.any(Function),
          conversationId: 'active',
        });

        onRequestInlineRename.mock.calls[0][0].beginRename(item);
        const input = item.querySelector('.claudian-rename-input')!;
        expect(title.replaceWith).toHaveBeenCalledWith(input);
        input.value = 'Renamed title';
        input.blur();
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
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    it('should switch conversation when clicking a non-current item content', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = dropdown.children[1];
      const currentItem = list.children[0];
      expect(currentItem.hasClass('active')).toBe(true);
      expect(currentItem.querySelector('.claudian-history-item-content')
        ?._eventListeners?.get('click')).toBeUndefined();
      const otherItem = list.children[1];
      const content = otherItem.querySelector('.claudian-history-item-content');
      const clickHandlers = content?._eventListeners?.get('click');
      expect(otherItem.hasClass('active')).toBe(false);
      expect(clickHandlers).toBeDefined();
      expect(clickHandlers).toHaveLength(1);

      await clickHandlers![0]({ stopPropagation: jest.fn() });
      for (let attempt = 0;
        attempt < 10 && (deps.plugin.switchConversation as jest.Mock).mock.calls.length === 0;
        attempt += 1) {
        await Promise.resolve();
      }

      expect(deps.plugin.switchConversation).toHaveBeenCalledWith('conv-2');
    });

    it('should call regenerateTitle when clicking regenerate button on failed item', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      deps.getTitleGenerationService = () => mockTitleService as any;

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Failed', createdAt: 1000, lastActivityAt: 1000, titleGenerationStatus: 'failed' },
      ]);

      renderDropdown(controller, deps);

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      expect(actions).toBeTruthy();
      expect(actions!.children).toHaveLength(3);
      // First child is the regenerate button
      const regenerateBtn = actions!.children[0];
      expect(regenerateBtn.getAttribute('aria-label')).toBe('Regenerate title');
      const clickHandlers = regenerateBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        title: 'Failed',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('rerenders the owning session surface after inline rename', async () => {
      const container = createMockEl();
      const onRerender = jest.fn();
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Old title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: jest.fn(),
        onRerender,
        organization: 'linked-content',
        sort: 'created',
      });

      const item = container.querySelector('.claudian-history-item')!;
      const title = item.querySelector('.claudian-history-item-title')!;
      title.replaceWith = jest.fn();
      item.querySelector('.claudian-history-item-actions')!.children.find((button: HTMLElement) => button.getAttribute('aria-label') === 'Rename')!.click();
      const input = item.querySelector('.claudian-rename-input')!;
      input.value = 'New title';
      input.blur();
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'New title');
      expect(onRerender).toHaveBeenCalledTimes(1);
    });

    it('cancels the active inline rename without persisting the draft', async () => {
      const container = createMockEl();
      const onRerender = jest.fn();
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Original title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, {
        onSelectConversation: jest.fn(),
        onRerender,
      });

      const item = container.querySelector('.claudian-history-item')!;
      const title = item.querySelector('.claudian-history-item-title')!;
      title.replaceWith = jest.fn();
      item.querySelector('.claudian-history-item-actions')!.children.find((button: HTMLElement) => button.getAttribute('aria-label') === 'Rename')!.click();
      const input = item.querySelector('.claudian-rename-input')!;
      input.value = 'Unsaved title';

      expect(controller.cancelInlineRename()).toBe(true);
      await Promise.resolve();

      expect(input.value).toBe('Original title');
      expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
      expect(onRerender).toHaveBeenCalledTimes(1);
      expect(controller.cancelInlineRename()).toBe(false);
    });

    it('releases inline rename ownership when its surface rerenders without blur', () => {
      const container = createMockEl();
      const options = {
        onSelectConversation: jest.fn(),
        onRerender: jest.fn(),
      };
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Original title', createdAt: 1000 },
      ]);

      controller.renderHistoryDropdown(container, options);
      const item = container.querySelector('.claudian-history-item')!;
      const title = item.querySelector('.claudian-history-item-title')!;
      title.replaceWith = jest.fn();
      item.querySelector('.claudian-history-item-actions')!.children.find((button: HTMLElement) => button.getAttribute('aria-label') === 'Rename')!.click();
      const input = item.querySelector('.claudian-rename-input')!;
      input.value = 'Detached draft';

      controller.renderHistoryDropdown(container, options);

      expect(controller.cancelInlineRename()).toBe(false);
      expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    });

    it('emits a delete intent for the clicked session without reloading the active tab', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = dropdown.children[1];
      const otherItem = list.children[1]; // conv-2
      const deleteBtn = otherItem.querySelector('.claudian-delete-btn');
      const clickHandlers = deleteBtn!._eventListeners?.get('click');

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.conversationLifecycle.delete).toHaveBeenCalledWith(['conv-2']);
      expect(deps.plugin.getConversationById).not.toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });
  });
});
