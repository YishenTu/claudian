import type { App, ToggleComponent } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { t } from '../../../i18n/i18n';
import { extractFirstParagraph, normalizeArgumentHint, parseSlashCommandContent, validateCommandName } from '../../../utils/slashCommand';

function resolveAllowedTools(inputValue: string, parsedTools?: string[]): string[] | undefined {
  const trimmed = inputValue.trim();
  if (trimmed) {
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (parsedTools && parsedTools.length > 0) {
    return parsedTools;
  }
  return undefined;
}

function isSkillEntry(entry: ProviderCommandEntry): boolean {
  return entry.kind === 'skill';
}

export class SlashCommandModal extends Modal {
  private entries: ProviderCommandEntry[];
  private existingEntry: ProviderCommandEntry | null;
  private onSave: (entry: ProviderCommandEntry) => Promise<void>;

  constructor(
    app: App,
    entries: ProviderCommandEntry[],
    existingEntry: ProviderCommandEntry | null,
    onSave: (entry: ProviderCommandEntry) => Promise<void>,
  ) {
    super(app);
    this.entries = entries;
    this.existingEntry = existingEntry;
    this.onSave = onSave;
  }

  onOpen() {
    const existingIsSkill = this.existingEntry ? isSkillEntry(this.existingEntry) : false;
    let selectedType: 'command' | 'skill' = existingIsSkill ? 'skill' : 'command';

    const typeLabel = () => selectedType === 'skill' ? 'Skill' : 'Slash Command';

    this.setTitle(this.existingEntry ? `Edit ${typeLabel()}` : `Add ${typeLabel()}`);
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let hintInput: HTMLInputElement;
    let modelInput: HTMLInputElement;
    let toolsInput: HTMLInputElement;
    let disableModelToggle = this.existingEntry?.disableModelInvocation ?? false;
    let disableUserInvocation = this.existingEntry?.userInvocable === false;
    let contextValue: 'fork' | '' = this.existingEntry?.context ?? '';
    let agentInput: HTMLInputElement;

    let disableUserSetting: Setting | null = null;
    let disableUserToggle: ToggleComponent | null = null;

    const updateSkillOnlyFields = () => {
      if (!disableUserSetting || !disableUserToggle) return;

      const isSkillType = selectedType === 'skill';
      disableUserSetting.settingEl.toggleClass('claudian-hidden', !isSkillType);
      if (!isSkillType) {
        disableUserInvocation = false;
        disableUserToggle.setValue(false);
      }
    };

    new Setting(contentEl)
      .setName('Type')
      .setDesc('Command or skill')
      .addDropdown(dropdown => {
        dropdown
          .addOption('command', 'Command')
          .addOption('skill', 'Skill')
          .setValue(selectedType)
          .onChange(value => {
            selectedType = value as 'command' | 'skill';
            this.setTitle(this.existingEntry ? `Edit ${typeLabel()}` : `Add ${typeLabel()}`);
            updateSkillOnlyFields();
          });
        if (this.existingEntry) {
          dropdown.setDisabled(true);
        }
      });

    new Setting(contentEl)
      .setName('Command name')
      .setDesc('The name used after / (e.g., "review" for /review)')
      .addText(text => {
        nameInput = text.inputEl;
        text.setValue(this.existingEntry?.name || '')
          .setPlaceholder('Review-code');
      });

    new Setting(contentEl)
      .setName('Description')
      .setDesc('Optional description shown in dropdown')
      .addText(text => {
        descInput = text.inputEl;
        text.setValue(this.existingEntry?.description || '');
      });

    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: 'Advanced options',
      cls: 'claudian-sp-advanced-summary',
    });
    if (
      this.existingEntry?.argumentHint
      || this.existingEntry?.model
      || this.existingEntry?.allowedTools?.length
      || this.existingEntry?.disableModelInvocation
      || this.existingEntry?.userInvocable === false
      || this.existingEntry?.context
      || this.existingEntry?.agent
    ) {
      details.open = true;
    }

    new Setting(details)
      .setName('Argument hint')
      .setDesc('Placeholder text for arguments (e.g., "[file] [focus]")')
      .addText(text => {
        hintInput = text.inputEl;
        text.setValue(this.existingEntry?.argumentHint || '');
      });

    new Setting(details)
      .setName('Model override')
      .setDesc('Optional model to use for this command')
      .addText(text => {
        modelInput = text.inputEl;
        text.setValue(this.existingEntry?.model || '')
          .setPlaceholder('Claude-sonnet-4-5');
      });

    new Setting(details)
      .setName('Allowed tools')
      .setDesc('Comma-separated list of tools to allow (empty = all)')
      .addText(text => {
        toolsInput = text.inputEl;
        text.setValue(this.existingEntry?.allowedTools?.join(', ') || '');
      });

    new Setting(details)
      .setName('Disable model invocation')
      .setDesc('Prevent the model from invoking this command itself')
      .addToggle(toggle => {
        toggle.setValue(disableModelToggle)
          .onChange(value => { disableModelToggle = value; });
      });

    disableUserSetting = new Setting(details)
      .setName('Disable user invocation')
      .setDesc('Prevent the user from invoking this skill directly')
      .addToggle(toggle => {
        disableUserToggle = toggle;
        toggle.setValue(disableUserInvocation)
          .onChange(value => { disableUserInvocation = value; });
      });

    updateSkillOnlyFields();

    new Setting(details)
      .setName('Context')
      .setDesc('Run in a subagent (fork)')
      .addToggle(toggle => {
        toggle.setValue(contextValue === 'fork')
          .onChange(value => {
            contextValue = value ? 'fork' : '';
            agentSetting.settingEl.toggleClass('claudian-hidden', !value);
          });
      });

    const agentSetting = new Setting(details)
      .setName('Agent')
      .setDesc('Subagent type when context is fork')
      .addText(text => {
        agentInput = text.inputEl;
        text.setValue(this.existingEntry?.agent || '')
          .setPlaceholder('Code-reviewer');
      });
    agentSetting.settingEl.toggleClass('claudian-hidden', contextValue !== 'fork');

    new Setting(contentEl)
      .setName('Prompt template')
      .setDesc('Use $ARGUMENTS, $1, $2, @file, !`bash`');

    const contentArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: 'Review this code for:\n$ARGUMENTS\n\n@$1',
      },
    });
    const initialContent = this.existingEntry
      ? parseSlashCommandContent(this.existingEntry.content).promptContent
      : '';
    contentArea.value = initialContent;

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-sp-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: 'Save',
      cls: 'claudian-save-btn',
    });
    saveBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
      const name = nameInput.value.trim();
      const nameError = validateCommandName(name);
      if (nameError) {
        new Notice(nameError);
        return;
      }

      const content = contentArea.value;
      if (!content.trim()) {
        new Notice('Prompt template is required');
        return;
      }

      const existing = this.entries.find(
        entry => entry.name.toLowerCase() === name.toLowerCase()
          && entry.id !== this.existingEntry?.id,
      );
      if (existing) {
        new Notice(`A command named "/${name}" already exists`);
        return;
      }

      const parsed = parseSlashCommandContent(content);
      const promptContent = parsed.promptContent;
      const isSkillType = selectedType === 'skill';

      const entry: ProviderCommandEntry = {
        id: this.existingEntry?.id || (
          isSkillType
            ? `skill-${name}`
            : `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
        ),
        providerId: 'claude',
        kind: isSkillType ? 'skill' : 'command',
        name,
        description: descInput.value.trim() || parsed.description || undefined,
        argumentHint: normalizeArgumentHint(hintInput.value.trim()) || parsed.argumentHint || undefined,
        allowedTools: resolveAllowedTools(toolsInput.value, parsed.allowedTools),
        model: modelInput.value.trim() || parsed.model || undefined,
        content: promptContent,
        disableModelInvocation: disableModelToggle || undefined,
        userInvocable: disableUserInvocation ? false : undefined,
        context: contextValue || undefined,
        agent: contextValue === 'fork' ? (agentInput.value.trim() || undefined) : undefined,
        hooks: parsed.hooks ?? this.existingEntry?.hooks,
        scope: 'vault',
        source: this.existingEntry?.source ?? 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
        persistenceKey: this.existingEntry?.persistenceKey,
      };

      try {
        await this.onSave(entry);
      } catch {
        const label = isSkillType ? 'skill' : 'slash command';
        new Notice(`Failed to save ${label}`);
        return;
      }
      this.close();
      })();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    };
    contentEl.addEventListener('keydown', handleKeyDown);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class SlashCommandSettings {
  private app: App;
  private containerEl: HTMLElement;
  private catalog: ProviderCommandCatalog | null;
  private commands: ProviderCommandEntry[] = [];

  constructor(
    containerEl: HTMLElement,
    app: App,
    catalog: ProviderCommandCatalog | null,
  ) {
    this.app = app;
    this.containerEl = containerEl;
    this.catalog = catalog;
    void this.loadAndRender();
  }

  private async loadAndRender(): Promise<void> {
    if (!this.catalog) {
      this.renderUnavailable();
      return;
    }

    this.commands = await this.catalog.listVaultEntries();
    this.render();
  }

  private renderUnavailable(): void {
    this.containerEl.empty();
    const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
    emptyEl.setText('Claude command catalog is unavailable.');
  }

  private render(): void {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.slashCommands.name'), cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openCommandModal(null));

    if (this.commands.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText('No commands or skills configured. Click + to create one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });

    for (const cmd of this.commands) {
      this.renderCommandItem(listEl, cmd);
    }
  }

  private renderCommandItem(listEl: HTMLElement, cmd: ProviderCommandEntry): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });

    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(`/${cmd.name}`);

    if (isSkillEntry(cmd)) {
      headerRow.createSpan({ text: 'skill', cls: 'claudian-slash-item-badge' });
    }

    if (cmd.argumentHint) {
      const hintEl = headerRow.createSpan({ cls: 'claudian-slash-item-hint' });
      hintEl.setText(cmd.argumentHint);
    }

    if (cmd.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-sp-item-desc' });
      descEl.setText(cmd.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    if (cmd.isEditable) {
      const editBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Edit' },
      });
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', () => this.openCommandModal(cmd));
    }

    if (!isSkillEntry(cmd) && cmd.isEditable) {
      const convertBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Convert to skill' },
      });
      setIcon(convertBtn, 'package');
      convertBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
        try {
          await this.transformToSkill(cmd);
        } catch {
          new Notice('Failed to convert to skill');
        }
        })();
      });
    }

    if (cmd.isDeletable) {
      const deleteBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
        attr: { 'aria-label': 'Delete' },
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
        try {
          await this.deleteCommand(cmd);
        } catch {
          const label = isSkillEntry(cmd) ? 'skill' : 'slash command';
          new Notice(`Failed to delete ${label}`);
        }
        })();
      });
    }
  }

  private openCommandModal(existingCmd: ProviderCommandEntry | null): void {
    const modal = new SlashCommandModal(
      this.app,
      this.commands,
      existingCmd,
      async (cmd) => {
        await this.saveCommand(cmd, existingCmd);
      },
    );
    modal.open();
  }

  private async saveCommand(cmd: ProviderCommandEntry, existing: ProviderCommandEntry | null): Promise<void> {
    if (!this.catalog) {
      return;
    }

    await this.catalog.saveVaultEntry(cmd);

    if (existing && existing.name !== cmd.name) {
      await this.catalog.deleteVaultEntry(existing);
    }

    await this.reloadCommands();

    this.render();
    const label = isSkillEntry(cmd) ? 'Skill' : 'Slash command';
    new Notice(`${label} "/${cmd.name}" ${existing ? 'updated' : 'created'}`);
  }

  private async deleteCommand(cmd: ProviderCommandEntry): Promise<void> {
    if (!this.catalog) {
      return;
    }

    await this.catalog.deleteVaultEntry(cmd);

    await this.reloadCommands();

    this.render();
    const label = isSkillEntry(cmd) ? 'Skill' : 'Slash command';
    new Notice(`${label} "/${cmd.name}" deleted`);
  }

  private async transformToSkill(cmd: ProviderCommandEntry): Promise<void> {
    if (!this.catalog) {
      return;
    }

    const skillName = cmd.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);

    const existingSkill = this.commands.find(
      entry => isSkillEntry(entry) && entry.name === skillName,
    );
    if (existingSkill) {
      new Notice(`A skill named "/${skillName}" already exists`);
      return;
    }

    const skill: ProviderCommandEntry = {
      ...cmd,
      id: `skill-${skillName}`,
      kind: 'skill',
      name: skillName,
      description: cmd.description || extractFirstParagraph(cmd.content),
      source: 'user',
      scope: 'vault',
      isEditable: true,
      isDeletable: true,
      displayPrefix: '/',
      insertPrefix: '/',
    };

    await this.catalog.saveVaultEntry(skill);
    await this.catalog.deleteVaultEntry(cmd);

    await this.reloadCommands();
    this.render();
    new Notice(`Converted "/${cmd.name}" to skill`);
  }

  private async reloadCommands(): Promise<void> {
    if (!this.catalog) {
      this.commands = [];
      return;
    }

    this.commands = await this.catalog.listVaultEntries();
  }

  public refresh(): void {
    void this.loadAndRender();
  }
}
