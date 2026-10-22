/** A group of sessions working toward one goal; membership lives on each conversation's `projectId`. */
export interface ProjectRecord {
  /** Names the record file, so it passes the same safe-segment check as session ids (`isValidSessionMetadataId`). */
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  /** Vault-relative path of the project doc; its file name is fixed at creation, its folder moves with `docFolder`. */
  readonly docPath: string;
  readonly isPinned: boolean;
  readonly createdAt: number;
}

export interface ProjectCreateInput {
  readonly name: string;
  readonly instructions: string;
  /** Vault-relative folder for the new doc; `''` is the vault root. */
  readonly docFolder: string;
}

export interface ProjectUpdatePatch {
  readonly name?: string;
  readonly instructions?: string;
  /**
   * Moves the doc into this vault-relative folder (`''` is the vault root), keeping its file name. A missing doc is
   * only repointed; throws `ProjectDocMoveConflictError` and changes nothing when a file is already there.
   */
  readonly docFolder?: string;
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
  /** Removes the record; member sessions stay and the project doc is kept. */
  delete(id: string): Promise<void>;
}

export interface ProjectMembership {
  /** Joins or moves the conversations into a live project, or out of any with null; views refresh once. */
  setConversationsProject(conversationIds: readonly string[], projectId: string | null): Promise<void>;
}

export interface ProjectDocContent {
  readonly content: string;
  /** Opaque content digest used for optimistic conflict detection. */
  readonly revision: string;
}

export type ProjectDocReadResult = ProjectDocContent | { readonly missing: true };

export interface ProjectDocSaveOptions {
  /** Write even when the doc changed since `expectedRevision`. */
  readonly overwrite?: boolean;
}

export interface ProjectDocOperations {
  readDoc(id: string): Promise<ProjectDocReadResult>;
  /** Throws `ProjectDocConflictError` when the current doc no longer matches `expectedRevision`, unless `overwrite`. */
  saveDoc(
    id: string,
    content: string,
    expectedRevision: string,
    options?: ProjectDocSaveOptions,
  ): Promise<ProjectDocContent>;
  /** Writes the template to the record's `docPath` unless a doc is there again; returns the doc either way. */
  recreateDoc(id: string): Promise<ProjectDocContent>;
}

export class ProjectDocConflictError extends Error {
  constructor(readonly projectId: string, options?: ErrorOptions) {
    super(`Project doc changed since it was read: ${projectId}`, options);
    this.name = 'ProjectDocConflictError';
  }
}

export class ProjectDocMoveConflictError extends Error {
  constructor(readonly projectId: string, readonly targetPath: string, options?: ErrorOptions) {
    super(`A file already exists where the project doc would move: ${targetPath}`, options);
    this.name = 'ProjectDocMoveConflictError';
  }
}
