import { createHash, randomUUID } from 'node:crypto';

import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { normalizeProjectMemoryPath, projectMemoryFolderOf } from '@/core/path/ProjectMemoryPath';
import { ManagedResourceCollisionError, type VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  type ProjectCreateInput,
  ProjectMemoryConflictError,
  type ProjectMemoryContent,
  type ProjectMemoryOperations,
  ProjectMemoryPathTakenError,
  type ProjectMemoryReadResult,
  type ProjectMemorySaveOptions,
  type ProjectMutations,
  type ProjectReader,
  type ProjectRecord,
  type ProjectUpdatePatch,
} from '@/core/types';

import type { ProjectStore } from './ProjectStore';

export interface ProjectServiceDeps {
  readonly store: Pick<ProjectStore, 'save' | 'remove'>;
  readonly memory: Pick<
    VaultFileAdapter,
    | 'ensureManagedFolder'
    | 'moveManagedFileNoReplace'
    | 'readManagedFile'
    | 'removeManagedFile'
    | 'removeManagedFolderIfEmpty'
    | 'stat'
    | 'trash'
    | 'verifyManagedPath'
    | 'writeManagedFile'
  >;
}

/**
 * Sole owner of project records and their memory files. Record and memory writes serialize per project;
 * membership stays on each conversation and is written through the conversation owner.
 */
export class ProjectService implements ProjectReader, ProjectMutations, ProjectMemoryOperations {
  readonly #records = new Map<string, ProjectRecord>();
  readonly #listeners = new Set<() => void>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(records: readonly ProjectRecord[], private readonly deps: ProjectServiceDeps) {
    for (const record of records) this.#records.set(record.id, record);
  }

  list(): readonly ProjectRecord[] {
    return Array.from(this.#records.values());
  }

  get(id: string | undefined): ProjectRecord | null {
    return id === undefined ? null : this.#records.get(id) ?? null;
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async create(input: ProjectCreateInput): Promise<ProjectRecord> {
    const name = requireName(input.name);
    const id = randomUUID();
    const record: ProjectRecord = {
      id,
      name,
      instructions: input.instructions,
      memoryPath: requireMemoryPath(input.memoryPath),
      isPinned: false,
      createdAt: Date.now(),
    };
    return this.#enqueue(id, async () => {
      if (this.#isClaimed(record.memoryPath, id)) throw new ProjectMemoryPathTakenError(record.memoryPath);
      if (!await this.#createMemory(record.memoryPath, renderProjectMemoryTemplate(name))) {
        throw new ProjectMemoryPathTakenError(record.memoryPath);
      }
      try {
        await this.deps.store.save(record);
      } catch (error) {
        // Best effort: the file is this attempt's own, and leaving it would block a retry at the same path.
        await this.deps.memory.removeManagedFile(record.memoryPath).catch(() => undefined);
        throw error;
      }
      this.#records.set(id, record);
      this.#publish();
      return record;
    });
  }

  async update(id: string, patch: ProjectUpdatePatch): Promise<void> {
    const name = patch.name !== undefined ? requireName(patch.name) : undefined;
    const requestedPath = patch.memoryPath !== undefined ? requireMemoryPath(patch.memoryPath) : undefined;
    return this.#enqueue(id, async () => {
      const record = this.#records.get(id);
      if (!record) return;
      const updated: ProjectRecord = {
        ...record,
        ...(name !== undefined ? { name } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
        ...(requestedPath !== undefined ? { memoryPath: requestedPath } : {}),
      };
      if (
        updated.name === record.name
        && updated.instructions === record.instructions
        && updated.memoryPath === record.memoryPath
      ) {
        return;
      }
      if (updated.memoryPath !== record.memoryPath && this.#isClaimed(updated.memoryPath, id)) {
        throw new ProjectMemoryPathTakenError(updated.memoryPath);
      }
      const moved = updated.memoryPath !== record.memoryPath
        && await this.#moveMemory(record.memoryPath, updated.memoryPath);
      try {
        await this.deps.store.save(updated);
      } catch (error) {
        // Best effort: put the memory file back so the recorded path still finds it.
        if (moved) {
          await this.deps.memory.moveManagedFileNoReplace(updated.memoryPath, record.memoryPath).catch(() => undefined);
        }
        throw error;
      }
      this.#records.set(id, updated);
      this.#publish();
    });
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.#commit(id, record => (record.isPinned === pinned ? record : { ...record, isPinned: pinned }));
  }

  /**
   * Removes the record, then moves its memory file to the trash and removes its folder inside the projects folder
   * once empty. Member ids stay on their conversations until cleared; readers resolve them through `get`, so they
   * already count as no project.
   */
  delete(id: string): Promise<void> {
    return this.#enqueue(id, async () => {
      const record = this.#records.get(id);
      if (!record) return;
      await this.deps.store.remove(id);
      this.#records.delete(id);
      this.#publish();
      // Another live project may still record the same file, as overlapping records from an earlier version or a
      // synced device can; it keeps the file.
      if (this.#isClaimed(record.memoryPath, id)) return;
      // Best effort: the project is gone either way, and a leftover file blocks nothing.
      try {
        await this.deps.memory.trash(record.memoryPath);
        const folder = projectMemoryFolderOf(record.memoryPath);
        if (folder.startsWith(`${PROJECTS_PATH}/`)) await this.deps.memory.removeManagedFolderIfEmpty(folder);
      } catch {
        // Kept in place.
      }
    });
  }

  async readMemory(id: string): Promise<ProjectMemoryReadResult> {
    return this.#readMemory(this.#require(id).memoryPath);
  }

  saveMemory(
    id: string,
    content: string,
    expectedRevision: string,
    options: ProjectMemorySaveOptions = {},
  ): Promise<ProjectMemoryContent> {
    return this.#enqueue(id, async () => {
      const { memoryPath } = this.#require(id);
      if (!options.overwrite) {
        const current = await this.#readMemory(memoryPath);
        if ('missing' in current || current.revision !== expectedRevision) {
          throw new ProjectMemoryConflictError(id);
        }
      }
      await this.#ensureFolderOf(memoryPath);
      await this.deps.memory.writeManagedFile(memoryPath, content);
      return this.#snapshot(memoryPath, content);
    });
  }

  recreateMemory(id: string): Promise<ProjectMemoryContent> {
    return this.#enqueue(id, async () => {
      const record = this.#require(id);
      const content = renderProjectMemoryTemplate(record.name);
      // The file may have reappeared (sync, undo) since it was reported missing; never replace it.
      if (await this.#createMemory(record.memoryPath, content)) return this.#snapshot(record.memoryPath, content);
      const current = await this.#readMemory(record.memoryPath);
      if ('missing' in current) throw new Error(`Could not recreate project memory: ${record.memoryPath}`);
      return current;
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

  /**
   * Whether another live project records this memory path. Its file may be missing, but recreating it there would
   * give two projects one file. Paths compare case-insensitively, as they name one file on most vaults.
   */
  #isClaimed(memoryPath: string, exceptId: string): boolean {
    const path = memoryPath.toLowerCase();
    for (const record of this.#records.values()) {
      if (record.id !== exceptId && record.memoryPath.toLowerCase() === path) return true;
    }
    return false;
  }

  #require(id: string): ProjectRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Unknown project: ${id}`);
    return record;
  }

  /**
   * Writes a new memory file, creating its folders, and reports false when a file is already at the path. The content
   * goes to a hidden sibling first and is moved without replacing, so a racing writer's file is never overwritten.
   */
  async #createMemory(memoryPath: string, content: string): Promise<boolean> {
    if (await this.#memoryExists(memoryPath)) return false;
    const folder = await this.#ensureFolderOf(memoryPath);
    const fileName = memoryPath.slice(folder ? folder.length + 1 : 0);
    const temp = `${folder ? `${folder}/` : ''}.${fileName}.${randomUUID()}.tmp`;
    await this.deps.memory.writeManagedFile(temp, content);
    try {
      await this.deps.memory.moveManagedFileNoReplace(temp, memoryPath);
      return true;
    } catch (error) {
      if (error instanceof ManagedResourceCollisionError) return false;
      throw error;
    } finally {
      // A no-op once the move succeeded.
      await this.deps.memory.removeManagedFile(temp).catch(() => undefined);
    }
  }

  /** Moves the memory file when it exists and reports whether it did; a missing file is only repointed. */
  async #moveMemory(source: string, target: string): Promise<boolean> {
    if (await this.#memoryExists(target)) throw new ProjectMemoryPathTakenError(target);
    if (!await this.#memoryExists(source)) return false;
    await this.#ensureFolderOf(target);
    try {
      await this.deps.memory.moveManagedFileNoReplace(source, target);
    } catch (error) {
      if (error instanceof ManagedResourceCollisionError) throw new ProjectMemoryPathTakenError(target, { cause: error });
      throw error;
    }
    return true;
  }

  #memoryExists(memoryPath: string): Promise<boolean> {
    return this.deps.memory.verifyManagedPath(memoryPath, { expectedType: 'file', allowMissing: true });
  }

  /** Creates the folder holding the memory file and returns it; `''` at the vault root, which needs none. */
  async #ensureFolderOf(memoryPath: string): Promise<string> {
    const folder = projectMemoryFolderOf(memoryPath);
    if (folder) await this.deps.memory.ensureManagedFolder(folder);
    return folder;
  }

  async #readMemory(memoryPath: string): Promise<ProjectMemoryReadResult> {
    if (!await this.#memoryExists(memoryPath)) return { missing: true };
    return this.#snapshot(memoryPath, await this.deps.memory.readManagedFile(memoryPath));
  }

  async #snapshot(memoryPath: string, content: string): Promise<ProjectMemoryContent> {
    const stat = await this.deps.memory.stat(memoryPath);
    return {
      content,
      revision: createHash('sha256').update(content, 'utf8').digest('hex'),
      modifiedAt: stat?.mtime ?? null,
    };
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

export function renderProjectMemoryTemplate(name: string): string {
  return `# ${name}\n\n## Goal\n\n## Requirements\n\n## Decisions\n\n## State\n\n## Open questions\n\n## Dead ends\n`;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Project name is required');
  return name;
}

function requireMemoryPath(value: string): string {
  const memoryPath = normalizeProjectMemoryPath(value);
  if (memoryPath === null) throw new Error(`Invalid project memory path: ${JSON.stringify(value)}`);
  return memoryPath;
}
