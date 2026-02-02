import { t } from '../../../i18n';

export interface BangBashModeCallbacks {
  onSubmit: (command: string) => Promise<void>;
  getInputWrapper: () => HTMLElement | null;
  resetInputHeight?: () => void;
}

export interface BangBashModeState {
  active: boolean;
  rawCommand: string;
}

export class BangBashModeManager {
  private inputEl: HTMLTextAreaElement;
  private callbacks: BangBashModeCallbacks;
  private state: BangBashModeState = { active: false, rawCommand: '' };
  private isSubmitting = false;
  private originalPlaceholder: string = '';

  constructor(
    inputEl: HTMLTextAreaElement,
    callbacks: BangBashModeCallbacks
  ) {
    this.inputEl = inputEl;
    this.callbacks = callbacks;
    this.originalPlaceholder = inputEl.placeholder;
  }

  handleTriggerKey(e: KeyboardEvent): boolean {
    if (!this.state.active && this.inputEl.value === '' && e.key === '!') {
      if (this.enterMode()) {
        e.preventDefault();
        return true;
      }
    }
    return false;
  }

  handleInputChange(): void {
    if (!this.state.active) return;
    this.state.rawCommand = this.inputEl.value;
  }

  private enterMode(): boolean {
    const wrapper = this.callbacks.getInputWrapper();
    if (!wrapper) return false;

    wrapper.addClass('claudian-input-bang-bash-mode');
    this.state = { active: true, rawCommand: '' };
    this.inputEl.placeholder = t('chat.bangBash.placeholder');
    return true;
  }

  private exitMode(): void {
    const wrapper = this.callbacks.getInputWrapper();
    if (wrapper) {
      wrapper.removeClass('claudian-input-bang-bash-mode');
    }
    this.state = { active: false, rawCommand: '' };
    this.inputEl.placeholder = this.originalPlaceholder;
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.state.active) return false;

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (this.state.rawCommand.trim()) {
        this.submit();
      }
      return true;
    }

    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.cancel();
      return true;
    }

    return false;
  }

  isActive(): boolean {
    return this.state.active;
  }

  getRawCommand(): string {
    return this.state.rawCommand;
  }

  private async submit(): Promise<void> {
    if (this.isSubmitting) return;

    const rawCommand = this.state.rawCommand.trim();
    if (!rawCommand) return;

    this.isSubmitting = true;

    try {
      this.clear();
      await this.callbacks.onSubmit(rawCommand);
    } finally {
      this.isSubmitting = false;
    }
  }

  private cancel(): void {
    this.clear();
  }

  clear(): void {
    this.inputEl.value = '';
    this.exitMode();
    this.callbacks.resetInputHeight?.();
  }

  destroy(): void {
    const wrapper = this.callbacks.getInputWrapper();
    if (wrapper) {
      wrapper.removeClass('claudian-input-bang-bash-mode');
    }
    this.inputEl.placeholder = this.originalPlaceholder;
  }
}
