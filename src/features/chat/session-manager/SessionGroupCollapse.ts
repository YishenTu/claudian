import { Notice } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { isProjectSectionKey } from '@/features/chat/session-manager/SessionListOrganizer';

/**
 * Which groups and sections one session list shows collapsed, by key. Linked content groups and whole sections
 * start expanded; projects use saved expansion when a host is provided. Without a host they start collapsed
 * unless `projectsStartExpanded` (search shows matching projects open without changing saved preferences).
 */
export class SessionGroupCollapse {
  /** Keys toggled away from their default state. */
  readonly #toggled = new Set<string>();

  constructor(private readonly options: {
    projectsStartExpanded?: boolean;
    host?: Pick<ChatFeatureHost, 'settings' | 'mutateSettings'>;
  } = {}) {}

  isCollapsed(groupKey: string): boolean {
    if (this.options.host && isProjectSectionKey(groupKey)) {
      return !expandedProjectIds(this.options.host.settings.expandedProjectIds).includes(groupKey.slice('project:'.length));
    }
    return this.#toggled.has(groupKey) !== this.#startsCollapsed(groupKey);
  }

  setCollapsed(groupKey: string, collapsed: boolean): void {
    if (this.options.host && isProjectSectionKey(groupKey)) {
      const projectId = groupKey.slice('project:'.length);
      void this.options.host.mutateSettings(settings => {
        const ids = new Set(expandedProjectIds(settings.expandedProjectIds));
        if (collapsed) ids.delete(projectId); else ids.add(projectId);
        settings.expandedProjectIds = [...ids];
      }).catch(() => new Notice('Failed to save project folder expansion'));
      return;
    }
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

function expandedProjectIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}
