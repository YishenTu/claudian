import { type App, Modal } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabLocalProjectSummary,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

type CreateProjectPort = Pick<
  CollabFeaturePort,
  'createProject' | 'resumeSetup'
>;

export interface CreateProjectModalOptions {
  readonly onClosed?: () => void;
  readonly onCreated?: (project: CollabLocalProjectSummary) => void;
}

export class CreateProjectModal extends Modal {
  private abortController = new AbortController();
  private createButton: HTMLButtonElement | null = null;
  private memberNameInput: HTMLInputElement | null = null;
  private projectNameInput: HTMLInputElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private submitting = false;

  constructor(
    app: App,
    private readonly port: CreateProjectPort,
    private readonly options: CreateProjectModalOptions = {},
  ) {
    super(app);
  }

  onOpen(): void {
    this.abortController = new AbortController();
    this.submitting = false;
    this.setTitle(t('collab.createProject.title'));
    this.modalEl.classList.add('claudian-collab-create-modal');
    this.contentEl.replaceChildren();

    this.projectNameInput = this.renderTextField(
      'project-name',
      t('collab.createProject.projectName'),
      t('collab.createProject.projectNamePlaceholder'),
    );
    this.memberNameInput = this.renderTextField(
      'member-name',
      t('collab.createProject.memberName'),
      t('collab.createProject.memberNamePlaceholder'),
    );
    this.projectNameInput.addEventListener('input', () => this.updateCreateButton());
    this.memberNameInput.addEventListener('input', () => this.updateCreateButton());

    this.statusEl = this.contentEl.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-create-status',
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-create-actions' });
    const cancelButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancelButton.addEventListener('click', () => this.close());
    this.createButton = actions.createEl('button', {
      attr: { 'data-action': 'create', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.createProject.create'),
    });
    this.createButton.addEventListener('click', () => {
      void this.runCreate();
    });
    this.updateCreateButton();
  }

  onClose(): void {
    this.abortController.abort();
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private renderTextField(
    field: string,
    label: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = this.contentEl.createDiv({ cls: 'claudian-collab-create-field' });
    const id = `claudian-collab-create-${field}`;
    row.createEl('label', { attr: { for: id }, text: label });
    return row.createEl('input', {
      attr: {
        'data-field': field,
        id,
        placeholder,
        type: 'text',
      },
    });
  }

  private async runCreate(): Promise<void> {
    if (!this.createButton || this.createButton.disabled || this.submitting) return;
    this.setSubmitting(true);
    this.renderStatus(t('collab.createProject.creating'));
    const result = await this.port.createProject({
      memberDisplayName: this.memberNameInput?.value.trim() ?? '',
      name: this.projectNameInput?.value.trim() ?? '',
    }, { signal: this.abortController.signal });
    if (this.abortController.signal.aborted) return;
    if (result.status === 'success') {
      this.options.onCreated?.(result.value);
      this.close();
      return;
    }
    if (result.status === 'recovery-required') {
      this.renderResume(result.operationId);
      return;
    }
    this.setSubmitting(false);
    this.renderStatus(t('collab.createProject.createFailed'), true);
  }

  private renderResume(operationId: string): void {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    this.statusEl.createDiv({
      cls: 'claudian-collab-create-warning',
      text: t('collab.createProject.resumeRequired'),
    });
    const resumeButton = this.statusEl.createEl('button', {
      attr: { 'data-action': 'resume', type: 'button' },
      text: t('collab.createProject.resume'),
    });
    resumeButton.addEventListener('click', () => {
      void this.runResume(operationId, resumeButton);
    });
  }

  private async runResume(
    operationId: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    const result = await this.port.resumeSetup(
      { operationId },
      { signal: this.abortController.signal },
    );
    if (this.abortController.signal.aborted) return;
    if (result.status === 'success') {
      this.options.onCreated?.(result.value);
      this.close();
      return;
    }
    button.disabled = false;
    this.renderStatus(t('collab.createProject.resumeFailed'), true);
  }

  private renderStatus(text: string, warning = false): void {
    if (!this.statusEl) return;
    this.statusEl.replaceChildren();
    this.statusEl.createDiv({
      cls: warning ? 'claudian-collab-create-warning' : undefined,
      text,
    });
  }

  private setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
    if (this.projectNameInput) this.projectNameInput.disabled = submitting;
    if (this.memberNameInput) this.memberNameInput.disabled = submitting;
    this.updateCreateButton();
  }

  private updateCreateButton(): void {
    if (!this.createButton) return;
    this.createButton.disabled = this.submitting
      || !this.projectNameInput?.value.trim()
      || !this.memberNameInput?.value.trim();
  }
}
