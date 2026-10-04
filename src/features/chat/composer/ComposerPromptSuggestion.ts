import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

interface SuggestionTurn {
  binding: { turnId: string; isCurrent: () => boolean } | null;
  suggestion: { turnId: string; text: string } | null;
}

/** A tab's transient prediction. Composer content hides it; a new owner or turn discards it. */
export class ComposerPromptSuggestion {
  private turn: SuggestionTurn | null = null;
  private composing = false;
  private readonly observer: MutationObserver;

  constructor(
    private readonly input: ComposerInputElement,
    private readonly canDisplay: () => boolean,
    /** Composer region containing the input; any expanded popup control inside it hides the prediction. */
    private readonly container: HTMLElement,
  ) {
    input.addEventListener('input', this.refresh);
    input.addEventListener('compositionstart', this.onCompositionStart);
    input.addEventListener('compositionend', this.onCompositionEnd);
    this.observer = new input.ownerDocument.defaultView!.MutationObserver(this.refresh);
    this.observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
  }

  beginTurn(): void {
    this.discard();
    this.turn = { binding: null, suggestion: null };
  }

  /** Requested rendering and trailing session events can reach the UI in either order. */
  bindTurn(turnId: string, isCurrent: () => boolean): void {
    if (!this.turn || this.turn.binding) return;
    this.turn.binding = { turnId, isCurrent };
    this.refresh();
  }

  receive(turnId: string, text: string): void {
    if (!this.turn || !text.trim()) return;
    if (this.turn.binding && this.turn.binding.turnId !== turnId) return;
    this.turn.suggestion = { turnId, text };
    this.refresh();
  }

  discard(): void {
    this.turn = null;
    this.input.setGhostText?.(null);
  }

  readonly refresh = (): void => {
    if (this.turn?.binding && !this.turn.binding.isCurrent()) this.turn = null;
    this.input.setGhostText?.(this.visibleText);
  };

  handleKeydown(event: KeyboardEvent): boolean {
    this.refresh();
    const text = this.visibleText;
    if (!text || event.isComposing
      || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
      || event.key !== 'Tab') return false;
    event.preventDefault();
    event.stopPropagation();
    this.discard();
    if (this.input.replaceText) this.input.replaceText(0, 0, text);
    else this.input.value = text;
    const EventConstructor = this.input.ownerDocument.defaultView!.Event;
    this.input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    return true;
  }

  destroy(): void {
    this.discard();
    this.observer.disconnect();
    this.input.removeEventListener('input', this.refresh);
    this.input.removeEventListener('compositionstart', this.onCompositionStart);
    this.input.removeEventListener('compositionend', this.onCompositionEnd);
  }

  private get visibleText(): string | null {
    const turn = this.turn;
    return turn?.binding && turn.suggestion?.turnId === turn.binding.turnId
      && !this.composing && this.input.value === ''
      && !this.container.querySelector('[aria-expanded="true"]') && this.canDisplay()
      ? turn.suggestion.text : null;
  }

  private readonly onCompositionStart = (): void => { this.composing = true; this.refresh(); };
  private readonly onCompositionEnd = (): void => { this.composing = false; this.refresh(); };
}
