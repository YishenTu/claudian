/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { ClaudianView } from '@/features/chat/ClaudianView';

it.each([false, true])('keeps session navigation named and operable without tooltips (archive: %s)', async archived => {
  const host = document.body.createDiv();
  const list = host.createDiv({ cls: 'claudian-history-list' });
  list.createDiv({ cls: 'claudian-session-list-header' });
  const view = Object.create(ClaudianView.prototype) as any;
  Object.assign(view, {
    isArchiveSessionView: archived,
    getSessionGroupKeys: () => new Set(),
    getSessionManagerOrganization: () => 'list',
    updateNewTabButtonVisibility: jest.fn(),
    requestSessionNew: jest.fn(),
    activateSessionSearch: jest.fn(),
    setArchiveSessionView: jest.fn(),
  });
  view.buildSessionHeaderActions(host);
  const names = ['New', 'Search', archived ? 'Sessions' : 'Archive'];
  for (const name of names) {
    const button = within(host).getByRole('button', { name });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter' });
  }
  expect(view.requestSessionNew).toHaveBeenCalledTimes(1);
  expect(view.activateSessionSearch).toHaveBeenCalledTimes(1);
  expect(view.setArchiveSessionView).toHaveBeenCalledWith(!archived);
  expect((await axe(host)).violations).toEqual([]);
  host.remove();
});
