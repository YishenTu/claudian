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
  resetInputHeight?: () => void;
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

  /**
   * Handles keydown to detect # trigger.
   * Returns true if the event was consumed (should prevent default).
   */
  handleTriggerKey(e: KeyboardEvent): boolean {
    // Only trigger on # keystroke when input is empty and not already in mode
    if (!this.state.active && this.inputEl.value === '' && e.key === '#') {
      if (this.enterMode()) {
        e.preventDefault();
        return true;
      }
    }
    return false;
  }

  /** Handles input changes to track instruction text. */
  handleInputChange(): void {
    if (!this.state.active) return;

    const text = this.inputEl.value;
    if (text === '') {
      this.exitMode();
    } else {
      this.state.rawInstruction = text;
    }
  }

  /**
   * Enters instruction mode.
   * Only enters if the indicator can be successfully shown.
   * Returns true if mode was entered, false otherwise.
   */
  private enterMode(): boolean {
    // Indicator is single source of truth - only enter mode if we can show it
    const wrapper = this.callbacks.getInputWrapper();
    if (!wrapper) return false;

    wrapper.addClass('claudian-input-instruction-mode');
    this.state = { active: true, rawInstruction: '' };
    this.inputEl.placeholder = INSTRUCTION_MODE_PLACEHOLDER;
    return true;
  }

  /** Exits instruction mode, restoring original state. */
  private exitMode(): void {
    const wrapper = this.callbacks.getInputWrapper();
    if (wrapper) {
      wrapper.removeClass('claudian-input-instruction-mode');
    }
    this.state = { active: false, rawInstruction: '' };
    this.inputEl.placeholder = this.originalPlaceholder;
  }

  /** Handles keydown events. Returns true if handled. */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.state.active) return false;

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      // Don't handle if instruction is empty
      if (!this.state.rawInstruction.trim()) {
        return false;
      }

      e.preventDefault();
      this.submit();
      return true;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Escape' && !e.isComposing) {
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
    this.callbacks.resetInputHeight?.();
  }

  /** Clears the input and resets state (called after successful submission). */
  clear(): void {
    this.inputEl.value = '';
    this.exitMode();
    this.callbacks.resetInputHeight?.();
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
