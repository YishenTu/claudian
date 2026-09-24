/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import {
  appendQuoteToComposer,
  formatSelectionQuote,
  MessageQuoteController,
} from '@/features/chat/controllers/MessageQuoteController';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

function createMessages(): { wrapperEl: HTMLElement; messagesEl: HTMLElement; assistantText: Text; userText: Text } {
  const wrapperEl = document.createElement('div');
  wrapperEl.className = 'claudian-messages-wrapper';
  const messagesEl = document.createElement('div');
  messagesEl.className = 'claudian-messages';
  wrapperEl.appendChild(messagesEl);

  const userEl = document.createElement('div');
  userEl.className = 'claudian-message claudian-message-user';
  const userText = document.createTextNode('What should I refactor first?');
  userEl.appendChild(userText);

  const assistantEl = document.createElement('div');
  assistantEl.className = 'claudian-message claudian-message-assistant';
  const assistantText = document.createTextNode('Start with the renderer.\nThen split the controller.');
  assistantEl.appendChild(assistantText);

  const welcomeEl = document.createElement('div');
  welcomeEl.className = 'claudian-welcome';
  welcomeEl.textContent = 'Welcome';

  messagesEl.append(welcomeEl, userEl, assistantEl);
  document.body.appendChild(wrapperEl);
  return { wrapperEl, messagesEl, assistantText, userText };
}

function select(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function releaseMouse(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

function getQuoteButton(wrapperEl: HTMLElement): HTMLButtonElement | null {
  return within(wrapperEl).queryByRole<HTMLButtonElement>('button', { name: 'Quote' });
}

describe('MessageQuoteController', () => {
  let controller: MessageQuoteController;
  let onQuote: jest.Mock;
  let dom: ReturnType<typeof createMessages>;

  beforeEach(() => {
    dom = createMessages();
    onQuote = jest.fn();
    controller = new MessageQuoteController({ messagesEl: dom.messagesEl, label: 'Quote', onQuote });
  });

  afterEach(() => {
    controller.dispose();
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it('shows an accessible Quote button after selecting text in an assistant message', async () => {
    expect(getQuoteButton(dom.wrapperEl)).toBeNull();

    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);

    const button = getQuoteButton(dom.wrapperEl);
    expect(button).not.toBeNull();
    expect(button!.type).toBe('button');
    expect(await axe(dom.wrapperEl)).toHaveNoViolations();
  });

  it('shows the button for selections in user messages too', () => {
    select(dom.userText, 0, 4);
    releaseMouse(dom.userText.parentElement!);

    expect(getQuoteButton(dom.wrapperEl)).not.toBeNull();
  });

  it('ignores selections outside messages', () => {
    const welcomeText = dom.messagesEl.querySelector('.claudian-welcome')!.firstChild!;
    select(welcomeText, 0, 7);
    releaseMouse(dom.messagesEl);

    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
  });

  it('ignores a collapsed selection', () => {
    select(dom.assistantText, 3, 3);
    releaseMouse(dom.assistantText.parentElement!);

    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
  });

  it('keeps the selection when the button is pressed', () => {
    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    getQuoteButton(dom.wrapperEl)!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('quotes the selected text and hides the button on click', () => {
    select(dom.assistantText, 0, dom.assistantText.length);
    releaseMouse(dom.assistantText.parentElement!);

    getQuoteButton(dom.wrapperEl)!.click();

    expect(onQuote).toHaveBeenCalledWith('Start with the renderer.\nThen split the controller.');
    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
    expect(document.getSelection()!.isCollapsed).toBe(true);
  });

  it('hides when the selection collapses', () => {
    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);

    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));

    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
  });

  it('hides on Escape and on scroll', () => {
    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(getQuoteButton(dom.wrapperEl)).toBeNull();

    releaseMouse(dom.assistantText.parentElement!);
    expect(getQuoteButton(dom.wrapperEl)).not.toBeNull();
    dom.messagesEl.dispatchEvent(new Event('scroll'));
    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
  });

  it('does not quote a selection whose message was re-rendered away', () => {
    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);
    const button = getQuoteButton(dom.wrapperEl)!;

    dom.assistantText.parentElement!.remove();
    button.click();

    expect(onQuote).not.toHaveBeenCalled();
    expect(getQuoteButton(dom.wrapperEl)).toBeNull();
  });

  it('removes the button and stops listening on dispose', () => {
    select(dom.assistantText, 0, 24);
    releaseMouse(dom.assistantText.parentElement!);

    controller.dispose();
    expect(dom.wrapperEl.querySelector('.claudian-message-quote-btn')).toBeNull();

    releaseMouse(dom.assistantText.parentElement!);
    expect(dom.wrapperEl.querySelector('.claudian-message-quote-btn')).toBeNull();
  });
});

describe('formatSelectionQuote', () => {
  it('prefixes every line and keeps blank lines inside the quote', () => {
    expect(formatSelectionQuote('  first line  \r\n\r\nsecond line\n')).toBe('> first line\n>\n> second line');
  });
});

describe('appendQuoteToComposer', () => {
  function createInput(value: string): ComposerInputElement {
    const inputEl = document.createElement('textarea') as unknown as ComposerInputElement;
    inputEl.value = value;
    document.body.appendChild(inputEl);
    return inputEl;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('inserts the quote into an empty composer and leaves the caret below it', () => {
    const inputEl = createInput('');
    const onInput = jest.fn();
    inputEl.addEventListener('input', onInput);

    appendQuoteToComposer(inputEl, '> quoted');

    expect(inputEl.value).toBe('> quoted\n\n');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(inputEl);
  });

  it('separates the quote from an existing draft with a blank line', () => {
    const inputEl = createInput('My draft');

    appendQuoteToComposer(inputEl, '> quoted');

    expect(inputEl.value).toBe('My draft\n\n> quoted\n\n');
  });

  it('uses the rich editor replaceText when available', () => {
    const inputEl = createInput('Draft\n');
    const replaceText = jest.fn((from: number, to: number, text: string) => {
      inputEl.value = inputEl.value.slice(0, from) + text + inputEl.value.slice(to);
    });
    inputEl.replaceText = replaceText;

    appendQuoteToComposer(inputEl, '> quoted');

    expect(replaceText).toHaveBeenCalledWith(6, 6, '\n> quoted\n\n');
    expect(inputEl.value).toBe('Draft\n\n> quoted\n\n');
  });
});
