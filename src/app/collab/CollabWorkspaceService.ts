import { createHash } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { isCollabOpaqueId } from '@claudian/collab-protocol';

import {
  type CollabFilesystemDiagnosticSink,
  createCollabFileExclusively,
  ensureCollabContainerGuard,
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
} from '@/app/collab/CollabFilesystemBoundary';
import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import {
  decodeDetachedProjectMarker,
  type DetachedProjectMarker,
} from '@/app/collab/exit/DetachedProjectMarker';
import { parseCollabProjectsFolder } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECTS_ROOT_MARKER_NAME = '.claudian-collab-root.json';
const PROJECTS_ROOT_MARKER = {
  owner: 'claudian-collab-projects',
  schemaVersion: 1,
} as const;
const PROJECTS_ROOT_MARKER_CONTENTS = `${JSON.stringify(PROJECTS_ROOT_MARKER, null, 2)}\n`;

export type CollabProjectsFolderChildPurpose =
  | 'create-clone'
  | 'create-seed'
  | 'host-transfer-staging'
  | 'join-staging';

export interface CollabProjectsFolderChildOwnership {
  readonly childName: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly purpose: CollabProjectsFolderChildPurpose;
}

interface CollabProjectsFolderChildMarker extends CollabProjectsFolderChildOwnership {
  readonly owner: 'claudian-collab-operation-child';
  readonly schemaVersion: 1;
}

export interface CollabWorkspaceServiceOptions {
  readonly obsidianConfigDirectory?: string;
  readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
  readonly pathPolicy?: CollabPathPolicy;
}

export interface CollabWorkspaceCleanupPaths {
  readonly detachedGitPath: string;
  readonly detachedProjectPath: string;
  readonly gitPath: string;
  readonly markerPath: string;
  readonly projectPath: string;
}

export interface CollabProjectsFolderChild {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function workspaceBoundaryError(reason: string): CollabError {
  return new CollabError({
    code: 'workspace-boundary-invalid',
    safeContext: { reason },
    recoveryActions: ['open-diagnostics'],
  });
}

function isProjectsRootMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && record.owner === PROJECTS_ROOT_MARKER.owner
    && record.schemaVersion === PROJECTS_ROOT_MARKER.schemaVersion;
}

function operationChildMarker(
  ownership: CollabProjectsFolderChildOwnership,
): CollabProjectsFolderChildMarker {
  return {
    childName: ownership.childName,
    operationId: ownership.operationId,
    owner: 'claudian-collab-operation-child',
    projectId: ownership.projectId,
    purpose: ownership.purpose,
    schemaVersion: 1,
  };
}

function isOperationChildMarker(
  value: unknown,
  expected: CollabProjectsFolderChildMarker,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 6
    && record.childName === expected.childName
    && record.operationId === expected.operationId
    && record.owner === expected.owner
    && record.projectId === expected.projectId
    && record.purpose === expected.purpose
    && record.schemaVersion === expected.schemaVersion;
}

export class CollabWorkspaceService {
  private readonly obsidianConfigDirectory?: string;
  private readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
  private readonly pathPolicy: CollabPathPolicy;

  constructor(
    private readonly vaultRoot: string,
    options: CollabWorkspaceServiceOptions = {},
  ) {
    this.obsidianConfigDirectory = options.obsidianConfigDirectory;
    this.onDiagnostic = options.onDiagnostic;
    this.pathPolicy = options.pathPolicy ?? new CollabPathPolicy({
      obsidianConfigDirectory: options.obsidianConfigDirectory,
    });
  }

  async ensureWorkspaceContainer(): Promise<void> {
    await this.claimProjectsFolder('workspace');
  }

  async claimProjectsFolder(projectsFolder: string): Promise<void> {
    const normalizedFolder = this.requireProjectsFolder(projectsFolder);
    const candidateRootPath = await resolveCollabVaultPath(
      this.vaultRoot,
      normalizedFolder,
    );
    await this.rejectUnownedNonEmptyRoot(candidateRootPath, normalizedFolder);
    const rootAbsolutePath = await ensureCollabVaultDirectory(
      this.vaultRoot,
      normalizedFolder,
      {
        mode: 0o755,
        onDiagnostic: this.onDiagnostic,
        preserveExistingMode: true,
      },
    );
    const markerRelativePath = `${normalizedFolder}/${PROJECTS_ROOT_MARKER_NAME}`;
    const markerAbsolutePath = path.join(rootAbsolutePath, PROJECTS_ROOT_MARKER_NAME);
    const markerExists = await this.validateExistingProjectsMarker(markerAbsolutePath);
    if (!markerExists) {
      const entries = await readdir(rootAbsolutePath);
      const canAdoptLegacyWorkspace = normalizedFolder === 'workspace'
        && await this.hasStandaloneGuard(rootAbsolutePath);
      if (entries.length > 0 && !canAdoptLegacyWorkspace) {
        throw workspaceBoundaryError('projects-root-unowned-nonempty');
      }
      const created = await createCollabFileExclusively(
        this.vaultRoot,
        markerRelativePath,
        PROJECTS_ROOT_MARKER_CONTENTS,
        { mode: 0o644, onDiagnostic: this.onDiagnostic },
      );
      if (!created) {
        const validAfterRace = await this.validateExistingProjectsMarker(markerAbsolutePath);
        if (!validAfterRace) {
          throw workspaceBoundaryError('projects-root-marker-invalid');
        }
      }
    }
    await ensureCollabContainerGuard(this.vaultRoot, normalizedFolder, {
      onDiagnostic: this.onDiagnostic,
      preserveExistingDirectoryMode: true,
    });
  }

  async resolveManagedProjectPath(workspacePath: string): Promise<string> {
    const separatorIndex = workspacePath.lastIndexOf('/');
    if (separatorIndex <= 0 || separatorIndex === workspacePath.length - 1) {
      throw workspaceBoundaryError('project-workspace-path-invalid');
    }
    const projectsFolder = workspacePath.slice(0, separatorIndex);
    const childName = workspacePath.slice(separatorIndex + 1);
    const expectedPath = this.getProjectsFolderChildPath(projectsFolder, childName);
    if (expectedPath !== workspacePath) {
      throw workspaceBoundaryError('project-workspace-path-invalid');
    }

    // Existing installations used the guarded `workspace` root before the
    // ownership marker existed. Claiming here performs that one safe migration;
    // arbitrary non-empty roots remain ineligible for adoption.
    await this.claimProjectsFolder(projectsFolder);
    await this.requireOwnedProjectsFolder(projectsFolder);
    const absolutePath = await resolveCollabVaultPath(
      this.vaultRoot,
      expectedPath,
      { mustExist: true },
    );
    const projectStat = await lstat(absolutePath).catch(() => null);
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
      throw workspaceBoundaryError('project-workspace-boundary-invalid');
    }
    return absolutePath;
  }

  async resolveCleanupPaths(
    workspacePath: string,
    operationId: string,
  ): Promise<CollabWorkspaceCleanupPaths> {
    if (!isCollabOpaqueId(operationId)) {
      throw workspaceBoundaryError('cleanup-operation-id-invalid');
    }
    const projectPath = await this.resolveManagedProjectPath(workspacePath);
    const parentPath = path.dirname(projectPath);
    const childName = path.basename(projectPath);
    return {
      detachedGitPath: path.join(projectPath, `.claudian-collab-git-${operationId}`),
      detachedProjectPath: path.join(parentPath, `.claudian-collab-project-${operationId}-${childName}`),
      gitPath: path.join(projectPath, '.git'),
      markerPath: path.join(projectPath, '.claudian-collab-detached.json'),
      projectPath,
    };
  }

  async createDetachedProjectMarker(
    workspacePath: string,
    operationId: string,
    marker: DetachedProjectMarker,
  ): Promise<void> {
    const paths = await this.resolveCleanupPaths(workspacePath, operationId);
    const markerRelativePath = `${workspacePath}/.claudian-collab-detached.json`;
    const created = await createCollabFileExclusively(
      this.vaultRoot,
      markerRelativePath,
      `${JSON.stringify(decodeDetachedProjectMarker(marker), null, 2)}\n`,
      { mode: 0o600, onDiagnostic: this.onDiagnostic },
    );
    if (!created) {
      await this.assertDetachedProjectMarker(workspacePath, operationId, marker);
    }
    if (paths.markerPath !== path.join(paths.projectPath, '.claudian-collab-detached.json')) {
      throw workspaceBoundaryError('detached-marker-path-invalid');
    }
  }

  async assertDetachedProjectMarker(
    workspacePath: string,
    operationId: string,
    expected: DetachedProjectMarker,
  ): Promise<void> {
    const markerPath = await this.resolveCleanupMarkerPath(workspacePath, operationId);
    const markerStat = await lstat(markerPath).catch(() => null);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
      throw workspaceBoundaryError('detached-marker-invalid');
    }
    let actual: DetachedProjectMarker;
    try {
      actual = decodeDetachedProjectMarker(JSON.parse(await readFile(markerPath, 'utf8')));
    } catch {
      throw workspaceBoundaryError('detached-marker-invalid');
    }
    if (JSON.stringify(actual) !== JSON.stringify(decodeDetachedProjectMarker(expected))) {
      throw workspaceBoundaryError('detached-marker-mismatch');
    }
  }

  async removeDetachedProjectMarker(
    workspacePath: string,
    operationId: string,
    expected: DetachedProjectMarker,
  ): Promise<void> {
    const markerPath = await this.resolveCleanupMarkerPath(workspacePath, operationId);
    const markerStat = await lstat(markerPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw workspaceBoundaryError('detached-marker-remove-failed');
    });
    if (markerStat === null) return;
    await this.assertDetachedProjectMarker(workspacePath, operationId, expected);
    await unlink(markerPath).catch(() => {
      throw workspaceBoundaryError('detached-marker-remove-failed');
    });
  }

  async detachProjectGit(workspacePath: string, operationId: string): Promise<void> {
    const paths = await this.resolveCleanupPaths(workspacePath, operationId);
    const sourceExists = await this.cleanupPathExists(paths.gitPath);
    const detachedExists = await this.cleanupPathExists(paths.detachedGitPath);
    if (sourceExists && detachedExists) {
      throw workspaceBoundaryError('detached-git-collision');
    }
    if (detachedExists) {
      await this.requireCleanupDirectory(paths.detachedGitPath, 'detached-git-invalid');
      return;
    }
    if (!sourceExists) throw workspaceBoundaryError('project-git-invalid');
    await this.requireCleanupDirectory(paths.gitPath, 'project-git-invalid');
    await rename(paths.gitPath, paths.detachedGitPath).catch(() => {
      throw workspaceBoundaryError('project-git-detach-failed');
    });
  }

  async isProjectGitDetached(workspacePath: string, operationId: string): Promise<boolean> {
    const paths = await this.resolveCleanupPaths(workspacePath, operationId);
    const sourceExists = await this.cleanupPathExists(paths.gitPath);
    const detachedExists = await this.cleanupPathExists(paths.detachedGitPath);
    if (sourceExists === detachedExists) {
      throw workspaceBoundaryError(sourceExists ? 'detached-git-collision' : 'project-git-invalid');
    }
    if (detachedExists) {
      await this.requireCleanupDirectory(paths.detachedGitPath, 'detached-git-invalid');
      return true;
    }
    await this.requireCleanupDirectory(paths.gitPath, 'project-git-invalid');
    return false;
  }

  async removeDetachedProjectGit(workspacePath: string, operationId: string): Promise<void> {
    const paths = await this.resolveCleanupPaths(workspacePath, operationId);
    const exists = await this.cleanupPathExists(paths.detachedGitPath);
    if (!exists) return;
    await this.requireCleanupDirectory(paths.detachedGitPath, 'detached-git-invalid');
    await rm(paths.detachedGitPath, { recursive: true }).catch(() => {
      throw workspaceBoundaryError('detached-git-remove-failed');
    });
  }

  async detachProjectRoot(workspacePath: string, operationId: string): Promise<void> {
    const separatorIndex = workspacePath.lastIndexOf('/');
    if (separatorIndex <= 0) throw workspaceBoundaryError('project-workspace-path-invalid');
    const projectsFolder = workspacePath.slice(0, separatorIndex);
    const childName = workspacePath.slice(separatorIndex + 1);
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    if (this.getProjectsFolderChildPath(normalizedFolder, childName) !== workspacePath) {
      throw workspaceBoundaryError('project-workspace-path-invalid');
    }
    if (!isCollabOpaqueId(operationId)) {
      throw workspaceBoundaryError('cleanup-operation-id-invalid');
    }
    const projectPath = await resolveCollabVaultPath(this.vaultRoot, workspacePath);
    const detachedRelativePath = `${projectsFolder}/.claudian-collab-project-${operationId}-${childName}`;
    const detachedProjectPath = await resolveCollabVaultPath(this.vaultRoot, detachedRelativePath);
    if (await this.cleanupPathExists(detachedProjectPath)) {
      const projectStillExists = await this.cleanupPathExists(projectPath);
      if (projectStillExists) throw workspaceBoundaryError('detached-project-collision');
      await this.requireCleanupDirectory(detachedProjectPath, 'detached-project-invalid');
      return;
    }
    await this.requireCleanupDirectory(projectPath, 'project-workspace-boundary-invalid');
    await rename(projectPath, detachedProjectPath).catch(() => {
      throw workspaceBoundaryError('project-root-detach-failed');
    });
  }

  async removeDetachedProjectRoot(
    workspacePath: string,
    operationId: string,
    expectedMarker: DetachedProjectMarker,
  ): Promise<void> {
    const separatorIndex = workspacePath.lastIndexOf('/');
    if (separatorIndex <= 0) throw workspaceBoundaryError('project-workspace-path-invalid');
    const projectsFolder = workspacePath.slice(0, separatorIndex);
    await this.requireOwnedProjectsFolder(projectsFolder);
    const childName = workspacePath.slice(separatorIndex + 1);
    const detachedRelativePath = `${projectsFolder}/.claudian-collab-project-${operationId}-${childName}`;
    const detachedPath = await resolveCollabVaultPath(this.vaultRoot, detachedRelativePath);
    if (!await this.cleanupPathExists(detachedPath)) return;
    await this.requireCleanupDirectory(detachedPath, 'detached-project-invalid');
    await this.assertDetachedProjectMarker(workspacePath, operationId, expectedMarker);
    await rm(detachedPath, { recursive: true }).catch(() => {
      throw workspaceBoundaryError('detached-project-remove-failed');
    });
  }

  getProjectsFolderChildPath(projectsFolder: string, childName: string): string {
    const normalizedFolder = this.requireProjectsFolder(projectsFolder);
    const childResult = this.pathPolicy.validateRepositoryPath(childName);
    if (!childResult.ok || childName.includes('/')) {
      throw workspaceBoundaryError('projects-child-name-invalid');
    }
    return `${normalizedFolder}/${childName}`;
  }

  async reserveProjectsFolderChild(
    projectsFolder: string,
    ownership: CollabProjectsFolderChildOwnership,
  ): Promise<CollabProjectsFolderChild> {
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    const relativePath = this.getProjectsFolderChildPath(
      normalizedFolder,
      ownership.childName,
    );
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    const marker = operationChildMarker(ownership);
    const markerRelativePath = this.operationChildMarkerRelativePath(
      normalizedFolder,
      marker,
    );
    const markerAbsolutePath = await resolveCollabVaultPath(
      this.vaultRoot,
      markerRelativePath,
    );
    const markerExists = await this.validateExistingOperationChildMarker(
      markerAbsolutePath,
      marker,
    );
    const childStat = await lstat(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw workspaceBoundaryError('projects-child-inspection-failed');
    });
    if (childStat && (!childStat.isDirectory() || childStat.isSymbolicLink())) {
      throw workspaceBoundaryError('projects-child-boundary-invalid');
    }
    if (!markerExists && childStat) {
      throw workspaceBoundaryError('projects-child-collision');
    }
    if (!markerExists) {
      const created = await createCollabFileExclusively(
        this.vaultRoot,
        markerRelativePath,
        `${JSON.stringify(marker, null, 2)}\n`,
        { mode: 0o600, onDiagnostic: this.onDiagnostic },
      );
      if (!created && !await this.validateExistingOperationChildMarker(
        markerAbsolutePath,
        marker,
      )) {
        throw workspaceBoundaryError('projects-child-owner-invalid');
      }
    }
    return { absolutePath, relativePath };
  }

  async removeReservedProjectsFolderChild(
    projectsFolder: string,
    ownership: CollabProjectsFolderChildOwnership,
  ): Promise<boolean> {
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    const marker = operationChildMarker(ownership);
    const markerRelativePath = this.operationChildMarkerRelativePath(
      normalizedFolder,
      marker,
    );
    const markerAbsolutePath = await resolveCollabVaultPath(
      this.vaultRoot,
      markerRelativePath,
    );
    if (!await this.validateExistingOperationChildMarker(markerAbsolutePath, marker)) {
      return false;
    }
    const relativePath = this.getProjectsFolderChildPath(
      normalizedFolder,
      ownership.childName,
    );
    const absolutePath = await resolveCollabVaultPath(this.vaultRoot, relativePath);
    const childStat = await lstat(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw workspaceBoundaryError('projects-child-inspection-failed');
    });
    if (childStat) {
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
        throw workspaceBoundaryError('projects-child-boundary-invalid');
      }
      await rm(absolutePath, { recursive: true });
    }
    await unlink(markerAbsolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw workspaceBoundaryError('projects-child-owner-remove-failed');
      }
    });
    return true;
  }

  async releaseReservedProjectsFolderChild(
    projectsFolder: string,
    ownership: CollabProjectsFolderChildOwnership,
  ): Promise<boolean> {
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    const marker = operationChildMarker(ownership);
    const markerAbsolutePath = await resolveCollabVaultPath(
      this.vaultRoot,
      this.operationChildMarkerRelativePath(normalizedFolder, marker),
    );
    if (!await this.validateExistingOperationChildMarker(markerAbsolutePath, marker)) {
      return false;
    }
    await unlink(markerAbsolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw workspaceBoundaryError('projects-child-owner-remove-failed');
      }
    });
    return true;
  }

  private requireProjectsFolder(projectsFolder: string): string {
    const parsed = parseCollabProjectsFolder(projectsFolder, {
      obsidianConfigDirectory: this.obsidianConfigDirectory,
    });
    if (!parsed.ok) {
      throw workspaceBoundaryError('projects-folder-invalid');
    }
    return parsed.value;
  }

  private async requireOwnedProjectsFolder(projectsFolder: string): Promise<string> {
    const normalizedFolder = this.requireProjectsFolder(projectsFolder);
    const rootAbsolutePath = await resolveCollabVaultPath(
      this.vaultRoot,
      normalizedFolder,
      { mustExist: true },
    );
    const rootStat = await lstat(rootAbsolutePath).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw workspaceBoundaryError('projects-root-boundary-invalid');
    }
    if (!await this.validateExistingProjectsMarker(
      path.join(rootAbsolutePath, PROJECTS_ROOT_MARKER_NAME),
    )) {
      throw workspaceBoundaryError('projects-root-unowned');
    }
    return normalizedFolder;
  }

  private operationChildMarkerRelativePath(
    projectsFolder: string,
    marker: CollabProjectsFolderChildMarker,
  ): string {
    const identity = JSON.stringify(marker);
    const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
    return `${projectsFolder}/.claudian-operation-${digest}.json`;
  }

  private async validateExistingOperationChildMarker(
    markerAbsolutePath: string,
    expected: CollabProjectsFolderChildMarker,
  ): Promise<boolean> {
    let markerStat: Awaited<ReturnType<typeof lstat>>;
    try {
      markerStat = await lstat(markerAbsolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw workspaceBoundaryError('projects-child-owner-inspection-failed');
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw workspaceBoundaryError('projects-child-owner-invalid');
    }
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(markerAbsolutePath, 'utf8')) as unknown;
    } catch {
      throw workspaceBoundaryError('projects-child-owner-invalid');
    }
    if (!isOperationChildMarker(marker, expected)) {
      throw workspaceBoundaryError('projects-child-owner-invalid');
    }
    return true;
  }

  private async validateExistingProjectsMarker(markerAbsolutePath: string): Promise<boolean> {
    let markerStat: Awaited<ReturnType<typeof lstat>>;
    try {
      markerStat = await lstat(markerAbsolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw workspaceBoundaryError('projects-root-marker-inspection-failed');
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw workspaceBoundaryError('projects-root-marker-invalid');
    }
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(markerAbsolutePath, 'utf8')) as unknown;
    } catch {
      throw workspaceBoundaryError('projects-root-marker-invalid');
    }
    if (!isProjectsRootMarker(marker)) {
      throw workspaceBoundaryError('projects-root-marker-invalid');
    }
    return true;
  }

  private async rejectUnownedNonEmptyRoot(
    rootAbsolutePath: string,
    normalizedFolder: string,
  ): Promise<void> {
    let rootStat: Awaited<ReturnType<typeof lstat>>;
    try {
      rootStat = await lstat(rootAbsolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw workspaceBoundaryError('projects-root-inspection-failed');
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw workspaceBoundaryError('projects-root-boundary-invalid');
    }
    const markerExists = await this.validateExistingProjectsMarker(
      path.join(rootAbsolutePath, PROJECTS_ROOT_MARKER_NAME),
    );
    if (markerExists) return;
    const entries = await readdir(rootAbsolutePath);
    const canAdoptLegacyWorkspace = normalizedFolder === 'workspace'
      && await this.hasStandaloneGuard(rootAbsolutePath);
    if (entries.length > 0 && !canAdoptLegacyWorkspace) {
      throw workspaceBoundaryError('projects-root-unowned-nonempty');
    }
  }

  private async hasStandaloneGuard(rootAbsolutePath: string): Promise<boolean> {
    const guardAbsolutePath = path.join(rootAbsolutePath, '.gitignore');
    let guardStat: Awaited<ReturnType<typeof lstat>>;
    try {
      guardStat = await lstat(guardAbsolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw workspaceBoundaryError('guard-read-failed');
    }
    if (!guardStat.isFile() || guardStat.isSymbolicLink()) {
      throw workspaceBoundaryError('guard-file-boundary-invalid');
    }
    const contents = await readFile(guardAbsolutePath, 'utf8').catch(() => {
      throw workspaceBoundaryError('guard-read-failed');
    });
    return contents.split(/\r?\n/).includes('/*');
  }

  private async cleanupPathExists(absolutePath: string): Promise<boolean> {
    return lstat(absolutePath).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw workspaceBoundaryError('cleanup-path-inspection-failed');
    });
  }

  private async resolveCleanupMarkerPath(
    workspacePath: string,
    operationId: string,
  ): Promise<string> {
    const separatorIndex = workspacePath.lastIndexOf('/');
    if (separatorIndex <= 0) throw workspaceBoundaryError('project-workspace-path-invalid');
    const projectsFolder = workspacePath.slice(0, separatorIndex);
    const childName = workspacePath.slice(separatorIndex + 1);
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    if (this.getProjectsFolderChildPath(normalizedFolder, childName) !== workspacePath) {
      throw workspaceBoundaryError('project-workspace-path-invalid');
    }
    if (!isCollabOpaqueId(operationId)) {
      throw workspaceBoundaryError('cleanup-operation-id-invalid');
    }
    const sourcePath = await resolveCollabVaultPath(this.vaultRoot, workspacePath);
    const detachedRelativePath = `${projectsFolder}/.claudian-collab-project-${operationId}-${childName}`;
    const detachedPath = await resolveCollabVaultPath(this.vaultRoot, detachedRelativePath);
    const sourceExists = await this.cleanupPathExists(sourcePath);
    const detachedExists = await this.cleanupPathExists(detachedPath);
    if (sourceExists === detachedExists) {
      throw workspaceBoundaryError('cleanup-project-location-invalid');
    }
    const rootPath = sourceExists ? sourcePath : detachedPath;
    await this.requireCleanupDirectory(rootPath, 'project-workspace-boundary-invalid');
    return path.join(rootPath, '.claudian-collab-detached.json');
  }

  async isProjectRootRemoved(
    workspacePath: string,
    operationId: string,
  ): Promise<boolean> {
    const separatorIndex = workspacePath.lastIndexOf('/');
    if (separatorIndex <= 0) throw workspaceBoundaryError('project-workspace-path-invalid');
    const projectsFolder = workspacePath.slice(0, separatorIndex);
    const childName = workspacePath.slice(separatorIndex + 1);
    const normalizedFolder = await this.requireOwnedProjectsFolder(projectsFolder);
    if (this.getProjectsFolderChildPath(normalizedFolder, childName) !== workspacePath) {
      throw workspaceBoundaryError('project-workspace-path-invalid');
    }
    if (!isCollabOpaqueId(operationId)) {
      throw workspaceBoundaryError('cleanup-operation-id-invalid');
    }
    const sourcePath = await resolveCollabVaultPath(this.vaultRoot, workspacePath);
    const detachedPath = await resolveCollabVaultPath(
      this.vaultRoot,
      `${projectsFolder}/.claudian-collab-project-${operationId}-${childName}`,
    );
    return !await this.cleanupPathExists(sourcePath)
      && !await this.cleanupPathExists(detachedPath);
  }

  private async requireCleanupDirectory(absolutePath: string, reason: string): Promise<void> {
    const targetStat = await lstat(absolutePath).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
      throw workspaceBoundaryError(reason);
    }
  }
}
