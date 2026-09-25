import type { CollabAuthorityTransferStatus, CollabMemberId } from '@claudian-collab/protocol';

import type {
  CollabCloudToLANTransferView,
  CollabFeaturePort,
  CollabFeatureState,
  CollabHostStatus,
  CollabLANToCloudTransferView,
  CollabLocalProjectSummary,
  CollabManagementOperationView,
  CollabManagerResponsibilityOfferSummary,
  CollabMemberSummaryView,
  CollabProjectCapabilities,
  CollabProjectSnapshot,
} from '@/core/collab';
import { type LatestTaskHandle, LatestTaskScope } from '@/shared/async/LatestTaskScope';

export type ProjectManagementSessionPort = Pick<CollabFeaturePort,
  | 'subscribe' | 'observeProject' | 'readSnapshot' | 'readProjectCapabilities'
  | 'readLanToCloudTransfer' | 'readCloudToLanTransfer' | 'readManagementOperation'
  | 'listMembers' | 'listManagerResponsibilityOffers'
  | 'claimLegacyHostInstallation' | 'startHost' | 'stopHost'
>;

export type ProjectHostAction = 'start' | 'stop';

export interface ProjectHostView {
  readonly project: CollabLocalProjectSummary;
  readonly status: CollabHostStatus;
  readonly pending: boolean;
  readonly error: {
    readonly action: ProjectHostAction;
    readonly details: Readonly<Record<string, unknown>> | null;
  } | null;
}

interface ManagementData {
  readonly snapshot: CollabProjectSnapshot;
  readonly capabilities: CollabProjectCapabilities;
  readonly memberSummaries: ReadonlyMap<CollabMemberId, CollabMemberSummaryView>;
  readonly managerOffers: readonly CollabManagerResponsibilityOfferSummary[];
}

interface ManagementRecovery {
  readonly lanToCloud: CollabLANToCloudTransferView | null;
  readonly cloudToLan: CollabCloudToLANTransferView | null;
  readonly operation: CollabManagementOperationView | null;
}

export interface ProjectManagementCommand {
  isCurrent(): boolean;
  complete(): void;
}

interface HostOperation {
  readonly action: ProjectHostAction;
  readonly controller: AbortController;
  phase: 'confirming' | 'claiming' | 'executing';
  revision: number;
}

export interface ProjectManagementSessionOptions {
  readonly project: CollabLocalProjectSummary;
  readonly port: ProjectManagementSessionPort;
  readonly confirmLegacyClaim: () => Promise<boolean>;
  readonly onChange: () => void;
  readonly onResetInteraction: () => void;
  readonly onClose: () => void;
  readonly onCommandCompleted?: () => void;
}

/** Owns one management surface's reads and presentation lifetime, never durable effects. */
export class ProjectManagementSession {
  private readonly lifetime = new AbortController();
  private readonly reads = new LatestTaskScope();
  private projectSubscription: { dispose(): void } | null = null;
  private subscription: { dispose(): void; } | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshRequested = false;
  private deferred = false;
  private opened = false;
  private actorEpoch = 0;
  private actorId: CollabMemberId | null = null;
  private command: ProjectManagementCommand | null = null;
  private hostOperation: HostOperation | null = null;
  private hostRevision = 0;
  private hostError: ProjectHostView['error'] = null;
  private localProject: CollabLocalProjectSummary;
  private managementData: ManagementData | null = null;
  private managementStatus: 'loading' | 'ready' | 'unavailable' = 'loading';
  private recoveryValue: ManagementRecovery = { lanToCloud: null, cloudToLan: null, operation: null };

  constructor(private readonly options: ProjectManagementSessionOptions) {
    this.localProject = options.project;
  }

  get signal(): AbortSignal { return this.lifetime.signal; }
  get project(): CollabLocalProjectSummary { return this.localProject; }
  get data(): ManagementData | null { return this.managementData; }
  get status(): 'loading' | 'ready' | 'unavailable' { return this.managementStatus; }
  get recovery(): ManagementRecovery { return this.recoveryValue; }
  get busy(): boolean { return this.deferred; }
  private setBusy(value: boolean): void {
    this.deferred = value;
    if (value && this.reads.active) {
      this.reads.cancel();
      this.refreshRequested = true;
    }
    if (!value && this.refreshRequested) void this.refresh();
  }

  capture(): () => boolean {
    const epoch = this.actorEpoch;
    return () => !this.signal.aborted && epoch === this.actorEpoch;
  }

  beginCommand(): ProjectManagementCommand | null {
    if (this.busy || this.signal.aborted) return null;
    const command: ProjectManagementCommand = {
      isCurrent: this.capture(),
      complete: () => {
        if (this.command !== command) return;
        this.command = null;
        this.setBusy(false);
        this.publish();
      },
    };
    this.command = command;
    this.setBusy(true);
    return command;
  }

  private replaceActor(): void {
    this.actorEpoch += 1;
    this.command = null;
    this.setBusy(false);
    this.hostOperation?.controller.abort();
    this.hostOperation = null;
    this.options.onResetInteraction();
  }

  get host(): ProjectHostView {
    const operation = this.hostOperation;
    const pendingStatus = operation?.revision === this.hostRevision
      ? operation.action === 'start' ? 'starting' : 'stopping' : null;
    return {
      project: this.project,
      status: pendingStatus ?? (this.hostError ? 'needs-attention' : this.project.hostStatus),
      pending: operation !== null,
      error: this.hostError,
    };
  }

  open(): void {
    if (this.opened || this.signal.aborted) return;
    this.opened = true;
    const subscription = this.options.port.subscribe(state => this.acceptProjection(state));
    if (this.signal.aborted) { subscription.dispose(); return; }
    this.subscription = subscription;
    this.projectSubscription = this.options.port.observeProject(this.project.id, (_coordination, changes) => {
      if (!changes || changes.members || changes.hosting) void this.refresh();
    });
    void this.refresh();
  }

  close(): void {
    this.opened = false;
    this.lifetime.abort();
    this.command = null;
    this.reads.close();
    this.hostOperation?.controller.abort();
    this.hostOperation = null;
    this.subscription?.dispose();
    this.subscription = null;
    this.projectSubscription?.dispose();
    this.projectSubscription = null;
    this.refreshRequested = false;
  }

  private publish(): void {
    if (!this.signal.aborted) this.options.onChange();
  }

  private acceptProjection(state: CollabFeatureState): void {
    if (this.signal.aborted) return;
    if (state.selectedProjectId !== this.project.id) { this.options.onClose(); return; }
    const project = state.projects.find(item => item.id === this.project.id);
    if (project?.lifecycle === 'retired') { this.options.onClose(); return; }
    const supersede = project !== undefined && (
      project.authorityKind !== this.project.authorityKind
      || project.hostInstallationStatus !== this.project.hostInstallationStatus
      || project.hostStatus !== this.project.hostStatus
      || project.connectionStatus !== this.project.connectionStatus
    );
    const changed = project !== undefined && JSON.stringify(project) !== JSON.stringify(this.project);
    if (project) this.acceptProject(project);
    if (changed) void this.refresh(supersede);
  }

  private acceptProject(project: CollabLocalProjectSummary): void {
    const previous = this.project;
    const authorityChanged = project.authorityKind !== previous.authorityKind;
    const installationChanged = project.hostInstallationStatus !== previous.hostInstallationStatus;
    const ownClaim = this.hostOperation?.phase === 'claiming'
      && !authorityChanged && previous.hostInstallationStatus === 'legacy-unbound'
      && project.hostInstallationStatus === 'hosted-here';
    if (authorityChanged || (installationChanged && !ownClaim)) {
      this.hostOperation?.controller.abort();
      this.hostOperation = null;
    }
    if (project.hostStatus !== previous.hostStatus || installationChanged) {
      this.hostRevision += 1;
      this.hostError = null;
    }
    this.localProject = project;
    if (authorityChanged) {
      this.reads.cancel();
      this.managementData = null;
      this.managementStatus = 'loading';
      this.recoveryValue = { lanToCloud: null, cloudToLan: null, operation: null };
      // Authority mode belongs to the read/draft binding; the admitted command can complete across its own transfer.
      this.options.onResetInteraction();
    }
    this.publish();
  }

  /** All invalidations share this lane; an in-flight read is followed by one coalesced refresh. */
  refresh(supersede = false): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    this.refreshRequested = true;
    if (supersede) this.reads.cancel();
    if (this.deferred) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = Promise.resolve().then(async () => {
        while (this.refreshRequested && !this.deferred && !this.signal.aborted) {
          this.refreshRequested = false;
          await this.readManagement();
        }
      }).finally(() => {
        this.refreshing = null;
        if (this.refreshRequested && !this.deferred && !this.signal.aborted) void this.refresh();
      });
    }
    return this.refreshing;
  }

  updateRecovery(update: Partial<ManagementRecovery>): void {
    if (this.signal.aborted) return;
    this.recoveryValue = { ...this.recoveryValue, ...update };
    this.publish();
  }

  updateCloudTransferStatus(status: CollabAuthorityTransferStatus): void {
    const view = this.recovery.cloudToLan;
    if (!view) return;
    this.updateRecovery({
      cloudToLan: {
        preparations: view.preparations,
        manager: view.manager ? { ...view.manager, status } : null,
        target: view.target ? { ...view.target, status } : null,
      }
    });
  }

  private async readManagement(): Promise<void> {
    const task = this.reads.start();
    const project = this.project;
    this.publish();
    try {
      const [result, capabilities, lanToCloud, cloudToLan, operation] = await waitForRead(task, Promise.all([
        this.options.port.readSnapshot(project.id, { signal: task.signal }),
        this.options.port.readProjectCapabilities(project.id, { signal: task.signal }),
        project.authorityKind === 'lan'
          ? this.options.port.readLanToCloudTransfer(project.id, { signal: task.signal })
          : Promise.resolve({ status: 'success' as const, value: null }),
        project.authorityKind === 'cloud'
          ? this.options.port.readCloudToLanTransfer(project.id, { signal: task.signal })
          : Promise.resolve({ status: 'success' as const, value: null }),
        this.options.port.readManagementOperation(project.id, { signal: task.signal }),
      ]));
      if (!task.isCurrent()) return;
      const recovery: ManagementRecovery = {
        lanToCloud: lanToCloud.status === 'success' ? lanToCloud.value : this.recovery.lanToCloud,
        cloudToLan: cloudToLan.status === 'success' ? cloudToLan.value : this.recovery.cloudToLan,
        operation: operation.status === 'success' ? operation.value : this.recovery.operation,
      };
      const fail = () => {
        this.recoveryValue = recovery;
        this.managementStatus = 'unavailable';
      };
      if (result.status !== 'success' || capabilities.status !== 'success'
        || result.value.source !== 'online' || result.value.stale
        || result.value.syncState.status !== 'synchronized') { fail(); return; }
      const snapshot = result.value.snapshot;
      if (snapshot.project.authorityKind !== project.authorityKind
        || snapshot.project.authorityKind !== capabilities.value.authorityKind
        || !snapshot.members.some(member => member.id === snapshot.currentMember.id)
        || (capabilities.value.authorityTransfer && (project.authorityKind === 'lan'
          ? lanToCloud.status !== 'success' : cloudToLan.status !== 'success'))
        || (project.authorityKind === 'cloud' && operation.status !== 'success')) { fail(); return; }
      const previousActor = this.actorId;
      this.actorId = snapshot.currentMember.id;
      if (previousActor && previousActor !== this.actorId) {
        // Identity invalidation cannot wait for the complete display bundle.
        this.managementData = null;
        this.managementStatus = 'loading';
        this.recoveryValue = { lanToCloud: null, cloudToLan: null, operation: null };
        this.replaceActor();
        this.publish();
      }
      let memberSummaries: ReadonlyMap<CollabMemberId, CollabMemberSummaryView> = new Map();
      let managerOffers: readonly CollabManagerResponsibilityOfferSummary[] = [];
      if (capabilities.value.membershipManagement
        && (project.authorityKind === 'cloud' || capabilities.value.importedMemberClaims)) {
        const listed = await waitForRead(task, this.options.port.listMembers(project.id, { signal: task.signal }));
        if (!task.isCurrent()) return;
        if (listed.status !== 'success') { fail(); return; }
        memberSummaries = new Map(listed.value.map(member => [member.memberId, member]));
      }
      if (project.authorityKind === 'cloud' && capabilities.value.managerResponsibility) {
        const offers = await waitForRead(task, this.options.port.listManagerResponsibilityOffers(project.id, { signal: task.signal }));
        if (!task.isCurrent()) return;
        if (offers.status !== 'success') { fail(); return; }
        managerOffers = offers.value;
      }
      this.managementData = { snapshot, capabilities: capabilities.value, memberSummaries, managerOffers };
      this.recoveryValue = recovery;
      this.managementStatus = 'ready';
    } catch {
      if (task.isCurrent()) this.managementStatus = 'unavailable';
    } finally {
      if (task.complete()) this.publish();
    }
  }

  async runHostAction(action: ProjectHostAction): Promise<void> {
    if (this.signal.aborted || this.hostOperation || this.project.authorityKind !== 'lan'
      || this.project.hostInstallationStatus === 'not-host'
      || this.project.hostInstallationStatus === 'hosted-elsewhere') return;
    const operation: HostOperation = {
      action, controller: new AbortController(), phase: 'confirming', revision: this.hostRevision,
    };
    this.hostOperation = operation;
    this.hostError = null;
    const current = () => !this.signal.aborted && this.hostOperation === operation;
    this.publish();
    try {
      if (action === 'start' && this.project.hostInstallationStatus === 'legacy-unbound') {
        const confirmed = await this.options.confirmLegacyClaim();
        if (!current() || !confirmed) return;
        operation.phase = 'claiming';
        const claim = await this.options.port.claimLegacyHostInstallation(this.project.id, { signal: operation.controller.signal });
        if (!current()) return;
        if (claim.status !== 'success') {
          this.hostError = { action, details: 'error' in claim ? claim.error.toJSON() : null };
          return;
        }
        this.acceptProject(claim.value);
        if (!current()) return;
      }
      operation.phase = 'executing';
      operation.revision = this.hostRevision;
      const result = action === 'start'
        ? await this.options.port.startHost(this.project.id, { signal: operation.controller.signal })
        : await this.options.port.stopHost(this.project.id, { signal: operation.controller.signal });
      if (!current()) return;
      // A projection can supersede the displayed result without consuming this command's completion.
      if (operation.revision === this.hostRevision) {
        if (result.status === 'success') this.localProject = { ...this.project, hostStatus: result.value.status };
        else this.hostError = { action, details: 'error' in result ? result.error.toJSON() : null };
      }
      if (result.status === 'success') {
        this.options.onCommandCompleted?.();
        void this.refresh(true);
      }
    } finally {
      if (current()) { this.hostOperation = null; this.publish(); }
    }
  }
}


function waitForRead<T>(task: LatestTaskHandle, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { reject(new Error('Management read cancelled')); };
    if (task.signal.aborted) cancelled();
    else task.signal.addEventListener('abort', cancelled, { once: true });
    work.then(resolve, reject).finally(() => task.signal.removeEventListener('abort', cancelled));
  });
}
