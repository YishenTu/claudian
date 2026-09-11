import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { CollabProjectId } from '@claudian-collab/protocol';

import { type CollabAuthorityInstallationStatus, type CollabLocalMembershipRecord, type CollabLocalProjectIndex, type CollabLocalProjectRepository, isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type { HostInstallationBindingService } from '@/app/collab/host-installation/HostInstallationBindingService';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabConnectionStatus, type CollabHostStatus, type CollabLocalProjectSummary, type CollabOperationOptions, resolveEffectiveCollabProjectId } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabProjectProjection {
  readonly projects: readonly CollabLocalProjectSummary[];
  readonly selectedProjectId: CollabProjectId | null;
}

export interface CollabProjectCatalogOptions {
  readonly projects: Pick<CollabLocalProjectRepository, 'loadIndex' | 'loadMembership' | 'loadProjectDocument' | 'selectProject'>;
  readonly workspace: Pick<CollabWorkspaceService, 'resolveManagedProjectPath'>;
  readonly pendingLeaves: {
    listProjectIds(): Promise<readonly CollabProjectId[]>;
    load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null>;
  };
  readonly cloudRetirementIntents: { listProjectIds(): Promise<readonly CollabProjectId[]> };
  readonly hostInstallation: Pick<HostInstallationBindingService, 'inspect'>;
  readonly lanHost: { getProjectState(projectId: CollabProjectId): { readonly status: Exclude<CollabHostStatus, 'not-host'> } };
  readonly readConnectionStatus: (projectId: CollabProjectId) => CollabConnectionStatus;
  readonly beforeSelectionPublished: (project: CollabLocalProjectSummary) => void;
  readonly onPublish: (projection: CollabProjectProjection) => void;
}

function isUnsupportedLocalMembership(error: unknown): boolean {
  return error instanceof CollabError
    && error.code === 'schema-version-unsupported'
    && error.safeContext.recordKind === 'membership';
}


export class CollabProjectCatalog {
  readonly #selections = new SerialTaskQueue();
  readonly #projectRevisions = new Map<CollabProjectId, number>();
  #revision = 0;
  #indexRevision = 0;
  #fullRevision = 0;
  #selecting = false;
  #closed = false;
  #projection: CollabProjectProjection = { projects: [], selectedProjectId: null };

  constructor(private readonly options: CollabProjectCatalogOptions) {}

  beginClose(): void { this.#closed = true; }

  async refresh(projectId?: CollabProjectId): Promise<CollabProjectProjection> {
    const revision = ++this.#revision;
    const projection = await this.read(projectId);
    if (this.#closed) return this.#projection;
    return this.#commit(projection, revision, projectId);
  }

  select(projectId: CollabProjectId, options: CollabOperationOptions): Promise<CollabLocalProjectSummary> {
    return this.#selections.run(async () => {
      this.#assertOpen(options.signal);
      const revision = ++this.#revision;
      const projection = await this.read();
      this.#assertOpen(options.signal);
      if (!projection.projects.some(project => project.id === projectId)) {
        throw new CollabError({ code: 'project-not-found', safeContext: { projectId } });
      }
      this.#selecting = true;
      try {
        await this.options.projects.selectProject(projectId);
        this.#assertOpen();
        const committed = this.#commit(projection, revision, undefined, projectId);
        return committed.projects.find(project => project.id === projectId)!;
      } finally { this.#selecting = false; }
    });
  }

  #commit(
    incoming: CollabProjectProjection,
    revision: number,
    onlyProjectId?: CollabProjectId,
    selectedProjectId?: CollabProjectId,
  ): CollabProjectProjection {
    const current = new Map(this.#projection.projects.map(project => [project.id, project]));
    const next = new Map(incoming.projects.map(project => [project.id, project]));
    const affected = onlyProjectId ? [onlyProjectId] : new Set([...current.keys(), ...next.keys()]);
    for (const projectId of affected) {
      if (Math.max(this.#projectRevisions.get(projectId) ?? 0, this.#fullRevision) > revision) continue;
      this.#projectRevisions.set(projectId, revision);
      const project = next.get(projectId);
      if (project) current.set(projectId, project);
      else current.delete(projectId);
    }
    if (!onlyProjectId) this.#fullRevision = Math.max(this.#fullRevision, revision);
    let selected = this.#projection.selectedProjectId;
    if (selectedProjectId !== undefined) {
      selected = selectedProjectId;
      this.#indexRevision = ++this.#revision;
    } else if (!onlyProjectId && !this.#selecting && revision >= this.#indexRevision) {
      selected = incoming.selectedProjectId;
      this.#indexRevision = revision;
    }
    const projects = [...current.values()];
    const projection = Object.freeze({
      projects: Object.freeze(projects),
      selectedProjectId: resolveEffectiveCollabProjectId(projects, selected),
    });
    const changed = JSON.stringify(projection) !== JSON.stringify(this.#projection);
    const previousSelection = this.#projection.projects.find(project => project.id === this.#projection.selectedProjectId);
    const nextSelection = projects.find(project => project.id === projection.selectedProjectId);
    if (nextSelection && (
      selectedProjectId !== undefined
      || nextSelection.id !== previousSelection?.id
      || nextSelection.health !== previousSelection.health
      || nextSelection.lifecycle !== previousSelection.lifecycle
    )) {
      this.options.beforeSelectionPublished(nextSelection);
    }
    this.#projection = projection;
    if (changed || selectedProjectId !== undefined) {
      this.options.onPublish(projection);
    }
    return projection;
  }

  #assertOpen(signal?: AbortSignal): void {
    if (this.#closed || signal?.aborted) throw new CollabError({ code: 'cancelled' });
  }

   async read(onlyProjectId?: CollabProjectId): Promise<CollabProjectProjection> {
    const [index, pendingLeaveProjectIds, cloudRetirementProjectIds] = await Promise.all([
      this.options.projects.loadIndex(),
      this.options.pendingLeaves.listProjectIds(),
      this.options.cloudRetirementIntents.listProjectIds(),
    ]);
    const pendingLeaves = await Promise.all(pendingLeaveProjectIds.filter(projectId => !onlyProjectId || projectId === onlyProjectId).map(async projectId => {
      try {
        return { corrupt: false as const, projectId, record: await this.options.pendingLeaves.load(projectId) };
      } catch {
        return { corrupt: true as const, projectId, record: null };
      }
    }));
    const pendingByProject = new Map(pendingLeaves.map(entry => [entry.projectId, entry]));
    const cloudRetirementProjects = new Set(cloudRetirementProjectIds);
    const projects = await Promise.all(index.projects.filter(project => !onlyProjectId || project.id === onlyProjectId).map(async project => {
      const pendingLeave = pendingByProject.get(project.id) ?? null;
      const hasCloudRetirementIntent = cloudRetirementProjects.has(project.id);
      const [membership, pending, workingCopyHealthy] = await Promise.all([
        this.options.projects.loadMembership(project.id).catch(error => {
          if (isUnsupportedLocalMembership(error)) return null;
          throw error;
        }),
        this.options.projects.loadProjectDocument(
          project.id,
          'pending-operation',
          decodeCollabPendingProjectOperation,
        ),
        this.#hasWorkingCopy(project.workspacePath),
      ]);
      const summary = await this.#projectSummary(
        project,
        membership,
        pending !== null || pendingLeave !== null || hasCloudRetirementIntent,
        workingCopyHealthy,
      );
      pendingByProject.delete(project.id);
      return pendingLeave
        ? {
          ...summary,
          cleanupStatus: pendingLeave.corrupt
            ? 'failed' as const
            : pendingLeave.record?.localCleanupComplete
            ? 'complete' as const
            : pendingLeave.record?.phase === 'recovery-required'
              ? 'failed' as const
              : 'pending' as const,
          health: 'needs-attention' as const,
          lifecycle: 'leaving' as const,
        }
        : summary;
    }));
    const journalOnly = [...pendingByProject.values()]
      .flatMap(entry => entry.record ? [entry.record] : [])
      .map(record => ({
        authorityKind: 'authorityKind' in record ? 'cloud' as const : 'lan' as const,
        cleanupStatus: record.localCleanupComplete
          ? 'complete' as const
          : record.phase === 'recovery-required'
            ? 'failed' as const
            : 'pending' as const,
        connectionStatus: 'needs-attention' as const,
        health: 'needs-attention' as const,
        hostInstallationStatus: 'not-host' as const,
        hostStatus: 'not-host' as const,
        id: record.projectId,
        lifecycle: 'leaving' as const,
        name: record.projectName,
        role: record.localRole,
        workspacePath: record.workspacePath,
      }));
    return { projects: [...projects, ...journalOnly], selectedProjectId: index.selectedProjectId };
  }

   async #hasWorkingCopy(workspacePath: string): Promise<boolean> {
    try {
      const absolutePath = await this.options.workspace.resolveManagedProjectPath(
        workspacePath,
      );
      const gitDirectory = path.join(absolutePath, '.git');
      const [workingCopyStat, gitDirectoryStat] = await Promise.all([
        lstat(absolutePath),
        lstat(gitDirectory),
      ]);
      return workingCopyStat.isDirectory()
        && !workingCopyStat.isSymbolicLink()
        && gitDirectoryStat.isDirectory()
        && !gitDirectoryStat.isSymbolicLink();
    } catch {
      return false;
    }
  }

   async #projectSummary(
    project: CollabLocalProjectIndex['projects'][number],
    membership: CollabLocalMembershipRecord | null,
    pending: boolean,
    workingCopyExists: boolean,
  ): Promise<CollabLocalProjectSummary> {
    const lifecycle = project.lifecycle ?? membership?.lifecycle;
    const effectiveLifecycle = lifecycle ?? 'active';
    const lanMembership = membership && isCollabLocalLanMembership(membership)
      ? membership
      : null;
    const ownsAuthority = lanMembership?.hostOwnership.ownsAuthority === true;
    let installationInspectionFailed = false;
    let inspectedInstallationStatus: CollabAuthorityInstallationStatus = 'absent';
    if (effectiveLifecycle !== 'retired' && ownsAuthority) {
      try {
        inspectedInstallationStatus = await this.options.hostInstallation.inspect(project.id);
      } catch {
        installationInspectionFailed = true;
      }
    }
    const hostInstallationStatus = inspectedInstallationStatus === 'absent'
      ? 'not-host'
      : inspectedInstallationStatus;
    const hostStatus = effectiveLifecycle === 'retired'
      ? 'not-host'
      : hostInstallationStatus === 'hosted-here'
      ? this.options.lanHost.getProjectState(project.id).status
      : hostInstallationStatus === 'legacy-unbound'
        ? 'stopped'
      : 'not-host';
    return {
      authorityKind: project.authorityKind,
      connectionStatus: effectiveLifecycle === 'retired'
        ? 'offline'
        : hostStatus === 'running'
        ? 'connected'
        : hostStatus === 'needs-attention'
          ? 'needs-attention'
          : hostInstallationStatus === 'hosted-here'
            || hostInstallationStatus === 'legacy-unbound'
          ? 'host-stopped'
          : membership ? this.options.readConnectionStatus(project.id) : 'offline',
      health: project.cleanupStatus === 'failed' || installationInspectionFailed
        ? 'needs-attention'
        : effectiveLifecycle === 'retired'
          ? 'healthy'
          : pending
        ? 'needs-attention'
        : workingCopyExists && membership
          ? 'healthy'
          : workingCopyExists
            ? 'needs-attention'
            : 'missing',
      hostStatus,
      hostInstallationStatus,
      id: project.id,
      name: project.name,
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(project.cleanupStatus === undefined
        ? {}
        : { cleanupStatus: project.cleanupStatus }),
      ...(project.retiredAt === undefined ? {} : { retiredAt: project.retiredAt }),
      ...(membership ? { role: membership.member.role } : {}),
      workspacePath: project.workspacePath,
    };
  }

}
