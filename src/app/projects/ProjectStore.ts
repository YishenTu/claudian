import { isValidSessionMetadataId, PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { normalizeProjectMemoryPath } from '@/core/path/ProjectMemoryPath';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ProjectRecord } from '@/core/types';

export type ProjectFileAdapter = Pick<
  VaultFileAdapter,
  'ensureManagedFolder' | 'listManagedFolderEntries' | 'readManagedFile' | 'removeManagedFile' | 'verifyManagedPath' | 'writeManagedFile'
>;

export interface ProjectStoreLoadResult {
  readonly records: ProjectRecord[];
  /** Files skipped because they could not be read or decoded; they are left untouched. */
  readonly invalidCount: number;
}

const RECORD_SUFFIX = '.json';

/**
 * One JSON file per project (`.claudian/projects/<id>.json`), so synced devices never contend
 * over a shared last-writer-wins file. Only records this store decoded are ever written.
 */
export class ProjectStore {
  constructor(private readonly adapter: ProjectFileAdapter) {}

  async load(): Promise<ProjectStoreLoadResult> {
    let files: string[];
    try {
      if (!await this.adapter.verifyManagedPath(PROJECTS_PATH, { expectedType: 'folder', allowMissing: true })) {
        return { records: [], invalidCount: 0 };
      }
      files = (await this.adapter.listManagedFolderEntries(PROJECTS_PATH))
        .filter(entry => entry.type !== 'folder')
        .map(entry => entry.path);
    } catch {
      // Startup continues without projects; nothing is written for records that were not read.
      return { records: [], invalidCount: 1 };
    }
    const records: ProjectRecord[] = [];
    let invalidCount = 0;
    for (const file of files.filter(path => path.endsWith(RECORD_SUFFIX)).sort()) {
      const id = file.slice(file.lastIndexOf('/') + 1, -RECORD_SUFFIX.length);
      const record = await this.#read(file, id);
      if (record) {
        records.push(record);
      } else {
        invalidCount += 1;
      }
    }
    return { records, invalidCount };
  }

  async save(record: ProjectRecord): Promise<void> {
    await this.adapter.ensureManagedFolder(PROJECTS_PATH);
    const persisted: ProjectRecord = {
      id: record.id,
      name: record.name,
      instructions: record.instructions,
      memoryPath: record.memoryPath,
      isPinned: record.isPinned,
      createdAt: record.createdAt,
    };
    await this.adapter.writeManagedFile(this.#path(record.id), `${JSON.stringify(persisted, null, 2)}\n`);
  }

  async remove(id: string): Promise<void> {
    await this.adapter.removeManagedFile(this.#path(id));
  }

  #path(id: string): string {
    if (!isValidSessionMetadataId(id)) throw new Error(`Invalid project id: ${id}`);
    return `${PROJECTS_PATH}/${id}${RECORD_SUFFIX}`;
  }

  async #read(file: string, id: string): Promise<ProjectRecord | null> {
    if (!isValidSessionMetadataId(id)) return null;
    try {
      return decodeProjectRecord(JSON.parse(await this.adapter.readManagedFile(file)), id);
    } catch {
      return null;
    }
  }
}

function decodeProjectRecord(value: unknown, expectedId: string): ProjectRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const memoryPath = typeof raw.memoryPath === 'string' ? normalizeProjectMemoryPath(raw.memoryPath) : null;
  if (
    raw.id !== expectedId
    || typeof raw.name !== 'string'
    || typeof raw.instructions !== 'string'
    || memoryPath === null
    || typeof raw.createdAt !== 'number'
    || !Number.isFinite(raw.createdAt)
  ) {
    return null;
  }
  return {
    id: expectedId,
    name: raw.name,
    instructions: raw.instructions,
    memoryPath,
    isPinned: raw.isPinned === true,
    createdAt: raw.createdAt,
  };
}
