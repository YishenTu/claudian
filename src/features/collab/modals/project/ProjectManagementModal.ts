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
  type CollabOperationOptions,
  type CollabProjectCapabilities,
  type CollabProjectSnapshot,
  type CollabResult,
  isCollabLanProjectSnapshot,
} from '@/core/collab';
import { HostDestinationModal } from '@/features/collab/modals/project/HostDestinationModal';
import { HostDiagnosticsModal } from '@/features/collab/modals/project/HostDiagnosticsModal';
import {
  type LanHostDiagnostics,
  LanHostSection,
  type LanHostTransferAction,
} from '@/features/collab/modals/project/LanHostSection';
import { ProjectInvitationModal } from '@/features/collab/modals/project/ProjectInvitationModal';
import { ProjectManagementSession } from '@/features/collab/modals/project/ProjectManagementSession';
import { t } from '@/i18n/i18n';
import { confirm } from '@/shared/modals/ConfirmModal';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ProjectManagementModalPort = Pick<
  CollabFeaturePort,
  | 'acceptHostTransfer'
  | 'cancelHostTransfer'
  | 'cancelCloudToLanTransfer'
  | 'cancelLanToCloudTransfer'
  | 'cancelManagerResponsibilityOffer'
  | 'claimLegacyHostInstallation'
  | 'completeManagementOperation'
  | 'openInvitation'
  | 'createHostTransfer'
  | 'createManagerResponsibilityOffer'
  | 'declineHostTransfer'
  | 'demoteManager'
  | 'leaveProject'
  | 'listInvitations'
  | 'listManagerResponsibilityOffers'
  | 'listMembers'
  | 'observeCloudToLanTransfer'
  | 'moveCloudToLan'
  | 'moveLanToCloud'
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
  | 'observeProject'
  | 'acceptLanToCloudTransfer'
  | 'acceptCloudToLanTransfer'
  | 'beginCloudToLanTransfer'
  | 'withdrawCloudToLanTarget'
>;

export interface ProjectManagementModalOptions {
  readonly copyText?: (text: string) => Promise<void>;
  readonly onChanged?: () => void;
  readonly onClosed?: () => void;
  readonly onReconnect?: (project: CollabLocalProjectSummary) => void;
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
  | { readonly kind: 'promote'; readonly member: CollabMember; readonly operation:
    | { readonly kind: 'direct' | 'create-offer' }
    | { readonly kind: 'complete-promotion'; readonly managerResponsibilityOfferId: string };
  };

type TransferDraftField = 'lan-to-cloud-server-url';

interface AccessStatus {
  readonly kind: 'error' | 'success';
  readonly text: string;
}

export class ProjectManagementModal extends Modal {
  #accessContentEl: HTMLDivElement | null = null;
  readonly #appInstance: App;
  #confirmation: AccessConfirmation | null = null;
  #cloudLanDestination: 'this-device' | 'another-device' | null = null;
  #hostDestinationModal: HostDestinationModal | null = null;
  #hostDiagnosticsModal: HostDiagnosticsModal | null = null;
  #hostActionEl: HTMLDivElement | null = null;
  #hostSection: LanHostSection | null = null;
  #membersSectionEl: HTMLDivElement | null = null;
  #invitationActionsEl: HTMLDivElement | null = null;
  #invitationModal: ProjectInvitationModal | null = null;
  #lifecycleActionsEl: HTMLDivElement | null = null;
  #opened = false;
  #projectActionsEl: HTMLDivElement | null = null;
  #reconnectActionEl: HTMLButtonElement | null = null;
  #secretExpiryTimer: number | null = null;
  #transferExpanded: boolean | null = null;
  #transferDrafts: Partial<Record<TransferDraftField, string>> = {};
  #status: AccessStatus | null = null;
  readonly #port: ProjectManagementModalPort;
  readonly #options: ProjectManagementModalOptions;

  #session!: ProjectManagementSession;

  get #hostProject(): CollabLocalProjectSummary { return this.#session?.project ?? this.#options.project; }
  get #snapshot(): CollabProjectSnapshot | null { return this.#session.data?.snapshot ?? null; }
  get #capabilities(): CollabProjectCapabilities | null { return this.#session.data?.capabilities ?? null; }
  get #currentMemberId(): CollabMemberId | null { return this.#snapshot?.currentMember.id ?? null; }
  get #hostMemberId(): CollabMemberId | null { return this.#lanSnapshot()?.project.hostMemberId ?? null; }
  get #members(): readonly CollabMember[] { return this.#snapshot?.members.filter(member => member.status !== 'left') ?? []; }
  get #managerOffers(): readonly CollabManagerResponsibilityOfferSummary[] { return this.#session.data?.managerOffers ?? []; }
  get #managementState(): 'loading' | 'ready' | 'unavailable' { return this.#session.status; }
  get #operationPending(): boolean { return this.#session.busy; }
  get #cloudTransferView(): CollabCloudToLanTransferView | null { return this.#session.recovery.cloudToLan; }
  get #cloudTargetDescriptor(): CollabCloudToLanTargetPreparationDescriptor | null {
    return this.#cloudTransferView?.target?.descriptor ?? this.#cloudTransferView?.manager?.descriptor ?? null;
  }
  get #cloudTransferHandle(): CollabCloudToLanTransferHandle | null {
    return this.#cloudTransferView?.manager?.handle ?? this.#cloudTransferView?.target?.handle ?? null;
  }
  get #cloudTransferStatus(): CollabAuthorityTransferStatus | null {
    return this.#cloudTransferView?.manager?.status ?? this.#cloudTransferView?.target?.status ?? null;
  }
  get #lanToCloudProposal(): CollabLanToCloudTransferView | null { return this.#session.recovery.lanToCloud; }
  set #lanToCloudProposal(value: CollabLanToCloudTransferView | null) { this.#session.updateRecovery({ lanToCloud: value }); }
  get #managementOperation(): CollabManagementOperationView | null {
    const operation = this.#session.recovery.operation;
    return operation?.action === 'reissue-member-claim' && operation.status === 'result-retained'
      && (!operation.secretAvailableUntil || Date.parse(operation.secretAvailableUntil) <= Date.now())
      ? { ...operation, invitation: null } : operation;
  }
  set #managementOperation(value: CollabManagementOperationView | null) { this.#session.updateRecovery({ operation: value }); }
  get #retainedInvitation(): CollabInvitationView | null {
    const operation = this.#managementOperation;
    return operation?.action === 'reissue-member-claim' && operation.status === 'result-retained'
      ? operation.invitation : null;
  }

  constructor(
    app: App,
    port: ProjectManagementModalPort,
    options: ProjectManagementModalOptions,
  ) {
    super(app);
    this.#port = port;
    this.#options = options;
    this.#appInstance = app;
  }

  onOpen(): void {
    this.#clearSecretExpiryTimer();
    this.#confirmation = null;
    this.#transferExpanded = null;
    this.#transferDrafts = {};
    this.#cloudLanDestination = null;
    this.#opened = true;
    this.#status = null;
    this.#session = new ProjectManagementSession({
      project: this.#options.project,
      port: this.#port,
      confirmLegacyClaim: () => confirm(
        this.#appInstance,
        t('collab.host.legacyClaimConfirmation'),
        t('collab.host.legacyClaimAction'),
        'claudian-collab-modal--filled-actions',
      ),
      onChange: () => {
        if (!this.#opened) return;
        this.#updateHostProject();
        this.#syncSecretExpiry();
        this.#renderCurrentView();
      },
      onResetInteraction: () => {
        this.#hostDestinationModal?.close();
        this.#abandonLanManagementIntent();
        this.#confirmation = null;
        this.#transferDrafts = {};
        this.#cloudLanDestination = null;
        this.#transferExpanded = null;
        this.#status = null;
        const active = this.contentEl.ownerDocument.activeElement;
        if (active && this.contentEl.contains(active) && active.hasAttribute('data-field')) {
          (active as HTMLElement).blur();
        }
      },
      onClose: () => this.close(),
      onCommandCompleted: () => this.#options.onChanged?.(),
    });
    this.setTitle(t('collab.projectManagement.title'));
    this.modalEl.classList.add(
      'claudian-collab-project-management-modal',
      'claudian-collab-modal--filled-actions',
    );
    this.#renderShell();
    this.#session.open();
  }

  onClose(): void {
    this.#opened = false;
    this.#transferDrafts = {};
    this.#session.close();
    this.#clearSecretExpiryTimer();
    this.#abandonLanManagementIntent();
    this.#hostSection?.destroy();
    this.#hostSection = null;
    this.#hostActionEl = null;
    this.#hostDestinationModal?.close();
    this.#hostDestinationModal = null;
    this.#hostDiagnosticsModal?.close();
    this.#hostDiagnosticsModal = null;
    this.#invitationModal?.close();
    this.#invitationModal = null;
    this.#membersSectionEl = null;
    this.#accessContentEl = null;
    this.#invitationActionsEl = null;
    this.#lifecycleActionsEl = null;
    this.#projectActionsEl = null;
    this.#reconnectActionEl = null;
    this.contentEl.replaceChildren();
    this.#options.onClosed?.();
  }

  #renderShell(): void {
    this.#hostSection?.destroy();
    this.#hostSection = null;
    this.contentEl.replaceChildren();
    const overview = this.contentEl.createDiv({ cls: 'claudian-collab-management-overview' });
    overview.createEl('h2', { text: this.#hostProject.name });
    overview.createDiv({
      cls: 'claudian-collab-management-location',
      text: this.#hostProject.workspacePath,
    });
    this.#accessContentEl = this.contentEl.createDiv({
      cls: 'claudian-collab-project-management-access',
    });
    this.#invitationActionsEl = null;
    this.#updateHostProject();
    this.#projectActionsEl = this.contentEl.createDiv({
      attr: { 'aria-label': t('collab.access.projectActions'), role: 'region' },
      cls: 'claudian-collab-project-actions',
    });
    this.#projectActionsEl.createEl('h3', { text: t('collab.access.projectActions') });
    if (this.#options.onReconnect) {
      this.#reconnectActionEl = this.#projectActionsEl.createEl('button', {
        attr: { 'data-action': 'restore-connection', type: 'button' },
        text: t('collab.reconnectProject.restoreWithLink'),
      });
      this.#reconnectActionEl.addEventListener('click', () => {
        if (!this.#canReconnect()) return;
        const project = this.#hostProject;
        this.close();
        this.#options.onReconnect?.(project);
      });
    }
    this.#lifecycleActionsEl = this.#projectActionsEl.createDiv({
      cls: 'claudian-collab-project-actions-lifecycle',
    });
    this.#projectActionsEl.hidden = true;
    this.#renderCurrentView();
  }

  #updateHostProject(): void {
    if (this.#hostProject.authorityKind === 'lan' && this.#hostProject.hostInstallationStatus !== 'not-host') {
      if (this.#hostSection) {
        this.#hostSection.setState(this.#session.host, this.#hostTransferAction());
        return;
      }
      this.#hostActionEl = createDiv({ cls: 'claudian-collab-project-host-action' });
      this.#hostSection = new LanHostSection(this.#hostActionEl, {
        state: this.#session.host,
        transferHost: this.#hostTransferAction(),
        onAction: action => { void this.#session.runHostAction(action); },
        onOpenDiagnostics: diagnostics => this.#openHostDiagnostics(diagnostics),
      });
    } else {
      this.#hostSection?.destroy();
      this.#hostSection = null;
      this.#hostActionEl?.remove();
      this.#hostActionEl = null;
    }
  }

  #hostTransferMembers(): readonly CollabMember[] {
    const snapshot = this.#lanSnapshot();
    if (this.#managementState !== 'ready'
      || this.#hostProject.hostInstallationStatus !== 'hosted-here'
      || !snapshot || snapshot.hostTransfer
      || this.#currentMemberId !== this.#hostMemberId
      || this.#currentMember()?.status !== 'active') return [];
    return this.#members.filter(member => member.status === 'active' && member.id !== this.#hostMemberId);
  }

  #hostTransferAction(): LanHostTransferAction | undefined {
    if (!this.#hostTransferMembers().length) return undefined;
    return {
      disabled: this.#managementActionBlocked(),
      onClick: () => this.#openHostDestination(),
    };
  }

  #openHostDestination(): void {
    const members = this.#hostTransferMembers();
    if (this.#hostDestinationModal || !members.length || this.#managementActionBlocked()) return;
    const isCurrent = this.#session.capture();
    const modal = new HostDestinationModal(this.#appInstance, {
      members,
      onClosed: () => {
        if (this.#hostDestinationModal === modal) this.#hostDestinationModal = null;
      },
      onSelect: memberId => {
        if (!isCurrent() || this.#managementActionBlocked()
          || !this.#hostTransferMembers().some(member => member.id === memberId)) return;
        void this.#runLifecycleAction(() => this.#port.createHostTransfer({
          projectId: this.#options.project.id,
          targetMemberId: memberId,
        }, ...this.#transientOperationOptions()));
      },
    });
    this.#hostDestinationModal = modal;
    modal.open();
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

  #applyCloudTransferView(view: CollabCloudToLanTransferView | null): void {
    this.#session.updateRecovery({ cloudToLan: view });
  }

  #applyManagementOperation(operation: CollabManagementOperationView | null): void {
    this.#session.updateRecovery({ operation });
  }

  #syncSecretExpiry(): void {
    this.#clearSecretExpiryTimer();
    const operation = this.#managementOperation;
    if (operation?.action === 'reissue-member-claim' && operation.status === 'result-retained'
      && operation.invitation && operation.secretAvailableUntil) {
      this.#scheduleSecretExpiry(operation.completionId, operation.secretAvailableUntil);
    }
  }

  #scheduleSecretExpiry(completionId: string, deadline: string): void {
    const expiresAt = Date.parse(deadline);
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
      this.#redactRetainedInvitation(completionId);
      return;
    }
    this.#secretExpiryTimer = window.setTimeout(() => {
      this.#secretExpiryTimer = null;
      if (!this.#opened || this.#managementOperation?.completionId !== completionId) return;
      if (Date.now() < expiresAt) {
        this.#scheduleSecretExpiry(completionId, deadline);
        return;
      }
      this.#redactRetainedInvitation(completionId);
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  #redactRetainedInvitation(completionId: string): void {
    if (this.#managementOperation?.completionId === completionId) this.#render();
  }

  #clearSecretExpiryTimer(): void {
    if (this.#secretExpiryTimer === null) return;
    window.clearTimeout(this.#secretExpiryTimer);
    this.#secretExpiryTimer = null;
  }

  #render(): void {
    if (!this.#opened) return;
    if (this.#hostDestinationModal) {
      const members = this.#hostTransferMembers();
      if (!members.length || this.#managementActionBlocked()) this.#hostDestinationModal.close();
      else this.#hostDestinationModal.setMembers(members);
    }
    const active = this.contentEl.ownerDocument.activeElement;
    const focusedControl = active && this.contentEl.contains(active) && active.hasAttribute('data-field')
      ? active as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement : null;
    const selection = focusedControl ? {
      field: focusedControl.dataset.field!,
      start: 'selectionStart' in focusedControl ? focusedControl.selectionStart : null,
      end: 'selectionEnd' in focusedControl ? focusedControl.selectionEnd : null,
      direction: 'selectionDirection' in focusedControl ? focusedControl.selectionDirection : null,
    } : null;
    if (this.#managementState === 'loading') this.#renderLoading();
    else if (this.#managementState === 'unavailable') this.#renderLoadFailure();
    else {
      const accessContent = this.#requireAccessContent();
      this.#invitationActionsEl = null;
      accessContent.replaceChildren();
      const current = this.#currentMember();
      const isManager = current?.role === 'manager' && current.status === 'active';

      this.#renderMembers(current, isManager);
      this.#renderProjectActions(current, isManager);
      this.#renderHosting(accessContent, current, isManager);
      this.#renderPendingManagementOperation();
      this.#renderStatus();
      this.#renderRetainedInvitation();
      if (this.#confirmation && this.#confirmation.kind !== 'leave' && this.#confirmation.kind !== 'retire') {
        this.#renderConfirmation(this.#confirmation);
      }
    }
    if (selection) {
      const replacement = this.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-field="${selection.field}"]`,
      );
      replacement?.focus();
      if (replacement && 'setSelectionRange' in replacement && selection.start !== null && selection.end !== null) {
        replacement.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
      }
    }
  }

  #renderMembers(
    current: CollabMember | undefined,
    isManager: boolean,
  ): void {
    const section = this.#requireAccessContent().createDiv({
      attr: { 'aria-label': t('collab.access.members'), role: 'region' },
      cls: 'claudian-collab-access-members',
    });
    this.#membersSectionEl = section;
    const header = section.createDiv({ cls: 'claudian-collab-management-section-header' });
    const title = header.createDiv();
    title.createEl('h3', { text: t('collab.access.members') });
    const summary = title.createDiv({ cls: 'claudian-collab-access-summary' });
    summary.createSpan({
      cls: 'claudian-collab-access-member-count',
      text: t(
        this.#members.length === 1
          ? 'collab.access.memberCountSingle' : 'collab.access.memberCount',
        { count: this.#members.length },
      ),
    });
    summary.createSpan({
      cls: 'claudian-collab-access-manager-count',
      text: t('collab.access.managerCount', {
        count: this.#members.filter(member => (
          member.role === 'manager' && member.status === 'active'
        )).length,
      }),
    });
    this.#invitationActionsEl = header.createDiv({
      cls: 'claudian-collab-project-invitation-action',
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
    if (
      isManager
      && canManageMembership
      && member.role !== 'manager'
    ) {
      if (this.#capabilities?.managerPromotion === true) {
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
        promote.addEventListener('click', () => this.#showConfirmation({ kind: 'promote', member, operation: { kind: 'direct' } }));
      } else if (canManageResponsibility) {
        this.#renderLegacyManagerPromotion(actions, member);
      }
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

  #renderLegacyManagerPromotion(actions: HTMLElement, member: CollabMember): void {
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

  #renderLeaveAction(container: HTMLElement): void {
    const row = container.createDiv({ cls: 'claudian-collab-management-action-row' });
    row.createDiv({
      cls: 'claudian-collab-management-description',
      text: t('collab.access.leaveProjectDescription'),
    });
    const leave = row.createEl('button', {
      attr: { 'data-action': 'leave-project', type: 'button' },
      cls: 'mod-cta',
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
  }

  #renderHostTransferActions(item: HTMLElement): void {
    const member = this.#currentMember();
    if (member?.status !== 'active') return;
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
    if (current?.status === 'active') {
      const recoversInvitation = this.#managementOperation?.action === 'create-invitation';
      if (isManager && (this.#capabilities?.invitations || recoversInvitation)) {
        const intent = recoversInvitation && this.#managementOperation?.status === 'pending'
          ? 'resume' : 'create';
        const invite = invitationActions.createEl('button', {
          attr: { 'data-action': 'create-invitation', type: 'button' },
          cls: 'mod-cta',
          text: intent === 'resume'
            ? t('collab.access.resumeInvitation')
            : t('collab.access.createInvitation'),
        });
        invite.disabled = this.#operationPending
          || !!this.#invitationModal
          || (this.#managementOperation !== null && !recoversInvitation);
        invite.addEventListener('click', () => {
          this.#openInvitationModal(intent);
        });
      }
      const recoversLink = this.#managementOperation?.action === 'create-recovery-link';
      if (isManager && (this.#capabilities?.projectRecovery || recoversLink)) {
        const copy = invitationActions.createEl('button', {
          attr: { 'data-action': 'copy-recovery-link', type: 'button' },
          text: t('collab.access.copyRecoveryLink'),
        });
        copy.disabled = this.#operationPending || !!this.#invitationModal || !this.#options.copyText
          || (this.#managementOperation !== null && !recoversLink);
        copy.addEventListener('click', () => void this.#copyRecoveryLink(recoversLink && this.#managementOperation?.status === 'pending' ? 'resume' : 'create'));
      }
      if (this.#capabilities?.leave) this.#renderLeaveAction(lifecycleActions);
      if (isManager && this.#capabilities?.retirement) {
        const row = lifecycleActions.createDiv({ cls: 'claudian-collab-management-action-row' });
        row.createDiv({
          cls: 'claudian-collab-management-description',
          text: t('collab.access.retireProjectDescription'),
        });
        const retire = row.createEl('button', {
          attr: { 'data-action': 'retire-project', type: 'button' },
          cls: 'mod-warning',
          text: t('collab.access.retireProject'),
        });
        retire.disabled = this.#managementActionBlocked();
        retire.addEventListener('click', () => {
          this.#showConfirmation({ kind: 'retire', member: current });
        });
      }
    }
    this.#syncProjectActionsVisibility();
    if (this.#confirmation?.kind === 'leave' || this.#confirmation?.kind === 'retire') {
      this.#renderConfirmation(this.#confirmation);
    }
  }

  #openInvitationModal(intent: 'create' | 'resume'): void {
    if (this.#invitationModal) return;
    const modal = new ProjectInvitationModal(this.#appInstance, this.#port, {
      intent,
      copyText: this.#options.copyText,
      onClosed: () => {
        if (this.#invitationModal !== modal) return;
        this.#invitationModal = null;
        if (this.#opened) void this.#session.refresh();
      },
      projectId: this.#options.project.id,
    });
    this.#invitationModal = modal;
    modal.open();
    this.#refreshProjectActions();
  }

  async #copyRecoveryLink(intent: 'create' | 'resume'): Promise<void> {
    const command = this.#session.beginCommand();
    if (!command || !this.#options.copyText) { command?.complete(); return; }
    const operation = this.#port.openInvitation({ projectId: this.#options.project.id, intent, purpose: 'recovery' });
    try {
      this.#status = null;
      this.#render();
      const result = await operation.run();
      if (!command.isCurrent()) return;
      if (result.status !== 'success' || result.value.status !== 'ready') throw new Error();
      const current = await operation.read();
      if (!command.isCurrent()) return;
      if (current.status !== 'success' || current.value.status !== 'ready') throw new Error();
      await this.#options.copyText(current.value.invitation.encodedInvitation);
      const acknowledged = await operation.acknowledge();
      if (acknowledged.status !== 'success') throw new Error();
      if (command.isCurrent()) this.#status = { kind: 'success', text: t('collab.access.recoveryLinkCopied') };
    } catch {
      if (command.isCurrent()) this.#status = { kind: 'error', text: t('collab.access.copyFailed') };
    } finally {
      operation.dispose();
      try { if (command.isCurrent()) await this.#session.refresh(); }
      finally { command.complete(); if (this.#opened) this.#render(); }
    }
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
    const deletionNotice = container.createDiv({
      attr: { 'aria-live': 'polite' },
      text: t('collab.access.immediateLocalDeletion'),
    });
    deletionNotice.hidden = confirmation.cleanupChoice !== 'delete-files';
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
        deletionNotice.hidden = choice !== 'delete-files';
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
    const command = this.#session.beginCommand();
    if (!command) return;
    try {
      this.#render();
      const result = await operation();
      if (!command.isCurrent()) return;
      if (result.status !== 'success') {
        this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
        this.#render();
        return;
      }
      onSuccess?.();
      this.#options.onChanged?.();
      await this.#session.refresh();
    } finally { command.complete(); }
  }

  async #createManagerPromotion(
    confirmation: Extract<AccessConfirmation, { readonly kind: 'promote' }>,
  ) {
    if (confirmation.operation.kind === 'create-offer') {
      return this.#port.createManagerResponsibilityOffer({
        projectId: this.#options.project.id,
        purpose: 'manager-promotion',
        targetMemberId: confirmation.member.id,
      }, ...this.#transientOperationOptions());
    }
    return this.#port.promoteManager({
      ...(confirmation.operation.kind === 'complete-promotion'
        ? { managerResponsibilityOfferId: confirmation.operation.managerResponsibilityOfferId } : {}),
      projectId: this.#options.project.id,
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
    const container = confirmation.kind === 'leave' || confirmation.kind === 'retire'
      ? this.#requireLifecycleActions()
      : this.#membersSectionEl;
    if (!container) return;
    const region = container.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-confirmation',
    });
    region.createDiv({ text: this.#confirmationQuestion(confirmation) });
    if (confirmation.kind === 'remove') {
      region.createDiv({ text: t('collab.access.removedFilesRetained') });
    } else if (confirmation.kind === 'demote') {
      region.createDiv({ text: t('collab.access.demoteHostUnchanged') });
    } else if (confirmation.kind === 'leave') {
      if (this.#managementState !== 'ready') {
        region.createDiv({ text: t(this.#hostProject.authorityKind === 'lan'
          ? 'collab.access.offlineLeaveLan' : 'collab.access.offlineLeaveCloud') });
      }
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
      cls: confirmation.kind === 'retire'
        ? 'mod-warning claudian-collab-retire-confirm'
        : confirmation.kind === 'promote' ? 'mod-cta' : 'mod-warning',
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
    if (confirmation.kind === 'promote') {
      const operation = confirmation.operation;
      return `promote:${confirmation.member.id}:${operation.kind}:${operation.kind === 'complete-promotion' ? operation.managerResponsibilityOfferId : ''}`;
    }
    return `${confirmation.kind}:${confirmation.member.id}`;
  }

  #abandonLanManagementIntent(): void {
    if (this.#hostProject.authorityKind !== 'lan') return;
    void this.#port.completeManagementOperation({ projectId: this.#options.project.id });
  }

  async #confirmAccessAction(
    confirmation: AccessConfirmation,
  ): Promise<void> {
    const command = this.#session.beginCommand();
    if (!command) return;
    try {
      this.#status = null;
      this.#render();
      let result: CollabResult<unknown>;
      try {
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
        result = await operation;
      } catch {
        if (!command.isCurrent()) return;
        this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
        this.#render();
        return;
      }
      if (!command.isCurrent()) return;
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
      await this.#session.refresh();
    } finally { command.complete(); }
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

  #renderHosting(
    container: HTMLElement,
    current: CollabMember | undefined,
    isManager: boolean,
    recovery = false,
  ): void {
    const actionsAvailable = this.#capabilities?.authorityTransfer === true;
    const lanToCloudProposal = this.#presentableLanToCloudProposal();
    const transferPresent = !!lanToCloudProposal || !!this.#cloudTransferView;
    const hostTransferPresent = !!this.#lanSnapshot()?.hostTransfer;
    const transferAvailable = (
      current?.status === 'active'
      && (actionsAvailable || transferPresent)
    ) || (recovery && transferPresent);
    const hostAvailable = (this.#hostActionEl?.childElementCount ?? 0) > 0;
    if (!hostAvailable && !transferAvailable && !hostTransferPresent) return;

    const hosting = container.createDiv({
      attr: { 'aria-label': t('collab.access.hosting'), role: 'region' },
      cls: 'claudian-collab-hosting',
    });
    hosting.createEl('h3', { text: t('collab.access.hosting') });
    if (hostAvailable && this.#hostActionEl) {
      const currentHosting = hosting.createDiv({
        cls: 'claudian-collab-hosting-current',
      });
      currentHosting.appendChild(this.#hostActionEl);
    }
    this.#renderHostTransferActions(hosting);
    if (!transferAvailable) return;

    const section = hosting.createDiv({
      cls: 'claudian-collab-authority-transfer',
    });
    const transferHeader = section.createDiv({ cls: 'claudian-collab-management-section-header' });
    const description = transferHeader.createDiv({ cls: 'claudian-collab-management-hosting-description' });
    if (!hostAvailable) {
      description.createDiv({
        cls: 'claudian-collab-management-hosting-kind',
        text: this.#hostProject.authorityKind === 'cloud'
          ? t('collab.createProject.authorityCloud') : t('collab.panel.lanHost'),
      });
    }
    description.createDiv({
      cls: 'claudian-collab-management-description',
      text: this.#hostProject.authorityKind === 'cloud'
        ? t('collab.access.cloudHostingDescription') : t('collab.access.lanHostingDescription'),
    });
    const toggle = transferHeader.createEl('button', {
      attr: {
        'aria-controls': 'claudian-collab-transfer-form',
        'aria-expanded': String(this.#transferExpanded ?? transferPresent),
        type: 'button',
      },
      cls: 'claudian-collab-authority-transfer-toggle',
      text: this.#hostProject.authorityKind === 'lan'
        ? t('collab.access.moveToCloud')
        : t('collab.access.moveToLan'),
    });
    const form = section.createDiv({
      attr: { id: 'claudian-collab-transfer-form' },
      cls: 'claudian-collab-authority-transfer-form',
    });
    form.hidden = !(this.#transferExpanded ?? transferPresent);
    toggle.addEventListener('click', () => {
      this.#transferExpanded = form.hidden === true;
      form.hidden = !this.#transferExpanded;
      toggle.setAttribute('aria-expanded', String(this.#transferExpanded));
    });
    if (this.#hostProject.authorityKind === 'lan') {
      this.#renderLanToCloudTransfer(form, recovery || actionsAvailable);
      return;
    }
    this.#renderCloudToLanTransfer(
      form,
      recovery ? Boolean(this.#cloudTransferView?.manager) : isManager,
      recovery || actionsAvailable,
    );
  }

  #renderLanToCloudTransfer(section: HTMLElement, actionsAvailable = true): void {
    const proposal = this.#presentableLanToCloudProposal();
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
          t(proposal.proposedByMemberId === this.#currentMemberId
            ? 'collab.access.retryLanToCloud'
            : 'collab.access.acceptLanToCloud'), async () => {
            const isCurrent = this.#session.capture();
            const result = await this.#port.acceptLanToCloudTransfer(
              {
                projectId: this.#options.project.id,
                transferId: proposal.status!.transferId,
              },
            );
            if (!isCurrent()) return result;
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
              const isCurrent = this.#session.capture();
              const result = await this.#port.cancelLanToCloudTransfer(
                {
                  projectId: this.#options.project.id,
                  transferId: proposal.status!.transferId,
                },
              );
              if (!isCurrent()) return result;
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
    this.#bindTransferDraft('lan-to-cloud-server-url', input);
    if (proposal?.status === null) input.value = proposal.serverUrl;
    const propose = row.createEl('button', {
      attr: { 'data-action': 'propose-lan-to-cloud', type: 'button' },
      cls: 'mod-cta claudian-collab-authority-transfer-submit',
      text: proposal?.status === null
        ? t('collab.access.retryLanToCloud')
        : this.#hostProject.hostInstallationStatus === 'hosted-here'
          ? t('collab.access.moveToCloud')
          : t('collab.access.proposeLanToCloud'),
    });
    propose.disabled = this.#managementActionBlocked() || !input.value.trim();
    input.addEventListener('input', () => {
      propose.disabled = this.#managementActionBlocked() || !input.value.trim();
    });
    propose.addEventListener('click', () => {
      const serverUrl = input.value;
      const sourceOwned = this.#hostProject.hostInstallationStatus === 'hosted-here';
      void this.#runTransferAction(async () => {
        const isCurrent = this.#session.capture();
        const request = { projectId: this.#options.project.id, serverUrl };
        const result = sourceOwned
          ? await this.#port.moveLanToCloud(request)
          : await this.#port.proposeLanToCloudTransfer(request);
        if (!isCurrent()) return result;
        if (result.status === 'success') this.#finishTerminalTransfer(result.value);
        return result;
      });
    });
  }

  #presentableLanToCloudProposal(): CollabLanToCloudTransferView | null {
    return this.#lanToCloudProposal?.status?.state === 'cancelled'
      ? null
      : this.#lanToCloudProposal;
  }

  #renderCloudToLanTransfer(
    section: HTMLElement,
    isManager: boolean,
    actionsAvailable = true,
  ): void {
    const targetView = this.#cloudTransferView?.target ?? null;
    const destination = this.#cloudLanDestination ?? ((this.#cloudTransferView?.preparations?.length ?? 0) > 0
      ? 'another-device' : 'this-device');
    if (!actionsAvailable) {
      const recovery = section.createDiv({ cls: 'claudian-collab-authority-transfer-target' });
      if (this.#cloudTransferStatus) {
        recovery.createDiv({ text: this.#transferStatusLabel(this.#cloudTransferStatus) });
      } else {
        recovery.createDiv({ text: this.#transferStatusLabel(null) });
      }
      recovery.createDiv({ text: t('collab.access.transferConnectionRequired') });
      return;
    }
    const hasPreparation = this.#cloudTargetDescriptor !== null;
    if (isManager && !hasPreparation && !this.#cloudTransferHandle) {
      const row = section.createDiv({ cls: 'claudian-collab-join-field' });
      const id = 'claudian-collab-lan-destination';
      row.createEl('label', { attr: { for: id }, text: t('collab.access.lanHost') });
      const select = row.createEl('select', { attr: { id, 'data-field': 'lan-destination' } });
      select.createEl('option', {
        attr: { value: 'this-device' }, text: t('collab.access.thisDevice'),
      });
      select.createEl('option', {
        attr: { value: 'another-device' }, text: t('collab.access.anotherDevice'),
      });
      select.value = destination;
      select.disabled = this.#managementActionBlocked();
      select.addEventListener('change', () => {
        this.#cloudLanDestination = select.value === 'another-device'
          ? 'another-device' : 'this-device';
        this.#renderCurrentView();
        this.contentEl.querySelector<HTMLSelectElement>(`#${id}`)?.focus();
      });
    }

    const actions = createDiv({ cls: 'claudian-collab-access-actions' });
    const thisDevice = hasPreparation
      ? targetView !== null
      : destination === 'this-device';
    if (thisDevice) {
      if (!this.#cloudTargetDescriptor) {
        section.createDiv({ text: t('collab.access.prepareLanHelp') });
        this.#createTransferButton(actions, 'prepare-cloud-to-lan',
          t(isManager ? 'collab.access.moveToLan' : 'collab.access.prepareCloudToLan'), async () => {
            const isCurrent = this.#session.capture();
            if (isManager) return this.#moveCloudToLanHere();
            const result = await this.#port.prepareCloudToLanTarget({ projectId: this.#options.project.id });
            if (!isCurrent()) return result;
            return result;
          });
        section.appendChild(actions);
        return;
      }
      if (isManager && !this.#cloudTransferHandle) {
        section.createDiv({ text: t('collab.access.lanTargetReady') });
      }
      if (this.#cloudTransferHandle || !isManager) {
        this.#renderCloudToLanAcceptance(section, actions, isManager);
      }
    }

    if (isManager && !this.#cloudTransferHandle) {
      if (thisDevice) {
        this.#createTransferButton(actions, 'begin-cloud-to-lan',
          t('collab.access.beginCloudToLan'), () => this.#moveCloudToLanHere());
      } else {
        section.createDiv({ text: t('collab.access.otherLanTargetHelp') });
        const retained = this.#cloudTransferView?.manager?.descriptor;
        const preparations = retained ? [{ preparationId: retained.preparationId, targetMemberId: retained.selectedTargetMemberId }]
          : this.#cloudTransferView?.preparations ?? [];
        for (const preparation of preparations) {
          const row = section.createDiv({ cls: 'claudian-collab-access-actions' });
          const member = this.#members.find(item => item.id === preparation.targetMemberId);
          row.createSpan({ text: member?.displayName ?? preparation.targetMemberId });
          this.#createTransferButton(row, 'begin-cloud-to-lan',
            t('collab.access.beginCloudToLan'), () => this.#port.beginCloudToLanTransfer({
              projectId: this.#options.project.id, preparationId: preparation.preparationId,
            }));
        }
      }
    }

    if (thisDevice && this.#cloudTargetDescriptor && (!targetView || targetView.canWithdraw)) {
      this.#createTransferButton(actions, 'withdraw-cloud-to-lan-target',
        t('collab.access.withdrawCloudToLan'), async () => {
          const isCurrent = this.#session.capture();
          const result = await this.#port.withdrawCloudToLanTarget({
            preparationId: this.#cloudTargetDescriptor!.preparationId,
            projectId: this.#options.project.id,
          });
          if (!isCurrent()) return result;
          if (result.status === 'success') this.#applyCloudTransferView(null);
          return result;
        });
    }
    if (!this.#cloudTransferHandle) {
      section.appendChild(actions);
      return;
    }
    if (!isManager) {
      section.createDiv({ text: this.#transferStatusLabel(this.#cloudTransferStatus) });
      section.appendChild(actions);
      return;
    }
    if (!thisDevice) {
      section.createDiv({ text: t('collab.access.cloudToLanApproved') });
    }
    if (this.#cloudTransferStatus) {
      section.createDiv({ text: this.#transferStatusLabel(this.#cloudTransferStatus) });
    }
    this.#createTransferButton(actions, 'observe-cloud-to-lan',
      t('collab.access.observeTransfer'), async () => {
        const isCurrent = this.#session.capture();
        const result = await this.#port.observeCloudToLanTransfer(
          this.#options.project.id,
        );
        if (!isCurrent()) return result;
        if (result.status === 'success') {
          this.#session.updateCloudTransferStatus(result.value);
          this.#finishTerminalTransfer(result.value);
        }
        return result;
      });
    if (this.#cloudTransferStatus && this.#isTransferCancellable(this.#cloudTransferStatus)) {
      this.#createTransferButton(actions, 'cancel-cloud-to-lan',
        t('collab.access.cancelTransfer'), async () => {
          const isCurrent = this.#session.capture();
          const result = await this.#port.cancelCloudToLanTransfer(
            this.#cloudTransferHandle!,
          );
          if (!isCurrent()) return result;
          if (result.status === 'success') {
            this.#session.updateCloudTransferStatus(result.value);
            this.#finishTerminalTransfer(result.value);
          }
          return result;
        });
    }
    section.appendChild(actions);
  }

  async #moveCloudToLanHere(): Promise<{ readonly status: string }> {
    const isCurrent = this.#session.capture();
    const result = await this.#port.moveCloudToLan(this.#options.project.id);
    if (!isCurrent()) return result;
    if (result.status === 'success') this.#finishTerminalTransfer(result.value);
    return result;
  }

  #renderCloudToLanAcceptance(section: HTMLElement, actions: HTMLElement, initiatedHere = false): void {
    const handle = this.#cloudTransferHandle;
    if (!handle) section.createDiv({ text: t('collab.access.waitingCloudToLanApproval') });
    this.#createTransferButton(actions, 'accept-cloud-to-lan',
      t('collab.access.resumeCloudToLan'), async () => {
        const isCurrent = this.#session.capture();
        if (!handle) {
          return this.#port.prepareCloudToLanTarget({ projectId: this.#options.project.id });
        }
        const result = initiatedHere
          ? await this.#port.moveCloudToLan(this.#options.project.id)
          : await this.#port.acceptCloudToLanTransfer(handle);
        if (isCurrent() && result.status === 'success') {
          this.#session.updateCloudTransferStatus(result.value);
          this.#finishTerminalTransfer(result.value);
        }
        return result;
      });
  }

  #transferStatusLabel(status: CollabAuthorityTransferStatus | null): string {
    if (!status) return t('collab.access.transferStatus.pending');
    if (status.state === 'completed') return t('collab.access.transferStatus.completed');
    if (status.state === 'cancelled') return t('collab.access.transferStatus.cancelled');
    return t('collab.access.transferStatus.active');
  }

  #bindTransferDraft(field: TransferDraftField, input: HTMLInputElement | HTMLTextAreaElement): void {
    input.value = this.#transferDrafts[field] ?? '';
    input.addEventListener('input', () => { this.#transferDrafts[field] = input.value; });
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
    const command = this.#session.beginCommand();
    if (!command) return;
    try {
      this.#status = null;
      this.#renderCurrentView();
      const result = await operation();
      if (!command.isCurrent()) return;
      await this.#session.refresh();
      if (!command.isCurrent()) return;
      this.#status = result.status === 'success'
        ? { kind: 'success', text: t('collab.access.transferUpdated') }
        : { kind: 'error', text: t('collab.access.actionFailed') };
      this.#renderCurrentView();
    } finally { command.complete(); }
  }

  #renderCurrentView(): void {
    this.#render();
  }

  #transientOperationOptions(): [] | [CollabOperationOptions] {
    return this.#hostProject.authorityKind === 'lan'
      ? [{ signal: this.#session.signal }]
      : [];
  }

  #managementActionBlocked(): boolean {
    return this.#operationPending || this.#managementOperation !== null;
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
    if (!operation || operation.action === 'create-invitation' || operation.action === 'create-recovery-link') return;
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
    if (operation.action !== 'reissue-member-claim' || operation.invitation === null) {
      this.#createLifecycleButton(
        this.#requireAccessContent(),
        'complete-management-operation',
        t('collab.access.finishOperation'),
        () => this.#port.completeManagementOperation({
          completionId: operation.completionId,
          projectId: this.#options.project.id,
        }),
        () => { this.#applyManagementOperation(null); },
        true,
      );
    }
  }

  async #resumeManagementOperation(): Promise<{ readonly status: string }> {
    const isCurrent = this.#session.capture();
    const result = await this.#port.resumeManagementOperation(
      this.#options.project.id,
    );
    if (!isCurrent()) return result;
    if (result.status !== 'success') return result;
    this.#applyManagementOperation(result.value);
    return result;
  }

  #renderRetainedInvitation(): void {
    if (!this.#retainedInvitation) return;
    const region = this.#invitationActionsEl ?? this.#requireAccessContent();
    const copy = region.createEl('button', {
      attr: { 'data-action': 'copy-member-claim', type: 'button' },
      text: t('collab.access.copyMemberClaim'),
    });
    copy.disabled = this.#operationPending
      || !this.#options.copyText
      || this.#managementOperation?.action !== 'reissue-member-claim'
      || this.#managementOperation.status !== 'result-retained'
      || this.#managementOperation.invitation?.encodedInvitation
        !== this.#retainedInvitation.encodedInvitation;
    copy.addEventListener('click', () => void this.#copyRetainedInvitation());
  }

  async #copyRetainedInvitation(): Promise<void> {
    const command = this.#session.beginCommand();
    if (!command) return;
    try {
      const operation = this.#managementOperation;
      const invitation = this.#retainedInvitation;
      if (!invitation) { this.#render(); return; }
      if (
        !invitation
        || !this.#options.copyText
        || operation?.action !== 'reissue-member-claim'
        || operation.status !== 'result-retained'
        || operation.invitation?.encodedInvitation !== invitation.encodedInvitation
      ) return;
      this.#render();
      try {
        const retained = await this.#port.readManagementOperation(
          this.#options.project.id,
          { signal: this.#session.signal },
        );
        if (!command.isCurrent()) return;
        if (retained.status !== 'success') {
          this.#clearSecretExpiryTimer();
          this.#managementOperation = { ...operation, invitation: null };
          this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
          return;
        }
        this.#applyManagementOperation(retained.value);
        const validatedInvitation = this.#retainedInvitation;
        if (
          retained.value?.action !== 'reissue-member-claim'
          || retained.value.status !== 'result-retained'
          || retained.value.completionId !== operation.completionId
          || !validatedInvitation
          || validatedInvitation.encodedInvitation !== invitation.encodedInvitation
          || validatedInvitation.expiresAt !== invitation.expiresAt
        ) {
          this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
          return;
        }
        await this.#options.copyText(validatedInvitation.encodedInvitation);
        if (!command.isCurrent()) return;
        const completed = await this.#port.completeManagementOperation(
          {
            completionId: operation.completionId,
            projectId: this.#options.project.id,
          },
        );
        if (!command.isCurrent()) return;
        if (completed.status !== 'success') {
          this.#status = { kind: 'error', text: t('collab.access.actionFailed') };
          return;
        }
        this.#applyManagementOperation(null);
        this.#status = { kind: 'success', text: t('collab.access.memberClaimCopied') };
      } catch {
        if (command.isCurrent()) {
          this.#status = { kind: 'error', text: t('collab.access.copyFailed') };
        }
      } finally {
        if (command.isCurrent()) {
          this.#render();
        }
      }
    } finally { command.complete(); }
  }

  #renderLoading(): void {
    if (!this.#opened || this.#managementState === 'ready') return;
    this.#clearProjectActions();
    const accessContent = this.#requireAccessContent();
    this.#invitationActionsEl = null;
    accessContent.replaceChildren();
    accessContent.createDiv({
      attr: { 'aria-live': 'polite' },
      cls: 'claudian-collab-access-status',
      text: t('collab.access.loading'),
    });
    this.#renderLocalLeave();
    this.#renderStatus();
    this.#renderHosting(accessContent, undefined, false);
  }

  #renderLoadFailure(): void {
    if (!this.#opened) return;
    this.#clearProjectActions();
    const accessContent = this.#requireAccessContent();
    this.#invitationActionsEl = null;
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
      void this.#session.refresh();
    });
    this.#renderLocalLeave();
    this.#renderHosting(accessContent, this.#currentMember(), false, true);
    this.#renderPendingManagementOperation();
    this.#renderStatus();
    this.#renderRetainedInvitation();
  }

  #renderLocalLeave(): void {
    if (
      this.#hostProject.role === 'member'
      && (this.#hostProject.authorityKind === 'cloud'
        || this.#hostProject.hostInstallationStatus === 'not-host')
      && this.#hostProject.lifecycle !== 'leaving'
      && this.#hostProject.lifecycle !== 'retired'
    ) {
      this.#renderLeaveAction(this.#requireLifecycleActions());
      this.#syncProjectActionsVisibility();
      if (this.#confirmation?.kind === 'leave') this.#renderConfirmation(this.#confirmation);
    }
  }

  #clearProjectActions(): void {
    this.#invitationActionsEl?.replaceChildren();
    this.#lifecycleActionsEl?.replaceChildren();
    this.#syncProjectActionsVisibility();
  }

  #canReconnect(): boolean {
    return this.#options.onReconnect !== undefined
      && this.#hostProject.connectionStatus !== 'connected'
      && this.#hostProject.lifecycle !== 'leaving'
      && this.#hostProject.lifecycle !== 'retired'
      && (this.#hostProject.authorityKind === 'cloud'
        || this.#hostProject.hostInstallationStatus === 'not-host'
        || this.#hostProject.hostInstallationStatus === 'hosted-elsewhere');
  }

  #syncProjectActionsVisibility(): void {
    if (!this.#projectActionsEl || !this.#lifecycleActionsEl) return;
    if (this.#reconnectActionEl) this.#reconnectActionEl.hidden = !this.#canReconnect();
    this.#projectActionsEl.hidden = this.#lifecycleActionsEl.childElementCount === 0 && !this.#canReconnect();
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

}
