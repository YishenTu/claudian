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
  #authorityKind: 'cloud' | 'lan' = 'lan';
  #authorityInputs: HTMLInputElement[] = [];
  #abortController = new AbortController();
  #createButton: HTMLButtonElement | null = null;
  #memberNameInput: HTMLInputElement | null = null;
  #projectNameInput: HTMLInputElement | null = null;
  #serverUrlInput: HTMLInputElement | null = null;
  #serverUrlRow: HTMLDivElement | null = null;
  #statusEl: HTMLDivElement | null = null;
  #submitting = false;
  readonly #port: CreateProjectPort;
  readonly #options: CreateProjectModalOptions;

  constructor(
    app: App,
    port: CreateProjectPort,
    options: CreateProjectModalOptions = {},
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
  }

  onOpen(): void {
    this.#abortController = new AbortController();
    this.#authorityKind = 'lan';
    this.#authorityInputs = [];
    this.#submitting = false;
    this.setTitle(t('collab.createProject.title'));
    this.modalEl.classList.add('claudian-collab-create-modal');
    this.contentEl.replaceChildren();

    this.#projectNameInput = this.#renderTextField(
      'project-name',
      t('collab.createProject.projectName'),
      t('collab.createProject.projectNamePlaceholder'),
    );
    this.#memberNameInput = this.#renderTextField(
      'member-name',
      t('collab.createProject.memberName'),
      t('collab.createProject.memberNamePlaceholder'),
    );
    this.#renderAuthorityFields();
    this.#projectNameInput.addEventListener('input', () => this.#updateCreateButton());
    this.#memberNameInput.addEventListener('input', () => this.#updateCreateButton());

    this.#statusEl = this.contentEl.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-create-status',
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-create-actions' });
    const cancelButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancelButton.addEventListener('click', () => this.close());
    this.#createButton = actions.createEl('button', {
      attr: { 'data-action': 'create', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.createProject.create'),
    });
    this.#createButton.addEventListener('click', () => {
      void this.#runCreate();
    });
    this.#updateCreateButton();
  }

  onClose(): void {
    this.#abortController.abort();
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  #renderTextField(
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

  async #runCreate(): Promise<void> {
    if (!this.#createButton || this.#createButton.disabled || this.#submitting) return;
    this.#setSubmitting(true);
    this.#renderStatus(t('collab.createProject.creating'));
    const result = await this.#port.createProject({
      authority: this.#authorityKind === 'cloud'
        ? { kind: 'cloud', serverUrl: this.#serverUrlInput?.value ?? '' }
        : { kind: 'lan' },
      memberDisplayName: this.#memberNameInput?.value.trim() ?? '',
      name: this.#projectNameInput?.value.trim() ?? '',
    }, { signal: this.#abortController.signal });
    if (this.#abortController.signal.aborted) return;
    if (result.status === 'success') {
      this.#options.onCreated?.(result.value);
      this.close();
      return;
    }
    if (result.status === 'recovery-required') {
      this.#renderResume(result.operationId);
      return;
    }
    this.#setSubmitting(false);
    this.#renderStatus(t('collab.createProject.createFailed'), true);
  }

  #renderResume(operationId: string, failed = false): void {
    if (!this.#statusEl) return;
    this.#statusEl.replaceChildren();
    this.#statusEl.createDiv({
      attr: failed ? { role: 'alert' } : undefined,
      cls: 'claudian-collab-create-warning',
      text: t(failed
        ? 'collab.createProject.resumeFailed'
        : 'collab.createProject.resumeRequired'),
    });
    const resumeButton = this.#statusEl.createEl('button', {
      attr: { 'data-action': 'resume', type: 'button' },
      text: t('collab.createProject.resume'),
    });
    resumeButton.addEventListener('click', () => {
      void this.#runResume(operationId, resumeButton);
    });
  }

  async #runResume(
    operationId: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    const result = await this.#port.resumeSetup(
      { operationId },
      { signal: this.#abortController.signal },
    );
    if (this.#abortController.signal.aborted) return;
    if (result.status === 'success') {
      this.#options.onCreated?.(result.value);
      this.close();
      return;
    }
    this.#renderResume(operationId, true);
  }

  #renderStatus(text: string, warning = false): void {
    if (!this.#statusEl) return;
    this.#statusEl.replaceChildren();
    this.#statusEl.createDiv({
      cls: warning ? 'claudian-collab-create-warning' : undefined,
      text,
    });
  }

  #setSubmitting(submitting: boolean): void {
    this.#submitting = submitting;
    if (this.#projectNameInput) this.#projectNameInput.disabled = submitting;
    if (this.#memberNameInput) this.#memberNameInput.disabled = submitting;
    if (this.#serverUrlInput) this.#serverUrlInput.disabled = submitting;
    for (const input of this.#authorityInputs) input.disabled = submitting;
    this.#updateCreateButton();
  }

  #updateCreateButton(): void {
    if (!this.#createButton) return;
    this.#createButton.disabled = this.#submitting
      || !this.#projectNameInput?.value.trim()
      || !this.#memberNameInput?.value.trim()
      || (this.#authorityKind === 'cloud' && !this.#serverUrlInput?.value.trim());
  }

  #renderAuthorityFields(): void {
    const group = this.contentEl.createEl('fieldset', {
      cls: 'claudian-collab-create-authority',
    });
    group.createEl('legend', { text: t('collab.createProject.authority') });
    for (const kind of ['lan', 'cloud'] as const) {
      const label = group.createEl('label');
      const input = label.createEl('input', {
        attr: {
          'data-field': `authority-${kind}`,
          name: 'claudian-collab-create-authority',
          type: 'radio',
          value: kind,
        },
      });
      input.checked = kind === this.#authorityKind;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.#authorityKind = kind;
        this.#updateAuthorityVisibility();
        this.#updateCreateButton();
      });
      label.createSpan({
        text: kind === 'lan'
          ? t('collab.createProject.authorityLan')
          : t('collab.createProject.authorityCloud'),
      });
      this.#authorityInputs.push(input);
    }
    this.#serverUrlRow = this.contentEl.createDiv({ cls: 'claudian-collab-create-field' });
    const id = 'claudian-collab-create-server-url';
    this.#serverUrlRow.createEl('label', {
      attr: { for: id },
      text: t('collab.createProject.serverUrl'),
    });
    this.#serverUrlInput = this.#serverUrlRow.createEl('input', {
      attr: {
        'data-field': 'server-url',
        id,
        inputmode: 'url',
        placeholder: t('collab.createProject.serverUrlPlaceholder'),
        type: 'text',
      },
    });
    this.#serverUrlInput.addEventListener('input', () => this.#updateCreateButton());
    this.#updateAuthorityVisibility();
  }

  #updateAuthorityVisibility(): void {
    const hidden = this.#authorityKind !== 'cloud';
    if (this.#serverUrlRow) this.#serverUrlRow.hidden = hidden;
    if (this.#serverUrlInput) this.#serverUrlInput.hidden = hidden;
  }
}
