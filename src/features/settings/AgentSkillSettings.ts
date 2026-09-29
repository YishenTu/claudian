import { type App, Modal, Notice, setIcon, Setting } from 'obsidian';

import type { AgentSkillDiagnostic, AgentSkillDocument, AgentSkillInput } from '../../core/skills/AgentSkill';
import { extraFrontmatterKeys } from '../../core/skills/AgentSkillCodec';
import {
  AgentSkillCollisionError,
  AgentSkillRepositoryError,
  AgentSkillRevisionConflictError,
} from '../../core/skills/AgentSkillRepository';
import {
  ClaudeCommandCollisionError,
  type ClaudeCommandDocument,
  ClaudeCommandRevisionConflictError,
  commandSkillName,
} from '../../core/skills/ClaudeCommandRepository';
import { AgentSkillValidationError } from '../../core/skills/validateAgentSkill';
import {
  ManagedResourcePathError,
  ManagedResourceRelocationError,
} from '../../core/storage/VaultFileAdapter';
import { t } from '../../i18n/i18n';
import { extractFirstParagraph } from '../../utils/slashCommand';
import type {
  AgentSkillManagementCoordinator,
  AgentSkillMutationResult,
} from './AgentSkillManagementCoordinator';

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

function showSaveError(error: unknown, name: string): void {
  if (
    error instanceof AgentSkillRevisionConflictError
    || error instanceof ClaudeCommandRevisionConflictError
  ) {
    new Notice(t('settings.agentSkills.staleConflict'));
    return;
  }
  if (error instanceof AgentSkillValidationError) {
    new Notice(t('settings.agentSkills.validationFailed', { message: error.message }));
    return;
  }
  if (error instanceof AgentSkillCollisionError) {
    new Notice(t('settings.agentSkills.collisionFailed', { name }));
    return;
  }
  if (error instanceof ClaudeCommandCollisionError) {
    new Notice(t('settings.skills.commands.collisionFailed', { name }));
    return;
  }
  new Notice(t('settings.agentSkills.saveFailed', { message: errorMessage(error) }));
}

interface AgentSkillEditorOptions {
  title: string;
  initial: AgentSkillInput | null;
  nameDesc?: string;
  descriptionDesc?: string;
  /** Frontmatter keys the save will remove; shown as a warning before saving. */
  droppedKeys?: readonly string[];
  save(input: AgentSkillInput): Promise<AgentSkillMutationResult<{ name: string }>>;
  successMessage(name: string): string;
}

class AgentSkillModal extends Modal {
  private nameInput!: HTMLInputElement;
  private descriptionInput!: HTMLInputElement;
  private instructionsArea!: HTMLTextAreaElement;

  constructor(app: App, private readonly options: AgentSkillEditorOptions) {
    super(app);
  }

  onOpen(): void {
    const { initial } = this.options;
    this.setTitle(this.options.title);
    this.modalEl.addClass('claudian-agent-skill-modal');

    if (this.options.droppedKeys && this.options.droppedKeys.length > 0) {
      this.contentEl.createEl('p', {
        cls: 'claudian-agent-skill-warning',
        text: t('settings.skills.droppedFrontmatterWarning', {
          keys: this.options.droppedKeys.join(', '),
        }),
      });
    }

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.name'))
      .setDesc(this.options.nameDesc ?? t('settings.agentSkills.modal.nameDesc'))
      .addText(text => {
        this.nameInput = text.inputEl;
        text.inputEl.setAttribute('aria-label', t('settings.agentSkills.modal.name'));
        text
          .setValue(initial?.name ?? '')
          .setPlaceholder(t('settings.agentSkills.modal.namePlaceholder'));
      });

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.description'))
      .setDesc(this.options.descriptionDesc ?? t('settings.agentSkills.modal.descriptionDesc'))
      .addText(text => {
        this.descriptionInput = text.inputEl;
        text.inputEl.setAttribute('aria-label', t('settings.agentSkills.modal.description'));
        text
          .setValue(initial?.description ?? '')
          .setPlaceholder(t('settings.agentSkills.modal.descriptionPlaceholder'));
      });

    new Setting(this.contentEl)
      .setName(t('settings.agentSkills.modal.instructions'))
      .setDesc(t('settings.agentSkills.modal.instructionsDesc'));

    this.instructionsArea = this.contentEl.createEl('textarea', {
      cls: 'claudian-agent-skill-instructions',
      attr: {
        rows: '12',
        'aria-label': t('settings.agentSkills.modal.instructions'),
        placeholder: t('settings.agentSkills.modal.instructionsPlaceholder'),
      },
    });
    this.instructionsArea.value = initial?.instructions ?? '';

    const save = async (): Promise<void> => {
      const input: AgentSkillInput = {
        name: this.nameInput.value.trim(),
        description: this.descriptionInput.value.trim(),
        instructions: this.instructionsArea.value,
      };
      try {
        const result = await this.options.save(input);
        new Notice(result.refreshFailed
          ? t('settings.agentSkills.savedRefreshFailed')
          : this.options.successMessage(result.value.name));
        this.close();
      } catch (error) {
        showSaveError(error, input.name);
      }
    };

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancelButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelButton.addEventListener('click', () => this.close());
    const saveButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.save'),
      cls: 'claudian-save-btn',
    });
    saveButton.addEventListener('click', () => {
      void save();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface AgentSkillDeleteOptions {
  title: string;
  description: string;
  path: string;
  remove(): Promise<AgentSkillMutationResult<void>>;
  successMessage: string;
}

class AgentSkillDeleteModal extends Modal {
  constructor(app: App, private readonly options: AgentSkillDeleteOptions) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.contentEl.createEl('p', {
      text: this.options.description,
      cls: 'claudian-agent-skill-delete-description',
    });
    this.contentEl.createEl('code', { text: this.options.path });

    const remove = async (): Promise<void> => {
      try {
        const result = await this.options.remove();
        new Notice(result.refreshFailed
          ? t('settings.agentSkills.savedRefreshFailed')
          : this.options.successMessage);
        this.close();
      } catch (error) {
        if (
          error instanceof AgentSkillRevisionConflictError
          || error instanceof ClaudeCommandRevisionConflictError
        ) {
          new Notice(t('settings.agentSkills.staleConflict'));
          return;
        }
        new Notice(t('settings.agentSkills.deleteFailed', { message: errorMessage(error) }));
      }
    };

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancelButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelButton.addEventListener('click', () => this.close());
    const deleteButton = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('settings.agentSkills.delete.confirm'),
      cls: 'mod-warning',
    });
    deleteButton.addEventListener('click', () => {
      void remove();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface AgentSkillSettingsOptions {
  /** Help text describing the managed folder; null shows none. */
  help?: string | null;
  /** Title shown at the left of the header row, before any help text. */
  title?: string;
  /** Renders extra controls before the refresh and add buttons. */
  renderHeaderAccessory?: (actions: HTMLElement) => void;
  /** Omits the command section entirely when there are no commands. */
  hideEmptyCommands?: boolean;
  /** Replaces the refresh button's own re-read, for owners that must also re-read other state. */
  onRefresh?: () => void;
}

/** Lists one skills folder and, when the coordinator manages them, Claude commands. */
export class AgentSkillSettings {
  private renderGeneration = 0;
  private disposed = false;
  private readonly rootEl: HTMLDivElement;

  constructor(
    containerEl: HTMLElement,
    private readonly coordinator: AgentSkillManagementCoordinator,
    private readonly app: App,
    private readonly options: AgentSkillSettingsOptions = {},
  ) {
    this.rootEl = containerEl.createDiv({ cls: 'claudian-agent-skills-manager' });
    void this.render();
  }

  /** Drops any in-flight render so a disposed panel never repaints. */
  dispose(): void {
    this.disposed = true;
    this.renderGeneration += 1;
  }

  async refresh(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.renderGeneration;
    let result;
    let commands;
    try {
      [result, commands] = await Promise.all([
        this.coordinator.list(),
        this.coordinator.listCommands(),
      ]);
    } catch {
      if (generation !== this.renderGeneration) return;
      this.rootEl.empty();
      this.#renderHeader();
      this.rootEl.createDiv({
        cls: 'claudian-agent-skills-error',
        text: t('settings.agentSkills.loadFailed'),
      });
      return;
    }
    if (generation !== this.renderGeneration) return;

    this.rootEl.empty();
    this.#renderHeader();

    if (result.skills.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-sp-empty-state',
        text: t('settings.agentSkills.noSkills'),
      });
    } else {
      const list = this.rootEl.createDiv({ cls: 'claudian-sp-list' });
      for (const skill of result.skills) {
        this.#renderSkill(list, skill);
      }
    }

    if (this.coordinator.managesCommands && !(this.options.hideEmptyCommands && commands.commands.length === 0)) {
      this.#renderCommands(commands.commands);
    }

    // Only packages the user can fix or delete; links and unreadable files are left to Sync.
    const diagnostics = result.diagnostics.filter(diagnostic => diagnostic.repairName !== undefined);
    if (diagnostics.length > 0) {
      const diagnosticsEl = this.rootEl.createDiv({ cls: 'claudian-agent-skills-diagnostics' });
      diagnosticsEl.createDiv({
        cls: 'claudian-agent-skills-diagnostics-title',
        text: t('settings.agentSkills.diagnosticsTitle'),
      });
      for (const diagnostic of diagnostics) {
        this.#renderDiagnostic(diagnosticsEl, diagnostic);
      }
    }
  }

  #renderHeader(): void {
    const header = this.rootEl.createDiv({
      cls: 'claudian-sp-header claudian-agent-skills-header',
    });
    const help = header.createDiv({ cls: 'claudian-agent-skills-help' });
    if (this.options.title) {
      help.createEl('h3', { cls: 'claudian-agent-skills-title', text: this.options.title });
    }
    if (this.options.help !== null) {
      help.createEl('p', { text: this.options.help ?? t('settings.agentSkills.sharedExpectation') });
    }

    const actions = header.createDiv({ cls: 'claudian-sp-header-actions' });
    this.options.renderHeaderAccessory?.(actions);
    const refreshButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { type: 'button', 'aria-label': t('common.refresh') },
    });
    setIcon(refreshButton, 'refresh-cw');
    refreshButton.addEventListener('click', () => {
      if (this.options.onRefresh) {
        this.options.onRefresh();
      } else {
        void this.render();
      }
    });
    const addButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { type: 'button', 'aria-label': t('common.add') },
    });
    setIcon(addButton, 'plus');
    addButton.addEventListener('click', () => this.#openSkillEditor(null));
  }

  #renderSkill(list: HTMLElement, skill: AgentSkillDocument): void {
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
    this.#actionButton(actions, t('common.edit'), 'pencil', () => this.#openSkillEditor(skill));
    this.#actionButton(actions, t('common.delete'), 'trash-2', () => {
      this.#openDelete({
        title: t('settings.agentSkills.delete.title'),
        description: t('settings.agentSkills.delete.description'),
        path: skill.directoryPath,
        remove: () => this.coordinator.trash(skill.name, skill.revision),
        successMessage: t('settings.agentSkills.deleted', { name: skill.name }),
      });
    }, 'claudian-settings-delete-btn');
  }

  #renderCommands(commands: ClaudeCommandDocument[]): void {
    const section = this.rootEl.createDiv({ cls: 'claudian-agent-skills-commands' });
    section.createDiv({
      cls: 'claudian-agent-skills-commands-title',
      text: t('settings.skills.commands.title'),
    });
    section.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.skills.commands.hint'),
    });
    if (commands.length === 0) {
      section.createDiv({ cls: 'claudian-sp-empty-state', text: t('settings.skills.commands.empty') });
      return;
    }
    const list = section.createDiv({ cls: 'claudian-sp-list' });
    for (const command of commands) {
      const item = list.createDiv({ cls: 'claudian-sp-item' });
      const info = item.createDiv({ cls: 'claudian-sp-info' });
      const itemHeader = info.createDiv({ cls: 'claudian-sp-item-header' });
      itemHeader.createSpan({ text: `/${command.name}`, cls: 'claudian-sp-item-name' });
      itemHeader.createSpan({ text: t('settings.skills.commands.badge'), cls: 'claudian-slash-item-badge' });
      if (command.description) {
        info.createDiv({ text: command.description, cls: 'claudian-sp-item-desc' });
      }

      const actions = item.createDiv({ cls: 'claudian-sp-item-actions' });
      this.#actionButton(actions, t('common.edit'), 'pencil', () => this.#openCommandEditor(command));
      this.#actionButton(
        actions,
        t('settings.skills.commands.convert'),
        'package',
        () => this.#openConvertEditor(command),
      );
      this.#actionButton(actions, t('common.delete'), 'trash-2', () => {
        this.#openDelete({
          title: t('settings.skills.commands.deleteTitle'),
          description: t('settings.skills.commands.deleteDescription'),
          path: command.filePath,
          remove: () => this.coordinator.trashCommand(command),
          successMessage: t('settings.skills.commands.deleted', { name: command.name }),
        });
      }, 'claudian-settings-delete-btn');
    }
  }

  #renderDiagnostic(container: HTMLElement, diagnostic: AgentSkillDiagnostic): void {
    const item = container.createDiv({ cls: 'claudian-agent-skills-diagnostic' });
    const info = item.createDiv({ cls: 'claudian-agent-skills-diagnostic-info' });
    info.createEl('code', { text: diagnostic.directoryPath });
    info.createSpan({ text: diagnostic.message });
    const name = diagnostic.repairName;
    if (name === undefined) return;

    const actions = item.createDiv({ cls: 'claudian-sp-item-actions' });
    this.#actionButton(actions, t('settings.agentSkills.fix'), 'wrench', () => {
      void this.#openRepairEditor(name);
    });
    this.#actionButton(actions, t('common.delete'), 'trash-2', () => {
      this.#openDelete({
        title: t('settings.agentSkills.delete.title'),
        description: t('settings.agentSkills.delete.description'),
        path: diagnostic.directoryPath,
        remove: () => this.coordinator.trashBroken(name),
        successMessage: t('settings.agentSkills.deleted', { name }),
      });
    }, 'claudian-settings-delete-btn');
  }

  async #openRepairEditor(name: string): Promise<void> {
    let draft;
    try {
      draft = await this.coordinator.readForRepair(name);
    } catch (error) {
      new Notice(t('settings.agentSkills.saveFailed', { message: errorMessage(error) }));
      return;
    }
    this.#openEditor({
      title: t('settings.agentSkills.modal.titleFix'),
      initial: draft.input,
      droppedKeys: this.#droppedKeys(draft.frontmatter),
      save: input => this.coordinator.repair(name, draft.revision, input),
      successMessage: fixedName => t('settings.agentSkills.fixed', { name: fixedName }),
    });
  }

  #openEditor(options: AgentSkillEditorOptions): void {
    new AgentSkillModal(this.app, {
      ...options,
      save: async input => this.#renderAfter(await options.save(input)),
    }).open();
  }

  #openDelete(options: AgentSkillDeleteOptions): void {
    new AgentSkillDeleteModal(this.app, {
      ...options,
      remove: async () => this.#renderAfter(await options.remove()),
    }).open();
  }

  #renderAfter<T>(result: T): T {
    void this.render();
    return result;
  }

  #actionButton(
    container: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
    extraClass = '',
  ): void {
    const button = container.createEl('button', {
      cls: `claudian-settings-action-btn${extraClass ? ` ${extraClass}` : ''}`,
      attr: { type: 'button', 'aria-label': label },
    });
    setIcon(button, icon);
    button.addEventListener('click', onClick);
  }

  #droppedKeys(frontmatter: Record<string, unknown>): string[] {
    return this.coordinator.frontmatterPolicy === 'portable' ? extraFrontmatterKeys(frontmatter) : [];
  }

  #openSkillEditor(existing: AgentSkillDocument | null): void {
    this.#openEditor({
      title: t(existing ? 'settings.agentSkills.modal.titleEdit' : 'settings.agentSkills.modal.titleAdd'),
      initial: existing,
      droppedKeys: existing ? this.#droppedKeys(existing.frontmatter) : [],
      save: input => (
        existing
          ? this.coordinator.update(existing.name, existing.revision, input)
          : this.coordinator.create(input)
      ),
      successMessage: name => t(
        existing ? 'settings.agentSkills.updated' : 'settings.agentSkills.created',
        { name },
      ),
    });
  }

  #openCommandEditor(command: ClaudeCommandDocument): void {
    this.#openEditor({
      title: t('settings.skills.commands.editTitle'),
      initial: command,
      nameDesc: t('settings.skills.commands.nameDesc'),
      descriptionDesc: t('settings.skills.commands.descriptionDesc'),
      droppedKeys: this.#droppedKeys(command.frontmatter),
      save: input => this.coordinator.updateCommand(command, input),
      successMessage: name => t('settings.skills.commands.updated', { name }),
    });
  }

  #openConvertEditor(command: ClaudeCommandDocument): void {
    this.#openEditor({
      title: t('settings.skills.commands.convertTitle'),
      initial: {
        name: commandSkillName(command.name),
        description: command.description || extractFirstParagraph(command.instructions) || '',
        instructions: command.instructions,
      },
      droppedKeys: this.#droppedKeys(command.frontmatter),
      save: input => this.coordinator.convertCommand(command, input),
      successMessage: name => t('settings.skills.commands.converted', { name }),
    });
  }
}
