import { createHash, randomUUID } from 'node:crypto';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  type ProjectCreateInput,
  ProjectDocConflictError,
  type ProjectDocContent,
  type ProjectDocOperations,
  type ProjectDocReadResult,
  type ProjectDocSaveOptions,
  type ProjectMembership,
  type ProjectMutations,
  type ProjectReader,
  type ProjectRecord,
  type ProjectUpdatePatch,
} from '@/core/types';

import { normalizeProjectDocFolder } from '../settings/ClaudianSettingsStorage';
import type { ProjectStore } from './ProjectStore';

/** Conversation-owned membership writes; the conversation owner checks liveness at its serialized write. */
export interface ProjectMemberPort {
  setConversationsProject(conversationIds: readonly string[], projectId: string | null): Promise<void>;
  clearProject(projectId: string): Promise<void>;
}

export interface ProjectServiceDeps {
  readonly store: Pick<ProjectStore, 'save' | 'remove'>;
  readonly docs: Pick<VaultFileAdapter, 'ensureManagedFolder' | 'readManagedFile' | 'verifyManagedPath' | 'writeManagedFile'>;
  /** Read at creation only, so a changed setting never moves existing docs. */
  getProjectDocFolder(): string;
  readonly members: ProjectMemberPort;
}

const DOC_SLUG_MAX_LENGTH = 48;

/**
 * Sole owner of project records and the project doc. Record and doc writes serialize per project;
 * membership stays on each conversation and is written through the conversation owner.
 */
export class ProjectService implements ProjectReader, ProjectMutations, ProjectMembership, ProjectDocOperations {
  readonly #records = new Map<string, ProjectRecord>();
  readonly #listeners = new Set<() => void>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(records: readonly ProjectRecord[], private readonly deps: ProjectServiceDeps) {
    for (const record of records) this.#records.set(record.id, record);
  }

  list(): readonly ProjectRecord[] {
    return Array.from(this.#records.values());
  }

  get(id: string): ProjectRecord | null {
    return this.#records.get(id) ?? null;
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async create(input: ProjectCreateInput): Promise<ProjectRecord> {
    const name = requireName(input.name);
    const id = randomUUID();
    const folder = normalizeProjectDocFolder(this.deps.getProjectDocFolder());
    const record: ProjectRecord = {
      id,
      name,
      instructions: input.instructions,
      docPath: `${folder ? `${folder}/` : ''}${slugify(name)}-${id.slice(0, 8)}.md`,
      isPinned: false,
      createdAt: Date.now(),
    };
    return this.#enqueue(id, async () => {
      // The id prefix keeps the name unique; a doc already at that path is never replaced.
      if (!await this.deps.docs.verifyManagedPath(record.docPath, { expectedType: 'file', allowMissing: true })) {
        await this.#writeDoc(record.docPath, renderProjectDocTemplate(name));
      }
      await this.deps.store.save(record);
      this.#records.set(id, record);
      this.#publish();
      return record;
    });
  }

  update(id: string, patch: ProjectUpdatePatch): Promise<void> {
    return this.#commit(id, record => ({
      ...record,
      ...(patch.name !== undefined ? { name: requireName(patch.name) } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    }));
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.#commit(id, record => (record.isPinned === pinned ? record : { ...record, isPinned: pinned }));
  }

  async delete(id: string): Promise<void> {
    const removed = await this.#enqueue(id, async () => {
      if (!this.#records.has(id)) return false;
      await this.deps.store.remove(id);
      this.#records.delete(id);
      this.#publish();
      return true;
    });
    if (!removed) return;
    // Best effort: readers already treat the stale id as no project, including unloaded and remote metadata.
    await this.deps.members.clearProject(id).catch(() => undefined);
  }

  setConversationsProject(conversationIds: readonly string[], projectId: string | null): Promise<void> {
    return this.deps.members.setConversationsProject(conversationIds, projectId);
  }

  async readDoc(id: string): Promise<ProjectDocReadResult> {
    return this.#readDoc(this.#require(id).docPath);
  }

  saveDoc(
    id: string,
    content: string,
    expectedRevision: string,
    options: ProjectDocSaveOptions = {},
  ): Promise<ProjectDocContent> {
    return this.#enqueue(id, async () => {
      const { docPath } = this.#require(id);
      if (!options.overwrite) {
        const current = await this.#readDoc(docPath);
        if ('missing' in current || current.revision !== expectedRevision) {
          throw new ProjectDocConflictError(id);
        }
      }
      await this.#writeDoc(docPath, content);
      return toDocContent(content);
    });
  }

  recreateDoc(id: string): Promise<ProjectDocContent> {
    return this.#enqueue(id, async () => {
      const record = this.#require(id);
      // The doc may have reappeared (sync, undo) since it was reported missing; never replace it.
      const current = await this.#readDoc(record.docPath);
      if (!('missing' in current)) return current;
      const content = renderProjectDocTemplate(record.name);
      await this.#writeDoc(record.docPath, content);
      return toDocContent(content);
    });
  }

  /** Waits for queued writes; later notifications reach no listener. */
  async dispose(): Promise<void> {
    this.#listeners.clear();
    await Promise.all(this.#queues.values());
  }

  #commit(id: string, next: (record: ProjectRecord) => ProjectRecord): Promise<void> {
    return this.#enqueue(id, async () => {
      const record = this.#records.get(id);
      if (!record) return;
      const updated = next(record);
      if (updated === record) return;
      await this.deps.store.save(updated);
      this.#records.set(id, updated);
      this.#publish();
    });
  }

  #require(id: string): ProjectRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown project: ${id}`);
    return record;
  }

  async #readDoc(docPath: string): Promise<ProjectDocReadResult> {
    if (!await this.deps.docs.verifyManagedPath(docPath, { expectedType: 'file', allowMissing: true })) {
      return { missing: true };
    }
    return toDocContent(await this.deps.docs.readManagedFile(docPath));
  }

  async #writeDoc(docPath: string, content: string): Promise<void> {
    const separator = docPath.lastIndexOf('/');
    // A doc at the vault root has no folder to create.
    if (separator > 0) await this.deps.docs.ensureManagedFolder(docPath.slice(0, separator));
    await this.deps.docs.writeManagedFile(docPath, content);
  }

  #publish(): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener();
      } catch {
        // A failing projection never rolls back a committed project change.
      }
    }
  }

  #enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(id) ?? Promise.resolve()).then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    this.#queues.set(id, barrier);
    void barrier.then(() => {
      if (this.#queues.get(id) === barrier) this.#queues.delete(id);
    });
    return result;
  }
}

export function renderProjectDocTemplate(name: string): string {
  return `# ${name}\n\n## Goal\n\n## Requirements\n\n## Decisions\n\n## State\n\n## Open questions\n\n## Dead ends\n`;
}

function toDocContent(content: string): ProjectDocContent {
  return { content, revision: createHash('sha256').update(content, 'utf8').digest('hex') };
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Project name is required');
  return name;
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, DOC_SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}
