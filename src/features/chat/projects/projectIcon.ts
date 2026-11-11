import type { ProjectRecord } from '@/core/types';

/** Obsidian aliases the legacy `folder` id to an open folder; explicit Lucide ids keep the states distinct. */
export const DEFAULT_PROJECT_ICON = 'lucide-folder';
const DEFAULT_PROJECT_OPEN_ICON = 'lucide-folder-open';
const LUCIDE_PREFIX = 'lucide-';

/** The icon drawn for a project; only the default folder opens with its group, a chosen icon stays as chosen. */
export function projectIconId(project: Pick<ProjectRecord, 'icon'>, expanded = false): string {
  if (project.icon) return project.icon;
  return expanded ? DEFAULT_PROJECT_OPEN_ICON : DEFAULT_PROJECT_ICON;
}

/** The name shown for an icon id: Lucide ids without their prefix. */
export function projectIconLabel(iconId: string): string {
  return iconId.startsWith(LUCIDE_PREFIX) ? iconId.slice(LUCIDE_PREFIX.length) : iconId;
}
