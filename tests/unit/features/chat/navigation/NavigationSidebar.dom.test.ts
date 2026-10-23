/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ProviderCapabilities } from '@/core/providers/types';
import { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';
import { MessageActions } from '@/features/chat/rendering/MessageActions';
import { setLocale } from '@/i18n/i18n';

const css = readFileSync(path.resolve('src/style/components/nav-sidebar.css'), 'utf8');
const sidebars: NavigationSidebar[] = [];

afterEach(() => {
  for (const sidebar of sidebars.splice(0)) sidebar.destroy();
  setLocale('en');
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
  return { parentEl, messagesEl, sidebar, view: within(parentEl) };
}

it('localizes the named navigation controls and the directory in the selected locale', () => {
  expect(setLocale('zh-CN')).toBe(true);
  const { messagesEl, sidebar, view } = mount(true);

  const names = {
    top: '滚动到顶部',
    previous: '上一条消息',
    directory: '对话目录',
    next: '下一条消息',
    bottom: '滚动到底部',
  };
  for (const name of [names.top, names.previous, names.directory, names.next, names.bottom]) {
    expect(view.getByRole('button', { name }).getAttribute('type')).toBe('button');
  }

  // External geometry the owner must target; jsdom lays nothing out.
  const [firstMessage, secondMessage] = Array.from(
    messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user'),
  );
  Object.defineProperty(firstMessage, 'offsetTop', { configurable: true, value: 600 });
  Object.defineProperty(secondMessage, 'offsetTop', { configurable: true, value: 1_200 });
  Object.defineProperty(messagesEl, 'scrollTop', { configurable: true, value: 1_000 });

  const intents: string[] = [];
  sidebar.setOnScrollIntent(intent => intents.push(intent));

  fireEvent.click(view.getByRole('button', { name: names.top }));
  expect(intents).toEqual(['away']);
  expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });

  fireEvent.click(view.getByRole('button', { name: names.bottom }));
  expect(intents).toEqual(['away', 'bottom']);
  expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: 2_000, behavior: 'smooth' });

  fireEvent.click(view.getByRole('button', { name: names.previous }));
  expect(intents).toEqual(['away', 'bottom', 'away']);
  expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: 590, behavior: 'smooth' });

  fireEvent.click(view.getByRole('button', { name: names.next }));
  expect(intents).toEqual(['away', 'bottom', 'away', 'away']);
  expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: 1_190, behavior: 'smooth' });

  const directory = view.getByRole('button', { name: names.directory });
  expect(directory.getAttribute('aria-expanded')).toBe('false');
  directory.focus();
  expect(document.activeElement).toBe(directory);
  fireEvent.click(directory);
  expect(directory.getAttribute('aria-expanded')).toBe('true');
  // The heading reuses the directory name; entries keep the user-authored titles and numbering.
  expect(view.getByText(names.directory)).toBeTruthy();
  expect(view.getByRole('button', { name: '1. First question' })).toBeTruthy();

  const entry = view.getByRole('button', { name: '2. Second question' });
  expect(entry.getAttribute('type')).toBe('button');
  entry.focus();
  expect(document.activeElement).toBe(entry);
  fireEvent.click(entry);
  expect(intents).toEqual(['away', 'bottom', 'away', 'away', 'away']);
  expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: 1_190, behavior: 'smooth' });
  expect(view.queryByRole('button', { name: '2. Second question' })).toBeNull();
  expect(directory.getAttribute('aria-expanded')).toBe('false');
});

it('renders the localized empty directory state once the messages are cleared', async () => {
  expect(setLocale('zh-CN')).toBe(true);
  const { messagesEl, view } = mount(true);

  const directory = view.getByRole('button', { name: '对话目录' });
  fireEvent.click(directory);
  // The entry query addresses live entries while they exist.
  expect(view.getByRole('button', { name: '1. First question' })).toBeTruthy();

  for (const message of Array.from(messagesEl.querySelectorAll('.claudian-message-user'))) {
    message.remove();
  }

  // The owner's observer refreshes the open directory to the empty state.
  await waitFor(() => expect(view.getByText('此对话中暂无用户提示词')).toBeTruthy());
  expect(directory.getAttribute('aria-expanded')).toBe('true');
  expect(view.getByText('对话目录')).toBeTruthy();
  expect(view.queryAllByRole('button', { name: /^\d+\.\s/ })).toEqual([]);
  // A hidden sidebar would make the absence check trivial; the controls stay in the accessibility tree.
  expect(view.getAllByRole('button')).toHaveLength(5);
});

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

// Expected names are acceptance literals: the title keeps whole characters and
// the 80-unit cap (ellipsis included), never slicing a surrogate pair apart.
const EMOJI = '😀';
const directoryTitleCases = [
  [
    'truncates at a surrogate pair boundary without splitting the pair',
    `${'x'.repeat(76)}${EMOJI}tail`,
    `${'x'.repeat(76)}...`,
  ],
  [
    'keeps a surrogate pair that fits before the truncation boundary',
    `${'x'.repeat(75)}${EMOJI}tail`,
    `${'x'.repeat(75)}${EMOJI}...`,
  ],
  [
    'leaves an exact 80-unit title unchanged',
    `${'x'.repeat(78)}${EMOJI}`,
    `${'x'.repeat(78)}${EMOJI}`,
  ],
] as const;

function addUserPrompt(messagesEl: HTMLElement, rawText: string): HTMLElement {
  const msgEl = messagesEl.createDiv({ cls: 'claudian-message claudian-message-user' });
  msgEl.createDiv({ cls: 'claudian-message-content', text: rawText });
  return msgEl;
}

describe.each(directoryTitleCases)('directory title: %s', (_name, rawText, expectedTitle) => {
  it('shows the published title from real MessageActions metadata', () => {
    const { messagesEl, view } = mount(true);
    messagesEl.replaceChildren();
    const msgEl = addUserPrompt(messagesEl, rawText);
    const actions = new MessageActions(
      { settings: {} } as never, messagesEl, () => ({}) as ProviderCapabilities, {}, () => false,
    );
    actions.applyTocTitle(msgEl, rawText);

    fireEvent.click(view.getByRole('button', { name: 'Conversation directory' }));
    expect(view.getByRole('button', { name: `1. ${expectedTitle}` }).textContent).toBe(`1. ${expectedTitle}`);
  });
});

it('falls back to visible message text without metadata through the same formatter', () => {
  const rawText = `${'x'.repeat(76)}${EMOJI}tail`;
  const { messagesEl, view } = mount(true);
  messagesEl.replaceChildren();
  addUserPrompt(messagesEl, rawText);

  fireEvent.click(view.getByRole('button', { name: 'Conversation directory' }));
  expect(view.getByRole('button', { name: `1. ${'x'.repeat(76)}...` }).textContent).toBe(`1. ${'x'.repeat(76)}...`);
});
