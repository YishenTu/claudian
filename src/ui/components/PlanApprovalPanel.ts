/**
 * PlanApproval panel component.
 *
 * Replaces the input area to show approval options.
 * Option 3 (revise) always shows an inline input styled as placeholder.
 */

import type { App, Component } from 'obsidian';

/** Options for creating the panel. */
export interface PlanApprovalPanelOptions {
  /** Container element (the main claudian view container). */
  containerEl: HTMLElement;
  /** The plan content to display. */
  planContent: string;
  /** Path to the plan file. */
  planFilePath?: string;
  /** Component for MarkdownRenderer lifecycle. */
  component: Component;
  /** Callback when user approves. */
  onApprove: () => void;
  /** Callback when user approves with new session. */
  onApproveNewSession: () => void;
  /** Callback when user wants to revise (with feedback). */
  onRevise: (feedback: string) => void;
  /** Callback when user cancels (Esc). */
  onCancel: () => void;
}

/** Find the input container and wrapper elements. */
function findInputElements(containerEl: HTMLElement): {
  inputContainer: HTMLElement | null;
  inputWrapper: HTMLElement | null;
} {
  const inputContainer = containerEl.querySelector('.claudian-input-container') as HTMLElement | null;
  const inputWrapper = containerEl.querySelector('.claudian-input-wrapper') as HTMLElement | null;
  return { inputContainer, inputWrapper };
}

/** Option definitions for the approval panel. */
const APPROVAL_OPTIONS = [
  { label: 'Approve', isRevise: false },
  { label: 'Approve && New Session', isRevise: false },
  { label: 'Type here to tell Claudian what to change', isRevise: true },
] as const;

/**
 * PlanApproval panel - shows option rows for approval (plan content shown in chat).
 */
export class PlanApprovalPanel {
  private containerEl: HTMLElement;
  private panelEl: HTMLElement;
  private onApprove: () => void;
  private onApproveNewSession: () => void;
  private onRevise: (feedback: string) => void;
  private onCancel: () => void;
  private isDestroyed = false;
  private reviseInputEl: HTMLInputElement | null = null;
  private currentOptionIndex = 0;
  private optionsEl: HTMLElement | null = null;

  // Input area references (for hiding/showing)
  private inputContainer: HTMLElement | null = null;
  private inputWrapper: HTMLElement | null = null;
  private thinkingEl: HTMLElement | null = null;

  constructor(_app: App, options: PlanApprovalPanelOptions) {
    this.containerEl = options.containerEl;
    this.onApprove = options.onApprove;
    this.onApproveNewSession = options.onApproveNewSession;
    this.onRevise = options.onRevise;
    this.onCancel = options.onCancel;

    // Find and hide the input area
    const { inputContainer, inputWrapper } = findInputElements(this.containerEl);
    this.inputContainer = inputContainer;
    this.inputWrapper = inputWrapper;

    if (this.inputWrapper) {
      this.inputWrapper.style.display = 'none';
    }

    // Hide thinking indicator (flavor text)
    this.thinkingEl = this.containerEl.querySelector('.claudian-thinking') as HTMLElement | null;
    if (this.thinkingEl) {
      this.thinkingEl.style.display = 'none';
    }

    // Create panel and insert it where the input wrapper was
    this.panelEl = this.createPanel();
    if (this.inputContainer) {
      this.inputContainer.appendChild(this.panelEl);
    } else {
      this.containerEl.appendChild(this.panelEl);
    }

    // Focus the panel
    this.panelEl.focus();
  }

  /** Create the panel DOM structure. */
  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'claudian-plan-approval-panel';
    panel.setAttribute('tabindex', '0');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Review implementation plan');

    // Add keyboard listener
    panel.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Header: "Would you like to proceed?"
    const headerEl = document.createElement('div');
    headerEl.className = 'claudian-plan-approval-header';
    headerEl.textContent = 'Would you like to proceed?';
    panel.appendChild(headerEl);

    // Options container
    this.optionsEl = document.createElement('div');
    this.optionsEl.className = 'claudian-plan-approval-options';
    this.renderOptions();
    panel.appendChild(this.optionsEl);

    return panel;
  }

  /** Render the option rows. */
  private renderOptions(): void {
    if (!this.optionsEl) return;
    this.optionsEl.innerHTML = '';

    APPROVAL_OPTIONS.forEach((option, index) => {
      const optionEl = document.createElement('div');
      optionEl.className = 'claudian-plan-approval-option';
      optionEl.setAttribute('data-option-index', String(index));

      // Caret indicator
      const caretEl = document.createElement('span');
      caretEl.className = 'claudian-plan-approval-caret';
      caretEl.textContent = index === this.currentOptionIndex ? '>' : ' ';
      optionEl.appendChild(caretEl);

      // Number indicator
      const numberEl = document.createElement('span');
      numberEl.className = 'claudian-plan-approval-number';
      numberEl.textContent = `${index + 1}.`;
      optionEl.appendChild(numberEl);

      // For option 3 (revise), always show input (styled as placeholder when empty)
      if (option.isRevise) {
        this.reviseInputEl = document.createElement('input');
        this.reviseInputEl.type = 'text';
        this.reviseInputEl.className = 'claudian-plan-approval-revise-inline';
        this.reviseInputEl.placeholder = option.label;
        // Prevent click from bubbling to option click handler
        this.reviseInputEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.currentOptionIndex = index;
          this.updateOptionFocus();
        });
        this.reviseInputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.handleReviseSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // If input has content, clear it; otherwise cancel
            if (this.reviseInputEl?.value) {
              this.reviseInputEl.value = '';
            } else {
              this.handleCancel();
            }
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            // Navigate to previous option
            this.currentOptionIndex = Math.max(0, this.currentOptionIndex - 1);
            this.updateOptionFocus();
            this.panelEl.focus();
          }
          e.stopPropagation();
        });
        // Focus input when it receives input (for auto-focus on navigate)
        this.reviseInputEl.addEventListener('focus', () => {
          this.currentOptionIndex = index;
          this.updateOptionFocus();
        });
        optionEl.appendChild(this.reviseInputEl);
      } else {
        // Regular label
        const labelEl = document.createElement('span');
        labelEl.className = 'claudian-plan-approval-option-label';
        labelEl.textContent = option.label;
        optionEl.appendChild(labelEl);
      }

      // Click handler
      optionEl.addEventListener('click', () => {
        this.currentOptionIndex = index;
        this.updateOptionFocus();
        if (!option.isRevise) {
          this.selectCurrentOption();
        } else {
          // Focus the input for revise option
          this.reviseInputEl?.focus();
        }
      });

      // Hover handler
      optionEl.addEventListener('mouseenter', () => {
        this.currentOptionIndex = index;
        this.updateOptionFocus();
      });

      if (index === this.currentOptionIndex) {
        optionEl.classList.add('focused');
      }

      this.optionsEl!.appendChild(optionEl);
    });
  }

  /** Update the visual focus indicator on options. */
  private updateOptionFocus(): void {
    if (!this.optionsEl) return;

    const options = this.optionsEl.querySelectorAll('.claudian-plan-approval-option');
    options.forEach((opt, i) => {
      const caret = opt.querySelector('.claudian-plan-approval-caret');
      const isFocused = i === this.currentOptionIndex;
      opt.classList.toggle('focused', isFocused);
      if (caret) {
        caret.textContent = isFocused ? '>' : ' ';
      }
    });

    if (this.currentOptionIndex !== 2 && this.reviseInputEl && document.activeElement === this.reviseInputEl) {
      this.reviseInputEl.blur();
      this.panelEl.focus();
    }

    // Auto-focus input when option 3 is selected
    if (this.currentOptionIndex === 2 && this.reviseInputEl) {
      this.reviseInputEl.focus();
    }
  }

  /** Select the currently focused option. */
  private selectCurrentOption(): void {
    switch (this.currentOptionIndex) {
      case 0:
        this.handleApprove();
        break;
      case 1:
        this.handleApproveNewSession();
        break;
      case 2:
        // For revise, just focus the input (user types directly)
        this.reviseInputEl?.focus();
        break;
    }
  }

  /** Handle keyboard events. */
  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isDestroyed) return;

    // If input is focused, let it handle its own keys (except navigation)
    if (document.activeElement === this.reviseInputEl) {
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.currentOptionIndex = Math.max(0, this.currentOptionIndex - 1);
        this.updateOptionFocus();
        break;

      case 'ArrowDown':
        e.preventDefault();
        this.currentOptionIndex = Math.min(APPROVAL_OPTIONS.length - 1, this.currentOptionIndex + 1);
        this.updateOptionFocus();
        break;

      case 'Enter':
        e.preventDefault();
        this.selectCurrentOption();
        break;

      case 'Escape':
        e.preventDefault();
        this.handleCancel();
        break;

      case '1':
        e.preventDefault();
        this.currentOptionIndex = 0;
        this.updateOptionFocus();
        this.selectCurrentOption();
        break;

      case '2':
        e.preventDefault();
        this.currentOptionIndex = 1;
        this.updateOptionFocus();
        this.selectCurrentOption();
        break;

      case '3':
        e.preventDefault();
        this.currentOptionIndex = 2;
        this.updateOptionFocus();
        // Focus input for typing
        this.reviseInputEl?.focus();
        break;

      default:
        // If on revise option and user types a printable character,
        // focus input and let it receive the character
        if (this.currentOptionIndex === 2 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (this.reviseInputEl) {
            this.reviseInputEl.focus();
            this.reviseInputEl.value = e.key;
            // Position cursor at end
            this.reviseInputEl.setSelectionRange(1, 1);
          }
        }
        break;
    }
  }

  /** Handle approve action. */
  private handleApprove(): void {
    if (this.isDestroyed) return;
    this.destroy();
    this.onApprove();
  }

  /** Handle approve with new session action. */
  private handleApproveNewSession(): void {
    if (this.isDestroyed) return;
    this.destroy();
    this.onApproveNewSession();
  }

  /** Handle cancel action (Esc). */
  private handleCancel(): void {
    if (this.isDestroyed) return;
    this.destroy();
    this.onCancel();
  }

  /** Handle revise submission. */
  private handleReviseSubmit(): void {
    if (this.isDestroyed) return;
    const feedback = this.reviseInputEl?.value.trim() || 'Please revise the plan.';
    this.destroy();
    this.onRevise(feedback);
  }

  /** Destroy the panel and restore input area. */
  private destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Remove panel
    this.panelEl.remove();

    // Restore input wrapper visibility
    if (this.inputWrapper) {
      this.inputWrapper.style.display = '';
    }

    // Restore thinking indicator visibility (if still present)
    if (this.thinkingEl) {
      this.thinkingEl.style.display = '';
    }
  }
}

/**
 * Show the plan approval panel.
 * Returns a promise that resolves with the user's decision.
 */
export function showPlanApprovalPanel(
  app: App,
  containerEl: HTMLElement,
  planContent: string,
  component: Component
): Promise<
  | { decision: 'approve' | 'approve_new_session' | 'cancel' }
  | { decision: 'revise'; feedback: string }
> {
  return new Promise((resolve) => {
    new PlanApprovalPanel(app, {
      containerEl,
      planContent,
      component,
      onApprove: () => resolve({ decision: 'approve' }),
      onApproveNewSession: () => resolve({ decision: 'approve_new_session' }),
      onRevise: (feedback) => resolve({ decision: 'revise', feedback }),
      onCancel: () => resolve({ decision: 'cancel' }),
    });
  });
}
