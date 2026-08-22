export class PromptSuggestionController {
  private readonly defaultPlaceholder: string;
  private suggestion: string | null = null;
  private revisionValue = 0;

  constructor(private readonly inputEl: HTMLTextAreaElement) {
    this.defaultPlaceholder = inputEl.placeholder
      || inputEl.getAttribute('placeholder')
      || '';
  }

  get isVisible(): boolean {
    return this.suggestion !== null;
  }

  get revision(): number {
    return this.revisionValue;
  }

  show(rawSuggestion: string): boolean {
    const suggestion = rawSuggestion.trim();
    if (!suggestion || this.inputEl.value.length > 0) return false;

    this.suggestion = suggestion;
    this.inputEl.placeholder = suggestion;
    return true;
  }

  handleKeydown(event: KeyboardEvent): boolean {
    const suggestion = this.suggestion;
    if (
      !suggestion
      || this.inputEl.value.length > 0
      || event.isComposing
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || (event.key !== 'Tab' && event.key !== 'ArrowRight')
    ) {
      return false;
    }

    event.preventDefault();
    this.inputEl.value = suggestion;
    this.clear();
    this.inputEl.setSelectionRange?.(suggestion.length, suggestion.length);
    this.inputEl.focus?.();
    const EventConstructor = this.inputEl.ownerDocument?.defaultView?.Event ?? Event;
    this.inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    return true;
  }

  handleInputChange(): void {
    this.clear();
  }

  clear(): void {
    this.revisionValue += 1;
    const suggestion = this.suggestion;
    this.suggestion = null;
    if (suggestion !== null && this.inputEl.placeholder === suggestion) {
      this.inputEl.placeholder = this.defaultPlaceholder;
    }
  }

  destroy(): void {
    this.clear();
  }
}
