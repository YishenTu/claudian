import type { CollabProjectId } from '@claudian-collab/protocol';
import { type App, Modal } from 'obsidian';

import type {
  CollabAuthorityKind,
  CollabFeaturePort,
  CollabInvitationSummaryView,
  CollabInvitationView,
} from '@/core/collab';
import { t } from '@/i18n/i18n';

export type ProjectInvitationModalPort = Pick<
  CollabFeaturePort,
  | 'completeManagementOperation'
  | 'createInvitation'
  | 'listInvitations'
  | 'readManagementOperation'
  | 'resumeManagementOperation'
  | 'revokeInvitation'
>;

export interface ProjectInvitationModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly authorityKind: CollabAuthorityKind;
  readonly onClosed?: () => void;
  readonly projectId: CollabProjectId;
}

type InvitationStatus =
  | { readonly kind: 'error' | 'success'; readonly text: string }
  | null;

export class ProjectInvitationModal extends Modal {
  #abortController = new AbortController();
  #invitation: CollabInvitationView | null = null;
  #invitations: readonly CollabInvitationSummaryView[] = [];
  #managementReadFailed = false;
  #opened = false;
  #operationGeneration = 0;
  #operationPending = false;
  #pendingCreation = false;
  #retainedResult = false;
  #status: InvitationStatus = null;
  readonly #port: ProjectInvitationModalPort;
  readonly #options: ProjectInvitationModalOptions;

  constructor(
    app: App,
    port: ProjectInvitationModalPort,
    options: ProjectInvitationModalOptions,
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
  }

  onOpen(): void {
    this.#abortController = new AbortController();
    this.#invitation = null;
    this.#invitations = [];
    this.#managementReadFailed = false;
    this.#opened = true;
    this.#operationGeneration += 1;
    this.#operationPending = false;
    this.#pendingCreation = false;
    this.#retainedResult = false;
    this.#status = null;
    this.setTitle(t('collab.access.invitations'));
    this.modalEl.classList.add('claudian-collab-project-invitation-modal');
    this.#render();
    if (this.#options.authorityKind === 'lan') {
      return;
    } else {
      void this.#loadCloudInvitations();
    }
  }

  onClose(): void {
    this.#opened = false;
    this.#operationGeneration += 1;
    this.#abortController.abort();
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  #render(): void {
    if (!this.#opened) return;
    this.contentEl.replaceChildren();
    if (!this.#invitation && this.#options.authorityKind === 'cloud') {
      this.#renderCloudInvitationList();
      return;
    }
    if (!this.#invitation) {
      this.contentEl.createDiv({
        attr: { 'aria-live': 'polite' },
        cls: this.#status?.kind === 'error'
          ? 'claudian-collab-access-status claudian-collab-access-status--error'
          : 'claudian-collab-access-status',
        text: this.#status?.text ?? t('collab.access.noInvitations'),
      });
      const create = this.contentEl.createEl('button', {
        attr: { 'data-action': 'create-invitation', type: 'button' },
        text: this.#status?.kind === 'error'
          ? t('collab.access.retry')
          : t('collab.access.createInvitation'),
      });
      create.disabled = this.#operationPending;
      create.addEventListener('click', () => void this.#createInvitation());
      return;
    }

    this.contentEl.createEl('textarea', {
      attr: {
        'aria-label': t('collab.access.invitation'),
        readonly: 'true',
        rows: '4',
      },
      cls: 'claudian-collab-access-invitation',
      text: this.#invitation.encodedInvitation,
    });
    const actions = this.contentEl.createDiv({ cls: 'claudian-collab-access-actions' });
    const copy = actions.createEl('button', {
      attr: { 'data-action': 'copy-invitation', type: 'button' },
      text: t('collab.access.copyInvitation'),
    });
    copy.disabled = this.#operationPending || !this.#options.copyText;
    copy.addEventListener('click', () => void this.#copyInvitation());
    if (this.#options.authorityKind === 'lan') {
      const revoke = actions.createEl('button', {
        attr: { 'data-action': 'revoke-invitation', type: 'button' },
        text: t('collab.access.revokeInvitation'),
      });
      revoke.disabled = this.#operationPending;
      revoke.addEventListener('click', () => void this.#revokeInvitation());
    }
    if (this.#status) {
      this.contentEl.createDiv({
        attr: {
          'aria-live': 'polite',
          ...(this.#status.kind === 'error' ? { role: 'alert' } : {}),
        },
        cls: `claudian-collab-access-status claudian-collab-access-status--${this.#status.kind}`,
        text: this.#status.text,
      });
    }
  }

  async #createInvitation(): Promise<void> {
    if (this.#operationPending) return;
    this.#operationPending = true;
    const generation = ++this.#operationGeneration;
    this.#status = null;
    this.#render();
    const result = await this.#port.createInvitation(
      this.#options.projectId,
      ...(this.#options.authorityKind === 'lan'
        ? [{ signal: this.#abortController.signal }]
        : []),
    );
    if (!this.#isCurrent(generation)) return;
    this.#operationPending = false;
    if (result.status === 'success') {
      this.#invitation = result.value;
      this.#retainedResult = this.#options.authorityKind === 'cloud';
    } else {
      this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
    }
    this.#render();
  }

  async #copyInvitation(): Promise<void> {
    if (!this.#invitation || !this.#options.copyText || this.#operationPending) return;
    this.#operationPending = true;
    this.#status = null;
    this.#render();
    try {
      await this.#options.copyText(this.#invitation.encodedInvitation);
      if (!this.#opened || this.#abortController.signal.aborted) return;
      if (this.#retainedResult) {
        const completed = await this.#port.completeManagementOperation(
          { projectId: this.#options.projectId },
        );
        if (!this.#opened || this.#abortController.signal.aborted) return;
        if (completed.status !== 'success') {
          this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
          return;
        }
        this.#retainedResult = false;
      }
      this.#status = { kind: 'success', text: t('collab.access.invitationCopied') };
    } catch {
      if (!this.#opened || this.#abortController.signal.aborted) return;
      this.#status = { kind: 'error', text: t('collab.access.copyFailed') };
    } finally {
      if (this.#opened && !this.#abortController.signal.aborted) {
        this.#operationPending = false;
        this.#render();
      }
    }
  }

  async #revokeInvitation(invitationId?: string): Promise<void> {
    if (
      this.#operationPending
      || (this.#options.authorityKind === 'lan' && !this.#invitation)
      || (this.#options.authorityKind === 'cloud' && !invitationId)
    ) return;
    this.#operationPending = true;
    this.#status = null;
    this.#render();
    const result = await this.#port.revokeInvitation(
      this.#options.authorityKind === 'cloud'
        ? { invitationId: invitationId!, projectId: this.#options.projectId }
        : this.#options.projectId,
      ...(this.#options.authorityKind === 'lan'
        ? [{ signal: this.#abortController.signal }]
        : []),
    );
    if (!this.#opened || this.#abortController.signal.aborted) return;
    this.#operationPending = false;
    if (result.status === 'success') {
      if (this.#options.authorityKind === 'lan') {
        this.close();
        return;
      }
      this.#invitation = null;
      this.#status = { kind: 'success', text: t('collab.access.invitationRevoked') };
      await this.#loadCloudInvitations();
      return;
    }
    this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
    this.#render();
  }

  async #loadCloudInvitations(): Promise<void> {
    if (!this.#opened || this.#operationPending) return;
    const generation = ++this.#operationGeneration;
    if (this.#managementReadFailed) this.#status = null;
    this.#operationPending = true;
    this.#render();
    const operation = await this.#port.readManagementOperation(
      this.#options.projectId,
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    if (operation.status !== 'success') {
      this.#operationPending = false;
      this.#managementReadFailed = true;
      this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
      this.#render();
      return;
    }
    this.#managementReadFailed = false;
    const retained = operation.value;
    if (retained?.action === 'create-invitation') {
      this.#pendingCreation = retained.status === 'pending';
    }
    if (
      retained?.action === 'create-invitation'
      && retained.status === 'result-retained'
      && retained.invitation
    ) {
      this.#invitation = retained.invitation;
      this.#retainedResult = true;
    }
    const listed = await this.#port.listInvitations(
      this.#options.projectId,
      { signal: this.#abortController.signal },
    );
    if (!this.#isCurrent(generation)) return;
    this.#operationPending = false;
    if (listed.status !== 'success') {
      this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
    } else {
      this.#invitations = listed.value;
    }
    this.#render();
  }

  #renderCloudInvitationList(): void {
    const heading = this.contentEl.createEl('h3', {
      text: t('collab.access.activeInvitations'),
    });
    if (this.#managementReadFailed) {
      const retry = this.contentEl.createEl('button', {
        attr: { 'data-action': 'retry-invitations', type: 'button' },
        text: t('collab.access.retry'),
      });
      retry.disabled = this.#operationPending;
      retry.addEventListener('click', () => void this.#loadCloudInvitations());
    } else {
      const create = this.contentEl.createEl('button', {
        attr: { 'data-action': 'create-invitation', type: 'button' },
        text: t('collab.access.createInvitation'),
      });
      create.disabled = this.#operationPending || this.#pendingCreation;
      create.addEventListener('click', () => void this.#createInvitation());
    }
    if (this.#pendingCreation) {
      const resume = this.contentEl.createEl('button', {
        attr: { 'data-action': 'resume-invitation', type: 'button' },
        text: t('collab.access.resumeInvitation'),
      });
      resume.disabled = this.#operationPending;
      resume.addEventListener('click', () => void this.#resumeInvitationCreation());
    }
    if (this.#invitations.length === 0) {
      heading.insertAdjacentElement('afterend', this.contentEl.createDiv({
        text: this.#operationPending
          ? t('collab.access.loadingInvitations')
          : t('collab.access.noInvitations'),
      }));
    } else {
      const list = this.contentEl.createEl('ul', { cls: 'claudian-collab-access-list' });
      for (const invitation of this.#invitations) {
        const item = list.createEl('li', { cls: 'claudian-collab-access-member' });
        item.createSpan({ text: invitation.invitationId });
        item.createSpan({
          attr: { 'data-invitation-state': invitation.state },
          text: this.#invitationStateLabel(invitation.state),
        });
        const revoke = item.createEl('button', {
          attr: {
            'aria-label': `${t('collab.access.revokeInvitation')}: ${invitation.invitationId}`,
            'data-action': 'revoke-invitation',
            'data-invitation-id': invitation.invitationId,
            type: 'button',
          },
          text: t('collab.access.revokeInvitation'),
        });
        revoke.disabled = this.#operationPending
          || this.#managementReadFailed
          || this.#pendingCreation
          || invitation.state !== 'active';
        revoke.addEventListener('click', () => void this.#revokeInvitation(
          invitation.invitationId,
        ));
      }
    }
    if (this.#status) {
      this.contentEl.createDiv({
        attr: this.#status.kind === 'error' ? { role: 'alert' } : { role: 'status' },
        cls: `claudian-collab-access-status claudian-collab-access-status--${this.#status.kind}`,
        text: this.#status.text,
      });
    }
  }

  async #resumeInvitationCreation(): Promise<void> {
    if (!this.#pendingCreation || this.#operationPending) return;
    const generation = ++this.#operationGeneration;
    this.#operationPending = true;
    this.#render();
    const result = await this.#port.resumeManagementOperation(
      this.#options.projectId,
    );
    if (!this.#isCurrent(generation)) return;
    this.#operationPending = false;
    if (result.status !== 'success' || result.value.action !== 'create-invitation') {
      this.#status = { kind: 'error', text: t('collab.access.invitationFailed') };
      this.#render();
      return;
    }
    this.#pendingCreation = result.value.status === 'pending';
    if (result.value.status === 'result-retained' && result.value.invitation) {
      this.#invitation = result.value.invitation;
      this.#retainedResult = true;
    }
    this.#render();
  }

  #isCurrent(generation: number): boolean {
    return this.#opened
      && !this.#abortController.signal.aborted
      && generation === this.#operationGeneration;
  }

  #invitationStateLabel(state: CollabInvitationSummaryView['state']): string {
    return t(`collab.access.invitationStatus.${state}`);
  }
}
