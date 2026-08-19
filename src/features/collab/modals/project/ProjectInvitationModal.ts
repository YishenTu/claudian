import type { CollabProjectId } from '@claudian/collab-protocol';
import { type App, Modal } from 'obsidian';

import type { CollabFeaturePort, CollabInvitationView } from '@/core/collab';
import { t } from '@/i18n/i18n';

export type ProjectInvitationModalPort = Pick<
  CollabFeaturePort,
  'createInvitation' | 'revokeInvitation'
>;

export interface ProjectInvitationModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly onClosed?: () => void;
  readonly projectId: CollabProjectId;
}

type InvitationStatus =
  | { readonly kind: 'error' | 'success'; readonly text: string }
  | null;

export class ProjectInvitationModal extends Modal {
  private abortController = new AbortController();
  private invitation: CollabInvitationView | null = null;
  private opened = false;
  private operationPending = false;
  private status: InvitationStatus = null;

  constructor(
    app: App,
    private readonly port: ProjectInvitationModalPort,
    private readonly options: ProjectInvitationModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.abortController = new AbortController();
    this.invitation = null;
    this.opened = true;
    this.operationPending = false;
    this.status = null;
    this.setTitle(t('collab.access.invitations'));
    this.modalEl.classList.add('claudian-collab-project-invitation-modal');
    this.render();
    void this.createInvitation();
  }

  onClose(): void {
    this.opened = false;
    this.abortController.abort();
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private render(): void {
    if (!this.opened) return;
    this.contentEl.replaceChildren();
    if (!this.invitation) {
      this.contentEl.createDiv({
        attr: { 'aria-live': 'polite' },
        cls: this.status?.kind === 'error'
          ? 'claudian-collab-access-status claudian-collab-access-status--error'
          : 'claudian-collab-access-status',
        text: this.status?.text ?? t('collab.access.creatingInvitation'),
      });
      if (this.status?.kind === 'error') {
        const retry = this.contentEl.createEl('button', {
          attr: { 'data-action': 'retry-invitation', type: 'button' },
          text: t('collab.access.retry'),
        });
        retry.disabled = this.operationPending;
        retry.addEventListener('click', () => void this.createInvitation());
      }
      return;
    }

    this.contentEl.createEl('textarea', {
      attr: {
        'aria-label': t('collab.access.invitation'),
        readonly: 'true',
        rows: '4',
      },
      cls: 'claudian-collab-access-invitation',
      text: this.invitation.encodedInvitation,
    });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-access-actions' });
    const copy = actions.createEl('button', {
      attr: { 'data-action': 'copy-invitation', type: 'button' },
      text: t('collab.access.copyInvitation'),
    });
    copy.disabled = this.operationPending || !this.options.copyText;
    copy.addEventListener('click', () => void this.copyInvitation());
    const revoke = actions.createEl('button', {
      attr: { 'data-action': 'revoke-invitation', type: 'button' },
      text: t('collab.access.revokeInvitation'),
    });
    revoke.disabled = this.operationPending;
    revoke.addEventListener('click', () => void this.revokeInvitation());
    if (this.status) {
      this.contentEl.createDiv({
        attr: {
          'aria-live': 'polite',
          ...(this.status.kind === 'error' ? { role: 'alert' } : {}),
        },
        cls: `claudian-collab-access-status claudian-collab-access-status--${this.status.kind}`,
        text: this.status.text,
      });
    }
  }

  private async createInvitation(): Promise<void> {
    if (this.operationPending) return;
    this.operationPending = true;
    this.status = null;
    this.render();
    const result = await this.port.createInvitation(
      this.options.projectId,
      { signal: this.abortController.signal },
    );
    if (!this.opened || this.abortController.signal.aborted) return;
    this.operationPending = false;
    if (result.status === 'success') {
      this.invitation = result.value;
    } else {
      this.status = { kind: 'error', text: t('collab.access.invitationFailed') };
    }
    this.render();
  }

  private async copyInvitation(): Promise<void> {
    if (!this.invitation || !this.options.copyText || this.operationPending) return;
    this.operationPending = true;
    this.status = null;
    this.render();
    try {
      await this.options.copyText(this.invitation.encodedInvitation);
      if (!this.opened || this.abortController.signal.aborted) return;
      this.status = { kind: 'success', text: t('collab.access.invitationCopied') };
    } catch {
      if (!this.opened || this.abortController.signal.aborted) return;
      this.status = { kind: 'error', text: t('collab.access.copyFailed') };
    } finally {
      if (this.opened && !this.abortController.signal.aborted) {
        this.operationPending = false;
        this.render();
      }
    }
  }

  private async revokeInvitation(): Promise<void> {
    if (!this.invitation || this.operationPending) return;
    this.operationPending = true;
    this.status = null;
    this.render();
    const result = await this.port.revokeInvitation(
      this.options.projectId,
      { signal: this.abortController.signal },
    );
    if (!this.opened || this.abortController.signal.aborted) return;
    this.operationPending = false;
    if (result.status === 'success') {
      this.close();
      return;
    }
    this.status = { kind: 'error', text: t('collab.access.invitationFailed') };
    this.render();
  }
}
