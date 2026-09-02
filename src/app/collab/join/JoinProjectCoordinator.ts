import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { collabMemberRef, type CollabOperationId, isCollabOpaqueId } from '@claudian-collab/protocol';

import type {
  CollabGitFoundation,
} from '@/app/collab/ClaudianCollabService';
import {
  removeCollabFileDurably,
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type {
  CollabProjectsFolderChildOwnership,
  CollabWorkspaceService,
} from '@/app/collab/CollabWorkspaceService';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import {
  JoinControlClient,
} from '@/app/collab/join/JoinControlClient';
import {
  COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
  decodeJoinProjectRecord,
  type JoinProjectPhase,
  type JoinProjectRecord,
} from '@/app/collab/join/JoinProjectRecord';
import {
  type CollabHostTrustStore,
  CollabHttpClient,
  type CollabTrustedHost,
} from '@/app/collab/lan/CollabHttpClient';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import { type CollabWorkingCopyPlacement, CollabWorkingCopySetup } from '@/app/collab/project/CollabWorkingCopySetup';
import { isCollabWorkingCopySlug } from '@/app/collab/project/CollabWorkingCopySlug';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabInvitationJoinRequest, type CollabLocalProjectSummary, type CollabOperationOptions, type CollabResult, type CollabResumeSetupRequest, parseCollabProjectsFolder } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type LocalProjectsPort = Pick<
  CollabLocalProjectRepository,
  | 'loadIndex'
  | 'loadMembership'
  | 'loadProjectDocument'
  | 'listPendingOperationProjectIds'
  | 'discardPendingOperation'
  | 'removeProject'
  | 'removeProjectDocument'
  | 'saveMembership'
  | 'saveProjectDocument'
  | 'selectProject'
  | 'upsertProject'
>;

export interface JoinProjectFoundationPort {
  readonly local: {
    readonly pathPolicy: Pick<CollabPathPolicy, 'validateRepositoryPath'>;
    readonly projects: LocalProjectsPort;
    readonly workspace: Pick<
      CollabWorkspaceService,
      | 'claimProjectsFolder'
      | 'getProjectsFolderChildPath'
      | 'releaseReservedProjectsFolderChild'
      | 'removeReservedProjectsFolderChild'
      | 'reserveProjectsFolderChild'
    >;
  };
  requireGitFoundation(): Promise<CollabGitFoundation>;
}

interface JoinHttpClientPort {
  bootstrapInvitation: CollabHttpClient['bootstrapInvitation'];
  fromStoredTrust: CollabHttpClient['fromStoredTrust'];
}

export interface JoinProjectCoordinatorOptions {
  readonly createHttpClient?: (trustStore: CollabHostTrustStore) => JoinHttpClientPort;
  readonly createJoinAttemptId?: () => string;
  readonly getProjectsFolder?: () => string;
  readonly invitationCodec?: InvitationCodec;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

interface ActiveJoinIntent {
  readonly controller: AbortController;
}


function joinError(
  code:
    | 'cancelled'
    | 'durable-progress-recovery-required'
    | 'idempotency-conflict'
    | 'membership-revoked'
    | 'operation-failed'
    | 'path-invalid'
    | 'project-not-found'
    | 'quota-exceeded'
    | 'repository-invalid'
    | 'workspace-boundary-invalid',
  reason: string,
  recoveryActions: readonly ('open-diagnostics' | 'refresh-invitation' | 'resume' | 'retry')[] = [],
): CollabError {
  return new CollabError({ code, recoveryActions, safeContext: { reason } });
}

function asJoinError(error: unknown): CollabError {
  return error instanceof CollabError
    ? error
    : joinError('operation-failed', 'join-project-failed', ['retry', 'open-diagnostics']);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw joinError('cancelled', 'operation-cancelled', ['retry']);
}

function validateDisplayName(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > 200
    || trimmed.includes('\u0000')
    || trimmed.includes('\r')
    || trimmed.includes('\n')
  ) {
    throw joinError('operation-failed', 'member-display-name-invalid');
  }
  return trimmed;
}

function phaseRank(phase: JoinProjectPhase): number {
  return [
    'planned',
    'trusted',
    'membership-created',
    'clone-completed',
    'placed',
    'activated',
  ].indexOf(phase);
}

function gitRemoteUrl(record: JoinProjectRecord): string {
  return `${record.endpoint}/v1/git/${record.projectId}/repository.git`;
}

class JoinTrustStore implements CollabHostTrustStore {
  constructor(
    private readonly projectId: string,
    private readonly loadRecord: () => Promise<JoinProjectRecord>,
    private readonly saveTrust: (
      record: JoinProjectRecord,
      trust: CollabTrustedHost,
    ) => Promise<void>,
  ) {}

  async read(projectId: string): Promise<CollabTrustedHost | null> {
    if (projectId !== this.projectId) return null;
    const record = await this.loadRecord();
    if (!record.hostCaCertificatePem) return null;
    return {
      caCertificatePem: record.hostCaCertificatePem,
      caFingerprint: record.hostCaFingerprint,
      endpoint: record.endpoint,
      projectId: record.projectId,
    };
  }

  async save(trust: CollabTrustedHost): Promise<'ca-mismatch' | 'saved'> {
    const record = await this.loadRecord();
    if (
      trust.projectId !== record.projectId
      || trust.endpoint !== record.endpoint
      || trust.caFingerprint !== record.hostCaFingerprint
      || (
        record.hostCaCertificatePem !== null
        && record.hostCaCertificatePem !== trust.caCertificatePem
      )
    ) {
      return 'ca-mismatch';
    }
    await this.saveTrust(record, trust);
    return 'saved';
  }
}

export class JoinProjectCoordinator {
   #activeIntent: ActiveJoinIntent | null = null;
   readonly #workingCopy: CollabWorkingCopySetup;
   readonly #createHttpClient: (
    trustStore: CollabHostTrustStore,
  ) => JoinHttpClientPort;
   readonly #createJoinAttemptId: () => string;
  private readonly getProjectsFolder: () => string;
   readonly #invitationCodec: InvitationCodec;
  private readonly now: () => Date;
   readonly #operationQueue = new SerialTaskQueue();
   readonly #remoteMembershipMayExist = new Set<CollabOperationId>();

  constructor(
    private readonly foundation: JoinProjectFoundationPort,
    private readonly options: JoinProjectCoordinatorOptions,
  ) {
    this.#workingCopy = new CollabWorkingCopySetup(foundation, options.vaultRoot);
    this.#invitationCodec = options.invitationCodec ?? new InvitationCodec();
    this.#createHttpClient = options.createHttpClient
      ?? (trustStore => new CollabHttpClient(trustStore, {
        invitationCodec: this.#invitationCodec,
      }));
    this.#createJoinAttemptId = options.createJoinAttemptId
      ?? (() => `join-${randomUUID().replaceAll('-', '')}`);
    this.getProjectsFolder = options.getProjectsFolder ?? (() => 'workspace');
    this.now = options.now ?? (() => new Date());
  }

  joinProject(
    request: CollabInvitationJoinRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.#startIntent(
      intent => this.#joinProjectUnlocked(request, intent, options.signal),
      options.signal,
    );
  }

  resumeJoin(
    request: CollabResumeSetupRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.#startIntent(
      intent => this.#resumeJoinUnlocked(request, intent),
      options.signal,
    );
  }

   #startIntent(
    operation: (intent: ActiveJoinIntent) => Promise<CollabResult<CollabLocalProjectSummary>>,
    externalSignal?: AbortSignal,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    this.#activeIntent?.controller.abort();
    const intent: ActiveJoinIntent = {
      controller: new AbortController(),
    };
    const onExternalAbort = () => intent.controller.abort();
    if (externalSignal?.aborted) intent.controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    this.#activeIntent = intent;
    const pending = this.#operationQueue.run(() => operation(intent));
    void pending.finally(() => {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.#activeIntent === intent) this.#activeIntent = null;
    }).catch(() => undefined);
    return pending;
  }

   async #joinProjectUnlocked(
    request: CollabInvitationJoinRequest,
    intent: ActiveJoinIntent,
    _externalSignal?: AbortSignal,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record: JoinProjectRecord | null = null;
    try {
      throwIfCancelled(intent.controller.signal);
      const displayName = validateDisplayName(request.memberDisplayName);
      const invitation = this.#invitationCodec.decode(request.encodedInvitation.trim());
      const existing = await this.#readExistingProject(invitation.projectId);
      if (existing) {
        if (
          existing.memberDisplayName !== displayName
          || existing.endpoint !== invitation.endpoint
          || existing.hostCaFingerprint !== invitation.caFingerprint
        ) {
          throw joinError('idempotency-conflict', 'pending-join-mismatch');
        }
        record = existing;
        if (
          phaseRank(record.phase) < phaseRank('membership-created')
          && record.encodedInvitation !== request.encodedInvitation.trim()
        ) {
          record = await this.#updateRecord(record, {
            encodedInvitation: request.encodedInvitation.trim(),
          });
        }
      } else {
        const parsedProjectsFolder = parseCollabProjectsFolder(this.getProjectsFolder());
        if (!parsedProjectsFolder.ok) {
          throw joinError('workspace-boundary-invalid', 'projects-folder-invalid');
        }
        const projectsFolder = parsedProjectsFolder.value;
        await this.foundation.local.workspace.claimProjectsFolder(projectsFolder);
        const joinAttemptId = this.#createJoinAttemptId();
        if (!isCollabOpaqueId(joinAttemptId)) {
          throw joinError('operation-failed', 'join-attempt-id-invalid');
        }
        const slug = await this.#claimSlug(
          projectsFolder,
          request.projectSlug,
          invitation.projectId,
        );
        const timestamp = this.now().toISOString();
        record = {
          createdAt: timestamp,
          encodedInvitation: request.encodedInvitation.trim(),
          endpoint: invitation.endpoint,
          hostCaCertificatePem: null,
          hostCaFingerprint: invitation.caFingerprint,
          joinAttemptId,
          lastEventSequence: null,
          memberCredential: null,
          memberDisplayName: displayName,
          memberId: null,
          memberRole: null,
          membershipExpiresAt: null,
          operationId: joinAttemptId,
          operationKind: 'join-project',
          phase: 'planned',
          projectId: invitation.projectId,
          projectName: null,
          projectsFolder,
          schemaVersion: COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
          slug,
          stagingDirectoryName: `.claudian-join-${joinAttemptId}`,
          updatedAt: timestamp,
        };
        await this.#saveRecord(record);
        await this.foundation.local.projects.upsertProject(this.#indexEntry(record));
      }
      await this.foundation.local.workspace.claimProjectsFolder(record.projectsFolder);
      return await this.advance(record, intent.controller.signal);
    } catch (error) {
      return this.#handleFailure(record, error);
    }
  }

   async #resumeJoinUnlocked(
    request: CollabResumeSetupRequest,
    intent: ActiveJoinIntent,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record: JoinProjectRecord | null = null;
    try {
      record = await this.#findPending(request.operationId);
      if (!record) throw joinError('project-not-found', 'pending-join-not-found');
      await this.foundation.local.workspace.claimProjectsFolder(record.projectsFolder);
      throwIfCancelled(intent.controller.signal);
      return await this.advance(record, intent.controller.signal);
    } catch (error) {
      return this.#handleFailure(record, error);
    }
  }

  private async advance(
    initialRecord: JoinProjectRecord,
    signal: AbortSignal,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record = initialRecord;
    let httpClient = this.#httpClientFor(record.projectId);
    let pinnedClient;

    if (phaseRank(record.phase) < phaseRank('membership-created')) {
      if (!record.encodedInvitation) {
        throw joinError('repository-invalid', 'pending-invitation-missing');
      }
      const invitation = this.#invitationCodec.decodePendingJoinRecovery(
        record.encodedInvitation,
      );
      pinnedClient = await httpClient.bootstrapInvitation(invitation, { signal });
      record = await this.#loadRecord(record.projectId);
      throwIfCancelled(signal);
      if (record.phase !== 'trusted') {
        throw joinError('repository-invalid', 'join-trust-phase-invalid');
      }
      this.#remoteMembershipMayExist.add(record.operationId);
      const attempt = await new JoinControlClient(pinnedClient).createJoinAttempt({
        displayName: record.memberDisplayName,
        invitationSecret: invitation.invitationSecret,
        joinAttemptId: record.joinAttemptId,
        projectId: record.projectId,
      }, { signal });
      if (
        attempt.id !== record.joinAttemptId
        || attempt.projectId !== record.projectId
        || attempt.member.displayName !== record.memberDisplayName
        || attempt.member.status !== 'pending'
      ) {
        throw joinError('repository-invalid', 'join-attempt-response-mismatch');
      }
      record = await this.#updateRecord(record, {
        encodedInvitation: null,
        memberCredential: attempt.memberCredential,
        memberId: attempt.member.id,
        membershipExpiresAt: attempt.expiresAt,
        phase: 'membership-created',
      });
    }

    if (
      record.phase !== 'activated'
      && Date.parse(record.membershipExpiresAt!) <= this.now().getTime()
    ) {
      await this.expire(record);
      throw joinError('membership-revoked', 'pending-membership-expired', [
        'refresh-invitation',
      ]);
    }

    if (record.phase === 'membership-created') {
      record = await this.#cloneIntoStaging(record, signal);
    }
    if (record.phase === 'clone-completed') {
      record = await this.#placeWorkingCopy(record, signal);
    }
    if (record.phase === 'placed') {
      throwIfCancelled(signal);
      httpClient = this.#httpClientFor(record.projectId);
      pinnedClient = await httpClient.fromStoredTrust(record.projectId);
      const snapshot = await new JoinControlClient(pinnedClient).activateJoinAttempt({
        joinAttemptId: record.joinAttemptId,
        memberCredential: record.memberCredential!,
        projectId: record.projectId,
      }, { signal });
      if (
        snapshot.project.id !== record.projectId
        || snapshot.currentMember.id !== record.memberId
        || snapshot.currentMember.displayName !== record.memberDisplayName
        || snapshot.currentMember.personalRef !== collabMemberRef(record.memberId)
        || snapshot.currentMember.status !== 'active'
      ) {
        throw joinError('repository-invalid', 'activation-response-mismatch');
      }
      record = await this.#updateRecord(record, {
        lastEventSequence: snapshot.eventSequence,
        memberRole: snapshot.currentMember.role,
        phase: 'activated',
        projectName: snapshot.project.name,
      });
    }
    if (record.phase !== 'activated') {
      throw joinError('repository-invalid', 'join-phase-invalid');
    }
    return this.finish(record, signal);
  }

   async #cloneIntoStaging(
    record: JoinProjectRecord,
    signal: AbortSignal,
  ): Promise<JoinProjectRecord> {
    throwIfCancelled(signal);
    const stagingPath = this.#workspaceChildPath(record, record.stagingDirectoryName);
    if (record.legacyJoinRecord) {
      const legacyStaging = await lstat(stagingPath).catch(() => null);
      if (legacyStaging) {
        if (!legacyStaging.isDirectory() || legacyStaging.isSymbolicLink()) {
          throw joinError('workspace-boundary-invalid', 'join-staging-boundary-invalid');
        }
        const git = await this.foundation.requireGitFoundation();
        await this.#workingCopy.validate(stagingPath, this.#workingCopyInput(record), git);
        return this.#updateRecord(record, { phase: 'clone-completed' });
      }
    }
    const caPath = await this.#writeTemporaryCa(record);
    try {
      await this.#workingCopy.clone({
        ...this.#workingCopyInput(record),
        displayName: record.memberDisplayName,
        remoteUrl: gitRemoteUrl(record),
      }, this.#gitNetwork(record, caPath), signal);
    } finally {
      await this.#removeTemporaryCa(record).catch(() => undefined);
    }
    return this.#updateRecord(record, { phase: 'clone-completed' });
  }

   async #placeWorkingCopy(
    record: JoinProjectRecord,
    signal: AbortSignal,
  ): Promise<JoinProjectRecord> {
    await this.#workingCopy.place(this.#workingCopyInput(record), signal);
    return this.#updateRecord(record, { phase: 'placed' });
  }

  private async finish(
    record: JoinProjectRecord,
    signal: AbortSignal,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    throwIfCancelled(signal);
    const timestamp = this.now().toISOString();
    const membership: CollabLocalMembershipRecord = {
      authority: {
        authorityGeneration: 1,
        endpoint: record.endpoint,
        gitRemoteUrl: gitRemoteUrl(record),
        hostCaCertificatePem: record.hostCaCertificatePem!,
        hostCaFingerprint: record.hostCaFingerprint,
        kind: 'lan',
      },
      createdAt: record.createdAt,
      hostOwnership: { ownsAuthority: false },
      lastEventSequence: record.lastEventSequence!,
      member: {
        credential: record.memberCredential!,
        displayName: record.memberDisplayName,
        id: record.memberId!,
        personalRef: collabMemberRef(record.memberId!),
        role: record.memberRole!,
      },
      project: {
        id: record.projectId,
        name: record.projectName!,
        workspacePath: `${record.projectsFolder}/${record.slug}`,
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: timestamp,
    };
    await this.#workingCopy.finalize(membership, signal);
    await this.foundation.local.projects.removeProjectDocument(
      record.projectId,
      'pending-operation',
    );
    await this.#removeTemporaryCa(record).catch(() => undefined);
    this.#remoteMembershipMayExist.delete(record.operationId);
    return {
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'connected',
        health: 'healthy',
        hostInstallationStatus: 'not-host',
        hostStatus: 'not-host',
        id: record.projectId,
        name: record.projectName!,
        role: record.memberRole!,
        workspacePath: `${record.projectsFolder}/${record.slug}`,
      },
    };
  }

   #workingCopyInput(record: JoinProjectRecord): CollabWorkingCopyPlacement {
    return {
      memberId: record.memberId!,
      personalRef: collabMemberRef(record.memberId!),
      projectId: record.projectId,
      projectsFolder: record.projectsFolder,
      slug: record.slug,
      staging: this.#stagingOwnership(record),
      stagingProvenance: record.legacyJoinRecord ? 'legacy-lan-join-v1' : 'reserved',
    };
  }

   async #handleFailure(
    record: JoinProjectRecord | null,
    error: unknown,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const collabError = asJoinError(error);
    const current = record
      ? await this.#tryLoadRecord(record.projectId) ?? record
      : null;
    if (collabError.code === 'membership-revoked' && current) {
      try {
        await this.expire(current);
      } catch {
        return {
          error: joinError(
            'operation-failed',
            'join-cleanup-incomplete',
            ['resume', 'open-diagnostics'],
          ),
          status: 'failure',
        };
      }
      return { error: collabError, status: 'failure' };
    }
    if (
      current
      && (
        phaseRank(current.phase) >= phaseRank('membership-created')
        || this.#remoteMembershipMayExist.has(current.operationId)
      )
    ) {
      if (current.phase === 'membership-created') {
        await this.#removeOwnedStaging(current).catch(() => undefined);
      }
      return {
        durablePhase: 'committed',
        durableProgress: true,
        error: joinError(
          'durable-progress-recovery-required',
          collabError.code,
          ['resume', 'open-diagnostics'],
        ),
        operationId: current.operationId,
        status: 'recovery-required',
      };
    }
    if (current) {
      try {
        await this.#cleanupBeforeMembership(current);
      } catch {
        return {
          error: joinError(
            'operation-failed',
            'join-cleanup-incomplete',
            ['resume', 'open-diagnostics'],
          ),
          status: 'failure',
        };
      }
    }
    return collabError.code === 'cancelled'
      ? {
        ...(current ? { operationId: current.operationId } : {}),
        durableProgress: false,
        status: 'cancelled',
      }
      : { error: collabError, status: 'failure' };
  }

   async #cleanupBeforeMembership(record: JoinProjectRecord): Promise<void> {
    await this.#removeOwnedStaging(record).catch(() => undefined);
    await this.#removeTemporaryCa(record).catch(() => undefined);
    await this.foundation.local.projects.discardPendingOperation(record.projectId);
  }

  private async expire(record: JoinProjectRecord): Promise<void> {
    if (phaseRank(record.phase) < phaseRank('placed')) {
      await this.#removeOwnedStaging(record).catch(() => undefined);
    }
    await this.#removeTemporaryCa(record).catch(() => undefined);
    await this.foundation.local.projects.discardPendingOperation(record.projectId);
    this.#remoteMembershipMayExist.delete(record.operationId);
  }

   #httpClientFor(projectId: string): JoinHttpClientPort {
    const trustStore = new JoinTrustStore(
      projectId,
      () => this.#loadRecord(projectId),
      async (record, trust) => {
        await this.#updateRecord(record, {
          hostCaCertificatePem: trust.caCertificatePem,
          ...(record.phase === 'planned' ? { phase: 'trusted' as const } : {}),
        });
      },
    );
    return this.#createHttpClient(trustStore);
  }

   async #readExistingProject(projectId: string): Promise<JoinProjectRecord | null> {
    const membership = await this.foundation.local.projects.loadMembership(projectId);
    if (membership) throw joinError('operation-failed', 'duplicate-local-project');
    const pending = await this.foundation.local.projects.loadProjectDocument(
      projectId,
      'pending-operation',
      decodeCollabPendingProjectOperation,
    );
    if (!pending) return null;
    if (pending.kind !== 'join-project') {
      throw joinError('operation-failed', 'duplicate-local-project');
    }
    return pending.record;
  }

   async #findPending(operationId: string): Promise<JoinProjectRecord | null> {
    if (!isCollabOpaqueId(operationId)) return null;
    const projectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    let match: JoinProjectRecord | null = null;
    for (const projectId of projectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending?.kind === 'join-project' && pending.record.operationId === operationId) {
        if (match) throw joinError('repository-invalid', 'pending-operation-duplicate');
        match = pending.record;
      }
    }
    return match;
  }

   async #claimSlug(
    projectsFolder: string,
    requestedSlug: string | undefined,
    projectId: string,
  ): Promise<string> {
    const index = await this.foundation.local.projects.loadIndex();
    const reserved = new Set(index.projects.map(project => project.workspacePath));
    const pendingProjectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    for (const pendingProjectId of pendingProjectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        pendingProjectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending && pending.kind !== 'cloud-relocation') {
        reserved.add(`${pending.record.projectsFolder}/${pending.record.slug}`);
      }
    }
    if (requestedSlug !== undefined) {
      const slug = requestedSlug.trim();
      if (!isCollabWorkingCopySlug(slug)) {
        throw joinError('workspace-boundary-invalid', 'project-slug-invalid');
      }
      if (
        reserved.has(`${projectsFolder}/${slug}`)
        || await lstat(this.#workspaceChildPathForRoot(projectsFolder, slug))
          .then(() => true, () => false)
      ) {
        throw joinError('workspace-boundary-invalid', 'project-slug-collision');
      }
      return slug;
    }
    const base = isCollabWorkingCopySlug(projectId) ? projectId : 'project';
    for (let suffix = 1; suffix <= 9_999; suffix += 1) {
      const slug = suffix === 1 ? base : `${base.slice(0, 58)}-${suffix}`;
      if (reserved.has(`${projectsFolder}/${slug}`)) continue;
      if (!await lstat(this.#workspaceChildPathForRoot(projectsFolder, slug))
        .then(() => true, () => false)) {
        return slug;
      }
    }
    throw joinError('workspace-boundary-invalid', 'project-slug-unavailable');
  }

   #indexEntry(record: JoinProjectRecord) {
    return {
      authorityKind: 'lan' as const,
      createdAt: record.createdAt,
      id: record.projectId,
      name: record.projectName ?? record.projectId,
      updatedAt: this.now().toISOString(),
      workspacePath: `${record.projectsFolder}/${record.slug}`,
    };
  }

  #saveRecord(record: JoinProjectRecord): Promise<void> {
    const normalized = decodeJoinProjectRecord(record);
    if (record.legacyJoinRecord && record.phase !== 'placed' && record.phase !== 'activated') {
      const { projectsFolder: _projectsFolder, ...legacy } = normalized;
      return this.foundation.local.projects.saveProjectDocument(
        normalized.projectId, 'pending-operation', { ...legacy, schemaVersion: 1 },
      );
    }
    return this.foundation.local.projects.saveProjectDocument(
      normalized.projectId,
      'pending-operation',
      normalized,
    );
  }

   async #updateRecord(
    record: JoinProjectRecord,
    changes: Partial<Omit<JoinProjectRecord, 'schemaVersion' | 'projectId'>>,
  ): Promise<JoinProjectRecord> {
    const decoded = decodeJoinProjectRecord({
      ...record,
      ...changes,
      updatedAt: this.now().toISOString(),
    });
    const updated: JoinProjectRecord = {
      ...decoded,
      ...(record.legacyJoinRecord ? { legacyJoinRecord: true as const } : {}),
    };
    await this.#saveRecord(updated);
    return updated;
  }

   async #loadRecord(projectId: string): Promise<JoinProjectRecord> {
    const record = await this.#tryLoadRecord(projectId);
    if (!record) throw joinError('project-not-found', 'pending-join-not-found');
    return record;
  }

   #tryLoadRecord(projectId: string): Promise<JoinProjectRecord | null> {
    return this.foundation.local.projects.loadProjectDocument(
      projectId,
      'pending-operation',
      decodeJoinProjectRecord,
    );
  }

   #gitNetwork(record: JoinProjectRecord, caPath: string): GitNetworkEnvironment {
    return {
      headers: [{
        name: 'Authorization',
        value: `Basic ${Buffer.from(
          `${record.memberId}:${record.memberCredential}`,
        ).toString('base64')}`,
      }],
      sslCaInfoPath: caPath,
    };
  }

   #temporaryCaRelativePath(record: JoinProjectRecord): string {
    return `.claudian/collab/projects/${record.projectId}/join-ca.pem`;
  }

   async #writeTemporaryCa(record: JoinProjectRecord): Promise<string> {
    await writeCollabFileAtomically(
      this.options.vaultRoot,
      this.#temporaryCaRelativePath(record),
      record.hostCaCertificatePem!,
      { mode: 0o600 },
    );
    return resolveCollabVaultPath(
      this.options.vaultRoot,
      this.#temporaryCaRelativePath(record),
      { mustExist: true },
    );
  }

   #removeTemporaryCa(record: JoinProjectRecord): Promise<boolean> {
    return removeCollabFileDurably(
      this.options.vaultRoot,
      this.#temporaryCaRelativePath(record),
    );
  }

   #workspaceChildPath(record: JoinProjectRecord, childName: string): string {
    return this.#workspaceChildPathForRoot(record.projectsFolder, childName);
  }

   #workspaceChildPathForRoot(projectsFolder: string, childName: string): string {
    return path.join(this.options.vaultRoot, ...projectsFolder.split('/'), childName);
  }

   #stagingOwnership(
    record: JoinProjectRecord,
  ): CollabProjectsFolderChildOwnership {
    if (record.stagingDirectoryName !== `.claudian-join-${record.joinAttemptId}`) {
      throw joinError('workspace-boundary-invalid', 'join-staging-name-invalid');
    }
    return {
      childName: record.stagingDirectoryName,
      operationId: record.operationId,
      projectId: record.projectId,
      purpose: 'join-staging',
    };
  }

   async #removeOwnedStaging(record: JoinProjectRecord): Promise<void> {
    await this.foundation.local.workspace.removeReservedProjectsFolderChild(
      record.projectsFolder,
      this.#stagingOwnership(record),
    );
  }

}
