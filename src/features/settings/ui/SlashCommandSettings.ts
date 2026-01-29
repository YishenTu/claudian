import type { App, ToggleComponent } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { SlashCommand } from '../../../core/types';
import { t } from '../../../i18n';
import type ClaudianPlugin from '../../../main';
import { extractFirstParagraph, isSkill, parseSlashCommandContent, validateCommandName } from '../../../utils/slashCommand';

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

export class SlashCommandModal extends Modal {
  private plugin: ClaudianPlugin;
  private existingCmd: SlashCommand | null;
  private onSave: (cmd: SlashCommand) => Promise<void>;

  constructor(
    app: App,
    plugin: ClaudianPlugin,
    existingCmd: SlashCommand | null,
    onSave: (cmd: SlashCommand) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.existingCmd = existingCmd;
    this.onSave = onSave;
  }

  onOpen() {
    const existingIsSkill = this.existingCmd ? isSkill(this.existingCmd) : false;
    let selectedType: 'command' | 'skill' = existingIsSkill ? 'skill' : 'command';

    const typeLabel = () => selectedType === 'skill' ? 'Skill' : 'Slash Command';

    this.setTitle(this.existingCmd ? `Edit ${typeLabel()}` : `Add ${typeLabel()}`);
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let hintInput: HTMLInputElement;
    let modelInput: HTMLInputElement;
    let toolsInput: HTMLInputElement;
    let disableModelToggle: boolean = this.existingCmd?.disableModelInvocation ?? false;
    let disableUserInvocation: boolean = this.existingCmd?.userInvocable === false;
    let contextValue: 'fork' | '' = this.existingCmd?.context ?? '';
    let agentInput: HTMLInputElement;

    /* eslint-disable prefer-const -- assigned in Setting callbacks */
    let disableUserSetting!: Setting;
    let disableUserToggle!: ToggleComponent;
    /* eslint-enable prefer-const */

    const updateSkillOnlyFields = () => {
      const isSkillType = selectedType === 'skill';
      disableUserSetting.settingEl.style.display = isSkillType ? '' : 'none';
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
            this.setTitle(this.existingCmd ? `Edit ${typeLabel()}` : `Add ${typeLabel()}`);
            updateSkillOnlyFields();
          });
        if (this.existingCmd) {
          dropdown.setDisabled(true);
        }
      });

    new Setting(contentEl)
      .setName('Command name')
      .setDesc('The name used after / (e.g., "review" for /review)')
      .addText(text => {
        nameInput = text.inputEl;
        text.setValue(this.existingCmd?.name || '')
          .setPlaceholder('review-code');
      });

    new Setting(contentEl)
      .setName('Description')
      .setDesc('Optional description shown in dropdown')
      .addText(text => {
        descInput = text.inputEl;
        text.setValue(this.existingCmd?.description || '');
      });

    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: 'Advanced options',
      cls: 'claudian-sp-advanced-summary',
    });
    if (this.existingCmd?.argumentHint || this.existingCmd?.model || this.existingCmd?.allowedTools?.length ||
        this.existingCmd?.disableModelInvocation || this.existingCmd?.userInvocable === false ||
        this.existingCmd?.context || this.existingCmd?.agent) {
      details.open = true;
    }

    new Setting(details)
      .setName('Argument hint')
      .setDesc('Placeholder text for arguments (e.g., "[file] [focus]")')
      .addText(text => {
        hintInput = text.inputEl;
        text.setValue(this.existingCmd?.argumentHint || '');
      });

    new Setting(details)
      .setName('Model override')
      .setDesc('Optional model to use for this command')
      .addText(text => {
        modelInput = text.inputEl;
        text.setValue(this.existingCmd?.model || '')
          .setPlaceholder('claude-sonnet-4-5');
      });

    new Setting(details)
      .setName('Allowed tools')
      .setDesc('Comma-separated list of tools to allow (empty = all)')
      .addText(text => {
        toolsInput = text.inputEl;
        text.setValue(this.existingCmd?.allowedTools?.join(', ') || '');
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
            agentSetting.settingEl.style.display = value ? '' : 'none';
          });
      });

    const agentSetting = new Setting(details)
      .setName('Agent')
      .setDesc('Subagent type when context is fork')
      .addText(text => {
        agentInput = text.inputEl;
        text.setValue(this.existingCmd?.agent || '')
          .setPlaceholder('code-reviewer');
      });
    agentSetting.settingEl.style.display = contextValue === 'fork' ? '' : 'none';

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
    const initialContent = this.existingCmd
      ? parseSlashCommandContent(this.existingCmd.content).promptContent
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
    saveBtn.addEventListener('click', async () => {
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

      const existing = this.plugin.settings.slashCommands.find(
        c => c.name.toLowerCase() === name.toLowerCase() &&
             c.id !== this.existingCmd?.id
      );
      if (existing) {
        new Notice(`A command named "/${name}" already exists`);
        return;
      }

      const parsed = parseSlashCommandContent(content);
      const promptContent = parsed.promptContent;

      const isSkillType = selectedType === 'skill';
      const id = this.existingCmd?.id ||
        (isSkillType
          ? `skill-${name}`
          : `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`);

      const cmd: SlashCommand = {
        id,
        name,
        description: descInput.value.trim() || parsed.description || undefined,
        argumentHint: hintInput.value.trim() || parsed.argumentHint || undefined,
        model: modelInput.value.trim() || parsed.model || undefined,
        allowedTools: resolveAllowedTools(toolsInput.value, parsed.allowedTools),
        content: promptContent,
        source: isSkillType ? 'user' : undefined,
        disableModelInvocation: disableModelToggle || undefined,
        userInvocable: disableUserInvocation ? false : undefined,
        context: contextValue || undefined,
        agent: contextValue === 'fork' ? (agentInput.value.trim() || undefined) : undefined,
      };

      try {
        await this.onSave(cmd);
      } catch {
        const label = isSkillType ? 'skill' : 'slash command';
        new Notice(`Failed to save ${label}`);
        return;
      }
      this.close();
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
  private containerEl: HTMLElement;
  private plugin: ClaudianPlugin;

  constructor(containerEl: HTMLElement, plugin: ClaudianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
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

    const commands = this.plugin.settings.slashCommands;

    if (commands.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText('No commands or skills configured. Click + to create one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });

    for (const cmd of commands) {
      this.renderCommandItem(listEl, cmd);
    }
  }

  private renderCommandItem(listEl: HTMLElement, cmd: SlashCommand): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });

    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(`/${cmd.name}`);

    if (isSkill(cmd)) {
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

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openCommandModal(cmd));

    if (!isSkill(cmd)) {
      const convertBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Convert to skill' },
      });
      setIcon(convertBtn, 'package');
      convertBtn.addEventListener('click', async () => {
        try {
          await this.transformToSkill(cmd);
        } catch {
          new Notice('Failed to convert to skill');
        }
      });
    }

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      try {
        await this.deleteCommand(cmd);
      } catch {
        const label = isSkill(cmd) ? 'skill' : 'slash command';
        new Notice(`Failed to delete ${label}`);
      }
    });
  }

  private openCommandModal(existingCmd: SlashCommand | null): void {
    const modal = new SlashCommandModal(
      this.plugin.app,
      this.plugin,
      existingCmd,
      async (cmd) => {
        await this.saveCommand(cmd, existingCmd);
      }
    );
    modal.open();
  }

  private storageFor(cmd: SlashCommand) {
    return isSkill(cmd) ? this.plugin.storage.skills : this.plugin.storage.commands;
  }

  private async saveCommand(cmd: SlashCommand, existing: SlashCommand | null): Promise<void> {
    // Save new file first (safer: if this fails, old file still exists)
    await this.storageFor(cmd).save(cmd);

    // Delete old file only after successful save (if name changed)
    if (existing && existing.name !== cmd.name) {
      await this.storageFor(existing).delete(existing.id);
    }

    await this.reloadCommands();

    this.render();
    const label = isSkill(cmd) ? 'Skill' : 'Slash command';
    new Notice(`${label} "/${cmd.name}" ${existing ? 'updated' : 'created'}`);
  }

  private async deleteCommand(cmd: SlashCommand): Promise<void> {
    await this.storageFor(cmd).delete(cmd.id);

    await this.reloadCommands();

    this.render();
    const label = isSkill(cmd) ? 'Skill' : 'Slash command';
    new Notice(`${label} "/${cmd.name}" deleted`);
  }

  private async transformToSkill(cmd: SlashCommand): Promise<void> {
    const skillName = cmd.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);

    const existingSkill = this.plugin.settings.slashCommands.find(
      c => isSkill(c) && c.name === skillName
    );
    if (existingSkill) {
      new Notice(`A skill named "/${skillName}" already exists`);
      return;
    }

    const description = cmd.description || extractFirstParagraph(cmd.content);

    const skill: SlashCommand = {
      ...cmd,
      id: `skill-${skillName}`,
      name: skillName,
      description,
      source: 'user',
    };

    await this.plugin.storage.skills.save(skill);
    await this.plugin.storage.commands.delete(cmd.id);

    await this.reloadCommands();
    this.render();
    new Notice(`Converted "/${cmd.name}" to skill`);
  }

  private async reloadCommands(): Promise<void> {
    this.plugin.settings.slashCommands = await this.plugin.storage.loadAllSlashCommands();
  }

  public refresh(): void {
    this.render();
  }
}
