import { type App, Modal, Notice, Setting } from 'obsidian';

import type { ProjectCreateInput, ProjectRecord } from '@/core/types';
import { t } from '@/i18n/i18n';

export interface ProjectEditorOptions {
  /** The project being edited; null creates one. */
  project: ProjectRecord | null;
  /** Persists the input; a rejection keeps the modal open. */
  save(input: ProjectCreateInput): Promise<void>;
  /** Opens the edited project's doc. */
  openDoc?: () => void;
}

/** Edits a project's name and instructions; instructions have no length limit. */
export class ProjectEditorModal extends Modal {
  private nameInput!: HTMLInputElement;
  private instructionsArea!: HTMLTextAreaElement;
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
    // The saved input is captured now, so the fields stay locked until the write settles.
    this.setSaving(true);
    try {
      await this.options.save({ name, instructions: this.instructionsArea.value });
      this.close();
    } catch {
      this.setSaving(false);
      new Notice(this.options.project ? t('chat.projects.errors.update') : t('chat.projects.errors.create'));
    }
  }

  private setSaving(saving: boolean): void {
    this.saving = saving;
    this.nameInput.disabled = saving;
    this.instructionsArea.disabled = saving;
    this.saveButton.disabled = saving;
  }
}
