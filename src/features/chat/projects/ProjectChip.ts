import { Menu } from 'obsidian';

import type { ProjectReader } from '@/core/types';
import type { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import { compareProjectNames } from '@/features/chat/projects/projectOrder';
import { t } from '@/i18n/i18n';

export interface ProjectChipDeps {
  projects: Pick<ProjectReader, 'get' | 'list'>;
  /** The session's conversation or blank draft, which owns what the chip shows and what choosing does. */
  conversation: Pick<ConversationController, 'project' | 'selectProject'>;
}

/**
 * Presents the conversation's live project in the composer info row, beside Linked content. The chip opens a
 * menu to switch the project or leave it.
 */
export class ProjectChip {
  constructor(
    private readonly infoRow: ComposerInfoRow,
    private readonly deps: ProjectChipDeps,
  ) {}

  /** Re-reads membership, the draft seed and its freeze, and the project record; callers refresh after any changes. */
  refresh(): void {
    const { projectId, changeable } = this.deps.conversation.project;
    const project = this.deps.projects.get(projectId);
    if (!project) {
      this.infoRow.setProject(null);
      return;
    }
    this.infoRow.setProject({
      label: project.name,
      // Obsidian aliases the legacy `folder` id to an open folder.
      icon: 'lucide-folder',
      ariaLabel: t('chat.projects.chipLabel', { name: project.name }),
      hasPopup: 'menu',
      disabled: !changeable,
      onActivate: anchorEl => this.showMenu(anchorEl, project.id),
    });
  }

  destroy(): void {
    this.infoRow.setProject(null);
  }

  private showMenu(anchorEl: HTMLElement, currentProjectId: string): void {
    const projects = [...this.deps.projects.list()].sort((left, right) => (
      Number(right.isPinned) - Number(left.isPinned) || compareProjectNames(left, right)
    ));
    const menu = new Menu().setUseNativeMenu(false);
    for (const project of projects) {
      menu.addItem((item) => {
        item.setTitle(project.name);
        if (project.id === currentProjectId) item.setChecked(true);
        item.onClick(() => this.deps.conversation.selectProject(project.id));
      });
    }
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle(t('chat.projects.noProject'))
      .onClick(() => this.deps.conversation.selectProject(null)));
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchorEl.ownerDocument);
  }
}
