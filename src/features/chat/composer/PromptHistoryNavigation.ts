import { getUserDisplayText } from '@/core/prompt/promptContext';
import { type ChatMessage, isCanonicalUserMessage } from '@/core/types';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

interface PromptHistoryNavigationOptions {
  readonly getMessages: () => readonly ChatMessage[];
  readonly input: ComposerInputElement;
  /** Whether the composer currently targets the transcript history is read from. */
  readonly isEnabled: () => boolean;
}

/**
 * Transient navigation over the current conversation's visible canonical user text.
 * A recall stays active only while the composer still shows exactly the recalled text.
 */
export class PromptHistoryNavigation {
  private selected: { id: string; text: string } | null = null;
  private composing = false;

  constructor(private readonly options: PromptHistoryNavigationOptions) {
    options.input.addEventListener('compositionstart', this.onCompositionStart);
    options.input.addEventListener('compositionend', this.onCompositionEnd);
  }

  get isRecalling(): boolean {
    return !this.composing && this.selected !== null && this.options.input.value === this.selected.text
      && this.options.isEnabled();
  }

  /** The recalled transcript is no longer the one the composer targets. */
  reset(): void {
    this.selected = null;
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || this.composing || event.isComposing || event.ctrlKey || event.metaKey
      || event.altKey || event.shiftKey
      || !['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key) || !this.options.isEnabled()) return false;

    const { input } = this.options;
    if (!this.isRecalling) this.reset();
    const prompts = this.options.getMessages().filter(isCanonicalUserMessage)
      .map(message => ({ id: message.id, text: getUserDisplayText(message) }))
      .filter(prompt => prompt.text.length > 0);

    if (!this.selected) {
      if (event.key !== 'ArrowUp' || input.value.length !== 0 || prompts.length === 0) return false;
      this.select(prompts[prompts.length - 1]);
    } else {
      const index = prompts.findIndex(prompt => prompt.id === this.selected!.id && prompt.text === this.selected!.text);
      // A rewind, deletion, or edit must not leave a recalled prompt from an obsolete transcript.
      if (index < 0 || event.key === 'Escape') {
        this.clear();
      } else if (!this.isCaretOnEdgeLine(event.key)) {
        return false;
      } else if (event.key === 'ArrowUp') {
        if (index === 0) return false;
        this.select(prompts[index - 1]);
      } else if (index === prompts.length - 1) {
        this.clear();
      } else {
        this.select(prompts[index + 1]);
      }
    }
    event.preventDefault();
    return true;
  }

  destroy(): void {
    this.options.input.removeEventListener('compositionstart', this.onCompositionStart);
    this.options.input.removeEventListener('compositionend', this.onCompositionEnd);
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.reset();
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
  };

  /** Arrow keys inside recalled text move the caret; only its first/last rendered row navigates. */
  private isCaretOnEdgeLine(key: string): boolean {
    const { input } = this.options;
    const { value, selectionStart, selectionEnd } = input;
    if (selectionStart === null || selectionStart !== selectionEnd) return false;
    // Without layout, logical lines approximate rendered rows.
    return input.isCaretOnEdgeRow?.(key === 'ArrowUp' ? 'up' : 'down') ?? (key === 'ArrowUp'
      ? !value.slice(0, selectionStart).includes('\n')
      : !value.slice(selectionStart).includes('\n'));
  }

  private select(prompt: { id: string; text: string }): void {
    this.selected = prompt;
    this.replaceInput(prompt.text);
  }

  private clear(): void {
    this.reset();
    this.replaceInput('');
  }

  private replaceInput(text: string): void {
    const { input } = this.options;
    if (input.replaceText) input.replaceText(0, input.value.length, text);
    else input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    // Recalled text takes the same input lifecycle as typing.
    input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)('input', { bubbles: true }));
  }
}
