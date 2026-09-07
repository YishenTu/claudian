import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  rename,
} from 'node:fs/promises';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef, type CollabProjectId, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import type { SqlJsMutationResult } from '@/app/collab/authority/SqlJsProjectDatabase';
import type {
  CollabAuthorityFoundation,
  CollabGitFoundation,
  CollabLocalFoundation,
} from '@/app/collab/ClaudianCollabService';
import { resolveCollabVaultPath } from '@/app/collab/CollabFilesystemBoundary';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type {
  CollabProjectsFolderChildOwnership,
} from '@/app/collab/CollabWorkspaceService';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import {
  COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
  type CollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';
import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabCreateProjectRequest, type CollabLocalProjectSummary, type CollabOperationOptions, type CollabResult, type CollabResumeSetupRequest, parseCollabProjectsFolder } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { type InstallationKey, isInstallationKey } from '@/core/device/InstallationKey';

const RECEIVE_DISABLED_HOOK = `#!/bin/sh
echo "Claudian Collab hosting is not active." >&2
exit 1
`;
const SETUP_CHILD_PATTERN = /^\.claudian-(?:clone|seed)-[A-Za-z0-9_-]{1,64}$/;

interface CollabProjectAuthorityDatabase {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface CollabProjectAuthorityFoundation extends Omit<
  CollabAuthorityFoundation,
  'database'
> {
  readonly database: CollabProjectAuthorityDatabase;
}

export interface CollabProjectFoundationPort {
  readonly local: CollabLocalFoundation;
  requireGitFoundation(): Promise<CollabGitFoundation>;
  createAuthority(projectId: CollabProjectId): Promise<CollabProjectAuthorityFoundation>;
  openAuthority(projectId: CollabProjectId): Promise<CollabProjectAuthorityFoundation>;
  inspectAuthority(
    projectId: CollabProjectId,
  ): Promise<CollabProjectAuthorityFoundation | null>;
  discardProvisionalAuthority(projectId: CollabProjectId): Promise<void>;
}

export interface CollabProjectSetupServiceOptions {
  readonly createCredential?: () => string;
  readonly createId?: (kind: 'member' | 'operation' | 'project') => string;
  readonly getProjectsFolder?: () => string;
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

function setupError(
  code:
    | 'cancelled'
    | 'durable-progress-recovery-required'
    | 'operation-failed'
    | 'project-not-found'
    | 'repository-invalid'
    | 'workspace-boundary-invalid',
  reason: string,
  recoveryActions: readonly ('open-diagnostics' | 'resume' | 'retry')[] = [],
): CollabError {
  return new CollabError({
    code,
    recoveryActions,
    safeContext: { reason },
  });
}

function asCollabError(error: unknown): CollabError {
  return error instanceof CollabError
    ? error
    : setupError('operation-failed', 'project-setup-failed', ['retry', 'open-diagnostics']);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw setupError('cancelled', 'operation-cancelled', ['retry']);
}

function validateText(value: string, field: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > 200
    || trimmed.includes('\u0000')
    || trimmed.includes('\r')
    || trimmed.includes('\n')
  ) {
    throw setupError('operation-failed', `${field}-invalid`);
  }
  return trimmed;
}

function validateGeneratedId(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  field: string,
): string {
  if (!predicate(value)) {
    throw setupError('operation-failed', `${field}-invalid`, ['open-diagnostics']);
  }
  return value;
}

function projectSummary(record: CollabProjectSetupRecord): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'host-stopped',
    health: 'healthy',
    hostInstallationStatus: 'hosted-here',
    hostStatus: 'stopped',
    id: record.projectId,
    name: record.name,
    role: 'manager',
    workspacePath: `${record.projectsFolder}/${record.slug}`,
  };
}

function slugBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  return slug || 'project';
}

export class CollabProjectSetupService {
   readonly #createCredential: () => string;
   readonly #createId: (kind: 'member' | 'operation' | 'project') => string;
  private readonly getProjectsFolder: () => string;
  private readonly now: () => Date;
   readonly #operationQueue = new SerialTaskQueue();

  constructor(
    private readonly foundation: CollabProjectFoundationPort,
    private readonly options: CollabProjectSetupServiceOptions,
  ) {
    this.#createCredential = options.createCredential
      ?? (() => randomBytes(32).toString('base64url'));
    this.#createId = options.createId ?? (kind => {
      const compactUuid = randomUUID().replaceAll('-', '');
      return kind === 'operation'
        ? `create-${compactUuid}`
        : `${kind}-${compactUuid}`;
    });
    this.getProjectsFolder = options.getProjectsFolder ?? (() => 'workspace');
    this.now = options.now ?? (() => new Date());
  }

  createProject(
    request: CollabCreateProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.#operationQueue.run(() => this.#createProjectUnlocked(request, options));
  }

  resumeSetup(
    request: CollabResumeSetupRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.#operationQueue.run(() => this.#resumeSetupUnlocked(request, options));
  }

   async #createProjectUnlocked(
    request: CollabCreateProjectRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record: CollabProjectSetupRecord | null = null;
    try {
      throwIfCancelled(options.signal);
      const name = validateText(request.name, 'project-name');
      const memberDisplayName = validateText(
        request.memberDisplayName,
        'member-display-name',
      );
      const parsedProjectsFolder = parseCollabProjectsFolder(this.getProjectsFolder());
      if (!parsedProjectsFolder.ok) {
        throw setupError('workspace-boundary-invalid', 'projects-folder-invalid');
      }
      const projectsFolder = parsedProjectsFolder.value;
      await this.foundation.local.workspace.claimProjectsFolder(projectsFolder);
      throwIfCancelled(options.signal);
      const projectId = validateGeneratedId(
        this.#createId('project'),
        isCollabProjectId,
        'project-id',
      );
      const memberId = validateGeneratedId(
        this.#createId('member'),
        isCollabMemberId,
        'member-id',
      );
      const operationId = validateGeneratedId(
        this.#createId('operation'),
        isCollabOpaqueId,
        'operation-id',
      );
      const credential = this.#createCredential();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
        throw setupError('operation-failed', 'member-credential-invalid', ['open-diagnostics']);
      }
      const slug = await this.#claimSlug(projectsFolder, name);
      const timestamp = this.now().toISOString();
      record = {
        cloneDirectoryName: `.claudian-clone-${projectId}`,
        createdAt: timestamp,
        initialCommitOid: null,
        memberCredential: credential,
        memberDisplayName,
        memberId,
        name,
        operationId,
        ownerInstallationKey: this.options.installationKey,
        phase: 'planned',
        projectId,
        projectsFolder,
        schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
        seedDirectoryName: `.claudian-seed-${projectId}`,
        slug,
        updatedAt: timestamp,
      };
      await this.#savePending(record);
      await this.foundation.local.projects.upsertProject(this.#indexEntry(record));
      record = await this.#prepareSeed(record, options.signal);
      record = await this.#commitAuthority(record, options.signal);
      throwIfCancelled(options.signal);
      return await this.#finishCommittedSetup(record, options.signal);
    } catch (error) {
      return this.#handleSetupFailure(record, error);
    }
  }

   async #resumeSetupUnlocked(
    request: CollabResumeSetupRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record: CollabProjectSetupRecord | null = null;
    try {
      throwIfCancelled(options.signal);
      const pending = await this.#findPending(request.operationId);
      if (!pending) throw setupError('project-not-found', 'pending-setup-not-found');
      this.#assertRecoveryOwner(pending);
      record = pending;
      if (record.legacyImportPlanned) {
        await this.#cleanupUncommitted(record);
        return {
          error: setupError('operation-failed', 'legacy-planned-create-unsupported'),
          status: 'failure',
        };
      }
      const authorityCommitted = await this.#isAuthorityCommitted(record);
      if (!authorityCommitted) {
        await this.foundation.local.workspace.claimProjectsFolder(record.projectsFolder);
        if (record.phase === 'planned') {
          record = await this.#prepareSeed(record, options.signal);
        }
        record = await this.#commitAuthority(record, options.signal);
      } else if (record.phase === 'planned' || record.phase === 'staged') {
        record = await this.#updateRecord(record, { phase: 'committed' });
      }
      throwIfCancelled(options.signal);
      return await this.#finishCommittedSetup(record, options.signal);
    } catch (error) {
      return this.#handleSetupFailure(record, error);
    }
  }

   #assertRecoveryOwner(record: CollabProjectSetupRecord): void {
    if (
      !isInstallationKey(record.ownerInstallationKey)
      || record.ownerInstallationKey !== this.options.installationKey
    ) {
      throw setupError(
        'durable-progress-recovery-required',
        'host-installation-recovery-owner-mismatch',
        ['resume', 'open-diagnostics'],
      );
    }
  }

   async #prepareSeed(
    record: CollabProjectSetupRecord,
    signal?: AbortSignal,
  ): Promise<CollabProjectSetupRecord> {
    const ownership = this.#workspaceChildOwnership(record, 'create-seed');
    await this.foundation.local.workspace.removeReservedProjectsFolderChild(
      record.projectsFolder,
      ownership,
    );
    const seed = await this.foundation.local.workspace.reserveProjectsFolderChild(
      record.projectsFolder,
      ownership,
    );
    try {
      await mkdir(seed.absolutePath, { mode: 0o755 });
    } catch {
      await this.foundation.local.workspace.releaseReservedProjectsFolderChild(
        record.projectsFolder,
        ownership,
      ).catch(() => undefined);
      throw setupError('workspace-boundary-invalid', 'setup-child-collision');
    }
    const git = await this.foundation.requireGitFoundation();
    const seedPath = seed.absolutePath;
    await git.repositories.initializeWorkingRepository(seedPath);
    await git.repositories.configureLocalRepository(seedPath, {
      memberId: record.memberId,
      personalRef: collabMemberRef(record.memberId),
      projectId: record.projectId,
      userDisplayName: record.memberDisplayName,
    });
    await git.repositories.stageAll(seedPath, signal);
    const initialCommitOid = await git.repositories.createCommitFromIndex(seedPath, {
      expectedRefOid: null,
      message: 'Initialize Collab project',
      parents: [],
      ref: COLLAB_MAIN_REF,
    });
    await git.repositories.createRef(
      seedPath,
      collabMemberRef(record.memberId),
      initialCommitOid,
    );
    return this.#updateRecord(record, {
      initialCommitOid,
      phase: 'staged',
    });
  }

   async #commitAuthority(
    record: CollabProjectSetupRecord,
    signal?: AbortSignal,
  ): Promise<CollabProjectSetupRecord> {
    if (!record.initialCommitOid) {
      throw setupError('repository-invalid', 'initial-commit-missing', ['open-diagnostics']);
    }
    const authority = await this.foundation.createAuthority(record.projectId);
    const existing = await authority.database.read(connection => authority.projects.get(connection));
    if (!existing) {
      const credentialHash = createHash('sha256')
        .update(record.memberCredential, 'utf8')
        .digest();
      // The point of no return: cancellation must not cross into the durable
      // authority mutation.
      throwIfCancelled(signal);
      await authority.database.mutate(connection => {
        authority.projects.initialize(connection, {
          createdAt: record.createdAt,
          hostCredentialHash: credentialHash,
          hostDisplayName: record.memberDisplayName,
          hostMemberId: record.memberId,
          name: record.name,
          projectId: record.projectId,
        });
        authority.events.append(connection, {
          actorMemberId: record.memberId,
          createdAt: record.createdAt,
          kind: 'project.created',
          payload: { projectId: record.projectId },
        });
      });
    } else {
      this.#assertMatchingAuthority(record, existing);
    }
    return this.#updateRecord(record, { phase: 'committed' });
  }

   async #finishCommittedSetup(
    record: CollabProjectSetupRecord,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const git = await this.foundation.requireGitFoundation();
    const authority = await this.foundation.openAuthority(record.projectId);
    await this.#ensureBareAuthority(record, authority, git, signal);
    throwIfCancelled(signal);
    const workingCopy = await this.#ensureWorkingCopy(record, authority, git, signal);
    record = await this.#updateRecord(record, { phase: 'clone-completed' });
    await this.saveMembership(record);
    await this.foundation.local.projects.saveProjectDocument(
      record.projectId,
      'publication-state',
      {
        baseMainOid: record.initialCommitOid!,
        operation: null,
        projectId: record.projectId,
        schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
        updatedAt: this.now().toISOString(),
      },
    );
    await this.foundation.local.projects.upsertProject(this.#indexEntry(record));
    await this.foundation.local.projects.selectProject(record.projectId);
    await this.#removeOwnedWorkspaceChild(record, 'create-seed');
    await this.#removeOwnedWorkspaceChild(record, 'create-clone');
    await this.foundation.local.projects.removeProjectDocument(
      record.projectId,
      'pending-operation',
    );
    await git.repositories.assertHealthy(workingCopy);
    return { status: 'success', value: projectSummary(record) };
  }

   async #ensureBareAuthority(
    record: CollabProjectSetupRecord,
    authority: CollabProjectAuthorityFoundation,
    git: CollabGitFoundation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!record.initialCommitOid) {
      throw setupError('repository-invalid', 'initial-commit-missing', ['open-diagnostics']);
    }
    const barePath = path.join(authority.authorityDirectory, 'repository.git');
    await mkdir(barePath, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await git.repositories.initializeBareRepository(barePath);
    const personalRef = collabMemberRef(record.memberId);
    const mainOid = await git.repositories.resolveRef(barePath, COLLAB_MAIN_REF);
    const personalOid = await git.repositories.resolveRef(barePath, personalRef);
    for (const [ref, oid] of [
      [COLLAB_MAIN_REF, mainOid],
      [personalRef, personalOid],
    ] as const) {
      if (oid !== null && oid !== record.initialCommitOid) {
        throw setupError('repository-invalid', 'authority-initial-ref-mismatch', [
          'open-diagnostics',
        ]);
      }
      if (oid === null) {
        const seedPath = this.#workspaceChildPath(record, record.seedDirectoryName);
        await git.repositories.addRemote(seedPath, 'origin', barePath);
        await git.repositories.push(seedPath, 'origin', `${ref}:${ref}`, undefined, signal);
      }
    }
    await git.repositories.installHook(barePath, 'pre-receive', RECEIVE_DISABLED_HOOK);
    await git.repositories.assertHealthy(barePath);
  }

   async #ensureWorkingCopy(
    record: CollabProjectSetupRecord,
    authority: CollabProjectAuthorityFoundation,
    git: CollabGitFoundation,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!record.initialCommitOid) {
      throw setupError('repository-invalid', 'initial-commit-missing', ['open-diagnostics']);
    }
    const finalPath = this.#workspaceChildPath(record, record.slug);
    const existing = await lstat(finalPath).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw setupError('workspace-boundary-invalid', 'working-copy-boundary-invalid');
      }
      const oid = await git.repositories.resolveRef(
        finalPath,
        collabMemberRef(record.memberId),
      );
      if (oid !== record.initialCommitOid) {
        throw setupError('repository-invalid', 'working-copy-ref-mismatch', [
          'open-diagnostics',
        ]);
      }
      return finalPath;
    }

    const clonePathForRecovery = this.#workspaceChildPath(
      record,
      record.cloneDirectoryName,
    );
    if (record.legacySetupRecord) {
      const legacyClone = await lstat(clonePathForRecovery).catch(() => null);
      if (legacyClone) {
        if (!legacyClone.isDirectory() || legacyClone.isSymbolicLink()) {
          throw setupError('workspace-boundary-invalid', 'setup-child-boundary-invalid');
        }
        const oid = await git.repositories.resolveRef(
          clonePathForRecovery,
          collabMemberRef(record.memberId),
        );
        if (oid !== record.initialCommitOid) {
          throw setupError('repository-invalid', 'legacy-clone-ref-mismatch', [
            'open-diagnostics',
          ]);
        }
        await git.repositories.configureLocalRepository(clonePathForRecovery, {
          memberId: record.memberId,
          personalRef: collabMemberRef(record.memberId),
          projectId: record.projectId,
          userDisplayName: record.memberDisplayName,
        });
        await git.repositories.removeRemote(clonePathForRecovery, 'origin');
        throwIfCancelled(signal);
        await rename(clonePathForRecovery, finalPath).catch(() => {
          throw setupError(
            'workspace-boundary-invalid',
            'working-copy-placement-failed',
            ['resume', 'open-diagnostics'],
          );
        });
        return finalPath;
      }
    }

    await this.#removeOwnedWorkspaceChild(record, 'create-clone');
    const cloneOwnership = this.#workspaceChildOwnership(record, 'create-clone');
    await this.foundation.local.workspace.reserveProjectsFolderChild(
      record.projectsFolder,
      cloneOwnership,
    );
    const barePath = path.join(authority.authorityDirectory, 'repository.git');
    let clonePath: string;
    try {
      clonePath = await git.repositories.cloneRepository({
        branch: `members/${record.memberId}`,
        directoryName: record.cloneDirectoryName,
        parentDirectory: await resolveCollabVaultPath(
          this.options.vaultRoot,
          record.projectsFolder,
          { mustExist: true },
        ),
        remoteUrl: barePath,
        signal,
      });
    } catch (error) {
      await this.#removeOwnedWorkspaceChild(record, 'create-clone').catch(() => undefined);
      throw error;
    }
    await git.repositories.configureLocalRepository(clonePath, {
      memberId: record.memberId,
      personalRef: collabMemberRef(record.memberId),
      projectId: record.projectId,
      userDisplayName: record.memberDisplayName,
    });
    await git.repositories.removeRemote(clonePath, 'origin');
    throwIfCancelled(signal);
    await rename(clonePath, finalPath).catch(() => {
      throw setupError('workspace-boundary-invalid', 'working-copy-placement-failed', [
        'resume',
        'open-diagnostics',
      ]);
    });
    await this.foundation.local.workspace.releaseReservedProjectsFolderChild(
      record.projectsFolder,
      cloneOwnership,
    );
    return finalPath;
  }

  private async saveMembership(record: CollabProjectSetupRecord): Promise<void> {
    await this.foundation.local.projects.saveMembership({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
      createdAt: record.createdAt,
      hostOwnership: { autoStart: true, ownsAuthority: true },
      lastEventSequence: 1,
      member: {
        credential: record.memberCredential,
        displayName: record.memberDisplayName,
        id: record.memberId,
        personalRef: collabMemberRef(record.memberId),
        role: 'manager',
      },
      project: {
        id: record.projectId,
        name: record.name,
        workspacePath: `${record.projectsFolder}/${record.slug}`,
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
    });
  }

   async #handleSetupFailure(
    record: CollabProjectSetupRecord | null,
    error: unknown,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const collabError = asCollabError(error);
    if (record && await this.#isAuthorityCommitted(record).catch(() => true)) {
      await this.#updateRecord(record, { phase: 'committed' }).catch(() => undefined);
      return {
        durablePhase: 'committed',
        durableProgress: true,
        error: setupError(
          'durable-progress-recovery-required',
          typeof collabError.safeContext.reason === 'string'
            ? collabError.safeContext.reason
            : collabError.code,
          ['resume', 'open-diagnostics'],
        ),
        operationId: record.operationId,
        status: 'recovery-required',
      };
    }
    if (record) {
      try {
        await this.#cleanupUncommitted(record);
      } catch {
        return {
          error: setupError(
            'operation-failed',
            'project-setup-cleanup-failed',
            ['resume', 'open-diagnostics'],
          ),
          status: 'failure',
        };
      }
    }
    if (collabError.code === 'cancelled') {
      return {
        ...(record ? { operationId: record.operationId } : {}),
        durableProgress: false,
        status: 'cancelled',
      };
    }
    return { error: collabError, status: 'failure' };
  }

   async #cleanupUncommitted(record: CollabProjectSetupRecord): Promise<void> {
    // Authority cleanup is the safety boundary: keep the discoverable local
    // setup record and resumable staging artifacts until the provisional
    // foundation is actually gone.
    await this.foundation.discardProvisionalAuthority(record.projectId);
    await this.#removeOwnedWorkspaceChild(record, 'create-seed').catch(() => undefined);
    await this.#removeOwnedWorkspaceChild(record, 'create-clone').catch(() => undefined);
    await this.foundation.local.projects.discardPendingOperation(record.projectId);
    await this.foundation.local.projects.pruneProjectPrivateDirectoryIfEmpty(
      record.projectId,
    ).catch(() => undefined);
  }

   async #isAuthorityCommitted(record: CollabProjectSetupRecord): Promise<boolean> {
    const authority = await this.foundation.inspectAuthority(record.projectId);
    if (!authority) return false;
    const project = await authority.database.read(connection => authority.projects.get(connection));
    if (!project) return false;
    this.#assertMatchingAuthority(record, project);
    return true;
  }

   #assertMatchingAuthority(
    record: CollabProjectSetupRecord,
    project: {
      readonly hostMemberId: string;
      readonly managerSetGeneration: number;
      readonly name: string;
      readonly projectId: string;
    },
  ): void {
    if (
      project.projectId !== record.projectId
      || project.name !== record.name
      || project.hostMemberId !== record.memberId
      || project.managerSetGeneration !== 0
    ) {
      throw setupError('repository-invalid', 'authority-project-mismatch', [
        'open-diagnostics',
      ]);
    }
  }

   async #findPending(operationId: string): Promise<CollabProjectSetupRecord | null> {
    const projectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    let match: CollabProjectSetupRecord | null = null;
    for (const projectId of projectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending?.kind === 'create-project' && pending.record.operationId === operationId) {
        if (match) throw setupError('repository-invalid', 'pending-operation-duplicate');
        match = pending.record;
      }
    }
    return match;
  }

   async #claimSlug(projectsFolder: string, name: string): Promise<string> {
    const base = slugBase(name);
    const index = await this.foundation.local.projects.loadIndex();
    const reservedPaths = new Set(index.projects.map(project => project.workspacePath));
    const pendingProjectIds = await this.foundation.local.projects
      .listPendingOperationProjectIds();
    for (const projectId of pendingProjectIds) {
      const pending = await this.foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending) {
        reservedPaths.add(`${pending.record.projectsFolder}/${pending.record.slug}`);
      }
    }
    for (let suffix = 1; suffix <= 9_999; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base.slice(0, 58)}-${suffix}`;
      if (reservedPaths.has(`${projectsFolder}/${candidate}`)) continue;
      const absolutePath = this.#workspaceChildPathForRoot(projectsFolder, candidate);
      if (!await lstat(absolutePath).then(() => true, () => false)) return candidate;
    }
    throw setupError('workspace-boundary-invalid', 'project-slug-unavailable');
  }

   #indexEntry(record: CollabProjectSetupRecord) {
    return {
      authorityKind: 'lan' as const,
      createdAt: record.createdAt,
      id: record.projectId,
      name: record.name,
      updatedAt: this.now().toISOString(),
      workspacePath: `${record.projectsFolder}/${record.slug}`,
    };
  }

   #savePending(record: CollabProjectSetupRecord): Promise<void> {
    const {
      legacyImportPlanned: _legacyImportPlanned,
      ...persisted
    } = record;
    return this.foundation.local.projects.saveProjectDocument(
      record.projectId,
      'pending-operation',
      persisted,
    );
  }

   async #updateRecord(
    record: CollabProjectSetupRecord,
    changes: Partial<Pick<
      CollabProjectSetupRecord,
      'initialCommitOid' | 'phase'
    >>,
  ): Promise<CollabProjectSetupRecord> {
    const updated: CollabProjectSetupRecord = {
      ...record,
      ...changes,
      updatedAt: this.now().toISOString(),
    };
    await this.#savePending(updated);
    return updated;
  }

   #workspaceChildPath(record: CollabProjectSetupRecord, childName: string): string {
    return this.#workspaceChildPathForRoot(record.projectsFolder, childName);
  }

   #workspaceChildPathForRoot(projectsFolder: string, childName: string): string {
    return path.join(this.options.vaultRoot, ...projectsFolder.split('/'), childName);
  }

   #workspaceChildOwnership(
    record: CollabProjectSetupRecord,
    purpose: 'create-clone' | 'create-seed',
  ): CollabProjectsFolderChildOwnership {
    const childName = purpose === 'create-seed'
      ? record.seedDirectoryName
      : record.cloneDirectoryName;
    if (!SETUP_CHILD_PATTERN.test(childName)) {
      throw setupError('workspace-boundary-invalid', 'setup-child-name-invalid');
    }
    return {
      childName,
      operationId: record.operationId,
      projectId: record.projectId,
      purpose,
    };
  }

   async #removeOwnedWorkspaceChild(
    record: CollabProjectSetupRecord,
    purpose: 'create-clone' | 'create-seed',
  ): Promise<void> {
    await this.foundation.local.workspace.removeReservedProjectsFolderChild(
      record.projectsFolder,
      this.#workspaceChildOwnership(record, purpose),
    );
  }

}
