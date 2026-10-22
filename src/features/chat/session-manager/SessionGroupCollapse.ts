import { isProjectSectionKey } from '@/features/chat/session-manager/SessionListOrganizer';

/**
 * Which groups and sections one session list shows collapsed, by key. Linked content groups and whole sections
 * start expanded; projects start collapsed unless `projectsStartExpanded` (search shows matching projects open).
 */
export class SessionGroupCollapse {
  /** Keys toggled away from their default state. */
  readonly #toggled = new Set<string>();

  constructor(private readonly options: { projectsStartExpanded?: boolean } = {}) {}

  isCollapsed(groupKey: string): boolean {
    return this.#toggled.has(groupKey) !== this.#startsCollapsed(groupKey);
  }

  setCollapsed(groupKey: string, collapsed: boolean): void {
    if (collapsed !== this.#startsCollapsed(groupKey)) {
      this.#toggled.add(groupKey);
    } else {
      this.#toggled.delete(groupKey);
    }
  }

  #startsCollapsed(groupKey: string): boolean {
    return !this.options.projectsStartExpanded && isProjectSectionKey(groupKey);
  }
}
