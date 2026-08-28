import type { CollabMember, CollabMemberId } from '@claudian-collab/protocol';
import { type App, Modal } from 'obsidian';

import { type CollabFeaturePort, type CollabLanProjectSnapshot, type CollabLocalCleanupChoice, type CollabLocalProjectSummary, type CollabProjectSnapshot, isCollabLanProjectSnapshot } from '@/core/collab';
import { HostDiagnosticsModal } from '@/features/collab/modals/project/HostDiagnosticsModal';
import {
  type LanHostDiagnostics,
  LanHostSection,
} from '@/features/collab/modals/project/LanHostSection';
import { ProjectInvitationModal } from '@/features/collab/modals/project/ProjectInvitationModal';
import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';
import { confirm } from '@/shared/modals/ConfirmModal';

export type ProjectManagementModalPort = Pick<
  CollabFeaturePort,
  | 'acceptHostTransfer'
  | 'cancelHostTransfer'
  | 'cancelManagerResponsibilityOffer'
  | 'claimLegacyHostInstallation'
  | 'createInvitation'
  | 'createHostTransfer'
  | 'createManagerResponsibilityOffer'
  | 'declineHostTransfer'
  | 'demoteManager'
  | 'leaveProject'
  | 'promoteManager'
  | 'readSnapshot'
  | 'removeMember'
  | 'revokeInvitation'
  | 'retireProject'
  | 'startHost'
  | 'stopHost'
  | 'subscribe'
>;

export interface ProjectManagementModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly onChanged?: () => void;
  readonly onClosed?: () => void;
  readonly project: CollabLocalProjectSummary;
}

type AccessConfirmation =
  | {
    readonly cleanupChoice: CollabLocalCleanupChoice;
    readonly kind: 'leave';
    readonly managerResponsibilityOfferId?: string;
    readonly managerSuccessorRequired?: boolean;
    readonly member: CollabMember;
  }
  | { readonly kind: 'remove'; readonly member: CollabMember }
  | { readonly kind: 'retire'; readonly member: CollabMember }
  | { readonly kind: 'demote'; readonly member: CollabMember }
  | {
    readonly kind: 'promote';
    readonly member: CollabMember;
    readonly operation:
      | { readonly kind: 'create-offer' }
      | {
        readonly kind: 'complete-promotion';
        readonly managerResponsibilityOfferId: string;
      };
  };

interface AccessStatus {
  readonly kind: 'error' | 'success';
  readonly text: string;
}

type AccessMutationIntentKind = 'demote' | 'manager-offer' | 'promote' | 'remove';

export class ProjectManagementModal extends Modal {
  private accessContentEl: HTMLDivElement | null = null;
  private readonly appInstance: App;
  private abortController = new AbortController();
  private confirmation: AccessConfirmation | null = null;
  private currentMemberId: CollabMemberId | null = null;
  private featureSubscription: { dispose(): void } | null = null;
  private hostDiagnosticsModal: HostDiagnosticsModal | null = null;
  private hostMemberId: CollabMemberId | null = null;
  private hostProject: CollabLocalProjectSummary;
  private hostSection: LanHostSection | null = null;
  private invitationActionsEl: HTMLDivElement | null = null;
  private invitationModal: ProjectInvitationModal | null = null;
  private lifecycleActionsEl: HTMLDivElement | null = null;
  private members: readonly CollabMember[] = [];
  private readonly mutationIntents = new MutationIntentStore<AccessMutationIntentKind>();
  private opened = false;
  private operationPending = false;
  private readonly readTasks = new LatestTaskScope();
  private snapshot: CollabProjectSnapshot | null = null;
  private status: AccessStatus | null = null;

  constructor(
    app: App,
    private readonly port: ProjectManagementModalPort,
    private readonly options: ProjectManagementModalOptions,
  ) {
    super(app);
    this.appInstance = app;
    this.hostProject = options.project;
  }

  onOpen(): void {
    this.abortController = new AbortController();
    this.confirmation = null;
    this.currentMemberId = null;
    this.hostMemberId = null;
    this.hostProject = this.options.project;
    this.members = [];
    this.mutationIntents.clearAll();
    this.opened = true;
    this.operationPending = false;
    this.snapshot = null;
    this.status = null;
    this.setTitle(t('collab.projectManagement.title'));
    this.modalEl.classList.add('claudian-collab-project-management-modal');
    this.renderShell();
    this.featureSubscription = this.port.subscribe(state => {
      if (state.projects.find(project => project.id === this.options.project.id)?.lifecycle
        === 'retired') {
        this.close();
        return;
      }
      if (!this.opened || this.operationPending || !this.snapshot) return;
      void this.loadMembers();
    });
    void this.loadMembers();
  }

  onClose(): void {
    this.opened = false;
    this.abortController.abort();
    this.featureSubscription?.dispose();
    this.featureSubscription = null;
    this.readTasks.cancel();
    this.mutationIntents.clearAll();
    this.hostSection?.destroy();
    this.hostSection = null;
    this.hostDiagnosticsModal?.close();
    this.hostDiagnosticsModal = null;
    this.invitationModal?.close();
    this.invitationModal = null;
    this.snapshot = null;
    this.accessContentEl = null;
    this.invitationActionsEl = null;
    this.lifecycleActionsEl = null;
    this.contentEl.replaceChildren();
    this.options.onClosed?.();
  }

  private renderShell(): void {
    this.hostSection?.destroy();
    this.hostSection = null;
    this.contentEl.replaceChildren();
    this.accessContentEl = this.contentEl.createDiv({
      cls: 'claudian-collab-project-management-access',
    });
    const actions = this.contentEl.createDiv({
      cls: 'claudian-collab-project-actions',
    });
    const primary = actions.createDiv({
      cls: 'claudian-collab-project-actions-primary',
    });
    if (
      this.hostProject.authorityKind === 'lan'
      && this.hostProject.hostInstallationStatus !== 'not-host'
    ) {
      const host = primary.createDiv({ cls: 'claudian-collab-project-host-action' });
      this.hostSection = new LanHostSection(host, {
        confirmLegacyClaim: () => confirm(
          this.appInstance,
          t('collab.host.legacyClaimConfirmation'),
          t('collab.host.legacyClaimAction'),
        ),
        onOpenDiagnostics: diagnostics => this.openHostDiagnostics(diagnostics),
        onStatusChanged: status => {
          this.hostProject = { ...this.hostProject, hostStatus: status };
          if (status === 'running') void this.loadMembers();
          this.options.onChanged?.();
        },
        port: this.port,
        project: this.hostProject,
      });
    }
    this.invitationActionsEl = primary.createDiv({
      cls: 'claudian-collab-project-invitation-action',
    });
    this.lifecycleActionsEl = actions.createDiv({
      cls: 'claudian-collab-project-actions-lifecycle',
    });
  }

  private openHostDiagnostics(diagnostics: LanHostDiagnostics): void {
    if (this.hostDiagnosticsModal) return;
    const modal = new HostDiagnosticsModal(this.appInstance, {
      copyText: this.options.copyText,
      diagnostics,
      onClosed: () => {
        if (this.hostDiagnosticsModal === modal) this.hostDiagnosticsModal = null;
      },
      projectName: this.options.project.name,
    });
    this.hostDiagnosticsModal = modal;
    modal.open();
  }

  private async loadMembers(): Promise<void> {
    // Presentation reads own one latest-task lane: a superseding read cancels
    // the earlier authority read. Mutations retain application-owned admission.
    const task = this.readTasks.start();
    this.renderLoading();
    const result = await this.port.readSnapshot(
      this.options.project.id,
      { signal: task.signal },
    );
    if (!this.isReadCurrent(task)) return;
    if (result.status !== 'success') {
      this.renderLoadFailure();
      return;
    }
    if (result.value.source !== 'online' || result.value.stale) {
      this.renderLoadFailure();
      return;
    }
    if (result.value.syncState.status !== 'synchronized') {
      this.renderLoadFailure();
      return;
    }
    const snapshot = result.value.snapshot;
    if (!snapshot.members.some(member => member.id === snapshot.currentMember.id)) {
      this.renderLoadFailure();
      return;
    }
    if (
      this.currentMemberId !== null
      && this.currentMemberId !== snapshot.currentMember.id
    ) {
      this.mutationIntents.clearAll();
      this.confirmation = null;
      this.status = null;
    }
    this.currentMemberId = snapshot.currentMember.id;
    this.hostMemberId = snapshot.project.authorityKind === 'lan'
      ? snapshot.project.hostMemberId
      : null;
    this.members = snapshot.members.filter(member => member.status !== 'left');
    this.snapshot = snapshot;
    this.render();
  }

  private render(): void {
    if (!this.opened) return;
    const accessContent = this.requireAccessContent();
    accessContent.replaceChildren();
    const current = this.currentMember();
    const isManager = current?.role === 'manager' && current.status === 'active';

    this.renderMembers(current, isManager);
    this.renderProjectActions(current, isManager);
    this.renderStatus();
    if (this.confirmation) this.renderConfirmation(this.confirmation);
  }

  private renderMembers(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const section = this.requireAccessContent().createDiv({
      cls: 'claudian-collab-access-members',
    });
    const summary = section.createDiv({ cls: 'claudian-collab-access-summary' });
    summary.createEl('h3', {
      text: t('collab.access.memberCount', { count: this.members.length }),
    });
    summary.createSpan({
      cls: 'claudian-collab-access-manager-count',
      text: t('collab.access.managerCount', {
        count: this.members.filter(member => (
          member.role === 'manager' && member.status === 'active'
        )).length,
      }),
    });
    if (this.members.length === 0) {
      section.createDiv({ text: t('collab.access.noMembers') });
      return;
    }
    const list = section.createEl('ul', { cls: 'claudian-collab-access-list' });
    for (const member of this.members) {
      this.renderMember(list, member, current, isManager);
    }
  }

  private renderMember(
    list: HTMLUListElement,
    member: CollabMember,
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const item = list.createEl('li', {
      attr: { 'data-member-id': member.id },
      cls: 'claudian-collab-access-member',
    });
    const heading = item.createDiv({ cls: 'claudian-collab-access-member-heading' });
    heading.createSpan({
      attr: { title: member.displayName },
      cls: 'claudian-collab-access-member-name',
      text: member.displayName,
    });
    const badges = heading.createSpan({ cls: 'claudian-collab-access-badges' });
    if (member.role === 'manager') {
      this.renderBadge(badges, t('collab.access.manager'), 'manager');
    }
    if (member.id === this.hostMemberId) {
      this.renderBadge(badges, t('collab.access.host'));
    }
    if (member.id === this.currentMemberId) {
      this.renderBadge(badges, t('collab.access.you'));
    }
    this.renderBadge(badges, this.memberStatusLabel(member));

    if (member.id === this.currentMemberId) {
      if (this.lanSnapshot()) this.renderIncomingResponsibilityActions(item, member);
      return;
    }
    if (member.status !== 'active') return;
    const lanSnapshot = this.lanSnapshot();
    if (!lanSnapshot) return;

    const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
    if (isManager && member.role !== 'manager') {
      const pendingPromotion = lanSnapshot.managerResponsibilityOffer;
      const matchingPromotion = pendingPromotion?.purpose === 'manager-promotion'
        && pendingPromotion.sourceManagerMemberId === this.currentMemberId
        && pendingPromotion.targetMemberId === member.id
        ? pendingPromotion
        : undefined;
      if (matchingPromotion?.status === 'offered') {
        const waiting = actions.createEl('button', {
          attr: {
            'data-action': 'promotion-pending',
            'data-member-id': member.id,
            type: 'button',
          },
          text: t('collab.access.promotionPending'),
        });
        waiting.disabled = true;
      } else if (matchingPromotion?.status === 'acknowledged') {
        const complete = actions.createEl('button', {
          attr: {
            'data-action': 'complete-promotion',
            'data-member-id': member.id,
            type: 'button',
          },
          text: t('collab.access.completePromotion'),
        });
        complete.disabled = this.operationPending;
        complete.addEventListener('click', () => {
          this.showConfirmation({
            kind: 'promote',
            member,
            operation: {
              kind: 'complete-promotion',
              managerResponsibilityOfferId: matchingPromotion.offerId,
            },
          });
        });
      } else {
        const promote = actions.createEl('button', {
          attr: {
            'data-action': 'make-manager',
            'data-member-id': member.id,
            type: 'button',
          },
          text: t('collab.access.makeManager'),
        });
        promote.disabled = this.operationPending;
        promote.addEventListener('click', () => {
          this.showConfirmation({
            kind: 'promote',
            member,
            operation: { kind: 'create-offer' },
          });
        });
      }
    }
    if (this.currentMemberId === this.hostMemberId && !lanSnapshot.hostTransfer) {
      const transferHost = actions.createEl('button', {
        attr: {
          'data-action': 'offer-host-transfer',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.transferHost'),
      });
      transferHost.disabled = this.operationPending;
      transferHost.addEventListener('click', () => {
        void this.runLifecycleAction(() => this.port.createHostTransfer({
          projectId: this.options.project.id,
          targetMemberId: member.id,
        }, { signal: this.abortController.signal }));
      });
    }
    if (!isManager) return;
    if (member.role === 'manager') {
      const demote = actions.createEl('button', {
        attr: {
          'data-action': 'make-member',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.makeMember'),
      });
      demote.disabled = this.operationPending;
      demote.addEventListener('click', () => {
        this.showConfirmation({ kind: 'demote', member });
      });
    }
    const remove = actions.createEl('button', {
      attr: {
        'data-action': 'remove-member',
        'data-member-id': member.id,
        type: 'button',
      },
      text: t('collab.access.removeMember'),
    });
    const isHost = member.id === this.hostMemberId;
    remove.disabled = this.operationPending || isHost;
    remove.addEventListener('click', () => {
      this.showConfirmation({ kind: 'remove', member });
    });
    if (isHost) {
      item.createDiv({
        cls: 'claudian-collab-access-note',
        text: t('collab.access.hostRemovalBlocked'),
      });
    }
  }

  private renderLeaveAction(container: HTMLElement, member: CollabMember): void {
    if (member.status !== 'active') return;
    const leave = container.createEl('button', {
      attr: { 'data-action': 'leave-project', type: 'button' },
      text: t('collab.access.leaveProject'),
    });
    leave.disabled = this.operationPending;
    leave.addEventListener('click', () => {
      this.showConfirmation({ cleanupChoice: 'keep-files', kind: 'leave', member });
    });
  }

  private renderIncomingResponsibilityActions(
    item: HTMLLIElement,
    member: CollabMember,
  ): void {
    const managerOffer = this.lanSnapshot()?.managerResponsibilityOffer;
    if (
      managerOffer?.sourceManagerMemberId === member.id
      && (managerOffer.status === 'offered' || managerOffer.status === 'acknowledged')
    ) {
      const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
      this.createLifecycleButton(actions, 'cancel-manager-responsibility',
        managerOffer.purpose === 'manager-promotion'
          ? t('collab.access.cancelPromotion')
          : t('collab.access.cancelManagerSuccession'),
        () => this.port.cancelManagerResponsibilityOffer({
          offerId: managerOffer.offerId,
          projectId: this.options.project.id,
        }, { signal: this.abortController.signal }));
    }
    const hostTransfer = this.lanSnapshot()?.hostTransfer;
    if (member.id === this.hostMemberId && hostTransfer?.canCancel) {
      const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
      this.createLifecycleButton(actions, 'cancel-host-transfer',
        t('collab.access.cancelTransfer'), () => this.port.cancelHostTransfer({
          projectId: this.options.project.id,
          transferId: hostTransfer.transferId,
        }, { signal: this.abortController.signal }));
    }
    if (hostTransfer?.targetMemberId !== member.id || hostTransfer.phase !== 'offered') return;
    const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
    if (hostTransfer.canAccept) {
      this.createLifecycleButton(actions, 'accept-host-transfer',
        t('collab.access.acceptHost'), () => this.port.acceptHostTransfer({
          projectId: this.options.project.id,
          transferId: hostTransfer.transferId,
        }, { signal: this.abortController.signal }));
    }
    if (hostTransfer.canDecline) {
      this.createLifecycleButton(actions, 'decline-host-transfer',
        t('collab.access.decline'), () => this.port.declineHostTransfer({
          projectId: this.options.project.id,
          transferId: hostTransfer.transferId,
        }, { signal: this.abortController.signal }));
    }
  }

  private renderBadge(container: HTMLElement, text: string, role?: 'manager'): void {
    container.createSpan({
      attr: role ? { 'data-role': role } : undefined,
      cls: 'claudian-collab-access-badge',
      text,
    });
  }

  private renderProjectActions(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const invitationActions = this.requireInvitationActions();
    const lifecycleActions = this.requireLifecycleActions();
    invitationActions.replaceChildren();
    lifecycleActions.replaceChildren();
    if (!current || current.status !== 'active') return;
    if (!this.lanSnapshot()) return;
    if (isManager) {
      const invite = invitationActions.createEl('button', {
        attr: { 'data-action': 'create-invitation', type: 'button' },
        text: t('collab.access.createInvitation'),
      });
      invite.disabled = this.operationPending || !!this.invitationModal;
      invite.addEventListener('click', () => {
        this.openInvitationModal();
      });
    }
    this.renderLeaveAction(lifecycleActions, current);
    if (!isManager) return;
    const retire = lifecycleActions.createEl('button', {
      attr: { 'data-action': 'retire-project', type: 'button' },
      text: t('collab.access.retireProject'),
    });
    retire.disabled = this.operationPending;
    retire.addEventListener('click', () => {
      this.showConfirmation({ kind: 'retire', member: current });
    });
  }

  private openInvitationModal(): void {
    if (this.invitationModal) return;
    const modal = new ProjectInvitationModal(this.appInstance, this.port, {
      copyText: this.options.copyText,
      onClosed: () => {
        if (this.invitationModal !== modal) return;
        this.invitationModal = null;
        if (this.opened) this.refreshProjectActions();
      },
      projectId: this.options.project.id,
    });
    this.invitationModal = modal;
    modal.open();
    this.refreshProjectActions();
  }

  private refreshProjectActions(): void {
    const current = this.currentMember();
    this.renderProjectActions(
      current,
      current?.role === 'manager' && current.status === 'active',
    );
  }

  private renderCleanupChoices(
    container: HTMLElement,
    confirmation: Extract<AccessConfirmation, { readonly kind: 'leave' }>,
  ): void {
    const choices = container.createDiv({ cls: 'claudian-collab-cleanup-choices' });
    for (const choice of ['keep-files', 'delete-files'] as const) {
      const label = choices.createEl('label');
      const input = label.createEl('input', {
        attr: {
          name: 'leave-cleanup-choice',
          type: 'radio',
          value: choice,
        },
      });
      input.checked = confirmation.cleanupChoice === choice;
      input.disabled = this.operationPending;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.confirmation = { ...confirmation, cleanupChoice: choice };
      });
      label.createSpan({
        text: choice === 'keep-files'
          ? t('collab.retired.keepFiles')
          : t('collab.retired.deleteFiles'),
      });
    }
  }

  private renderManagerSuccessorSelection(
    container: HTMLElement,
    confirmation: Extract<AccessConfirmation, { readonly kind: 'leave' }>,
  ): void {
    const currentMemberId = this.requireCurrentMemberId();
    const offer = this.lanSnapshot()?.managerResponsibilityOffer;
    const leaveOffer = offer?.purpose === 'manager-leave'
      && offer.sourceManagerMemberId === currentMemberId
      && (offer.status === 'offered' || offer.status === 'acknowledged')
      ? offer
      : undefined;
    if (leaveOffer?.status === 'acknowledged') {
      container.createDiv({
        cls: 'claudian-collab-access-note',
        text: t('collab.access.managerSuccessorAcknowledged'),
      });
      return;
    }
    if (leaveOffer) {
      const target = this.members.find(member => member.id === leaveOffer.targetMemberId);
      container.createDiv({
        cls: 'claudian-collab-access-note',
        text: t('collab.access.waitingForManagerAcknowledgement', {
          name: target?.displayName ?? leaveOffer.targetMemberId,
        }),
      });
      return;
    }

    const selection = container.createDiv({
      cls: 'claudian-collab-manager-successor-selection',
    });
    selection.createDiv({ text: t('collab.access.chooseManagerSuccessor') });
    const actions = selection.createDiv({ cls: 'claudian-collab-access-actions' });
    for (const candidate of this.members) {
      if (candidate.id === currentMemberId || candidate.status !== 'active') continue;
      const button = actions.createEl('button', {
        attr: {
          'data-action': 'select-manager-successor',
          'data-member-id': candidate.id,
          type: 'button',
        },
        text: candidate.displayName,
      });
      button.disabled = this.operationPending;
      button.addEventListener('click', () => {
        const request = {
          projectId: this.options.project.id,
          purpose: 'manager-leave',
          targetMemberId: candidate.id,
        } as const;
        const intentId = this.mutationIntents.intent('manager-offer', request);
        void this.runLifecycleAction(() => this.port.createManagerResponsibilityOffer({
          ...request,
          intentId,
        }, { signal: this.abortController.signal }), () => {
          this.mutationIntents.clear('manager-offer', intentId);
        });
      });
    }
  }

  private createLifecycleButton(
    container: HTMLElement,
    action: string,
    text: string,
    operation: () => Promise<{ readonly status: string }>,
  ): void {
    const button = container.createEl('button', {
      attr: { 'data-action': action, type: 'button' },
      text,
    });
    button.disabled = this.operationPending;
    button.addEventListener('click', () => {
      void this.runLifecycleAction(operation);
    });
  }

  private async runLifecycleAction(
    operation: () => Promise<{ readonly status: string }>,
    onSuccess?: () => void,
  ): Promise<void> {
    if (this.operationPending) return;
    this.operationPending = true;
    this.render();
    const result = await operation();
    if (!this.opened || this.abortController.signal.aborted) return;
    this.operationPending = false;
    if (result.status !== 'success') {
      this.status = { kind: 'error', text: t('collab.access.actionFailed') };
      this.render();
      return;
    }
    onSuccess?.();
    this.options.onChanged?.();
    await this.loadMembers();
  }

  private async createManagerPromotion(
    confirmation: Extract<AccessConfirmation, { readonly kind: 'promote' }>,
    intentId: string,
  ) {
    if (confirmation.operation.kind === 'complete-promotion') {
      return this.port.promoteManager({
        intentId,
        managerResponsibilityOfferId: confirmation.operation.managerResponsibilityOfferId,
        projectId: this.options.project.id,
        targetMemberId: confirmation.member.id,
      }, { signal: this.abortController.signal });
    }
    return this.port.createManagerResponsibilityOffer({
      intentId,
      projectId: this.options.project.id,
      purpose: 'manager-promotion',
      targetMemberId: confirmation.member.id,
    }, { signal: this.abortController.signal });
  }

  private memberStatusLabel(member: CollabMember): string {
    switch (member.status) {
      case 'active':
        return t('collab.access.status.active');
      case 'pending':
        return t('collab.access.status.pending');
      case 'revoked':
        return t('collab.access.status.revoked');
      case 'left':
        return t('collab.access.status.left');
    }
  }

  private renderConfirmation(confirmation: AccessConfirmation): void {
    const region = this.requireAccessContent().createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-confirmation',
    });
    region.createDiv({ text: this.confirmationQuestion(confirmation) });
    if (confirmation.kind === 'remove') {
      region.createDiv({ text: t('collab.access.removedFilesRetained') });
    } else if (confirmation.kind === 'demote') {
      region.createDiv({ text: t('collab.access.demoteHostUnchanged') });
    } else if (confirmation.kind === 'leave') {
      region.createDiv({ text: t('collab.access.leaveCleanupWarning') });
      this.renderCleanupChoices(region, confirmation);
      if (confirmation.managerSuccessorRequired) {
        this.renderManagerSuccessorSelection(region, confirmation);
      }
    } else if (confirmation.kind === 'retire') {
      region.createDiv({ text: t('collab.access.retireWarning') });
    }
    const actions = region.createDiv({ cls: 'claudian-collab-access-actions' });
    const cancel = actions.createEl('button', {
      attr: { 'data-action': 'cancel-access-action', type: 'button' },
      text: t('common.cancel'),
    });
    cancel.disabled = this.operationPending;
    cancel.addEventListener('click', () => {
      this.discardConfirmationIntent(this.confirmation ?? confirmation);
      this.confirmation = null;
      this.status = null;
      this.render();
    });
    const confirm = actions.createEl('button', {
      attr: { 'data-action': 'confirm-access-action', type: 'button' },
      cls: confirmation.kind === 'promote' ? 'mod-cta' : 'mod-warning',
      text: this.status?.kind === 'error'
        ? t('collab.access.retry')
        : t('collab.access.confirm'),
    });
    const managerOffer = this.lanSnapshot()?.managerResponsibilityOffer;
    const acceptedLeaveOffer = confirmation.kind === 'leave'
      && confirmation.managerSuccessorRequired
      && managerOffer?.purpose === 'manager-leave'
      && managerOffer.sourceManagerMemberId === this.currentMemberId
      && managerOffer.status === 'acknowledged'
      ? managerOffer
      : undefined;
    confirm.disabled = this.operationPending
      || (confirmation.kind === 'leave'
        && confirmation.managerSuccessorRequired === true
        && !acceptedLeaveOffer);
    confirm.addEventListener('click', () => {
      const currentConfirmation = this.confirmation ?? confirmation;
      void this.confirmAccessAction(
        currentConfirmation.kind === 'leave' && acceptedLeaveOffer
          ? {
            ...currentConfirmation,
            managerResponsibilityOfferId: acceptedLeaveOffer.offerId,
          }
          : currentConfirmation,
      );
    });
  }

  private confirmationQuestion(confirmation: AccessConfirmation): string {
    switch (confirmation.kind) {
      case 'leave':
        return t('collab.access.confirmLeave');
      case 'remove':
        return t('collab.access.confirmRemove', {
          name: confirmation.member.displayName,
        });
      case 'demote':
        return t('collab.access.confirmDemote', {
          name: confirmation.member.displayName,
        });
      case 'promote':
        return t('collab.access.confirmPromote', {
          name: confirmation.member.displayName,
        });
      case 'retire':
        return t('collab.access.confirmRetire');
    }
  }

  private showConfirmation(confirmation: AccessConfirmation): void {
    if (this.operationPending) return;
    if (
      this.confirmation
      && this.confirmationWorkflowKey(this.confirmation)
        !== this.confirmationWorkflowKey(confirmation)
    ) {
      this.discardConfirmationIntent(this.confirmation);
    }
    this.confirmation = confirmation;
    this.status = null;
    this.render();
    this.requireAccessContent().querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.focus();
  }

  private confirmationWorkflowKey(confirmation: AccessConfirmation): string {
    if (confirmation.kind !== 'promote') {
      return `${confirmation.kind}:${confirmation.member.id}`;
    }
    return confirmation.operation.kind === 'complete-promotion'
      ? `${confirmation.kind}:${confirmation.member.id}:${confirmation.operation.kind}:${confirmation.operation.managerResponsibilityOfferId}`
      : `${confirmation.kind}:${confirmation.member.id}:${confirmation.operation.kind}`;
  }

  private confirmationIntent(
    confirmation: AccessConfirmation,
  ): { readonly intentId: string; readonly kind: AccessMutationIntentKind } | null {
    if (
      confirmation.kind !== 'promote'
      && confirmation.kind !== 'demote'
      && confirmation.kind !== 'remove'
    ) return null;
    const kind = confirmation.kind;
    const identity = kind === 'promote'
      ? {
        operation: confirmation.operation,
        projectId: this.options.project.id,
        targetMemberId: confirmation.member.id,
      }
      : {
        projectId: this.options.project.id,
        targetMemberId: confirmation.member.id,
      };
    return {
      intentId: this.mutationIntents.intent(kind, identity),
      kind,
    };
  }

  private discardConfirmationIntent(confirmation: AccessConfirmation): void {
    if (confirmation.kind === 'leave') {
      this.mutationIntents.discard('manager-offer');
    } else if (
      confirmation.kind === 'promote'
      || confirmation.kind === 'demote'
      || confirmation.kind === 'remove'
    ) {
      this.mutationIntents.discard(confirmation.kind);
    }
  }

  private async confirmAccessAction(
    confirmation: AccessConfirmation,
  ): Promise<void> {
    if (this.operationPending) return;
    this.operationPending = true;
    this.status = null;
    this.render();
    const mutationIntent = this.confirmationIntent(confirmation);
    const operation = confirmation.kind === 'leave'
      ? this.port.leaveProject({
        cleanupChoice: confirmation.cleanupChoice,
        ...(confirmation.managerResponsibilityOfferId === undefined ? {} : {
          managerResponsibilityOfferId: confirmation.managerResponsibilityOfferId,
        }),
        projectId: this.options.project.id,
      }, { signal: this.abortController.signal })
      : confirmation.kind === 'remove'
        ? this.port.removeMember({
          ...(mutationIntent ? { intentId: mutationIntent.intentId } : {}),
          memberId: confirmation.member.id,
          projectId: this.options.project.id,
        }, { signal: this.abortController.signal })
        : confirmation.kind === 'demote'
          ? this.port.demoteManager({
            ...(mutationIntent ? { intentId: mutationIntent.intentId } : {}),
            projectId: this.options.project.id,
            targetMemberId: confirmation.member.id,
          }, { signal: this.abortController.signal })
          : confirmation.kind === 'promote'
            ? this.createManagerPromotion(
              confirmation,
              mutationIntent?.intentId ?? this.mutationIntents.intent('promote', {
                operation: confirmation.operation,
                projectId: this.options.project.id,
                targetMemberId: confirmation.member.id,
              }),
            )
            : this.port.retireProject({
              expectedHostMemberId: this.requireHostMemberId(),
              managerActorMemberId: this.requireCurrentMemberId(),
              projectId: this.options.project.id,
            }, { signal: this.abortController.signal });
    const result = await operation;
    if (!this.opened || this.abortController.signal.aborted) return;
    this.operationPending = false;
    if (result.status !== 'success') {
      if (
        result.status === 'failure'
        && result.error.code === 'authorization-denied'
        && result.error.safeContext.reason === 'last-manager-required'
      ) {
        this.status = { kind: 'error', text: t('collab.access.lastManagerRequired') };
        this.render();
        return;
      }
      if (
        confirmation.kind === 'leave'
        && result.status === 'failure'
        && result.error.code === 'manager-responsibility-pending'
      ) {
        this.confirmation = { ...confirmation, managerSuccessorRequired: true };
        this.status = {
          kind: 'error',
          text: t('collab.access.managerSuccessorRequired'),
        };
        this.render();
        return;
      }
      if (
        confirmation.kind === 'leave'
        && result.status === 'failure'
        && result.error.code === 'host-transfer-pending'
      ) {
        this.status = { kind: 'error', text: t('collab.access.hostTransferRequired') };
        this.render();
        return;
      }
      this.status = { kind: 'error', text: t('collab.access.actionFailed') };
      this.render();
      return;
    }
    if (mutationIntent) {
      this.mutationIntents.clear(mutationIntent.kind, mutationIntent.intentId);
    }
    this.options.onChanged?.();
    if (confirmation.kind === 'leave' || confirmation.kind === 'retire') {
      this.close();
      return;
    }
    this.confirmation = null;
    this.status = { kind: 'success', text: t('collab.access.actionComplete') };
    await this.loadMembers();
  }

  private renderStatus(): void {
    if (!this.status) return;
    this.requireAccessContent().createDiv({
      attr: {
        'aria-live': 'polite',
        ...(this.status.kind === 'error' ? { role: 'alert' } : {}),
      },
      cls: `claudian-collab-access-status claudian-collab-access-status--${this.status.kind}`,
      text: this.status.text,
    });
  }

  private renderLoading(): void {
    if (!this.opened) return;
    const accessContent = this.requireAccessContent();
    accessContent.replaceChildren();
    accessContent.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-status',
      text: t('collab.access.loading'),
    });
  }

  private renderLoadFailure(): void {
    if (!this.opened) return;
    const accessContent = this.requireAccessContent();
    accessContent.replaceChildren();
    accessContent.createDiv({
      attr: { role: 'alert' },
      cls: 'claudian-collab-access-status claudian-collab-access-status--error',
      text: t('collab.access.loadFailed'),
    });
    const retry = accessContent.createEl('button', {
      attr: { 'data-action': 'retry-members', type: 'button' },
      text: t('collab.access.retry'),
    });
    retry.addEventListener('click', () => {
      void this.loadMembers();
    });
    retry.focus();
  }

  private currentMember(): CollabMember | undefined {
    return this.members.find(member => member.id === this.currentMemberId);
  }

  private lanSnapshot(): CollabLanProjectSnapshot | null {
    return this.snapshot && isCollabLanProjectSnapshot(this.snapshot)
      ? this.snapshot
      : null;
  }

  private requireCurrentMemberId(): CollabMemberId {
    if (!this.currentMemberId) {
      throw new Error('Current Collab Member identity is unavailable');
    }
    return this.currentMemberId;
  }

  private requireHostMemberId(): CollabMemberId {
    if (!this.hostMemberId) {
      throw new Error('Current Collab Host identity is unavailable');
    }
    return this.hostMemberId;
  }

  private requireAccessContent(): HTMLDivElement {
    if (!this.accessContentEl) {
      throw new Error('Project management content is not mounted');
    }
    return this.accessContentEl;
  }

  private requireInvitationActions(): HTMLDivElement {
    if (!this.invitationActionsEl) {
      throw new Error('Project invitation actions are not mounted');
    }
    return this.invitationActionsEl;
  }

  private requireLifecycleActions(): HTMLDivElement {
    if (!this.lifecycleActionsEl) {
      throw new Error('Project lifecycle actions are not mounted');
    }
    return this.lifecycleActionsEl;
  }

  private isReadCurrent(task: LatestTaskHandle): boolean {
    return this.opened
      && !this.abortController.signal.aborted
      && task.isCurrent();
  }
}
