import {
  type ActivateDevelopmentBootstrapRequest,
  type BeginDevelopmentBootstrapRequest,
  type CancelDevelopmentBootstrapRequest,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  decodeDevelopmentBootstrapReport,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  developmentBootstrapOperationCodec,
  type DevelopmentBootstrapReport,
  type GetDevelopmentBootstrapRequest,
  type PutDevelopmentBootstrapGitBundleRequest,
  type SubmitDevelopmentBootstrapReportRequest,
} from '@claudian-collab/protocol';

import type {
  CloudBootstrapReadinessCollector,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import {
  type CloudBootstrapTransitionRecord,
  type CloudBootstrapTransitionStorePort,
  createCloudBootstrapTransitionRecord,
  developmentBootstrapManifestSha256,
  markCloudBootstrapHostStopped,
  markCloudBootstrapTerminalCleanupCompleted,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface DevelopmentBootstrapCloudPort {
  activate(
    request: ActivateDevelopmentBootstrapRequest,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  begin(
    request: BeginDevelopmentBootstrapRequest,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  cancel(
    request: CancelDevelopmentBootstrapRequest,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  get(
    request: GetDevelopmentBootstrapRequest,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus | null>;
  report(
    request: SubmitDevelopmentBootstrapReportRequest,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
  upload(
    request: PutDevelopmentBootstrapGitBundleRequest,
    body: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapAttemptStatus>;
}

export interface CloudBootstrapLocalIdentity {
  readonly authorityKind: 'lan';
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly gitRemoteUrl: string;
  readonly memberId: CollabMemberId;
  readonly ownsAuthority: boolean;
  readonly projectId: CollabProjectId;
}

export interface CloudBootstrapCoordinatorOptions {
  readonly binding: {
    finalize(
      record: CloudBootstrapTransitionRecord,
      signal?: AbortSignal,
    ): Promise<CloudBootstrapTransitionRecord>;
  };
  readonly cloud: DevelopmentBootstrapCloudPort;
  readonly createFenceId: () => string;
  readonly formerHost: {
    stopAndDrain(projectId: CollabProjectId, signal?: AbortSignal): Promise<{
      readonly autoStartDisabled: true;
      readonly resourcesDrained: true;
      readonly routeUnregistered: true;
      readonly stoppedAt: CollabIsoTimestamp;
    }>;
  };
  readonly localIdentity: {
    load(projectId: CollabProjectId): Promise<CloudBootstrapLocalIdentity>;
  };
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly readiness: Pick<CloudBootstrapReadinessCollector, 'collect'>;
  readonly source: {
    assertManifestCurrent(
      manifest: DevelopmentBootstrapManifest,
      signal?: AbortSignal,
    ): Promise<void>;
    captureManifest(
      projectId: CollabProjectId,
      signal?: AbortSignal,
    ): Promise<DevelopmentBootstrapManifest>;
    discardBundle(manifest: DevelopmentBootstrapManifest): Promise<void>;
    openBundle(
      manifest: DevelopmentBootstrapManifest,
      signal?: AbortSignal,
    ): AsyncIterable<Uint8Array>;
  };
  readonly transitions: CloudBootstrapTransitionStorePort;
  readonly workSessions: {
    closeAndDrain(projectId: CollabProjectId, signal?: AbortSignal): Promise<void>;
    completeAfterActivation(projectId: CollabProjectId): Promise<void>;
    resumeAfterCancellation(projectId: CollabProjectId): Promise<void>;
  };
}

export interface StartCloudBootstrapInput {
  readonly developmentActorId: string;
  readonly memberId: CollabMemberId;
  readonly projectId: CollabProjectId;
  readonly serverUrl: string;
}

export interface SubmitCloudBootstrapParticipantInput extends StartCloudBootstrapInput {
  readonly manifest: DevelopmentBootstrapManifest;
}

function coordinatorError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({
    code: 'cancelled',
    recoveryActions: ['retry'],
    safeContext: { reason: 'cloud-bootstrap-operation-cancelled' },
  });
}

function decodeStatus(
  operation:
    | 'activateDevelopmentBootstrap'
    | 'beginDevelopmentBootstrap'
    | 'cancelDevelopmentBootstrap'
    | 'getDevelopmentBootstrap'
    | 'putDevelopmentBootstrapGitBundle'
    | 'submitDevelopmentBootstrapReport',
  value: DevelopmentBootstrapAttemptStatus,
): DevelopmentBootstrapAttemptStatus {
  return developmentBootstrapOperationCodec(operation).decodeResponse(value);
}

export class CloudBootstrapCoordinator {
  private readonly now: () => Date;

  constructor(private readonly options: CloudBootstrapCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private assertOwnedRecord(record: CloudBootstrapTransitionRecord): void {
    if (record.ownerInstallationKey !== this.options.installationKey) {
      throw coordinatorError('host-installation-recovery-owner-mismatch');
    }
  }

  async startFormerHost(
    input: StartCloudBootstrapInput,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    this.assertActorMatchesMember(input);
    throwIfCancelled(signal);
    const manifest = await this.options.source.captureManifest(input.projectId, signal);
    throwIfCancelled(signal);
    if (
      manifest.comparison.projectId !== input.projectId
      || manifest.comparison.sourceHostMemberId !== input.memberId
    ) {
      throw coordinatorError('cloud-bootstrap-source-manifest-identity-mismatch');
    }
    let record: CloudBootstrapTransitionRecord;
    try {
      record = await this.createTransition(
        input,
        manifest,
        this.options.createFenceId(),
        signal,
      );
    } catch (error) {
      await this.options.source.discardBundle(manifest);
      throw error;
    }
    throwIfCancelled(signal);
    record = await this.stopFormerHost(record, signal);
    return this.driveFormerHost(record, true, signal);
  }

  async submitParticipant(
    input: SubmitCloudBootstrapParticipantInput,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    this.assertActorMatchesMember(input);
    if (input.manifest.comparison.sourceHostMemberId === input.memberId) {
      throw coordinatorError('cloud-bootstrap-participant-is-source-host');
    }
    const record = await this.createTransition(input, input.manifest, undefined, signal);
    throwIfCancelled(signal);
    await this.options.workSessions.closeAndDrain(record.projectId, signal);
    throwIfCancelled(signal);
    const report = await this.collectReport(record, signal);
    const remote = decodeStatus(
      'submitDevelopmentBootstrapReport',
      await this.options.cloud.report({ attemptId: record.attemptId, report }, signal),
    );
    return this.observeAndSaveTerminal(record, remote, signal);
  }

  async recoverProject(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord | null> {
    throwIfCancelled(signal);
    let record = await this.options.transitions.load(projectId);
    throwIfCancelled(signal);
    if (!record) return null;
    this.assertOwnedRecord(record);
    if (record.terminalCleanupCompleted) return record;
    if (record.attemptState === 'cancelled') {
      return this.settleLocalTerminal(record, signal);
    }
    if (record.attemptState === 'activated') {
      await this.options.workSessions.closeAndDrain(record.projectId, signal);
      return this.settleLocalTerminal(record, signal);
    }
    if (record.fence.state === 'active') record = await this.stopFormerHost(record, signal);
    if (record.fence.state === 'not-applicable' || record.fence.state === 'host-stopped') {
      throwIfCancelled(signal);
      await this.options.workSessions.closeAndDrain(record.projectId, signal);
      throwIfCancelled(signal);
    }
    const report = await this.collectReport(record, signal);
    const remote = await this.options.cloud.get({ attemptId: record.attemptId }, signal);
    if (remote === null) {
      if (record.memberId !== record.oldAuthority.sourceHostMemberId) return record;
      return this.driveFormerHost(record, true, signal, report);
    }
    const status = decodeStatus('getDevelopmentBootstrap', remote);
    const terminal = await this.observeAndSaveTerminal(record, status, signal);
    if (terminal.attemptState !== 'pending') return terminal;
    if (record.memberId !== record.oldAuthority.sourceHostMemberId) {
      if (status.reporterMemberIds.includes(record.memberId)) return terminal;
      const reported = decodeStatus(
        'submitDevelopmentBootstrapReport',
        await this.options.cloud.report({ attemptId: record.attemptId, report }, signal),
      );
      return this.observeAndSaveTerminal(record, reported, signal);
    }
    return this.driveFormerHost(record, false, signal, report, status);
  }

  async cancel(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    const record = await this.options.transitions.load(projectId);
    if (!record) throw coordinatorError('cloud-bootstrap-transition-not-found');
    this.assertOwnedRecord(record);
    if (record.attemptState === 'activated') {
      throw coordinatorError('cloud-bootstrap-already-activated');
    }
    if (record.attemptState === 'cancelled') {
      return this.settleLocalTerminal(record, signal);
    }
    const status = decodeStatus(
      'cancelDevelopmentBootstrap',
      await this.options.cloud.cancel({ attemptId: record.attemptId }, signal),
    );
    const updated = observeCloudBootstrapAttemptStatus(
      record,
      status,
      this.timestamp(),
    );
    if (updated.attemptState !== 'cancelled') {
      throw coordinatorError('cloud-bootstrap-cancellation-not-durable');
    }
    await this.options.transitions.save(updated);
    return this.settleLocalTerminal(updated, signal);
  }

  private async createTransition(
    input: StartCloudBootstrapInput,
    manifest: DevelopmentBootstrapManifest,
    fenceId?: string,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    throwIfCancelled(signal);
    const identity = await this.options.localIdentity.load(input.projectId);
    throwIfCancelled(signal);
    if (
      identity.authorityKind !== 'lan'
      || identity.projectId !== input.projectId
      || identity.memberId !== input.memberId
      || identity.caFingerprint !== manifest.comparison.sourceCaFingerprint
      || (fenceId !== undefined) !== identity.ownsAuthority
    ) {
      throw coordinatorError('cloud-bootstrap-local-authority-identity-mismatch');
    }
    const manifestSha256 = developmentBootstrapManifestSha256(manifest);
    const record = await this.options.transitions.create(createCloudBootstrapTransitionRecord({
      developmentActorId: input.developmentActorId,
      ...(fenceId === undefined ? {} : { fenceId }),
      manifest,
      manifestSha256,
      memberId: input.memberId,
      oldEndpoint: identity.endpoint,
      oldGitRemoteUrl: identity.gitRemoteUrl,
      ownerInstallationKey: this.options.installationKey,
      serverUrl: input.serverUrl,
      timestamp: this.timestamp(),
    }));
    throwIfCancelled(signal);
    return record;
  }

  private async stopFormerHost(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    if (record.fence.state !== 'active') return record;
    throwIfCancelled(signal);
    await this.options.workSessions.closeAndDrain(record.projectId, signal);
    throwIfCancelled(signal);
    const evidence = await this.options.formerHost.stopAndDrain(record.projectId, signal);
    throwIfCancelled(signal);
    if (
      evidence.autoStartDisabled !== true
      || evidence.resourcesDrained !== true
      || evidence.routeUnregistered !== true
    ) {
      throw coordinatorError('cloud-bootstrap-host-stop-incomplete');
    }
    const stopped = markCloudBootstrapHostStopped(
      record,
      evidence.stoppedAt,
      this.timestamp(),
    );
    await this.options.transitions.save(stopped);
    throwIfCancelled(signal);
    return stopped;
  }

  private async collectReport(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapReport> {
    throwIfCancelled(signal);
    const isFormerHost = record.memberId === record.oldAuthority.sourceHostMemberId;
    if (isFormerHost) {
      await this.options.source.assertManifestCurrent(record.manifest, signal);
      throwIfCancelled(signal);
    }
    const readiness = await this.options.readiness.collect({
      manifest: record.manifest,
      memberId: record.memberId,
    }, signal);
    throwIfCancelled(signal);
    if (isFormerHost && record.fence.state !== 'host-stopped') {
      throw coordinatorError('cloud-bootstrap-host-stop-attestation-unavailable');
    }
    return decodeDevelopmentBootstrapReport({
      attemptId: record.attemptId,
      capturedAt: this.timestamp(),
      clientReadiness: readiness.clientReadiness,
      comparison: record.manifest.comparison,
      ...(isFormerHost ? {
        hostStopAttestation: {
          attemptId: record.attemptId,
          autoStartDisabled: true,
          fenceDurable: true,
          fenceId: record.fence.fenceId,
          hostStopped: true,
          manifestSha256: record.manifestSha256,
          projectId: record.projectId,
          resourcesDrained: true,
          routeUnregistered: true,
          stoppedAt: record.fence.stoppedAt,
        },
      } : {}),
      observedPersonalRefOid: readiness.observedPersonalRefOid,
      reporterMemberId: record.memberId,
    });
  }

  private async driveFormerHost(
    record: CloudBootstrapTransitionRecord,
    begin: boolean,
    signal?: AbortSignal,
    existingReport?: DevelopmentBootstrapReport,
    existingStatus?: DevelopmentBootstrapAttemptStatus,
  ): Promise<CloudBootstrapTransitionRecord> {
    throwIfCancelled(signal);
    const report = existingReport ?? await this.collectReport(record, signal);
    let status = existingStatus;
    if (begin) {
      status = decodeStatus(
        'beginDevelopmentBootstrap',
        await this.options.cloud.begin({ manifest: record.manifest }, signal),
      );
    }
    if (!status) throw coordinatorError('cloud-bootstrap-status-unavailable');
    let terminal = await this.observeAndSaveTerminal(record, status, signal);
    if (terminal.attemptState !== 'pending') return terminal;

    if (!status.reporterMemberIds.includes(record.memberId)) {
      status = decodeStatus(
        'submitDevelopmentBootstrapReport',
        await this.options.cloud.report({ attemptId: record.attemptId, report }, signal),
      );
      terminal = await this.observeAndSaveTerminal(record, status, signal);
      if (terminal.attemptState !== 'pending') return terminal;
    }

    if (status.bundleState === 'missing') {
      status = decodeStatus(
        'putDevelopmentBootstrapGitBundle',
        await this.options.cloud.upload({
          attemptId: record.attemptId,
          byteCount: record.manifest.git.bundle.byteCount,
          contentEncoding: 'identity',
          contentType: 'application/x-git-bundle',
          sha256: record.manifest.git.bundle.sha256,
        }, bodySignal => this.options.source.openBundle(record.manifest, bodySignal), signal),
      );
      terminal = await this.observeAndSaveTerminal(record, status, signal);
      if (terminal.attemptState !== 'pending') return terminal;
    }

    if (status.state !== 'ready') return terminal;
    status = decodeStatus(
      'activateDevelopmentBootstrap',
      await this.options.cloud.activate({
        attemptId: record.attemptId,
        manifestSha256: record.manifestSha256,
      }, signal),
    );
    return this.observeAndSaveTerminal(record, status, signal);
  }

  private async observeAndSaveTerminal(
    record: CloudBootstrapTransitionRecord,
    status: DevelopmentBootstrapAttemptStatus,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    if (status.state === 'recovery-required' || status.state === 'rejected') {
      throw coordinatorError(`cloud-bootstrap-server-${status.state}`);
    }
    const updated = observeCloudBootstrapAttemptStatus(
      record,
      status,
      this.timestamp(),
    );
    if (
      updated.attemptState !== record.attemptState
      || updated.activationResult !== record.activationResult
      || updated.fence.state !== record.fence.state
    ) {
      await this.options.transitions.save(updated);
    }
    return this.settleLocalTerminal(updated, signal);
  }

  private async settleLocalTerminal(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    if (record.attemptState === 'pending') return record;
    if (record.memberId === record.oldAuthority.sourceHostMemberId) {
      await this.options.source.discardBundle(record.manifest);
    }
    if (record.attemptState === 'cancelled') {
      await this.options.workSessions.resumeAfterCancellation(record.projectId);
    } else {
      record = await this.options.binding.finalize(record, signal);
      await this.options.workSessions.completeAfterActivation(record.projectId);
    }
    if (record.terminalCleanupCompleted) return record;
    const completed = markCloudBootstrapTerminalCleanupCompleted(
      record,
      this.timestamp(),
    );
    await this.options.transitions.save(completed);
    return completed;
  }

  private timestamp(): CollabIsoTimestamp {
    return this.now().toISOString();
  }

  private assertActorMatchesMember(input: StartCloudBootstrapInput): void {
    if (input.developmentActorId !== input.memberId) {
      throw coordinatorError('cloud-bootstrap-development-actor-member-mismatch');
    }
  }
}
