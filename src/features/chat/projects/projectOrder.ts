import type { ProjectRecord } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';

/** Where a moved project lands relative to the project it is dropped on. */
export type ProjectPlacement = 'before' | 'after';

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

/** The saved project order, tolerating a hand-edited settings file. */
export function savedProjectOrder(settings: Pick<ChatFeatureHost['settings'], 'projectOrder'>): readonly string[] {
  const value: unknown = settings.projectOrder;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Projects in the user's order, regardless of pin state: projects missing from the saved order (new ones) lead,
 * newest first, followed by the saved order.
 */
export function orderProjects(projects: readonly ProjectRecord[], savedOrder: readonly string[]): ProjectRecord[] {
  const positions = new Map<string, number>();
  savedOrder.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index); });
  const position = (project: ProjectRecord): number => positions.get(project.id) ?? -1;
  return [...projects].sort((left, right) => (
    position(left) - position(right)
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id)
  ));
}

/** Saves the order with `projectId` moved next to `targetId`; the saved order then covers every current project. */
export function moveProject(
  host: Pick<ChatFeatureHost, 'projects' | 'mutateSettings'>,
  projectId: string,
  targetId: string,
  placement: ProjectPlacement,
): Promise<void> {
  return host.mutateSettings((settings) => {
    const ids = orderProjects(host.projects.list(), savedProjectOrder(settings))
      .map(project => project.id)
      .filter(id => id !== projectId);
    const targetIndex = ids.indexOf(targetId);
    if (projectId === targetId || targetIndex < 0 || !host.projects.get(projectId)) return;
    ids.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, projectId);
    settings.projectOrder = ids;
  });
}
