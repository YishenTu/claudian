/**
 * Claudian - Instruction modal
 *
 * Unified modal that handles all instruction mode states:
 * - Loading (initial processing)
 * - Clarification (agent asks question)
 * - Confirmation (final instruction review)
 */

import type { App } from 'obsidian';
import { Modal, TextAreaComponent } from 'obsidian';

export type InstructionDecision = 'accept' | 'reject';

/** Modal state. */
type ModalState = 'loading' | 'clarification' | 'confirmation';

/** Callbacks for the instruction modal. */
export interface InstructionModalCallbacks {
  onAccept: (finalInstruction: string) => void;
  onReject: () => void;
  onClarificationSubmit: (response: string) => Promise<void>;
}

/** Unified modal for instruction mode. */
export class InstructionModal extends Modal {
  private rawInstruction: string;
  private callbacks: InstructionModalCallbacks;
  private state: ModalState = 'loading';
  private resolved = false;

  // UI elements
  private contentSectionEl: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private clarificationEl: HTMLElement | null = null;
  private confirmationEl: HTMLElement | null = null;
  private buttonsEl: HTMLElement | null = null;

  // Clarification state
  private clarificationTextEl: HTMLElement | null = null;
  private responseTextarea: TextAreaComponent | null = null;
  private isSubmitting = false;

  // Confirmation state
  private refinedInstruction: string = '';
  private editTextarea: TextAreaComponent | null = null;
  private isEditing = false;
  private refinedDisplayEl: HTMLElement | null = null;
  private editContainerEl: HTMLElement | null = null;
  private editBtnEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    rawInstruction: string,
    callbacks: InstructionModalCallbacks
  ) {
    super(app);
    this.rawInstruction = rawInstruction;
    this.callbacks = callbacks;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('claudian-instruction-modal');
    this.setTitle('Add Custom Instruction');

    // User input section (always visible)
    const inputSection = contentEl.createDiv({ cls: 'claudian-instruction-section' });
    const inputLabel = inputSection.createDiv({ cls: 'claudian-instruction-label' });
    inputLabel.setText('Your input:');
    const inputText = inputSection.createDiv({ cls: 'claudian-instruction-original' });
    inputText.setText(this.rawInstruction);

    // Main content section (changes based on state)
    this.contentSectionEl = contentEl.createDiv({ cls: 'claudian-instruction-content-section' });

    // Loading state
    this.loadingEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-loading' });
    this.loadingEl.createDiv({ cls: 'claudian-instruction-spinner' });
    this.loadingEl.createSpan({ text: 'Processing your instruction...' });

    // Clarification state (hidden initially)
    this.clarificationEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-clarification-section' });
    this.clarificationEl.style.display = 'none';
    this.clarificationTextEl = this.clarificationEl.createDiv({ cls: 'claudian-instruction-clarification' });

    const responseSection = this.clarificationEl.createDiv({ cls: 'claudian-instruction-section' });
    const responseLabel = responseSection.createDiv({ cls: 'claudian-instruction-label' });
    responseLabel.setText('Your response:');

    this.responseTextarea = new TextAreaComponent(responseSection);
    this.responseTextarea.inputEl.addClass('claudian-instruction-response-textarea');
    this.responseTextarea.inputEl.rows = 3;
    this.responseTextarea.inputEl.placeholder = 'Provide more details...';

    this.responseTextarea.inputEl.addEventListener('keydown', (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.isSubmitting) {
        e.preventDefault();
        this.submitClarification();
      }
    });

    // Confirmation state (hidden initially)
    this.confirmationEl = this.contentSectionEl.createDiv({ cls: 'claudian-instruction-confirmation-section' });
    this.confirmationEl.style.display = 'none';

    // Refined instruction display/edit
    const refinedSection = this.confirmationEl.createDiv({ cls: 'claudian-instruction-section' });
    const refinedLabel = refinedSection.createDiv({ cls: 'claudian-instruction-label' });
    refinedLabel.setText('Refined snippet:');

    this.refinedDisplayEl = refinedSection.createDiv({ cls: 'claudian-instruction-refined' });
    this.editContainerEl = refinedSection.createDiv({ cls: 'claudian-instruction-edit-container' });
    this.editContainerEl.style.display = 'none';

    this.editTextarea = new TextAreaComponent(this.editContainerEl);
    this.editTextarea.inputEl.addClass('claudian-instruction-edit-textarea');
    this.editTextarea.inputEl.rows = 4;

    // Buttons (changes based on state)
    this.buttonsEl = contentEl.createDiv({ cls: 'claudian-instruction-buttons' });
    this.updateButtons();

    // Start in loading state
    this.showState('loading');
  }

  /** Shows clarification question from agent. */
  showClarification(clarification: string) {
    if (this.clarificationTextEl) {
      this.clarificationTextEl.setText(clarification);
    }
    if (this.responseTextarea) {
      this.responseTextarea.setValue('');
    }
    this.isSubmitting = false;
    this.showState('clarification');
    this.responseTextarea?.inputEl.focus();
  }

  /** Shows confirmation with refined instruction. */
  showConfirmation(refinedInstruction: string) {
    this.refinedInstruction = refinedInstruction;

    if (this.refinedDisplayEl) {
      this.refinedDisplayEl.setText(refinedInstruction);
    }
    if (this.editTextarea) {
      this.editTextarea.setValue(refinedInstruction);
    }

    this.showState('confirmation');
  }

  /** Shows error and closes modal. */
  showError(error: string) {
    // Just close - the error notice will be shown by caller
    this.resolved = true;
    this.close();
  }

  /** Updates the modal to show loading state during clarification submit. */
  showClarificationLoading() {
    this.isSubmitting = true;
    if (this.loadingEl) {
      this.loadingEl.querySelector('.claudian-instruction-spinner');
      const text = this.loadingEl.querySelector('span');
      if (text) text.textContent = 'Processing...';
    }
    this.showState('loading');
  }

  private showState(state: ModalState) {
    this.state = state;

    if (this.loadingEl) {
      this.loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
    }
    if (this.clarificationEl) {
      this.clarificationEl.style.display = state === 'clarification' ? 'block' : 'none';
    }
    if (this.confirmationEl) {
      this.confirmationEl.style.display = state === 'confirmation' ? 'block' : 'none';
    }

    this.updateButtons();
  }

  private updateButtons() {
    if (!this.buttonsEl) return;
    this.buttonsEl.empty();

    const cancelBtn = this.buttonsEl.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-instruction-btn claudian-instruction-reject-btn',
      attr: { 'aria-label': 'Cancel' }
    });
    cancelBtn.addEventListener('click', () => this.handleReject());

    if (this.state === 'clarification') {
      const submitBtn = this.buttonsEl.createEl('button', {
        text: 'Submit',
        cls: 'claudian-instruction-btn claudian-instruction-accept-btn',
        attr: { 'aria-label': 'Submit response' }
      });
      submitBtn.addEventListener('click', () => this.submitClarification());
    } else if (this.state === 'confirmation') {
      this.editBtnEl = this.buttonsEl.createEl('button', {
        text: 'Edit',
        cls: 'claudian-instruction-btn claudian-instruction-edit-btn',
        attr: { 'aria-label': 'Edit instruction' }
      });
      this.editBtnEl.addEventListener('click', () => this.toggleEdit());

      const acceptBtn = this.buttonsEl.createEl('button', {
        text: 'Accept',
        cls: 'claudian-instruction-btn claudian-instruction-accept-btn',
        attr: { 'aria-label': 'Accept instruction' }
      });
      acceptBtn.addEventListener('click', () => this.handleAccept());
      acceptBtn.focus();
    }
  }

  private async submitClarification() {
    const response = this.responseTextarea?.getValue().trim();
    if (!response || this.isSubmitting) return;

    this.showClarificationLoading();

    try {
      await this.callbacks.onClarificationSubmit(response);
    } catch {
      // On error, go back to clarification state
      this.isSubmitting = false;
      this.showState('clarification');
    }
  }

  private toggleEdit() {
    this.isEditing = !this.isEditing;

    if (this.isEditing) {
      if (this.refinedDisplayEl) this.refinedDisplayEl.style.display = 'none';
      if (this.editContainerEl) this.editContainerEl.style.display = 'block';
      if (this.editBtnEl) this.editBtnEl.setText('Preview');
      this.editTextarea?.inputEl.focus();
    } else {
      const edited = this.editTextarea?.getValue() || this.refinedInstruction;
      this.refinedInstruction = edited;
      if (this.refinedDisplayEl) {
        this.refinedDisplayEl.setText(edited);
        this.refinedDisplayEl.style.display = 'block';
      }
      if (this.editContainerEl) this.editContainerEl.style.display = 'none';
      if (this.editBtnEl) this.editBtnEl.setText('Edit');
    }
  }

  private handleAccept() {
    if (this.resolved) return;
    this.resolved = true;

    const finalInstruction = this.isEditing
      ? (this.editTextarea?.getValue() || this.refinedInstruction)
      : this.refinedInstruction;

    this.callbacks.onAccept(finalInstruction);
    this.close();
  }

  private handleReject() {
    if (this.resolved) return;
    this.resolved = true;
    this.callbacks.onReject();
    this.close();
  }

  onClose() {
    if (!this.resolved) {
      this.resolved = true;
      this.callbacks.onReject();
    }
    this.contentEl.empty();
  }
}
