import type { ProjectRecord } from '@/core/types';

/** Natural, case-insensitive project name order shared by project lists and menus. */
export function compareProjectNames(left: Pick<ProjectRecord, 'name'>, right: Pick<ProjectRecord, 'name'>): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
}

/** Order of project pickers: pinned projects first, then by name. */
export function compareProjectsForPicker(
  left: Pick<ProjectRecord, 'name' | 'isPinned'>,
  right: Pick<ProjectRecord, 'name' | 'isPinned'>,
): number {
  return Number(right.isPinned) - Number(left.isPinned) || compareProjectNames(left, right);
}
