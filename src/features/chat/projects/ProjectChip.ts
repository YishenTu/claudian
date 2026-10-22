import { Menu } from 'obsidian';

import type { ProjectReader } from '@/core/types';
import type { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import { resolveLiveProject } from '@/features/chat/execution/projectInstructions';
import { t } from '@/i18n/i18n';

export interface ProjectChipDeps {
  projects: Pick<ProjectReader, 'get' | 'list'>;
  /**
   * The raw project id of the shown conversation, or of the blank draft's seed, and whether it can change now:
   * first-turn admission freezes the seed while creation is pending.
   */
  getProjectId: () => { projectId: string | undefined; changeable: boolean };
  /** Moves the conversation, or the draft's seed, into a project or out of any with null. */
  selectProject: (projectId: string | null) => void;
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
    const { projectId, changeable } = this.deps.getProjectId();
    const project = resolveLiveProject(this.deps.projects, projectId);
    if (!project) {
      this.infoRow.setProject(null);
      return;
    }
    this.infoRow.setProject({
      label: project.name,
      icon: 'folder',
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
      Number(right.isPinned) - Number(left.isPinned)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
    ));
    const menu = new Menu().setUseNativeMenu(false);
    for (const project of projects) {
      menu.addItem((item) => {
        item.setTitle(project.name);
        if (project.id === currentProjectId) item.setChecked(true);
        item.onClick(() => this.deps.selectProject(project.id));
      });
    }
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle(t('chat.projects.noProject'))
      .onClick(() => this.deps.selectProject(null)));
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchorEl.ownerDocument);
  }
}
