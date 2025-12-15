/**
 * Claudian - Instruction mode manager
 *
 * Detects `#` at start of input to enable instruction mode.
 * Shows visual indicator (light blue border) and custom placeholder when active.
 */

/** Callbacks for instruction mode interactions. */
export interface InstructionModeCallbacks {
  onSubmit: (rawInstruction: string) => Promise<void>;
  getInputWrapper: () => HTMLElement | null;
}

/** State for instruction mode. */
export interface InstructionModeState {
  active: boolean;
  rawInstruction: string;
}

const INSTRUCTION_MODE_PLACEHOLDER = '# Save in custom system prompt';

/** Manages instruction mode detection and visual indicator. */
export class InstructionModeManager {
  private inputEl: HTMLTextAreaElement;
  private callbacks: InstructionModeCallbacks;
  private state: InstructionModeState = { active: false, rawInstruction: '' };
  private isSubmitting = false;
  private originalPlaceholder: string = '';

  constructor(
    inputEl: HTMLTextAreaElement,
    callbacks: InstructionModeCallbacks
  ) {
    this.inputEl = inputEl;
    this.callbacks = callbacks;
    this.originalPlaceholder = inputEl.placeholder;
  }

  /** Handles input changes to detect # trigger. */
  handleInputChange(): void {
    const text = this.inputEl.value;

    if (this.state.active) {
      // Already in instruction mode - track the instruction text
      // Exit if input is cleared completely
      if (text === '') {
        this.exitMode();
      } else {
        this.state.rawInstruction = text;
      }
    } else {
      // Not in instruction mode - check for # trigger
      // Detect # at start (with or without space after)
      if (text === '#' || text.startsWith('# ')) {
        this.enterMode(text.startsWith('# ') ? text.substring(2) : '');
      }
    }
  }

  /** Enters instruction mode, removing # from input. */
  private enterMode(initialText: string = ''): void {
    this.state = { active: true, rawInstruction: initialText };
    this.inputEl.value = initialText;
    this.inputEl.placeholder = INSTRUCTION_MODE_PLACEHOLDER;
    this.updateIndicator();
  }

  /** Exits instruction mode, restoring original state. */
  private exitMode(): void {
    this.state = { active: false, rawInstruction: '' };
    this.inputEl.placeholder = this.originalPlaceholder;
    this.updateIndicator();
  }

  /** Handles keydown events. Returns true if handled. */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.state.active) return false;

    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't handle if instruction is empty
      if (!this.state.rawInstruction.trim()) {
        return false;
      }

      e.preventDefault();
      this.submit();
      return true;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
      return true;
    }

    return false;
  }

  /** Checks if instruction mode is active. */
  isActive(): boolean {
    return this.state.active;
  }

  /** Gets the current raw instruction text. */
  getRawInstruction(): string {
    return this.state.rawInstruction;
  }

  /** Submits the instruction for refinement. */
  private async submit(): Promise<void> {
    if (this.isSubmitting) return;

    const rawInstruction = this.state.rawInstruction.trim();
    if (!rawInstruction) return;

    this.isSubmitting = true;

    try {
      await this.callbacks.onSubmit(rawInstruction);
    } finally {
      this.isSubmitting = false;
    }
  }

  /** Cancels instruction mode and clears input. */
  private cancel(): void {
    this.inputEl.value = '';
    this.exitMode();
  }

  /** Clears the input and resets state (called after successful submission). */
  clear(): void {
    this.inputEl.value = '';
    this.exitMode();
  }

  /** Updates the visual indicator (light blue border). */
  private updateIndicator(): void {
    const wrapper = this.callbacks.getInputWrapper();
    if (!wrapper) return;

    if (this.state.active) {
      wrapper.addClass('claudian-input-instruction-mode');
    } else {
      wrapper.removeClass('claudian-input-instruction-mode');
    }
  }

  /** Cleans up event listeners. */
  destroy(): void {
    // Remove indicator class and restore placeholder on destroy
    const wrapper = this.callbacks.getInputWrapper();
    if (wrapper) {
      wrapper.removeClass('claudian-input-instruction-mode');
    }
    this.inputEl.placeholder = this.originalPlaceholder;
  }
}
