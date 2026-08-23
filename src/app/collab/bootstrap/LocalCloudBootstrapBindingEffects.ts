import {
  COLLAB_MAIN_REF,
  type CollabProjectId,
  type DevelopmentBootstrapAttemptStatus,
} from '@claudian-collab/protocol';

import type { CloudBootstrapBindingEffects } from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import type { CloudBootstrapReadinessCollector } from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import type { CloudBootstrapTransitionRecord } from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import {
  type CollabLocalCloudMembershipRecord,
  type CollabLocalMembershipRecord,
  type CollabLocalProjectIndex,
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  COLLAB_MAIN_FETCH_REFSPEC,
  COLLAB_MEMBERS_FETCH_REFSPEC,
  COLLAB_ORIGIN_MAIN_REF,
  collabOriginTrackingRef,
} from '@/app/collab/git/collabGitRefs';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import type {
  CollabAuthorityAdapter,
  CollabAuthorityGitNetwork,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface LocalCloudBootstrapBindingProjects {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
  repairIndexFromMemberships(): Promise<CollabLocalProjectIndex>;
  retireAuthorityDirectory(projectId: CollabProjectId, attemptId: string): Promise<string | null>;
  saveMembership(record: CollabLocalMembershipRecord): Promise<void>;
}

interface LocalCloudBootstrapBindingGit {
  assertOrigin(record: CloudBootstrapTransitionRecord, repositoryPath: string): Promise<void>;
  fetchFromUrl(
    repositoryPath: string,
    remote: string,
    refspecs: readonly string[],
    network?: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void>;
  resolveRefs(
    repositoryPath: string,
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string | null>>;
  network(projectId: CollabProjectId, git: CollabAuthorityGitNetwork): Promise<GitNetworkEnvironment>;
  rotateOrigin(record: CloudBootstrapTransitionRecord, repositoryPath: string): Promise<void>;
}

export interface LocalCloudBootstrapBindingEffectsOptions {
  readonly activation: {
    get(
      record: CloudBootstrapTransitionRecord,
      signal?: AbortSignal,
    ): Promise<DevelopmentBootstrapAttemptStatus | null>;
  };
  readonly authorityAdapter: Pick<CollabAuthorityAdapter, 'create'>;
  readonly authorityLifecycle: {
    closeAuthority(projectId: CollabProjectId): Promise<void>;
  };
  readonly git: LocalCloudBootstrapBindingGit;
  readonly now?: () => Date;
  readonly projects: LocalCloudBootstrapBindingProjects;
  readonly readiness: Pick<CloudBootstrapReadinessCollector, 'collect'>;
  readonly workspace: {
    resolveManagedProjectPath(workspacePath: string): Promise<string>;
  };
}

function bindingError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function normalizedFingerprint(value: string): string {
  return value.replaceAll(':', '').toLocaleLowerCase('en-US');
}

function hasSameOrigin(left: string | null, right: string): boolean {
  if (left === null) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export class LocalCloudBootstrapBindingEffects implements CloudBootstrapBindingEffects {
  private readonly now: () => Date;

  constructor(private readonly options: LocalCloudBootstrapBindingEffectsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async verifyActivation(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await this.options.activation.get(record, signal);
    const expected = record.activationResult;
    const observed = status?.activationResult;
    if (
      !expected
      || !status
      || status.state !== 'activated'
      || status.activationPhase !== 'completed'
      || status.attemptId !== record.attemptId
      || status.projectId !== record.projectId
      || status.manifestSha256 !== record.manifestSha256
      || !observed
      || observed.activatedAt !== expected.activatedAt
      || observed.activationOperationId !== expected.activationOperationId
      || observed.placementGeneration !== expected.placementGeneration
      || observed.projectId !== expected.projectId
    ) {
      throw bindingError('cloud-bootstrap-binding-activation-identity-mismatch');
    }
  }

  async confirmReadiness(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requireLanMembership(record);
    const readiness = await this.options.readiness.collect({
      manifest: record.manifest,
      memberId: record.memberId,
    }, signal);
    if (readiness.observedPersonalRefOid !== record.repositoryIdentity.personalRefOid) {
      throw bindingError('cloud-bootstrap-binding-readiness-mismatch');
    }
  }

  async rotateOrigin(record: CloudBootstrapTransitionRecord): Promise<void> {
    const membership = await this.requireLanMembership(record);
    const repositoryPath = await this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    );
    await this.options.git.rotateOrigin(record, repositoryPath);
  }

  async verifyCloud(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const membership = await this.loadExactMembership(record);
    const repositoryPath = await this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    );
    await this.options.git.assertOrigin(record, repositoryPath);
    const cloudMembership = this.cloudMembership(record, membership, membership.lastEventSequence);
    const session = await this.options.authorityAdapter.create(cloudMembership);
    try {
      if (
        !session.supports('project-snapshot')
        || !session.supports('project-events')
        || !session.supports('git-upload-pack')
        || session.git.remoteUrl !== record.newAuthority.gitRemoteUrl
      ) {
        throw bindingError('cloud-bootstrap-binding-capability-mismatch');
      }
      const snapshot = await session.control.readSnapshot(record.projectId, { signal });
      this.assertSnapshot(record, snapshot);
      await this.options.git.assertOrigin(record, repositoryPath);
      const network = await this.options.git.network(record.projectId, session.git);
      await this.options.git.assertOrigin(record, repositoryPath);
      await this.options.git.fetchFromUrl(
        repositoryPath,
        record.newAuthority.gitRemoteUrl,
        [COLLAB_MAIN_FETCH_REFSPEC, COLLAB_MEMBERS_FETCH_REFSPEC],
        network,
        signal,
      );
      const personalTrackingRef = collabOriginTrackingRef(record.repositoryIdentity.personalRef);
      const refs = await this.options.git.resolveRefs(
        repositoryPath,
        [COLLAB_ORIGIN_MAIN_REF, personalTrackingRef],
        signal,
      );
      if (
        refs.get(COLLAB_ORIGIN_MAIN_REF) !== record.repositoryIdentity.mainOid
        || refs.get(personalTrackingRef) !== record.repositoryIdentity.personalRefOid
      ) {
        throw bindingError('cloud-bootstrap-binding-git-identity-mismatch');
      }
    } finally {
      session.dispose();
    }
  }

  async replaceMembership(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const membership = await this.loadExactMembership(record);
    const candidate = this.cloudMembership(record, membership, membership.lastEventSequence);
    const session = await this.options.authorityAdapter.create(candidate);
    try {
      const snapshot = await session.control.readSnapshot(record.projectId, { signal });
      this.assertSnapshot(record, snapshot);
      await this.options.projects.saveMembership(this.cloudMembership(
        record,
        membership,
        snapshot.eventSequence,
        snapshot.currentMember,
      ));
    } finally {
      session.dispose();
    }
  }

  async repairIndex(record: CloudBootstrapTransitionRecord): Promise<void> {
    await this.requireCloudMembership(record);
    const index = await this.options.projects.repairIndexFromMemberships();
    const entry = index.projects.find(candidate => candidate.id === record.projectId);
    if (entry?.authorityKind !== 'cloud') {
      throw bindingError('cloud-bootstrap-binding-index-repair-failed');
    }
  }

  async retireLanAuthority(record: CloudBootstrapTransitionRecord): Promise<void> {
    await this.requireCloudMembership(record);
    if (record.memberId !== record.oldAuthority.sourceHostMemberId) return;
    await this.options.authorityLifecycle.closeAuthority(record.projectId);
    const retired = await this.options.projects.retireAuthorityDirectory(
      record.projectId,
      record.attemptId,
    );
    if (retired === null) {
      throw bindingError('cloud-bootstrap-binding-retired-authority-missing');
    }
  }

  private async loadExactMembership(
    record: CloudBootstrapTransitionRecord,
  ): Promise<CollabLocalMembershipRecord> {
    const membership = await this.options.projects.loadMembership(record.projectId);
    if (
      !membership
      || membership.project.id !== record.projectId
      || membership.member.id !== record.memberId
      || membership.member.personalRef !== record.repositoryIdentity.personalRef
      || membership.project.name !== record.manifest.comparison.projectName
    ) {
      throw bindingError('cloud-bootstrap-binding-membership-identity-mismatch');
    }
    if (isCollabLocalCloudMembership(membership)) {
      this.assertCloudAuthority(record, membership);
    }
    return membership;
  }

  private async requireLanMembership(
    record: CloudBootstrapTransitionRecord,
  ) {
    const membership = await this.loadExactMembership(record);
    if (
      !isCollabLocalLanMembership(membership)
      || !hasSameOrigin(membership.authority.endpoint, record.oldAuthority.endpoint)
      || membership.authority.gitRemoteUrl !== record.oldAuthority.gitRemoteUrl
      || membership.authority.hostCaFingerprint === null
      || normalizedFingerprint(membership.authority.hostCaFingerprint)
        !== record.oldAuthority.caFingerprint
    ) {
      throw bindingError('cloud-bootstrap-binding-lan-authority-mismatch');
    }
    return membership;
  }

  private async requireCloudMembership(
    record: CloudBootstrapTransitionRecord,
  ): Promise<CollabLocalCloudMembershipRecord> {
    const membership = await this.loadExactMembership(record);
    if (!isCollabLocalCloudMembership(membership)) {
      throw bindingError('cloud-bootstrap-binding-cloud-membership-missing');
    }
    return membership;
  }

  private assertCloudAuthority(
    record: CloudBootstrapTransitionRecord,
    membership: CollabLocalCloudMembershipRecord,
  ): void {
    if (
      membership.authority.bindingVersion !== record.newAuthority.bindingVersion
      || membership.authority.developmentActorId !== record.developmentActorId
      || membership.authority.gitRemoteUrl !== record.newAuthority.gitRemoteUrl
      || membership.authority.serverUrl !== record.newAuthority.serverUrl
      || membership.authority.wireVersion !== record.newAuthority.wireVersion
    ) {
      throw bindingError('cloud-bootstrap-binding-cloud-authority-mismatch');
    }
  }

  private cloudMembership(
    record: CloudBootstrapTransitionRecord,
    membership: CollabLocalMembershipRecord,
    lastEventSequence: number,
    currentMember: Pick<
      CollabProjectSnapshot['currentMember'],
      'displayName' | 'id' | 'personalRef' | 'role'
    > = membership.member,
  ): CollabLocalCloudMembershipRecord {
    return {
      authority: {
        bindingVersion: record.newAuthority.bindingVersion,
        developmentActorId: record.developmentActorId,
        gitRemoteUrl: record.newAuthority.gitRemoteUrl,
        kind: 'cloud',
        serverUrl: record.newAuthority.serverUrl,
        wireVersion: record.newAuthority.wireVersion,
      },
      createdAt: membership.createdAt,
      lastEventSequence,
      ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
      member: {
        displayName: currentMember.displayName,
        id: currentMember.id,
        personalRef: currentMember.personalRef,
        role: currentMember.role,
      },
      project: membership.project,
      schemaVersion: membership.schemaVersion,
      updatedAt: this.now().toISOString(),
    };
  }

  private assertSnapshot(
    record: CloudBootstrapTransitionRecord,
    snapshot: CollabProjectSnapshot,
  ): void {
    const manifestMember = record.manifest.comparison.members.find(candidate => (
      candidate.memberId === record.memberId
    ));
    if (
      snapshot.project.authorityKind !== 'cloud'
      || snapshot.project.id !== record.projectId
      || snapshot.project.name !== record.manifest.comparison.projectName
      || snapshot.project.mainRef !== COLLAB_MAIN_REF
      || snapshot.project.mainOid !== record.repositoryIdentity.mainOid
      || snapshot.currentMember.id !== record.memberId
      || snapshot.currentMember.personalRef !== record.repositoryIdentity.personalRef
      || snapshot.currentMember.role !== manifestMember?.role
      || snapshot.currentMember.displayName !== manifestMember?.displayName
      || !Number.isSafeInteger(snapshot.eventSequence)
      || snapshot.eventSequence < 0
    ) {
      throw bindingError('cloud-bootstrap-binding-snapshot-identity-mismatch');
    }
  }
}
