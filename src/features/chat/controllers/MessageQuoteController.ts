import { setIcon } from 'obsidian';

import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

const MESSAGE_SELECTOR = '.claudian-message';
const BUTTON_GAP_PX = 6;
const EDGE_PADDING_PX = 8;

export interface MessageQuoteControllerOptions {
  messagesEl: HTMLElement;
  label: string;
  onQuote: (text: string) => void;
}

/** Formats selected message text as a Markdown blockquote. */
export function formatSelectionQuote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Appends a quote block to the composer, leaving the caret on a fresh line below it. */
export function appendQuoteToComposer(inputEl: ComposerInputElement, quote: string): void {
  const currentValue = inputEl.value;
  let separator = '';
  if (currentValue.trim()) {
    if (currentValue.endsWith('\n\n')) separator = '';
    else if (currentValue.endsWith('\n')) separator = '\n';
    else separator = '\n\n';
  }
  const insertion = `${separator}${quote}\n\n`;
  if (inputEl.replaceText) inputEl.replaceText(currentValue.length, currentValue.length, insertion);
  else inputEl.value = `${currentValue}${insertion}`;

  const cursorPosition = inputEl.value.length;
  inputEl.selectionStart = cursorPosition;
  inputEl.selectionEnd = cursorPosition;

  const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
  inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  inputEl.focus();
}

/**
 * Shows a floating Quote button over text selected inside chat messages.
 * The button never takes focus, so the selection survives until it is quoted.
 */
export class MessageQuoteController {
  readonly #messagesEl: HTMLElement;
  readonly #label: string;
  readonly #onQuote: (text: string) => void;
  #buttonEl: HTMLButtonElement | null = null;
  #disposed = false;

  readonly #onMouseUp = (): void => {
    this.#showForCurrentSelection();
  };

  readonly #onSelectionChange = (): void => {
    if (this.#buttonEl && !this.#buttonEl.hidden) this.#showForCurrentSelection();
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.#hide();
  };

  readonly #onScroll = (): void => {
    this.#hide();
  };

  constructor(options: MessageQuoteControllerOptions) {
    this.#messagesEl = options.messagesEl;
    this.#label = options.label;
    this.#onQuote = options.onQuote;

    const doc = this.#messagesEl.ownerDocument;
    this.#messagesEl.addEventListener('mouseup', this.#onMouseUp);
    this.#messagesEl.addEventListener('scroll', this.#onScroll, { passive: true });
    doc.addEventListener('selectionchange', this.#onSelectionChange);
    doc.addEventListener('keydown', this.#onKeyDown);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const doc = this.#messagesEl.ownerDocument;
    this.#messagesEl.removeEventListener('mouseup', this.#onMouseUp);
    this.#messagesEl.removeEventListener('scroll', this.#onScroll);
    doc.removeEventListener('selectionchange', this.#onSelectionChange);
    doc.removeEventListener('keydown', this.#onKeyDown);
    this.#buttonEl?.remove();
    this.#buttonEl = null;
  }

  #showForCurrentSelection(): void {
    const range = this.#getMessageSelectionRange();
    if (!range) {
      this.#hide();
      return;
    }
    const hostEl = this.#messagesEl.parentElement;
    if (!hostEl) return;

    const button = this.#ensureButton(hostEl);
    button.hidden = false;
    this.#position(button, hostEl, range);
  }

  #getMessageSelectionRange(): Range | null {
    const selection = this.#messagesEl.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.#isInsideMessage(range.startContainer) || !this.#isInsideMessage(range.endContainer)) {
      return null;
    }
    return selection.toString().trim() ? range : null;
  }

  #isInsideMessage(node: Node): boolean {
    const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const messageEl = el?.closest(MESSAGE_SELECTOR);
    return !!messageEl && this.#messagesEl.contains(messageEl);
  }

  #ensureButton(hostEl: HTMLElement): HTMLButtonElement {
    if (this.#buttonEl?.parentElement === hostEl) return this.#buttonEl;
    this.#buttonEl?.remove();
    const button = hostEl.createEl('button', {
      cls: 'claudian-message-quote-btn',
      attr: { type: 'button' },
    });
    setIcon(button.createSpan({ cls: 'claudian-message-quote-btn-icon' }), 'text-quote');
    button.createSpan({ text: this.#label });
    // Pressing the button must not move focus, which would clear the selection.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#quote();
    });
    this.#buttonEl = button;
    return button;
  }

  #position(button: HTMLButtonElement, hostEl: HTMLElement, range: Range): void {
    const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
    const anchor = rects.at(-1);
    if (!anchor) return;
    const hostRect = hostEl.getBoundingClientRect();
    const buttonWidth = button.offsetWidth;
    const buttonHeight = button.offsetHeight;

    let top = anchor.bottom - hostRect.top + BUTTON_GAP_PX;
    if (top + buttonHeight > hostRect.height - EDGE_PADDING_PX) {
      const first = rects[0];
      top = first.top - hostRect.top - buttonHeight - BUTTON_GAP_PX;
    }
    const maxLeft = Math.max(EDGE_PADDING_PX, hostRect.width - buttonWidth - EDGE_PADDING_PX);
    const left = Math.min(Math.max(anchor.right - hostRect.left - buttonWidth / 2, EDGE_PADDING_PX), maxLeft);

    button.style.setProperty('--claudian-quote-btn-top', `${Math.round(Math.max(top, EDGE_PADDING_PX))}px`);
    button.style.setProperty('--claudian-quote-btn-left', `${Math.round(left)}px`);
  }

  #quote(): void {
    const selection = this.#messagesEl.ownerDocument.getSelection();
    // Revalidate after selection changes or re-renders; Selection preserves rendered line breaks.
    const text = this.#getMessageSelectionRange() ? selection!.toString() : '';
    selection?.removeAllRanges();
    this.#hide();
    if (text) this.#onQuote(text);
  }

  #hide(): void {
    if (this.#buttonEl) this.#buttonEl.hidden = true;
  }
}
