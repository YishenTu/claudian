import path from 'node:path';

import {
  COLLAB_MAIN_REF,
  type CollabMemberId,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import {
  CLOUD_BOOTSTRAP_READINESS_OPERATIONS,
  type CloudBootstrapReadinessInspector,
  type CloudBootstrapReadinessObservation,
  type CloudBootstrapReadinessOperation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import type { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { ConflictScratchStore } from '@/app/collab/conflicts/ConflictScratchStore';
import type {
  ManagerResponsibilityReceiptRecord,
} from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import { CollabRequestDraftStore } from '@/app/collab/publish/CollabRequestDraftStore';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LocalCloudBootstrapReadinessInspectorOptions {
  readonly foundation: Pick<
    ClaudianCollabService,
    'inspectAuthority' | 'local' | 'requireGitFoundation'
  >;
  readonly isProjectQuiesced: (projectId: CollabProjectId) => boolean;
  readonly managerResponsibilityReceipts: {
    load(projectId: CollabProjectId): Promise<ManagerResponsibilityReceiptRecord | null>;
  };
  readonly vaultRoot: string;
}

function inspectorError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function remoteTrackingRef(ref: string): string {
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix)) throw inspectorError('cloud-bootstrap-personal-ref-invalid');
  return `refs/remotes/origin/${ref.slice(prefix.length)}`;
}

export class LocalCloudBootstrapReadinessInspector
implements CloudBootstrapReadinessInspector {
  readonly #conflicts: ConflictScratchStore;
  readonly #drafts: CollabRequestDraftStore;
  readonly #foundation: LocalCloudBootstrapReadinessInspectorOptions['foundation'];
  readonly #isProjectQuiesced: (projectId: CollabProjectId) => boolean;
  readonly #journals: CollabLifecycleJournalStore;
  readonly #managerResponsibilityReceipts:
    LocalCloudBootstrapReadinessInspectorOptions['managerResponsibilityReceipts'];
  readonly #publicationState: CollabPublicationStateStore;

  constructor(options: LocalCloudBootstrapReadinessInspectorOptions) {
    this.#foundation = options.foundation;
    this.#isProjectQuiesced = options.isProjectQuiesced;
    this.#managerResponsibilityReceipts = options.managerResponsibilityReceipts;
    this.#journals = new CollabLifecycleJournalStore(options.vaultRoot);
    this.#conflicts = new ConflictScratchStore(
      options.vaultRoot,
      options.foundation.local.projects,
    );
    this.#drafts = new CollabRequestDraftStore(options.foundation.local.projects);
    this.#publicationState = new CollabPublicationStateStore(
      options.foundation.local.projects,
    );
  }

  async inspect(
    projectId: CollabProjectId,
    memberId: CollabMemberId,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapReadinessObservation> {
    throwIfCancelled(signal);
    const membership = await this.#foundation.local.projects.loadMembership(projectId);
    throwIfCancelled(signal);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
      || membership.member.id !== memberId
    ) {
      throw inspectorError('cloud-bootstrap-readiness-membership-mismatch');
    }
    const quiesced = this.#isProjectQuiesced(projectId);
    const [
      pendingOperationProjectIds,
      pendingLeave,
      retiredCleanup,
      localCleanup,
      incomingTransfer,
      outgoingTransfer,
      retirement,
      managerResponsibilityReceipt,
      conflicts,
      draft,
      publicationState,
    ] = await Promise.all([
      this.#foundation.local.projects.listPendingOperationProjectIds(),
      this.#journals.pendingLeaves.load(projectId),
      this.#journals.retiredCleanups.load(projectId),
      this.#foundation.local.projects.localCleanup.load(projectId),
      this.#foundation.local.projects.hostTransferRecovery.load(projectId, 'incoming'),
      this.#foundation.local.projects.hostTransferRecovery.load(projectId, 'outgoing'),
      this.#foundation.local.projects.loadRetirementRecord(projectId),
      this.#managerResponsibilityReceipts.load(projectId),
      this.#conflicts.list(),
      this.#drafts.load(projectId),
      this.#publicationState.load(projectId),
    ]);
    throwIfCancelled(signal);
    const operations = Object.fromEntries(
      CLOUD_BOOTSTRAP_READINESS_OPERATIONS.map(operation => [
        operation,
        quiesced ? 'settled' : 'active',
      ]),
    ) as Record<CloudBootstrapReadinessOperation, 'active' | 'settled'>;
    if (pendingOperationProjectIds.includes(projectId)) operations.projectSetup = 'active';
    if (pendingLeave || membership.lifecycle === 'leaving') operations.leave = 'active';
    if (retiredCleanup || localCleanup) operations.cleanup = 'active';
    if (retirement) operations.retirement = 'active';
    if (incomingTransfer || outgoingTransfer) operations.hostTransfer = 'active';
    if (
      managerResponsibilityReceipt?.status === 'offered'
      || managerResponsibilityReceipt?.status === 'acknowledged'
    ) {
      operations.managerResponsibility = 'active';
    }
    if (conflicts.some(record => record.projectId === projectId)) {
      operations.conflictRecovery = 'active';
    }
    if (publicationState.operation !== null) operations.publish = 'active';

    const git = await this.#foundation.requireGitFoundation();
    throwIfCancelled(signal);
    const workingPath = await this.#foundation.local.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    );
    throwIfCancelled(signal);
    await git.repositories.assertLocalRepositoryIdentity(workingPath, {
      memberId,
      personalRef: membership.member.personalRef,
      projectId,
    }, signal);
    let identityRepositoryPath: string;
    let mainRef: string;
    let personalRef: string;
    if (membership.hostOwnership.ownsAuthority) {
      const authority = await this.#foundation.inspectAuthority(projectId);
      throwIfCancelled(signal);
      if (!authority) throw inspectorError('cloud-bootstrap-readiness-authority-missing');
      identityRepositoryPath = path.join(authority.authorityDirectory, 'repository.git');
      mainRef = COLLAB_MAIN_REF;
      personalRef = membership.member.personalRef;
    } else {
      identityRepositoryPath = workingPath;
      mainRef = remoteTrackingRef(COLLAB_MAIN_REF);
      personalRef = remoteTrackingRef(membership.member.personalRef);
    }
    const refs = await git.repositories.resolveRefs(
      identityRepositoryPath,
      [mainRef, personalRef],
      signal,
    );
    const mainOid = refs.get(mainRef);
    const personalRefOid = refs.get(personalRef);
    if (!mainOid || !personalRefOid) {
      throw inspectorError('cloud-bootstrap-readiness-ref-missing');
    }
    const [formatResult, workingState, localPersonalOid] = await Promise.all([
      git.runner.run({
        args: ['rev-parse', '--show-object-format'],
        cwd: identityRepositoryPath,
        maxStdoutBytes: 64,
        signal,
      }),
      git.repositories.getWorkingTreeState(workingPath, signal),
      git.repositories.resolveRef(workingPath, membership.member.personalRef, signal),
    ]);
    throwIfCancelled(signal);
    const objectFormat = formatResult.stdout.toString('utf8').trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw inspectorError('cloud-bootstrap-readiness-object-format-invalid');
    }
    return {
      collabGitChildCount: git.runner.activeProcessCount,
      operations,
      preservedWork: {
        hasLocalOnlyCommits: localPersonalOid !== null && localPersonalOid !== personalRefOid,
        hasPrivateDraft: draft !== null,
        hasUnpublishedFiles: workingState.entries.length > 0,
      },
      projectOperationQueue: {
        activeCount: quiesced ? 0 : 1,
        queuedCount: 0,
      },
      projectWorkSession: quiesced ? 'closed' : 'open',
      repository: {
        mainOid,
        memberId,
        objectFormat,
        personalRef: membership.member.personalRef,
        personalRefOid,
        projectId,
      },
    };
  }
}
