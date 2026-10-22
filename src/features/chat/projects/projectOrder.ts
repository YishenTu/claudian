import type { ProjectRecord } from '@/core/types';

/** Natural, case-insensitive project name order shared by project lists and menus. */
export function compareProjectNames(left: Pick<ProjectRecord, 'name'>, right: Pick<ProjectRecord, 'name'>): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
}
