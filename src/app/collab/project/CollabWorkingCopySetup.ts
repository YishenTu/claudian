import { lstat, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import { resolveCollabVaultPath, syncCollabVaultDirectoryDurably } from '@/app/collab/CollabFilesystemBoundary';
import type { CollabLocalMembershipRecord, CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type { CollabProjectsFolderChildOwnership, CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { COLLAB_MAIN_FETCH_REFSPEC, COLLAB_ORIGIN_MAIN_REF } from '@/app/collab/git/collabGitRefs';
import { type GitNetworkEnvironment, parseGitNulFields } from '@/app/collab/git/GitCommandRunner';
import { COLLAB_PUBLICATION_STATE_SCHEMA_VERSION, decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabWorkingCopyFoundation {
  readonly local: {
    readonly pathPolicy: Pick<CollabPathPolicy, 'validateRepositoryPath'>;
    readonly projects: Pick<CollabLocalProjectRepository,
      'loadIndex' | 'loadMembership' | 'loadProjectDocument' | 'saveMembership' | 'saveProjectDocument' | 'upsertProject' | 'selectProject'>;
    readonly workspace: Pick<CollabWorkspaceService,
      'getProjectsFolderChildPath' | 'reserveProjectsFolderChild' | 'removeReservedProjectsFolderChild' | 'releaseReservedProjectsFolderChild'>;
  };
  requireGitFoundation(): Promise<CollabGitFoundation>;
}

export interface CollabWorkingCopyIdentity {
  readonly projectId: string;
  readonly memberId: string;
  readonly personalRef: string;
}

export interface CollabWorkingCopyPlacement extends CollabWorkingCopyIdentity {
  readonly projectsFolder: string;
  readonly slug: string;
  readonly staging: CollabProjectsFolderChildOwnership;
}

const INDEX_MODE_PATTERN = /^(100644|100755) ([0-9a-f]{40}(?:[0-9a-f]{24})?) 0\t(.+)$/;

function setupError(
  code: 'cancelled' | 'repository-invalid' | 'workspace-boundary-invalid' | 'quota-exceeded',
  reason: string,
): CollabError {
  return new CollabError({ code, recoveryActions: ['resume', 'open-diagnostics'], safeContext: { reason } });
}

async function inspectPath(absolutePath: string) {
  return lstat(absolutePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

export class CollabWorkingCopySetup {
  constructor(
    private readonly foundation: CollabWorkingCopyFoundation,
    private readonly vaultRoot: string,
  ) {}

  async clone(
    input: CollabWorkingCopyPlacement & { readonly displayName: string; readonly remoteUrl: string },
    network: GitNetworkEnvironment,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.foundation.local.workspace.removeReservedProjectsFolderChild(input.projectsFolder, input.staging);
    await this.foundation.local.workspace.reserveProjectsFolderChild(input.projectsFolder, input.staging);
    const git = await this.foundation.requireGitFoundation();
    try {
      const clonePath = await git.repositories.cloneRepository({
        branch: input.personalRef.slice('refs/heads/'.length),
        directoryName: input.staging.childName,
        network,
        parentDirectory: await resolveCollabVaultPath(this.vaultRoot, input.projectsFolder, { mustExist: true }),
        remoteUrl: input.remoteUrl,
        signal,
      });
      await git.repositories.fetch(clonePath, 'origin', [COLLAB_MAIN_FETCH_REFSPEC], network, signal);
      await git.repositories.configureLocalRepository(clonePath, {
        memberId: input.memberId,
        personalRef: input.personalRef,
        projectId: input.projectId,
        userDisplayName: input.displayName,
      });
      await this.validate(clonePath, input, git);
    } catch (error) {
      await this.foundation.local.workspace.removeReservedProjectsFolderChild(input.projectsFolder, input.staging)
        .catch(() => undefined);
      throw error;
    }
  }

  async place(input: CollabWorkingCopyPlacement, signal?: AbortSignal): Promise<void> {
    const git = await this.foundation.requireGitFoundation();
    const stagingPath = await this.childPath(input.projectsFolder, input.staging.childName);
    const finalPath = await this.childPath(input.projectsFolder, input.slug);
    const [stagingStat, finalStat] = await Promise.all([inspectPath(stagingPath), inspectPath(finalPath)]);
    if (finalStat) {
      if (stagingStat || !finalStat.isDirectory() || finalStat.isSymbolicLink()) {
        throw setupError('workspace-boundary-invalid', 'setup-final-boundary-invalid');
      }
      await this.validate(finalPath, input, git);
    } else {
      if (!stagingStat?.isDirectory() || stagingStat.isSymbolicLink()) {
        throw setupError('workspace-boundary-invalid', 'setup-staging-missing');
      }
      await this.foundation.local.workspace.reserveProjectsFolderChild(input.projectsFolder, input.staging);
      await this.validate(stagingPath, input, git);
      signal?.throwIfAborted();
      await rename(stagingPath, finalPath);
      await syncCollabVaultDirectoryDurably(this.vaultRoot, input.projectsFolder);
    }
    await this.foundation.local.workspace.releaseReservedProjectsFolderChild(input.projectsFolder, input.staging);
  }

  async finalize(membership: CollabLocalMembershipRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const projectId = membership.project.id;
    const workingCopy = await resolveCollabVaultPath(this.vaultRoot, membership.project.workspacePath, { mustExist: true });
    const git = await this.foundation.requireGitFoundation();
    const identity = { memberId: membership.member.id, personalRef: membership.member.personalRef, projectId };
    await git.repositories.assertLocalRepositoryIdentity(workingCopy, identity);
    const existing = await this.foundation.local.projects.loadMembership(projectId);
    if (existing && (
      existing.project.workspacePath !== membership.project.workspacePath
      || existing.member.id !== membership.member.id
      || existing.member.personalRef !== membership.member.personalRef
      || !isDeepStrictEqual(existing.authority, membership.authority)
    )) {
      throw setupError('repository-invalid', 'setup-existing-binding-mismatch');
    }
    const publication = await this.foundation.local.projects.loadProjectDocument(projectId, 'publication-state', decodeCollabPublicationStateRecord);
    if (!publication) await this.validate(workingCopy, identity, git);
    const baseMainOid = await git.repositories.resolveRef(workingCopy, COLLAB_ORIGIN_MAIN_REF);
    if (!baseMainOid) throw setupError('repository-invalid', 'setup-accepted-main-missing');
    if (!existing) await this.foundation.local.projects.saveMembership(membership);
    if (!publication) {
      await this.foundation.local.projects.saveProjectDocument(projectId, 'publication-state', {
        baseMainOid, operation: null, projectId,
        schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION, updatedAt: membership.updatedAt,
      });
    }
    await this.foundation.local.projects.upsertProject({
      authorityKind: membership.authority.kind,
      createdAt: membership.createdAt,
      id: projectId,
      name: membership.project.name,
      updatedAt: membership.updatedAt,
      workspacePath: membership.project.workspacePath,
    });
    await this.foundation.local.projects.selectProject(projectId);
  }

  childPath(projectsFolder: string, child: string): Promise<string> {
    return resolveCollabVaultPath(this.vaultRoot, this.foundation.local.workspace.getProjectsFolderChildPath(projectsFolder, child));
  }

  async assertFinalized(membership: CollabLocalMembershipRecord): Promise<CollabLocalMembershipRecord> {
    const projectId = membership.project.id;
    const [index, retained, publication] = await Promise.all([
      this.foundation.local.projects.loadIndex(),
      this.foundation.local.projects.loadMembership(projectId),
      this.foundation.local.projects.loadProjectDocument(projectId, 'publication-state', decodeCollabPublicationStateRecord),
    ]);
    const project = index.projects.find(entry => entry.id === projectId);
    if (!project || !retained || !publication
      || project.workspacePath !== membership.project.workspacePath
      || project.authorityKind !== membership.authority.kind
      || retained.project.workspacePath !== membership.project.workspacePath
      || retained.member.id !== membership.member.id || retained.member.personalRef !== membership.member.personalRef
      || !isDeepStrictEqual(retained.authority, membership.authority)) {
      throw setupError('repository-invalid', 'setup-finalization-incomplete');
    }
    const git = await this.foundation.requireGitFoundation();
    await git.repositories.assertLocalRepositoryIdentity(
      await resolveCollabVaultPath(this.vaultRoot, membership.project.workspacePath, { mustExist: true }),
      { memberId: membership.member.id, personalRef: membership.member.personalRef, projectId },
    );
    return retained;
  }

  async validate(
    repositoryPath: string,
    record: CollabWorkingCopyIdentity,
    git: CollabGitFoundation,
  ): Promise<void> {
    const personalRef = record.personalRef;
    await git.repositories.assertLocalRepositoryIdentity(repositoryPath, record);
    const [headOid, personalOid, status, symbolicRef] = await Promise.all([
      git.repositories.resolveRef(repositoryPath, 'HEAD'),
      git.repositories.resolveRef(repositoryPath, personalRef),
      git.repositories.getWorkingTreeStatus(repositoryPath),
      git.runner.run({
        args: ['symbolic-ref', '--quiet', 'HEAD'],
        cwd: repositoryPath,
        maxStdoutBytes: 512,
      }),
    ]);
    if (
      !headOid
      || headOid !== personalOid
      || symbolicRef.stdout.toString('utf8').trim() !== personalRef
      || status.length > 0
    ) {
      throw setupError('repository-invalid', 'joined-personal-ref-invalid');
    }
    const index = await git.runner.run({
      args: ['ls-files', '--stage', '-z'],
      cwd: repositoryPath,
      maxStdoutBytes: 16 * 1024 * 1024,
    });
    const tracked = new Set<string>();
    for (const entry of parseGitNulFields(index.stdout)) {
      const match = INDEX_MODE_PATTERN.exec(entry);
      if (!match) throw setupError('repository-invalid', 'joined-index-entry-invalid');
      const pathResult = this.foundation.local.pathPolicy.validateRepositoryPath(match[3]);
      if (!pathResult.ok || tracked.has(match[3])) {
        throw pathResult.ok
          ? setupError('repository-invalid', 'joined-index-path-duplicate')
          : pathResult.error;
      }
      tracked.add(match[3]);
    }
    const checkout = await this.#listCheckoutFiles(repositoryPath);
    if (
      checkout.files.length !== tracked.size
      || checkout.files.some(file => !tracked.has(file))
    ) {
      throw setupError('repository-invalid', 'joined-checkout-mismatch');
    }
    await git.repositories.assertHealthy(repositoryPath);
  }

   async #listCheckoutFiles(
    repositoryPath: string,
  ): Promise<{ readonly files: readonly string[]; readonly totalBytes: number }> {
    const files: string[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (relativeDirectory.length === 0 && entry.name === '.git') continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const pathResult = this.foundation.local.pathPolicy.validateRepositoryPath(relativePath);
        if (!pathResult.ok) throw pathResult.error;
        const absolutePath = path.join(directory, entry.name);
        const fileStat = await lstat(absolutePath);
        if (fileStat.isSymbolicLink()) {
          throw setupError('repository-invalid', 'joined-symbolic-link');
        }
        if (fileStat.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (!fileStat.isFile()) {
          throw setupError('repository-invalid', 'joined-file-type-invalid');
        }
        if (fileStat.size > CLAUDIAN_COLLAB_LIMITS.maxBlobBytes) {
          throw setupError('quota-exceeded', 'joined-blob-limit');
        }
        files.push(relativePath);
        totalBytes += fileStat.size;
        if (
          files.length > CLAUDIAN_COLLAB_LIMITS.maxChangedPaths
          || totalBytes > CLAUDIAN_COLLAB_LIMITS.maxCheckoutBytes
        ) {
          throw setupError('quota-exceeded', 'joined-checkout-limit');
        }
      }
    };
    await visit(repositoryPath, '');
    files.sort();
    return { files, totalBytes };
  }


}
