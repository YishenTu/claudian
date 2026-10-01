/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Menu } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import {
  type HistoryConversationStatus,
  SessionBrowser,
  type SessionBrowserDeps,
} from '@/features/chat/session-manager/SessionBrowser';
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

function expectButton(container: HTMLElement, name: string): void {
  expect(within(container).queryByRole('button', { name })).not.toBeNull();
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
  const controller = new SessionBrowser({
    plugin: { getConversationList: () => conversations, settings: {} },
    getCurrentConversationId: () => null,
    isStreaming: () => false,
    reloadActiveConversation: async () => undefined,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  } as unknown as SessionBrowserDeps);
  const container = document.createElement('div');
  document.body.append(container);
  const onSelectConversation = options.onSelectConversation ?? jest.fn().mockResolvedValue(undefined);
  const onSetConversationsArchived = options.onSetConversationsArchived
    ?? jest.fn().mockResolvedValue(undefined);
  const render = (): void => controller.renderHistoryDropdown(container, {
    onSelectConversation,
    onSetConversationsArchived,
    onSetConversationsPinned,
    onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
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
  const item = (name: string): HTMLElement => button(name).closest<HTMLElement>('.claudian-history-item')!;
  return {
    controller, container, button, item, onSelectConversation, onSetConversationsArchived, onSetConversationsPinned, render,
  };
}

describe('SessionBrowser multi-select archive', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  it('archives every Option-clicked session from the context menu of a selected session', async () => {
    const { container, button, item, onSelectConversation, onSetConversationsArchived } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Gamma session'), { altKey: true });

    expect(onSelectConversation).not.toHaveBeenCalled();
    expectButton(container, 'Alpha session Selected');
    expectButton(container, 'Gamma session Selected');
    expectButton(container, 'Beta session');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.contextMenu(item('Gamma session'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Pin 2 sessions', 'Archive 2 sessions']);
    menu.items[1].clickHandler?.();
    await Promise.resolve();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['alpha', 'gamma']);
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });

  it('skips running sessions in the selection', () => {
    const { button, item, onSetConversationsArchived } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    fireEvent.contextMenu(item('Alpha session'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Pin 2 sessions', 'Archive 1 session']);
    menu.items[1].clickHandler?.();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['alpha']);
  });

  it('pins the unpinned sessions in a mixed selection', () => {
    const { container, button, item, onSetConversationsPinned } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    fireEvent.contextMenu(item('Alpha session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Pin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['alpha', 'running'], true);
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });

  it('unpins the selection when every selected session is pinned', () => {
    const { button, item, onSetConversationsPinned } = renderList();

    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Second pinned session'), { altKey: true });
    fireEvent.contextMenu(item('Pinned session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Unpin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['pinned', 'pinned-too'], false);
  });

  it('keeps the selection while interacting with sessions and clears it when pointer or focus leaves them', () => {
    const { container, button, item } = renderList();
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Elsewhere';
    document.body.append(outside);

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.pointerDown(item('Beta session'));
    fireEvent.focusIn(button('Beta session'));
    expectButton(container, 'Alpha session Selected');

    fireEvent.pointerDown(document.body);
    expectButton(container, 'Alpha session');

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.focusIn(outside);
    expectButton(container, 'Alpha session');
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });

  it('toggles selection with Option+Enter and clears it with Escape', () => {
    const { container, button, onSelectConversation } = renderList();

    fireEvent.keyDown(button('Alpha session'), { key: 'Enter', altKey: true });
    fireEvent.keyDown(button('Beta session'), { key: 'Enter', altKey: true });
    expectButton(container, 'Alpha session Selected');
    fireEvent.keyDown(button('Alpha session'), { key: 'Enter', altKey: true });
    expectButton(container, 'Alpha session');
    expect(onSelectConversation).not.toHaveBeenCalled();

    fireEvent.keyDown(button('Beta session'), { key: 'Escape' });
    expectButton(container, 'Beta session');
  });

  it('clears the selection and shows the single-session menu for an unselected session', () => {
    const { container, button, item } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Beta session'), { altKey: true });
    fireEvent.contextMenu(item('Gamma session'));

    expect(lastMenu().items.map(menuItem => menuItem.title)).toContain('Archive');
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });

  it('clears the selection on a plain click before opening the session', () => {
    const { container, button, onSelectConversation } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Beta session'));

    expect(onSelectConversation).toHaveBeenCalledWith('beta');
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });
});

describe('SessionBrowser recency dividers', () => {
  afterEach(() => { document.body.replaceChildren(); });

  function render(
    groupByRecency: boolean,
    items: ConversationMeta[],
    extra: Record<string, unknown> = {},
  ): HTMLElement {
    const controller = new SessionBrowser({
      plugin: { getConversationList: () => items, settings: {} },
      getCurrentConversationId: () => null,
      isStreaming: () => false,
      reloadActiveConversation: async () => undefined,
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

  const recent = (id: string, days: number, extra: Partial<ConversationMeta> = {}): ConversationMeta => ({
    ...session(id, `${id} session`, extra),
    lastActivityAt: testDate({ days: -days }).getTime(),
  });

  it('labels the unpinned list by last activity without dividing pinned sessions', async () => {
    const container = render(true, [
      recent('fresh', 2), recent('week', 10), recent('month', 20), recent('stale', 60),
      recent('pinned-stale', 60, { isPinned: true }),
    ]);
    const sessionList = container.querySelector<HTMLElement>('.claudian-session-list-items')!;

    expect([...sessionList.children].map(child => (
      child.classList.contains('claudian-session-recency-divider')
        ? `# ${child.textContent}`
        : child.getAttribute('data-conversation-id')
    ))).toEqual([
      '# Past week', 'fresh', '# Past 2 weeks', 'week', '# Past month', 'month', '# Older', 'stale',
    ]);
    expect(container.querySelector('.claudian-history-section--pinned .claudian-session-recency-divider')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders no dividers unless recency grouping is requested', () => {
    const container = render(false, [recent('fresh', 2), recent('stale', 60)]);

    expect(container.querySelector('.claudian-session-recency-divider')).toBeNull();
  });

  it('archives every non-running session in a group from its divider menu', () => {
    const onSetConversationsArchived = jest.fn().mockResolvedValue(undefined);
    const container = render(true, [
      recent('fresh', 2), recent('stale', 60), recent('stale-running', 70), recent('ancient', 400),
    ], {
      sessionActionMode: 'active',
      onSetConversationsArchived,
      getConversationStatus: (id: string): HistoryConversationStatus => ({
        openState: 'closed', isRunning: id === 'stale-running',
      }),
    });
    const olderDivider = [...container.querySelectorAll<HTMLElement>('.claudian-session-recency-divider')]
      .find(divider => divider.textContent === 'Older')!;

    fireEvent.contextMenu(olderDivider);
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale', 'ancient']);
  });
});

describe('SessionBrowser archived multi-select', () => {
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
    const deleteConversation = jest.fn().mockResolvedValue(undefined);
    const controller = new SessionBrowser({
      plugin: { app: {}, getConversationList: () => archived, settings: {}, deleteConversation },
      getCurrentConversationId: () => null,
      isStreaming: () => false,
      reloadActiveConversation: async () => undefined,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = document.createElement('div');
    document.body.append(container);
    const onRestoreConversations = jest.fn().mockResolvedValue(undefined);
    const onRerender = jest.fn();
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),
      onSetConversationArchived: jest.fn().mockResolvedValue(undefined),
      onRestoreConversations,
      onRerender,
      showMetadataPopover: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });
    const item = (title: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('.claudian-history-item')]
      .find(candidate => candidate.querySelector('.claudian-history-item-title')?.textContent === title)!;
    return { container, item, onRestoreConversations, onRerender, deleteConversation };
  }

  it('restores the Option-clicked archived sessions in one batch', async () => {
    const { container, item, onRestoreConversations } = renderArchived();

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.keyDown(item('Third archived'), { key: 'Enter', altKey: true });
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.contextMenu(item('Third archived'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Restore 2 sessions', 'Delete 2 sessions']);
    menu.items[0].clickHandler?.();

    expect(onRestoreConversations).toHaveBeenCalledWith(['one', 'three']);
    expect(container.querySelectorAll('.claudian-history-item--selected')).toHaveLength(0);
  });

  it.each([true, false])('deletes the selected archived sessions only after confirmation (%s)', async (confirmed) => {
    const { item, onRerender, deleteConversation } = renderArchived();
    jest.mocked(confirmDelete).mockResolvedValue(confirmed);

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.click(item('Second archived'), { altKey: true });
    fireEvent.contextMenu(item('First archived'));
    lastMenu().items[1].clickHandler?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(confirmDelete).toHaveBeenCalledWith(expect.anything(), 'Permanently delete 2 sessions?');
    expect(deleteConversation.mock.calls).toEqual(confirmed ? [['one'], ['two']] : []);
    expect(onRerender).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  });
});

