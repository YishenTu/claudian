import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES,
  type CollabAuthorityTransferStatus,
  type CollabMember,
  type CollabMemberId,
} from '@claudian-collab/protocol';
import { type App, Modal } from 'obsidian';

import {
  type CollabCloudToLanTargetPreparationDescriptor,
  type CollabCloudToLanTransferHandle,
  type CollabCloudToLanTransferView,
  type CollabFeaturePort,
  type CollabInvitationView,
  type CollabLanProjectSnapshot,
  type CollabLanToCloudTransferView,
  type CollabLocalCleanupChoice,
  type CollabLocalProjectSummary,
  type CollabManagementOperationView,
  type CollabManagerResponsibilityOfferSummary,
  type CollabMemberSummaryView,
  type CollabOperationOptions,
  type CollabProjectCapabilities,
  type CollabProjectSnapshot,
  isCollabLanProjectSnapshot,
} from '@/core/collab';
import { HostDiagnosticsModal } from '@/features/collab/modals/project/HostDiagnosticsModal';
import {
  type LanHostDiagnostics,
  LanHostSection,
} from '@/features/collab/modals/project/LanHostSection';
import { ProjectInvitationModal } from '@/features/collab/modals/project/ProjectInvitationModal';
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
  | 'cancelCloudToLanTransfer'
  | 'cancelLanToCloudTransfer'
  | 'cancelManagerResponsibilityOffer'
  | 'claimLegacyHostInstallation'
  | 'completeManagementOperation'
  | 'createInvitation'
  | 'createHostTransfer'
  | 'createManagerResponsibilityOffer'
  | 'declineHostTransfer'
  | 'demoteManager'
  | 'leaveProject'
  | 'listInvitations'
  | 'listManagerResponsibilityOffers'
  | 'listMembers'
  | 'observeCloudToLanTransfer'
  | 'prepareCloudToLanTarget'
  | 'proposeLanToCloudTransfer'
  | 'promoteManager'
  | 'readLanToCloudTransfer'
  | 'readCloudToLanTransfer'
  | 'readManagementOperation'
  | 'readProjectCapabilities'
  | 'readSnapshot'
  | 'reissueMemberClaim'
  | 'removeMember'
  | 'revokeMemberClaim'
  | 'revokeInvitation'
  | 'retireProject'
  | 'resumeManagementOperation'
  | 'startHost'
  | 'stopHost'
  | 'subscribe'
  | 'acceptLanToCloudTransfer'
  | 'acceptCloudToLanTransfer'
  | 'beginCloudToLanTransfer'
  | 'withdrawCloudToLanTarget'
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

export class ProjectManagementModal extends Modal {
  #accessContentEl: HTMLDivElement | null = null;
  readonly #appInstance: App;
  #abortController = new AbortController();
  #confirmation: AccessConfirmation | null = null;
  #capabilities: CollabProjectCapabilities | null = null;
  #cloudTargetDescriptor: CollabCloudToLanTargetPreparationDescriptor | null = null;
  #cloudTransferHandle: CollabCloudToLanTransferHandle | null = null;
  #cloudTransferStatus: CollabAuthorityTransferStatus | null = null;
  #cloudTransferView: CollabCloudToLanTransferView | null = null;
  #currentMemberId: CollabMemberId | null = null;
  #featureSubscription: { dispose(): void } | null = null;
  #hostDiagnosticsModal: HostDiagnosticsModal | null = null;
  #hostMemberId: CollabMemberId | null = null;
  #hostProject: CollabLocalProjectSummary;
  #hostSection: LanHostSection | null = null;
  #invitationActionsEl: HTMLDivElement | null = null;
  #invitationModal: ProjectInvitationModal | null = null;
  #lifecycleActionsEl: HTMLDivElement | null = null;
  #managerOffers: readonly CollabManagerResponsibilityOfferSummary[] = [];
  #managementOperation: CollabManagementOperationView | null = null;
  #lanToCloudProposal: CollabLanToCloudTransferView | null = null;
  #memberSummaries = new Map<CollabMemberId, CollabMemberSummaryView>();
  #members: readonly CollabMember[] = [];
  #opened = false;
  #operationPending = false;
  readonly #readTasks = new LatestTaskScope();
  #retainedInvitation: CollabInvitationView | null = null;
  #snapshot: CollabProjectSnapshot | null = null;
  #status: AccessStatus | null = null;
  readonly #port: ProjectManagementModalPort;
  readonly #options: ProjectManagementModalOptions;

  constructor(
    app: App,
    port: ProjectManagementModalPort,
    options: ProjectManagementModalOptions,
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
    this.#appInstance = app;
    this.#hostProject = options.project;
  }

  onOpen(): void {
    this.#abortController = new AbortController();
    this.#confirmation = null;
    this.#capabilities = null;
    this.#cloudTargetDescriptor = null;
    this.#cloudTransferHandle = null;
    this.#cloudTransferStatus = null;
    this.#cloudTransferView = null;
    this.#currentMemberId = null;
    this.#hostMemberId = null;
    this.#hostProject = this.#options.project;
    this.#members = [];
    this.#managerOffers = [];
    this.#managementOperation = null;
    this.#lanToCloudProposal = null;
    this.#memberSummaries.clear();
    this.#opened = true;
    this.#operationPending = false;
    this.#retainedInvitation = null;
    this.#snapshot = null;
    this.#status = null;
    this.setTitle(t('collab.projectManagement.title'));
    this.modalEl.classList.add('claudian-collab-project-management-modal');
    this.#renderShell();
    const featureSubscription = this.#port.subscribe(state => {
      if (state.selectedProjectId !== this.#options.project.id) {
        this.close();
        return;
      }
      const projected = state.projects.find(project => project.id === this.#options.project.id);
      if (projected?.lifecycle === 'retired') {
        this.close();
        return;
      }
      if (projected && projected.authorityKind !== this.#hostProject.authorityKind) {
        this.#hostProject = projected;
        this.#snapshot = null;
        this.#capabilities = null;
        this.#renderShell();
        if (this.#opened && !this.#operationPending) void this.#loadMembers();
        return;
      }
      if (projected) this.#hostProject = projected;
      if (!this.#opened || this.#operationPending || !this.#snapshot) return;
      void this.#loadMembers();
    });
    if (!this.#opened) {
      featureSubscription.dispose();
      return;
    }
    this.#featureSubscription = featureSubscription;
    void this.#loadMembers();
  }

  onClose(): void {
    this.#opened = false;
    this.#abortController.abort();
    this.#featureSubscription?.dispose();
    this.#featureSubscription = null;
    this.#readTasks.cancel();
    this.#abandonLanManagementIntent();
    this.#hostSection?.destroy();
    this.#hostSection = null;
    this.#hostDiagnosticsModal?.close();
    this.#hostDiagnosticsModal = null;
    this.#invitationModal?.close();
    this.#invitationModal = null;
    this.#snapshot = null;
    this.#accessContentEl = null;
    this.#invitationActionsEl = null;
    this.#lifecycleActionsEl = null;
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  #renderShell(): void {
    this.#hostSection?.destroy();
    this.#hostSection = null;
    this.contentEl.replaceChildren();
    this.#accessContentEl = this.contentEl.createDiv({
      cls: 'claudian-collab-project-management-access',
    });
    const actions = this.contentEl.createDiv({
      cls: 'claudian-collab-project-actions',
    });
    const primary = actions.createDiv({
      cls: 'claudian-collab-project-actions-primary',
    });
    if (
      this.#hostProject.authorityKind === 'lan'
      && this.#hostProject.hostInstallationStatus !== 'not-host'
    ) {
      const host = primary.createDiv({ cls: 'claudian-collab-project-host-action' });
      this.#hostSection = new LanHostSection(host, {
        confirmLegacyClaim: () => confirm(
          this.#appInstance,
          t('collab.host.legacyClaimConfirmation'),
          t('collab.host.legacyClaimAction'),
        ),
        onOpenDiagnostics: diagnostics => this.#openHostDiagnostics(diagnostics),
        onStatusChanged: status => {
          this.#hostProject = { ...this.#hostProject, hostStatus: status };
          if (status === 'running') void this.#loadMembers();
          this.#options.onChanged?.();
        },
        port: this.#port,
        project: this.#hostProject,
      });
    }
    this.#invitationActionsEl = primary.createDiv({
      cls: 'claudian-collab-project-invitation-action',
    });
    this.#lifecycleActionsEl = actions.createDiv({
      cls: 'claudian-collab-project-actions-lifecycle',
    });
  }

  #openHostDiagnostics(diagnostics: LanHostDiagnostics): void {
    if (this.#hostDiagnosticsModal) return;
    const modal = new HostDiagnosticsModal(this.#appInstance, {
      copyText: this.#options.copyText,
      diagnostics,
      onClosed: () => {
        if (this.#hostDiagnosticsModal === modal) this.#hostDiagnosticsModal = null;
      },
      projectName: this.#options.project.name,
    });
    this.#hostDiagnosticsModal = modal;
    modal.open();
  }

  async #loadMembers(): Promise<void> {
    // Presentation reads own one latest-task lane: a superseding read cancels
    // the earlier authority read. Mutations retain application-owned admission.
    const task = this.#readTasks.start();
    this.#renderLoading();
    const [
      result,
      capabilities,
      lanToCloudProposal,
      cloudToLanTransfer,
      managementOperation,
    ] = await Promise.all([
      this.#port.readSnapshot(this.#options.project.id, { signal: task.signal }),
      this.#port.readProjectCapabilities(
        this.#options.project.id,
        { signal: task.signal },
      ),
      this.#hostProject.authorityKind === 'lan'
        ? this.#port.readLanToCloudTransfer(
          this.#options.project.id,
          { signal: task.signal },
        )
        : Promise.resolve({ status: 'success' as const, value: null }),
      this.#hostProject.authorityKind === 'cloud'
        ? this.#port.readCloudToLanTransfer(
          this.#options.project.id,
          { signal: task.signal },
        )
        : Promise.resolve({ status: 'success' as const, value: null }),
      this.#hostProject.authorityKind === 'cloud'
        ? this.#port.readManagementOperation(
          this.#options.project.id,
          { signal: task.signal },
        )
        : Promise.resolve({ status: 'success' as const, value: null }),
    ]);
    if (!this.#isReadCurrent(task)) return;
    if (lanToCloudProposal.status === 'success') {
      this.#lanToCloudProposal = lanToCloudProposal.value;
    }
    if (cloudToLanTransfer.status === 'success') {
      this.#applyCloudTransferView(cloudToLanTransfer.value);
    }
    if (managementOperation.status === 'success') {
      this.#applyManagementOperation(managementOperation.value);
    }
    if (result.status !== 'success' || capabilities.status !== 'success') {
      this.#renderLoadFailure();
      return;
    }
    if (result.value.source !== 'online' || result.value.stale) {
      this.#renderLoadFailure();
      return;
    }
    if (result.value.syncState.status !== 'synchronized') {
      this.#renderLoadFailure();
      return;
    }
    const snapshot = result.value.snapshot;
    if (snapshot.project.authorityKind !== capabilities.value.authorityKind) {
      this.#renderLoadFailure();
      return;
    }
    if (!snapshot.members.some(member => member.id === snapshot.currentMember.id)) {
      this.#renderLoadFailure();
      return;
    }
    if (
      this.#currentMemberId !== null
      && this.#currentMemberId !== snapshot.currentMember.id
    ) {
      this.#abandonLanManagementIntent();
      this.#confirmation = null;
      this.#status = null;
    }
    this.#currentMemberId = snapshot.currentMember.id;
    this.#capabilities = capabilities.value;
    if (
      capabilities.value.authorityTransfer
      && capabilities.value.authorityKind === 'lan'
      && lanToCloudProposal.status !== 'success'
    ) {
      this.#renderLoadFailure();
      return;
    }
    if (
      capabilities.value.authorityTransfer
      && capabilities.value.authorityKind === 'cloud'
      && cloudToLanTransfer.status !== 'success'
    ) {
      this.#renderLoadFailure();
      return;
    }
    if (
      capabilities.value.authorityTransfer
      && lanToCloudProposal.status === 'success'
    ) {
      this.#lanToCloudProposal = lanToCloudProposal.value;
    }
    this.#hostMemberId = snapshot.project.authorityKind === 'lan'
      ? snapshot.project.hostMemberId
      : null;
    this.#members = snapshot.members.filter(member => member.status !== 'left');
    this.#memberSummaries.clear();
    this.#managerOffers = [];
    if (
      snapshot.project.authorityKind === 'cloud'
      && capabilities.value.membershipManagement
    ) {
      const listed = await this.#port.listMembers(
        this.#options.project.id,
        { signal: task.signal },
      );
      if (!this.#isReadCurrent(task)) return;
      if (listed.status !== 'success') {
        this.#renderLoadFailure();
        return;
      }
      this.#memberSummaries = new Map(listed.value.map(member => [member.memberId, member]));
    }
    if (
      snapshot.project.authorityKind === 'cloud'
      && capabilities.value.managerResponsibility
    ) {
      const offers = await this.#port.listManagerResponsibilityOffers(
        this.#options.project.id,
        { signal: task.signal },
      );
      if (!this.#isReadCurrent(task)) return;
      if (offers.status !== 'success') {
        this.#renderLoadFailure();
        return;
      }
      this.#managerOffers = offers.value;
    }
    if (snapshot.project.authorityKind === 'cloud') {
      if (managementOperation.status !== 'success') {
        this.#renderLoadFailure();
        return;
      }
    }
    this.#snapshot = snapshot;
    this.#render();
  }

  #applyCloudTransferView(view: CollabCloudToLanTransferView | null): void {
    this.#cloudTransferView = view;
    this.#cloudTargetDescriptor = view?.target?.descriptor ?? view?.manager?.descriptor ?? null;
    this.#cloudTransferHandle = view?.manager?.handle ?? view?.target?.handle ?? null;
    this.#cloudTransferStatus = view?.manager?.status ?? view?.target?.status ?? null;
  }

  #applyManagementOperation(operation: CollabManagementOperationView | null): void {
    this.#managementOperation = operation;
    this.#retainedInvitation = operation?.action === 'reissue-member-claim'
      && operation.status === 'result-retained'
      ? operation.invitation
      : null;
  }

  #render(): void {
    if (!this.#opened) return;
    const accessContent = this.#requireAccessContent();
    accessContent.replaceChildren();
    const current = this.#currentMember();
    const isManager = current?.role === 'manager' && current.status === 'active';

    this.#renderMembers(current, isManager);
    this.#renderProjectActions(current, isManager);
    this.#renderAuthorityTransfer(current, isManager);
    this.#renderPendingManagementOperation();
    this.#renderStatus();
    this.#renderRetainedInvitation();
    if (this.#confirmation) this.#renderConfirmation(this.#confirmation);
  }

  #renderMembers(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const section = this.#requireAccessContent().createDiv({
      cls: 'claudian-collab-access-members',
    });
    const summary = section.createDiv({ cls: 'claudian-collab-access-summary' });
    summary.createEl('h3', {
      text: t('collab.access.memberCount', { count: this.#members.length }),
    });
    summary.createSpan({
      cls: 'claudian-collab-access-manager-count',
      text: t('collab.access.managerCount', {
        count: this.#members.filter(member => (
          member.role === 'manager' && member.status === 'active'
        )).length,
      }),
    });
    if (this.#members.length === 0) {
      section.createDiv({ text: t('collab.access.noMembers') });
      return;
    }
    const list = section.createEl('ul', { cls: 'claudian-collab-access-list' });
    for (const member of this.#members) {
      this.#renderMember(list, member, current, isManager);
    }
  }

  #renderMember(
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
      this.#renderBadge(badges, t('collab.access.manager'), 'manager');
    }
    if (member.id === this.#hostMemberId) {
      this.#renderBadge(badges, t('collab.access.host'));
    }
    if (member.id === this.#currentMemberId) {
      this.#renderBadge(badges, t('collab.access.you'));
    }
    this.#renderBadge(badges, this.#memberStatusLabel(member));

    if (member.id === this.#currentMemberId) {
      if (this.#capabilities?.managerResponsibility || this.#lanSnapshot()) {
        this.#renderIncomingResponsibilityActions(item, member);
      }
      return;
    }
    if (member.status !== 'active') return;
    const lanSnapshot = this.#lanSnapshot();
    const canManageMembership = this.#capabilities?.membershipManagement === true;
    const canManageResponsibility = this.#capabilities?.managerResponsibility === true;
    if (!lanSnapshot && !canManageMembership && !canManageResponsibility) return;

    const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
    const summary = this.#memberSummaries.get(member.id);
    if (
      isManager
      && this.#capabilities?.importedMemberClaims
      && summary?.importedClaim
      && summary.importedClaim.bindingState === 'unbound'
    ) {
      const reissue = actions.createEl('button', {
        attr: {
          'aria-label': `${t('collab.access.reissueMemberClaim')}: ${member.displayName}`,
          'data-action': 'reissue-member-claim',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.reissueMemberClaim'),
      });
      reissue.disabled = this.#managementActionBlocked();
      reissue.addEventListener('click', () => void this.#reissueMemberClaim(member.id));
      const revokeClaim = actions.createEl('button', {
        attr: {
          'aria-label': `${t('collab.access.revokeMemberClaim')}: ${member.displayName}`,
          'data-action': 'revoke-member-claim',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.revokeMemberClaim'),
      });
      revokeClaim.disabled = this.#managementActionBlocked()
        || summary.importedClaim.state === 'revoked';
      revokeClaim.addEventListener('click', () => {
        void this.#runLifecycleAction(() => this.#port.revokeMemberClaim({
          memberId: member.id,
          projectId: this.#options.project.id,
        }));
      });
    }
    if (
      isManager
      && canManageMembership
      && canManageResponsibility
      && member.role !== 'manager'
    ) {
      const matchingPromotion = this.#managerResponsibilityOffer(offer => (
        offer.purpose === 'manager-promotion'
        && offer.sourceManagerMemberId === this.#currentMemberId
        && offer.targetMemberId === member.id
      ));
      if (matchingPromotion?.status === 'offered') {
        const waiting = actions.createEl('button', {
          attr: {
            'aria-label': `${t('collab.access.promotionPending')}: ${member.displayName}`,
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
            'aria-label': `${t('collab.access.completePromotion')}: ${member.displayName}`,
            'data-action': 'complete-promotion',
            'data-member-id': member.id,
            type: 'button',
          },
          text: t('collab.access.completePromotion'),
        });
        complete.disabled = this.#managementActionBlocked();
        complete.addEventListener('click', () => {
          this.#showConfirmation({
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
            'aria-label': `${t('collab.access.makeManager')}: ${member.displayName}`,
            'data-action': 'make-manager',
            'data-member-id': member.id,
            type: 'button',
          },
          text: t('collab.access.makeManager'),
        });
        promote.disabled = this.#managementActionBlocked();
        promote.addEventListener('click', () => {
          this.#showConfirmation({
            kind: 'promote',
            member,
            operation: { kind: 'create-offer' },
          });
        });
      }
    }
    if (lanSnapshot && this.#currentMemberId === this.#hostMemberId && !lanSnapshot.hostTransfer) {
      const transferHost = actions.createEl('button', {
        attr: {
          'aria-label': `${t('collab.access.transferHost')}: ${member.displayName}`,
          'data-action': 'offer-host-transfer',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.transferHost'),
      });
      transferHost.disabled = this.#managementActionBlocked();
      transferHost.addEventListener('click', () => {
        void this.#runLifecycleAction(() => this.#port.createHostTransfer({
          projectId: this.#options.project.id,
          targetMemberId: member.id,
        }, ...this.#transientOperationOptions()));
      });
    }
    if (!isManager || !canManageMembership) return;
    if (member.role === 'manager') {
      const demote = actions.createEl('button', {
        attr: {
          'aria-label': `${t('collab.access.makeMember')}: ${member.displayName}`,
          'data-action': 'make-member',
          'data-member-id': member.id,
          type: 'button',
        },
        text: t('collab.access.makeMember'),
      });
      demote.disabled = this.#managementActionBlocked();
      demote.addEventListener('click', () => {
        this.#showConfirmation({ kind: 'demote', member });
      });
    }
    const remove = actions.createEl('button', {
      attr: {
        'aria-label': `${t('collab.access.removeMember')}: ${member.displayName}`,
        'data-action': 'remove-member',
        'data-member-id': member.id,
        type: 'button',
      },
      text: t('collab.access.removeMember'),
    });
    const isHost = member.id === this.#hostMemberId;
    remove.disabled = this.#managementActionBlocked() || isHost;
    remove.addEventListener('click', () => {
      this.#showConfirmation({ kind: 'remove', member });
    });
    if (isHost) {
      item.createDiv({
        cls: 'claudian-collab-access-note',
        text: t('collab.access.hostRemovalBlocked'),
      });
    }
  }

  #renderLeaveAction(container: HTMLElement): void {
    const leave = container.createEl('button', {
      attr: { 'data-action': 'leave-project', type: 'button' },
      text: t('collab.access.leaveProject'),
    });
    leave.disabled = this.#managementActionBlocked();
    leave.addEventListener('click', () => {
      this.#showConfirmation({ cleanupChoice: 'keep-files', kind: 'leave' });
    });
  }

  #renderIncomingResponsibilityActions(
    item: HTMLLIElement,
    member: CollabMember,
  ): void {
    const managerOffer = this.#lanSnapshot()?.managerResponsibilityOffer;
    const effectiveManagerOffer = managerOffer ?? this.#managerResponsibilityOffer(offer => (
      offer.sourceManagerMemberId === member.id
    ));
    if (
      effectiveManagerOffer?.sourceManagerMemberId === member.id
      && (effectiveManagerOffer.status === 'offered'
        || effectiveManagerOffer.status === 'acknowledged')
    ) {
      const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
      this.#createLifecycleButton(actions, 'cancel-manager-responsibility',
        effectiveManagerOffer.purpose === 'manager-promotion'
          ? t('collab.access.cancelPromotion')
          : t('collab.access.cancelManagerSuccession'),
        () => this.#port.cancelManagerResponsibilityOffer({
          offerId: effectiveManagerOffer.offerId,
          projectId: this.#options.project.id,
        }, ...this.#transientOperationOptions()));
    }
    const hostTransfer = this.#lanSnapshot()?.hostTransfer;
    if (member.id === this.#hostMemberId && hostTransfer?.canCancel) {
      const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
      this.#createLifecycleButton(actions, 'cancel-host-transfer',
        t('collab.access.cancelTransfer'), () => this.#port.cancelHostTransfer({
          projectId: this.#options.project.id,
          transferId: hostTransfer.transferId,
        }, ...this.#transientOperationOptions()));
    }
    if (hostTransfer?.targetMemberId !== member.id || hostTransfer.phase !== 'offered') return;
    const actions = item.createDiv({ cls: 'claudian-collab-access-actions' });
    if (hostTransfer.canAccept) {
      this.#createLifecycleButton(actions, 'accept-host-transfer',
        t('collab.access.acceptHost'), () => this.#port.acceptHostTransfer({
          projectId: this.#options.project.id,
          transferId: hostTransfer.transferId,
        }, ...this.#transientOperationOptions()));
    }
    if (hostTransfer.canDecline) {
      this.#createLifecycleButton(actions, 'decline-host-transfer',
        t('collab.access.decline'), () => this.#port.declineHostTransfer({
          projectId: this.#options.project.id,
          transferId: hostTransfer.transferId,
        }, ...this.#transientOperationOptions()));
    }
  }

  #renderBadge(container: HTMLElement, text: string, role?: 'manager'): void {
    container.createSpan({
      attr: role ? { 'data-role': role } : undefined,
      cls: 'claudian-collab-access-badge',
      text,
    });
  }

  #renderProjectActions(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const invitationActions = this.#requireInvitationActions();
    const lifecycleActions = this.#requireLifecycleActions();
    invitationActions.replaceChildren();
    lifecycleActions.replaceChildren();
    if (!current || current.status !== 'active') return;
    const recoversInvitation = this.#managementOperation?.action === 'create-invitation';
    if (isManager && (this.#capabilities?.invitations || recoversInvitation)) {
      const invite = invitationActions.createEl('button', {
        attr: { 'data-action': 'create-invitation', type: 'button' },
        text: recoversInvitation
          ? t('collab.access.resumeInvitation')
          : t('collab.access.createInvitation'),
      });
      invite.disabled = this.#operationPending
        || !!this.#invitationModal
        || (this.#managementOperation !== null && !recoversInvitation);
      invite.addEventListener('click', () => {
        this.#openInvitationModal();
      });
    }
    if (this.#capabilities?.leave) this.#renderLeaveAction(lifecycleActions);
    if (!isManager || !this.#capabilities?.retirement) return;
    const retire = lifecycleActions.createEl('button', {
      attr: { 'data-action': 'retire-project', type: 'button' },
      text: t('collab.access.retireProject'),
    });
    retire.disabled = this.#managementActionBlocked();
    retire.addEventListener('click', () => {
      this.#showConfirmation({ kind: 'retire', member: current });
    });
  }

  #openInvitationModal(): void {
    if (this.#invitationModal) return;
    const modal = new ProjectInvitationModal(this.#appInstance, this.#port, {
      authorityKind: this.#capabilities?.authorityKind ?? this.#options.project.authorityKind,
      copyText: this.#options.copyText,
      onClosed: () => {
        if (this.#invitationModal !== modal) return;
        this.#invitationModal = null;
        if (this.#opened) this.#refreshProjectActions();
      },
      projectId: this.#options.project.id,
    });
    this.#invitationModal = modal;
    modal.open();
    this.#refreshProjectActions();
  }

  #refreshProjectActions(): void {
    const current = this.#currentMember();
    this.#renderProjectActions(
      current,
      current?.role === 'manager' && current.status === 'active',
    );
  }

  #renderCleanupChoices(
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
      input.disabled = this.#managementActionBlocked();
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.#confirmation = { ...confirmation, cleanupChoice: choice };
      });
      label.createSpan({
        text: choice === 'keep-files'
          ? t('collab.retired.keepFiles')
          : t('collab.retired.deleteFiles'),
      });
    }
  }

  #renderManagerSuccessorSelection(
    container: HTMLElement,
    confirmation: Extract<AccessConfirmation, { readonly kind: 'leave' }>,
  ): void {
    const currentMemberId = this.#requireCurrentMemberId();
    const leaveOffer = this.#managerResponsibilityOffer(offer => (
      offer.purpose === 'manager-leave'
      && offer.sourceManagerMemberId === currentMemberId
    ));
    if (leaveOffer?.status === 'acknowledged') {
      container.createDiv({
        cls: 'claudian-collab-access-note',
        text: t('collab.access.managerSuccessorAcknowledged'),
      });
      return;
    }
    if (leaveOffer) {
      const target = this.#members.find(member => member.id === leaveOffer.targetMemberId);
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
    for (const candidate of this.#members) {
      if (candidate.id === currentMemberId || candidate.status !== 'active') continue;
      const button = actions.createEl('button', {
        attr: {
          'data-action': 'select-manager-successor',
          'data-member-id': candidate.id,
          type: 'button',
        },
        text: candidate.displayName,
      });
      button.disabled = this.#managementActionBlocked();
      button.addEventListener('click', () => {
        const request = {
          projectId: this.#options.project.id,
          purpose: 'manager-leave',
          targetMemberId: candidate.id,
        } as const;
        void this.#runLifecycleAction(() => this.#port.createManagerResponsibilityOffer(
          request,
          ...this.#transientOperationOptions(),
        ));
      });
    }
  }

  #createLifecycleButton(
    container: HTMLElement,
    action: string,
    text: string,
    operation: () => Promise<{ readonly status: string }>,
    onSuccess?: () => void,
    allowDurableManagement = false,
  ): void {
    const button = container.createEl('button', {
      attr: { 'data-action': action, type: 'button' },
      text,
    });
    button.disabled = this.#operationPending
      || (!allowDurableManagement && this.#managementOperation !== null);
    button.addEventListener('click', () => {
      void this.#runLifecycleAction(operation, onSuccess);
    });
  }

  async #runLifecycleAction(
    operation: () => Promise<{ readonly status: string }>,
    onSuccess?: () => void,
  ): Promise<void> {
    if (this.#operationPending) return;
    this.#operationPending = true;
    this.#render();
    const result = await operation();
    if (!this.#opened || this.#abortController.signal.aborted) return;
    this.#operationPending = false;
    if (result.status !== 'success') {
      this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
      this.#render();
      return;
    }
    onSuccess?.();
    this.#options.onChanged?.();
    await this.#loadMembers();
  }

  async #createManagerPromotion(
    confirmation: Extract<AccessConfirmation, { readonly kind: 'promote' }>,
  ) {
    if (confirmation.operation.kind === 'complete-promotion') {
      return this.#port.promoteManager({
        managerResponsibilityOfferId: confirmation.operation.managerResponsibilityOfferId,
        projectId: this.#options.project.id,
        targetMemberId: confirmation.member.id,
      }, ...this.#transientOperationOptions());
    }
    return this.#port.createManagerResponsibilityOffer({
      projectId: this.#options.project.id,
      purpose: 'manager-promotion',
      targetMemberId: confirmation.member.id,
    }, ...this.#transientOperationOptions());
  }

  #memberStatusLabel(member: CollabMember): string {
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

  #renderConfirmation(confirmation: AccessConfirmation): void {
    const region = this.#requireAccessContent().createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-confirmation',
    });
    region.createDiv({ text: this.#confirmationQuestion(confirmation) });
    if (confirmation.kind === 'remove') {
      region.createDiv({ text: t('collab.access.removedFilesRetained') });
    } else if (confirmation.kind === 'demote') {
      region.createDiv({ text: t('collab.access.demoteHostUnchanged') });
    } else if (confirmation.kind === 'leave') {
      region.createDiv({ text: t('collab.access.leaveCleanupWarning') });
      this.#renderCleanupChoices(region, confirmation);
      if (confirmation.managerSuccessorRequired) {
        this.#renderManagerSuccessorSelection(region, confirmation);
      }
    } else if (confirmation.kind === 'retire') {
      region.createDiv({ text: t('collab.access.retireWarning') });
    }
    const actions = region.createDiv({ cls: 'claudian-collab-access-actions' });
    const cancel = actions.createEl('button', {
      attr: { 'data-action': 'cancel-access-action', type: 'button' },
      text: t('common.cancel'),
    });
    cancel.disabled = this.#managementActionBlocked();
    cancel.addEventListener('click', () => {
      this.#abandonLanManagementIntent();
      this.#confirmation = null;
      this.#status = null;
      this.#render();
    });
    const confirm = actions.createEl('button', {
      attr: { 'data-action': 'confirm-access-action', type: 'button' },
      cls: confirmation.kind === 'promote' ? 'mod-cta' : 'mod-warning',
      text: this.#status?.kind === 'error'
        ? t('collab.access.retry')
        : t('collab.access.confirm'),
    });
    const managerOffer = this.#managerResponsibilityOffer(offer => (
      offer.purpose === 'manager-leave'
      && offer.sourceManagerMemberId === this.#currentMemberId
    ));
    const acceptedLeaveOffer = confirmation.kind === 'leave'
      && confirmation.managerSuccessorRequired
      && managerOffer?.purpose === 'manager-leave'
      && managerOffer.sourceManagerMemberId === this.#currentMemberId
      && managerOffer.status === 'acknowledged'
      ? managerOffer
      : undefined;
    confirm.disabled = this.#managementActionBlocked()
      || (confirmation.kind === 'leave'
        && confirmation.managerSuccessorRequired === true
        && !acceptedLeaveOffer);
    confirm.addEventListener('click', () => {
      const currentConfirmation = this.#confirmation ?? confirmation;
      void this.#confirmAccessAction(
        currentConfirmation.kind === 'leave' && acceptedLeaveOffer
          ? {
            ...currentConfirmation,
            managerResponsibilityOfferId: acceptedLeaveOffer.offerId,
          }
          : currentConfirmation,
      );
    });
  }

  #confirmationQuestion(confirmation: AccessConfirmation): string {
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

  #showConfirmation(confirmation: AccessConfirmation): void {
    if (this.#operationPending) return;
    if (
      this.#confirmation
      && this.#confirmationWorkflowKey(this.#confirmation)
        !== this.#confirmationWorkflowKey(confirmation)
    ) {
      this.#abandonLanManagementIntent();
    }
    this.#confirmation = confirmation;
    this.#status = null;
    this.#render();
    this.#requireAccessContent().querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.focus();
  }

  #confirmationWorkflowKey(confirmation: AccessConfirmation): string {
    if (confirmation.kind === 'leave') {
      return `leave:${this.#options.project.id}`;
    }
    if (confirmation.kind !== 'promote') {
      return `${confirmation.kind}:${confirmation.member.id}`;
    }
    return confirmation.operation.kind === 'complete-promotion'
      ? `${confirmation.kind}:${confirmation.member.id}:${confirmation.operation.kind}:${confirmation.operation.managerResponsibilityOfferId}`
      : `${confirmation.kind}:${confirmation.member.id}:${confirmation.operation.kind}`;
  }

  #abandonLanManagementIntent(): void {
    if (this.#hostProject.authorityKind !== 'lan') return;
    void this.#port.completeManagementOperation({ projectId: this.#options.project.id });
  }

  async #confirmAccessAction(
    confirmation: AccessConfirmation,
  ): Promise<void> {
    if (this.#operationPending) return;
    this.#operationPending = true;
    this.#status = null;
    this.#render();
    const operation = confirmation.kind === 'leave'
      ? this.#port.leaveProject({
        cleanupChoice: confirmation.cleanupChoice,
        ...(confirmation.managerResponsibilityOfferId === undefined ? {} : {
          managerResponsibilityOfferId: confirmation.managerResponsibilityOfferId,
        }),
        projectId: this.#options.project.id,
      }, ...this.#transientOperationOptions())
      : confirmation.kind === 'remove'
        ? this.#port.removeMember({
          memberId: confirmation.member.id,
          projectId: this.#options.project.id,
        }, ...this.#transientOperationOptions())
        : confirmation.kind === 'demote'
          ? this.#port.demoteManager({
            projectId: this.#options.project.id,
            targetMemberId: confirmation.member.id,
          }, ...this.#transientOperationOptions())
          : confirmation.kind === 'promote'
            ? this.#createManagerPromotion(confirmation)
            : this.#port.retireProject({
              projectId: this.#options.project.id,
            }, ...this.#transientOperationOptions());
    const result = await operation;
    if (!this.#opened || this.#abortController.signal.aborted) return;
    this.#operationPending = false;
    if (result.status !== 'success') {
      if (
        result.status === 'failure'
        && result.error.code === 'authorization-denied'
        && result.error.safeContext.reason === 'last-manager-required'
      ) {
        this.#status = { kind: 'error', text: t('collab.access.lastManagerRequired') };
        this.#render();
        return;
      }
      if (
        confirmation.kind === 'leave'
        && result.status === 'failure'
        && result.error.code === 'manager-responsibility-pending'
      ) {
        this.#confirmation = { ...confirmation, managerSuccessorRequired: true };
        this.#status = {
          kind: 'error',
          text: t('collab.access.managerSuccessorRequired'),
        };
        this.#render();
        return;
      }
      if (
        confirmation.kind === 'leave'
        && result.status === 'failure'
        && result.error.code === 'host-transfer-pending'
      ) {
        this.#status = { kind: 'error', text: t('collab.access.hostTransferRequired') };
        this.#render();
        return;
      }
      this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
      this.#render();
      return;
    }
    this.#options.onChanged?.();
    if (confirmation.kind === 'leave' || confirmation.kind === 'retire') {
      this.close();
      return;
    }
    this.#confirmation = null;
    this.#status = { kind: 'success', text: t('collab.access.actionComplete') };
    await this.#loadMembers();
  }

  #renderStatus(): void {
    if (!this.#status) return;
    this.#requireAccessContent().createDiv({
      attr: {
        'aria-live': 'polite',
        ...(this.#status.kind === 'error' ? { role: 'alert' } : {}),
      },
      cls: `claudian-collab-access-status claudian-collab-access-status--${this.#status.kind}`,
      text: this.#status.text,
    });
  }

  #renderAuthorityTransfer(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    if (!current || current.status !== 'active') return;
    const actionsAvailable = this.#capabilities?.authorityTransfer === true;
    if (!actionsAvailable && !this.#lanToCloudProposal && !this.#cloudTransferView) return;
    const section = this.#requireAccessContent().createDiv({
      cls: 'claudian-collab-authority-transfer',
    });
    section.createEl('h3', { text: t('collab.access.authorityTransfer') });
    if (this.#hostProject.authorityKind === 'lan') {
      this.#renderLanToCloudTransfer(section, actionsAvailable);
      return;
    }
    this.#renderCloudToLanTransfer(section, current.id, isManager, actionsAvailable);
  }

  #renderLanToCloudTransfer(section: HTMLElement, actionsAvailable = true): void {
    const proposal = this.#lanToCloudProposal;
    if (proposal) {
      section.createDiv({
        text: t('collab.access.lanToCloudProposal', {
          phase: this.#transferStatusLabel(proposal.status),
          url: proposal.serverUrl,
        }),
      });
      if (
        actionsAvailable
        && proposal.sourceOwned
        && this.#hostProject.hostInstallationStatus === 'hosted-here'
        && proposal.status?.state === 'active'
      ) {
        const actions = section.createDiv({ cls: 'claudian-collab-access-actions' });
        this.#createTransferButton(actions, 'accept-lan-to-cloud',
          t('collab.access.acceptLanToCloud'), async () => {
            const result = await this.#port.acceptLanToCloudTransfer(
              {
                projectId: this.#options.project.id,
                transferId: proposal.status!.transferId,
              },
            );
            if (result.status === 'success') this.#lanToCloudProposal = {
              ...proposal,
              status: result.value,
            };
            if (result.status === 'success') this.#finishTerminalTransfer(result.value);
            return result;
          });
        if (this.#isTransferCancellable(proposal.status)) {
          this.#createTransferButton(actions, 'cancel-lan-to-cloud',
            t('collab.access.cancelTransfer'), async () => {
              const result = await this.#port.cancelLanToCloudTransfer(
                {
                  projectId: this.#options.project.id,
                  transferId: proposal.status!.transferId,
                },
              );
              if (result.status === 'success') this.#lanToCloudProposal = {
                ...proposal,
                status: result.value,
              };
              if (result.status === 'success') this.#finishTerminalTransfer(result.value);
              return result;
            });
        }
      }
      if (proposal.status?.state !== 'cancelled' && proposal.status !== null) return;
    }
    if (!actionsAvailable) return;
    const row = section.createDiv({ cls: 'claudian-collab-join-field' });
    const id = 'claudian-collab-lan-to-cloud-server-url';
    row.createEl('label', { attr: { for: id }, text: t('collab.access.cloudServerUrl') });
    const input = row.createEl('input', {
      attr: {
        'data-field': 'lan-to-cloud-server-url',
        id,
        inputmode: 'url',
        placeholder: t('collab.access.cloudServerUrlPlaceholder'),
        type: 'text',
      },
    });
    if (proposal?.status === null) input.value = proposal.serverUrl;
    const propose = row.createEl('button', {
      attr: { 'data-action': 'propose-lan-to-cloud', type: 'button' },
      text: proposal?.status === null
        ? t('collab.joinProject.resume')
        : t('collab.access.proposeLanToCloud'),
    });
    propose.disabled = this.#managementActionBlocked() || !input.value.trim();
    input.addEventListener('input', () => {
      propose.disabled = this.#managementActionBlocked() || !input.value.trim();
    });
    propose.addEventListener('click', () => {
      const serverUrl = input.value;
      void this.#runTransferAction(async () => {
        const result = await this.#port.proposeLanToCloudTransfer({
          projectId: this.#options.project.id,
          serverUrl,
        });
        if (result.status === 'success') this.#lanToCloudProposal = {
          proposedByMemberId: proposal?.proposedByMemberId ?? this.#requireCurrentMemberId(),
          serverUrl,
          sourceOwned: this.#hostProject.hostInstallationStatus === 'hosted-here',
          status: result.value,
        };
        return result;
      });
    });
  }

  #renderCloudToLanTransfer(
    section: HTMLElement,
    currentMemberId: CollabMemberId,
    isManager: boolean,
    actionsAvailable = true,
  ): void {
    const managerView = this.#cloudTransferView?.manager ?? null;
    const targetSelectedElsewhere = managerView !== null
      && managerView.descriptor.selectedTargetMemberId !== currentMemberId;
    if (!actionsAvailable) {
      const recovery = section.createDiv({ cls: 'claudian-collab-authority-transfer-target' });
      if (this.#cloudTargetDescriptor) {
        this.#renderJsonValue(recovery, this.#cloudTargetDescriptor,
          t('collab.access.cloudToLanDescriptor'), 'copy-cloud-to-lan-descriptor');
      }
      if (this.#cloudTransferHandle) {
        this.#renderJsonValue(recovery, this.#cloudTransferHandle,
          t('collab.access.cloudToLanHandle'), 'copy-cloud-to-lan-handle');
      }
      if (this.#cloudTransferStatus) {
        recovery.createDiv({ text: this.#transferStatusLabel(this.#cloudTransferStatus) });
      } else {
        recovery.createDiv({ text: this.#transferStatusLabel(null) });
      }
      recovery.createDiv({ text: t('collab.access.transferConnectionRequired') });
      return;
    }
    if (!targetSelectedElsewhere) {
      const targetView = this.#cloudTransferView?.target ?? null;
      const target = section.createDiv({ cls: 'claudian-collab-authority-transfer-target' });
      target.createEl('h4', { text: t('collab.access.cloudToLanTarget') });
      if (!this.#cloudTargetDescriptor) {
        this.#createTransferButton(target, 'prepare-cloud-to-lan',
          t('collab.access.prepareCloudToLan'), async () => {
            const result = await this.#port.prepareCloudToLanTarget(
              { projectId: this.#options.project.id },
            );
            if (result.status === 'success') this.#cloudTargetDescriptor = result.value;
            return result;
          });
      } else {
        this.#renderJsonValue(target, this.#cloudTargetDescriptor,
          t('collab.access.cloudToLanDescriptor'), 'copy-cloud-to-lan-descriptor');
        if (!targetView || targetView.canWithdraw) {
          this.#createTransferButton(target, 'withdraw-cloud-to-lan-target',
            t('collab.access.withdrawCloudToLan'), async () => {
              const result = await this.#port.withdrawCloudToLanTarget({
                preparationId: this.#cloudTargetDescriptor!.preparationId,
                projectId: this.#options.project.id,
              });
              if (result.status === 'success') this.#applyCloudTransferView(null);
              return result;
            });
        }
      }

      const acceptField = this.#renderJsonInput(
        section,
        'cloud-to-lan-handle',
        t('collab.access.cloudToLanHandle'),
      );
      const accept = this.#createTransferButton(section, 'accept-cloud-to-lan',
        t('collab.access.acceptCloudToLan'), async () => {
          try {
            const result = await this.#port.acceptCloudToLanTransfer(
              JSON.parse(acceptField.value) as CollabCloudToLanTransferHandle,
            );
            if (result.status === 'success') {
              this.#cloudTransferStatus = result.value;
              this.#finishTerminalTransfer(result.value);
            }
            return result;
          } catch {
            return Promise.resolve({ status: 'failure' as const, error: new Error() as never });
          }
      });
      if (targetView?.handle) acceptField.value = JSON.stringify(targetView.handle);
      if (!isManager && (this.#cloudTransferStatus ?? targetView?.status)) {
        target.createDiv({
          text: this.#transferStatusLabel(this.#cloudTransferStatus ?? targetView!.status),
        });
      }
      accept.disabled = this.#managementActionBlocked() || !acceptField.value.trim();
      acceptField.addEventListener('input', () => {
        accept.disabled = this.#managementActionBlocked() || !acceptField.value.trim();
      });
    }

    if (!isManager) return;
    const manager = section.createDiv({ cls: 'claudian-collab-authority-transfer-manager' });
    manager.createEl('h4', { text: t('collab.access.cloudToLanManager') });
    const descriptor = this.#renderJsonInput(
      manager,
      'cloud-to-lan-descriptor',
      t('collab.access.cloudToLanDescriptor'),
    );
    if (managerView) descriptor.value = JSON.stringify(managerView.descriptor);
    if (!this.#cloudTransferHandle) {
      const begin = this.#createTransferButton(manager, 'begin-cloud-to-lan',
        t('collab.access.beginCloudToLan'), async () => {
          try {
            const result = await this.#port.beginCloudToLanTransfer({
              descriptor: JSON.parse(
                descriptor.value,
              ) as CollabCloudToLanTargetPreparationDescriptor,
            });
            if (result.status === 'success') this.#cloudTransferHandle = result.value;
            return result;
          } catch {
            return { status: 'failure' as const, error: new Error() as never };
          }
        });
      begin.disabled = this.#managementActionBlocked() || !descriptor.value.trim();
      descriptor.addEventListener('input', () => {
        begin.disabled = this.#managementActionBlocked() || !descriptor.value.trim();
      });
    }
    if (!this.#cloudTransferHandle) return;
    this.#renderJsonValue(manager, this.#cloudTransferHandle,
      t('collab.access.cloudToLanHandle'), 'copy-cloud-to-lan-handle');
    if (this.#cloudTransferStatus) {
      manager.createDiv({ text: this.#transferStatusLabel(this.#cloudTransferStatus) });
    }
    this.#createTransferButton(manager, 'observe-cloud-to-lan',
      t('collab.access.observeTransfer'), async () => {
        const result = await this.#port.observeCloudToLanTransfer(
          this.#options.project.id,
        );
        if (result.status === 'success') {
          this.#cloudTransferStatus = result.value;
          this.#finishTerminalTransfer(result.value);
        }
        return result;
      });
    if (this.#cloudTransferStatus && this.#isTransferCancellable(this.#cloudTransferStatus)) {
      this.#createTransferButton(manager, 'cancel-cloud-to-lan',
        t('collab.access.cancelTransfer'), async () => {
          const result = await this.#port.cancelCloudToLanTransfer(
            this.#cloudTransferHandle!,
          );
          if (result.status === 'success') {
            this.#cloudTransferStatus = result.value;
            this.#finishTerminalTransfer(result.value);
          }
          return result;
        });
    }
  }

  #transferStatusLabel(status: CollabAuthorityTransferStatus | null): string {
    if (!status) return t('collab.access.transferStatus.pending');
    if (status.state === 'completed') return t('collab.access.transferStatus.completed');
    if (status.state === 'cancelled') return t('collab.access.transferStatus.cancelled');
    return t('collab.access.transferStatus.active');
  }

  #renderJsonInput(
    container: HTMLElement,
    field: string,
    label: string,
  ): HTMLTextAreaElement {
    const id = `claudian-collab-${field}`;
    container.createEl('label', { attr: { for: id }, text: label });
    return container.createEl('textarea', {
      attr: { 'data-field': field, id, rows: '4' },
    });
  }

  #renderJsonValue(
    container: HTMLElement,
    value: unknown,
    label: string,
    action: string,
  ): void {
    const encoded = JSON.stringify(value);
    container.createEl('textarea', {
      attr: { 'aria-label': label, readonly: 'true', rows: '4' },
      text: encoded,
    });
    const copy = container.createEl('button', {
      attr: {
        'aria-label': `${t('collab.access.copyTransferData')}: ${label}`,
        'data-action': action,
        type: 'button',
      },
      text: t('collab.access.copyTransferData'),
    });
    copy.disabled = !this.#options.copyText;
    copy.addEventListener('click', () => void this.#options.copyText?.(encoded));
  }

  #createTransferButton(
    container: HTMLElement,
    action: string,
    text: string,
    operation: () => Promise<{ readonly status: string }>,
  ): HTMLButtonElement {
    const button = container.createEl('button', {
      attr: { 'data-action': action, type: 'button' },
      text,
    });
    button.disabled = this.#managementActionBlocked();
    button.addEventListener('click', () => void this.#runTransferAction(operation));
    return button;
  }

  async #runTransferAction(
    operation: () => Promise<{ readonly status: string }>,
  ): Promise<void> {
    if (this.#operationPending) return;
    this.#operationPending = true;
    this.#status = null;
    this.#renderCurrentView();
    const result = await operation();
    if (!this.#opened || this.#abortController.signal.aborted) return;
    this.#operationPending = false;
    if (result.status === 'recovery-required') {
      await this.#refreshAuthorityTransferView();
      if (!this.#opened || this.#abortController.signal.aborted) return;
    }
    this.#status = result.status === 'success'
      ? { kind: 'success', text: t('collab.access.transferUpdated') }
      : result.status === 'recovery-required'
        ? { kind: 'error', text: t('collab.joinProject.resumeRequired') }
        : { kind: 'error', text: t('collab.access.actionFailed') };
    this.#renderCurrentView();
  }

  #renderCurrentView(): void {
    if (this.#snapshot) this.#render();
    else this.#renderLoadFailure();
  }

  #transientOperationOptions(): [] | [CollabOperationOptions] {
    return this.#hostProject.authorityKind === 'lan'
      ? [{ signal: this.#abortController.signal }]
      : [];
  }

  #managementActionBlocked(): boolean {
    return this.#operationPending || this.#managementOperation !== null;
  }

  async #refreshCloudTransferView(): Promise<void> {
    const result = await this.#port.readCloudToLanTransfer(
      this.#options.project.id,
      { signal: this.#abortController.signal },
    );
    if (result.status === 'success') this.#applyCloudTransferView(result.value);
  }

  async #refreshAuthorityTransferView(): Promise<void> {
    if (this.#hostProject.authorityKind === 'lan') {
      const result = await this.#port.readLanToCloudTransfer(
        this.#options.project.id,
        { signal: this.#abortController.signal },
      );
      if (result.status === 'success') this.#lanToCloudProposal = result.value;
      return;
    }
    await this.#refreshCloudTransferView();
  }

  #finishTerminalTransfer(status: CollabAuthorityTransferStatus): void {
    if (status.state !== 'cancelled' && status.state !== 'completed') return;
    this.#options.onChanged?.();
    this.close();
  }

  #isTransferCancellable(status: CollabAuthorityTransferStatus): boolean {
    return status.state === 'active'
      && COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES.includes(status.phase as never);
  }

  #renderPendingManagementOperation(): void {
    const operation = this.#managementOperation;
    if (!operation || operation.action === 'create-invitation') return;
    if (operation.status === 'pending') {
      this.#createLifecycleButton(
        this.#requireAccessContent(),
        'resume-management-operation',
        t('collab.joinProject.resume'),
        () => this.#resumeManagementOperation(),
        undefined,
        true,
      );
      return;
    }
    if (operation.action !== 'reissue-member-claim') {
      this.#createLifecycleButton(
        this.#requireAccessContent(),
        'complete-management-operation',
        t('collab.access.finishOperation'),
        () => this.#port.completeManagementOperation({
          projectId: this.#options.project.id,
        }),
        () => { this.#managementOperation = null; },
        true,
      );
    }
  }

  async #resumeManagementOperation(): Promise<{ readonly status: string }> {
    const result = await this.#port.resumeManagementOperation(
      this.#options.project.id,
    );
    if (result.status !== 'success') return result;
    this.#managementOperation = result.value;
    this.#retainedInvitation = result.value.action === 'reissue-member-claim'
      && result.value.status === 'result-retained'
      ? result.value.invitation
      : null;
    return result;
  }

  #renderRetainedInvitation(): void {
    if (!this.#retainedInvitation) return;
    const region = this.#requireAccessContent().createDiv({
      cls: 'claudian-collab-access-claim',
    });
    region.createEl('textarea', {
      attr: {
        'aria-label': t('collab.access.memberClaim'),
        readonly: 'true',
        rows: '4',
      },
      text: this.#retainedInvitation.encodedInvitation,
    });
    const copy = region.createEl('button', {
      attr: { 'data-action': 'copy-member-claim', type: 'button' },
      text: t('collab.access.copyMemberClaim'),
    });
    copy.disabled = this.#operationPending || !this.#options.copyText;
    copy.addEventListener('click', () => void this.#copyRetainedInvitation());
  }

  async #reissueMemberClaim(memberId: CollabMemberId): Promise<void> {
    if (this.#operationPending) return;
    this.#operationPending = true;
    this.#status = null;
    this.#render();
    const result = await this.#port.reissueMemberClaim({
      memberId,
      projectId: this.#options.project.id,
    });
    if (!this.#opened || this.#abortController.signal.aborted) return;
    this.#operationPending = false;
    if (result.status === 'success') {
      this.#retainedInvitation = result.value;
      this.#status = { kind: 'success', text: t('collab.access.memberClaimReady') };
    } else {
      this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
    }
    this.#render();
  }

  async #copyRetainedInvitation(): Promise<void> {
    if (!this.#retainedInvitation || !this.#options.copyText || this.#operationPending) return;
    this.#operationPending = true;
    this.#render();
    try {
      await this.#options.copyText(this.#retainedInvitation.encodedInvitation);
      if (!this.#opened || this.#abortController.signal.aborted) return;
      const completed = await this.#port.completeManagementOperation(
        { projectId: this.#options.project.id },
      );
      if (!this.#opened || this.#abortController.signal.aborted) return;
      if (completed.status !== 'success') {
        this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
        return;
      }
      this.#retainedInvitation = null;
      this.#status = { kind: 'success', text: t('collab.access.memberClaimCopied') };
    } catch {
      if (this.#opened && !this.#abortController.signal.aborted) {
        this.#status = { kind: 'error', text: t('collab.access.copyFailed') };
      }
    } finally {
      if (this.#opened && !this.#abortController.signal.aborted) {
        this.#operationPending = false;
        this.#render();
      }
    }
  }

  #renderLoading(): void {
    if (!this.#opened) return;
    this.#clearProjectActions();
    const accessContent = this.#requireAccessContent();
    accessContent.replaceChildren();
    accessContent.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-status',
      text: t('collab.access.loading'),
    });
  }

  #renderLoadFailure(): void {
    if (!this.#opened) return;
    this.#clearProjectActions();
    const accessContent = this.#requireAccessContent();
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
      void this.#loadMembers();
    });
    if (
      this.#hostProject.authorityKind === 'cloud'
      && this.#hostProject.role === 'member'
      && this.#hostProject.lifecycle !== 'leaving'
      && this.#hostProject.lifecycle !== 'retired'
    ) {
      const lifecycle = accessContent.createDiv({
        cls: 'claudian-collab-project-actions-lifecycle',
      });
      this.#renderLeaveAction(lifecycle);
    }
    if (this.#cloudTransferView) {
      const transfer = accessContent.createDiv({
        cls: 'claudian-collab-authority-transfer',
      });
      transfer.createEl('h3', { text: t('collab.access.authorityTransfer') });
      this.#renderCloudToLanTransfer(
        transfer,
        this.#cloudTransferView.target?.descriptor?.selectedTargetMemberId ?? '',
        this.#cloudTransferView.manager !== null,
      );
    }
    if (this.#lanToCloudProposal) {
      const transfer = accessContent.createDiv({
        cls: 'claudian-collab-authority-transfer',
      });
      transfer.createEl('h3', { text: t('collab.access.authorityTransfer') });
      this.#renderLanToCloudTransfer(transfer);
    }
    this.#renderPendingManagementOperation();
    this.#renderStatus();
    this.#renderRetainedInvitation();
    retry.focus();
  }

  #clearProjectActions(): void {
    this.#invitationActionsEl?.replaceChildren();
    this.#lifecycleActionsEl?.replaceChildren();
  }

  #currentMember(): CollabMember | undefined {
    return this.#members.find(member => member.id === this.#currentMemberId);
  }

  #lanSnapshot(): CollabLanProjectSnapshot | null {
    return this.#snapshot && isCollabLanProjectSnapshot(this.#snapshot)
      ? this.#snapshot
      : null;
  }

  #managerResponsibilityOffer(
    matches: (offer: CollabManagerResponsibilityOfferSummary) => boolean = () => true,
  ): CollabManagerResponsibilityOfferSummary | undefined {
    const lanOffer = this.#lanSnapshot()?.managerResponsibilityOffer;
    if (
      lanOffer
      && (lanOffer.status === 'offered' || lanOffer.status === 'acknowledged')
      && matches(lanOffer)
    ) return lanOffer;
    return this.#managerOffers.find(offer => (
        (offer.status === 'offered' || offer.status === 'acknowledged')
        && matches(offer)
      ));
  }

  #requireCurrentMemberId(): CollabMemberId {
    if (!this.#currentMemberId) {
      throw new Error('Current Collab Member identity is unavailable');
    }
    return this.#currentMemberId;
  }

  #requireAccessContent(): HTMLDivElement {
    if (!this.#accessContentEl) {
      throw new Error('Project management content is not mounted');
    }
    return this.#accessContentEl;
  }

  #requireInvitationActions(): HTMLDivElement {
    if (!this.#invitationActionsEl) {
      throw new Error('Project invitation actions are not mounted');
    }
    return this.#invitationActionsEl;
  }

  #requireLifecycleActions(): HTMLDivElement {
    if (!this.#lifecycleActionsEl) {
      throw new Error('Project lifecycle actions are not mounted');
    }
    return this.#lifecycleActionsEl;
  }

  #isReadCurrent(task: LatestTaskHandle): boolean {
    return this.#opened
      && !this.#abortController.signal.aborted
      && task.isCurrent();
  }
}
