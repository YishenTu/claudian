/** A group of sessions working toward one goal; membership lives on each conversation's `projectId`. */
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
   * appended); missing folders are created. Throws `ProjectMemoryPathTakenError` when a file is already there.
   */
  readonly memoryPath: string;
}

export interface ProjectUpdatePatch {
  readonly name?: string;
  readonly instructions?: string;
  /**
   * Moves or renames the memory file to this vault-relative path (normalized like `ProjectCreateInput.memoryPath`).
   * A missing memory file is only repointed; throws `ProjectMemoryPathTakenError` and changes nothing when a file is
   * already there.
   */
  readonly memoryPath?: string;
}
/**
 * Live project records. A conversation's `projectId` is meaningful only when `get` resolves it; null means no
 * project, so consumers never trust a raw id.
 */
export interface ProjectReader {
  list(): readonly ProjectRecord[];
  get(id: string): ProjectRecord | null;
  /** Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void;
}

export interface ProjectMutations {
  create(input: ProjectCreateInput): Promise<ProjectRecord>;
  update(id: string, patch: ProjectUpdatePatch): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** Removes the record; member sessions stay and the memory file is kept. */
  delete(id: string): Promise<void>;
}

export interface ProjectMembership {
  /** Joins or moves the conversations into a live project, or out of any with null; views refresh once. */
  setConversationsProject(conversationIds: readonly string[], projectId: string | null): Promise<void>;
}

export interface ProjectMemoryContent {
  readonly content: string;
  /** Opaque content digest used for optimistic conflict detection. */
  readonly revision: string;
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

/** A file already exists where a project memory file would be created or moved; nothing was changed. */
export class ProjectMemoryPathTakenError extends Error {
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`A file already exists at the project memory path: ${path}`, options);
    this.name = 'ProjectMemoryPathTakenError';
  }
}
