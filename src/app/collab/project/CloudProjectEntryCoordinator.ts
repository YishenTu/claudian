import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { COLLAB_CLOUD_BINDING_VERSION, COLLAB_PROTOCOL_VERSION } from '@claudian-collab/protocol';

import type { CollabLocalCloudMembershipRecord, CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import { type CloudProjectEntryRecord, decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import type { CloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { type CollabWorkingCopyFoundation, type CollabWorkingCopyPlacement, CollabWorkingCopySetup } from '@/app/collab/project/CollabWorkingCopySetup';
import { isCollabWorkingCopySlug } from '@/app/collab/project/CollabWorkingCopySlug';
import { type CloudAuthorityAdapter, type CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import { cloudProjectGitRemoteUrl, validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabAuthorityGitNetworkEnvironment } from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabCreateProjectRequest, type CollabLocalProjectSummary, type CollabOperationOptions, type CollabResult, type CollabResumeSetupRequest, parseCollabProjectsFolder } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface CloudProjectEntryFoundation extends CollabWorkingCopyFoundation {
  readonly local: CollabWorkingCopyFoundation['local'] & {
    readonly projects: CollabWorkingCopyFoundation['local']['projects'] & Pick<CollabLocalProjectRepository,
      'loadIndex' | 'listPendingOperationProjectIds' | 'removeProjectDocument'>;
    readonly workspace: CollabWorkingCopyFoundation['local']['workspace'] & Pick<CollabWorkspaceService, 'claimProjectsFolder'>;
  };
}

interface CloudProjectEntryOptions {
  readonly activateProject: (membership: CollabLocalCloudMembershipRecord, options: CollabOperationOptions) => Promise<void>;
  readonly cloudAuthority: Pick<CloudAuthorityAdapter, 'connect'>;
  readonly createId?: (kind: 'operation' | 'project') => string;
  readonly getProjectsFolder: () => string;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

export type CloudProjectJoinInput = {
  readonly invitation: CloudProjectInvitation;
  readonly memberDisplayName: string;
  readonly projectSlug?: string;
} | { readonly projectId: string };

function entryError(reason: string): CollabError {
  return new CollabError({ code: 'durable-progress-recovery-required', safeContext: { reason }, recoveryActions: ['resume', 'open-diagnostics'] });
}

export class CloudProjectEntryCoordinator {
  readonly #queue = new SerialTaskQueue();
  readonly #lifetime = new AbortController();
  readonly #setup: CollabWorkingCopySetup;
  readonly #network: CollabAuthorityGitNetworkEnvironment;
  readonly #now: () => Date;
  readonly #createId: (kind: 'operation' | 'project') => string;

  constructor(private readonly foundation: CloudProjectEntryFoundation, private readonly options: CloudProjectEntryOptions) {
    this.#setup = new CollabWorkingCopySetup(foundation, options.vaultRoot);
    this.#network = new CollabAuthorityGitNetworkEnvironment(options.vaultRoot);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (kind => `${kind}-${randomUUID()}`);
  }

  createProject(request: CollabCreateProjectRequest, options: CollabOperationOptions = {}): Promise<CollabResult<CollabLocalProjectSummary>> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const captured = { ...request, authority: request.authority && { ...request.authority } };
    const projectsFolder = this.options.getProjectsFolder();
    return this.#queue.run(async () => {
      try {
        signal.throwIfAborted();
        if (captured.authority?.kind !== 'cloud') throw new TypeError('Cloud entry requires a Cloud endpoint');
        const serverUrl = validateCloudServerUrl(captured.authority.serverUrl, 'serverUrl');
        const parsedFolder = parseCollabProjectsFolder(projectsFolder);
        if (!parsedFolder.ok) throw new CollabError({ code: 'workspace-boundary-invalid' });
        await this.foundation.local.workspace.claimProjectsFolder(parsedFolder.value);
        const projectId = this.#createId('project');
        const operationId = this.#createId('operation');
        if (await this.foundation.local.projects.loadMembership(projectId)
          || (await this.foundation.local.projects.listPendingOperationProjectIds()).includes(projectId)) {
          throw entryError('entry-project-already-owned');
        }
        const slug = await this.#claimSlug(parsedFolder.value, captured.name, projectId);
        const timestamp = this.#now().toISOString();
        const record = decodeCloudProjectEntryRecord({
          admission: null, createdAt: timestamp, operationId, operationKind: 'cloud-create-project',
          phase: 'intent', projectId, projectsFolder: parsedFolder.value,
          request: { idempotencyKey: operationId, managerDisplayName: captured.memberDisplayName.trim(), projectId, projectName: captured.name.trim() },
          schemaVersion: 1, serverUrl, slug, stagingDirectoryName: `.claudian-clone-${projectId}`, updatedAt: timestamp,
        });
        return await this.#begin(record, signal);
      } catch (error) {
        if (signal.aborted) return { durableProgress: false, status: 'cancelled' };
        return { error: error instanceof CollabError ? error : new CollabError({ code: 'operation-failed', safeContext: { reason: 'cloud-entry-invalid' } }), status: 'failure' };
      }
    });
  }

  joinProject(request: CloudProjectJoinInput, options: CollabOperationOptions = {}): Promise<CollabResult<CollabLocalProjectSummary>> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const invitationInput = 'invitation' in request ? request : null;
    const projectId = 'projectId' in request ? request.projectId : request.invitation.invitation.projectId;
    const projectsFolder = this.options.getProjectsFolder();
    return this.#queue.run(async () => {
      try {
        signal.throwIfAborted();
        const pending = await this.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCollabPendingProjectOperation);
        if (pending) throw entryError('entry-project-already-owned');
        const existing = await this.foundation.local.projects.loadMembership(projectId);
        if (existing && !isCollabLocalCloudMembership(existing)) throw entryError('entry-existing-binding-mismatch');
        const serverUrl = invitationInput?.invitation.serverUrl ?? existing?.authority.serverUrl;
        if (!serverUrl || (existing && existing.authority.serverUrl !== serverUrl)) {
          throw entryError('entry-existing-binding-mismatch');
        }
        const connection = await this.options.cloudAuthority.connect({ projectId, serverUrl }, { signal });
        let existingSnapshot;
        try {
          existingSnapshot = await connection.readSnapshot(projectId, { signal });
        } catch (error) {
          if (existing || !(error instanceof CollabError) || error.code !== 'project-not-found') throw error;
        } finally { connection.dispose(); }
        if (existing) {
          if (!existingSnapshot
            || existing.member.id !== existingSnapshot.currentMember.id
            || existing.member.personalRef !== existingSnapshot.currentMember.personalRef
            || existing.authority.authorityGeneration !== existingSnapshot.project.authorityGeneration) {
            throw entryError('entry-existing-identity-mismatch');
          }
        }
        const parsedFolder = parseCollabProjectsFolder(existing ? path.posix.dirname(existing.project.workspacePath) : projectsFolder);
        if (!parsedFolder.ok) throw new CollabError({ code: 'workspace-boundary-invalid' });
        await this.foundation.local.workspace.claimProjectsFolder(parsedFolder.value);
        const slug = existing ? path.posix.basename(existing.project.workspacePath)
          : await this.#claimSlug(parsedFolder.value, projectId, projectId, invitationInput?.projectSlug);
        if (!isCollabWorkingCopySlug(slug)) throw new CollabError({ code: 'path-invalid' });
        if (existing && await this.#isOccupied(parsedFolder.value, slug)) {
          await this.#setup.assertFinalized(existing);
          await this.options.activateProject(existing, { signal });
          signal.throwIfAborted();
          await this.foundation.local.projects.selectProject(projectId);
          return this.#success(existing);
        }
        const operationId = this.#createId('operation');
        const timestamp = this.#now().toISOString();
        const record = decodeCloudProjectEntryRecord({
          admission: existingSnapshot ? { response: null, snapshot: existingSnapshot } : null,
          createdAt: timestamp, operationId, operationKind: existingSnapshot ? 'cloud-existing-project' : 'cloud-join-project',
          phase: existingSnapshot ? 'admitted' : 'intent', projectId, projectsFolder: parsedFolder.value,
          request: existingSnapshot || !invitationInput ? null : {
            displayName: invitationInput.memberDisplayName.trim(), idempotencyKey: operationId,
            invitationId: invitationInput.invitation.invitation.invitationId, projectId, secret: invitationInput.invitation.invitation.secret,
          },
          schemaVersion: 1, serverUrl, slug, stagingDirectoryName: `.claudian-clone-${projectId}`, updatedAt: timestamp,
        });
        return await this.#begin(record, signal);
      } catch (error) {
        if (signal.aborted) return { durableProgress: false, status: 'cancelled' };
        return { error: error instanceof CollabError ? error : entryError('cloud-entry-invalid'), status: 'failure' };
      }
    });
  }

  resumeSetup(request: CollabResumeSetupRequest, options: CollabOperationOptions = {}): Promise<CollabResult<CollabLocalProjectSummary>> {
    const operationId = request.operationId;
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    return this.#queue.run(async () => {
      try {
        let found: CloudProjectEntryRecord | null = null;
        for (const projectId of await this.foundation.local.projects.listPendingOperationProjectIds()) {
          const pending = await this.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCollabPendingProjectOperation);
          if (pending?.record.operationId !== operationId) continue;
          if (found || pending.kind !== 'cloud-entry') throw entryError('entry-operation-mismatch');
          found = pending.record;
        }
        if (!found) throw entryError('entry-operation-missing');
        return this.#continue(found, signal);
      } catch {
        return { error: entryError('entry-recovery-record-invalid'), status: 'failure' };
      }
    });
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    return this.#queue.drain();
  }

  async #begin(record: CloudProjectEntryRecord, signal: AbortSignal): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      await this.#save(record);
    } catch (error) {
      const persisted = await this.foundation.local.projects.loadProjectDocument(record.projectId, 'pending-operation', decodeCloudProjectEntryRecord)
        .catch(() => undefined);
      if (persisted && isDeepStrictEqual(persisted, record)) return this.#recovery(persisted, error);
      return {
        error: new CollabError({
          code: 'operation-failed',
          recoveryActions: persisted === null ? ['retry', 'open-diagnostics'] : ['open-diagnostics'],
          safeContext: { reason: persisted === null ? 'cloud-entry-intent-not-saved' : 'cloud-entry-intent-state-unavailable' },
        }),
        status: 'failure',
      };
    }
    return this.#continue(record, signal, false);
  }

  async #continue(initial: CloudProjectEntryRecord, signal?: AbortSignal, preserveRecovery = true): Promise<CollabResult<CollabLocalProjectSummary>> {
    let record = initial;
    preserveRecovery ||= initial.phase !== 'intent';
    let connection: CloudAuthorityConnection | undefined;
    try {
      signal?.throwIfAborted();
      connection = await this.options.cloudAuthority.connect({ projectId: record.projectId, serverUrl: record.serverUrl }, { signal });
      if (record.phase === 'intent') {
        signal?.throwIfAborted();
        preserveRecovery = true;
        if (!record.request) throw entryError('entry-request-missing');
        if (record.operationKind === 'cloud-create-project') {
          const response = await connection.createProject(record.request, { signal });
          const snapshot = await connection.readSnapshot(record.projectId, { signal });
          record = await this.#update(record, { admission: { response, snapshot }, phase: 'admitted' });
        } else if (record.operationKind === 'cloud-join-project') {
          let response;
          try {
            response = await connection.joinProject(record.request, { signal });
          } catch (error) {
            if (!(error instanceof CloudAuthorityRejection) || error.mutationOutcome !== 'rejected') throw error;
            const projects = this.foundation.local.projects;
            const pending = await projects.loadProjectDocument(record.projectId, 'pending-operation', decodeCloudProjectEntryRecord);
            if (!isDeepStrictEqual(pending, record)) throw entryError('entry-recovery-record-changed');
            try {
              await projects.removeProjectDocument(record.projectId, 'pending-operation');
            } catch (removalError) {
              if (await projects.loadProjectDocument(record.projectId, 'pending-operation', decodeCloudProjectEntryRecord)) throw removalError;
            }
            return { error, status: 'failure' };
          }
          const snapshot = await connection.readSnapshot(record.projectId, { signal });
          record = await this.#update(record, { admission: { response, snapshot }, phase: 'admitted', request: null });
        }
      }
      const admission = record.admission;
      if (!admission) throw entryError('entry-admission-missing');
      const placement: CollabWorkingCopyPlacement = {
        memberId: admission.snapshot.currentMember.id, personalRef: admission.snapshot.currentMember.personalRef, projectId: record.projectId,
        projectsFolder: record.projectsFolder, slug: record.slug,
        staging: { childName: record.stagingDirectoryName, operationId: record.operationId, projectId: record.projectId, purpose: 'create-clone' },
        stagingProvenance: 'reserved',
      };
      if (record.phase === 'admitted') {
        await this.#setup.clone({ ...placement, displayName: admission.snapshot.currentMember.displayName, remoteUrl: connection.git.remoteUrl }, await this.#network.resolve(record.projectId, connection.git), signal);
        if (record.operationKind === 'cloud-create-project') {
          const git = await this.foundation.requireGitFoundation();
          const clone = await this.#setup.childPath(record.projectsFolder, record.stagingDirectoryName);
          if (await git.repositories.resolveRef(clone, 'HEAD') !== admission.snapshot.project.mainOid
            || (await git.repositories.listTreeRecursive(clone, admission.snapshot.project.mainOid)).length !== 0) {
            throw entryError('cloud-create-not-empty');
          }
        }
        record = await this.#update(record, { phase: 'clone-validated' });
      }
      if (record.phase === 'clone-validated') {
        await this.#setup.place(placement, signal);
        record = await this.#update(record, { phase: 'placed' });
      }
      const membership: CollabLocalCloudMembershipRecord = {
        authority: {
          authorityGeneration: admission.snapshot.project.authorityGeneration,
          bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
          gitRemoteUrl: cloudProjectGitRemoteUrl(record.serverUrl, record.projectId),
          kind: 'cloud', serverUrl: record.serverUrl, wireVersion: COLLAB_PROTOCOL_VERSION,
        },
        createdAt: record.createdAt, lastEventSequence: admission.snapshot.eventSequence,
        member: { displayName: admission.snapshot.currentMember.displayName, id: admission.snapshot.currentMember.id, personalRef: admission.snapshot.currentMember.personalRef, role: admission.snapshot.currentMember.role },
        project: { id: record.projectId, name: admission.snapshot.project.name, workspacePath: `${record.projectsFolder}/${record.slug}` },
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION, updatedAt: record.updatedAt,
      };
      if (record.phase === 'placed') {
        await this.#setup.finalize(membership, signal);
        record = await this.#update(record, { phase: 'locally-finalized' });
      }
      signal?.throwIfAborted();
      const retained = await this.#setup.assertFinalized(membership);
      await this.options.activateProject(retained as CollabLocalCloudMembershipRecord, { signal });
      signal?.throwIfAborted();
      await this.foundation.local.projects.removeProjectDocument(record.projectId, 'pending-operation');
      return this.#success(membership);
    } catch (error) {
      if (!preserveRecovery && signal?.aborted) {
        await this.foundation.local.projects.removeProjectDocument(record.projectId, 'pending-operation');
        return { durableProgress: false, operationId: record.operationId, status: 'cancelled' };
      }
      return this.#recovery(record, error);
    } finally {
      connection?.dispose();
    }
  }

  #recovery(record: CloudProjectEntryRecord, error?: unknown): CollabResult<CollabLocalProjectSummary> {
    return { durablePhase: 'committed', durableProgress: true, error: error instanceof CollabError ? error : entryError('cloud-entry-incomplete'), operationId: record.operationId, status: 'recovery-required' };
  }

  #success(membership: CollabLocalCloudMembershipRecord): CollabResult<CollabLocalProjectSummary> {
    return {
      status: 'success', value: {
        authorityKind: 'cloud', connectionStatus: 'connected', health: 'healthy',
        hostInstallationStatus: 'not-host', hostStatus: 'not-host', id: membership.project.id,
        name: membership.project.name, role: membership.member.role, workspacePath: membership.project.workspacePath,
      },
    };
  }

  async #claimSlug(projectsFolder: string, name: string, projectId: string, requestedSlug?: string): Promise<string> {
    const index = await this.foundation.local.projects.loadIndex();
    const reserved = new Set(index.projects.map(project => project.workspacePath));
    for (const pendingId of await this.foundation.local.projects.listPendingOperationProjectIds()) {
      const pending = await this.foundation.local.projects.loadProjectDocument(pendingId, 'pending-operation', decodeCollabPendingProjectOperation);
      if (pending && pending.kind !== 'cloud-relocation') {
        reserved.add(`${pending.record.projectsFolder}/${pending.record.slug}`);
      }
    }
    if (requestedSlug !== undefined) {
      if (!isCollabWorkingCopySlug(requestedSlug)
        || reserved.has(`${projectsFolder}/${requestedSlug}`)
        || await this.#isOccupied(projectsFolder, requestedSlug)) {
        throw new CollabError({ code: 'workspace-boundary-invalid', safeContext: { reason: 'cloud-entry-slug-unavailable' } });
      }
      return requestedSlug;
    }
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 58) || projectId.slice(0, 58);
    for (let suffix = 1; suffix < 10_000; suffix++) {
      const slug = suffix === 1 ? base : `${base}-${suffix}`;
      if (reserved.has(`${projectsFolder}/${slug}`)) continue;
      if (!await this.#isOccupied(projectsFolder, slug)) return slug;
    }
    throw entryError('entry-destination-unavailable');
  }

  async #isOccupied(projectsFolder: string, slug: string): Promise<boolean> {
    return lstat(await this.#setup.childPath(projectsFolder, slug)).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
  }

  #save(record: CloudProjectEntryRecord): Promise<void> {
    return this.foundation.local.projects.saveProjectDocument(record.projectId, 'pending-operation', record);
  }

  async #update(record: CloudProjectEntryRecord, changes: Partial<Pick<CloudProjectEntryRecord, 'admission' | 'phase' | 'request'>>): Promise<CloudProjectEntryRecord> {
    const next = decodeCloudProjectEntryRecord({ ...record, ...changes, updatedAt: this.#now().toISOString() });
    await this.#save(next);
    return next;
  }
}
