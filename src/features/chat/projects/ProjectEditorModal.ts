import { type App, Modal, Notice, Setting } from 'obsidian';

import {
  DEFAULT_PROJECT_DOC_FOLDER,
  normalizeProjectDocFolder,
  projectDocFolderOf,
} from '@/core/path/ProjectDocFolder';
import { type ProjectCreateInput, ProjectDocMoveConflictError, type ProjectRecord } from '@/core/types';
import { t } from '@/i18n/i18n';

const DOC_FOLDER_ERROR_ID = 'claudian-project-doc-folder-error';

export interface ProjectEditorOptions {
  /** The project being edited; null creates one. */
  project: ProjectRecord | null;
  /** Persists the input with a normalized doc folder; a rejection keeps the modal open. */
  save(input: ProjectCreateInput): Promise<void>;
  /** Opens the edited project's doc. */
  openDoc?: () => void;
}

/** Edits a project's name, instructions and doc folder; instructions have no length limit. */
export class ProjectEditorModal extends Modal {
  private nameInput!: HTMLInputElement;
  private instructionsArea!: HTMLTextAreaElement;
  private docFolderInput!: HTMLInputElement;
  private docFolderError!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private saving = false;

  constructor(app: App, private readonly options: ProjectEditorOptions) {
    super(app);
  }

  onOpen(): void {
    const { project } = this.options;
    this.setTitle(project ? t('chat.projects.editor.titleEdit') : t('chat.projects.editor.titleNew'));
    this.modalEl.addClass('claudian-project-modal');

    new Setting(this.contentEl)
      .setName(t('chat.projects.editor.name'))
      .setDesc(t('chat.projects.editor.nameDesc'))
      .addText((text) => {
        this.nameInput = text.inputEl;
        text.inputEl.setAttribute('aria-label', t('chat.projects.editor.name'));
        text
          .setValue(project?.name ?? '')
          .setPlaceholder(t('chat.projects.editor.namePlaceholder'));
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          void this.save();
        });
      });

    new Setting(this.contentEl)
      .setName(t('chat.projects.editor.instructions'))
      .setDesc(t('chat.projects.editor.instructionsDesc'));
    this.instructionsArea = this.contentEl.createEl('textarea', {
      cls: 'claudian-project-instructions',
      attr: { rows: '10', 'aria-label': t('chat.projects.editor.instructions') },
    });
    this.instructionsArea.value = project?.instructions ?? '';

    const docFolderSetting = new Setting(this.contentEl)
      .setName(t('chat.projects.editor.docFolder'))
      .setDesc(t('chat.projects.editor.docFolderDesc'))
      .addText((text) => {
        this.docFolderInput = text.inputEl;
        text.inputEl.setAttribute('aria-label', t('chat.projects.editor.docFolder'));
        text
          .setValue(project ? projectDocFolderOf(project.docPath) : DEFAULT_PROJECT_DOC_FOLDER)
          .setPlaceholder(t('chat.projects.editor.docFolderPlaceholder'))
          .onChange(() => this.showDocFolderError(false));
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          void this.save();
        });
      });
    this.docFolderError = docFolderSetting.controlEl.createDiv({
      cls: 'claudian-setting-validation claudian-setting-validation-error claudian-hidden',
      text: t('chat.projects.editor.docFolderInvalid'),
      attr: { id: DOC_FOLDER_ERROR_ID },
    });

    const { openDoc } = this.options;
    if (project && openDoc) {
      const docRow = this.contentEl.createDiv({ cls: 'claudian-project-doc-row' });
      docRow.createSpan({ cls: 'claudian-project-doc-row-label', text: t('chat.projects.editor.docPath') });
      docRow.createEl('code', { cls: 'claudian-project-doc-row-path', text: project.docPath });
      const openButton = docRow.createEl('button', {
        cls: 'claudian-project-doc-row-open',
        text: t('chat.projects.editor.openDoc'),
        attr: { type: 'button' },
      });
      openButton.addEventListener('click', () => {
        this.close();
        openDoc();
      });
    }

    const actions = this.contentEl.createDiv({ cls: 'claudian-project-modal-actions' });
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
    this.saveButton.addEventListener('click', () => { void this.save(); });
    this.nameInput.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    const name = this.nameInput.value.trim();
    if (!name) {
      new Notice(t('chat.projects.editor.nameRequired'));
      this.nameInput.focus();
      return;
    }
    const docFolder = normalizeProjectDocFolder(this.docFolderInput.value);
    if (docFolder === null) {
      this.showDocFolderError(true);
      this.docFolderInput.focus();
      return;
    }
    // The saved input is captured now, so the fields stay locked until the write settles.
    this.setSaving(true);
    try {
      await this.options.save({ name, instructions: this.instructionsArea.value, docFolder });
      this.close();
    } catch (error) {
      this.setSaving(false);
      if (error instanceof ProjectDocMoveConflictError) {
        new Notice(t('chat.projects.errors.docMoveConflict', { path: error.targetPath }));
        return;
      }
      new Notice(this.options.project ? t('chat.projects.errors.update') : t('chat.projects.errors.create'));
    }
  }

  private showDocFolderError(visible: boolean): void {
    this.docFolderError.toggleClass('claudian-hidden', !visible);
    if (visible) {
      this.docFolderError.setAttribute('role', 'alert');
      this.docFolderInput.setAttribute('aria-invalid', 'true');
      this.docFolderInput.setAttribute('aria-describedby', DOC_FOLDER_ERROR_ID);
    } else {
      this.docFolderError.removeAttribute('role');
      this.docFolderInput.removeAttribute('aria-invalid');
      this.docFolderInput.removeAttribute('aria-describedby');
    }
  }

  private setSaving(saving: boolean): void {
    this.saving = saving;
    this.nameInput.disabled = saving;
    this.instructionsArea.disabled = saving;
    this.docFolderInput.disabled = saving;
    this.saveButton.disabled = saving;
  }
}
