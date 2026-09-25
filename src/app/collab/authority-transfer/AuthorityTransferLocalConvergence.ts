import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferStatus,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferImportedTargetIdentity,
} from '@/app/collab/authority-transfer/AuthorityTransferImportedTargetIdentity';
import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  authorityTransferClaimantStatus,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type { ProjectRecoveryClaimantRecord, ProjectRecoveryConvergenceIntent } from '@/app/collab/authority-transfer/claim/ProjectRecoveryClaimantRecord';
import type {
  AuthorityProjectionTransitionPort,
} from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type {
  CollabLocalLANMembershipRecord,
  CollabLocalMembershipRecord,
  CollabLocalProjectIndex,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLANMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  cloudProjectGitRemoteURL,
  validateCloudServerURL,
} from '@/app/collab/remote-authority/CloudAuthorityURLs';
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface AuthorityTransferConvergenceProjects {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
  repairIndexFromMemberships(): Promise<CollabLocalProjectIndex>;
  saveMembership(record: CollabLocalMembershipRecord): Promise<void>;
}

interface AuthorityTransferConvergenceWorkspace {
  resolveManagedProjectPath(workspacePath: string): Promise<string>;
}

interface AuthorityTransferConvergenceGit {
  rotate(input: {
    readonly newRemoteUrl: string;
    readonly newServerUrl: string | null;
    readonly oldRemoteUrl: string;
    readonly oldServerUrl: string | null;
    readonly projectId: CollabProjectId;
    readonly repositoryPath: string;
    readonly exactBindings?: boolean;
    readonly retainedBindings?: readonly { readonly remoteUrl: string; readonly serverUrl: string | null }[];
  }): Promise<void>;
}

export interface AuthorityTransferLocalConvergenceOptions {
  readonly activity: {
    transitionProject(projectId: CollabProjectId, operation: () => Promise<void>): Promise<void>;
  };
  readonly authorityProjectionTransitions: AuthorityProjectionTransitionPort;
  readonly git: AuthorityTransferConvergenceGit;
  readonly now?: () => Date;
  readonly projects: AuthorityTransferConvergenceProjects;
  readonly settleLocalAuthorityAdvance: (identity: {
    projectId: CollabProjectId; memberId: string; authorityGeneration: number;
  }) => Promise<void>;
  readonly workspace: AuthorityTransferConvergenceWorkspace;
}

export interface LANToCloudHostConvergenceInput {
  readonly snapshot: CollabProjectSnapshot;
  readonly status: CollabAuthorityTransferStatus;
}

type LANToCloudMemberProjection = Pick<
  CollabProjectSnapshot['currentMember'],
  'displayName' | 'id' | 'personalRef' | 'role'
>;

export interface CloudToLANMemberConvergenceInput {
  readonly endpoint: string;
  readonly hostCaCertificatePem: string;
  readonly hostCaFingerprint: string;
  readonly identity: AuthorityTransferImportedTargetIdentity;
  readonly memberCredential: string;
  readonly status: CollabAuthorityTransferStatus;
}

export interface CloudToLANHostConvergenceInput extends Omit<CloudToLANMemberConvergenceInput, 'endpoint'> {
  withEndpoint(operation: (endpoint: string) => Promise<void>): Promise<void>;
}

function convergenceError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function lanRemoteURL(endpoint: string, projectId: CollabProjectId): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw convergenceError('authority-transfer-target-endpoint-invalid');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.port.length === 0
  ) throw convergenceError('authority-transfer-target-endpoint-invalid');
  return `${parsed.origin}/v1/git/${projectId}/repository.git`;
}

function cloudRemoteURL(serverUrl: string, projectId: CollabProjectId): string {
  try {
    return cloudProjectGitRemoteURL(serverUrl, projectId);
  } catch {
    throw convergenceError('authority-transfer-cloud-url-invalid');
  }
}

function assertCompleted(
  status: CollabAuthorityTransferStatus,
  direction: CollabAuthorityTransferStatus['direction'],
): void {
  if (
    status.direction !== direction
    || status.phase !== 'completed'
    || status.state !== 'completed'
    || status.relinquishmentProof === null
  ) throw convergenceError('authority-transfer-convergence-status-incomplete');
}

function assertSnapshot(
  membership: CollabLocalMembershipRecord,
  snapshot: CollabProjectSnapshot,
): void {
  if (
    snapshot.project.id !== membership.project.id
    || snapshot.project.name !== membership.project.name
    || snapshot.currentMember.id !== membership.member.id
    || snapshot.currentMember.personalRef !== membership.member.personalRef
  ) throw convergenceError('authority-transfer-convergence-snapshot-mismatch');
}

export class AuthorityTransferLocalConvergence {
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferLocalConvergenceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async lanToCloudHost(input: LANToCloudHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.#transitionSourceToCloud(
      input.status,
      () => this.#lanToCloud(input, true),
    );
  }

  async lanToCloudHostOffline(status: CollabAuthorityTransferStatus): Promise<void> {
    assertCompleted(status, 'lan-to-cloud');
    return this.#transitionSourceToCloud(status, async () => {
      const membership = await this.#requireMembership(status.projectId);
      if (status.relinquishmentProof?.sourceHostMemberId !== membership.member.id) {
        throw convergenceError('authority-transfer-source-member-mismatch');
      }
      await this.#convergeLanMembershipToCloud(
        membership,
        status,
        membership.member,
        membership.lastEventSequence,
        true,
      );
    });
  }

  async lanToCloudMember(input: LANToCloudHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.#transitionProject(
      input.status.projectId,
      'cloud',
      () => this.#lanToCloud(input, false),
    );
  }

  async cloudToLanHost(input: CloudToLANHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.options.activity.transitionProject(input.status.projectId, () => (
      input.withEndpoint(endpoint => this.options.authorityProjectionTransitions.run(
        input.status.projectId,
        () => this.#completeProjection(input.status.projectId, 'lan', () => this.#cloudToLan({ ...input, endpoint }, true)),
      ))
    ));
  }

  async prepareProjectRecovery(record: ProjectRecoveryClaimantRecord,
    input: Omit<ProjectRecoveryConvergenceIntent, 'previousBindings'>): Promise<ProjectRecoveryConvergenceIntent> {
    const membership = await this.#requireMembership(record.projectId);
    this.#assertProjectRecoveryIdentity(record, membership, input.identity);
    const previousBindings = [{ remoteUrl: membership.authority.gitRemoteUrl!,
      serverUrl: isCollabLocalCloudMembership(membership) ? membership.authority.serverUrl : null },
      ...this.#retainedBindings(membership, record.invitation.link.authorityGeneration + 1, record.retainedAttempts)];
    if (!previousBindings[0].remoteUrl) throw convergenceError('project-recovery-origin-missing');
    return { ...input, previousBindings: previousBindings.filter((binding, index) =>
      previousBindings.findIndex(other => other.remoteUrl === binding.remoteUrl && other.serverUrl === binding.serverUrl) === index) };
  }

  async restoreProjectRecovery(record: ProjectRecoveryClaimantRecord): Promise<void> {
    const plan = record.convergence;
    if (!record.redemptionReceipt || !plan) throw convergenceError('project-recovery-proof-missing');
    return this.#transitionProject(record.projectId, plan.target.kind, async () => {
      const membership = await this.#requireMembership(record.projectId);
      this.#assertProjectRecoveryIdentity(record, membership, plan.identity);
      const { identity, target } = plan;
      const remoteUrl = target.kind === 'cloud' ? cloudRemoteURL(target.serverUrl, record.projectId) : lanRemoteURL(target.endpoint, record.projectId);
      const serverUrl = target.kind === 'cloud' ? target.serverUrl : null;
      if (!membership.authority.gitRemoteUrl || !plan.previousBindings.some(binding => binding.remoteUrl === membership.authority.gitRemoteUrl
        && binding.serverUrl === (isCollabLocalCloudMembership(membership) ? membership.authority.serverUrl : null))
        && membership.authority.gitRemoteUrl !== remoteUrl) throw convergenceError('project-recovery-origin-conflict');
      await this.options.git.rotate({ projectId: record.projectId,
        repositoryPath: await this.options.workspace.resolveManagedProjectPath(membership.project.workspacePath),
        oldRemoteUrl: plan.previousBindings[0].remoteUrl, oldServerUrl: plan.previousBindings[0].serverUrl,
        newRemoteUrl: remoteUrl, newServerUrl: serverUrl, retainedBindings: plan.previousBindings, exactBindings: true });
      const common = { createdAt: membership.createdAt, updatedAt: this.timestamp(membership.updatedAt),
        schemaVersion: membership.schemaVersion, project: membership.project, lastEventSequence: identity.eventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }) };
      if (target.kind === 'cloud') {
        await this.options.projects.saveMembership({ ...common,
          authority: { kind: 'cloud', authorityGeneration: identity.authorityGeneration, serverUrl: target.serverUrl,
            gitRemoteUrl: remoteUrl, wireVersion: COLLAB_PROTOCOL_VERSION, bindingVersion: COLLAB_CLOUD_BINDING_VERSION },
          member: { id: identity.currentMember.id, personalRef: identity.currentMember.personalRef,
            role: identity.currentMember.role, displayName: identity.currentMember.displayName } });
      } else {
        if (!record.targetCredential) throw convergenceError('project-recovery-credential-missing');
        await this.options.projects.saveMembership({ ...common,
          authority: { kind: 'lan', authorityGeneration: identity.authorityGeneration, endpoint: new URL(target.endpoint).origin,
            gitRemoteUrl: remoteUrl, hostCaCertificatePem: target.caCertificatePem, hostCaFingerprint: target.caFingerprint },
          hostOwnership: { autoStart: false, ownsAuthority: false },
          member: { id: identity.currentMember.id, personalRef: identity.currentMember.personalRef,
            role: identity.currentMember.role, displayName: identity.currentMember.displayName, credential: record.targetCredential } });
      }

    });
  }

  #assertProjectRecoveryIdentity(record: ProjectRecoveryClaimantRecord, membership: CollabLocalMembershipRecord,
    identity: AuthorityTransferImportedTargetIdentity): void {
    if (membership.member.id !== record.memberId || membership.member.personalRef !== record.memberPersonalRef
      || identity.project.id !== record.projectId || identity.currentMember.id !== record.memberId
      || identity.currentMember.personalRef !== record.memberPersonalRef || identity.authorityGeneration !== record.invitation.link.authorityGeneration
      || membership.authority.authorityGeneration > identity.authorityGeneration
      || isCollabLocalLANMembership(membership) && membership.hostOwnership.ownsAuthority) throw convergenceError('project-recovery-identity-invalid');
  }

  async restoreCloudMembership(input: LANToCloudHostConvergenceInput, retainedAttempts: readonly AuthorityTransferClaimantRecord[] = []): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.#transitionProject(input.status.projectId, 'cloud', async () => {
      const membership = await this.#requireMembership(input.status.projectId);
      assertSnapshot(membership, input.snapshot);
      const targetGeneration = input.status.targetAuthority.generation;
      if (input.snapshot.project.authorityKind !== 'cloud'
        || input.snapshot.project.authorityGeneration !== targetGeneration
        || membership.authority.authorityGeneration > targetGeneration
        || isCollabLocalLANMembership(membership) && membership.hostOwnership.ownsAuthority) {
        throw convergenceError('authority-transfer-convergence-generation-mismatch');
      }
      if (membership.authority.authorityGeneration === targetGeneration) {
        if (!isCollabLocalCloudMembership(membership)) throw convergenceError('authority-transfer-cloud-membership-conflict');
        await this.#lanToCloud(input, false);
        return;
      }
      await this.#writeCloudMembership(membership, input.status, input.snapshot.currentMember, input.snapshot.eventSequence, this.#retainedBindings(membership, targetGeneration, retainedAttempts));

    });
  }

  async restoreLanMembership(input: Omit<CloudToLANMemberConvergenceInput, 'status'>, retainedAttempts: readonly AuthorityTransferClaimantRecord[] = []): Promise<void> {
    return this.#transitionProject(input.identity.project.id, 'lan', async () => {
      const membership = await this.#requireMembership(input.identity.project.id);
      if (membership.project.name !== input.identity.project.name
        || membership.member.id !== input.identity.currentMember.id
        || membership.member.personalRef !== input.identity.currentMember.personalRef
        || membership.authority.authorityGeneration > input.identity.authorityGeneration
        || isCollabLocalLANMembership(membership) && membership.hostOwnership.ownsAuthority) {
        throw convergenceError('authority-transfer-convergence-target-identity-mismatch');
      }
      await this.#writeLanMembership(membership, input, false, this.#retainedBindings(membership, input.identity.authorityGeneration, retainedAttempts));
    });
  }

  async cloudToLanMember(input: CloudToLANMemberConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.#transitionProject(
      input.status.projectId,
      'lan',
      () => this.#cloudToLan(input, false),
    );
  }

  async recoverConvertedClaimant(record: AuthorityTransferClaimantRecord): Promise<void> {
    if (record.variant === 'project-recovery') return this.restoreProjectRecovery(record);
    if (record.variant === 'manager-reissued' && record.lanTarget) {
      return this.#transitionProject(record.projectId, 'lan', async () => {
        const membership = await this.#requireMembership(record.projectId);
        if (!isCollabLocalLANMembership(membership) || membership.hostOwnership.ownsAuthority
          || membership.member.id !== record.memberId || membership.member.personalRef !== record.memberPersonalRef
          || membership.member.credential !== record.targetCredential
          || membership.authority.authorityGeneration !== record.descriptor.targetAuthorityGeneration
          || membership.authority.hostCaCertificatePem !== record.lanTarget!.caCertificatePem
          || membership.authority.hostCaFingerprint !== record.lanTarget!.caFingerprint
          || membership.authority.endpoint === null
          || membership.authority.gitRemoteUrl !== lanRemoteURL(membership.authority.endpoint, record.projectId)) {
          throw convergenceError('authority-transfer-lan-membership-conflict');
        }

      });
    }

    const status = authorityTransferClaimantStatus(record);
    if (!status) throw convergenceError('authority-transfer-claimant-status-missing');
    assertCompleted(status, status.direction);
    return this.#transitionProject(record.projectId, status.targetAuthority.kind, async () => {
      const membership = await this.#requireMembership(record.projectId);
      if (membership.member.id !== record.memberId) {
        throw convergenceError('authority-transfer-claimant-member-conflict');
      }
      if (status.direction === 'lan-to-cloud') {
        const serverUrl = validateCloudServerURL(
          status.targetUrl,
          'authorityTransferTargetUrl',
        );
        if (
          !isCollabLocalCloudMembership(membership)
          || membership.authority.authorityGeneration
            !== status.targetAuthority.generation
          || membership.authority.serverUrl !== serverUrl
          || membership.authority.gitRemoteUrl
            !== cloudRemoteURL(status.targetUrl, record.projectId)
        ) throw convergenceError('authority-transfer-cloud-membership-conflict');

        return;
      }
      if (record.variant !== 'source-issued') {
        throw convergenceError('authority-transfer-claimant-direction-invalid');
      }
      const lanTarget = record.lanTarget;
      const targetCredential = record.targetCredential;
      if (!lanTarget || !targetCredential || !isCollabLocalLANMembership(membership)) {
        throw convergenceError('authority-transfer-lan-membership-conflict');
      }
      const endpoint = membership.authority.endpoint;
      if (
        membership.authority.authorityGeneration !== status.targetAuthority.generation
        || endpoint === null
        || membership.authority.gitRemoteUrl !== lanRemoteURL(endpoint, record.projectId)
        || membership.authority.hostCaCertificatePem !== lanTarget.caCertificatePem
        || membership.authority.hostCaFingerprint !== lanTarget.caFingerprint
        || membership.member.credential !== targetCredential
        || membership.hostOwnership.autoStart
        || membership.hostOwnership.ownsAuthority
      ) throw convergenceError('authority-transfer-lan-membership-conflict');

    });
  }

  #transitionProject(
    projectId: CollabProjectId,
    authorityKind: 'cloud' | 'lan',
    operation: () => Promise<void>,
  ): Promise<void> {
    return this.options.activity.transitionProject(projectId, () => (
      this.options.authorityProjectionTransitions.run(projectId, () => this.#completeProjection(projectId, authorityKind, operation))
    ));
  }

  #transitionSourceToCloud(status: CollabAuthorityTransferStatus, operation: () => Promise<void>): Promise<void> {
    return this.options.activity.transitionProject(status.projectId, () => (
      this.options.authorityProjectionTransitions.run(status.projectId, async () => {
        const membership = await this.#requireMembership(status.projectId);
        if (membership.member.id !== status.relinquishmentProof?.sourceHostMemberId) {
          throw convergenceError('authority-transfer-source-member-mismatch');
        }
        // A retained source still owes cleanup, but later authority bindings
        // already include this move and must not be projected back to its target.
        if (membership.authority.authorityGeneration > status.targetAuthority.generation) {
          await this.finish(status.projectId, membership.authority.kind);
          return;
        }
        await this.#completeProjection(status.projectId, 'cloud', operation);
      })
    ));
  }

  async #completeProjection(projectId: CollabProjectId, authorityKind: 'cloud' | 'lan', operation: () => Promise<void>): Promise<void> {
    await operation();
    await this.finish(projectId, authorityKind);
  }

  async #lanToCloud(
    input: LANToCloudHostConvergenceInput,
    sourceOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.#requireMembership(input.status.projectId);
    assertSnapshot(membership, input.snapshot);
    if (
      input.snapshot.project.authorityKind !== 'cloud'
      || input.snapshot.project.authorityGeneration !== input.status.targetAuthority.generation
    ) throw convergenceError('authority-transfer-convergence-generation-mismatch');
    await this.#convergeLanMembershipToCloud(
      membership,
      input.status,
      input.snapshot.currentMember,
      input.snapshot.eventSequence,
      sourceOwnsAuthority,
    );
  }

  async #convergeLanMembershipToCloud(
    membership: CollabLocalMembershipRecord,
    status: CollabAuthorityTransferStatus,
    member: LANToCloudMemberProjection,
    lastEventSequence: number,
    sourceOwnsAuthority: boolean,
  ): Promise<void> {
    const newRemoteUrl = cloudRemoteURL(status.targetUrl, status.projectId);
    const serverUrl = validateCloudServerURL(
      status.targetUrl,
      'authorityTransferTargetUrl',
    );
    if (isCollabLocalLANMembership(membership)) {
      const oldRemoteUrl = membership.authority.gitRemoteUrl;
      if (
        !oldRemoteUrl
        || membership.hostOwnership.ownsAuthority !== sourceOwnsAuthority
      ) {
        throw convergenceError('authority-transfer-source-membership-invalid');
      }
      await this.#writeCloudMembership(membership, status, member, lastEventSequence);
    } else {
      if (
        membership.authority.authorityGeneration
          !== status.targetAuthority.generation
        || membership.authority.gitRemoteUrl !== newRemoteUrl
        || membership.authority.serverUrl !== serverUrl
      ) throw convergenceError('authority-transfer-cloud-membership-conflict');
    }

  }

  async #writeCloudMembership(
    membership: CollabLocalMembershipRecord,
    status: CollabAuthorityTransferStatus,
    member: LANToCloudMemberProjection,
    lastEventSequence: number,
    retainedBindings?: Parameters<AuthorityTransferConvergenceGit['rotate']>[0]['retainedBindings'],
  ): Promise<void> {
    const newRemoteUrl = cloudRemoteURL(status.targetUrl, status.projectId);
    const serverUrl = validateCloudServerURL(status.targetUrl, 'authorityTransferTargetUrl');
    if (!membership.authority.gitRemoteUrl) throw convergenceError('authority-transfer-source-membership-invalid');
    await this.#rotate(membership, membership.authority.gitRemoteUrl, newRemoteUrl, serverUrl, retainedBindings);
    await this.options.projects.saveMembership({
      authority: {
        authorityGeneration: status.targetAuthority.generation,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: newRemoteUrl,
        kind: 'cloud',
        serverUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      createdAt: membership.createdAt,
      lastEventSequence,
      ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
      member: {
        displayName: member.displayName,
        id: member.id,
        personalRef: member.personalRef,
        role: member.role,
      },
      project: membership.project,
      schemaVersion: membership.schemaVersion,
      updatedAt: this.timestamp(membership.updatedAt),
    });
  }

  async #cloudToLan(
    input: CloudToLANMemberConvergenceInput,
    targetOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.#requireMembership(input.status.projectId);
    const identity = input.identity;
    if (
      identity.project.id !== membership.project.id
      || identity.project.name !== membership.project.name
      || identity.currentMember.id !== membership.member.id
      || identity.currentMember.personalRef !== membership.member.personalRef
      || identity.authorityGeneration !== input.status.targetAuthority.generation
    ) throw convergenceError('authority-transfer-convergence-target-identity-mismatch');
    await this.#writeLanMembership(membership, input, targetOwnsAuthority);
  }

  async #writeLanMembership(
    membership: CollabLocalMembershipRecord,
    input: Omit<CloudToLANMemberConvergenceInput, 'status'>,
    targetOwnsAuthority: boolean,
    retainedBindings?: Parameters<AuthorityTransferConvergenceGit['rotate']>[0]['retainedBindings'],
  ): Promise<void> {
    const identity = input.identity;
    const newRemoteUrl = lanRemoteURL(input.endpoint, identity.project.id);
    if (isCollabLocalCloudMembership(membership) || membership.authority.authorityGeneration < identity.authorityGeneration) {
      if (!membership.authority.gitRemoteUrl) throw convergenceError('authority-transfer-origin-missing');
      await this.#rotate(membership, membership.authority.gitRemoteUrl, newRemoteUrl, null, retainedBindings);
      const candidate: CollabLocalLANMembershipRecord = {
        authority: {
          authorityGeneration: identity.authorityGeneration,
          endpoint: new URL(input.endpoint).origin,
          gitRemoteUrl: newRemoteUrl,
          hostCaCertificatePem: input.hostCaCertificatePem,
          hostCaFingerprint: input.hostCaFingerprint,
          kind: 'lan',
        },
        createdAt: membership.createdAt,
        hostOwnership: {
          autoStart: targetOwnsAuthority,
          ownsAuthority: targetOwnsAuthority,
        },
        lastEventSequence: identity.eventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
        member: {
          credential: input.memberCredential,
          displayName: identity.currentMember.displayName,
          id: identity.currentMember.id,
          personalRef: identity.currentMember.personalRef,
          role: identity.currentMember.role,
        },
        project: membership.project,
        schemaVersion: membership.schemaVersion,
        updatedAt: this.timestamp(membership.updatedAt),
      };
      await this.options.projects.saveMembership(candidate);
    } else {
      if (membership.authority.authorityGeneration
        !== identity.authorityGeneration
      || membership.authority.hostCaCertificatePem !== input.hostCaCertificatePem
      || membership.authority.hostCaFingerprint !== input.hostCaFingerprint
      || membership.member.credential !== input.memberCredential
      || membership.hostOwnership.ownsAuthority !== targetOwnsAuthority
      || typeof membership.hostOwnership.autoStart !== 'boolean'
      || (!targetOwnsAuthority && membership.hostOwnership.autoStart !== false)
      || membership.authority.endpoint === null
      || membership.authority.gitRemoteUrl !== lanRemoteURL(membership.authority.endpoint, identity.project.id)
      ) throw convergenceError('authority-transfer-lan-membership-conflict');
      if (membership.authority.endpoint !== new URL(input.endpoint).origin) {
        await this.#rotate(membership, membership.authority.gitRemoteUrl, newRemoteUrl, null, retainedBindings);
        await this.options.projects.saveMembership({
          ...membership,
          authority: { ...membership.authority, endpoint: new URL(input.endpoint).origin, gitRemoteUrl: newRemoteUrl },
          updatedAt: this.timestamp(membership.updatedAt),
        });
      }
    }

  }

  private async finish(projectId: CollabProjectId, authorityKind: 'cloud' | 'lan'): Promise<void> {
    const index = await this.options.projects.repairIndexFromMemberships();
    if (index.projects.find(project => project.id === projectId)?.authorityKind !== authorityKind) {
      throw convergenceError('authority-transfer-index-convergence-failed');
    }
    const membership = await this.#requireMembership(projectId);
    await this.options.settleLocalAuthorityAdvance({
      projectId, memberId: membership.member.id, authorityGeneration: membership.authority.authorityGeneration,
    });
  }

  async #requireMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord> {
    const membership = await this.options.projects.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw convergenceError('authority-transfer-membership-missing');
    }
    return membership;
  }

  #retainedBindings(membership: CollabLocalMembershipRecord, generation: number, attempts: readonly AuthorityTransferClaimantRecord[]) {
    return attempts.flatMap(attempt => {
      if (attempt.projectId !== membership.project.id || attempt.memberId !== membership.member.id) {
        throw convergenceError('authority-transfer-retained-identity-mismatch');
      }
      if (attempt.variant === 'project-recovery') {
        if (!attempt.convergence || attempt.invitation.link.authorityGeneration >= generation) return [];
        const { target } = attempt.convergence;
        return [...attempt.convergence.previousBindings, { remoteUrl: target.kind === 'lan' ? lanRemoteURL(target.endpoint, attempt.projectId)
          : cloudRemoteURL(target.serverUrl, attempt.projectId), serverUrl: target.kind === 'lan' ? null : target.serverUrl }];
      }
      const confirmed = attempt.variant === 'source-issued'
        ? ['source-acknowledged', 'membership-converged', 'completed'].includes(attempt.phase)
        : ['target-confirmed', 'membership-converged', 'completed'].includes(attempt.phase);
      const targetGeneration = attempt.variant === 'source-issued' ? attempt.status.targetAuthority.generation : attempt.descriptor.targetAuthorityGeneration;
      if (!confirmed || targetGeneration >= generation) return [];
      const endpoint = attempt.variant === 'source-issued' ? attempt.status.targetUrl : attempt.serverUrl;
      const serverUrl = attempt.lanTarget ? null : validateCloudServerURL(endpoint, 'retainedClaimantTarget');
      return [{ remoteUrl: serverUrl === null ? lanRemoteURL(endpoint, attempt.projectId) : cloudRemoteURL(endpoint, attempt.projectId), serverUrl }];
    });
  }

  #rotate(
    membership: CollabLocalMembershipRecord,
    oldRemoteUrl: string,
    newRemoteUrl: string,
    newServerUrl: string | null,
    retainedBindings?: Parameters<AuthorityTransferConvergenceGit['rotate']>[0]['retainedBindings'],
  ): Promise<void> {
    return this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    ).then(repositoryPath => this.options.git.rotate({
      newRemoteUrl,
      newServerUrl,
      retainedBindings,
      oldRemoteUrl,
      oldServerUrl: isCollabLocalCloudMembership(membership)
        ? membership.authority.serverUrl
        : null,
      projectId: membership.project.id,
      repositoryPath,
    }));
  }

  private timestamp(previous: string): string {
    const current = this.now().toISOString();
    return Date.parse(current) >= Date.parse(previous) ? current : previous;
  }
}
