import type { ProjectRecord } from '@/core/types';

/** Natural, case-insensitive project name order shared by project lists and menus. */
export function compareProjectNames(left: Pick<ProjectRecord, 'name'>, right: Pick<ProjectRecord, 'name'>): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
}

/** Projects a session can join from a picker: unarchived ones, pinned first, then by name. */
export function projectsForPicker(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return projects
    .filter(project => !project.isArchived)
    .sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || compareProjectNames(left, right));
}
