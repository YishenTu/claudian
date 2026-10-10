import { extractUserDisplayContent } from '@/core/prompt/promptContext';
import { type ChatMessage, isCanonicalUserMessage } from '@/core/types';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

interface PromptHistoryNavigationOptions {
  readonly getMessages: () => readonly ChatMessage[];
  readonly input: ComposerInputElement;
  readonly onInputReplaced: () => void;
}

/** Transient navigation over the current conversation's visible canonical user text. */
export class PromptHistoryNavigation {
  private selected: { id: string; text: string } | null = null;
  private draft = '';
  private composing = false;

  constructor(private readonly options: PromptHistoryNavigationOptions) {}

  get canRestoreDraft(): boolean {
    return !this.composing && this.selected !== null && this.options.input.value === this.selected.text;
  }

  reset(): void {
    this.selected = null;
    this.draft = '';
  }

  handleCompositionStart(): void {
    this.composing = true;
    this.reset();
  }

  handleCompositionEnd(): void {
    this.composing = false;
    this.reset();
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || this.composing || event.isComposing || event.ctrlKey || event.metaKey
      || event.altKey || event.shiftKey
      || !['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return false;

    const { input } = this.options;
    if (this.selected && input.value !== this.selected.text) this.reset();
    const prompts = this.options.getMessages().filter(isCanonicalUserMessage)
      .map(message => ({
        id: message.id,
        text: message.displayContent ?? extractUserDisplayContent(message.content) ?? message.content,
      }))
      .filter(prompt => prompt.text.length > 0);

    if (!this.selected) {
      if (event.key !== 'ArrowUp' || input.value.length !== 0
        || input.selectionStart !== 0 || input.selectionEnd !== 0 || prompts.length === 0) return false;
      this.draft = input.value;
      this.select(prompts[prompts.length - 1]);
    } else {
      const index = prompts.findIndex(prompt => prompt.id === this.selected!.id && prompt.text === this.selected!.text);
      // A rewind, deletion, or edit must not leave a recalled prompt from an obsolete transcript.
      if (index < 0 || event.key === 'Escape' || (event.key === 'ArrowDown' && index === prompts.length - 1)) {
        this.restoreDraft();
      } else if (event.key === 'ArrowUp') {
        if (index === 0) return false;
        this.select(prompts[index - 1]);
      } else {
        this.select(prompts[index + 1]);
      }
    }
    event.preventDefault();
    return true;
  }

  private select(prompt: { id: string; text: string }): void {
    this.selected = prompt;
    this.replaceInput(prompt.text);
  }

  private restoreDraft(): void {
    const text = this.draft;
    this.reset();
    this.replaceInput(text);
  }

  private replaceInput(text: string): void {
    const { input } = this.options;
    if (input.replaceText) input.replaceText(0, input.value.length, text);
    else input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    this.options.onInputReplaced();
  }
}
