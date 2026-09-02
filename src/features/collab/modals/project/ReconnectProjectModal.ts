import { type App, Modal } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabLocalProjectSummary,
  CollabPendingReconnectView,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

type ReconnectProjectPort = Pick<
  CollabFeaturePort,
  'readPendingReconnect' | 'reconnectProject' | 'resumeReconnect'
>;

export interface ReconnectProjectModalOptions {
  readonly onClosed?: () => void;
  readonly onReconnected?: (project: CollabLocalProjectSummary) => void;
  readonly project: CollabLocalProjectSummary;
}

export class ReconnectProjectModal extends Modal {
  #abortController = new AbortController();
  #invitationInput: HTMLTextAreaElement | null = null;
  #invitationRow: HTMLDivElement | null = null;
  #mode: 'invitation' | 'relocation' = 'invitation';
  #operationGeneration = 0;
  #opened = false;
  #pendingReconnect: CollabPendingReconnectView | null = null;
  #reconnectButton: HTMLButtonElement | null = null;
  #serverUrlInput: HTMLInputElement | null = null;
  #serverUrlRow: HTMLDivElement | null = null;
  #statusEl: HTMLDivElement | null = null;
  #submitting = false;
  readonly #port: ReconnectProjectPort;
  readonly #options: ReconnectProjectModalOptions;

  constructor(
    app: App,
    port: ReconnectProjectPort,
    options: ReconnectProjectModalOptions,
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
  }

  onOpen(): void {
    this.#abortController = new AbortController();
    this.#mode = 'invitation';
    this.#opened = true;
    this.#pendingReconnect = null;
    this.#submitting = false;
    this.#operationGeneration += 1;
    this.setTitle(t('collab.reconnectProject.title'));
    this.modalEl.classList.add('claudian-collab-join-modal');
    this.contentEl.replaceChildren();

    this.contentEl.createDiv({
      cls: 'claudian-collab-join-description',
      text: t(this.#options.project.authorityKind === 'cloud'
        ? 'collab.reconnectProject.descriptionCloud'
        : 'collab.reconnectProject.descriptionLan', {
        name: this.#options.project.name,
      }),
    });
    if (this.#options.project.authorityKind === 'cloud') this.#renderCloudModeSelection();
    this.#invitationRow = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    this.#invitationRow.createEl('label', {
      attr: { for: 'claudian-collab-reconnect-invitation' },
      text: t('collab.reconnectProject.invitation'),
    });
    this.#invitationInput = this.#invitationRow.createEl('textarea', {
      attr: {
        'data-field': 'invitation',
        id: 'claudian-collab-reconnect-invitation',
        placeholder: t('collab.reconnectProject.invitationPlaceholder'),
        rows: '5',
      },
    });
    this.#invitationInput.addEventListener('input', () => this.#updateButton());
    if (this.#options.project.authorityKind === 'cloud') this.#renderServerUrlField();

    this.#statusEl = this.contentEl.createDiv({ cls: 'claudian-collab-join-status' });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-join-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancel.addEventListener('click', () => this.close());
    this.#reconnectButton = actions.createEl('button', {
      attr: { 'data-action': 'reconnect', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.reconnectProject.reconnect'),
    });
    this.#reconnectButton.disabled = true;
    this.#reconnectButton.addEventListener('click', () => {
      void this.#runReconnect();
    });
    if (this.#options.project.authorityKind === 'cloud') {
      void this.#loadPendingReconnect();
    }
  }

  onClose(): void {
    this.#opened = false;
    this.#abortController.abort();
    this.#operationGeneration += 1;
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  async #runReconnect(): Promise<void> {
    if (!this.#reconnectButton || this.#reconnectButton.disabled || this.#submitting) return;
    const generation = ++this.#operationGeneration;
    this.#setSubmitting(true);
    this.#renderStatus(t('collab.reconnectProject.reconnecting'));
    const result = await this.#port.reconnectProject(
      this.#mode === 'relocation'
        ? {
          authority: {
            kind: 'cloud',
            serverUrl: this.#serverUrlInput?.value ?? '',
          },
          projectId: this.#options.project.id,
        }
        : {
          encodedInvitation: this.#invitationInput?.value.trim() ?? '',
          projectId: this.#options.project.id,
        },
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    if (result.status === 'success') {
      this.#options.onReconnected?.(result.value);
      this.close();
      return;
    }
    if (result.status === 'recovery-required') {
      await this.#loadPendingReconnect();
      return;
    }
    this.#renderStatus(t(this.#mode === 'relocation'
      ? 'collab.reconnectProject.failedRelocation'
      : this.#options.project.authorityKind === 'cloud'
        ? 'collab.reconnectProject.failedCloudMaterial'
        : 'collab.reconnectProject.failedInvitation'), true);
    this.#setSubmitting(false);
    this.#updateButton();
  }

  #renderStatus(text: string, warning = false): void {
    if (!this.#statusEl) return;
    this.#statusEl.replaceChildren();
    this.#statusEl.createDiv({
      attr: warning ? { role: 'alert' } : { role: 'status' },
      cls: warning ? 'claudian-collab-join-warning' : undefined,
      text,
    });
  }

  #updateButton(): void {
    if (!this.#reconnectButton) return;
    this.#reconnectButton.disabled = this.#submitting || (this.#mode === 'relocation'
      ? !this.#serverUrlInput?.value.trim()
      : !this.#invitationInput?.value.trim());
  }

  #setSubmitting(submitting: boolean): void {
    this.#submitting = submitting;
    if (this.#invitationInput) this.#invitationInput.disabled = submitting;
    if (this.#serverUrlInput) this.#serverUrlInput.disabled = submitting;
    for (const input of this.contentEl.querySelectorAll<HTMLInputElement>(
      '[name="claudian-collab-reconnect-mode"]',
    )) input.disabled = submitting;
    this.#updateButton();
  }

  #isCurrent(generation: number): boolean {
    return this.#opened && generation === this.#operationGeneration;
  }

  async #loadPendingReconnect(): Promise<void> {
    const generation = ++this.#operationGeneration;
    const result = await this.#port.readPendingReconnect(
      this.#options.project.id,
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    if (result.status !== 'success') {
      this.#setSubmitting(false);
      this.#renderStatus(t('collab.reconnectProject.failedRelocation'), true);
      return;
    }
    this.#pendingReconnect = result.value;
    if (result.value) {
      this.#renderPendingReconnect();
      return;
    }
    if (this.#submitting) {
      this.#setSubmitting(false);
      this.#renderStatus(t('collab.reconnectProject.failedRelocation'), true);
    }
  }

  #renderPendingReconnect(failed = false): void {
    const pending = this.#pendingReconnect;
    if (!pending || !this.#statusEl) return;
    this.#mode = 'relocation';
    for (const input of this.contentEl.querySelectorAll<HTMLInputElement>(
      '[name="claudian-collab-reconnect-mode"]',
    )) input.checked = input.value === 'relocation';
    if (this.#serverUrlInput) this.#serverUrlInput.value = pending.serverUrl;
    this.#updateModeVisibility();
    this.#setSubmitting(true);
    this.#statusEl.replaceChildren();
    this.#statusEl.createDiv({
      attr: failed ? { role: 'alert' } : { role: 'status' },
      cls: 'claudian-collab-join-warning',
      text: t(failed
        ? 'collab.joinProject.resumeFailed'
        : 'collab.joinProject.resumeRequired'),
    });
    const resume = this.#statusEl.createEl('button', {
      attr: { 'data-action': 'resume', type: 'button' },
      text: t('collab.joinProject.resume'),
    });
    resume.addEventListener('click', () => void this.#runResume(resume));
  }

  async #runResume(button: HTMLButtonElement): Promise<void> {
    if (!this.#pendingReconnect || button.disabled) return;
    const generation = ++this.#operationGeneration;
    button.disabled = true;
    const result = await this.#port.resumeReconnect(
      this.#options.project.id,
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    if (result.status === 'success') {
      this.#options.onReconnected?.(result.value);
      this.close();
      return;
    }
    this.#renderPendingReconnect(true);
  }

  #renderCloudModeSelection(): void {
    const group = this.contentEl.createEl('fieldset', {
      cls: 'claudian-collab-join-mode',
    });
    group.createEl('legend', { text: t('collab.reconnectProject.method') });
    for (const mode of ['invitation', 'relocation'] as const) {
      const label = group.createEl('label');
      const input = label.createEl('input', {
        attr: {
          'data-field': `reconnect-${mode}`,
          name: 'claudian-collab-reconnect-mode',
          type: 'radio',
          value: mode,
        },
      });
      input.checked = mode === this.#mode;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.#mode = mode;
        this.#updateModeVisibility();
        this.#updateButton();
      });
      label.createSpan({
        text: mode === 'invitation'
          ? t('collab.reconnectProject.invitationOrClaim')
          : t('collab.reconnectProject.relocation'),
      });
    }
  }

  #renderServerUrlField(): void {
    this.#serverUrlRow = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    const id = 'claudian-collab-reconnect-server-url';
    this.#serverUrlRow.createEl('label', {
      attr: { for: id },
      text: t('collab.reconnectProject.serverUrl'),
    });
    this.#serverUrlInput = this.#serverUrlRow.createEl('input', {
      attr: {
        'data-field': 'server-url',
        id,
        inputmode: 'url',
        placeholder: t('collab.reconnectProject.serverUrlPlaceholder'),
        type: 'text',
      },
    });
    this.#serverUrlInput.addEventListener('input', () => this.#updateButton());
    this.#updateModeVisibility();
  }

  #updateModeVisibility(): void {
    if (this.#invitationRow) this.#invitationRow.hidden = this.#mode !== 'invitation';
    if (this.#invitationInput) this.#invitationInput.hidden = this.#mode !== 'invitation';
    if (this.#serverUrlRow) this.#serverUrlRow.hidden = this.#mode !== 'relocation';
    if (this.#serverUrlInput) this.#serverUrlInput.hidden = this.#mode !== 'relocation';
  }
}
