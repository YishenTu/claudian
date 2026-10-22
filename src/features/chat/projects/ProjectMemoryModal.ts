import { type App, Modal, Notice } from 'obsidian';

import {
  ProjectMemoryConflictError,
  type ProjectMemoryContent,
  type ProjectMemoryOperations,
  type ProjectRecord,
} from '@/core/types';
import { t } from '@/i18n/i18n';

export interface ProjectMemoryModalOptions {
  project: ProjectRecord;
  memory: ProjectMemoryOperations;
}

/**
 * Edits the project memory file as plain text. Saving compares against the revision last loaded; when the
 * file changed meanwhile, the user's text stays and they choose Reload or Overwrite.
 */
export class ProjectMemoryModal extends Modal {
  private contentArea!: HTMLTextAreaElement;
  private noticeEl!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private reloadButton!: HTMLButtonElement;
  private revision: string | null = null;
  private loadGeneration = 0;
  private busy = false;

  constructor(app: App, private readonly options: ProjectMemoryModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { project } = this.options;
    this.setTitle(t('chat.projects.memory.title', { name: project.name }));
    this.modalEl.addClass('claudian-project-memory-modal');

    const pathRow = this.contentEl.createDiv({ cls: 'claudian-project-memory-path' });
    pathRow.createSpan({ cls: 'claudian-project-memory-path-label', text: t('chat.projects.memory.path') });
    pathRow.createEl('code', { cls: 'claudian-project-memory-path-value', text: project.memoryPath });
    const copyButton = pathRow.createEl('button', {
      cls: 'claudian-project-memory-copy',
      text: t('chat.projects.memory.copyPath'),
      attr: { type: 'button' },
    });
    copyButton.addEventListener('click', () => {
      void navigator.clipboard.writeText(project.memoryPath).then(
        () => { new Notice(t('chat.projects.memory.pathCopied')); },
        () => { new Notice(t('chat.projects.memory.copyFailed')); },
      );
    });

    this.noticeEl = this.contentEl.createDiv({ cls: 'claudian-project-memory-notice' });
    this.contentArea = this.contentEl.createEl('textarea', {
      cls: 'claudian-project-memory-content',
      attr: { rows: '20', spellcheck: 'false', 'aria-label': t('chat.projects.memory.content') },
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-project-modal-actions' });
    this.reloadButton = actions.createEl('button', {
      cls: 'claudian-project-memory-reload',
      text: t('chat.projects.memory.reload'),
      attr: { type: 'button' },
    });
    this.reloadButton.addEventListener('click', () => { void this.load(); });
    const cancelButton = actions.createEl('button', {
      cls: 'claudian-cancel-btn',
      text: t('common.cancel'),
      attr: { type: 'button' },
    });
    cancelButton.addEventListener('click', () => this.close());
    this.saveButton = actions.createEl('button', {
      cls: 'claudian-save-btn mod-cta',
      text: t('common.save'),
      attr: { type: 'button' },
    });
    this.saveButton.addEventListener('click', () => { void this.save(false); });

    void this.load();
  }

  onClose(): void {
    this.loadGeneration += 1;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.setEditable(false);
    this.showNotice(t('chat.projects.memory.loading'));
    try {
      const result = await this.options.memory.readMemory(this.options.project.id);
      if (generation !== this.loadGeneration) return;
      if ('missing' in result) {
        this.revision = null;
        this.contentArea.value = '';
        this.showMissing();
        return;
      }
      this.apply(result);
    } catch {
      if (generation !== this.loadGeneration) return;
      this.showNotice(t('chat.projects.memory.loadFailed'), 'alert');
    }
  }

  private async save(overwrite: boolean): Promise<void> {
    if (this.busy || (!overwrite && this.revision === null)) return;
    // The written text is captured now, so the editor stays locked until the write settles.
    this.setBusy(true);
    this.setEditable(false);
    try {
      await this.options.memory.saveMemory(
        this.options.project.id,
        this.contentArea.value,
        this.revision ?? '',
        overwrite ? { overwrite: true } : undefined,
      );
      new Notice(t('chat.projects.memory.saved'));
      this.close();
    } catch (error) {
      this.setBusy(false);
      this.setEditable(true);
      if (error instanceof ProjectMemoryConflictError) {
        this.showConflict();
      } else {
        new Notice(t('chat.projects.memory.saveFailed'));
      }
    }
  }

  private async recreate(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      const memory = await this.options.memory.recreateMemory(this.options.project.id);
      this.setBusy(false);
      this.apply(memory);
    } catch {
      this.setBusy(false);
      new Notice(t('chat.projects.memory.saveFailed'));
    }
  }

  /** While a write is in flight, nothing else may reload or write the memory file. */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.reloadButton.disabled = busy;
    this.noticeEl.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  private apply(memory: ProjectMemoryContent): void {
    this.loadGeneration += 1;
    this.revision = memory.revision;
    this.contentArea.value = memory.content;
    this.clearNotice();
    this.setEditable(true);
  }

  private setEditable(editable: boolean): void {
    this.contentArea.disabled = !editable;
    this.saveButton.disabled = !editable;
  }

  private clearNotice(): void {
    this.noticeEl.empty();
    this.noticeEl.removeClass('claudian-project-memory-notice--visible');
  }

  private showNotice(message: string, role: 'status' | 'alert' = 'status'): HTMLElement {
    this.clearNotice();
    this.noticeEl.addClass('claudian-project-memory-notice--visible');
    const messageEl = this.noticeEl.createEl('p', { cls: 'claudian-project-memory-notice-text', text: message });
    messageEl.setAttribute('role', role);
    return this.noticeEl.createDiv({ cls: 'claudian-project-memory-notice-actions' });
  }

  private showMissing(): void {
    const actions = this.showNotice(t('chat.projects.memory.missing'), 'alert');
    const recreateButton = actions.createEl('button', {
      text: t('chat.projects.memory.recreate'),
      attr: { type: 'button' },
    });
    recreateButton.addEventListener('click', () => { void this.recreate(); });
  }

  /** The user's text stays in place; Reload discards it, Overwrite writes it anyway. */
  private showConflict(): void {
    const actions = this.showNotice(t('chat.projects.memory.conflict'), 'alert');
    const overwriteButton = actions.createEl('button', {
      cls: 'mod-warning',
      text: t('chat.projects.memory.overwrite'),
      attr: { type: 'button' },
    });
    overwriteButton.addEventListener('click', () => { void this.save(true); });
  }
}
