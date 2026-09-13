import type { CollabProjectId } from '@claudian-collab/protocol';
import { type App, Modal, Notice } from 'obsidian';

import type {
  CollabFeaturePort,
  CollabInvitationOperation,
  CollabInvitationState,
  CollabInvitationView,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

export type ProjectInvitationModalPort = Pick<CollabFeaturePort, 'openInvitation'>;

export interface ProjectInvitationModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly intent: 'create' | 'resume';
  readonly onClosed?: () => void;
  readonly projectId: CollabProjectId;
}

export class ProjectInvitationModal extends Modal {
  #operation: CollabInvitationOperation | null = null;
  #invitation: CollabInvitationView | null = null;
  #availableUntil = 0;
  #expiryTimer: number | null = null;
  #expiryText: HTMLElement | null = null;
  #unavailableText: string | null = null;
  #error: string | null = null;
  #opened = false;
  #generation = 0;
  #busy = false;
  readonly #port: ProjectInvitationModalPort;
  readonly #options: ProjectInvitationModalOptions;

  constructor(app: App, port: ProjectInvitationModalPort, options: ProjectInvitationModalOptions) {
    super(app);
    this.#port = port;
    this.#options = options;
  }

  onOpen(): void {
    this.#clearExpiryTimer();
    this.#operation?.dispose();
    this.#operation = this.#port.openInvitation({
      projectId: this.#options.projectId, intent: this.#options.intent,
    });
    this.#invitation = null;
    this.#unavailableText = null;
    this.#error = null;
    this.#opened = true;
    this.#generation += 1;
    this.#busy = false;
    this.setTitle(t('collab.access.invitation'));
    this.modalEl.classList.add(
      'claudian-collab-project-invitation-modal',
      'claudian-collab-modal--filled-actions',
    );
    void this.#loadInvitation();
  }

  onClose(): void {
    this.#opened = false;
    this.#generation += 1;
    this.#operation?.dispose();
    this.#operation = null;
    this.#clearExpiryTimer();
    this.#invitation = null;
    this.#expiryText = null;
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  #render(): void {
    if (!this.#opened) return;
    const activeElement = this.contentEl.ownerDocument.activeElement;
    const restoreCopyFocus = this.contentEl.contains(activeElement)
      && activeElement?.getAttribute('data-action') === 'copy-invitation';
    this.contentEl.replaceChildren();
    this.#expiryText = null;
    if (this.#invitation) {
      const copy = this.contentEl.createEl('button', {
        attr: {
          'aria-label': t('collab.access.copyInvitation'),
          'data-action': 'copy-invitation',
          title: t('collab.access.copyInvitation'),
          type: 'button',
        },
        cls: 'claudian-collab-project-invitation-copy',
        text: this.#invitation.encodedInvitation,
      });
      copy.disabled = this.#busy || !this.#options.copyText;
      copy.addEventListener('click', () => void this.#copyInvitation());
      if (restoreCopyFocus) copy.focus();
      this.#expiryText = this.contentEl.createDiv({
        cls: 'claudian-collab-project-invitation-expiry',
        text: this.#remainingTimeText(),
      });
    } else if (this.#busy) {
      this.contentEl.createDiv({
        attr: { role: 'status' },
        text: t('collab.access.creatingInvitation'),
      });
    } else if (this.#unavailableText) {
      this.contentEl.createDiv({ attr: { role: 'status' }, text: this.#unavailableText });
      const create = this.contentEl.createEl('button', {
        attr: { type: 'button' },
        text: t('collab.access.createNewInvitation'),
      });
      create.addEventListener('click', () => void this.#replaceInvitation());
    }
    if (this.#error) {
      this.contentEl.createDiv({
        attr: { role: 'alert' },
        cls: 'claudian-collab-access-status claudian-collab-access-status--error',
        text: this.#error,
      });
      if (!this.#invitation && !this.#unavailableText && !this.#busy) {
        const retry = this.contentEl.createEl('button', {
          attr: { type: 'button' },
          text: t('collab.access.retry'),
        });
        retry.addEventListener('click', () => void this.#loadInvitation());
      }
    }
  }

  async #loadInvitation(): Promise<void> {
    if (!this.#opened || this.#busy || !this.#operation) return;
    const generation = ++this.#generation;
    const operation = this.#operation;
    this.#busy = true;
    this.#error = null;
    this.#render();
    try {
      const result = await operation.run();
      if (!this.#isCurrent(generation)) return;
      if (result.status === 'success') this.#applyState(result.value);
      else this.#error = t('collab.access.invitationFailed');
    } catch {
      if (this.#isCurrent(generation)) this.#error = t('collab.access.invitationFailed');
    } finally {
      if (this.#isCurrent(generation)) {
        this.#busy = false;
        this.#render();
      }
    }
  }

  async #copyInvitation(): Promise<void> {
    if (!this.#invitation || !this.#options.copyText || this.#busy || !this.#operation) return;
    const generation = this.#generation;
    const operation = this.#operation;
    this.#busy = true;
    this.#error = null;
    this.#render();
    try {
      const read = await operation.read();
      if (!this.#isCurrent(generation)) return;
      if (read.status !== 'success') {
        this.#invitation = null;
        this.#clearExpiryTimer();
        this.#error = t('collab.access.invitationFailed');
        return;
      }
      this.#applyState(read.value);
      if (!this.#invitation) return;
      await this.#options.copyText(this.#invitation.encodedInvitation);
      if (!this.#isCurrent(generation)) return;
      const completed = await operation.acknowledge();
      if (!this.#isCurrent(generation)) return;
      if (completed.status !== 'success') {
        this.#error = t('collab.access.invitationFailed');
        return;
      }
      new Notice(t('collab.access.invitationCopied'));
    } catch {
      if (this.#isCurrent(generation)) this.#error = t('collab.access.copyFailed');
    } finally {
      if (this.#isCurrent(generation)) {
        this.#busy = false;
        this.#render();
      }
    }
  }

  #replaceInvitation(): void {
    if (this.#busy || this.#invitation) return;
    this.#operation?.dispose();
    this.#operation = this.#port.openInvitation({ projectId: this.#options.projectId, intent: 'create' });
    this.#unavailableText = null;
    void this.#loadInvitation();
  }

  #applyState(state: CollabInvitationState): void {
    this.#clearExpiryTimer();
    this.#invitation = null;
    this.#unavailableText = null;
    if (state.status === 'blocked') {
      this.#error = t('collab.access.invitationManagementPending');
    } else if (state.status === 'unavailable') {
      this.#unavailableText = t(state.reason === 'expired'
        ? 'collab.access.invitationExpired' : 'collab.access.invitationUnavailable');
    } else {
      this.#invitation = state.invitation;
      this.#availableUntil = Date.parse(state.availableUntil);
      this.#refreshExpiry();
    }
  }

  #remainingTimeText(): string {
    return t('collab.access.invitationExpiresIn', {
      minutes: Math.max(1, Math.ceil((Date.parse(this.#invitation!.expiresAt) - Date.now()) / 60_000)),
    });
  }

  #refreshExpiry(): void {
    this.#clearExpiryTimer();
    if (!this.#opened || !this.#invitation) return;
    const remaining = this.#availableUntil - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.#unavailableText = t(Date.parse(this.#invitation.expiresAt) <= Date.now()
        ? 'collab.access.invitationExpired' : 'collab.access.invitationUnavailable');
      this.#invitation = null;
      this.#render();
      return;
    }
    if (this.#expiryText) this.#expiryText.textContent = this.#remainingTimeText();
    const linkRemaining = Date.parse(this.#invitation.expiresAt) - Date.now();
    this.#expiryTimer = window.setTimeout(
      () => this.#refreshExpiry(), Math.min(remaining, linkRemaining % 60_000 || 60_000),
    );
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer === null) return;
    window.clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  #isCurrent(generation: number): boolean {
    return this.#opened && generation === this.#generation;
  }
}
