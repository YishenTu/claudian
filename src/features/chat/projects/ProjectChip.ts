import { Menu } from 'obsidian';

import type { ProjectReader } from '@/core/types';
import type { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import { compareProjectsForPicker } from '@/features/chat/projects/projectOrder';
import { t } from '@/i18n/i18n';

export interface ProjectChipDeps {
  projects: Pick<ProjectReader, 'get' | 'list'>;
  /** The session's conversation or blank draft, which owns what the chip shows and what choosing does. */
  conversation: Pick<ConversationController, 'project' | 'selectProject'>;
}

/**
 * The project in the composer info row, beside Linked content, shown only for a live project. A blank draft's chip
 * is a selector between the live projects and No project; a started session's chip is a fixed label. Membership of
 * a started session changes from the session lists.
 */
export class ProjectChip {
  constructor(
    private readonly infoRow: ComposerInfoRow,
    private readonly deps: ProjectChipDeps,
  ) {}

  /** Re-reads membership, the draft seed and its freeze, and the project record; callers refresh after any changes. */
  refresh(): void {
    const { projectId, isDraft, changeable } = this.deps.conversation.project;
    const project = this.deps.projects.get(projectId);
    if (!project) {
      this.infoRow.setProject(null);
      return;
    }
    const label = project.name;
    this.infoRow.setProject({
      label,
      // Obsidian aliases the legacy `folder` id to an open folder.
      icon: 'lucide-folder',
      ariaLabel: t('chat.projects.chipLabel', { name: label }),
      ...(isDraft ? { hasPopup: 'menu' as const } : {}),
      // A started session's chip is fixed; a draft's is fixed only while its first turn creates the session.
      disabled: !changeable,
      onActivate: anchorEl => this.showMenu(anchorEl, project.id),
    });
  }

  destroy(): void {
    this.infoRow.setProject(null);
  }

  private showMenu(anchorEl: HTMLElement, currentProjectId: string): void {
    const { conversation } = this.deps;
    const projects = [...this.deps.projects.list()].sort(compareProjectsForPicker);
    const menu = new Menu().setUseNativeMenu(false);
    for (const project of projects) {
      menu.addItem((item) => {
        item.setTitle(project.name);
        if (project.id === currentProjectId) item.setChecked(true);
        item.onClick(() => conversation.selectProject(project.id));
      });
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle(t('chat.projects.noProject'));
      item.onClick(() => conversation.selectProject(null));
    });
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchorEl.ownerDocument);
  }
}
