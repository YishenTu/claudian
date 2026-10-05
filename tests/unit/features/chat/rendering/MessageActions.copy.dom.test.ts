/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { setIcon } from 'obsidian';

import type { ProviderCapabilities } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { MessageActions } from '@/features/chat/rendering/MessageActions';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.setText = function (text) { this.textContent = typeof text === 'string' ? text : null; };

const COPY_FEEDBACK_MS = 1_500;
const USER_MESSAGE: ChatMessage = { id: 'u1', role: 'user', content: 'user prompt', timestamp: testDate().getTime() };

function setup() {
  const messagesEl = document.body.createDiv();
  const actions = new MessageActions(
    { settings: {} } as never, messagesEl, () => ({}) as ProviderCapabilities, {},
  );
  return { messagesEl, actions };
}

/** Both toolbars copy through the same shared feedback binding. */
const copyButtonSources = [
  ['response', 'copied response', (actions: MessageActions, messagesEl: HTMLElement) => {
    actions.addTextCopyButton(messagesEl.createDiv(), 'copied response');
  }],
  ['user message', 'user prompt', (actions: MessageActions, messagesEl: HTMLElement) => {
    actions.decorateUserMessage(messagesEl.createDiv(), USER_MESSAGE, 'user prompt');
  }],
] as const;

function writeTextReturning(result: () => Promise<void>) {
  const writeText = jest.fn(result);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

beforeEach(() => {
  document.body.replaceChildren();
  jest.useFakeTimers();
  // Obsidian renders icons; expose the requested icon so restoration is observable.
  jest.mocked(setIcon).mockImplementation((el, icon) => {
    el.replaceChildren(el.ownerDocument.createElement('svg'));
    el.firstElementChild!.setAttribute('data-icon', icon);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.mocked(setIcon).mockReset();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe.each(copyButtonSources)('%s copy button', (_name, copiedText, render) => {
  function mountButton() {
    const { messagesEl, actions } = setup();
    render(actions, messagesEl);
    return within(messagesEl).getByRole('button', { name: 'Copy message' });
  }

  it('shows Copied! after the clipboard write and restores the icon after 1500 ms', async () => {
    const writeText = writeTextReturning(() => Promise.resolve());
    const button = mountButton();
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();

    fireEvent.click(button);
    await jest.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith(copiedText);
    expect(button.textContent).toBe('Copied!');
    expect(button.classList.contains('copied')).toBe(true);

    await jest.advanceTimersByTimeAsync(COPY_FEEDBACK_MS - 1);
    expect(button.textContent).toBe('Copied!');

    await jest.advanceTimersByTimeAsync(1);
    expect(button.textContent).toBe('');
    expect(button.classList.contains('copied')).toBe(false);
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
  });

  it('shows no success feedback and arms no timer when the clipboard write is rejected', async () => {
    const writeText = writeTextReturning(() => Promise.reject(new Error('not allowed')));
    const button = mountButton();

    fireEvent.click(button);
    await jest.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button.textContent).not.toBe('Copied!');
    expect(button.classList.contains('copied')).toBe(false);
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('restarts the feedback window when clicked again before the first one ends', async () => {
    writeTextReturning(() => Promise.resolve());
    const button = mountButton();

    fireEvent.click(button);
    await jest.advanceTimersByTimeAsync(1_000);
    fireEvent.click(button);
    await jest.advanceTimersByTimeAsync(0);

    // The first click's timer would have fired by now had it not been cleared.
    await jest.advanceTimersByTimeAsync(COPY_FEEDBACK_MS - 1_000 + 1);
    expect(button.textContent).toBe('Copied!');
    expect(button.classList.contains('copied')).toBe(true);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(button.classList.contains('copied')).toBe(false);
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
  });

  it('keeps the click from reaching the surrounding message', () => {
    writeTextReturning(() => Promise.resolve());
    const button = mountButton();
    const onMessageClick = jest.fn();
    button.parentElement!.parentElement!.addEventListener('click', onMessageClick);

    fireEvent.click(button);

    expect(onMessageClick).not.toHaveBeenCalled();
  });
});
