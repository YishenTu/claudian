/**
 * A group of sessions working toward one goal; membership lives on each conversation's `projectId` and is written
 * through the conversation owner. Deleting a record leaves member ids in place; they resolve to no project.
 */
export interface ProjectRecord {
  /** Names the record file, so it passes the same safe-segment check as session ids (`isValidSessionMetadataId`). */
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  /** Vault-relative path of the project memory file (`.md`); editing the project can move or rename it. */
  readonly memoryPath: string;
  readonly isPinned: boolean;
  readonly createdAt: number;
}

export interface ProjectCreateInput {
  readonly name: string;
  readonly instructions: string;
  /**
   * Vault-relative path for the new memory file, normalized by `normalizeProjectMemoryPath` (a missing `.md` is
   * appended); missing folders are created. Throws `ProjectMemoryPathTakenError` when a file is already there or
   * another project records the path.
   */
  readonly memoryPath: string;
}

export interface ProjectUpdatePatch {
  readonly name?: string;
  readonly instructions?: string;
  /**
   * Moves or renames the memory file to this vault-relative path (normalized like `ProjectCreateInput.memoryPath`).
   * A missing memory file is only repointed; throws `ProjectMemoryPathTakenError` and changes nothing when a file is
   * already there or another project records the path.
   */
  readonly memoryPath?: string;
}
/**
 * Live project records. A conversation's `projectId` is meaningful only when `get` resolves it; null means no
 * project, so consumers never trust a raw id.
 */
export interface ProjectReader {
  list(): readonly ProjectRecord[];
  /** Undefined (no project id) resolves to null, like a missing or deleted project. */
  get(id: string | undefined): ProjectRecord | null;
  /** Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void;
}

export interface ProjectMutations {
  create(input: ProjectCreateInput): Promise<ProjectRecord>;
  update(id: string, patch: ProjectUpdatePatch): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  /**
   * Removes the record and moves its memory file to the trash (best effort). Member sessions stay; their ids
   * resolve to no project until the caller clears them through the conversation owner.
   */
  delete(id: string): Promise<void>;
}

export interface ProjectMemoryContent {
  readonly content: string;
  /** Opaque content digest used for optimistic conflict detection. */
  readonly revision: string;
  /** When the memory file was last written (epoch ms), or null when the platform cannot tell. */
  readonly modifiedAt: number | null;
}

export type ProjectMemoryReadResult = ProjectMemoryContent | { readonly missing: true };

export interface ProjectMemorySaveOptions {
  /** Write even when the memory file changed since `expectedRevision`. */
  readonly overwrite?: boolean;
}

export interface ProjectMemoryOperations {
  readMemory(id: string): Promise<ProjectMemoryReadResult>;
  /** Throws `ProjectMemoryConflictError` when the current memory file no longer matches `expectedRevision`, unless `overwrite`. */
  saveMemory(
    id: string,
    content: string,
    expectedRevision: string,
    options?: ProjectMemorySaveOptions,
  ): Promise<ProjectMemoryContent>;
  /** Writes the template to the record's `memoryPath` unless a file is there again; returns the memory either way. */
  recreateMemory(id: string): Promise<ProjectMemoryContent>;
}

export class ProjectMemoryConflictError extends Error {
  constructor(readonly projectId: string, options?: ErrorOptions) {
    super(`Project memory changed since it was read: ${projectId}`, options);
    this.name = 'ProjectMemoryConflictError';
  }
}

/**
 * A file already exists, or another project records the path, where a project memory file would be created or
 * moved; nothing was changed.
 */
export class ProjectMemoryPathTakenError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`A file already exists at the project memory path: ${path}`, options);
    this.name = 'ProjectMemoryPathTakenError';
  }
}
