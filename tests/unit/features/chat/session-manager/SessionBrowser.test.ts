import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createMockEl } from '@test/helpers/MockElement';
import { Menu, Notice, setIcon } from 'obsidian';

import type { TitleGenerationService } from '@/core/providers/types';
import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { ChatState } from '@/features/chat/state/ChatState';
import { OPENAI_PROVIDER_ICON } from '@/shared/icons';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

function createMockDeps(overrides: Record<string, unknown> = {}): ConversationControllerDeps & { getHistoryDropdown: () => HTMLElement; getTitleGenerationService: () => TitleGenerationService | null } {
  const state = new ChatState();
  const inputEl = { value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement;
  const historyDropdown = createMockEl();
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const linkedContentController = {
    resetAutoDraft: jest.fn(),
    lock: jest.fn(),
  };

  return {
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
      getConversationSync: jest.fn().mockReturnValue(null),
      getConversationList: jest.fn().mockReturnValue([]),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      deleteConversation: jest.fn().mockResolvedValue(undefined),
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
  } as ReturnType<typeof createMockDeps>;
}

function createBrowser(deps: ReturnType<typeof createMockDeps>): SessionBrowser {
  return new SessionBrowser({
    plugin: deps.plugin,
    getCurrentConversationId: () => deps.state.currentConversationId,
    isStreaming: () => deps.state.isStreaming,
    reloadActiveConversation: () => new ConversationController(deps).loadActive(),
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
  describe('formatDate', () => {
    it('should return time format for today', () => {
      const now = new Date();
      const result = controller.formatDate(now.getTime());

      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it('should return month/day format for a past date', () => {
      const pastDate = new Date(2023, 0, 15).getTime();
      const result = controller.formatDate(pastDate);

      expect(result).toContain('15');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return month/day format for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const result = controller.formatDate(yesterday.getTime());

      expect(result).not.toMatch(/^\d{2}:\d{2}$/);
    });
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

      it('should not delete while streaming', async () => {
        deps.state.isStreaming = true;

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

        expect(deps.plugin.deleteConversation).not.toHaveBeenCalled();
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
        const onSetConversationsArchived = jest.fn().mockResolvedValue(undefined);
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
          onSetConversationsArchived,
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
          onSetConversationsArchived,
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

      it('renders dual-mode sessions on one row with metadata in a hover card', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([{
          id: 'session-1',
          providerId: 'codex',
          selectedModel: 'gpt-5.1-codex',
          title: 'Review architecture',
          createdAt: 1_000,
          lastActivityAt: 2_000,
          linkedContentPath: 'Projects/Architecture.md',
        }]);
        jest.spyOn(controller, 'formatMetadataDate').mockReturnValue('Aug 3, 2026');
        jest.spyOn(controller, 'formatMetadataDateTime').mockReturnValue('Aug 5, 2026, 14:28');

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showMetadataPopover: true,
          getProviderIcon: () => OPENAI_PROVIDER_ICON,
          getModelLabel: () => 'GPT-5.1 Codex',
        });

        const item = container.querySelector('.claudian-history-item')!;
        item.getBoundingClientRect = jest.fn().mockReturnValue({
          top: 120,
          left: 20,
          width: 200,
          height: 28,
          right: 220,
          bottom: 148,
          x: 20,
          y: 120,
          toJSON: jest.fn(),
        });
        const body = createMockEl();
        Object.defineProperty(item.ownerDocument, 'body', {
          configurable: true,
          value: body,
        });
        const content = item.querySelector('.claudian-history-item-content')!;
        expect(item.getAttribute('tabindex')).toBeNull();
        expect(item.getAttribute('role')).toBeNull();
        expect(content.getAttribute('tabindex')).toBe('0');
        expect(content.getAttribute('role')).toBe('button');
        expect(item.querySelector('.claudian-history-item-date')).toBeNull();

        item.dispatchEvent({ type: 'mouseenter' });

        const popover = body.querySelector('.claudian-session-metadata-popover')!;
        expect(popover.getAttribute('role')).toBe('tooltip');
        expect(popover.querySelectorAll('.claudian-session-metadata-label')
          .map((label: { textContent: string }) => label.textContent))
          .toEqual(['Created', 'Last active']);
        expect(popover.querySelectorAll('.claudian-session-metadata-value')
          .map((value: { textContent: string }) => value.textContent))
          .toEqual([
            'Architecture',
            'GPT-5.1 Codex',
            'Aug 3, 2026',
            'Aug 5, 2026, 14:28',
          ]);
        expect(popover.querySelector('.claudian-session-metadata-provider-icon'))
          .not.toBeNull();
        expect(popover.style.top).toBe('120px');
        const contentValue = popover.querySelector(
          '.claudian-session-metadata-value--content',
        )!;
        expect(contentValue.getAttribute('title')).toBe('Projects/Architecture.md');

        content.dispatchEvent({
          type: 'keydown',
          key: 'Escape',
          stopPropagation: jest.fn(),
        });
        expect(popover.hasClass('claudian-hidden')).toBe(true);

        content.dispatchEvent({ type: 'focusin' });
        expect(body.querySelectorAll('.claudian-session-metadata-popover'))
          .toHaveLength(2);
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

      it('omits the note metadata row for unlinked sessions', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([{
          id: 'session-1',
          providerId: 'codex',
          selectedModel: 'gpt-5.1-codex',
          title: 'Review architecture',
          createdAt: 1_000,
          lastActivityAt: 2_000,
        }]);
        jest.spyOn(controller, 'formatMetadataDate').mockReturnValue('Aug 3, 2026');
        jest.spyOn(controller, 'formatMetadataDateTime').mockReturnValue('Aug 5, 2026, 14:28');

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showMetadataPopover: true,
          getProviderIcon: () => OPENAI_PROVIDER_ICON,
          getModelLabel: () => 'GPT-5.1 Codex',
        });

        const item = container.querySelector('.claudian-history-item')!;
        const body = createMockEl();
        Object.defineProperty(item.ownerDocument, 'body', {
          configurable: true,
          value: body,
        });

        item.dispatchEvent({ type: 'mouseenter' });

        const popover = body.querySelector('.claudian-session-metadata-popover')!;
        expect(popover.querySelectorAll('.claudian-session-metadata-row')).toHaveLength(3);
        expect(popover.querySelectorAll('.claudian-session-metadata-value')
          .map((value: { textContent: string }) => value.textContent))
          .toEqual(['GPT-5.1 Codex', 'Aug 3, 2026', 'Aug 5, 2026, 14:28']);
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
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
        });

        const archiveButton = container.querySelector('.claudian-archive-btn')!;
        expect(archiveButton.getAttribute('disabled')).not.toBeNull();
        expect(archiveButton.getAttribute('aria-label'))
          .toBe('Cannot archive a running session');
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
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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

      it('shows metadata for an existing directory with a provisional Note name', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([{
          id: 'untitled-folder',
          providerId: 'claude',
          title: 'Untitled folder chat',
          createdAt: 1,
          lastActivityAt: 1,
          linkedContentPath: 'Projects/Untitled',
        }]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          organization: 'linked-content',
          sort: 'created',
          language: 'en',
          contentExists: () => true,
          contentIsNote: () => false,
          showMetadataPopover: true,
        });

        const item = container.querySelector('.claudian-history-item')!;
        const body = createMockEl();
        Object.defineProperty(item.ownerDocument, 'body', {
          configurable: true,
          value: body,
        });
        item.dispatchEvent({ type: 'mouseenter' });

        expect(body.querySelector('.claudian-session-metadata-value--content')?.textContent)
          .toBe('Untitled');
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

        expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-1');
        expect(onRerender).toHaveBeenCalledTimes(1);
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
        const order: string[] = [];
        const restoreSpy = jest.spyOn(controller as any, 'restoreHistoryListPosition')
          .mockImplementation(() => {
            order.push('restore');
          });
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Conversation', createdAt: 1 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          preserveListState: true,
          onBeforeRestoreListState: (listContainer) => {
            order.push('decorate');
            const list = listContainer.querySelector('.claudian-history-list')!;
            list.insertBefore(createMockEl(), list.firstChild);
          },
        });

        expect(order).toEqual(['decorate', 'restore']);
        restoreSpy.mockRestore();
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
        jest.spyOn(controller, 'formatDate').mockImplementation(
          (timestamp) => `Date ${timestamp}`,
        );

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 2000 },
          { id: 'conv-2', title: 'Open', createdAt: 2000, lastActivityAt: 1000 },
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
          .toBe('Date 2000');
        expect(list.children[1].querySelector('.claudian-history-item-date')?.textContent)
          .toBe('Date 1000');
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
        jest.spyOn(controller, 'formatDate').mockImplementation(
          (timestamp) => `Date ${timestamp}`,
        );
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          {
            id: 'conv-1',
            title: 'Timestamped',
            createdAt: 1000,
            lastActivityAt: 2000,
          },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          sort: 'last-updated',
          showOpenStateLabels: false,
        });

        expect(container.querySelector('.claudian-history-item-date')?.textContent)
          .toBe('Date 2000');

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          sort: 'created',
          showOpenStateLabels: false,
        });

        expect(container.querySelector('.claudian-history-item-date')?.textContent)
          .toBe('Date 1000');
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
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
        const onSetConversationPinned = jest.fn().mockResolvedValue(undefined);
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'normal', title: 'Normal', createdAt: 2 },
          { id: 'pinned', title: 'Pinned', createdAt: 1, isPinned: true },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          showPinnedSection: true,
          onSetConversationPinned,
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
        expect(menu.items.map(item => item.title)).toEqual(['Pin', 'Rename', 'Delete']);
        menu.items[0].clickHandler?.();
        await Promise.resolve();
        expect(onSetConversationPinned).toHaveBeenCalledWith('normal', true);

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
        expect(menu.items.map(item => item.title)).toEqual(['Unpin', 'Rename', 'Delete']);
        menu.items[0].clickHandler?.();
        await Promise.resolve();
        expect(onSetConversationPinned).toHaveBeenCalledWith('pinned', false);
      });

      it('hides the inline pin action without removing the context-menu action', () => {
        const container = createMockEl();
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'active', title: 'Active', createdAt: 2 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
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
          onSetConversationPinned: jest.fn().mockResolvedValue(undefined),
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
          onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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

    it('should invoke rename handler when clicking rename button', () => {
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Test Title', createdAt: 1000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      expect(actions).toBeTruthy();
      const rBtn = actions!.children.find((button: HTMLElement) => button.getAttribute('aria-label') === 'Rename');
      expect(rBtn).toBeTruthy();
      const clickHandlers = rBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      const mockInput = createMockEl();
      (mockInput as any).type = '';
      (mockInput as any).className = '';
      (mockInput as any).value = '';
      (mockInput as any).focus = jest.fn();
      (mockInput as any).select = jest.fn();

      const titleEl = item.querySelector('.claudian-history-item-title');
      if (titleEl) {
        (titleEl as any).replaceWith = jest.fn();
      }

      const origCreateEl = item.createEl;
      item.createEl = jest.fn().mockReturnValue(mockInput) as any;

      try {
        clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(item.createEl).toHaveBeenCalledWith('input', {
          cls: 'claudian-rename-input',
          attr: { type: 'text', value: 'Test Title' },
        });
        expect(titleEl!.replaceWith).toHaveBeenCalledWith(mockInput);
      } finally {
        item.createEl = origCreateEl;
      }
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

    it('does not persist an unchanged inline rename', async () => {
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
      input.value = '  Original title  ';
      input.blur();
      await Promise.resolve();

      expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
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

    it('should delete conversation and reload active when deleting current conversation', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastActivityAt: 1000 },
      ]);

      renderDropdown(controller, deps);

      const list = dropdown.children[1];
      const item = list.children[0];
      const deleteBtn = item.querySelector('.claudian-delete-btn');
      expect(deleteBtn).toBeTruthy();

      const clickHandlers = deleteBtn!._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-1');
      expect(deps.plugin.getConversationById).toHaveBeenCalledTimes(1);
      expect(deps.plugin.getConversationById).toHaveBeenCalledWith('conv-1');
    });

    it('should delete non-current conversation without calling loadActive', async () => {
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

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-2');
      expect(deps.plugin.getConversationById).not.toHaveBeenCalled();
    });
  });

  describe('regenerateTitle', () => {
    it.each(['', 'removed-model'])('gives settings guidance without pending status for title model %s', async model => {
      deps.plugin.settings.titleGenerationModel = model;
      await controller.regenerateTitle('conv-1');
      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Select an available title model'));
    });

    it('should not regenerate if titleService is null', async () => {
      const depsNoService = createMockDeps({
        getTitleGenerationService: () => null,
      });
      const controllerNoService = createBrowser(depsNoService);

      (depsNoService.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controllerNoService.regenerateTitle('conv-1');

      expect(depsNoService.plugin.updateConversation).not.toHaveBeenCalled();
    });

    it('should not regenerate if enableAutoTitleGeneration is false', async () => {
      deps.plugin.settings.enableAutoTitleGeneration = false;
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();

      deps.plugin.settings.enableAutoTitleGeneration = true;
    });

    it('should not regenerate if conversation not found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue(null);

      await controller.regenerateTitle('non-existent');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if conversation has no messages', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if no user message found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'assistant', content: 'Hi' },
          { role: 'assistant', content: 'There' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should call titleService.generateTitle with correct params', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello world', displayContent: 'Hello world!' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      mockTitleService.generateTitle.mockImplementation(async () => {
        expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
          titleGenerationStatus: 'pending',
        });
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        'Hello world!', // Uses displayContent
        expect.any(Function)
      );
    });

    it('should regenerate title with only user message (no assistant yet)', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [{ role: 'user', content: 'Hello world' }],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        'Hello world',
        expect.any(Function)
      );
    });

    it('should rename conversation with generated title', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Create a plan' },
          { role: 'assistant', content: 'Here is the plan...' },
        ],
      });

      mockTitleService.generateTitle.mockImplementation(
        async (convId: string, _user: string, callback: any) => {
          await callback(convId, { success: true, title: 'New Generated Title' });
        }
      );

      (deps.plugin.renameConversation as any) = jest.fn().mockResolvedValue(undefined);

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'New Generated Title');
    });
  });

});
describe('SessionBrowser - regenerateTitle callback branches', () => {
  let controller: SessionBrowser;
  let deps: ReturnType<typeof createMockDeps>;
  let mockTitleService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps = createMockDeps({
      getTitleGenerationService: () => mockTitleService,
    });
    controller = createBrowser(deps);
  });

  it('should mark as failed when generation fails and user has not renamed', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns same title (user didn't rename)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'Original Title',
          messages: [],
        });
        await callback('conv-1', { success: false, title: '' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: 'failed',
    });
  });

  it('should clear status when user manually renamed during generation', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where user has renamed the conversation
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns a different title (user renamed)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'User Renamed Title',
          messages: [],
        });
        await callback('conv-1', { success: true, title: 'AI Generated Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    // Should NOT rename because user already renamed
    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    // Should clear the status since user's choice takes precedence
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: undefined,
    });
  });

  it('should not apply title when conversation no longer exists during callback', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where conversation was deleted
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(null);
        await callback('conv-1', { success: true, title: 'New Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
  });
});
