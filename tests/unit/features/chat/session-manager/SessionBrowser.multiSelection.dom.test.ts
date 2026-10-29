/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import type { ConversationMeta } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';



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
  onSelectConversation?: Mock;
  onSetConversationsArchived?: Mock;
} = {}) {
  const onSetConversationsPinned = vi.fn().mockResolvedValue(undefined);
  const onSetConversationsArchived = options.onSetConversationsArchived
    ?? vi.fn().mockResolvedValue(undefined);
  const controller = new SessionBrowser({
    plugin: { getConversationList: () => conversations, settings: {}, projects: createProjectsFake(), conversationLifecycle: {
      archive: onSetConversationsArchived, setPinned: onSetConversationsPinned,
    } },
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  } as unknown as SessionBrowserDeps);
  const container = document.createElement('div');
  document.body.append(container);
  const onSelectConversation = options.onSelectConversation ?? vi.fn().mockResolvedValue(undefined);
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

describe('SessionBrowser multi-select archive', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  it('archives every Option-clicked session from the context menu of a selected session', async () => {
    const { container, button, onSelectConversation, onSetConversationsArchived } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Gamma session'), { altKey: true });

    expect(onSelectConversation).not.toHaveBeenCalled();
    expectButton(container, 'Alpha session Selected');
    expectButton(container, 'Gamma session Selected');
    expectButton(container, 'Beta session');
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.contextMenu(button('Gamma session'));
    const menu = lastMenu();
    expect(menu.items.map(menuItem => menuItem.title)).toEqual(['Pin 2 sessions', 'Move 2 sessions to project…', 'Archive 2 sessions']);
    menu.items[2].clickHandler?.();
    await Promise.resolve();

    expect(onSetConversationsArchived).toHaveBeenCalledWith(['alpha', 'gamma']);
    expect(selectedCount(container)).toBe(0);
  });

  it('keeps the selection while interacting with sessions and clears it when pointer or focus leaves them', () => {
    const { container, button } = renderList();
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Elsewhere';
    document.body.append(outside);

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.pointerDown(button('Beta session'));
    fireEvent.focusIn(button('Beta session'));
    expectButton(container, 'Alpha session Selected');

    fireEvent.pointerDown(document.body);
    expectButton(container, 'Alpha session');

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.focusIn(outside);
    expectButton(container, 'Alpha session');
    expect(selectedCount(container)).toBe(0);
  });

  it('keeps the selection for pointer-downs inside a list rendered in another window', () => {
    const popoutDocument = createPopoutDocument();
    const controller = new SessionBrowser({
      plugin: { getConversationList: () => conversations, settings: {}, projects: createProjectsFake() },
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    } as unknown as SessionBrowserDeps);
    const container = popoutDocument.createElement('div');
    popoutDocument.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),

      showMetadataPopover: true,
      sessionActionMode: 'active',
    });
    const popoutButton = (name: string): HTMLElement => within(container).getByRole('button', {
      name: new RegExp(`^${name}`),
    });

    fireEvent.click(popoutButton('Alpha session'), { altKey: true });
    fireEvent.pointerDown(popoutButton('Beta session'));
    fireEvent.click(popoutButton('Beta session'), { altKey: true });

    expect(selectedCount(container)).toBe(2);
    fireEvent.pointerDown(popoutDocument.body);
    expect(selectedCount(container)).toBe(0);
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
    const { container, button } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Beta session'), { altKey: true });
    expect(selectedCount(container)).toBe(2);
    fireEvent.contextMenu(button('Gamma session'));

    expect(lastMenu().items.map(menuItem => menuItem.title)).toContain('Archive');
    expect(selectedCount(container)).toBe(0);
  });

  it('clears the selection on a plain click before opening the session', () => {
    const { container, button, onSelectConversation } = renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    expect(selectedCount(container)).toBe(1);
    fireEvent.click(button('Beta session'));

    expect(onSelectConversation).toHaveBeenCalledWith('beta');
    expect(selectedCount(container)).toBe(0);
  });
});
