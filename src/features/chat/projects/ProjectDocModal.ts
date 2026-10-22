import { type App, Modal, Notice } from 'obsidian';

import {
  ProjectDocConflictError,
  type ProjectDocContent,
  type ProjectDocOperations,
  type ProjectRecord,
} from '@/core/types';
import { t } from '@/i18n/i18n';

export interface ProjectDocModalOptions {
  project: ProjectRecord;
  docs: ProjectDocOperations;
}

/**
 * Edits the project doc as plain text. Saving compares against the revision last loaded; when the
 * doc changed meanwhile, the user's text stays and they choose Reload or Overwrite.
 */
export class ProjectDocModal extends Modal {
  private contentArea!: HTMLTextAreaElement;
  private noticeEl!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private reloadButton!: HTMLButtonElement;
  private revision: string | null = null;
  private loadGeneration = 0;
  private busy = false;

  constructor(app: App, private readonly options: ProjectDocModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { project } = this.options;
    this.setTitle(t('chat.projects.doc.title', { name: project.name }));
    this.modalEl.addClass('claudian-project-doc-modal');

    const pathRow = this.contentEl.createDiv({ cls: 'claudian-project-doc-path' });
    pathRow.createSpan({ cls: 'claudian-project-doc-path-label', text: t('chat.projects.doc.path') });
    pathRow.createEl('code', { cls: 'claudian-project-doc-path-value', text: project.docPath });
    const copyButton = pathRow.createEl('button', {
      cls: 'claudian-project-doc-copy',
      text: t('chat.projects.doc.copyPath'),
      attr: { type: 'button' },
    });
    copyButton.addEventListener('click', () => {
      void navigator.clipboard.writeText(project.docPath).then(
        () => { new Notice(t('chat.projects.doc.pathCopied')); },
        () => { new Notice(t('chat.projects.doc.copyFailed')); },
      );
    });

    this.noticeEl = this.contentEl.createDiv({ cls: 'claudian-project-doc-notice' });
    this.contentArea = this.contentEl.createEl('textarea', {
      cls: 'claudian-project-doc-content',
      attr: { rows: '20', spellcheck: 'false', 'aria-label': t('chat.projects.doc.content') },
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-project-modal-actions' });
    this.reloadButton = actions.createEl('button', {
      cls: 'claudian-project-doc-reload',
      text: t('chat.projects.doc.reload'),
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
    this.showNotice(t('chat.projects.doc.loading'));
    try {
      const result = await this.options.docs.readDoc(this.options.project.id);
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
      this.showNotice(t('chat.projects.doc.loadFailed'), 'alert');
    }
  }

  private async save(overwrite: boolean): Promise<void> {
    if (this.busy || (!overwrite && this.revision === null)) return;
    // The written text is captured now, so the editor stays locked until the write settles.
    this.setBusy(true);
    this.setEditable(false);
    try {
      await this.options.docs.saveDoc(
        this.options.project.id,
        this.contentArea.value,
        this.revision ?? '',
        overwrite ? { overwrite: true } : undefined,
      );
      new Notice(t('chat.projects.doc.saved'));
      this.close();
    } catch (error) {
      this.setBusy(false);
      this.setEditable(true);
      if (error instanceof ProjectDocConflictError) {
        this.showConflict();
      } else {
        new Notice(t('chat.projects.doc.saveFailed'));
      }
    }
  }

  private async recreate(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      const doc = await this.options.docs.recreateDoc(this.options.project.id);
      this.setBusy(false);
      this.apply(doc);
    } catch {
      this.setBusy(false);
      new Notice(t('chat.projects.doc.saveFailed'));
    }
  }

  /** While a write is in flight, nothing else may reload or write the doc. */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.reloadButton.disabled = busy;
    this.noticeEl.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  private apply(doc: ProjectDocContent): void {
    this.loadGeneration += 1;
    this.revision = doc.revision;
    this.contentArea.value = doc.content;
    this.clearNotice();
    this.setEditable(true);
  }

  private setEditable(editable: boolean): void {
    this.contentArea.disabled = !editable;
    this.saveButton.disabled = !editable;
  }

  private clearNotice(): void {
    this.noticeEl.empty();
    this.noticeEl.removeClass('claudian-project-doc-notice--visible');
  }

  private showNotice(message: string, role: 'status' | 'alert' = 'status'): HTMLElement {
    this.clearNotice();
    this.noticeEl.addClass('claudian-project-doc-notice--visible');
    const messageEl = this.noticeEl.createEl('p', { cls: 'claudian-project-doc-notice-text', text: message });
    messageEl.setAttribute('role', role);
    return this.noticeEl.createDiv({ cls: 'claudian-project-doc-notice-actions' });
  }

  private showMissing(): void {
    const actions = this.showNotice(t('chat.projects.doc.missing'), 'alert');
    const recreateButton = actions.createEl('button', {
      text: t('chat.projects.doc.recreate'),
      attr: { type: 'button' },
    });
    recreateButton.addEventListener('click', () => { void this.recreate(); });
  }

  /** The user's text stays in place; Reload discards it, Overwrite writes it anyway. */
  private showConflict(): void {
    const actions = this.showNotice(t('chat.projects.doc.conflict'), 'alert');
    const overwriteButton = actions.createEl('button', {
      cls: 'mod-warning',
      text: t('chat.projects.doc.overwrite'),
      attr: { type: 'button' },
    });
    overwriteButton.addEventListener('click', () => { void this.save(true); });
  }
}
