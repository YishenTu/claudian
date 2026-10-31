import { testDate } from '@test/helpers/testClock';

import type { ProjectMemoryOperations, ProjectMutations, ProjectReader, ProjectRecord } from '@/core/types';

export function projectRecord(overrides: Partial<ProjectRecord> & Pick<ProjectRecord, 'id'>): ProjectRecord {
  return {
    name: `Project ${overrides.id}`,
    instructions: `Instructions for ${overrides.id}`,
    memoryPath: `.claudian/projects/${overrides.id}.md`,
    isPinned: false,
    isArchived: false,
    createdAt: testDate().getTime(),
    ...overrides,
  };
}

/** Live project records behind the reader port; tests edit and delete them between turns. */
export function createProjectsFake(records: readonly ProjectRecord[] = []): ProjectReader & ProjectMutations & ProjectMemoryOperations & {
  put(record: ProjectRecord): void;
  remove(id: string): void;
} {
  const live = new Map(records.map(record => [record.id, record]));
  const unsupportedOperation = (): never => {
    throw new Error('This project fixture supports record reads; use the real project store for mutations or memory.');
  };
  return {
    create: unsupportedOperation,
    update: unsupportedOperation,
    setPinned: unsupportedOperation,
    setArchived: unsupportedOperation,
    delete: unsupportedOperation,
    readMemory: unsupportedOperation,
    saveMemory: unsupportedOperation,
    recreateMemory: unsupportedOperation,
    list: () => [...live.values()],
    get: id => (id === undefined ? null : live.get(id) ?? null),
    onChanged: () => () => undefined,
    put: record => { live.set(record.id, record); },
    remove: id => { live.delete(id); },
  };
}
