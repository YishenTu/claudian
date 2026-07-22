import { type App, Modal, Notice, setIcon, Setting } from 'obsidian';

import type { AgentSkillDocument, AgentSkillInput } from '../../core/skills/AgentSkill';
import {
  AgentSkillCollisionError,
  AgentSkillRepositoryError,
  AgentSkillRevisionConflictError,
} from '../../core/skills/AgentSkillRepository';
import {
  AgentSkillValidationError,
  validateAgentSkillInput,
} from '../../core/skills/validateAgentSkill';
import {
  ManagedResourcePathError,
  ManagedResourceRelocationError,
} from '../../core/storage/VaultFileAdapter';
import type {
  AgentSkillManagementCoordinator,
  AgentSkillMutationResult,
} from '../../features/settings/AgentSkillManagementCoordinator';
import { t } from '../../i18n/i18n';

type AgentSkillSaveHandler = (
  input: AgentSkillInput,
) => Promise<AgentSkillMutationResult<AgentSkillDocument>>;

function errorMessage(error: unknown): string {
  if (
    error instanceof AgentSkillRepositoryError
    || error instanceof ManagedResourcePathError
    || error instanceof ManagedResourceRelocationError
  ) {
    return error.message;
  }
  return 'Unexpected storage error';
}

function showSaveError(error: unknown, skillName: string): void {
  if (error instanceof AgentSkillRevisionConflictError) {
    new Notice(t('settings.agentSkills.staleConflict'));
    return;
  }
  if (error instanceof AgentSkillValidationError) {
    new Notice(t('settings.agentSkills.validationFailed', { message: error.message }));
    return;
  }
  if (error instanceof AgentSkillCollisionError) {
    new Notice(t('settings.agentSkills.collisionFailed', { name: skillName }));
    return;
  }
  new Notice(t('settings.agentSkills.saveFailed', { message: errorMessage(error) }));
}

export class AgentSkillModal extends Modal {
  private nameInput!: HTMLInputElement;
  private descriptionInput!: HTMLInputElement;
  private instructionsArea!: HTMLTextAreaElement;
  private triggerSave!: () => Promise<void>;

  constructor(
    app: App,
    private readonly existing: AgentSkillDocument | null,
    private readonly onSave: AgentSkillSaveHandler,
  ) {
    super(app);
  }

  getTestInputs(): {
    nameInput: HTMLInputElement;
    descriptionInput: HTMLInputElement;
    instructionsArea: HTMLTextAreaElement;
    triggerSave: () => Promise<void>;
  } {
    return {
      nameInput: this.nameInput,
      descriptionInput: this.descriptionInput,
      instructionsArea: this.instructionsArea,
      triggerSave: this.triggerSave,
    };
  }

  onOpen(): void {
    this.setTitle(t(this.existing
      ? 'settings.agentSkills.modal.titleEdit'
      : 'settings.agentSkills.modal.titleAdd'));
    this.modalEl.addClass('claudian-agent-skill-modal');

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.name'))
      .setDesc(t('settings.agentSkills.modal.nameDesc'))
      .addText(text => {
        this.nameInput = text.inputEl;
        text
          .setValue(this.existing?.name ?? '')
          .setPlaceholder(t('settings.agentSkills.modal.namePlaceholder'));
      });

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.description'))
      .setDesc(t('settings.agentSkills.modal.descriptionDesc'))
      .addText(text => {
        this.descriptionInput = text.inputEl;
        text
          .setValue(this.existing?.description ?? '')
          .setPlaceholder(t('settings.agentSkills.modal.descriptionPlaceholder'));
      });

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.instructions'))
      .setDesc(t('settings.agentSkills.modal.instructionsDesc'));

    this.instructionsArea = this.contentEl.createEl('textarea', {
      cls: 'claudian-agent-skill-instructions',
      attr: {
        rows: '12',
        placeholder: t('settings.agentSkills.modal.instructionsPlaceholder'),
      },
    });
    this.instructionsArea.value = this.existing?.instructions ?? '';

    this.triggerSave = async (): Promise<void> => {
      const input: AgentSkillInput = {
        name: this.nameInput.value.trim(),
        description: this.descriptionInput.value.trim(),
        instructions: this.instructionsArea.value,
      };
      try {
        validateAgentSkillInput(input);
        const result = await this.onSave(input);
        if (result.refreshFailed) {
          new Notice(t('settings.agentSkills.savedRefreshFailed'));
        } else {
          new Notice(t(this.existing
            ? 'settings.agentSkills.updated'
            : 'settings.agentSkills.created', { name: result.value.name }));
        }
        this.close();
      } catch (error) {
        showSaveError(error, input.name);
      }
    };

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancelButton = actions.createEl('button', {
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelButton.addEventListener('click', () => this.close());
    const saveButton = actions.createEl('button', {
      text: t('common.save'),
      cls: 'claudian-save-btn',
    });
    saveButton.addEventListener('click', () => {
      void this.triggerSave();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class AgentSkillDeleteModal extends Modal {
  private triggerDelete!: () => Promise<void>;

  constructor(
    app: App,
    private readonly skill: AgentSkillDocument,
    private readonly onDelete: () => Promise<AgentSkillMutationResult<void>>,
  ) {
    super(app);
  }

  getTestTrigger(): () => Promise<void> {
    return this.triggerDelete;
  }

  onOpen(): void {
    this.setTitle(t('settings.agentSkills.delete.title'));
    this.contentEl.createEl('p', {
      text: t('settings.agentSkills.delete.description'),
      cls: 'claudian-agent-skill-delete-description',
    });
    this.contentEl.createEl('code', { text: this.skill.directoryPath });

    this.triggerDelete = async (): Promise<void> => {
      try {
        const result = await this.onDelete();
        if (result.refreshFailed) {
          new Notice(t('settings.agentSkills.savedRefreshFailed'));
        } else {
          new Notice(t('settings.agentSkills.deleted', { name: this.skill.name }));
        }
        this.close();
      } catch (error) {
        if (error instanceof AgentSkillRevisionConflictError) {
          new Notice(t('settings.agentSkills.staleConflict'));
          return;
        }
        new Notice(t('settings.agentSkills.deleteFailed', { message: errorMessage(error) }));
      }
    };

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancelButton = actions.createEl('button', {
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelButton.addEventListener('click', () => this.close());
    const deleteButton = actions.createEl('button', {
      text: t('settings.agentSkills.delete.confirm'),
      cls: 'mod-warning',
    });
    deleteButton.addEventListener('click', () => {
      void this.triggerDelete();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class AgentSkillSettings {
  private renderGeneration = 0;
  private readonly rootEl: HTMLDivElement;
  private readonly unsubscribe: () => void;

  constructor(
    containerEl: HTMLElement,
    private readonly coordinator: AgentSkillManagementCoordinator,
    private readonly app: App,
  ) {
    this.rootEl = containerEl.createDiv({ cls: 'claudian-agent-skills-manager' });
    this.unsubscribe = coordinator.subscribe(() => this.render());
    void this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    let result;
    try {
      result = await this.coordinator.list();
    } catch {
      if (generation !== this.renderGeneration) return;
      this.rootEl.empty();
      this.renderHeader();
      this.rootEl.createDiv({
        cls: 'claudian-agent-skills-error',
        text: t('settings.agentSkills.loadFailed'),
      });
      return;
    }
    if (generation !== this.renderGeneration) return;

    this.rootEl.empty();
    this.renderHeader();
    const help = this.rootEl.createDiv({ cls: 'claudian-agent-skills-help' });
    help.createEl('p', { text: t('settings.agentSkills.sharedExpectation') });

    if (result.skills.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-sp-empty-state',
        text: t('settings.agentSkills.noSkills'),
      });
    } else {
      const list = this.rootEl.createDiv({ cls: 'claudian-sp-list' });
      for (const skill of result.skills) {
        this.renderSkill(list, skill);
      }
    }

    if (result.diagnostics.length > 0) {
      const diagnostics = this.rootEl.createDiv({ cls: 'claudian-agent-skills-diagnostics' });
      diagnostics.createDiv({
        cls: 'claudian-agent-skills-diagnostics-title',
        text: t('settings.agentSkills.diagnosticsTitle'),
      });
      for (const diagnostic of result.diagnostics) {
        const item = diagnostics.createDiv({ cls: 'claudian-agent-skills-diagnostic' });
        item.createEl('code', { text: diagnostic.directoryPath });
        item.createSpan({ text: diagnostic.message });
      }
    }
  }

  private renderHeader(): void {
    const header = this.rootEl.createDiv({ cls: 'claudian-sp-header' });
    header.createSpan({ text: t('settings.agentSkills.header'), cls: 'claudian-sp-label' });

    const actions = header.createDiv({ cls: 'claudian-sp-header-actions' });
    const refreshButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshButton, 'refresh-cw');
    refreshButton.addEventListener('click', () => {
      void this.render();
    });
    const addButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addButton, 'plus');
    addButton.addEventListener('click', () => this.openEditModal(null));
  }

  private renderSkill(list: HTMLElement, skill: AgentSkillDocument): void {
    const item = list.createDiv({ cls: 'claudian-sp-item' });
    const info = item.createDiv({ cls: 'claudian-sp-info' });
    const itemHeader = info.createDiv({ cls: 'claudian-sp-item-header' });
    itemHeader.createSpan({ text: skill.name, cls: 'claudian-sp-item-name' });
    itemHeader.createSpan({
      text: t('settings.agentSkills.skillBadge'),
      cls: 'claudian-slash-item-badge',
    });
    info.createDiv({ text: skill.description, cls: 'claudian-sp-item-desc' });

    const actions = item.createDiv({ cls: 'claudian-sp-item-actions' });
    const editButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.edit') },
    });
    setIcon(editButton, 'pencil');
    editButton.addEventListener('click', () => this.openEditModal(skill));
    const deleteButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': t('common.delete') },
    });
    setIcon(deleteButton, 'trash-2');
    deleteButton.addEventListener('click', () => this.openDeleteModal(skill));
  }

  private openEditModal(existing: AgentSkillDocument | null): void {
    const modal = new AgentSkillModal(this.app, existing, input => (
      existing
        ? this.coordinator.update(existing.name, existing.revision, input)
        : this.coordinator.create(input)
    ));
    modal.open();
  }

  private openDeleteModal(skill: AgentSkillDocument): void {
    const modal = new AgentSkillDeleteModal(
      this.app,
      skill,
      () => this.coordinator.trash(skill.name, skill.revision),
    );
    modal.open();
  }
}
