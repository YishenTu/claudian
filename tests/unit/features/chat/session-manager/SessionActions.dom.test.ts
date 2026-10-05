/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { confirmDelete } from '@/shared/modals/ConfirmModal';

jest.mock('@/shared/modals/ConfirmModal', () => ({ confirmDelete: jest.fn() }));

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

type MockMenu = {
  items: Array<{ title: string; disabled: boolean; clickHandler: (() => void) | null }>;
};

function lastMenu(): MockMenu {
  return (Menu as unknown as { instances: MockMenu[] }).instances.at(-1)!;
}

function session(id: string, title: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id, providerId: 'claude', title, messageCount: 1, preview: '',
    createdAt: testDate({ days: -3 }).getTime(), lastActivityAt: testDate({ days: -1 }).getTime(), ...extra,
  };
}

function selectedCount(container: HTMLElement): number {
  return within(container).queryAllByText('Selected').length;
}

const conversations = [
  session('alpha', 'Alpha session'),
  session('beta', 'Beta session'),
  session('gamma', 'Gamma session'),
  session('running', 'Running session'),
  session('pinned', 'Pinned session', { isPinned: true }),
  session('pinned-too', 'Second pinned session', { isPinned: true }),
];

function renderList(options: {
  onSelectConversation?: jest.Mock;
  onSetConversationsArchived?: jest.Mock;
} = {}) {
  const onSetConversationsPinned = jest.fn().mockResolvedValue(undefined);
  const onSetConversationsArchived = options.onSetConversationsArchived
    ?? jest.fn().mockResolvedValue(undefined);
  const controller = new SessionBrowser({
    plugin: { getConversationList: () => conversations, settings: {}, conversationLifecycle: {
      archive: onSetConversationsArchived, setPinned: onSetConversationsPinned,
    } },
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  } as unknown as SessionBrowserDeps);
  const container = document.createElement('div');
  document.body.append(container);
  const onSelectConversation = options.onSelectConversation ?? jest.fn().mockResolvedValue(undefined);
  const render = (): void => controller.renderHistoryDropdown(container, {
    onSelectConversation,



    onRerender: render,
    showMetadataPopover: true,
    sessionActionMode: 'active',
    getConversationStatus: (id): HistoryConversationStatus => ({
      openState: 'closed',
      isRunning: id === 'running',
    }),
  });
  render();
  const button = (name: string): HTMLElement => within(container).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
  return {
    controller, container, button, onSelectConversation, onSetConversationsArchived, onSetConversationsPinned, render,
  };
}

describe('SessionActions selection menu', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  it('skips running sessions in the selection', () => {
    const { button, onSetConversationsArchived } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    fireEvent.contextMenu(button('Alpha session'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Pin 2 sessions', 'Archive 1 session']);
    menu.items[1].clickHandler?.();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['alpha']);
  });

  it('pins the unpinned sessions in a mixed selection', () => {
    const { container, button, onSetConversationsPinned } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    expect(selectedCount(container)).toBe(3);
    fireEvent.contextMenu(button('Alpha session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Pin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['alpha', 'running'], true);
    expect(selectedCount(container)).toBe(0);
  });

  it('unpins the selection when every selected session is pinned', () => {
    const { button, onSetConversationsPinned } = renderList();

    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Second pinned session'), { altKey: true });
    fireEvent.contextMenu(button('Pinned session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Unpin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['pinned', 'pinned-too'], false);
  });
});

describe('SessionActions recency divider groups', () => {
  afterEach(() => { document.body.replaceChildren(); });

  function render(
    groupByRecency: boolean,
    items: ConversationMeta[],
    extra: Record<string, unknown> = {},
  ): HTMLElement {
    const controller = new SessionBrowser({
      plugin: { getConversationList: () => items, settings: {}, conversationLifecycle: { archive: extra.archive } },
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),
      showMetadataPopover: true,
      showPinnedSection: true,
      groupByRecency,
      ...extra,
    });
    return container;
  }

  /** Divider labels and session titles in document order. */
  const visibleSequence = (container: HTMLElement): string[] => within(container)
    .getAllByText(/^(Past week|Past 2 weeks|Past month|Older|.+ session)$/)
    .map(element => element.textContent ?? '');

  const recent = (id: string, days: number, extra: Partial<ConversationMeta> = {}): ConversationMeta => ({
    ...session(id, `${id} session`, extra),
    lastActivityAt: testDate({ days: -days }).getTime(),
  });

  it('labels the unpinned list by last activity without dividing pinned sessions', async () => {
    const container = render(true, [
      recent('fresh', 2), recent('week', 10), recent('month', 20), recent('stale', 60),
      recent('pinned-stale', 60, { isPinned: true }),
    ]);
    expect(visibleSequence(container)).toEqual([
      'pinned-stale session',
      'Past week', 'fresh session', 'Past 2 weeks', 'week session',
      'Past month', 'month session', 'Older', 'stale session',
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders no dividers unless recency grouping is requested', () => {
    const container = render(false, [recent('fresh', 2), recent('stale', 60)]);

    expect(visibleSequence(container)).toEqual(['fresh session', 'stale session']);
  });

  it('opens a divider group menu from a focusable native button', async () => {
    const onSetConversationsArchived = jest.fn().mockResolvedValue(undefined);
    const container = render(true, [recent('fresh', 2), recent('stale', 60)], {
      sessionActionMode: 'active',
      archive: onSetConversationsArchived,
    });
    const actions = within(container).getByRole('button', { name: 'Actions for Older' });

    expect(actions.tagName).toBe('BUTTON');
    expect(actions.getAttribute('type')).toBe('button');
    actions.focus();
    expect(actions.ownerDocument.activeElement).toBe(actions);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(actions);
    const menu = lastMenu() as MockMenu & { showAtPosition: jest.Mock };
    expect(menu.showAtPosition).toHaveBeenCalled();
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();
    expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale']);
  });

  it('archives every non-running session in a group from its divider menu', () => {
    const onSetConversationsArchived = jest.fn().mockResolvedValue(undefined);
    const container = render(true, [
      recent('fresh', 2), recent('stale', 60), recent('stale-running', 70), recent('ancient', 400),
    ], {
      sessionActionMode: 'active',
      archive: onSetConversationsArchived,
      getConversationStatus: (id: string): HistoryConversationStatus => ({
        openState: 'closed', isRunning: id === 'stale-running',
      }),
    });
    fireEvent.contextMenu(within(container).getByText('Older'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale', 'ancient']);
  });
});

describe('SessionActions archived bulk actions', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
    jest.mocked(confirmDelete).mockReset();
  });

  function renderArchived() {
    const archived = [
      session('one', 'First archived', { isArchived: true }),
      session('two', 'Second archived', { isArchived: true }),
      session('three', 'Third archived', { isArchived: true }),
    ];
    const onRestoreConversations = jest.fn().mockResolvedValue(undefined);
    const deleteConversation = jest.fn().mockResolvedValue(undefined);
    const controller = new SessionBrowser({
      plugin: { app: {}, getConversationList: () => archived, settings: {}, conversationLifecycle: { delete: deleteConversation, restore: onRestoreConversations } },
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = document.createElement('div');
    document.body.append(container);
    const onRerender = jest.fn();
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),


      onRerender,
      showMetadataPopover: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });
    const item = (title: string): HTMLElement => within(container).getByText(title);
    return { container, item, onRestoreConversations, onRerender, deleteConversation };
  }

  it('restores the Option-clicked archived sessions in one batch', async () => {
    const { container, item, onRestoreConversations } = renderArchived();

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.keyDown(item('Third archived'), { key: 'Enter', altKey: true });
    expect(selectedCount(container)).toBe(2);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.contextMenu(item('Third archived'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Restore 2 sessions', 'Delete 2 sessions']);
    menu.items[0].clickHandler?.();

    expect(onRestoreConversations).toHaveBeenCalledWith(['one', 'three']);
    expect(selectedCount(container)).toBe(0);
  });

  it.each([true, false])('deletes the selected archived sessions only after confirmation (%s)', async (confirmed) => {
    const { item, onRerender, deleteConversation } = renderArchived();
    jest.mocked(confirmDelete).mockResolvedValue(confirmed);

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.click(item('Second archived'), { altKey: true });
    fireEvent.contextMenu(item('First archived'));
    expect(lastMenu().items[1].title).toBe('Delete 2 sessions');
    lastMenu().items[1].clickHandler?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(confirmDelete).toHaveBeenCalledWith(expect.anything(), 'Permanently delete 2 sessions?');
    expect(deleteConversation.mock.calls).toEqual(confirmed ? [[['one', 'two']]] : []);
    expect(onRerender.mock.calls.length > 0).toBe(confirmed);
  });

  it('offers restoring or deleting every archived session of a Linked content group', async () => {
    const archived = [
      session('plan-a', 'Plan draft', { isArchived: true, linkedContentPath: 'Projects/Plan.md' }),
      session('plan-b', 'Plan review', { isArchived: true, linkedContentPath: 'Projects/Plan.md' }),
      session('other', 'Other archived', { isArchived: true, linkedContentPath: 'Projects/Other.md' }),
    ];
    const onRestoreConversations = jest.fn().mockResolvedValue(undefined);
    const deleteConversation = jest.fn().mockResolvedValue(undefined);
    jest.mocked(confirmDelete).mockResolvedValue(true);
    const controller = new SessionBrowser({
      plugin: { app: {}, getConversationList: () => archived, settings: {}, conversationLifecycle: { delete: deleteConversation, restore: onRestoreConversations } },
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),
      onSetLinkedContentPinned: jest.fn().mockResolvedValue(undefined),
      onStartLinkedContentConversation: jest.fn().mockResolvedValue(undefined),

      onRerender: jest.fn(),
      organization: 'linked-content',
      contentExists: () => true,
      contentIsNote: () => true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
      searchQuery: 'draft',
    });

    expect(within(container).queryByRole('button', { name: /^New chat for/ })).toBeNull();
    fireEvent.contextMenu(within(container).getByText('Plan'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Restore all sessions', 'Delete all sessions']);
    menu.items[0].clickHandler?.();
    expect(onRestoreConversations).toHaveBeenCalledWith(['plan-a', 'plan-b']);
    menu.items[1].clickHandler?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(confirmDelete).toHaveBeenCalledWith(expect.anything(), 'Permanently delete 2 sessions?');
    expect(deleteConversation.mock.calls).toEqual([[['plan-a', 'plan-b']]]);
  });

  it('offers restoring or deleting every archived session under a date divider', async () => {
    const archived = [
      { ...session('fresh', 'Fresh archived', { isArchived: true }), lastActivityAt: testDate({ days: -2 }).getTime() },
      { ...session('stale', 'Stale archived', { isArchived: true }), lastActivityAt: testDate({ days: -60 }).getTime() },
      { ...session('ancient', 'Ancient archived', { isArchived: true }), lastActivityAt: testDate({ days: -400 }).getTime() },
    ];
    const onRestoreConversations = jest.fn().mockResolvedValue(undefined);
    const deleteConversation = jest.fn().mockResolvedValue(undefined);
    jest.mocked(confirmDelete).mockResolvedValue(true);
    const controller = new SessionBrowser({
      plugin: { app: {}, getConversationList: () => archived, settings: {}, conversationLifecycle: { delete: deleteConversation, restore: onRestoreConversations } },
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),

      onRerender: jest.fn(),
      groupByRecency: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });

    fireEvent.contextMenu(within(container).getByText('Older'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Restore all sessions', 'Delete all sessions']);
    menu.items[0].clickHandler?.();
    expect(onRestoreConversations).toHaveBeenCalledWith(['stale', 'ancient']);
    menu.items[1].clickHandler?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deleteConversation.mock.calls).toEqual([[['stale', 'ancient']]]);
  });
});
