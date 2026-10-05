/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of [classes].flat()) this.classList.toggle(name, value);
};

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

function createSurface() {
  // Active rows carry their own Archive action; an archived-only list keeps navigation names unique.
  const conversations = [conversation('archived', { isArchived: true })];
  const plugin = {
    app: { vault: { getAbstractFileByPath: () => null } },
    settings: { enableAutoTitleGeneration: false },
    getConversationList: () => conversations,
  };
  const requestNew = jest.fn();
  const surface = new SessionManagerSurface({
    plugin: plugin as unknown as ChatFeatureHost,
    navigation: {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
      hasUnboundDraft: () => false,
      openConversation: jest.fn().mockResolvedValue(undefined),
      openSessionConversation: jest.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: jest.fn().mockResolvedValue(undefined),
    },
    getActiveTab: () => null,
    isWide: () => true,
    canCreateTab: () => true,
    requestNew,
    notifyOtherViews: jest.fn(),
  });
  const host = document.body.createDiv();
  surface.mountSidebar(host);
  surface.renderSidebar();
  return { host, requestNew, surface };
}

afterEach(() => {
  document.body.replaceChildren();
});

it.each([false, true])('keeps session navigation named and operable without tooltips (archive: %s)', async archived => {
  const { host, requestNew, surface } = createSurface();
  const sidebar = within(host);
  if (archived) {
    fireEvent.keyDown(sidebar.getByRole('button', { name: 'Archive' }), { key: 'Enter' });
  }
  const archiveName = archived ? 'Sessions' : 'Archive';
  const list = host.querySelector('.claudian-history-list')!;
  expect(within(list as HTMLElement).getByText(archived ? 'Archived' : 'Sessions')).toBeTruthy();

  for (const name of ['New', 'Search', archiveName]) {
    const button = sidebar.getByRole('button', { name });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    // Navigation sits above the session list and its header.
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button.focus();
    expect(document.activeElement).toBe(button);
  }
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'Search' }), { key: 'Enter' });
  const searchBox = sidebar.getByRole('searchbox', {
    name: archived ? 'Search archived sessions' : 'Search sessions',
  });
  expect(document.activeElement).toBe(searchBox);
  expect(sidebar.queryByRole('button', { name: 'Search' })).toBeNull();
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: archiveName }), { key: 'Enter' });
  expect(sidebar.getByRole('button', { name: archived ? 'Archive' : 'Sessions' })).toBeTruthy();
  expect(sidebar.queryByRole('searchbox')).toBeNull();

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'New' }), { key: 'Enter' });
  expect(requestNew).toHaveBeenCalledTimes(1);
  // New always returns to active sessions.
  expect(sidebar.getByRole('button', { name: 'Archive' })).toBeTruthy();

  surface.dispose();
});
