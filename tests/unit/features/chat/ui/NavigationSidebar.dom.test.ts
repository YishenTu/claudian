/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { NavigationSidebar } from '@/features/chat/ui/NavigationSidebar';

const css = readFileSync(path.resolve('src/style/components/nav-sidebar.css'), 'utf8');
const sidebars: NavigationSidebar[] = [];

afterEach(() => {
  for (const sidebar of sidebars.splice(0)) sidebar.destroy();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function mount(scrollable: boolean) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const parentEl = document.body.createDiv();
  const messagesEl = parentEl.createDiv();
  for (const title of ['First question', 'Second question']) {
    messagesEl.createDiv({ cls: 'claudian-message claudian-message-user', attr: { 'data-toc-title': title } });
  }
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: scrollable ? 2_000 : 400 });
  Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, value: 400 });
  messagesEl.scrollTo = jest.fn() as never;

  const sidebar = new NavigationSidebar(parentEl, messagesEl);
  sidebars.push(sidebar);
  return { parentEl, messagesEl, view: within(parentEl) };
}

it('offers history navigation as named native buttons and the directory as a disclosure', async () => {
  const { parentEl, messagesEl, view } = mount(true);

  for (const name of ['Scroll to top', 'Previous message', 'Conversation directory', 'Next message', 'Scroll to bottom']) {
    expect(view.getByRole('button', { name }).getAttribute('type')).toBe('button');
  }

  const directory = view.getByRole('button', { name: 'Conversation directory' });
  expect(directory.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(directory);
  expect(directory.getAttribute('aria-expanded')).toBe('true');

  const entry = view.getByRole('button', { name: '2. Second question' });
  expect(entry.getAttribute('type')).toBe('button');
  expect((await axe(parentEl)).violations).toEqual([]);

  fireEvent.click(entry);
  expect(messagesEl.scrollTo).toHaveBeenCalled();
  expect(view.queryByRole('button', { name: '2. Second question' })).toBeNull();
  expect(directory.getAttribute('aria-expanded')).toBe('false');
});

it('keeps the navigation out of the accessibility tree and tab order while it is not shown', () => {
  const { view } = mount(false);

  expect(view.queryAllByRole('button')).toEqual([]);
  // The controls still exist, so the empty query reflects their hidden state.
  expect(view.getAllByRole('button', { hidden: true })).toHaveLength(5);
});
