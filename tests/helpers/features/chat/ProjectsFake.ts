import { testDate } from '@test/helpers/testClock';

import type { ProjectReader, ProjectRecord } from '@/core/types';

export function projectRecord(overrides: Partial<ProjectRecord> & Pick<ProjectRecord, 'id'>): ProjectRecord {
  return {
    name: `Project ${overrides.id}`,
    instructions: `Instructions for ${overrides.id}`,
    memoryPath: `.claudian/projects/${overrides.id}.md`,
    isPinned: false,
    createdAt: testDate().getTime(),
    ...overrides,
  };
}

/** Live project records behind the reader port; tests edit and delete them between turns. */
export function createProjectsFake(records: readonly ProjectRecord[] = []): ProjectReader & {
  put(record: ProjectRecord): void;
  remove(id: string): void;
} {
  const live = new Map(records.map(record => [record.id, record]));
  return {
    list: () => [...live.values()],
    get: id => live.get(id) ?? null,
    onChanged: () => () => undefined,
    put: record => { live.set(record.id, record); },
    remove: id => { live.delete(id); },
  };
}
