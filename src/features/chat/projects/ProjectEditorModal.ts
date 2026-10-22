import { type App, Modal, Notice, Setting } from 'obsidian';

import { defaultProjectMemoryPath, normalizeProjectMemoryPath } from '@/core/path/ProjectMemoryPath';
import { type ProjectCreateInput, ProjectMemoryPathTakenError, type ProjectRecord } from '@/core/types';
import { t } from '@/i18n/i18n';

const MEMORY_PATH_ERROR_ID = 'claudian-project-memory-path-error';

export interface ProjectEditorOptions {
  /** The project being edited; null creates one. */
  project: ProjectRecord | null;
  /** Persists the input with a normalized memory path; a rejection keeps the modal open. */
  save(input: ProjectCreateInput): Promise<void>;
  /** Opens the edited project's memory file. */
  openMemory?: () => void;
}

/**
 * Edits a project's name, instructions and memory file path; instructions have no length limit. A new project's
 * path follows the name until the user edits the path.
 */
export class ProjectEditorModal extends Modal {
  private nameInput!: HTMLInputElement;
  private instructionsArea!: HTMLTextAreaElement;
  private memoryPathInput!: HTMLInputElement;
  private memoryPathError!: HTMLElement;
  private memoryPathEdited = false;
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
          .setPlaceholder(t('chat.projects.editor.namePlaceholder'))
          .onChange((name) => {
            if (project || this.memoryPathEdited) return;
            this.memoryPathInput.value = defaultProjectMemoryPath(name);
            this.showMemoryPathError(null);
          });
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

    const memoryPathSetting = new Setting(this.contentEl)
      .setName(t('chat.projects.editor.memoryPath'))
      .setDesc(t('chat.projects.editor.memoryPathDesc'))
      .addText((text) => {
        this.memoryPathInput = text.inputEl;
        text.inputEl.setAttribute('aria-label', t('chat.projects.editor.memoryPath'));
        text
          .setValue(project ? project.memoryPath : defaultProjectMemoryPath(''))
          .setPlaceholder(t('chat.projects.editor.memoryPathPlaceholder'))
          .onChange(() => {
            this.memoryPathEdited = true;
            this.showMemoryPathError(null);
          });
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          void this.save();
        });
      });
    memoryPathSetting.settingEl.addClass('claudian-project-memory-setting');
    const { openMemory } = this.options;
    if (project && openMemory) {
      const openButton = memoryPathSetting.controlEl.createEl('button', {
        cls: 'claudian-project-memory-open',
        text: t('chat.projects.editor.openMemory'),
        attr: { type: 'button' },
      });
      openButton.addEventListener('click', () => {
        this.close();
        openMemory();
      });
    }
    this.memoryPathError = memoryPathSetting.controlEl.createDiv({
      cls: 'claudian-setting-validation claudian-setting-validation-error claudian-hidden',
      attr: { id: MEMORY_PATH_ERROR_ID },
    });

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
    const memoryPath = normalizeProjectMemoryPath(this.memoryPathInput.value);
    if (memoryPath === null) {
      this.showMemoryPathError(t('chat.projects.editor.memoryPathInvalid'));
      this.memoryPathInput.focus();
      return;
    }
    // The saved input is captured now, so the fields stay locked until the write settles.
    this.setSaving(true);
    try {
      await this.options.save({ name, instructions: this.instructionsArea.value, memoryPath });
      this.close();
    } catch (error) {
      this.setSaving(false);
      if (error instanceof ProjectMemoryPathTakenError) {
        this.showMemoryPathError(t('chat.projects.editor.memoryPathTaken', { path: error.path }));
        this.memoryPathInput.focus();
        return;
      }
      new Notice(this.options.project ? t('chat.projects.errors.update') : t('chat.projects.errors.create'));
    }
  }

  /** Shows the message on the memory path field, or clears it with null. */
  private showMemoryPathError(message: string | null): void {
    this.memoryPathError.toggleClass('claudian-hidden', message === null);
    this.memoryPathError.setText(message ?? '');
    if (message !== null) {
      this.memoryPathError.setAttribute('role', 'alert');
      this.memoryPathInput.setAttribute('aria-invalid', 'true');
      this.memoryPathInput.setAttribute('aria-describedby', MEMORY_PATH_ERROR_ID);
    } else {
      this.memoryPathError.removeAttribute('role');
      this.memoryPathInput.removeAttribute('aria-invalid');
      this.memoryPathInput.removeAttribute('aria-describedby');
    }
  }

  private setSaving(saving: boolean): void {
    this.saving = saving;
    this.nameInput.disabled = saving;
    this.instructionsArea.disabled = saving;
    this.memoryPathInput.disabled = saving;
    this.saveButton.disabled = saving;
  }
}
