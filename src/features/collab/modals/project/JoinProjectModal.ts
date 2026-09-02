import { type App, Modal } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabLocalProjectSummary,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

type JoinProjectPort = Pick<CollabFeaturePort, 'joinProject' | 'resumeSetup'>;

export interface JoinProjectModalOptions {
  readonly onClosed?: () => void;
  readonly onJoined?: (project: CollabLocalProjectSummary) => void;
}

export class JoinProjectModal extends Modal {
  #abortController = new AbortController();
  #invitationInput: HTMLTextAreaElement | null = null;
  #joinButton: HTMLButtonElement | null = null;
  #materialEl: HTMLDivElement | null = null;
  #memberNameInput: HTMLInputElement | null = null;
  #operationGeneration = 0;
  #statusEl: HTMLDivElement | null = null;
  #submitting = false;
  readonly #port: JoinProjectPort;
  readonly #options: JoinProjectModalOptions;

  constructor(
    app: App,
    port: JoinProjectPort,
    options: JoinProjectModalOptions = {},
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
  }

  onOpen(): void {
    this.#abortController = new AbortController();
    this.#operationGeneration += 1;
    this.#submitting = false;
    this.setTitle(t('collab.joinProject.title'));
    this.modalEl.classList.add('claudian-collab-join-modal');
    this.contentEl.replaceChildren();

    const invitationField = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    invitationField.createEl('label', {
      attr: { for: 'claudian-collab-join-invitation' },
      text: t('collab.joinProject.invitation'),
    });
    this.#invitationInput = invitationField.createEl('textarea', {
      attr: {
        'data-field': 'invitation',
        id: 'claudian-collab-join-invitation',
        placeholder: t('collab.joinProject.invitationPlaceholder'),
        rows: '5',
      },
    });

    const memberField = this.contentEl.createDiv({ cls: 'claudian-collab-join-field' });
    memberField.createEl('label', {
      attr: { for: 'claudian-collab-join-member-name' },
      text: t('collab.joinProject.memberName'),
    });
    this.#memberNameInput = memberField.createEl('input', {
      attr: {
        'data-field': 'member-name',
        id: 'claudian-collab-join-member-name',
        placeholder: t('collab.joinProject.memberNamePlaceholder'),
        type: 'text',
      },
    });
    this.#materialEl = invitationField.createDiv({
      attr: { 'aria-live': 'polite', 'data-material': 'unknown' },
      cls: 'claudian-collab-join-material',
    });
    this.#invitationInput.addEventListener('input', () => {
      this.#renderMaterial();
      this.#updateJoinButton();
    });
    this.#memberNameInput.addEventListener('input', () => this.#updateJoinButton());

    this.#statusEl = this.contentEl.createDiv({ cls: 'claudian-collab-join-status' });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-join-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
    });
    cancel.addEventListener('click', () => this.close());
    this.#joinButton = actions.createEl('button', {
      attr: { 'data-action': 'join', type: 'button' },
      cls: 'mod-cta',
      text: t('collab.joinProject.join'),
    });
    this.#joinButton.disabled = true;
    this.#joinButton.addEventListener('click', () => {
      void this.#runJoin();
    });
  }

  onClose(): void {
    this.#abortController.abort();
    this.#operationGeneration += 1;
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  async #runJoin(): Promise<void> {
    if (!this.#joinButton || this.#joinButton.disabled || this.#submitting) return;
    const generation = ++this.#operationGeneration;
    this.#setSubmitting(true);
    this.#renderStatus(t('collab.joinProject.joining'));
    const result = await this.#port.joinProject({
      encodedInvitation: this.#invitationInput?.value.trim() ?? '',
      memberDisplayName: this.#memberNameInput?.value.trim() ?? '',
    }, { signal: this.#abortController.signal });
    if (!this.#isCurrent(generation)) return;
    if (result.status === 'success') {
      this.#options.onJoined?.(result.value);
      this.close();
      return;
    }
    if (result.status === 'recovery-required') {
      this.#renderResume(result.operationId);
      return;
    }
    this.#renderStatus(t('collab.joinProject.joinFailed'), true);
    this.#setSubmitting(false);
    this.#updateJoinButton();
  }

  #renderResume(operationId: string, failed = false): void {
    if (!this.#statusEl) return;
    this.#statusEl.replaceChildren();
    this.#statusEl.createDiv({
      attr: failed ? { role: 'alert' } : undefined,
      cls: 'claudian-collab-join-warning',
      text: t(failed
        ? 'collab.joinProject.resumeFailed'
        : 'collab.joinProject.resumeRequired'),
    });
    const resume = this.#statusEl.createEl('button', {
      attr: { 'data-action': 'resume', type: 'button' },
      text: t('collab.joinProject.resume'),
    });
    resume.addEventListener('click', () => {
      void this.#runResume(operationId, resume);
    });
  }

  async #runResume(
    operationId: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    const generation = ++this.#operationGeneration;
    button.disabled = true;
    this.#renderStatus(t('collab.joinProject.joining'));
    const result = await this.#port.resumeSetup(
      { operationId },
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    if (result.status === 'success') {
      this.#options.onJoined?.(result.value);
      this.close();
      return;
    }
    this.#renderResume(operationId, true);
  }

  #renderStatus(text: string, warning = false): void {
    if (!this.#statusEl) return;
    this.#statusEl.replaceChildren();
    if (!text) return;
    this.#statusEl.createDiv({
      attr: warning
        ? { 'aria-live': 'assertive', role: 'alert' }
        : { 'aria-live': 'polite', role: 'status' },
      cls: warning ? 'claudian-collab-join-warning' : undefined,
      text,
    });
  }

  #updateJoinButton(): void {
    if (!this.#joinButton) return;
    this.#joinButton.disabled = this.#submitting
      || this.#materialKind() === 'claim'
      || !this.#invitationInput?.value.trim()
      || !this.#memberNameInput?.value.trim();
  }

  #setSubmitting(submitting: boolean): void {
    this.#submitting = submitting;
    if (this.#invitationInput) this.#invitationInput.disabled = submitting;
    if (this.#memberNameInput) this.#memberNameInput.disabled = submitting;
    this.#updateJoinButton();
  }

  #renderMaterial(): void {
    if (!this.#materialEl) return;
    const kind = this.#materialKind();
    this.#materialEl.dataset.material = kind;
    this.#materialEl.textContent = kind === 'cloud'
      ? t('collab.joinProject.materialCloud')
      : kind === 'claim'
        ? t('collab.joinProject.materialClaim')
        : kind === 'lan'
          ? t('collab.joinProject.materialLan')
          : '';
  }

  #materialKind(): 'claim' | 'cloud' | 'lan' | 'unknown' {
    const value = this.#invitationInput?.value.trim() ?? '';
    if (value.startsWith('claudian-cloud-claim:')) return 'claim';
    if (value.startsWith('claudian-cloud:')) return 'cloud';
    if (value.startsWith('claudian-collab:')) return 'lan';
    return 'unknown';
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#operationGeneration && !this.#abortController.signal.aborted;
  }
}
